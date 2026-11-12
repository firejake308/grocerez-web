// Sets the street address of ONE located store that has none. Needs only better-sqlite3
// (already in the API image). It changes nothing unless you pass --apply, refuses unless exactly
// one store matches, and only ever fills in an empty address.
//
//   docker compose exec -T api node --input-type=module - "WinCo Foods" "8968 Tehama Ridge Parkway" < set-store-address.mjs
//   docker compose exec -T api node --input-type=module - "WinCo Foods" "8968 Tehama Ridge Parkway" --apply < set-store-address.mjs
import Database from 'better-sqlite3';

const [name, address] = process.argv.slice(2).filter((a) => a !== '-' && !a.startsWith('--'));
const apply = process.argv.includes('--apply');
if (!name || !address) {
  console.error('usage: node - "<store name>" "<street address>" [--apply] < set-store-address.mjs');
  process.exit(1);
}

const path = process.env.DATABASE_PATH || './data/grocerez.db';
const db = new Database(path, { readonly: !apply, fileMustExist: true });
try {
  const matches = db.prepare(
    `SELECT id, name, address, lat, lon FROM stores
     WHERE lower(name) = lower(?) AND address IS NULL AND lat IS NOT NULL AND lon IS NOT NULL`,
  ).all(name);
  console.log(`${matches.length} located store(s) named "${name}" with no address:`);
  for (const m of matches) console.log(`  ${m.id}  (${m.lat}, ${m.lon})`);
  if (matches.length !== 1) {
    console.error(matches.length === 0 ? 'Nothing to do.' : 'More than one match; refusing to guess. Nothing was changed.');
    process.exit(matches.length === 0 ? 0 : 1);
  }
  if (!apply) {
    console.log(`Would set the address to "${address}". Re-run with --apply to do it.`);
  } else {
    const res = db.prepare('UPDATE stores SET address = ? WHERE id = ? AND address IS NULL').run(address, matches[0].id);
    console.log(`Set the address to "${address}" (${res.changes} row changed).`);
  }
} finally {
  db.close();
}
