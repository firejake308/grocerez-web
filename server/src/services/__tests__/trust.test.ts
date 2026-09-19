import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { runMigrations } from '../../db/migrate.js';
import type { AppDb } from '../../db/client.js';
import { users, priceReports } from '../../db/schema.js';
import { newId } from '../../lib/ids.js';
import { badCount, recomputeAllTrust, recomputeUserTrust, tierForUser, trustScore, trustTier } from '../trust.js';

describe('trustScore / trustTier (pure)', () => {
  it('is 0.5 for a fresh user with no confirmations or bad reports', () => {
    expect(trustScore(0, 0)).toBe(0.5);
  });

  it('rises with confirmations and falls with bad reports', () => {
    expect(trustScore(10, 0)).toBeGreaterThan(trustScore(0, 0));
    expect(trustScore(0, 3)).toBeLessThan(trustScore(0, 0));
  });

  it('is "new" below 3 reports regardless of score', () => {
    expect(trustTier(0, 0, 0)).toBe('new');
    expect(trustTier(2, 50, 0)).toBe('new');
  });

  it('graduates established -> trusted as confirmations pile up', () => {
    expect(trustTier(3, 0, 0)).toBe('established'); // score 0.5
    expect(trustTier(3, 10, 0)).toBe('trusted');
  });

  it('drops to restricted once bad reports dominate', () => {
    expect(trustTier(3, 0, 5)).toBe('restricted');
  });
});

describe('badCount', () => {
  it('counts upheld flags fully and dismissed flags at one-third weight', () => {
    expect(badCount({ upheldFlagsCount: 2, dismissedFlagsCount: 0 })).toBe(2);
    expect(badCount({ upheldFlagsCount: 0, dismissedFlagsCount: 5 })).toBe(1); // floor(5/3)
    expect(badCount({ upheldFlagsCount: 1, dismissedFlagsCount: 3 })).toBe(2);
  });
});

function seedUser(db: AppDb, overrides: Partial<typeof users.$inferInsert> = {}): string {
  const id = newId();
  db.insert(users).values({ id, email: `${id}@example.com`, ...overrides }).run();
  return id;
}

function seedReport(db: AppDb, userId: string, overrides: Partial<typeof priceReports.$inferInsert> = {}) {
  const id = newId();
  db.insert(priceReports).values({
    id,
    userId,
    itemName: 'Milk',
    priceCents: 300,
    priceRaw: '3.00',
    observedDate: '2026-01-01',
    freshnessDate: '2026-01-01',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }).run();
  return id;
}

describe('recomputeUserTrust', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
  });

  afterEach(() => {
    sqlite.close();
  });

  it('counts a report as confirmed once it has at least one confirmation', () => {
    const uid = seedUser(db);
    seedReport(db, uid, { confirmCount: 1 });
    seedReport(db, uid, { confirmCount: 0 });
    seedReport(db, uid, { confirmCount: 0 });
    const result = recomputeUserTrust(db, uid);
    const user = db.select().from(users).where(eq(users.id, uid)).all()[0];
    expect(user?.confirmedCount).toBe(1);
    expect(user?.reportsCount).toBe(3);
    expect(result?.tier).toBe('established'); // score 2/3
  });

  it('counts an unconfirmed, unflagged report as confirmed once it is 14+ days old', () => {
    const uid = seedUser(db);
    seedReport(db, uid, { createdAt: '2026-01-01T00:00:00.000Z' });
    seedReport(db, uid, { createdAt: '2026-01-01T00:00:00.000Z' });
    seedReport(db, uid, { createdAt: '2026-01-01T00:00:00.000Z' });
    const soon = () => new Date('2026-01-10T00:00:00.000Z'); // 9 days: not yet
    const later = () => new Date('2026-01-20T00:00:00.000Z'); // 19 days: yes

    recomputeUserTrust(db, uid, soon);
    expect(db.select().from(users).where(eq(users.id, uid)).all()[0]?.confirmedCount).toBe(0);

    recomputeUserTrust(db, uid, later);
    expect(db.select().from(users).where(eq(users.id, uid)).all()[0]?.confirmedCount).toBe(3);
  });

  it('does not count a flagged (nonzero flagWeight) report as confirmed just from tenure', () => {
    const uid = seedUser(db);
    seedReport(db, uid, { createdAt: '2026-01-01T00:00:00.000Z', flagWeight: 0.5 });
    const later = () => new Date('2026-02-01T00:00:00.000Z');
    recomputeUserTrust(db, uid, later);
    expect(db.select().from(users).where(eq(users.id, uid)).all()[0]?.confirmedCount).toBe(0);
  });

  it('excludes deleted reports from reports_count', () => {
    const uid = seedUser(db);
    seedReport(db, uid);
    seedReport(db, uid, { status: 'deleted' });
    recomputeUserTrust(db, uid);
    expect(db.select().from(users).where(eq(users.id, uid)).all()[0]?.reportsCount).toBe(1);
  });

  it('folds upheld and dismissed flags into the bad count', () => {
    const uid = seedUser(db, { upheldFlagsCount: 1, dismissedFlagsCount: 3 });
    seedReport(db, uid, { confirmCount: 1 });
    seedReport(db, uid, { confirmCount: 1 });
    seedReport(db, uid, { confirmCount: 1 });
    const result = recomputeUserTrust(db, uid);
    // confirmed=3, bad=1+floor(3/3)=2 -> score=(3+1)/(3+6+2)=4/11
    expect(result?.trustScore).toBeCloseTo(4 / 11, 6);
  });

  it('returns null for an unknown user', () => {
    expect(recomputeUserTrust(db, 'nope')).toBeNull();
  });
});

describe('recomputeAllTrust', () => {
  it('recomputes every user and returns the count', () => {
    const { db, sqlite } = runMigrations(':memory:');
    const a = seedUser(db);
    const b = seedUser(db);
    seedReport(db, a, { confirmCount: 1 });
    const n = recomputeAllTrust(db);
    expect(n).toBe(2);
    expect(db.select().from(users).where(eq(users.id, a)).all()[0]?.confirmedCount).toBe(1);
    void b;
    sqlite.close();
  });
});

describe('tierForUser', () => {
  it('matches trustTier applied to the user row', () => {
    const user = { reportsCount: 5, confirmedCount: 4, upheldFlagsCount: 0, dismissedFlagsCount: 0 };
    expect(tierForUser(user)).toBe(trustTier(5, 4, 0));
  });
});
