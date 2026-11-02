/**
 * Dev-only: seeds two price reports so the store backfill can be tried end to end.
 *   - eggs at a made-up named store (should be left alone)
 *   - a snack bar at a bare address with the coordinates of the Costco at
 *     8900 Tehama Ridge Parkway (should be moved to Costco by the backfill)
 * Safe to re-run: reports use fixed ids, so existing ones are skipped.
 *
 *   npm run seed-store-test
 */
import { eq } from 'drizzle-orm';
import { runMigrations } from './db/migrate.js';
import { env } from './env.js';
import { priceReports, users } from './db/schema.js';
import { refreshCurrentPrice, todayOf } from './services/freshness.js';
import { refreshProductFromReports, resolveProduct } from './services/products.js';
import { resolveStore } from './services/stores.js';

const USER_ID = 'seed-store-test-user';
const today = todayOf(new Date());

const SEEDS = [
  {
    id: 'seed-store-test-eggs',
    itemName: 'Large Eggs',
    brand: 'Cherry Farms',
    priceCents: 199,
    store: 'Cherry Lane Market @ 1234 Cherry Lane',
    lat: 32.95,
    lon: -97.25,
  },
  {
    id: 'seed-store-test-tehama',
    itemName: 'Chocolate Chip Granola Bars',
    brand: 'Nature Valley',
    priceCents: 549,
    store: '8900 Tehama Ridge Parkway',
    lat: 32.900796,
    lon: -97.320443,
  },
];

const { db, sqlite } = runMigrations(env.DATABASE_PATH);
try {
  if (!db.select().from(users).where(eq(users.id, USER_ID)).all()[0]) {
    db.insert(users).values({ id: USER_ID, email: 'store-test@example.invalid' }).run();
  }
  for (const seed of SEEDS) {
    if (db.select().from(priceReports).where(eq(priceReports.id, seed.id)).all()[0]) {
      console.log(`${seed.id}: already seeded`);
      continue;
    }
    const store = resolveStore(db, { rawStore: seed.store, lat: seed.lat, lon: seed.lon });
    const { productId } = resolveProduct(db, { itemName: seed.itemName, brand: seed.brand, tags: [], quantity: null, quantityUnits: null }, seed.priceCents);
    db.insert(priceReports)
      .values({
        id: seed.id,
        userId: USER_ID,
        productId,
        storeId: store.id,
        itemName: seed.itemName,
        brand: seed.brand,
        priceCents: seed.priceCents,
        priceRaw: (seed.priceCents / 100).toFixed(2),
        observedDate: today,
        freshnessDate: today,
        updatedAt: new Date().toISOString(),
      })
      .run();
    refreshProductFromReports(db, productId);
    refreshCurrentPrice(db, productId, store.id);
    console.log(`${seed.id}: ${seed.itemName} at "${store.name}"${store.chainKey === '' ? ' (address-only)' : ''}`);
  }
} finally {
  sqlite.close();
}
