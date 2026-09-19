import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { requireUser, type AppEnv } from '../lib/authenticate.js';
import { applySubscriptionEvent, BillingError, createCheckoutSession, verifyWebhookSignature } from '../services/billing.js';

export interface BillingDeps {
  secretKey: string;
  webhookSecret: string;
  priceId: string;
  appUrl: string;
}

/**
 * Stripe Checkout + webhook (Phase 3, plan section 6.3.3). Both routes
 * 503 when their secret is unset, the same pattern /api/admin uses for
 * ADMIN_TOKEN, rather than crashing on startup without live keys.
 */
export function billingRoutes(db: AppDb, deps: BillingDeps, now: () => Date = () => new Date()) {
  const router = new Hono<AppEnv>();

  router.post('/checkout', requireUser(db), async (c) => {
    if (!deps.secretKey || !deps.priceId) return c.json({ error: 'Subscriptions are not configured yet.' }, 503);
    const auth = c.get('auth');
    if (auth.kind !== 'session') return c.json({ error: 'Sign-in required' }, 401);
    const user = db.select().from(users).where(eq(users.id, auth.userId)).all()[0];
    if (!user) return c.json({ error: 'Sign-in required' }, 401);

    try {
      const session = await createCheckoutSession(deps.secretKey, deps.priceId, deps.appUrl, user.id, user.email);
      return c.json({ url: session.url });
    } catch (err) {
      if (err instanceof BillingError) return c.json({ error: err.message }, err.status as 502);
      console.error(err);
      return c.json({ error: 'Internal error' }, 500);
    }
  });

  // No requireAuth: Stripe calls this unauthenticated and is verified by signature instead.
  router.post('/webhook', async (c) => {
    if (!deps.webhookSecret) return c.json({ error: 'Webhooks are not configured yet.' }, 503);
    const signature = c.req.header('Stripe-Signature') ?? '';
    const rawBody = await c.req.text();
    if (!verifyWebhookSignature(rawBody, signature, deps.webhookSecret, 300, now)) {
      return c.json({ error: 'Invalid signature.' }, 400);
    }

    const event = JSON.parse(rawBody);
    try {
      applySubscriptionEvent(db, event);
    } catch (err) {
      console.error('Failed to apply billing webhook event:', err);
      return c.json({ error: 'Internal error' }, 500);
    }
    return c.json({ received: true });
  });

  return router;
}
