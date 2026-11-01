import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { stripeEvents, subscriptions, users } from '../db/schema.js';
import { newId } from '../lib/ids.js';

/**
 * Stripe Checkout, billing portal, and webhook handling (plan section
 * 6.3.3), talked to over Stripe's plain REST API rather than the `stripe`
 * npm SDK -- matching this codebase's habit of a small `fetch` call over a
 * dependency (see Overpass/Nominatim in services/geo.ts, OpenRouter in
 * services/parse.ts). `fetch` is injected so tests run against a fake Stripe.
 *
 * The one price this app sells is created once in the Stripe dashboard and
 * referenced by STRIPE_PRICE_ID, so the API key never needs write access to
 * Products or Prices. `verifyPrice` re-checks it before the first checkout.
 */

/** What the subscription must cost. A price id pointing at anything else is refused rather than charged. */
export const SUBSCRIPTION_PRICE_CENTS = 199;

/** Paid access is only granted for these Stripe subscription states, and only until the period end. */
const ENTITLED_STATUSES = new Set(['active', 'trialing', 'past_due']);
/** Terminal states: Stripe never reactivates these, so a late event must not resurrect them. */
const TERMINAL_STATUSES = new Set(['canceled', 'incomplete_expired']);

export class BillingError extends Error {
  constructor(public readonly status: 502 | 503, message: string, public readonly upstreamStatus?: number) {
    super(message);
    this.name = 'BillingError';
  }
}

export interface StripeConfig {
  apiKey: string;
  webhookSecret: string;
  priceId: string;
  appUrl: string;
  fetch?: typeof fetch;
}

/** Live keys (`sk_live_`, `rk_live_`) only ever receive live events, test keys only test events. */
export const isLiveKey = (apiKey: string): boolean => /^(sk|rk)_live_/.test(apiKey);

export const checkoutConfigured = (cfg: StripeConfig): boolean => !!cfg.apiKey && !!cfg.priceId;

interface StripePrice {
  id: string;
  active?: boolean;
  currency?: string;
  unit_amount?: number | null;
  type?: string;
  recurring?: { interval?: string; interval_count?: number } | null;
}

export class StripeClient {
  private priceVerified = false;
  private readonly doFetch: typeof fetch;
  private readonly appUrl: string;

  constructor(private readonly cfg: StripeConfig) {
    this.doFetch = cfg.fetch ?? fetch;
    this.appUrl = cfg.appUrl.replace(/\/+$/, '');
  }

  private async request<T>(method: 'GET' | 'POST', path: string, form?: Record<string, string>, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.cfg.apiKey}` };
    if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    let response: Response;
    try {
      response = await this.doFetch(`https://api.stripe.com${path}`, {
        method,
        headers,
        body: form ? new URLSearchParams(form).toString() : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      console.error('Stripe request failed:', method, path, err);
      throw new BillingError(502, 'Could not reach the payment provider. Please try again.');
    }

    const data = (await response.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
    if (!response.ok || !data) {
      console.error('Stripe returned an error:', method, path, response.status, data?.error?.message);
      throw new BillingError(502, 'The payment provider rejected the request. Please try again.', response.status);
    }
    return data;
  }

  /**
   * Confirms STRIPE_PRICE_ID is the $1.99/month USD recurring price we mean
   * to sell. Only a success is cached, so fixing the price in the dashboard
   * takes effect without a restart.
   */
  async verifyPrice(): Promise<void> {
    if (this.priceVerified) return;
    let price: StripePrice;
    try {
      price = await this.request<StripePrice>('GET', `/v1/prices/${encodeURIComponent(this.cfg.priceId)}`);
    } catch (err) {
      if (err instanceof BillingError) {
        console.error(`STRIPE_PRICE_ID ${this.cfg.priceId} could not be read; refusing to start checkout.`);
        // A 4xx here means the configured id is wrong (a config error), not that Stripe is down.
        if (err.upstreamStatus && err.upstreamStatus >= 400 && err.upstreamStatus < 500 && err.upstreamStatus !== 429) {
          throw new BillingError(503, 'Subscriptions are not configured correctly yet.');
        }
      }
      throw err;
    }
    const ok =
      price.active === true &&
      price.currency === 'usd' &&
      price.unit_amount === SUBSCRIPTION_PRICE_CENTS &&
      price.type === 'recurring' &&
      price.recurring?.interval === 'month' &&
      (price.recurring.interval_count ?? 1) === 1;
    if (!ok) {
      console.error(`STRIPE_PRICE_ID ${this.cfg.priceId} is not an active ${SUBSCRIPTION_PRICE_CENTS}-cent USD monthly price; refusing to start checkout.`);
      throw new BillingError(503, 'Subscriptions are not configured correctly yet.');
    }
    this.priceVerified = true;
  }

  /**
   * Returns the user's Stripe customer id, creating the customer on first
   * use. The idempotency key makes two simultaneous first checkouts resolve
   * to the same customer instead of two.
   */
  async ensureCustomer(db: AppDb, user: { id: string; email: string; stripeCustomerId: string | null }): Promise<string> {
    if (user.stripeCustomerId) return user.stripeCustomerId;
    const customer = await this.request<{ id?: string }>(
      'POST',
      '/v1/customers',
      { email: user.email, 'metadata[user_id]': user.id },
      `grocerez-customer-${user.id}`,
    );
    if (!customer.id) throw new BillingError(502, 'The payment provider returned an unexpected response.');
    db.update(users).set({ stripeCustomerId: customer.id }).where(eq(users.id, user.id)).run();
    return customer.id;
  }

  async createCheckoutSession(userId: string, customerId: string): Promise<{ id: string; url: string }> {
    const session = await this.request<{ id?: string; url?: string }>('POST', '/v1/checkout/sessions', {
      mode: 'subscription',
      customer: customerId,
      'line_items[0][price]': this.cfg.priceId,
      'line_items[0][quantity]': '1',
      success_url: `${this.appUrl}/?checkout=success`,
      cancel_url: `${this.appUrl}/?checkout=cancel`,
      client_reference_id: userId,
      'metadata[user_id]': userId,
      'subscription_data[metadata][user_id]': userId,
    });
    if (!session.id || !session.url) throw new BillingError(502, 'The payment provider returned an unexpected response.');
    return { id: session.id, url: session.url };
  }

  async createPortalSession(customerId: string): Promise<{ url: string }> {
    const session = await this.request<{ url?: string }>('POST', '/v1/billing_portal/sessions', {
      customer: customerId,
      return_url: `${this.appUrl}/`,
    });
    if (!session.url) throw new BillingError(502, 'The payment provider returned an unexpected response.');
    return { url: session.url };
  }
}

