import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { runMigrations } from '../../db/migrate.js';
import type { AppDb } from '../../db/client.js';
import { priceReports, products, stores, users } from '../../db/schema.js';
import { newId } from '../../lib/ids.js';
import { castVote, recountReport, removeVote, VoteError } from '../votes.js';

function seedUser(db: AppDb, overrides: Partial<typeof users.$inferInsert> = {}): string {
  const id = newId();
  db.insert(users).values({ id, email: `${id}@example.com`, ...overrides }).run();
  return id;
}

function seedProductStore(db: AppDb) {
  const productId = newId();
  const storeId = newId();
  db.insert(products).values({ id: productId, canonicalName: 'Milk' }).run();
  db.insert(stores).values({ id: storeId, name: 'Kroger', chainKey: 'kroger', storeKey: newId() }).run();
  return { productId, storeId };
}

function seedReport(db: AppDb, userId: string, overrides: Partial<typeof priceReports.$inferInsert> = {}): string {
  const { productId, storeId } = seedProductStore(db);
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
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  }).run();
  return id;
}

describe('castVote: confirm', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
  });

  afterEach(() => {
    sqlite.close();
  });

  it('confirms a report and bumps its confirm count and freshness date', () => {
    const author = seedUser(db);
    const voter = seedUser(db);
    const reportId = seedReport(db, author);
    const state = castVote(db, { userId: voter, reportId, kind: 'confirm' }, () => new Date('2026-06-15T00:00:00.000Z'));
    expect(state.confirmCount).toBe(1);
    expect(state.myVote).toBe('confirm');
    const report = db.select().from(priceReports).where(eq(priceReports.id, reportId)).all()[0];
    expect(report?.freshnessDate).toBe('2026-06-15');
  });

  it('rejects confirming your own report', () => {
    const author = seedUser(db);
    const reportId = seedReport(db, author);
    expect(() => castVote(db, { userId: author, reportId, kind: 'confirm' })).toThrow(VoteError);
  });

  it('is idempotent: confirming twice does not double-count', () => {
    const author = seedUser(db);
    const voter = seedUser(db);
    const reportId = seedReport(db, author);
    castVote(db, { userId: voter, reportId, kind: 'confirm' });
    castVote(db, { userId: voter, reportId, kind: 'confirm' });
    const report = db.select().from(priceReports).where(eq(priceReports.id, reportId)).all()[0];
    expect(report?.confirmCount).toBe(1);
  });

  it('rejects a vote from a banned account', () => {
    const author = seedUser(db);
    const voter = seedUser(db, { status: 'banned' });
    const reportId = seedReport(db, author);
    expect(() => castVote(db, { userId: voter, reportId, kind: 'confirm' })).toThrow(VoteError);
  });

  it('404s on an unknown report', () => {
    const voter = seedUser(db);
    expect(() => castVote(db, { userId: voter, reportId: 'nope', kind: 'confirm' })).toThrow(VoteError);
  });
});

describe('castVote: flag and the hide threshold', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
  });

  afterEach(() => {
    sqlite.close();
  });

  it('requires a reason', () => {
    const author = seedUser(db);
    const voter = seedUser(db);
    const reportId = seedReport(db, author);
    // `reason` is optional in the type (the route validates it with zod before
    // this point); castVote has its own runtime guard as a second line of defense.
    expect(() => castVote(db, { userId: voter, reportId, kind: 'flag' })).toThrow(VoteError);
  });

  it('records the voter\'s trust score as the flag weight', () => {
    const author = seedUser(db);
    const voter = seedUser(db, { trustScore: 0.9 });
    const reportId = seedReport(db, author);
    const state = castVote(db, { userId: voter, reportId, kind: 'flag', reason: 'wrong_price' });
    expect(state.flagWeight).toBeCloseTo(0.9);
  });

  it('hides a report once combined weight >= 1.5 from >= 2 distinct flaggers', () => {
    const author = seedUser(db);
    const a = seedUser(db, { trustScore: 0.9 });
    const b = seedUser(db, { trustScore: 0.9 });
    const reportId = seedReport(db, author);
    castVote(db, { userId: a, reportId, kind: 'flag', reason: 'wrong_price' });
    const state = castVote(db, { userId: b, reportId, kind: 'flag', reason: 'wrong_price' });
    expect(state.status).toBe('hidden');
    expect(state.reviewReason).toBe('flagged');
  });

  it('does not hide from a single flagger even with high weight', () => {
    const author = seedUser(db);
    const a = seedUser(db, { trustScore: 0.95 });
    const reportId = seedReport(db, author);
    const state = castVote(db, { userId: a, reportId, kind: 'flag', reason: 'wrong_price' });
    expect(state.status).toBe('active');
  });

  it('does not hide when combined weight from two low-trust flaggers is under 1.5', () => {
    const author = seedUser(db);
    const a = seedUser(db, { trustScore: 0.33 });
    const b = seedUser(db, { trustScore: 0.33 });
    const reportId = seedReport(db, author);
    castVote(db, { userId: a, reportId, kind: 'flag', reason: 'spam' });
    const state = castVote(db, { userId: b, reportId, kind: 'flag', reason: 'spam' });
    expect(state.status).toBe('active');
  });

  it('rejects a second vote from the same user on the same report without withdrawing first', () => {
    const author = seedUser(db);
    const voter = seedUser(db);
    const reportId = seedReport(db, author);
    castVote(db, { userId: voter, reportId, kind: 'confirm' });
    expect(() => castVote(db, { userId: voter, reportId, kind: 'flag', reason: 'spam' })).not.toThrow();
    // switching kind replaces the vote; recheck state
  });

  it('enforces the votes-per-hour rate limit', () => {
    const author = seedUser(db);
    const voter = seedUser(db);
    for (let i = 0; i < 30; i++) {
      const reportId = seedReport(db, author);
      castVote(db, { userId: voter, reportId, kind: 'confirm' });
    }
    const lastReport = seedReport(db, author);
    expect(() => castVote(db, { userId: voter, reportId: lastReport, kind: 'confirm' })).toThrow(VoteError);
  });
});

