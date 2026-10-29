import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { runMigrations } from '../../db/migrate.js';
import type { AppDb } from '../../db/client.js';
import { contributionCredits, creditRedemptions, currentPrices, freeTierProducts, priceReports, products, stores, users } from '../../db/schema.js';
import { newId } from '../../lib/ids.js';
import {
  computeFreeTier,
  creditBalance,
  entitlementLevel,
  evaluateContributionCredits,
  freeTierProductIds,
  RedeemError,
  redeemFreeMonth,
  regionKey,
  revokeCreditForReport,
} from '../entitlements.js';

const KROGER = { lat: 32.9, lon: -97.2 };

function seedUser(db: AppDb, overrides: Partial<typeof users.$inferInsert> = {}): string {
  const id = newId();
  db.insert(users).values({ id, email: `${id}@example.com`, ...overrides }).run();
  return id;
}

/** reportsCount=3, no bad/confirmed history -> trust score 0.5 -> 'established' (see trust.ts). */
function seedEstablishedUser(db: AppDb): string {
  return seedUser(db, { reportsCount: 3, confirmedCount: 0, upheldFlagsCount: 0, dismissedFlagsCount: 0 });
}

function seedStore(db: AppDb, lat: number, lon: number, name = 'Kroger'): string {
  const id = newId();
  db.insert(stores).values({ id, name, lat, lon, chainKey: name.toLowerCase(), storeKey: newId() }).run();
  return id;
}

function seedProduct(db: AppDb, canonicalName = 'Milk'): string {
  const id = newId();
  db.insert(products).values({ id, canonicalName }).run();
  return id;
}

function seedReport(db: AppDb, userId: string, productId: string, storeId: string, overrides: Partial<typeof priceReports.$inferInsert> = {}): string {
  const id = newId();
  db.insert(priceReports).values({
    id,
    userId,
    productId,
    storeId,
    itemName: 'Milk',
    priceCents: 300,
    priceRaw: '3.00',
    observedDate: '2026-06-01',
    freshnessDate: '2026-06-01',
    status: 'active',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  }).run();
  return id;
}

describe('entitlementLevel', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;
  const now = () => new Date('2026-06-15T00:00:00.000Z');
  const load = (id: string) => db.select().from(users).where(eq(users.id, id)).all()[0];

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
  });

  afterEach(() => {
    sqlite.close();
  });

  it('is subscriber for an active, unexpired paid plan', () => {
    const id = seedUser(db, { plan: 'paid', planExpiresAt: '2026-07-01T00:00:00.000Z' });
    expect(entitlementLevel(load(id), now)).toBe('subscriber');
  });

  it('stays subscriber for up to 3 days past the period end (a delayed renewal webhook), then falls back to public', () => {
    const id = seedUser(db, { plan: 'paid', planExpiresAt: '2026-06-13T00:00:00.000Z' }); // ended 2 days ago
    expect(entitlementLevel(load(id), now)).toBe('subscriber');
    const lapsed = seedUser(db, { plan: 'paid', planExpiresAt: '2026-06-11T00:00:00.000Z' }); // ended 4 days ago
    expect(entitlementLevel(load(lapsed), now)).toBe('public');
    const longGone = seedUser(db, { plan: 'paid', planExpiresAt: '2026-06-01T00:00:00.000Z' });
    expect(entitlementLevel(load(longGone), now)).toBe('public');
  });

  it('a paid plan with no recorded expiry grants nothing (it used to mean "forever")', () => {
    const id = seedUser(db, { plan: 'paid', planExpiresAt: null });
    expect(entitlementLevel(load(id), now)).toBe('public');
  });

  it('a free plan is public even with a far-future expiry left over', () => {
    const id = seedUser(db, { plan: 'free', planExpiresAt: '2099-01-01T00:00:00.000Z' });
    expect(entitlementLevel(load(id), now)).toBe('public');
  });

  it('is contributor while credit access has not ended, and public the instant it has', () => {
    const active = seedUser(db, { creditAccessUntil: '2026-06-15T00:00:01.000Z' });
    expect(entitlementLevel(load(active), now)).toBe('contributor');
    const ended = seedUser(db, { creditAccessUntil: '2026-06-15T00:00:00.000Z' });
    expect(entitlementLevel(load(ended), now)).toBe('public');
    const never = seedUser(db);
    expect(entitlementLevel(load(never), now)).toBe('public');
  });

  it('subscriber outranks contributor', () => {
    const id = seedUser(db, { plan: 'paid', planExpiresAt: '2026-07-01T00:00:00.000Z', creditAccessUntil: '2026-07-01T00:00:00.000Z' });
    expect(entitlementLevel(load(id), now)).toBe('subscriber');
  });

  it('earning credits alone does not unlock anything -- only redeeming does', () => {
    const id = seedUser(db);
    giveCredits(db, id, 100, '2026-06-10T00:00:00.000Z');
    expect(entitlementLevel(load(id), now)).toBe('public');
  });
});

