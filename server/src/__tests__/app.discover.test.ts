import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { createApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import type { AppDb } from '../db/client.js';
import type { Mailer } from '../lib/mail.js';
import { priceReports, users } from '../db/schema.js';
import { fillerReports } from './helpers/freeSet.js';

const json = (res: Response): Promise<Record<string, any>> => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

const DFW = { lat: 32.9019798, lon: -97.1889734, store: 'Kroger @ 9150 North Tarrant Parkway' };
const NYC = { lat: 40.7128, lon: -74.006, store: 'Key Food @ 1 Broadway' };

class FakeMailer implements Mailer {
  sent: string[] = [];
  async send(_to: string, _subject: string, text: string): Promise<void> {
    this.sent.push(text);
  }
  lastCode(): string {
    return this.sent.at(-1)!.match(/\d{6}/)![0];
  }
}

describe('GET /api/discover', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;
  let mailer: FakeMailer;

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
    mailer = new FakeMailer();
  });

  afterEach(() => {
    sqlite.close();
  });

  const build = (entitlementsEnforced: boolean) => createApp({ db, corsOrigins: [], mailer, entitlementsEnforced });

  const signIn = async (app: ReturnType<typeof createApp>, email: string): Promise<string> => {
    await app.request('/api/auth/request-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    const res = await app.request('/api/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: mailer.lastCode() }) });
    return (await json(res)).sessionToken as string;
  };
  const device = async (app: ReturnType<typeof createApp>): Promise<string> => (await json(await app.request('/api/devices/register', { method: 'POST' }))).deviceToken as string;

  const mk = (where: typeof DFW) => (id: string, itemName: string) => ({
    id, itemName, brand: '', tags: [], quantity: 1, quantityUnits: 'each', price: '4.99',
    store: where.store, latitude: where.lat, longitude: where.lon, observedDate: '2026-10-20', updatedAt: '2026-10-20T00:00:00.000Z',
  });
  const push = (app: ReturnType<typeof createApp>, token: string, reports: unknown[]) =>
    app.request('/api/sync/push', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ reports }) });
  const discover = async (app: ReturnType<typeof createApp>, token: string, query = '') =>
    json(await app.request(`/api/discover${query}`, { headers: { Authorization: `Bearer ${token}` } }));
  const names = (body: Record<string, any>) => (body.reports as { itemName: string }[]).map((r) => r.itemName); // eslint-disable-line @typescript-eslint/no-explicit-any

  it('requires a device or session token', async () => {
    const app = build(true);
    expect((await app.request('/api/discover')).status).toBe(401);
    expect((await app.request('/api/discover', { headers: { Authorization: 'Bearer nope' } })).status).toBe(401);
  });

  describe('enforcement off', () => {
    it('returns the newest report per product, anywhere, newest first, with no locked teasers and no location needed', async () => {
      const app = build(false);
      const scanner = await signIn(app, 'scanner@example.com');
      await push(app, scanner, [mk(DFW)('a', 'Milk'), mk(NYC)('b', 'Eggs'), mk(DFW)('c', 'Bread'), mk(NYC)('d', 'Milk')]);
      const body = await discover(app, await device(app));
      expect(body.accessLevel).toBe('unrestricted');
      expect(names(body)).toEqual(['Milk', 'Bread', 'Eggs']); // Milk once (its newest report), newest product first
      expect(body.reports.find((r: { itemName: string }) => r.itemName === 'Milk').storeName).toBe('Key Food');
      expect(body.locked).toEqual([]);
    });

    it('skips hidden and deleted reports and stores without coordinates', async () => {
      const app = build(false);
      const scanner = await signIn(app, 'scanner@example.com');
      await push(app, scanner, [mk(DFW)('a', 'Milk'), mk(DFW)('b', 'Eggs'), mk(DFW)('c', 'Bread'), { ...mk(DFW)('d', 'Cheese'), store: 'Walmart', latitude: undefined, longitude: undefined }]);
      sqlite.prepare("update price_reports set status = 'hidden' where id = 'b'").run();
      sqlite.prepare("update price_reports set status = 'deleted' where id = 'c'").run();
      expect(names(await discover(app, await device(app)))).toEqual(['Milk']);
    });

    it('honors ?limit, clamping nonsense to the default and huge values to 20', async () => {
      const app = build(false);
      const scanner = await signIn(app, 'scanner@example.com');
      await push(app, scanner, fillerReports('f', mk(DFW)));
      const token = await device(app);
      expect(await discover(app, token, '?limit=3').then((b) => b.reports)).toHaveLength(3);
      expect(await discover(app, token, '?limit=0').then((b) => b.reports)).toHaveLength(6);
      expect(await discover(app, token, '?limit=abc').then((b) => b.reports)).toHaveLength(6);
      expect(await discover(app, token, '?limit=100').then((b) => b.reports)).toHaveLength(20);
    });

    it('is empty, not an error, on an empty database', async () => {
      const app = build(false);
      expect(await discover(app, await device(app))).toMatchObject({ reports: [], locked: [] });
    });
  });

  describe('enforcement on', () => {
    it('in a young region everything is free: a brand-new product is shown with its price, nothing is locked', async () => {
      const app = build(true);
      const scanner = await signIn(app, 'scanner@example.com');
      await push(app, scanner, [mk(DFW)('a', 'Dummy Milk')]);
      const body = await discover(app, await device(app));
      expect(body.accessLevel).toBe('public');
      expect(names(body)).toEqual(['Dummy Milk']);
      expect(body.reports[0].priceCents).toBe(499);
      expect(body.locked).toEqual([]);
    });

    it('shows a product outside a full free set only as a price-less teaser, and never leaks its price', async () => {
      const app = build(true);
      const a = await signIn(app, 'a@example.com');
      const b = await signIn(app, 'b@example.com');
      await push(app, a, fillerReports('fa', mk(NYC)));
      await push(app, b, fillerReports('fb', mk(NYC)));
      await push(app, a, [{ ...mk(NYC)('o', 'Olipop'), price: '7.77' }]); // one reporter: ranks below the 25 fillers
      const res = await app.request('/api/discover?limit=20', { headers: { Authorization: `Bearer ${await device(app)}` } });
      const text = await res.text();
      const body = JSON.parse(text);
      expect(names(body)).not.toContain('Olipop');
      expect(body.locked).toHaveLength(1);
      expect(body.locked[0]).toMatchObject({ canonicalName: 'Olipop', storeCount: 1, reportCount: 1 });
      expect(text).not.toContain('"priceCents":777');
      expect(text).not.toContain('7.77');
      expect(body.locked[0].priceCents).toBeUndefined();
      expect(Object.keys(body.locked[0]).sort()).toEqual(['canonicalName', 'newestDate', 'productId', 'reportCount', 'storeCount']);
    });

    it("applies each store's own region: free in a young region, locked where the free set is full", async () => {
      const app = build(true);
      const a = await signIn(app, 'a@example.com');
      const b = await signIn(app, 'b@example.com');
      await push(app, a, fillerReports('fa', mk(NYC)));
      await push(app, b, fillerReports('fb', mk(NYC)));
      await push(app, a, [mk(NYC)('o', 'Olipop'), mk(DFW)('m', 'Dummy Milk')]);
      const body = await discover(app, await device(app), '?limit=20');
      expect(names(body)).toContain('Dummy Milk'); // young DFW region: free
      expect(names(body)).not.toContain('Olipop'); // full NYC free set: locked
      expect(body.locked.map((l: { canonicalName: string }) => l.canonicalName)).toEqual(['Olipop']);
    });

    it('returns at most 3 teasers', async () => {
      const app = build(true);
      const a = await signIn(app, 'a@example.com');
      const b = await signIn(app, 'b@example.com');
      await push(app, a, fillerReports('fa', mk(NYC)));
      await push(app, b, fillerReports('fb', mk(NYC)));
      await push(app, a, ['Olipop', 'Poppi', 'Humm', 'Culture Pop', 'Koia'].map((n, i) => mk(NYC)(`x${i}`, n)));
      const body = await discover(app, await device(app), '?limit=20');
      expect(body.locked).toHaveLength(3);
    });

    it('a subscriber gets the locked product as a full report, with no teasers', async () => {
      const app = build(true);
      const a = await signIn(app, 'a@example.com');
      const b = await signIn(app, 'b@example.com');
      await push(app, a, fillerReports('fa', mk(NYC)));
      await push(app, b, fillerReports('fb', mk(NYC)));
      await push(app, a, [mk(NYC)('o', 'Olipop')]);
      const sub = await signIn(app, 'sub@example.com');
      const id = (await json(await app.request('/api/me', { headers: { Authorization: `Bearer ${sub}` } }))).id as string;
      db.update(users).set({ plan: 'paid', planExpiresAt: new Date(Date.now() + 30 * 86400_000).toISOString() }).where(eq(users.id, id)).run();
      const body = await discover(app, sub, '?limit=20');
      expect(body.accessLevel).toBe('subscriber');
      expect(names(body)).toContain('Olipop');
      expect(body.locked).toEqual([]);
    });

    it('a signed-in user without a subscription is gated exactly like a device', async () => {
      const app = build(true);
      const a = await signIn(app, 'a@example.com');
      const b = await signIn(app, 'b@example.com');
      await push(app, a, fillerReports('fa', mk(NYC)));
      await push(app, b, fillerReports('fb', mk(NYC)));
      await push(app, a, [mk(NYC)('o', 'Olipop')]);
      const body = await discover(app, await signIn(app, 'free@example.com'), '?limit=20');
      expect(body.accessLevel).toBe('public');
      expect(names(body)).not.toContain('Olipop');
      expect(body.locked).toHaveLength(1);
    });
  });

  it('does not read more than the newest window of reports (cost is bounded by the window, not the database)', async () => {
    const app = build(false);
    const scanner = await signIn(app, 'scanner@example.com');
    await push(app, scanner, [mk(DFW)('old', 'Ancient Item')]);
    const old = sqlite.prepare("select user_id, product_id, store_id from price_reports where id = 'old'").get() as { user_id: string; product_id: string; store_id: string };
    sqlite.prepare("insert into products (id, canonical_name) values ('bulkp', 'Bulk')").run();
    const insert = sqlite.prepare(
      "insert into price_reports (id, user_id, product_id, store_id, item_name, price_cents, price_raw, observed_date, freshness_date, status, created_at, updated_at) values (?, ?, 'bulkp', ?, 'Bulk', 100, '1.00', '2026-10-21', '2026-10-21', 'active', ?, ?)",
    );
    const stamp = new Date().toISOString();
    sqlite.transaction(() => { for (let i = 0; i < 320; i++) insert.run(`b${i}`, old.user_id, old.store_id, stamp, stamp); })();
    const total = (sqlite.prepare('select count(*) as n from price_reports').get() as { n: number }).n;
    expect(total).toBeGreaterThan(300);
    expect(names(await discover(app, await device(app), '?limit=20'))).toEqual(['Bulk']); // the older product is beyond the window
    void priceReports;
  });
});
