import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { requireUser, type AppEnv } from '../lib/authenticate.js';
import { tierForUser } from '../services/trust.js';
import { subscriptions } from '../db/schema.js';
import { SUBSCRIPTION_PRICE_CENTS } from '../services/billing.js';
import { CREDIT_EXPIRY_DAYS, CREDITS_PER_FREE_MONTH, CREDITS_PER_VERIFIED_REPORT, creditBalance, entitlementLevel } from '../services/entitlements.js';

const updateMeSchema = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  homeLat: z.number().min(-90).max(90).nullable().optional(),
  homeLon: z.number().min(-180).max(180).nullable().optional(),
});

/** What the client needs to render membership: level, subscription state, and the credit balance. */
export function entitlementSummary(db: AppDb, user: typeof users.$inferSelect, enforced: boolean, billingConfigured: boolean, now: () => Date) {
  // The subscription with the latest period end is the one that matters; a stale canceled one sorts behind a live one.
  const subscription = db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, user.id))
    .all()
    .sort((a, b) => (b.currentPeriodEnd ?? '').localeCompare(a.currentPeriodEnd ?? ''))[0];

  return {
    enforced,
    level: entitlementLevel(user, now),
    billingConfigured,
    priceCents: SUBSCRIPTION_PRICE_CENTS,
    plan: user.plan,
    planExpiresAt: user.planExpiresAt,
    subscription: subscription
      ? { status: subscription.status, currentPeriodEnd: subscription.currentPeriodEnd, cancelAtPeriodEnd: subscription.cancelAtPeriodEnd }
      : null,
    creditAccessUntil: user.creditAccessUntil,
    credits: {
      balance: creditBalance(db, user.id, now),
      perReport: CREDITS_PER_VERIFIED_REPORT,
      perFreeMonth: CREDITS_PER_FREE_MONTH,
      expiryDays: CREDIT_EXPIRY_DAYS,
    },
  };
}

const toProfile = (db: AppDb, user: typeof users.$inferSelect, enforced: boolean, billingConfigured: boolean, now: () => Date) => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  homeLat: user.homeLat,
  homeLon: user.homeLon,
  tier: tierForUser(user),
  counts: {
    reports: user.reportsCount,
    confirmed: user.confirmedCount,
    upheldFlags: user.upheldFlagsCount,
  },
  entitlement: entitlementSummary(db, user, enforced, billingConfigured, now),
});

export function meRoutes(db: AppDb, entitlementsEnforced = false, now: () => Date = () => new Date(), billingConfigured = false) {
  const router = new Hono<AppEnv>();

  router.get('/', requireUser(db), (c) => {
    const auth = c.get('auth');
    // requireUser only calls next() for the 'session' branch; this narrows
    // the type accordingly (auth.userId is otherwise string | null).
    if (auth.kind !== 'session') return c.json({ error: 'Sign-in required' }, 401);
    const user = db.select().from(users).where(eq(users.id, auth.userId)).all()[0];
    if (!user) return c.json({ error: 'Not found' }, 404);
    return c.json(toProfile(db, user, entitlementsEnforced, billingConfigured, now));
  });

  router.patch('/', requireUser(db), async (c) => {
    const auth = c.get('auth');
    if (auth.kind !== 'session') return c.json({ error: 'Sign-in required' }, 401);
    const body = await c.req.json().catch(() => null);
    const parsed = updateMeSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request.' }, 400);

    db.update(users).set(parsed.data).where(eq(users.id, auth.userId)).run();
    const user = db.select().from(users).where(eq(users.id, auth.userId)).all()[0];
    if (!user) return c.json({ error: 'Not found' }, 404);
    return c.json(toProfile(db, user, entitlementsEnforced, billingConfigured, now));
  });

  return router;
}
