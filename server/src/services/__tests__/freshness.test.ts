import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { runMigrations } from '../../db/migrate.js';
import type { AppDb } from '../../db/client.js';
import { currentPrices, priceReports, products, stores, users } from '../../db/schema.js';
import { newId } from '../../lib/ids.js';
import { isStaleReport, refreshCurrentPrice, STALE_AFTER_DAYS, todayOf } from '../freshness.js';

describe('isStaleReport', () => {
  const today = '2026-06-01';

  it('is stale once its expiry date has passed', () => {
    expect(isStaleReport({ expiresAt: '2026-05-31', freshnessDate: today, observedDate: today }, today)).toBe(true);
    expect(isStaleReport({ expiresAt: '2026-06-02', freshnessDate: today, observedDate: today }, today)).toBe(false);
  });

  it(`is stale once older than ${STALE_AFTER_DAYS} days with no confirmation`, () => {
    expect(isStaleReport({ expiresAt: null, freshnessDate: '2026-04-01', observedDate: '2026-04-01' }, today)).toBe(true);
    expect(isStaleReport({ expiresAt: null, freshnessDate: '2026-05-01', observedDate: '2026-04-01' }, today)).toBe(false);
  });

  it('uses freshnessDate (bumped by confirmation) over observedDate when set', () => {
    // Observed long ago, but confirmed recently -> not stale.
    expect(isStaleReport({ expiresAt: null, freshnessDate: '2026-05-30', observedDate: '2026-01-01' }, today)).toBe(false);
  });
});

function seed(db: AppDb) {
  const productId = newId();
  const storeId = newId();
  db.insert(products).values({ id: productId, canonicalName: 'Milk' }).run();
  db.insert(stores).values({ id: storeId, name: 'Kroger', chainKey: 'kroger', storeKey: newId() }).run();
  const userOf = (tier: 'new' | 'established' | 'trusted') => {
    const id = newId();
    const [reportsCount, confirmedCount] = tier === 'new' ? [0, 0] : tier === 'established' ? [5, 4] : [5, 40];
    db.insert(users).values({ id, email: `${id}@example.com`, reportsCount, confirmedCount }).run();
    return id;
  };
  const reportOf = (userId: string, priceCents: number, observedDate: string, overrides: Partial<typeof priceReports.$inferInsert> = {}) => {
    const id = newId();
    db.insert(priceReports).values({
      id,
      userId,
      productId,
      storeId,
      itemName: 'Milk',
      priceCents,
      priceRaw: String(priceCents / 100),
      observedDate,
      freshnessDate: observedDate,
      status: 'active',
      updatedAt: `${observedDate}T00:00:00.000Z`,
      ...overrides,
    }).run();
    return id;
  };
  return { productId, storeId, userOf, reportOf };
}

