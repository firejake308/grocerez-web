import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { subscriptions, users } from '../db/schema.js';
import { newId } from '../lib/ids.js';

/**
 * Stripe Checkout + webhook (Phase 3, plan section 6.3.3), talked to over
 * its plain REST API rather than the `stripe` npm SDK -- matching the rest
 * of this codebase's habit of a small `fetch` call over a dependency (see
 * Overpass/Nominatim in services/geo.ts, and OpenRouter in services/parse.ts).
 *
 * Not live-verified in this environment: there is no real Stripe account
 * or webhook to test against here. Reviewed against Stripe's documented
 * API shapes and signature scheme; run a real Checkout + a `stripe
 * listen`-forwarded webhook once before relying on this in production.
 */

export class BillingError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'BillingError';
  }
}

export interface CheckoutSession {
  id: string;
  url: string;
}

/** Creates a subscription Checkout Session for one user. */
export async function createCheckoutSession(
  secretKey: string,
  priceId: string,
  appUrl: string,
  userId: string,
  customerEmail: string,
): Promise<CheckoutSession> {
  const body = new URLSearchParams({
    mode: 'subscription',
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    success_url: `${appUrl}/subscribe/success`,
    cancel_url: `${appUrl}/subscribe/cancel`,
    client_reference_id: userId,
    customer_email: customerEmail,
  });

  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = (await response.json().catch(() => null)) as { id?: string; url?: string; error?: { message?: string } } | null;
  if (!response.ok || !data?.id || !data?.url) {
    throw new BillingError(502, data?.error?.message ?? 'Could not start checkout. Please try again.');
  }
  return { id: data.id, url: data.url };
}

/**
 * Verifies a Stripe webhook signature by hand: the `Stripe-Signature`
 * header is `t=<unix seconds>,v1=<hex hmac>[,v1=<hex hmac>...]`, and the
 * signed payload is `${t}.${rawBody}` under HMAC-SHA256 with the webhook
 * secret. See https://docs.stripe.com/webhooks#verify-manually (this
 * function implements that scheme rather than the `stripe` SDK's helper).
 */
export function verifyWebhookSignature(rawBody: string, signatureHeader: string, secret: string, toleranceSeconds = 300, now: () => Date = () => new Date()): boolean {
  const parts = Object.fromEntries(
    signatureHeader.split(',').map((kv) => {
      const [k, v] = kv.split('=', 2);
      return [k, v] as const;
    }),
  );
  const timestamp = parts.t;
  const signatures = signatureHeader.split(',').filter((kv) => kv.startsWith('v1=')).map((kv) => kv.slice(3));
  if (!timestamp || signatures.length === 0) return false;
  if (Math.abs(now().getTime() / 1000 - Number(timestamp)) > toleranceSeconds) return false;

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  return signatures.some((sig) => {
    const sigBuf = Buffer.from(sig, 'hex');
    return sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf);
  });
}

interface StripeEvent {
  type: string;
  data: { object: Record<string, unknown> };
}

/**
 * Applies the subset of Stripe subscription lifecycle events this app
 * cares about. `checkout.session.completed` links a session to a user via
 * `client_reference_id` (set at Checkout creation above); the two
 * `customer.subscription.*` events that follow carry the actual status
 * and period end, looked up by Stripe's own subscription id.
 */
export function applySubscriptionEvent(db: AppDb, event: StripeEvent): void {
  if (event.type === 'checkout.session.completed') {
    const obj = event.data.object as { client_reference_id?: string | null; subscription?: string | null };
    if (!obj.client_reference_id || !obj.subscription) return;
    const userId = obj.client_reference_id;
    const existing = db.select().from(subscriptions).where(eq(subscriptions.providerRef, obj.subscription)).all()[0];
    if (!existing) {
      db.insert(subscriptions).values({ id: newId(), userId, provider: 'stripe', providerRef: obj.subscription, status: 'active' }).run();
    }
    db.update(users).set({ plan: 'paid' }).where(eq(users.id, userId)).run();
    return;
  }

  if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    const obj = event.data.object as { id: string; status: string; current_period_end?: number };
    const sub = db.select().from(subscriptions).where(eq(subscriptions.providerRef, obj.id)).all()[0];
    if (!sub) return;
    const periodEnd = obj.current_period_end ? new Date(obj.current_period_end * 1000).toISOString() : null;
    db.update(subscriptions).set({ status: obj.status, currentPeriodEnd: periodEnd }).where(eq(subscriptions.id, sub.id)).run();

    const active = obj.status === 'active' || obj.status === 'trialing';
    db.update(users)
      .set(active ? { plan: 'paid', planExpiresAt: periodEnd } : { plan: 'free', planExpiresAt: null })
      .where(eq(users.id, sub.userId))
      .run();
  }
}
