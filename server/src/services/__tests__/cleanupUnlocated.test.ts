import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { runMigrations } from '../../db/migrate.js';
import type { AppDb } from '../../db/client.js';
import { contributionCredits, currentPrices, priceReports, products, reportVotes, stores, users } from '../../db/schema.js';
import { newId } from '../../lib/ids.js';
import { cleanupUnlocatedStores } from '../cleanupUnlocated.js';

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
});
