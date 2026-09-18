import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { sql } from 'drizzle-orm';
import type { AppDb } from './db/client.js';
import type { AppEnv } from './lib/authenticate.js';
import { ConsoleMailer, type Mailer } from './lib/mail.js';
import { authRoutes } from './routes/auth.js';
import { deviceRoutes } from './routes/devices.js';
import { meRoutes } from './routes/me.js';

export interface AppContext {
  db: AppDb;
  corsOrigins: string[];
  /** Defaults to logging codes to the console; tests inject a fake to capture them. */
  mailer?: Mailer;
}

/**
 * Builds the Hono app. Takes its dependencies (the db, config) as
 * parameters rather than reading globals, so tests can spin up an app over
 * an isolated in-memory database and a fake mailer.
 */
export function createApp({ db, corsOrigins, mailer = new ConsoleMailer() }: AppContext) {
  const app = new Hono<AppEnv>();

  app.use('*', cors({ origin: corsOrigins }));

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  // Cheap end-to-end check that the database is reachable and migrated.
  app.get('/api/db-check', (c) => {
    const row = db.get<{ ok: number }>(sql`select 1 as ok`);
    return c.json({ ok: row?.ok === 1 });
  });

  app.route('/api/auth', authRoutes({ db, mailer }));
  app.route('/api/devices', deviceRoutes(db));
  app.route('/api/me', meRoutes(db));

  // Sync, product, flag, and admin routes are added as each is implemented
  // (see docs/server-sync-plan.md sections 7-9).

  return app;
}
