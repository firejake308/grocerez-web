import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { requireUser, type AppEnv } from '../lib/authenticate.js';
import { BillingError, checkoutConfigured, handleWebhookEvent, isLiveKey, StripeClient, verifyWebhookSignature, type StripeConfig } from '../services/billing.js';
import { entitlementLevel, RedeemError, redeemFreeMonth } from '../services/entitlements.js';
import { consumeRateLimit, LIMITS } from '../services/rateLimit.js';
import { entitlementSummary } from './me.js';

export type BillingDeps = StripeConfig;

const MAX_WEBHOOK_BYTES = 1_000_000;

const eventSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  created: z.number().int().nonnegative(),
  livemode: z.boolean(),
  data: z.object({ object: z.record(z.unknown()) }),
});

/**
 * Stripe Checkout, billing portal, webhook, and credit redemption (plan
 * section 6.3). The Stripe-backed routes 503 when their config is unset,
 * the same pattern /api/admin uses for ADMIN_TOKEN, rather than crashing on
 * startup without live keys. Redeeming credits needs no Stripe at all.
 */
export function billingRoutes(db: AppDb, deps: BillingDeps, entitlementsEnforced = false, now: () => Date = () => new Date()) {
  const router = new Hono<AppEnv>();
  const stripe = new StripeClient(deps);

  const respondToError = (err: unknown) => {
    if (err instanceof BillingError) return { body: { error: err.message }, status: err.status };
    console.error(err);
    return { body: { error: 'Internal error' }, status: 500 as const };
  };

  router.post('/checkout', requireUser(db), async (c) => {
    if (!checkoutConfigured(deps)) return c.json({ error: 'Subscriptions are not configured yet.' }, 503);
    const auth = c.get('auth');
    if (auth.kind !== 'session') return c.json({ error: 'Sign-in required' }, 401);
    const user = db.select().from(users).where(eq(users.id, auth.userId)).all()[0];
    if (!user) return c.json({ error: 'Sign-in required' }, 401);

    if (entitlementLevel(user, now) === 'subscriber') return c.json({ error: 'You already have an active subscription.' }, 409);
    if (!consumeRateLimit(db, `checkout:${user.id}`, LIMITS.checkoutPerUserHour, now)) {
      return c.json({ error: 'Too many checkout attempts. Try again later.' }, 429);
    }

    try {
      await stripe.verifyPrice();
      const customerId = await stripe.ensureCustomer(db, user);
      const session = await stripe.createCheckoutSession(user.id, customerId);
      return c.json({ url: session.url });
    } catch (err) {
      const { body, status } = respondToError(err);
      return c.json(body, status);
    }
  });

  router.post('/portal', requireUser(db), async (c) => {
    if (!deps.apiKey) return c.json({ error: 'Subscriptions are not configured yet.' }, 503);
    const auth = c.get('auth');
    if (auth.kind !== 'session') return c.json({ error: 'Sign-in required' }, 401);
    const user = db.select().from(users).where(eq(users.id, auth.userId)).all()[0];
    if (!user) return c.json({ error: 'Sign-in required' }, 401);
    if (!user.stripeCustomerId) return c.json({ error: 'No billing account yet. Subscribe first.' }, 404);

    try {
      const session = await stripe.createPortalSession(user.stripeCustomerId);
      return c.json({ url: session.url });
    } catch (err) {
      const { body, status } = respondToError(err);
      return c.json(body, status);
    }
  });

  router.post('/redeem-credits', requireUser(db), (c) => {
    const auth = c.get('auth');
    if (auth.kind !== 'session') return c.json({ error: 'Sign-in required' }, 401);
    try {
      redeemFreeMonth(db, auth.userId, now);
    } catch (err) {
      if (err instanceof RedeemError) return c.json({ error: err.message }, err.status);
      throw err;
    }
    const user = db.select().from(users).where(eq(users.id, auth.userId)).all()[0];
    return c.json({ entitlement: entitlementSummary(db, user, entitlementsEnforced, checkoutConfigured(deps), now) });
  });

  // No requireAuth: Stripe calls this unauthenticated and is verified by signature instead.
  router.post('/webhook', async (c) => {
    if (!deps.webhookSecret) return c.json({ error: 'Webhooks are not configured yet.' }, 503);
    const declaredLength = Number(c.req.header('Content-Length') ?? 0);
    if (declaredLength > MAX_WEBHOOK_BYTES) return c.json({ error: 'Payload too large.' }, 400);
    const rawBody = await c.req.text();
    if (rawBody.length > MAX_WEBHOOK_BYTES) return c.json({ error: 'Payload too large.' }, 400);

    if (!verifyWebhookSignature(rawBody, c.req.header('Stripe-Signature') ?? '', deps.webhookSecret, 300, now)) {
      return c.json({ error: 'Invalid signature.' }, 400);
    }

    let parsed: z.infer<typeof eventSchema>;
    try {
      parsed = eventSchema.parse(JSON.parse(rawBody));
    } catch {
      return c.json({ error: 'Malformed event.' }, 400);
    }

    try {
      const outcome = handleWebhookEvent(db, parsed, { livemode: deps.apiKey ? isLiveKey(deps.apiKey) : null }, now);
      return c.json(outcome === 'duplicate' ? { received: true, duplicate: true } : { received: true });
    } catch (err) {
      console.error('Failed to apply billing webhook event:', parsed.id, parsed.type, err);
      return c.json({ error: 'Internal error' }, 500);
    }
  });

  return router;
}
