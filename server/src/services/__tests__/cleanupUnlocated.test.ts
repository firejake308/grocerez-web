import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { runMigrations } from '../../db/migrate.js';
import type { AppDb } from '../../db/client.js';
import { contributionCredits, currentPrices, priceReports, products, reportVotes, stores, users } from '../../db/schema.js';
import { newId } from '../../lib/ids.js';
import { CleanupError, cleanupUnlocatedStores } from '../cleanupUnlocated.js';
import { resolveStore } from '../stores.js';

describe('cleanupUnlocatedStores', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;
  let userId: string;
  let productId: string;
  let located: string;
  let legacy: string;

  const report = (id: string, storeId: string, priceCents: number, status: 'active' | 'hidden' = 'active') => {
    db.insert(priceReports).values({
      id, userId, productId, storeId, itemName: 'Milk', priceCents, priceRaw: String(priceCents / 100), observedDate: '2026-10-20',
      freshnessDate: '2026-10-20', status, createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z',
    }).run();
  };

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
    userId = newId();
    db.insert(users).values({ id: userId, email: 'u@example.com' }).run();
    productId = newId();
    db.insert(products).values({ id: productId, canonicalName: 'Milk', reportCount: 3, medianPriceCents: 300 }).run();
    located = newId();
    db.insert(stores).values({ id: located, name: 'Kroger', lat: 32.9, lon: -97.2, chainKey: 'kroger', storeKey: 'kroger:near' }).run();
    // A store from before locations were required: the triggers would refuse it today.
    sqlite.exec('drop trigger stores_require_location_insert');
    legacy = newId();
    db.insert(stores).values({ id: legacy, name: 'Walmart', chainKey: 'walmart', storeKey: 'walmart:chain', isChainLevel: true }).run();
    report('keep', located, 500);
    report('gone1', legacy, 100);
    report('gone2', legacy, 200, 'hidden');
    db.insert(currentPrices).values({ productId, storeId: legacy, reportId: 'gone1', priceCents: 100, observedDate: '2026-10-20' }).run();
    db.insert(reportVotes).values({ id: newId(), reportId: 'gone1', userId, kind: 'confirm', weight: 1, createdAt: '2026-10-21T00:00:00.000Z' } as never).run();
    db.insert(contributionCredits).values({ id: newId(), userId, reportId: 'gone1', earnedAt: '2026-10-21T00:00:00.000Z' }).run();
  });
  afterEach(() => sqlite.close());

  it('counts what it would delete and touches nothing without apply', () => {
    const summary = cleanupUnlocatedStores(db, { apply: false });
    expect(summary.stores).toEqual([expect.objectContaining({ name: 'Walmart', reports: 2, activeReports: 1 })]);
    expect(summary).toMatchObject({ reports: 2, activeReports: 1 });
    expect(db.select().from(stores).all()).toHaveLength(2);
    expect(db.select().from(priceReports).all()).toHaveLength(3);
  });

  it('deletes the stores without coordinates and everything that hangs off them, keeping located data', () => {
    const summary = cleanupUnlocatedStores(db, { apply: true });
    expect(summary.deleted).toEqual({ reports: 2, votes: 1, credits: 1, currentPrices: 1, stores: 1 });
    expect(db.select().from(stores).all().map((s) => s.id)).toEqual([located]);
    expect(db.select().from(priceReports).all().map((r) => r.id)).toEqual(['keep']);
    expect(db.select().from(reportVotes).all()).toHaveLength(0);
    expect(db.select().from(contributionCredits).all()).toHaveLength(0);
    // The product's stats reflect only the report that is left.
    const product = db.select().from(products).where(eq(products.id, productId)).all()[0];
    expect(product).toMatchObject({ reportCount: 1, medianPriceCents: 500 });
  });

  it('does nothing when every store has a location', () => {
    cleanupUnlocatedStores(db, { apply: true });
    expect(cleanupUnlocatedStores(db, { apply: true }).stores).toEqual([]);
  });

  describe('moves', () => {
    const webb = () => resolveStore(db, { rawStore: 'Walmart @ 9410 Webb Chapel Road', lat: 32.862, lon: -96.857 });

    it('re-files a bare chain name at the located store you name (abbreviations are fine) and still deletes the rest', () => {
      const target = webb();
      const other = newId();
      db.insert(stores).values({ id: other, name: 'La Cima', chainKey: 'la cima', storeKey: 'la cima' }).run();
      report('doomed', other, 777);

      const summary = cleanupUnlocatedStores(db, { apply: true, moves: [{ from: 'Walmart', to: 'Walmart @ 9410 Webb Chapel Rd' }] });

      expect(summary.moves).toEqual([expect.objectContaining({ from: 'Walmart', reports: 2, to: expect.objectContaining({ id: target.id, lat: 32.862, lon: -96.857 }) })]);
      expect(summary.moved).toEqual({ reports: 2, stores: 1 });
      expect(summary.deleted).toMatchObject({ reports: 1, stores: 1 }); // only La Cima's
      const byId = Object.fromEntries(db.select().from(priceReports).all().map((r) => [r.id, r.storeId]));
      expect(byId).toEqual({ keep: located, gone1: target.id, gone2: target.id });
      expect(db.select().from(stores).where(eq(stores.id, legacy)).all()).toHaveLength(0);
      // The moved reports keep their votes and credits, and the target's current price is the moved one.
      expect(db.select().from(reportVotes).all()).toHaveLength(1);
      expect(db.select().from(contributionCredits).all()).toHaveLength(1);
      expect(db.select().from(currentPrices).where(eq(currentPrices.storeId, target.id)).all()).toEqual([expect.objectContaining({ reportId: 'gone1', priceCents: 100 })]);
      expect(db.select().from(products).where(eq(products.id, productId)).all()[0].reportCount).toBe(2); // keep + gone1 (gone2 is hidden)
    });

    it('can also move an address-only store, but never a named store at the same address', () => {
      const target = webb();
      const addrOnly = newId();
      db.insert(stores).values({ id: addrOnly, name: '9410 Webb Chapel Road', address: '9410 Webb Chapel Road', chainKey: '', storeKey: 'addr:legacy' }).run();
      report('addr1', addrOnly, 321);
      const named = newId(); // a named store at that same address, also unlocated: not an address-only store
      db.insert(stores).values({ id: named, name: 'Costco', address: '9410 Webb Chapel Road', chainKey: 'costco', storeKey: 'costco:legacy' }).run();
      report('costco1', named, 555);

      const summary = cleanupUnlocatedStores(db, { apply: true, moves: [{ from: '9410 Webb Chapel Rd', to: 'Walmart @ 9410 Webb Chapel Road' }] });
      expect(summary.moves).toEqual([expect.objectContaining({ from: '9410 Webb Chapel Rd', reports: 1, to: expect.objectContaining({ id: target.id }) })]);
      const byId = Object.fromEntries(db.select().from(priceReports).all().map((r) => [r.id, r.storeId]));
      expect(byId.addr1).toBe(target.id);
      expect(byId.costco1).toBeUndefined(); // deleted with the rest, not swept up by the address move
    });

    it('moves a "Chain @ Address" store to a located store known only by its chain name, when that is unambiguous', () => {
      const old = newId();
      db.insert(stores).values({ id: old, name: 'WinCo Foods', address: 'Presidio Vista Drive', chainKey: 'winco foods', storeKey: 'winco:legacy' }).run();
      report('w1', old, 199);
      // Newer scans have coordinates but OpenStreetMap had no address for the store.
      const winco = resolveStore(db, { rawStore: 'WinCo Foods', lat: 29.5, lon: -98.6 });

      const summary = cleanupUnlocatedStores(db, { apply: true, moves: [{ from: 'WinCo Foods @ Presidio Vista Drive', to: 'WinCo Foods' }] });
      expect(summary.moves).toEqual([expect.objectContaining({ reports: 1, to: expect.objectContaining({ id: winco.id, address: null }) })]);
      expect(db.select().from(priceReports).where(eq(priceReports.id, 'w1')).all()[0].storeId).toBe(winco.id);
      // Other unlocated stores with the same chain but a different address are not swept up by that source.
      expect(summary.stores.map((s) => s.name)).toEqual(['Walmart']);
    });

    it('refuses a bare chain name as the target when that chain has several located stores', () => {
      resolveStore(db, { rawStore: 'Kroger @ 1 Main Street', lat: 32.8, lon: -96.8 });
      resolveStore(db, { rawStore: 'Kroger @ 2 Oak Street', lat: 32.9, lon: -96.9 });
      expect(() => cleanupUnlocatedStores(db, { apply: true, moves: [{ from: 'Walmart', to: 'Kroger' }] })).toThrow(/More than one/);
    });

    it('maps HEB onto "H-E-B @ ..." and shows the plan, touching nothing, without apply', () => {
      const heb = newId();
      db.insert(stores).values({ id: heb, name: 'HEB', chainKey: 'heb', storeKey: 'heb:chain' }).run();
      report('heb1', heb, 250);
      const target = resolveStore(db, { rawStore: 'H-E-B @ 3451 Heritage Trace Parkway', lat: 32.9159533, lon: -97.3080462 });

      const summary = cleanupUnlocatedStores(db, { apply: false, moves: [{ from: 'HEB', to: 'H-E-B @ 3451 Heritage Trace Pkwy' }] });
      expect(summary.moves).toEqual([expect.objectContaining({ reports: 1, to: expect.objectContaining({ id: target.id }) })]);
      expect(summary.stores.map((s) => s.name)).toEqual(['Walmart']); // the HEB store is not in the delete list
      expect(db.select().from(priceReports).where(eq(priceReports.id, 'heb1')).all()[0].storeId).toBe(heb);
      expect(db.select().from(stores).where(eq(stores.id, heb)).all()).toHaveLength(1);
    });

    it('refuses, and changes nothing, when the target does not exist or is ambiguous', () => {
      expect(() => cleanupUnlocatedStores(db, { apply: true, moves: [{ from: 'Walmart', to: 'Walmart @ 1 Nowhere Road' }] })).toThrow(CleanupError);
      webb();
      db.insert(stores).values({ id: newId(), name: 'Walmart', address: '9410 Webb Chapel Rd', lat: 32.8, lon: -96.8, chainKey: 'walmart', storeKey: 'walmart:dup' }).run();
      expect(() => cleanupUnlocatedStores(db, { apply: true, moves: [{ from: 'Walmart', to: 'Walmart @ 9410 Webb Chapel Road' }] })).toThrow(/More than one/);
      expect(db.select().from(priceReports).all()).toHaveLength(3);
      expect(db.select().from(stores).where(eq(stores.id, legacy)).all()).toHaveLength(1);
    });

    it('refuses a move whose source matches nothing while other stores are still queued for deletion (a typo must not delete what it meant to save)', () => {
      webb();
      expect(() => cleanupUnlocatedStores(db, { apply: true, moves: [{ from: 'Wallmart', to: 'Walmart @ 9410 Webb Chapel Road' }] })).toThrow(/No unlocated store is called "Wallmart"/);
      expect(db.select().from(priceReports).all()).toHaveLength(3);
    });

    it('is a quiet no-op the second time, once everything has been moved or deleted', () => {
      webb();
      const moves = [{ from: 'Walmart', to: 'Walmart @ 9410 Webb Chapel Road' }];
      cleanupUnlocatedStores(db, { apply: true, moves });
      const again = cleanupUnlocatedStores(db, { apply: true, moves });
      expect(again.moves).toEqual([]);
      expect(again.stores).toEqual([]);
    });
  });
});
