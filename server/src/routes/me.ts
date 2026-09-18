import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { requireUser, type AppEnv } from '../lib/authenticate.js';
import { trustTier } from '../services/trust.js';

const updateMeSchema = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  homeLat: z.number().min(-90).max(90).nullable().optional(),
  homeLon: z.number().min(-180).max(180).nullable().optional(),
});

const toProfile = (user: typeof users.$inferSelect) => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  homeLat: user.homeLat,
  homeLon: user.homeLon,
  tier: trustTier(user.reportsCount, user.confirmedCount, user.upheldFlagsCount),
  counts: {
    reports: user.reportsCount,
    confirmed: user.confirmedCount,
    upheldFlags: user.upheldFlagsCount,
  },
  // ENTITLEMENTS_ENFORCED lands in Phase 3 (plan section 6.3.3); everyone
  // has full access while it's off.
  entitlement: { enforced: false, plan: user.plan, planExpiresAt: user.planExpiresAt },
});

export function meRoutes(db: AppDb) {
  const router = new Hono<AppEnv>();

  router.get('/', requireUser(db), (c) => {
    const auth = c.get('auth');
    // requireUser only calls next() for the 'session' branch; this narrows
    // the type accordingly (auth.userId is otherwise string | null).
    if (auth.kind !== 'session') return c.json({ error: 'Sign-in required' }, 401);
    const user = db.select().from(users).where(eq(users.id, auth.userId)).all()[0];
    if (!user) return c.json({ error: 'Not found' }, 404);
    return c.json(toProfile(user));
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
    return c.json(toProfile(user));
  });

  return router;
}