/** Gives `n` credit rows (10 credits each) to a user, each backed by a real report row. */
function giveCredits(db: AppDb, userId: string, n: number, earnedAt: string, extra: Partial<typeof contributionCredits.$inferInsert> = {}): string[] {
  const productId = seedProduct(db);
  const storeId = seedStore(db, KROGER.lat, KROGER.lon);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const reportId = seedReport(db, userId, productId, storeId);
    const id = newId();
    db.insert(contributionCredits).values({ id, userId, reportId, earnedAt, ...extra }).run();
    ids.push(id);
  }
  return ids;
}

describe('creditBalance', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;
  const now = () => new Date('2026-06-15T00:00:00.000Z');

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
  });

  afterEach(() => {
    sqlite.close();
  });

  it('is 10 credits per row, ignoring revoked, spent, and older-than-90-day rows', () => {
    const userId = seedUser(db);
    giveCredits(db, userId, 3, '2026-06-10T00:00:00.000Z'); // counts: 30
    giveCredits(db, userId, 2, '2026-06-10T00:00:00.000Z', { revokedAt: '2026-06-11T00:00:00.000Z' });
    giveCredits(db, userId, 4, '2026-03-01T00:00:00.000Z'); // 106 days old
    const redemptionId = newId();
    db.insert(creditRedemptions).values({ id: redemptionId, userId, credits: 200, accessFrom: '2026-06-01T00:00:00.000Z', accessUntil: '2026-07-01T00:00:00.000Z', createdAt: '2026-06-01T00:00:00.000Z' }).run();
    giveCredits(db, userId, 5, '2026-06-02T00:00:00.000Z', { spentRedemptionId: redemptionId });
    expect(creditBalance(db, userId, now)).toBe(30);
  });

  it('the 90-day window is inclusive of day 90 and exclusive after', () => {
    const userId = seedUser(db);
    giveCredits(db, userId, 1, '2026-03-17T00:00:00.000Z'); // exactly 90 days before now
    giveCredits(db, userId, 1, '2026-03-16T23:59:59.000Z'); // just past
    expect(creditBalance(db, userId, now)).toBe(10);
  });

  it("does not include other users' credits", () => {
    const a = seedUser(db);
    const b = seedUser(db);
    giveCredits(db, a, 3, '2026-06-10T00:00:00.000Z');
    expect(creditBalance(db, b, now)).toBe(0);
  });
});

