import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { runMigrations } from './db/migrate.js';
import { createMailer } from './lib/mail.js';
import { env } from './env.js';
import { recomputeAllTrust } from './services/trust.js';
import { cleanupPhotos } from './services/photos.js';
import { computeFreeTierForAllRegions, evaluateContributionCredits } from './services/entitlements.js';

const { db, sqlite } = runMigrations(env.DATABASE_PATH);
const mailer = createMailer(env.MAIL_PROVIDER, env.RESEND_API_KEY, env.MAIL_FROM);

const app = createApp({
  db,
  corsOrigins: env.CORS_ORIGINS,
  mailer,
  geo: { overpassUrl: env.OVERPASS_URL, nominatimUrl: env.NOMINATIM_URL, userAgent: 'GrocerEZ-sync/0.1' },
  adminToken: env.ADMIN_TOKEN,
  entitlementsEnforced: env.ENTITLEMENTS_ENFORCED,
  parse: {
    apiKey: env.OPENROUTER_API_KEY,
    centsPer1kTokens: env.OPENROUTER_CENTS_PER_1K_TOKENS,
    dailyBudgetCents: env.PARSE_DAILY_BUDGET_CENTS,
    photoDir: env.PHOTO_DIR,
  },
  billing: {
    secretKey: env.STRIPE_SECRET,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    priceId: env.STRIPE_PRICE_ID,
    appUrl: env.APP_URL,
  },
});

// Periodic maintenance: things with no single event to hook, so they run
// on a timer instead. Trust (section 9.2) needs the 14-day "unflagged
// counts as confirmed" rule recomputed for everyone; photo evidence
// (Phase 3) needs its 90-day retention swept; the free tier (6.3.1) is a
// nightly-recomputed table, and contribution credits (6.3.2) need their
// own 14-day "unflagged counts as verified" rule evaluated periodically,
// the same shape as the trust rule above.
const MAINTENANCE_MS = 6 * 60 * 60 * 1000;
const runMaintenance = () => {
  try {
    console.log(`Trust recomputed for ${recomputeAllTrust(db)} users`);
  } catch (err) {
    console.error('Trust maintenance failed:', err);
  }
  try {
    console.log(`Free tier recomputed for ${computeFreeTierForAllRegions(db)} region(s)`);
    console.log(`${evaluateContributionCredits(db)} contribution credit(s) awarded`);
  } catch (err) {
    console.error('Entitlements maintenance failed:', err);
  }
  cleanupPhotos(db, env.PHOTO_DIR)
    .then((deleted) => { if (deleted > 0) console.log(`Cleaned up ${deleted} expired photo(s)`); })
    .catch((err) => console.error('Photo cleanup failed:', err));
};
runMaintenance();
const maintenanceTimer = setInterval(runMaintenance, MAINTENANCE_MS);
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
