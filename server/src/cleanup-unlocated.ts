/**
 * One-time cleanup: lists, and with --apply deletes, stores that have no
 * coordinates, together with their price reports. Opens the database through
 * runMigrations, so it APPLIES any pending migrations: run it only where this
 * code is deployed. To just count against an older deployment, use the
 * read-only scripts/count-unlocated-stores.mjs. Talks to the database
 * directly, so run it on the box (stop or accept brief contention with the API):
 *
 *   npm run cleanup-unlocated            # count and list only
 *   npm run cleanup-unlocated -- --apply # delete them
 */
import { runMigrations } from './db/migrate.js';
import { env } from './env.js';
import { cleanupUnlocatedStores } from './services/cleanupUnlocated.js';

const apply = process.argv.includes('--apply');
const { db, sqlite } = runMigrations(env.DATABASE_PATH);
try {
  const summary = cleanupUnlocatedStores(db, { apply });
  for (const s of summary.stores) console.log(`${s.name}${s.address ? ` @ ${s.address}` : ''}: ${s.reports} report(s), ${s.activeReports} active`);
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', stores: summary.stores.length, reports: summary.reports, activeReports: summary.activeReports, deleted: summary.deleted }, null, 2));
  if (!apply && summary.stores.length > 0) console.log('Re-run with --apply to delete them.');
} finally {
  sqlite.close();
}