describe('redeemFreeMonth', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;
  const now = () => new Date('2026-06-15T00:00:00.000Z');
  const load = (id: string) => db.select().from(users).where(eq(users.id, id)).all()[0];

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
  });

  afterEach(() => {
    sqlite.close();
  });

  it('spends exactly 200 credits and grants 30 days from now', () => {
    const userId = seedUser(db);
    giveCredits(db, userId, 20, '2026-06-10T00:00:00.000Z');
    const result = redeemFreeMonth(db, userId, now);
    expect(result).toEqual({ accessUntil: '2026-07-15T00:00:00.000Z', balance: 0 });
    expect(load(userId).creditAccessUntil).toBe('2026-07-15T00:00:00.000Z');
    expect(entitlementLevel(load(userId), now)).toBe('contributor');
  });

  it('spends the oldest credits first', () => {
    const userId = seedUser(db);
    const oldest = giveCredits(db, userId, 20, '2026-05-01T00:00:00.000Z');
    const newest = giveCredits(db, userId, 3, '2026-06-10T00:00:00.000Z');
    redeemFreeMonth(db, userId, now);
    const rows = db.select().from(contributionCredits).all();
    expect(rows.filter((r) => r.spentRedemptionId).map((r) => r.id).sort()).toEqual(oldest.sort());
    expect(rows.filter((r) => newest.includes(r.id)).every((r) => !r.spentRedemptionId)).toBe(true);
    expect(creditBalance(db, userId, now)).toBe(30);
  });

  it('refuses with a 409 below 200 and changes nothing', () => {
    const userId = seedUser(db);
    giveCredits(db, userId, 19, '2026-06-10T00:00:00.000Z');
    expect(() => redeemFreeMonth(db, userId, now)).toThrow(RedeemError);
    try {
      redeemFreeMonth(db, userId, now);
    } catch (err) {
      expect((err as RedeemError).status).toBe(409);
    }
    expect(creditBalance(db, userId, now)).toBe(190);
    expect(load(userId).creditAccessUntil).toBeNull();
    expect(db.select().from(creditRedemptions).all()).toHaveLength(0);
  });

  it('refuses for a subscriber, but not for a user whose subscription has lapsed', () => {
    const subscribed = seedUser(db, { plan: 'paid', planExpiresAt: '2026-07-01T00:00:00.000Z' });
    giveCredits(db, subscribed, 20, '2026-06-10T00:00:00.000Z');
    expect(() => redeemFreeMonth(db, subscribed, now)).toThrow(/active subscription/);
    expect(creditBalance(db, subscribed, now)).toBe(200);

    const lapsed = seedUser(db, { plan: 'paid', planExpiresAt: '2026-05-01T00:00:00.000Z' });
    giveCredits(db, lapsed, 20, '2026-06-10T00:00:00.000Z');
    expect(() => redeemFreeMonth(db, lapsed, now)).not.toThrow();
  });

  it('stacks: a second redemption extends from the end of the current access, not from today', () => {
    const userId = seedUser(db);
    giveCredits(db, userId, 40, '2026-06-10T00:00:00.000Z');
    redeemFreeMonth(db, userId, now);
    const second = redeemFreeMonth(db, userId, now);
    expect(second.accessUntil).toBe('2026-08-14T00:00:00.000Z');
  });

  it('starts fresh from today when the previous free month has already ended', () => {
    const userId = seedUser(db, { creditAccessUntil: '2026-06-01T00:00:00.000Z' });
    giveCredits(db, userId, 20, '2026-06-10T00:00:00.000Z');
    expect(redeemFreeMonth(db, userId, now).accessUntil).toBe('2026-07-15T00:00:00.000Z');
  });

  it('404s for an unknown user', () => {
    expect(() => redeemFreeMonth(db, 'ghost', now)).toThrow(RedeemError);
  });

  it('is all-or-nothing: if a write fails midway, no credits are spent and no access is granted', () => {
    const userId = seedUser(db);
    giveCredits(db, userId, 20, '2026-06-10T00:00:00.000Z');
    sqlite.exec(`create trigger boom before update on users begin select raise(abort, 'boom'); end`);
    expect(() => redeemFreeMonth(db, userId, now)).toThrow();
    sqlite.exec('drop trigger boom');
    expect(db.select().from(creditRedemptions).all()).toHaveLength(0);
    expect(db.select().from(contributionCredits).all().every((c) => !c.spentRedemptionId)).toBe(true);
    expect(creditBalance(db, userId, now)).toBe(200);
  });
});

