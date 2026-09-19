import { Hono } from 'hono';
import { z } from 'zod';
import type { AppDb } from '../db/client.js';
import { requireUser, type AppEnv } from '../lib/authenticate.js';
import { castVote, removeVote, VoteError } from '../services/votes.js';

const flagSchema = z.object({
  reason: z.enum(['wrong_price', 'wrong_item', 'expired', 'duplicate', 'spam', 'other']),
  note: z.string().max(500).optional(),
});

/** Confirm / flag / withdraw (plan section 9.3). Voting needs an account: a vote's weight is the voter's trust. */
export function reportRoutes(db: AppDb, now: () => Date = () => new Date()) {
  const router = new Hono<AppEnv>();

  router.onError((err, c) => {
    if (err instanceof VoteError) return c.json({ error: err.message }, err.status as 400 | 403 | 404 | 409 | 429);
    console.error(err);
    return c.json({ error: 'Internal error' }, 500);
  });

  const userId = (auth: AppEnv['Variables']['auth']): string | null => (auth.kind === 'session' ? auth.userId : null);

  // requireUser is applied per route rather than via router.use('*', ...):
  // /api/reports/:id/photo is mounted separately at this same prefix (see
  // routes/photos.ts) with its own, different auth (author or admin token),
  // and a wildcard middleware here would otherwise intercept it too.
  router.post('/:id/confirm', requireUser(db), (c) => {
    const uid = userId(c.get('auth'));
    if (!uid) return c.json({ error: 'Sign-in required' }, 401);
    return c.json(castVote(db, { userId: uid, reportId: c.req.param('id')!, kind: 'confirm' }, now));
  });

  router.post('/:id/flag', requireUser(db), async (c) => {
    const uid = userId(c.get('auth'));
    if (!uid) return c.json({ error: 'Sign-in required' }, 401);
    const body = flagSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'A flag needs a reason (wrong_price, wrong_item, expired, duplicate, spam, other).' }, 400);
    return c.json(castVote(db, { userId: uid, reportId: c.req.param('id')!, kind: 'flag', reason: body.data.reason, note: body.data.note }, now));
  });

  router.delete('/:id/vote', requireUser(db), (c) => {
    const uid = userId(c.get('auth'));
    if (!uid) return c.json({ error: 'Sign-in required' }, 401);
    return c.json(removeVote(db, uid, c.req.param('id')!, now));
  });

  return router;
}
