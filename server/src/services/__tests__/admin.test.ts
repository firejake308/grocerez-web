import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { runMigrations } from '../../db/migrate.js';
import type { AppDb } from '../../db/client.js';
import { currentPrices, priceReports, products, productTokens, stores, users } from '../../db/schema.js';
import { newId } from '../../lib/ids.js';
import { AdminError, listFlags, mergeProducts, resolveFlag, setUserStatus } from '../admin.js';
import { castVote } from '../votes.js';
import { resolveProduct } from '../products.js';
import { refreshCurrentPrice } from '../freshness.js';

function seedUser(db: AppDb, overrides: Partial<typeof users.$inferInsert> = {}): string {
  const id = newId();
  db.insert(users).values({ id, email: `${id}@example.com`, ...overrides }).run();
  return id;
}

function seedStore(db: AppDb): string {
  const id = newId();
  db.insert(stores).values({ id, name: 'Kroger', chainKey: 'kroger', storeKey: newId() }).run();
  return id;
}

function seedReport(db: AppDb, userId: string, storeId: string, overrides: Partial<typeof priceReports.$inferInsert> = {}): string {
  const productId = overrides.productId ?? (() => {
    const id = newId();
    db.insert(products).values({ id, canonicalName: 'Milk' }).run();
    return id;
  })();
  const id = newId();
  db.insert(priceReports).values({
    id,
    userId,
    storeId,
    itemName: 'Milk',
    priceCents: 300,
    priceRaw: '3.00',
    observedDate: '2026-06-01',
    freshnessDate: '2026-06-01',
    status: 'active',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
    productId,
  }).run();
  refreshCurrentPrice(db, productId, storeId);
  return id;
}

describe('listFlags / resolveFlag', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
  });

  afterEach(() => {
    sqlite.close();
  });

  it('lists only open flags by default, with report and flagger context', () => {
    const author = seedUser(db);
    const flagger = seedUser(db, { trustScore: 0.8 });
    const store = seedStore(db);
    const reportId = seedReport(db, author, store);
    castVote(db, { userId: flagger, reportId, kind: 'flag', reason: 'wrong_price', note: 'saw it cheaper' });

    const open = listFlags(db, 'open');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ reason: 'wrong_price', note: 'saw it cheaper', resolution: null });
    expect(open[0].report.author.id).toBe(author);
    expect(open[0].flagger.id).toBe(flagger);

    expect(listFlags(db, 'resolved')).toHaveLength(0);
  });

  it('upholding a flag hides the report and increments the author\'s upheld count', () => {
    const author = seedUser(db);
    const flaggerA = seedUser(db, { trustScore: 0.9 });
    const flaggerB = seedUser(db, { trustScore: 0.9 });
    const store = seedStore(db);
    const reportId = seedReport(db, author, store);
    castVote(db, { userId: flaggerA, reportId, kind: 'flag', reason: 'spam' });
    castVote(db, { userId: flaggerB, reportId, kind: 'flag', reason: 'spam' });
    const flagId = listFlags(db, 'open')[0].flagId;

    resolveFlag(db, flagId, 'upheld');

    const report = db.select().from(priceReports).where(eq(priceReports.id, reportId)).all()[0];
    expect(report?.status).toBe('hidden');
    const authorRow = db.select().from(users).where(eq(users.id, author)).all()[0];
    expect(authorRow?.upheldFlagsCount).toBe(1);
    expect(listFlags(db, 'open')).toHaveLength(0);
    expect(listFlags(db, 'resolved')).toHaveLength(2); // both flags on the report resolve together
  });

  it('dismissing a flag restores the report and counts against each flagger', () => {
    const author = seedUser(db);
    const flaggerA = seedUser(db, { trustScore: 0.9 });
    const flaggerB = seedUser(db, { trustScore: 0.9 });
    const store = seedStore(db);
    const reportId = seedReport(db, author, store);
    castVote(db, { userId: flaggerA, reportId, kind: 'flag', reason: 'spam' });
    castVote(db, { userId: flaggerB, reportId, kind: 'flag', reason: 'spam' });
    expect(db.select().from(priceReports).where(eq(priceReports.id, reportId)).all()[0]?.status).toBe('hidden');
    const flagId = listFlags(db, 'open')[0].flagId;

    resolveFlag(db, flagId, 'dismissed');

    const report = db.select().from(priceReports).where(eq(priceReports.id, reportId)).all()[0];
    expect(report?.status).toBe('active');
    expect(db.select().from(users).where(eq(users.id, flaggerA)).all()[0]?.dismissedFlagsCount).toBe(1);
    expect(db.select().from(users).where(eq(users.id, flaggerB)).all()[0]?.dismissedFlagsCount).toBe(1);
  });

  it('does not restore a report dismissed for a reason other than the flag threshold (e.g. it was manually hidden)', () => {
    const author = seedUser(db);
    const flagger = seedUser(db, { trustScore: 0.9 });
    const store = seedStore(db);
    const reportId = seedReport(db, author, store, { status: 'hidden', reviewReason: 'new_user' });
    castVote(db, { userId: flagger, reportId, kind: 'flag', reason: 'spam' });
    const flagId = listFlags(db, 'open')[0].flagId;
    resolveFlag(db, flagId, 'dismissed');
    expect(db.select().from(priceReports).where(eq(priceReports.id, reportId)).all()[0]?.status).toBe('hidden');
  });

  it('rejects resolving an already-resolved flag', () => {
    const author = seedUser(db);
    const flagger = seedUser(db, { trustScore: 0.9 });
    const store = seedStore(db);
    const reportId = seedReport(db, author, store);
    castVote(db, { userId: flagger, reportId, kind: 'flag', reason: 'spam' });
    const flagId = listFlags(db, 'open')[0].flagId;
    resolveFlag(db, flagId, 'dismissed');
    expect(() => resolveFlag(db, flagId, 'dismissed')).toThrow(AdminError);
  });

  it('404s on an unknown flag', () => {
    expect(() => resolveFlag(db, 'nope', 'dismissed')).toThrow(AdminError);
  });
});

