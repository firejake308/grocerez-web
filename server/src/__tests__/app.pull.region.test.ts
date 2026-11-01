import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { createApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import type { AppDb } from '../db/client.js';
import { priceReports, products, stores, users } from '../db/schema.js';
import { computeFreeTier, freeTierProductIds } from '../services/entitlements.js';

const json = (res: Response): Promise<Record<string, any>> => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

// Center and radius. NEAR is inside the circle. CORNER is inside the bounding box
// (0.1 deg lat ~ 6.9 mi, 0.17 deg lon ~ 9.8 mi) but ~12 mi away, so outside a 10 mi circle.
const CENTER = { lat: 32.9, lon: -97.2 };
const RADIUS = 10;

describe('region-scoped reads', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
    db.insert(users).values({ id: 'u1', email: 'u1@example.com' }).run();
    db.insert(users).values({ id: 'u2', email: 'u2@example.com' }).run();
    db.insert(stores).values({ id: 'near', name: 'Near', lat: CENTER.lat + 0.02, lon: CENTER.lon + 0.02, chainKey: 'near', storeKey: 'near' }).run();
    db.insert(stores).values({ id: 'corner', name: 'Corner', lat: CENTER.lat + 0.1, lon: CENTER.lon + 0.17, chainKey: 'corner', storeKey: 'corner' }).run();
    db.insert(stores).values({ id: 'far', name: 'Far', lat: 40.7, lon: -74.0, chainKey: 'far', storeKey: 'far' }).run();
    db.insert(stores).values({ id: 'nowhere', name: 'Chain', lat: null, lon: null, isChainLevel: true, chainKey: 'chain', storeKey: 'chain' }).run();
    for (const id of ['milk', 'eggs', 'bread']) db.insert(products).values({ id, canonicalName: id }).run();
  });

  afterEach(() => {
    sqlite.close();
  });

  const addReport = (id: string, storeId: string, productId = 'milk', userId = 'u1') =>
    db.insert(priceReports).values({
      id, userId, productId, storeId, itemName: productId, priceCents: 300, priceRaw: '3.00', observedDate: '2026-10-01', freshnessDate: '2026-10-01',
      status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }).run();

  describe('GET /api/sync/pull', () => {
    const pullAll = async (app: ReturnType<typeof createApp>, token: string, limit: number) => {
      const seen: { id: string; seq: number }[] = [];
      let since = 0;
      for (let i = 0; i < 20; i++) {
        const body = await json(await app.request(`/api/sync/pull?since=${since}&lat=${CENTER.lat}&lon=${CENTER.lon}&radiusMi=${RADIUS}&limit=${limit}`, { headers: { Authorization: `Bearer ${token}` } }));
        seen.push(...body.reports.map((r: { id: string; seq: number }) => ({ id: r.id, seq: r.seq })));
        if (body.nextSince <= since || body.reports.length < limit) break;
        since = body.nextSince;
      }
      return seen;
    };

    it('returns exactly the reports inside the circle, in order, across chunk boundaries with out-of-circle rows interleaved', async () => {
      const app = createApp({ db, corsOrigins: [] });
      const { deviceToken } = await json(await app.request('/api/devices/register', { method: 'POST' }));
      // 4000 reports, one in four at a store inside the circle and the rest at a bounding-box-corner store outside it (so a
      // 1000-row chunk holds only ~250 usable rows and a page of 500 must read several chunks), plus noise elsewhere.
      db.transaction((tx) => {
        for (let i = 0; i < 4000; i++) {
          const storeId = i % 4 === 0 ? 'near' : 'corner';
          tx.insert(priceReports).values({
            id: `r${i}`, userId: 'u1', productId: 'milk', storeId, itemName: 'milk', priceCents: 300, priceRaw: '3.00', observedDate: '2026-10-01', freshnessDate: '2026-10-01',
            status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          }).run();
          if (i % 50 === 0) tx.insert(priceReports).values({ id: `far${i}`, userId: 'u1', productId: 'milk', storeId: 'far', itemName: 'milk', priceCents: 300, priceRaw: '3.00', observedDate: '2026-10-01', freshnessDate: '2026-10-01', status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).run();
        }
      });

      for (const limit of [100, 500]) {
        const seen = await pullAll(app, deviceToken, limit);
        const ids = seen.map((s) => s.id);
        expect(ids, `limit ${limit}`).toHaveLength(1000); // every fourth i, nothing else
        expect(new Set(ids).size).toBe(1000);
        expect(ids.every((id) => id.startsWith('r') && Number(id.slice(1)) % 4 === 0), `limit ${limit}`).toBe(true);
        expect(seen.map((s) => s.seq), `limit ${limit}`).toEqual([...seen.map((s) => s.seq)].sort((a, b) => a - b));
      }
    });

    it('excludes chain-level stores with no coordinates and stores outside the box', async () => {
      const app = createApp({ db, corsOrigins: [] });
      const { deviceToken } = await json(await app.request('/api/devices/register', { method: 'POST' }));
      addReport('a', 'near');
      addReport('b', 'nowhere');
      addReport('c', 'far');
      addReport('d', 'corner');
      const seen = await pullAll(app, deviceToken, 500);
      expect(seen.map((s) => s.id)).toEqual(['a']);
    });

    it('a page that is full stops reading: nextSince is the last row returned, so the next pull continues right after it', async () => {
      const app = createApp({ db, corsOrigins: [] });
      const { deviceToken } = await json(await app.request('/api/devices/register', { method: 'POST' }));
      for (let i = 0; i < 5; i++) addReport(`n${i}`, 'near');
      const first = await json(await app.request(`/api/sync/pull?since=0&lat=${CENTER.lat}&lon=${CENTER.lon}&radiusMi=${RADIUS}&limit=2`, { headers: { Authorization: `Bearer ${deviceToken}` } }));
      expect(first.reports.map((r: { id: string }) => r.id)).toEqual(['n0', 'n1']);
      const second = await json(await app.request(`/api/sync/pull?since=${first.nextSince}&lat=${CENTER.lat}&lon=${CENTER.lon}&radiusMi=${RADIUS}&limit=2`, { headers: { Authorization: `Bearer ${deviceToken}` } }));
      expect(second.reports.map((r: { id: string }) => r.id)).toEqual(['n2', 'n3']);
    });
  });

  describe('free-set refresh', () => {
    it('counts only stores inside the circle: a bounding-box corner store does not make a product popular', () => {
      // 'eggs' is reported only at the corner store (outside the circle), by two users; 'milk' is reported at the near store.
      addReport('e1', 'corner', 'eggs', 'u1');
      addReport('e2', 'corner', 'eggs', 'u2');
      addReport('m1', 'near', 'milk', 'u1');
      computeFreeTier(db, CENTER.lat, CENTER.lon, RADIUS);
      const free = freeTierProductIds(db, CENTER.lat, CENTER.lon, RADIUS);
      expect(free.has('milk')).toBe(true);
      expect(free.has('eggs')).toBe(false);
    });

    it('ranks by distinct reporters x distinct stores from the database counts', () => {
      db.insert(stores).values({ id: 'near2', name: 'Near2', lat: CENTER.lat - 0.02, lon: CENTER.lon - 0.02, chainKey: 'near2', storeKey: 'near2' }).run();
      // milk: 2 reporters x 2 stores = 4; eggs: 1 x 1 = 1, however many times it is scanned.
      addReport('a', 'near', 'milk', 'u1');
      addReport('b', 'near2', 'milk', 'u2');
      for (let i = 0; i < 10; i++) addReport(`e${i}`, 'near', 'eggs', 'u1');
      computeFreeTier(db, CENTER.lat, CENTER.lon, RADIUS);
      const rows = sqlite.prepare('select product_id, rank from free_tier_products order by rank').all() as { product_id: string; rank: number }[];
      expect(rows.map((r) => r.product_id)).toEqual(['milk', 'eggs']);
    });

    it('ignores hidden and deleted reports, reports without a product, and reports older than 90 days', () => {
      addReport('ok', 'near', 'milk');
      for (const [id, status] of [['h', 'hidden'], ['d', 'deleted']] as const) {
        addReport(id, 'near', 'eggs');
        sqlite.prepare('update price_reports set status = ? where id = ?').run(status, id);
      }
      addReport('old', 'near', 'bread');
      sqlite.prepare("update price_reports set created_at = '2020-01-01T00:00:00.000Z' where id = 'old'").run();
      addReport('np', 'near', 'milk');
      sqlite.prepare("update price_reports set product_id = null where id = 'np'").run();
      computeFreeTier(db, CENTER.lat, CENTER.lon, RADIUS);
      expect([...freeTierProductIds(db, CENTER.lat, CENTER.lon, RADIUS)]).toEqual(['milk']);
    });

    it('is a no-op with no stores in the region', () => {
      computeFreeTier(db, 10, 10, RADIUS);
      expect(freeTierProductIds(db, 10, 10, RADIUS).size).toBe(0);
    });
  });
});
