import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { runMigrations } from './db/migrate.js';
import { createMailer } from './lib/mail.js';
import { env } from './env.js';

const { db, sqlite } = runMigrations(env.DATABASE_PATH);
const mailer = createMailer(env.MAIL_PROVIDER, env.RESEND_API_KEY, env.MAIL_FROM);

const app = createApp({
  db,
  corsOrigins: env.CORS_ORIGINS,
  mailer,
  geo: { overpassUrl: env.OVERPASS_URL, nominatimUrl: env.NOMINATIM_URL, userAgent: 'GrocerEZ-sync/0.1' },
});

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
