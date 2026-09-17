import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDb } from './client.js';
import { env } from '../env.js';

/**
 * Applies every migration in ./drizzle that hasn't run yet. Safe to call on
 * every server start (drizzle tracks what's applied in its own table), and
 * is also the standalone `npm run db:migrate` script for CI/deploy.
 */
export function runMigrations(databasePath: string) {
  const { db, sqlite } = openDb(databasePath);
  migrate(db, { migrationsFolder: new URL('../../drizzle', import.meta.url).pathname });
  return { db, sqlite };
}

// Only run automatically when invoked directly (`npm run db:migrate`), not
// when imported by the app or by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { sqlite } = runMigrations(env.DATABASE_PATH);
  console.log(`Migrations applied to ${env.DATABASE_PATH}`);
  sqlite.close();
}
