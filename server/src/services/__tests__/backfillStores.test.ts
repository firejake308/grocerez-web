import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { runMigrations } from '../../db/migrate.js';
import type { AppDb } from '../../db/client.js';
import { currentPrices, priceReports, products, stores, users } from '../../db/schema.js';
import { newId } from '../../lib/ids.js';
import { refreshCurrentPrice } from '../freshness.js';
import { _resetGeoCachesForTests } from '../geo.js';
import { backfillStoreNames } from '../backfillStores.js';
import { resolveStore } from '../stores.js';

const SPOT = { lat: 32.900796, lon: -97.320443 };

describe('backfillStoreNames', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;
  let userId: string;
  let overpassCalls: number;

  const deps = () => ({
    overpassUrl: 'http://overpass.test/api/interpreter',
    nominatimUrl: 'http://nominatim.test',
    fetchImpl: (async () => {
      overpassCalls++;
      return new Response(
        JSON.stringify({
          elements: [
            { type: 'node', lat: SPOT.lat, lon: SPOT.lon, tags: { shop: 'tyres', name: 'Costco Tire Center', 'addr:housenumber': '8900', 'addr:street': 'Tehama Ridge Parkway' } },
            { type: 'way', center: { lat: SPOT.lat + 0.0003, lon: SPOT.lon }, tags: { shop: 'wholesale', name: 'Costco', 'addr:housenumber': '8900', 'addr:street': 'Tehama Ridge Parkway' } },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch,
  });

  const seedReport = (storeId: string, productId: string) => {
    db.insert(priceReports)
      .values({ id: newId(), userId, storeId, productId, itemName: 'Milk', priceCents: 300, priceRaw: '3.00', observedDate: '2026-06-01', freshnessDate: '2026-06-01', status: 'active', updatedAt: '2026-06-01T00:00:00.000Z' })
      .run();
    refreshCurrentPrice(db, productId, storeId);
  };

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
    _resetGeoCachesForTests();
    overpassCalls = 0;
    userId = newId();
    db.insert(users).values({ id: userId, email: `${userId}@example.com` }).run();
  });

  afterEach(() => sqlite.close());

  const seedProduct = () => {
    const id = newId();
    db.insert(products).values({ id, canonicalName: 'Milk' }).run();
    return id;
  };

  it('moves reports from an address-only store to the grocery store found there, and tidies up', async () => {
    const productId = seedProduct();
    const plain = resolveStore(db, { rawStore: '8900 Tehama Ridge Parkway', lat: SPOT.lat, lon: SPOT.lon });
    seedReport(plain.id, productId);

    const lines: string[] = [];
    const summary = await backfillStoreNames(db, deps(), { apply: true, log: (l) => lines.push(l) });

    expect(lines).toEqual(['8900 Tehama Ridge Parkway -> Costco']);
    expect(summary).toMatchObject({ addressOnlyStores: 1, resolved: 1, reportsMoved: 1 });
    const report = db.select().from(priceReports).all()[0];
    const costco = db.select().from(stores).where(eq(stores.id, report.storeId as string)).all()[0];
    expect(costco.name).toBe('Costco');
    expect(db.select().from(stores).where(eq(stores.id, plain.id)).all()).toHaveLength(0);
    expect(db.select().from(currentPrices).all().map((c) => c.storeId)).toEqual([costco.id]);
  });

  it('looks an address up once, even when several rows share it (including the doubled label)', async () => {
    const productId = seedProduct();
    const plain = resolveStore(db, { rawStore: '8900 Tehama Ridge Parkway', lat: SPOT.lat, lon: SPOT.lon });
    // a row from before the doubled label was recognised, one geohash cell over
    const doubled = newId();
    db.insert(stores)
      .values({ id: doubled, name: '8900 Tehama Ridge Parkway', address: '8900 Tehama Ridge Parkway', lat: SPOT.lat + 0.01, lon: SPOT.lon, geohash7: 'zzzzzzz', chainKey: '8900 tehama ridge parkway', storeKey: 'legacy' })
      .run();
    seedReport(plain.id, productId);
    seedReport(doubled, productId);

    const summary = await backfillStoreNames(db, deps(), { apply: true });
    expect(summary).toMatchObject({ addressOnlyStores: 2, resolved: 2, reportsMoved: 2 });
    expect(overpassCalls).toBe(1);
    expect(new Set(db.select().from(priceReports).all().map((r) => r.storeId)).size).toBe(1);
  });

  it('leaves reports at stores that already have a name alone', async () => {
    const productId = seedProduct();
    const kroger = resolveStore(db, { rawStore: 'Kroger @ 9150 North Tarrant Parkway', lat: 32.9, lon: -97.18 });
    seedReport(kroger.id, productId);
    const summary = await backfillStoreNames(db, deps(), { apply: true });
    expect(summary.addressOnlyStores).toBe(0);
    expect(overpassCalls).toBe(0);
  });

  it('only reports what it would do without apply', async () => {
    const productId = seedProduct();
    const plain = resolveStore(db, { rawStore: '8900 Tehama Ridge Parkway', lat: SPOT.lat, lon: SPOT.lon });
    seedReport(plain.id, productId);

    const summary = await backfillStoreNames(db, deps(), { apply: false });
    expect(summary).toMatchObject({ resolved: 1, reportsMoved: 0 });
    expect(db.select().from(priceReports).all()[0].storeId).toBe(plain.id);
  });

  it('skips address-only stores that have no coordinates', async () => {
    const productId = seedProduct();
    const noCoords = resolveStore(db, { rawStore: '12 Nowhere Lane' });
    seedReport(noCoords.id, productId);
    const summary = await backfillStoreNames(db, deps(), { apply: true });
    expect(summary).toMatchObject({ noCoordinates: 1, reportsMoved: 0 });
    expect(overpassCalls).toBe(0);
  });
});
