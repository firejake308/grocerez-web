import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { runMigrations } from '../../db/migrate.js';
import type { AppDb } from '../../db/client.js';
import { consumeRateLimit } from '../rateLimit.js';

describe('consumeRateLimit', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
  });

  afterEach(() => {
    sqlite.close();
  });

  it('allows up to the limit, then rejects', () => {
    for (let i = 0; i < 3; i++) expect(consumeRateLimit(db, 'b', 3)).toBe(true);
    expect(consumeRateLimit(db, 'b', 3)).toBe(false);
  });

  it('tracks separate buckets independently', () => {
    for (let i = 0; i < 3; i++) consumeRateLimit(db, 'a', 3);
    expect(consumeRateLimit(db, 'a', 3)).toBe(false);
    expect(consumeRateLimit(db, 'b', 3)).toBe(true);
  });

  it('is a sliding window: events older than an hour no longer count', () => {
    const base = new Date('2026-01-01T00:00:00.000Z');
    for (let i = 0; i < 3; i++) consumeRateLimit(db, 'c', 3, () => base);
    expect(consumeRateLimit(db, 'c', 3, () => base)).toBe(false);
    const later = () => new Date(base.getTime() + 61 * 60_000);
    expect(consumeRateLimit(db, 'c', 3, later)).toBe(true);
  });
});