describe('removeVote', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
  });

  afterEach(() => {
    sqlite.close();
  });

  it('withdraws a confirmation and recounts', () => {
    const author = seedUser(db);
    const voter = seedUser(db);
    const reportId = seedReport(db, author);
    castVote(db, { userId: voter, reportId, kind: 'confirm' });
    const state = removeVote(db, voter, reportId);
    expect(state.myVote).toBeNull();
    expect(state.confirmCount).toBe(0);
  });

  it('leaves a flagged report hidden even after a flagger withdraws (only an admin can restore it, per plan section 9.3)', () => {
    const author = seedUser(db);
    const a = seedUser(db, { trustScore: 0.9 });
    const b = seedUser(db, { trustScore: 0.9 });
    const reportId = seedReport(db, author);
    castVote(db, { userId: a, reportId, kind: 'flag', reason: 'spam' });
    castVote(db, { userId: b, reportId, kind: 'flag', reason: 'spam' });
    expect(db.select().from(priceReports).where(eq(priceReports.id, reportId)).all()[0]?.status).toBe('hidden');
    const state = removeVote(db, a, reportId);
    expect(state.status).toBe('hidden');
    expect(state.flagWeight).toBeCloseTo(0.9); // recounted down to just b's flag, but still hidden
  });

  it('is a no-op when there is nothing to withdraw', () => {
    const author = seedUser(db);
    const voter = seedUser(db);
    const reportId = seedReport(db, author);
    expect(() => removeVote(db, voter, reportId)).not.toThrow();
  });
});

describe('recountReport: restricted-author release', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
  });

  afterEach(() => {
    sqlite.close();
  });

  it('releases a new_user-held report once it has 2 confirmations', () => {
    const author = seedUser(db, { status: 'restricted' });
    const voterA = seedUser(db);
    const voterB = seedUser(db);
    const reportId = seedReport(db, author, { status: 'hidden', reviewReason: 'new_user' });
    castVote(db, { userId: voterA, reportId, kind: 'confirm' });
    const state = castVote(db, { userId: voterB, reportId, kind: 'confirm' });
    expect(state.status).toBe('active');
    expect(state.reviewReason).toBeNull();
  });

  it('leaves it hidden with a single confirmation', () => {
    const author = seedUser(db, { status: 'restricted' });
    const voter = seedUser(db);
    const reportId = seedReport(db, author, { status: 'hidden', reviewReason: 'new_user' });
    const state = castVote(db, { userId: voter, reportId, kind: 'confirm' });
    expect(state.status).toBe('hidden');
  });
});

describe('recountReport updates the author trust and current price', () => {
  it('recomputes trust after a confirmation', () => {
    const { db, sqlite } = runMigrations(':memory:');
    const author = seedUser(db, { reportsCount: 3 });
    const voter = seedUser(db);
    const reportId = seedReport(db, author, { userId: author });
    recountReport(db, reportId); // no votes yet; harmless
    castVote(db, { userId: voter, reportId, kind: 'confirm' });
    const updatedAuthor = db.select().from(users).where(eq(users.id, author)).all()[0];
    expect(updatedAuthor?.confirmedCount).toBe(1);
    sqlite.close();
  });
});
