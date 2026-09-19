import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { runMigrations } from './db/migrate.js';
import { createMailer } from './lib/mail.js';
import { env } from './env.js';
import { recomputeAllTrust } from './services/trust.js';

const { db, sqlite } = runMigrations(env.DATABASE_PATH);
const mailer = createMailer(env.MAIL_PROVIDER, env.RESEND_API_KEY, env.MAIL_FROM);

const app = createApp({
  db,
  corsOrigins: env.CORS_ORIGINS,
  mailer,
  geo: { overpassUrl: env.OVERPASS_URL, nominatimUrl: env.NOMINATIM_URL, userAgent: 'GrocerEZ-sync/0.1' },
  adminToken: env.ADMIN_TOKEN,
});

// Trust maintenance (plan section 9.2): the 14-day "unflagged counts as
// confirmed" rule has no event to hook, so recompute everyone periodically.
const TRUST_MAINTENANCE_MS = 6 * 60 * 60 * 1000;
const runTrustMaintenance = () => {
  try {
    console.log(`Trust recomputed for ${recomputeAllTrust(db)} users`);
  } catch (err) {
    console.error('Trust maintenance failed:', err);
  }
};
runTrustMaintenance();
const maintenanceTimer = setInterval(runTrustMaintenance, TRUST_MAINTENANCE_MS);
maintenanceTimer.unref();

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`grocerez-server listening on http://localhost:${info.port}`);
});

const shutdown = () => {
  console.log('Shutting down...');
  server.close();
  sqlite.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
