import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { requireUser, type AppEnv } from '../lib/authenticate.js';
import { tierForUser } from '../services/trust.js';
import { CREDITS_PER_MONTH, creditsThisMonth, entitlementLevel } from '../services/entitlements.js';

const updateMeSchema = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  homeLat: z.number().min(-90).max(90).nullable().optional(),
  homeLon: z.number().min(-180).max(180).nullable().optional(),
});

const toProfile = (db: AppDb, user: typeof users.$inferSelect, enforced: boolean, now: () => Date) => ({
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
  entitlement: {
    enforced,
    level: entitlementLevel(db, user, now),
    plan: user.plan,
    planExpiresAt: user.planExpiresAt,
    credits: { earned: creditsThisMonth(db, user.id, now), needed: CREDITS_PER_MONTH },
  },
});

export function meRoutes(db: AppDb, entitlementsEnforced = false, now: () => Date = () => new Date()) {
  const router = new Hono<AppEnv>();

  router.get('/', requireUser(db), (c) => {
    const auth = c.get('auth');
    // requireUser only calls next() for the 'session' branch; this narrows
    // the type accordingly (auth.userId is otherwise string | null).
    if (auth.kind !== 'session') return c.json({ error: 'Sign-in required' }, 401);
    const user = db.select().from(users).where(eq(users.id, auth.userId)).all()[0];
    if (!user) return c.json({ error: 'Not found' }, 404);
    return c.json(toProfile(db, user, entitlementsEnforced, now));
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
    return c.json(toProfile(db, user, entitlementsEnforced, now));
  });

  return router;
}
