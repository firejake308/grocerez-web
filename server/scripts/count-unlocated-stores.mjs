// Read-only: counts the stores that have no coordinates and the data attached to them.
// Needs nothing from this repo except better-sqlite3 (already in the API image), and it
// never writes, migrates or deletes: it opens the database file read-only and only SELECTs.
//
//   docker compose exec -T api node --input-type=module - < count-unlocated-stores.mjs
//
// The path comes from DATABASE_PATH (the image sets /data/grocerez.db).
import Database from 'better-sqlite3';

const path = process.env.DATABASE_PATH || './data/grocerez.db';
const db = new Database(path, { readonly: true, fileMustExist: true });
try {
  const stores = db.prepare(`
    SELECT s.id, s.name, s.address,
           COUNT(r.id)                                          AS reports,
           COALESCE(SUM(r.status = 'active'), 0)                AS active,
           COUNT(DISTINCT r.product_id)                         AS products,
           COUNT(DISTINCT r.user_id)                            AS authors,
           MAX(r.observed_date)                                 AS newest
    FROM stores s
    LEFT JOIN price_reports r ON r.store_id = s.id
    WHERE s.lat IS NULL OR s.lon IS NULL
    GROUP BY s.id
    ORDER BY reports DESC, s.name`).all();

  for (const s of stores) {
    console.log(`${s.name}${s.address ? ` @ ${s.address}` : ''}: ${s.reports} report(s), ${s.active} active, ${s.products} product(s), ${s.authors} author(s), newest ${s.newest ?? 'n/a'}`);
  }

  const one = (sql) => db.prepare(sql).get();
  const ids = `(SELECT id FROM stores WHERE lat IS NULL OR lon IS NULL)`;
  const summary = {
    database: path,
    storesWithoutCoordinates: stores.length,
    totalStores: one('SELECT COUNT(*) AS n FROM stores').n,
    reportsAtThem: stores.reduce((n, s) => n + s.reports, 0),
    activeReportsAtThem: stores.reduce((n, s) => n + s.active, 0),
    totalReports: one('SELECT COUNT(*) AS n FROM price_reports').n,
    votesOnThoseReports: one(`SELECT COUNT(*) AS n FROM report_votes WHERE report_id IN (SELECT id FROM price_reports WHERE store_id IN ${ids})`).n,
    creditsOnThoseReports: one(`SELECT COUNT(*) AS n FROM contribution_credits WHERE report_id IN (SELECT id FROM price_reports WHERE store_id IN ${ids})`).n,
    currentPricesAtThem: one(`SELECT COUNT(*) AS n FROM current_prices WHERE store_id IN ${ids}`).n,
    reportsWithNoStoreAtAll: one('SELECT COUNT(*) AS n FROM price_reports WHERE store_id IS NULL').n,
  };
  console.log(JSON.stringify(summary, null, 2));
} finally {
  db.close();
}