describe('refreshCurrentPrice', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
  });

  afterEach(() => {
    sqlite.close();
  });

  it('deletes the row when there are no active reports', () => {
    const { productId, storeId } = seed(db);
    refreshCurrentPrice(db, productId, storeId);
    expect(db.select().from(currentPrices).where(and(eq(currentPrices.productId, productId), eq(currentPrices.storeId, storeId))).all()).toEqual([]);
  });

  it('picks the newest observed_date; ties go to the higher seq (latest push)', () => {
    const { productId, storeId, userOf, reportOf } = seed(db);
    const trusted = userOf('trusted');
    reportOf(trusted, 300, '2026-06-01');
    reportOf(trusted, 350, '2026-06-01');
    refreshCurrentPrice(db, productId, storeId);
    const row = db.select().from(currentPrices).where(and(eq(currentPrices.productId, productId), eq(currentPrices.storeId, storeId))).all()[0];
    expect(row?.priceCents).toBe(350);
  });

  it('overrides a newer unverified report with a recent, disagreeing trusted one', () => {
    const { productId, storeId, userOf, reportOf } = seed(db);
    const trusted = userOf('trusted');
    const fresh = userOf('new');
    reportOf(trusted, 300, '2026-06-01');
    const newReportId = reportOf(fresh, 100, '2026-06-10'); // disagrees by 67%, within 30 days
    refreshCurrentPrice(db, productId, storeId, () => new Date('2026-06-10T00:00:00.000Z'));
    const row = db.select().from(currentPrices).where(and(eq(currentPrices.productId, productId), eq(currentPrices.storeId, storeId))).all()[0];
    expect(row?.priceCents).toBe(300);
    expect(row?.contestedReportId).toBe(newReportId);
  });

  it('does not override when the disagreement is under 15%', () => {
    const { productId, storeId, userOf, reportOf } = seed(db);
    const trusted = userOf('trusted');
    const fresh = userOf('new');
    reportOf(trusted, 300, '2026-06-01');
    reportOf(fresh, 305, '2026-06-10'); // ~1.6% different
    refreshCurrentPrice(db, productId, storeId, () => new Date('2026-06-10T00:00:00.000Z'));
    const row = db.select().from(currentPrices).where(and(eq(currentPrices.productId, productId), eq(currentPrices.storeId, storeId))).all()[0];
    expect(row?.priceCents).toBe(305);
    expect(row?.contestedReportId).toBeNull();
  });

  it('does not override when the trusted report is more than 30 days older', () => {
    const { productId, storeId, userOf, reportOf } = seed(db);
    const trusted = userOf('trusted');
    const fresh = userOf('new');
    reportOf(trusted, 300, '2026-01-01');
    reportOf(fresh, 100, '2026-06-10');
    refreshCurrentPrice(db, productId, storeId, () => new Date('2026-06-10T00:00:00.000Z'));
    const row = db.select().from(currentPrices).where(and(eq(currentPrices.productId, productId), eq(currentPrices.storeId, storeId))).all()[0];
    expect(row?.priceCents).toBe(100);
  });

  it('never overrides when the newest report is itself from a trusted author', () => {
    const { productId, storeId, userOf, reportOf } = seed(db);
    const trusted = userOf('trusted');
    reportOf(trusted, 300, '2026-06-01');
    reportOf(trusted, 100, '2026-06-10'); // a real, large price drop
    refreshCurrentPrice(db, productId, storeId, () => new Date('2026-06-10T00:00:00.000Z'));
    const row = db.select().from(currentPrices).where(and(eq(currentPrices.productId, productId), eq(currentPrices.storeId, storeId))).all()[0];
    expect(row?.priceCents).toBe(100);
  });

  it('ignores non-active reports entirely', () => {
    const { productId, storeId, userOf, reportOf } = seed(db);
    const trusted = userOf('trusted');
    reportOf(trusted, 300, '2026-06-01');
    reportOf(trusted, 999, '2026-06-10', { status: 'hidden' });
    refreshCurrentPrice(db, productId, storeId, () => new Date('2026-06-10T00:00:00.000Z'));
    const row = db.select().from(currentPrices).where(and(eq(currentPrices.productId, productId), eq(currentPrices.storeId, storeId))).all()[0];
    expect(row?.priceCents).toBe(300);
  });

  it('marks the current row stale using the same rule as isStaleReport', () => {
    const { productId, storeId, userOf, reportOf } = seed(db);
    const trusted = userOf('trusted');
    reportOf(trusted, 300, '2026-01-01');
    refreshCurrentPrice(db, productId, storeId, () => new Date('2026-06-01T00:00:00.000Z'));
    const row = db.select().from(currentPrices).where(and(eq(currentPrices.productId, productId), eq(currentPrices.storeId, storeId))).all()[0];
    expect(row?.isStale).toBe(true);
  });

  it('deletes an existing row once its last report is removed (status flips away from active)', () => {
    const { productId, storeId, userOf, reportOf } = seed(db);
    const trusted = userOf('trusted');
    const id = reportOf(trusted, 300, '2026-06-01');
    refreshCurrentPrice(db, productId, storeId);
    expect(db.select().from(currentPrices).where(and(eq(currentPrices.productId, productId), eq(currentPrices.storeId, storeId))).all()).toHaveLength(1);
    db.update(priceReports).set({ status: 'deleted' }).where(eq(priceReports.id, id)).run();
    refreshCurrentPrice(db, productId, storeId);
    expect(db.select().from(currentPrices).where(and(eq(currentPrices.productId, productId), eq(currentPrices.storeId, storeId))).all()).toEqual([]);
  });
});

describe('todayOf', () => {
  it('formats as YYYY-MM-DD', () => {
    expect(todayOf(new Date('2026-06-01T23:59:00.000Z'))).toBe('2026-06-01');
  });
});