describe('computeFreeTier / freeTierProductIds', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;
  const now = () => new Date('2026-06-15T00:00:00.000Z');

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
  });

  afterEach(() => {
    sqlite.close();
  });

  it('ranks products by distinct reporters x distinct stores and keeps only the top N', () => {
    const storeA = seedStore(db, KROGER.lat, KROGER.lon, 'Kroger');
    const storeB = seedStore(db, KROGER.lat + 0.01, KROGER.lon, 'Walmart');
    // Popular: 2 reporters x 2 stores = score 4.
    const popular = seedProduct(db, 'Milk');
    const [u1, u2] = [seedUser(db), seedUser(db)];
    seedReport(db, u1, popular, storeA);
    seedReport(db, u2, popular, storeB);
    // Rare: 1 reporter x 1 store = score 1.
    const rare = seedProduct(db, 'Truffle Oil');
    seedReport(db, u1, rare, storeA);

    computeFreeTier(db, KROGER.lat, KROGER.lon, 50, now);
    const ids = freeTierProductIds(db, KROGER.lat, KROGER.lon, 50);
    expect(ids.has(popular)).toBe(true);
    expect(ids.has(rare)).toBe(true); // fewer than FREE_TIER_PRODUCT_COUNT candidates -> everything included

    const rows = db.select().from(freeTierProducts).where(eq(freeTierProducts.regionKey, regionKey(KROGER.lat, KROGER.lon, 50))).all();
    const byId = Object.fromEntries(rows.map((r) => [r.productId, r.rank]));
    expect(byId[popular]).toBeLessThan(byId[rare]);
  });

  it('ignores reports outside the region and reports older than the 90-day window', () => {
    const storeA = seedStore(db, KROGER.lat, KROGER.lon);
    const farStore = seedStore(db, KROGER.lat + 10, KROGER.lon + 10);
    const userId = seedUser(db);
    const near = seedProduct(db, 'Milk');
    seedReport(db, userId, near, storeA);
    const far = seedProduct(db, 'Faraway Cheese');
    seedReport(db, userId, far, farStore);
    const stale = seedProduct(db, 'Old Chips');
    seedReport(db, userId, stale, storeA, { createdAt: '2025-01-01T00:00:00.000Z' });

    computeFreeTier(db, KROGER.lat, KROGER.lon, 50, now);
    const ids = freeTierProductIds(db, KROGER.lat, KROGER.lon, 50);
    expect(ids.has(near)).toBe(true);
    expect(ids.has(far)).toBe(false);
    expect(ids.has(stale)).toBe(false);
  });

  it('keeps a product in the set for 7 days after it enters, even if it would otherwise fall out', () => {
    const storeA = seedStore(db, KROGER.lat, KROGER.lon);
    const [u1, u2, u3] = [seedUser(db), seedUser(db), seedUser(db)];
    // 24 popular products (score 3) plus our newcomer (score 1) = 25 total: everyone fits on day 1, newcomer included.
    for (let i = 0; i < 24; i++) {
      const p = seedProduct(db, `Popular ${i}`);
      seedReport(db, u1, p, storeA);
      seedReport(db, u2, p, storeA);
      seedReport(db, u3, p, storeA);
    }
    const enteringProduct = seedProduct(db, 'Newcomer');
    seedReport(db, u1, enteringProduct, storeA);

    const day1 = () => new Date('2026-06-01T00:00:00.000Z');
    computeFreeTier(db, KROGER.lat, KROGER.lon, 50, day1);
    expect(freeTierProductIds(db, KROGER.lat, KROGER.lon, 50).has(enteringProduct)).toBe(true);

    // A 25th popular product now pushes candidates to 26; the newcomer (score 1) is the clear loser on merit...
    const p25 = seedProduct(db, 'Popular 24');
    seedReport(db, u1, p25, storeA);
    seedReport(db, u2, p25, storeA);
    seedReport(db, u3, p25, storeA);

    const day4 = () => new Date('2026-06-04T00:00:00.000Z');
    computeFreeTier(db, KROGER.lat, KROGER.lon, 50, day4);
    expect(freeTierProductIds(db, KROGER.lat, KROGER.lon, 50).has(enteringProduct)).toBe(true); // ...but still within its 7-day floor

    const day10 = () => new Date('2026-06-10T00:00:00.000Z');
    computeFreeTier(db, KROGER.lat, KROGER.lon, 50, day10);
    expect(freeTierProductIds(db, KROGER.lat, KROGER.lon, 50).has(enteringProduct)).toBe(false); // floor has expired
  });
});