/**
 * Verifies a Stripe webhook signature by hand: the `Stripe-Signature`
 * header is `t=<unix seconds>,v1=<hex hmac>[,v1=<hex hmac>...]` and the
 * signed payload is `${t}.${rawBody}` under HMAC-SHA256 with the webhook
 * secret (https://docs.stripe.com/webhooks#verify-manually). Several `v1`
 * values appear while a signing secret is being rotated; any one matching
 * is enough. `v0` (test-only scheme) is ignored.
 */
export function verifyWebhookSignature(rawBody: string, signatureHeader: string, secret: string, toleranceSeconds = 300, now: () => Date = () => new Date()): boolean {
  if (!secret || !signatureHeader) return false;

  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of signatureHeader.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') timestamp ??= value;
    else if (key === 'v1') signatures.push(value);
  }
  if (!timestamp || !/^\d{1,12}$/.test(timestamp) || signatures.length === 0) return false;
  if (Math.abs(now().getTime() / 1000 - Number(timestamp)) > toleranceSeconds) return false;

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  return signatures.some((sig) => {
    if (!/^[0-9a-f]{64}$/i.test(sig)) return false;
    return timingSafeEqual(Buffer.from(sig, 'hex'), expected);
  });
}

export interface StripeEvent {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  data: { object: Record<string, unknown> };
}

export type WebhookOutcome = 'applied' | 'duplicate' | 'ignored';

interface StripeSubscriptionObject {
  id: string;
  customer?: string | { id?: string } | null;
  status: string;
  cancel_at_period_end?: boolean;
  current_period_end?: number;
  items?: { data?: { current_period_end?: number }[] };
  metadata?: { user_id?: string };
}

const customerIdOf = (customer: StripeSubscriptionObject['customer']): string | null =>
  typeof customer === 'string' ? customer : customer?.id ?? null;

/**
 * Stripe API versions from 2025-03-31 move `current_period_end` from the
 * subscription onto each item; read either, taking the latest item.
 */
function periodEndOf(sub: StripeSubscriptionObject): string | null {
  const candidates = [sub.current_period_end, ...(sub.items?.data ?? []).map((i) => i.current_period_end)].filter((n): n is number => typeof n === 'number' && n > 0);
  return candidates.length ? new Date(Math.max(...candidates) * 1000).toISOString() : null;
}

/** users.plan / plan_expires_at are derived from ALL of a user's subscriptions, never from a single event. */
function syncUserPlan(db: AppDb, userId: string): void {
  const entitled = db.select().from(subscriptions).where(eq(subscriptions.userId, userId)).all().filter((s) => ENTITLED_STATUSES.has(s.status) && s.currentPeriodEnd);
  const expiresAt = entitled.map((s) => s.currentPeriodEnd!).sort().at(-1) ?? null;
  db.update(users).set(expiresAt ? { plan: 'paid', planExpiresAt: expiresAt } : { plan: 'free', planExpiresAt: null }).where(eq(users.id, userId)).run();
}

