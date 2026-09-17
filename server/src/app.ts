import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppDb } from './db/client.js';
import { sql } from 'drizzle-orm';

export interface AppContext {
  db: AppDb;
  corsOrigins: string[];
}

/**
 * Builds the Hono app. Takes its dependencies (the db, config) as
 * parameters rather than reading globals, so tests can spin up an app over
 * an isolated in-memory database.
 */
export function createApp({ db, corsOrigins }: AppContext) {
  const app = new Hono();

  app.use('*', cors({ origin: corsOrigins }));

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  // Cheap end-to-end check that the database is reachable and migrated.
  app.get('/api/db-check', (c) => {
    const row = db.get<{ ok: number }>(sql`select 1 as ok`);
    return c.json({ ok: row?.ok === 1 });
  });

  // Route modules for auth, sync, products, flags, and admin are added as
  // each is implemented (see docs/server-sync-plan.md sections 6-9).

  return app;
}
