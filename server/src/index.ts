import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { openDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { env } from './env.js';

const { db, sqlite } = runMigrations(env.DATABASE_PATH);
void openDb; // kept for tests / future callers that don't want a migration run

const app = createApp({ db, corsOrigins: env.CORS_ORIGINS });

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
