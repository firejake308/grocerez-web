import { Hono } from 'hono';
import fs from 'node:fs/promises';
import type { AppDb } from '../db/client.js';
import { authenticate } from '../lib/authenticate.js';
import { checkPhotoAccess } from '../services/photos.js';

/**
 * Photo evidence retrieval (Phase 3): visible only to the report's own
 * author or an admin. Admin access reuses the same shared ADMIN_TOKEN as
 * /api/admin (section 9.5) rather than a session, since reviewing a flag
 * is an admin action, not a user one.
 */
export function photoRoutes(db: AppDb, photoDir: string, adminToken: string) {
  const router = new Hono();

  router.get('/:id/photo', async (c) => {
    const header = c.req.header('Authorization') ?? '';
    const isAdmin = !!adminToken && header === `Bearer ${adminToken}`;
    const auth = isAdmin ? null : authenticate(db, header);
    const requesterUserId = auth?.kind === 'session' ? auth.userId : null;

    const { allowed, filePath } = checkPhotoAccess(db, photoDir, c.req.param('id'), requesterUserId, isAdmin);
    if (!allowed || !filePath) return c.json({ error: 'Not found.' }, 404);

    try {
      const bytes = await fs.readFile(filePath);
      return c.body(new Uint8Array(bytes), 200, { 'Content-Type': 'image/jpeg' });
    } catch {
      return c.json({ error: 'Not found.' }, 404);
    }
  });

  return router;
}
