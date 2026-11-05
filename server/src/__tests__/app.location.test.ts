import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { createApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import type { AppDb } from '../db/client.js';
import type { Mailer } from '../lib/mail.js';
import { priceReports, stores } from '../db/schema.js';

const json = (res: Response): Promise<Record<string, any>> => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

class FakeMailer implements Mailer {
  sent: string[] = [];
  async send(_to: string, _subject: string, text: string): Promise<void> {
    this.sent.push(text);
  }
  lastCode(): string {
    return this.sent.at(-1)!.match(/\d{6}/)![0];
  }
}

describe('every price report and store needs a location', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;
  let mailer: FakeMailer;

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
    mailer = new FakeMailer();
  });
  afterEach(() => sqlite.close());

  const app = () => createApp({ db, corsOrigins: [], mailer });
  const signIn = async (a: ReturnType<typeof createApp>): Promise<string> => {
    await a.request('/api/auth/request-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@example.com' }) });
    const res = await a.request('/api/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@example.com', code: mailer.lastCode() }) });
    return (await json(res)).sessionToken as string;
  };
  const report = (id: string, extra: Record<string, unknown> = {}) => ({
    id, itemName: 'Milk', brand: '', tags: [], quantity: 1, quantityUnits: 'each', price: '3.99', store: 'Kroger',
    latitude: 32.9, longitude: -97.2, observedDate: '2026-10-20', updatedAt: '2026-10-20T00:00:00.000Z', ...extra,
  });
  const push = async (a: ReturnType<typeof createApp>, token: string, reports: unknown[]) =>
    (await json(await a.request('/api/sync/push', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ reports }) }))).results as { id: string; status: string; error?: string }[];

  it('accepts a report with a location', async () => {
    const a = app();
    const [r] = await push(a, await signIn(a), [report('ok')]);
    expect(r.status).toBe('active');
  });

  it('rejects a report with no location, a null location, or only half of one, and stores nothing', async () => {
    const a = app();
    const token = await signIn(a);
    const results = await push(a, token, [
      report('none', { latitude: undefined, longitude: undefined }),
      report('null', { latitude: null, longitude: null }),
      report('half', { longitude: undefined }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(results.every((r) => /location is required/i.test(r.error ?? ''))).toBe(true);
    expect(db.select().from(priceReports).all()).toHaveLength(0);
    expect(db.select().from(stores).all()).toHaveLength(0);
  });

  it('still lets a withdrawal through without a location, so it can never get stuck', async () => {
    const a = app();
    const token = await signIn(a);
    await push(a, token, [report('x')]);
    const [r] = await push(a, token, [report('x', { latitude: undefined, longitude: undefined, deletedAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z' })]);
    expect(r.status).toBe('deleted');
    expect(db.select().from(priceReports).all()[0].status).toBe('deleted');
  });

  it('the database itself refuses a store without a location, on insert and when removing one', () => {
    const insert = (lat: number | null, lon: number | null) =>
      db.insert(stores).values({ id: `s${Math.random()}`, name: 'X', lat, lon, chainKey: 'x', storeKey: `k${Math.random()}` }).run();
    expect(() => insert(null, null)).toThrow(/require lat and lon/);
    expect(() => insert(32.9, null)).toThrow(/require lat and lon/);
    insert(32.9, -97.2);
    expect(() => sqlite.exec('update stores set lat = null')).toThrow(/require lat and lon/);
    db.run(sql`update stores set shop_type = 'supermarket'`); // other edits are fine
    db.run(sql`update stores set lat = 33.0`); // and so is moving it
  });
});
