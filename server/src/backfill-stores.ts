/**
 * One-time cleanup: gives reports saved at a bare address (no store name) a
 * real store, using the same lookup the scanner uses. Talks to the database
 * directly, so run it on the box (stop or accept brief contention with the API):
 *
 *   npm run backfill-stores            # look up and print only
 *   npm run backfill-stores -- --apply # also move the reports to the store found
 */
import { runMigrations } from './db/migrate.js';
import { env } from './env.js';
import { backfillStoreNames } from './services/backfillStores.js';

const apply = process.argv.includes('--apply');
if (!env.OVERPASS_URL) {
  console.error('OVERPASS_URL is not set; there is nothing to look stores up with.');
  process.exit(1);
}

const { db, sqlite } = runMigrations(env.DATABASE_PATH);
try {
  const summary = await backfillStoreNames(
    db,
    { overpassUrl: env.OVERPASS_URL, nominatimUrl: env.NOMINATIM_URL, userAgent: 'GrocerEZ-sync/0.1' },
    { apply, log: (line) => console.log(line) },
  );
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...summary }, null, 2));
  if (!apply && summary.resolved > 0) console.log('Re-run with --apply to move the reports.');
} finally {
  sqlite.close();
}
