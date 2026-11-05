/**
 * One-time cleanup of stores that have no coordinates. Opens the database
 * through runMigrations, so it APPLIES any pending migrations: run it only
 * where this code is deployed. To just count against an older deployment, use
 * the read-only scripts/count-unlocated-stores.mjs.
 *
 * A bare chain name ("Kroger", no address) or a bare street address can't be
 * placed by itself, but if you know which store those reports belong to,
 * --move re-files them there (the target must already exist, with coordinates). Whatever is left unplaced
 * is deleted with --apply, along with its reports, votes, credits and prices.
 *
 *   npm run cleanup-unlocated -- \
 *     --move "Kroger=Kroger @ 4901 Maple Avenue" \
 *     --move "Walmart=Walmart @ 9410 Webb Chapel Rd" \
 *     --move "9410 Webb Chapel Road=Walmart @ 9410 Webb Chapel Rd"   # dry run: shows the plan
 *   npm run cleanup-unlocated -- --move ... --apply        # does it, in one transaction
 */
import { runMigrations } from './db/migrate.js';
import { env } from './env.js';
import { CleanupError, cleanupUnlocatedStores, type StoreMove } from './services/cleanupUnlocated.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const moves: StoreMove[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--move') continue;
  const spec = args[++i] ?? '';
  const eq = spec.indexOf('=');
  if (eq < 1) {
    console.error(`--move needs "Chain name or street address=Chain @ Street Address", got "${spec}".`);
    process.exit(1);
  }
  moves.push({ from: spec.slice(0, eq).trim(), to: spec.slice(eq + 1).trim() });
}

const { db, sqlite } = runMigrations(env.DATABASE_PATH);
try {
  const summary = cleanupUnlocatedStores(db, { apply, moves });
  for (const m of summary.moves) {
    console.log(`MOVE ${m.from}: ${m.reports} report(s) from ${m.stores.length} store(s) -> ${m.to.name} @ ${m.to.address} (${m.to.lat}, ${m.to.lon})`);
  }
  for (const s of summary.stores) console.log(`${apply ? 'DELETED' : 'WOULD DELETE'} ${s.name}${s.address ? ` @ ${s.address}` : ''}: ${s.reports} report(s), ${s.activeReports} active`);
  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    movedReports: summary.moves.reduce((n, m) => n + m.reports, 0),
    storesLeftUnplaced: summary.stores.length,
    reportsToDelete: summary.reports,
    deleted: summary.deleted,
  }, null, 2));
  if (!apply && (summary.moves.length > 0 || summary.stores.length > 0)) console.log('Re-run with --apply to do it.');
} catch (err) {
  if (err instanceof CleanupError) {
    console.error(err.message);
    process.exitCode = 1;
  } else {
    throw err;
  }
} finally {
  sqlite.close();
}