/**
 * Applies one Stripe event. Everything -- the dedupe record included -- runs
 * in a single transaction, so a failure leaves no trace and Stripe's retry
 * gets a clean second attempt.
 *
 *  - Duplicate event ids are no-ops (Stripe delivers at least once).
 *  - Events from the other mode (test vs live) are ignored.
 *  - Subscription events older than the newest one already applied are
 *    skipped, and a terminal state is never overwritten.
 *  - Access is derived from subscription status + a recorded period end;
 *    nothing grants open-ended access.
 */
export function handleWebhookEvent(db: AppDb, event: StripeEvent, opts: { livemode: boolean | null }, now: () => Date = () => new Date()): WebhookOutcome {
  // `livemode: null` means no API key is configured to infer the mode from, so accept either.
  if (opts.livemode !== null && event.livemode !== opts.livemode) {
    console.warn(`Ignoring ${event.livemode ? 'live' : 'test'}-mode Stripe event ${event.id}; this server is using ${opts.livemode ? 'live' : 'test'} keys.`);
    return 'ignored';
  }

  return db.transaction((tx) => {
    const txDb = tx as unknown as AppDb;
    const recorded = txDb.insert(stripeEvents).values({ id: event.id, type: event.type, receivedAt: now().toISOString() }).onConflictDoNothing().run();
    if (recorded.changes === 0) return 'duplicate';

    if (event.type === 'checkout.session.completed') {
      const obj = event.data.object as { client_reference_id?: string | null; customer?: string | null; mode?: string };
      if (obj.mode && obj.mode !== 'subscription') return 'ignored';
      if (!obj.client_reference_id || !obj.customer) return 'ignored';
      const user = txDb.select().from(users).where(eq(users.id, obj.client_reference_id)).all()[0];
      if (!user) {
        console.warn(`Stripe checkout ${event.id} references unknown user ${obj.client_reference_id}.`);
        return 'ignored';
      }
      // Linking only: paid access comes from the subscription events, which carry the period end.
      if (!user.stripeCustomerId) txDb.update(users).set({ stripeCustomerId: obj.customer }).where(eq(users.id, user.id)).run();
      return 'applied';
    }

    if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const obj = event.data.object as unknown as StripeSubscriptionObject;
      if (!obj.id || !obj.status) return 'ignored';
      const existing = txDb.select().from(subscriptions).where(eq(subscriptions.providerRef, obj.id)).all()[0];
      const customerId = customerIdOf(obj.customer);

      const metadataUser = obj.metadata?.user_id ? txDb.select().from(users).where(eq(users.id, obj.metadata.user_id)).all()[0] : undefined;
      const customerUser = customerId ? txDb.select().from(users).where(eq(users.stripeCustomerId, customerId)).all()[0] : undefined;
      // A subscription stays with the user it was first linked to; metadata or customer lookups only decide who a *new* one belongs to.
      const userId = existing?.userId ?? metadataUser?.id ?? customerUser?.id;
      if (!userId) {
        console.warn(`Stripe subscription event ${event.id} (${obj.id}) matches no user.`);
        return 'ignored';
      }

      const eventAt = new Date(event.created * 1000).toISOString();
      const status = event.type === 'customer.subscription.deleted' ? 'canceled' : obj.status;

      if (existing) {
        if (TERMINAL_STATUSES.has(existing.status)) return 'ignored';
        if (existing.lastEventAt && eventAt < existing.lastEventAt) return 'ignored';
        txDb.update(subscriptions).set({
          status,
          currentPeriodEnd: periodEndOf(obj) ?? existing.currentPeriodEnd,
          cancelAtPeriodEnd: obj.cancel_at_period_end ?? existing.cancelAtPeriodEnd,
          lastEventAt: eventAt,
        }).where(eq(subscriptions.id, existing.id)).run();
      } else {
        txDb.insert(subscriptions).values({
          id: newId(),
          userId,
          provider: 'stripe',
          providerRef: obj.id,
          status,
          currentPeriodEnd: periodEndOf(obj),
          cancelAtPeriodEnd: obj.cancel_at_period_end ?? false,
          lastEventAt: eventAt,
        }).run();
      }

      // Remember the Stripe customer for the portal, unless it's already known or belongs to someone else.
      const target = metadataUser ?? customerUser ?? txDb.select().from(users).where(eq(users.id, userId)).all()[0];
      if (customerId && target && !target.stripeCustomerId && !customerUser) {
        txDb.update(users).set({ stripeCustomerId: customerId }).where(eq(users.id, userId)).run();
      }
      syncUserPlan(txDb, userId);
      return 'applied';
    }

    return 'ignored';
  });
}
