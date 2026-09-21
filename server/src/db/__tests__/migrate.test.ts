import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../migrate.js';
import { sql } from 'drizzle-orm';

describe('runMigrations', () => {
  const dbPaths: string[] = [];
  const tempDbPath = () => {
    const p = path.join(os.tmpdir(), `grocerez-test-${Math.random().toString(36).slice(2)}.db`);
    dbPaths.push(p);
    return p;
  };

  afterEach(() => {
    for (const p of dbPaths.splice(0)) {
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(p + suffix, { force: true });
    }
  });

  it('creates every table declared in the schema', () => {
    const { db, sqlite } = runMigrations(tempDbPath());
    const rows = db.all<{ name: string }>(
      sql`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '__drizzle%'`,
    );
    const names = new Set(rows.map((r) => r.name));
    for (const table of [
      'users', 'auth_codes', 'sessions', 'devices', 'subscriptions',
      'stores', 'products', 'product_tokens', 'price_reports', 'report_votes',
      'current_prices', 'free_tier_products', 'contribution_credits',
    ]) {
      expect(names.has(table)).toBe(true);
    }
    sqlite.close();
  });

  it('is safe to run twice against the same database', () => {
    const p = tempDbPath();
    const first = runMigrations(p);
    first.sqlite.close();
    const second = runMigrations(p); // should be a no-op, not an error
    second.sqlite.close();
  });

  it('enforces the unique email constraint', () => {
    const { db, sqlite } = runMigrations(tempDbPath());
    db.run(sql`insert into users (id, email) values ('u1', 'a@example.com')`);
    expect(() => db.run(sql`insert into users (id, email) values ('u2', 'a@example.com')`)).toThrow();
    sqlite.close();
  });

  it('enforces foreign keys (a report needs a real user)', () => {
    const { db, sqlite } = runMigrations(tempDbPath());
    expect(() =>
      db.run(sql`
        insert into price_reports
          (id, user_id, item_name, price_cents, price_raw, observed_date, updated_at)
        values
          ('r1', 'no-such-user', 'Milk', 299, '2.99', '2026-09-17', '2026-09-17T00:00:00.000Z')
      `),
    ).toThrow();
    sqlite.close();
  });
});
