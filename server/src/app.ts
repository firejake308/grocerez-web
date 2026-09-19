import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { sql } from 'drizzle-orm';
import type { AppDb } from './db/client.js';
import { authenticate, type AppEnv } from './lib/authenticate.js';
import { ConsoleMailer, type Mailer } from './lib/mail.js';
import { authRoutes } from './routes/auth.js';
import { deviceRoutes } from './routes/devices.js';
import { meRoutes } from './routes/me.js';
import { syncRoutes } from './routes/sync.js';
import { geoRoutes } from './routes/geo.js';
import { reportRoutes } from './routes/reports.js';
import { productRoutes } from './routes/products.js';
import { adminRoutes } from './routes/admin.js';
import { consumeRateLimit, LIMITS } from './services/rateLimit.js';
import type { GeoDeps } from './services/geo.js';

export interface AppContext {
  db: AppDb;
  corsOrigins: string[];
  /** Defaults to logging codes to the console; tests inject a fake to capture them. */
  mailer?: Mailer;
  /** Overpass/Nominatim settings; tests inject a fake fetch. Defaults to no Overpass and public Nominatim. */
  geo?: GeoDeps;
  /** Shared secret for /api/admin (plan section 9.5). Empty disables those routes. */
  adminToken?: string;
  /** Injectable clock for time-based rules (rate limits, staleness) in tests. */
  now?: () => Date;
}

/**
 * Builds the Hono app. Takes its dependencies (the db, config) as
 * parameters rather than reading globals, so tests can spin up an app over
 * an isolated in-memory database and a fake mailer.
 */
export function createApp({
  db,
  corsOrigins,
  mailer = new ConsoleMailer(),
  geo = { overpassUrl: '', nominatimUrl: 'https://nominatim.openstreetmap.org' },
  adminToken = '',
  now = () => new Date(),
}: AppContext) {
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
  app.route('/api/sync', syncRoutes(db, now));

  // The geo proxy is metered per caller so a single device can't use the
  // server as a relay to Nominatim or the Overpass box (section 9.4).
  app.use('/api/geo/*', async (c, next) => {
    // Runs before the geo router's requireAuth, so resolve the caller here;
    // an unauthenticated request passes through to be rejected there.
    const auth = authenticate(db, c.req.header('Authorization'));
    const key = auth ? (auth.kind === 'session' ? `geo:user:${auth.userId}` : `geo:device:${auth.deviceId}`) : null;
    if (key && !consumeRateLimit(db, key, LIMITS.geoPerCallerHour, now)) {
      return c.json({ error: 'Too many location lookups in the last hour. Try again later.' }, 429);
    }
    await next();
  });
  app.route('/api/geo', geoRoutes(db, geo));
  app.route('/api/reports', reportRoutes(db, now));
  app.route('/api/products', productRoutes(db, now));
  app.route('/api/admin', adminRoutes(db, adminToken, now));

  return app;
}
