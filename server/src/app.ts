import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { sql } from 'drizzle-orm';
import type { AppDb } from './db/client.js';
import { authenticate, type AppEnv } from './lib/authenticate.js';
import { buildCorsOriginMatcher } from './lib/cors.js';
import { ConsoleMailer, type Mailer } from './lib/mail.js';
import { authRoutes } from './routes/auth.js';
import { deviceRoutes } from './routes/devices.js';
import { meRoutes } from './routes/me.js';
import { syncRoutes } from './routes/sync.js';
import { geoRoutes } from './routes/geo.js';
import { reportRoutes } from './routes/reports.js';
import { photoRoutes } from './routes/photos.js';
import { productRoutes } from './routes/products.js';
import { adminRoutes } from './routes/admin.js';
import { parseRoutes, type ParseRouteDeps } from './routes/parse.js';
import { billingRoutes, type BillingDeps } from './routes/billing.js';
import { consumeRateLimit, LIMITS } from './services/rateLimit.js';
import type { GeoDeps } from './services/geo.js';

export interface AppContext {
  db: AppDb;
  corsOrigins: string[];
  /** Netlify site slug (e.g. "imaginative-sorbet-554b69") to also allow that site's deploy-preview and branch-deploy URLs. Empty disables this. */
  netlifySiteSlug?: string;
  /** Defaults to logging codes to the console; tests inject a fake to capture them. */
  mailer?: Mailer;
  /** Overpass/Nominatim settings; tests inject a fake fetch. Defaults to no Overpass and public Nominatim. */
  geo?: GeoDeps;
  /** Shared secret for /api/admin (plan section 9.5) and for admin access to /api/reports/:id/photo. Empty disables admin endpoints. */
  adminToken?: string;
  /** Section 6.3.3. Off by default so seed/dev users keep seeing everything. */
  entitlementsEnforced?: boolean;
  /** AI parse proxy config (Phase 3). Empty apiKey means mock responses, not a crash. */
  parse?: ParseRouteDeps;
  /** Stripe checkout/webhook config (Phase 3). Empty secret means /api/billing/* answers 503. */
  billing?: BillingDeps;
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
  netlifySiteSlug = '',
  mailer = new ConsoleMailer(),
  geo = { overpassUrl: '', nominatimUrl: 'https://nominatim.openstreetmap.org' },
  adminToken = '',
  entitlementsEnforced = false,
  parse = { apiKey: '', centsPer1kTokens: 0.2, dailyBudgetCents: 500, photoDir: './data/photos' },
  billing = { secretKey: '', webhookSecret: '', priceId: '', appUrl: 'http://localhost:5173' },
  now = () => new Date(),
}: AppContext) {
  const app = new Hono<AppEnv>();

  const matchCorsOrigin = buildCorsOriginMatcher(corsOrigins, netlifySiteSlug);
  app.use('*', cors({ origin: (origin) => matchCorsOrigin(origin) }));

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  // Cheap end-to-end check that the database is reachable and migrated.
  app.get('/api/db-check', (c) => {
    const row = db.get<{ ok: number }>(sql`select 1 as ok`);
    return c.json({ ok: row?.ok === 1 });
  });

  app.route('/api/auth', authRoutes({ db, mailer }));
  app.route('/api/devices', deviceRoutes(db));
  app.route('/api/me', meRoutes(db, entitlementsEnforced, now));
  app.route('/api/sync', syncRoutes(db, now, entitlementsEnforced));

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
  app.route('/api/reports', photoRoutes(db, parse.photoDir, adminToken));
  app.route('/api/products', productRoutes(db, now));
  app.route('/api/admin', adminRoutes(db, adminToken, now));
  app.route('/api/parse', parseRoutes(db, parse, now));
  app.route('/api/billing', billingRoutes(db, billing, now));

  return app;
}