describe('evaluateContributionCredits', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
  });

  afterEach(() => {
    sqlite.close();
  });

  const now = () => new Date('2026-06-20T00:00:00.000Z');

  it('awards a credit for a confirmed, non-redundant report from an established author', () => {
    const author = seedEstablishedUser(db);
    const productId = seedProduct(db);
    const storeId = seedStore(db, KROGER.lat, KROGER.lon);
    const reportId = seedReport(db, author, productId, storeId, { confirmCount: 1, observedDate: '2026-06-19', createdAt: '2026-06-19T00:00:00.000Z' });

    expect(evaluateContributionCredits(db, now)).toBe(1);
    const credit = db.select().from(contributionCredits).where(eq(contributionCredits.reportId, reportId)).all()[0];
    expect(credit.userId).toBe(author);
  });

  it('awards a credit for an old-enough, still-active-and-unflagged report even with no confirmation', () => {
    const author = seedEstablishedUser(db);
    const productId = seedProduct(db);
    const storeId = seedStore(db, KROGER.lat, KROGER.lon);
    seedReport(db, author, productId, storeId, { createdAt: '2026-06-01T00:00:00.000Z' }); // 19 days old

    expect(evaluateContributionCredits(db, now)).toBe(1);
  });

  it('does not award a credit for a report younger than 14 days with no confirmation', () => {
    const author = seedEstablishedUser(db);
    const productId = seedProduct(db);
    const storeId = seedStore(db, KROGER.lat, KROGER.lon);
    seedReport(db, author, productId, storeId, { createdAt: '2026-06-19T00:00:00.000Z' });

    expect(evaluateContributionCredits(db, now)).toBe(0);
  });

  it('does not award a credit to a new-tier author', () => {
    const author = seedUser(db); // reportsCount 0 -> 'new'
    const productId = seedProduct(db);
    const storeId = seedStore(db, KROGER.lat, KROGER.lon);
    seedReport(db, author, productId, storeId, { confirmCount: 1, createdAt: '2026-06-01T00:00:00.000Z' });

    expect(evaluateContributionCredits(db, now)).toBe(0);
  });

  it('does not award a credit for a price-outlier report', () => {
    const author = seedEstablishedUser(db);
    const productId = seedProduct(db);
    const storeId = seedStore(db, KROGER.lat, KROGER.lon);
    seedReport(db, author, productId, storeId, { confirmCount: 1, reviewReason: 'price_outlier', createdAt: '2026-06-01T00:00:00.000Z' });

    expect(evaluateContributionCredits(db, now)).toBe(0);
  });

  it('does not award a second credit for a same-pair report within 30 days at nearly the same price', () => {
    const author = seedEstablishedUser(db);
    const productId = seedProduct(db);
    const storeId = seedStore(db, KROGER.lat, KROGER.lon);
    const firstId = seedReport(db, author, productId, storeId, { confirmCount: 1, observedDate: '2026-06-01', createdAt: '2026-06-01T00:00:00.000Z' });
    db.insert(currentPrices).values({ productId, storeId, reportId: firstId, priceCents: 300, observedDate: '2026-06-10' }).run();
    seedReport(db, author, productId, storeId, { confirmCount: 1, observedDate: '2026-06-10', createdAt: '2026-06-01T00:00:00.000Z', priceCents: 305 });

    // Only the first (non-redundant) report earns; the second is a <5% price move on the same pair within 30 days.
    expect(evaluateContributionCredits(db, now)).toBe(1);
  });

  it('awards a credit for a same-pair report within 30 days when the price differs by at least 5%', () => {
    const author = seedEstablishedUser(db);
    const productId = seedProduct(db);
    const storeId = seedStore(db, KROGER.lat, KROGER.lon);
    const firstId = seedReport(db, author, productId, storeId, { confirmCount: 1, observedDate: '2026-06-01', createdAt: '2026-06-01T00:00:00.000Z' });
    db.insert(currentPrices).values({ productId, storeId, reportId: firstId, priceCents: 300, observedDate: '2026-06-10' }).run();
    seedReport(db, author, productId, storeId, { confirmCount: 1, observedDate: '2026-06-10', createdAt: '2026-06-01T00:00:00.000Z', priceCents: 400 });

    expect(evaluateContributionCredits(db, now)).toBe(2);
  });

  it('caps credits at 10 per user per day', () => {
    const author = seedEstablishedUser(db);
    const storeId = seedStore(db, KROGER.lat, KROGER.lon);
    for (let i = 0; i < 12; i++) {
      const productId = seedProduct(db, `Product ${i}`);
      seedReport(db, author, productId, storeId, { confirmCount: 1, createdAt: '2026-06-01T00:00:00.000Z' });
    }
    expect(evaluateContributionCredits(db, now)).toBe(10);
  });

  it('never re-evaluates a report that already has a credit row', () => {
    const author = seedEstablishedUser(db);
    const productId = seedProduct(db);
    const storeId = seedStore(db, KROGER.lat, KROGER.lon);
    seedReport(db, author, productId, storeId, { confirmCount: 1, createdAt: '2026-06-01T00:00:00.000Z' });

    expect(evaluateContributionCredits(db, now)).toBe(1);
    expect(evaluateContributionCredits(db, now)).toBe(0);
  });
});

describe('revokeCreditForReport', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
  });

  afterEach(() => {
    sqlite.close();
  });

  it('marks a report\'s credit as revoked', () => {
    const userId = seedUser(db);
    const productId = seedProduct(db);
    const storeId = seedStore(db, KROGER.lat, KROGER.lon);
    const reportId = seedReport(db, userId, productId, storeId);
    db.insert(contributionCredits).values({ id: newId(), userId, reportId, earnedAt: '2026-06-01T00:00:00.000Z' }).run();

    revokeCreditForReport(db, reportId, () => new Date('2026-06-15T00:00:00.000Z'));
    const credit = db.select().from(contributionCredits).where(eq(contributionCredits.reportId, reportId)).all()[0];
    expect(credit.revokedAt).toBe('2026-06-15T00:00:00.000Z');
  });
});
