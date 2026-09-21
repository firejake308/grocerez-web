import { Hono } from 'hono';
import { z } from 'zod';
import type { AppDb } from '../db/client.js';
import { AdminError, listFlags, mergeProducts, resolveFlag, setUserStatus } from '../services/admin.js';
import { recomputeAllTrust } from '../services/trust.js';

/**
 * Section 9.5: JSON admin endpoints behind a shared ADMIN_TOKEN. With no
 * token configured they answer 503 rather than being open. The CLI
 * (src/admin-cli.ts) calls the same services directly on the box.
 */
export function adminRoutes(db: AppDb, adminToken: string, now: () => Date = () => new Date()) {
  const router = new Hono();

  router.use('*', async (c, next) => {
    if (!adminToken) return c.json({ error: 'Admin endpoints are disabled (ADMIN_TOKEN is not set).' }, 503);
    const header = c.req.header('Authorization') ?? '';
    if (header !== `Bearer ${adminToken}`) return c.json({ error: 'Admin token required.' }, 401);
    await next();
  });

  router.onError((err, c) => {
    if (err instanceof AdminError) return c.json({ error: err.message }, err.status as 400 | 404 | 409);
    console.error(err);
    return c.json({ error: 'Internal error' }, 500);
  });

  router.get('/flags', (c) => {
    const status = c.req.query('status') === 'resolved' ? 'resolved' : 'open';
    return c.json({ flags: listFlags(db, status) });
  });

  router.post('/flags/:id/resolve', async (c) => {
    const body = z.object({ resolution: z.enum(['upheld', 'dismissed']) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'resolution must be "upheld" or "dismissed".' }, 400);
    return c.json(resolveFlag(db, c.req.param('id'), body.data.resolution, now));
  });

  router.post('/products/:id/merge-into/:targetId', (c) => {
    return c.json(mergeProducts(db, c.req.param('id'), c.req.param('targetId'), now));
  });

  router.patch('/users/:id', async (c) => {
    const body = z.object({ status: z.enum(['active', 'restricted', 'banned']) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'status must be active, restricted, or banned.' }, 400);
    return c.json(setUserStatus(db, c.req.param('id'), body.data.status, now));
  });

  router.post('/trust/recompute', (c) => c.json({ users: recomputeAllTrust(db, now) }));

  return router;
}