describe('mergeProducts', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
  });

  afterEach(() => {
    sqlite.close();
  });

  it('moves reports, re-points current prices, and marks the source merged', () => {
    const userA = seedUser(db);
    const store = seedStore(db);
    const source = resolveProduct(db, { itemName: 'Ferrero Collection Fine Assorted Confections', brand: 'Ferrero', tags: [], quantity: 4.6, quantityUnits: 'ounce' }, 899).productId;
    const target = resolveProduct(db, { itemName: 'Ferrero Collection With Raffaello', brand: 'Ferrero', tags: [], quantity: 4.6, quantityUnits: 'ounce' }, 742).productId;
    expect(source).not.toBe(target); // these land as separate products, per the matcher tests
    const reportId = seedReport(db, userA, store, { productId: source, priceCents: 899 });

    const result = mergeProducts(db, source, target);
    expect(result.targetId).toBe(target);
    expect(result.movedReports).toBe(1);

    const report = db.select().from(priceReports).where(eq(priceReports.id, reportId)).all()[0];
    expect(report?.productId).toBe(target);

    const sourceProduct = db.select().from(products).where(eq(products.id, source)).all()[0];
    expect(sourceProduct?.mergedInto).toBe(target);
    expect(sourceProduct?.reportCount).toBe(0);

    const targetProduct = db.select().from(products).where(eq(products.id, target)).all()[0];
    expect(targetProduct?.reportCount).toBe(1);

    expect(db.select().from(currentPrices).where(eq(currentPrices.productId, source)).all()).toEqual([]);
    const targetPrice = db.select().from(currentPrices).where(eq(currentPrices.productId, target)).all()[0];
    expect(targetPrice?.priceCents).toBe(899);
  });

  it('copies the source\'s tokens onto the target', () => {
    const store = seedStore(db);
    const source = resolveProduct(db, { itemName: 'Something Unique Here', brand: '', tags: [], quantity: null, quantityUnits: null }, 100).productId;
    const target = resolveProduct(db, { itemName: 'Totally Different Words', brand: '', tags: [], quantity: null, quantityUnits: null }, 100).productId;
    void store;
    mergeProducts(db, source, target);
    const tokens = db.select({ token: productTokens.token }).from(productTokens).where(eq(productTokens.productId, target)).all().map((t) => t.token);
    expect(tokens).toEqual(expect.arrayContaining(['unique', 'totally', 'different']));
  });

  it('rejects merging a product into itself', () => {
    const p = resolveProduct(db, { itemName: 'Milk', brand: '', tags: [], quantity: null, quantityUnits: null }, 300).productId;
    expect(() => mergeProducts(db, p, p)).toThrow(AdminError);
  });

  it('rejects an unknown source or target', () => {
    const p = resolveProduct(db, { itemName: 'Milk', brand: '', tags: [], quantity: null, quantityUnits: null }, 300).productId;
    expect(() => mergeProducts(db, 'nope', p)).toThrow(AdminError);
    expect(() => mergeProducts(db, p, 'nope')).toThrow(AdminError);
  });

  it('rejects re-merging an already-merged product', () => {
    const a = resolveProduct(db, { itemName: 'Milk', brand: '', tags: [], quantity: null, quantityUnits: null }, 300).productId;
    const b = resolveProduct(db, { itemName: 'Almond Milk', brand: '', tags: [], quantity: null, quantityUnits: null }, 400).productId;
    const c = resolveProduct(db, { itemName: 'Oat Milk', brand: '', tags: [], quantity: null, quantityUnits: null }, 500).productId;
    mergeProducts(db, a, b);
    expect(() => mergeProducts(db, a, c)).toThrow(AdminError);
  });

  it('follows a chain: merging into an already-merged product lands on its final target', () => {
    const a = resolveProduct(db, { itemName: 'Milk', brand: '', tags: [], quantity: null, quantityUnits: null }, 300).productId;
    const b = resolveProduct(db, { itemName: 'Almond Milk', brand: '', tags: [], quantity: null, quantityUnits: null }, 400).productId;
    const c = resolveProduct(db, { itemName: 'Oat Milk', brand: '', tags: [], quantity: null, quantityUnits: null }, 500).productId;
    mergeProducts(db, b, c); // b -> c
    const result = mergeProducts(db, a, b); // a -> b, but b already points to c
    expect(result.targetId).toBe(c);
  });
});

describe('setUserStatus', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
  });

  afterEach(() => {
    sqlite.close();
  });

  it('banning a user hides their active reports', () => {
    const user = seedUser(db);
    const store = seedStore(db);
    const reportId = seedReport(db, user, store);
    const result = setUserStatus(db, user, 'banned');
    expect(result.affectedReports).toBe(1);
    const report = db.select().from(priceReports).where(eq(priceReports.id, reportId)).all()[0];
    expect(report?.status).toBe('hidden');
    expect(report?.reviewReason).toBe('banned');
    expect(db.select().from(users).where(eq(users.id, user)).all()[0]?.status).toBe('banned');
  });

  it('reactivating a banned user restores exactly the reports the ban hid, not ones already hidden for another reason', () => {
    const user = seedUser(db);
    const store = seedStore(db);
    const alreadyHidden = seedReport(db, user, store, { status: 'hidden', reviewReason: 'flagged' });
    const wasActive = seedReport(db, user, store);
    setUserStatus(db, user, 'banned');
    expect(db.select().from(priceReports).where(eq(priceReports.id, wasActive)).all()[0]?.reviewReason).toBe('banned');

    setUserStatus(db, user, 'active');
    expect(db.select().from(priceReports).where(eq(priceReports.id, wasActive)).all()[0]?.status).toBe('active');
    expect(db.select().from(priceReports).where(eq(priceReports.id, alreadyHidden)).all()[0]?.status).toBe('hidden');
  });

  it('404s on an unknown user', () => {
    expect(() => setUserStatus(db, 'nope', 'restricted')).toThrow(AdminError);
  });
});
