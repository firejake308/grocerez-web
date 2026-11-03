import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { createApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import type { AppDb } from '../db/client.js';
import type { Mailer } from '../lib/mail.js';
import { productSearchCounts } from '../db/schema.js';
import { computeFreeTierForAllRegions } from '../services/entitlements.js';
import { LIMITS } from '../services/rateLimit.js';
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

describe('GET /api/search', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;
  let mailer: FakeMailer;

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
    mailer = new FakeMailer();
  });
  afterEach(() => sqlite.close());

  const build = (entitlementsEnforced: boolean) => createApp({ db, corsOrigins: [], mailer, entitlementsEnforced });
  type App = ReturnType<typeof createApp>;

  const signIn = async (app: App, email: string): Promise<string> => {
    await app.request('/api/auth/request-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    const res = await app.request('/api/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: mailer.lastCode() }) });
    return (await json(res)).sessionToken as string;
  };
  const device = async (app: App): Promise<string> => (await json(await app.request('/api/devices/register', { method: 'POST' }))).deviceToken as string;
  const mk = (where: typeof DFW) => (id: string, itemName: string, extra: Record<string, unknown> = {}) => ({
    id, itemName, brand: '', tags: [], quantity: 1, quantityUnits: 'each', price: '4.99',
    store: where.store, latitude: where.lat, longitude: where.lon, observedDate: '2026-10-20', updatedAt: '2026-10-20T00:00:00.000Z', ...extra,
  });
  const push = (app: App, token: string, reports: unknown[]) =>
    app.request('/api/sync/push', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ reports }) });
  const search = async (app: App, token: string, query: string) =>
    json(await app.request(`/api/search${query}`, { headers: { Authorization: `Bearer ${token}` } }));
  const names = (body: Record<string, any>) => (body.reports as { itemName: string }[]).map((r) => r.itemName).sort(); // eslint-disable-line @typescript-eslint/no-explicit-any

  it('requires a token and a query', async () => {
    const app = build(false);
    expect((await app.request('/api/search?q=milk')).status).toBe(401);
    const token = await device(app);
    expect((await app.request('/api/search', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(400);
    expect((await app.request('/api/search?q=%20%21', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(400);
  });

  it('returns every match, not a capped sample, newest report per product and store', async () => {
    const app = build(false);
    const scanner = await signIn(app, 'scanner@example.com');
    const reports = [];
    for (let i = 0; i < 40; i++) reports.push(mk(DFW)(`b${i}`, `Bananas variety ${i}`));
    reports.push(mk(DFW)('old', 'Milk', { price: '3.00', observedDate: '2026-10-01' }), mk(DFW)('new', 'Milk', { price: '3.50', observedDate: '2026-10-20' }), mk(DFW)('x', 'Bread'));
    await push(app, scanner, reports);

    const body = await search(app, await device(app), '?q=banana');
    expect(body.accessLevel).toBe('unrestricted');
    expect(body.reports).toHaveLength(40);
    expect(body.truncated).toBe(false);
    expect(body.locked).toEqual([]);

    const milk = await search(app, await device(app), '?q=milk');
    expect(milk.reports).toHaveLength(1);
    expect(milk.reports[0].priceCents).toBe(350);
  });

  it('matches brand and tags and uses prefix matching like the client search', async () => {
    const app = build(false);
    const scanner = await signIn(app, 'scanner@example.com');
    await push(app, scanner, [mk(DFW)('a', 'Large Eggs', { brand: 'Vital Farms' }), mk(DFW)('b', 'Oat Drink', { tags: ['dairy-free'] }), mk(DFW)('c', 'Egg Noodles')]);
    const token = await device(app);
    expect(names(await search(app, token, '?q=egg'))).toEqual(['Egg Noodles', 'Large Eggs']);
    expect(names(await search(app, token, '?q=eggs'))).toEqual(['Egg Noodles', 'Large Eggs']);
    expect(names(await search(app, token, '?q=vital'))).toEqual(['Large Eggs']);
    expect(names(await search(app, token, '?q=dairy'))).toEqual(['Oat Drink']);
    expect(names(await search(app, token, '?q=large+egg'))).toEqual(['Large Eggs']);
  });

  it('filters to a radius when lat and lon are given, and spans everywhere when they are not', async () => {
    const app = build(false);
    const scanner = await signIn(app, 'scanner@example.com');
    await push(app, scanner, [mk(DFW)('a', 'Milk'), mk(NYC)('b', 'Milk')]);
    const token = await device(app);
    expect((await search(app, token, '?q=milk')).reports).toHaveLength(2);
    const near = await search(app, token, `?q=milk&lat=${DFW.lat}&lon=${DFW.lon}`);
    expect(near.reports).toHaveLength(1);
    expect(near.reports[0].storeName).toBe('Kroger');
  });

  describe('enforcement on', () => {
    // Two reporters fill the free set with 25 fruit; a lone report of Milk then falls outside it.
    const seed = async (app: App) => {
      const a = await signIn(app, 'a@example.com');
      const b = await signIn(app, 'b@example.com');
      await push(app, a, [...fillerReports('a', mk(DFW)), mk(DFW)('milk', 'Milk'), mk(DFW)('eggs', 'Eggs')]);
      await push(app, b, fillerReports('b', mk(DFW)));
      computeFreeTierForAllRegions(db);
    };

    it('gives a free caller full reports for free-set products and price-less teasers for the rest, with or without a ZIP', async () => {
      const app = build(true);
      await seed(app);
      const token = await device(app);
      // A different locked product per variant: each search counts, and a counted search can promote its product on the next refresh.
      for (const [product, q] of [['milk', ''], ['eggs', `&lat=${DFW.lat}&lon=${DFW.lon}`]]) {
        const fruit = await search(app, token, `?q=apple${q}`);
        expect(fruit.accessLevel).toBe('public');
        expect(names(fruit)).toEqual(['apple']);
        expect(fruit.locked).toEqual([]);

        const locked = await search(app, token, `?q=${product}${q}`);
        expect(locked.reports).toEqual([]);
        expect(locked.locked).toHaveLength(1);
        expect(locked.locked[0]).toMatchObject({ canonicalName: product === 'milk' ? 'Milk' : 'Eggs', storeCount: 1 });
        expect(JSON.stringify(locked)).not.toContain('priceCents');
      }
    });

    it('a ZIP never locks what the same caller saw without one (free set is global)', async () => {
      const app = build(true);
      const a = await signIn(app, 'a@example.com');
      const b = await signIn(app, 'b@example.com');
      // NYC has fewer than 25 products, so everything there is free; DFW fills its own set so its Milk is locked.
      await push(app, a, [...fillerReports('a', mk(DFW)), mk(DFW)('milk-dfw', 'Milk'), mk(NYC)('milk-nyc', 'Milk')]);
      await push(app, b, fillerReports('b', mk(DFW)));
      computeFreeTierForAllRegions(db);

      const token = await device(app);
      const anywhere = await search(app, token, '?q=milk');
      const dfw = await search(app, token, `?q=milk&lat=${DFW.lat}&lon=${DFW.lon}`);
      // Milk is in NYC's free set, so it is free everywhere, including at the Dallas store.
      expect(anywhere.reports).toHaveLength(2);
      expect(dfw.reports).toHaveLength(1);
      expect(dfw.locked).toEqual([]);
    });

    it('gives a subscriber everything with no teasers', async () => {
      const app = build(true);
      await seed(app);
      const subscriber = await signIn(app, 'sub@example.com');
      sqlite.prepare("update users set plan = 'paid', plan_expires_at = '2099-01-01T00:00:00.000Z' where email = 'sub@example.com'").run();
      const body = await search(app, subscriber, '?q=milk');
      expect(body.accessLevel).toBe('subscriber');
      expect(names(body)).toEqual(['Milk']);
      expect(body.locked).toEqual([]);
    });
  });

  describe('search counting', () => {
    it('adds one per matched product per search, bucketed by location, and nothing for a search with no matches', async () => {
      const app = build(false);
      const scanner = await signIn(app, 'scanner@example.com');
      await push(app, scanner, [mk(DFW)('a', 'Milk'), mk(DFW)('b', 'Milk 2%'), mk(NYC)('c', 'Eggs')]);
      const token = await device(app);
      await search(app, token, '?q=milk');
      await search(app, token, `?q=milk&lat=${DFW.lat}&lon=${DFW.lon}`);
      await search(app, token, '?q=nothingmatchesthis');

      const rows = db.select().from(productSearchCounts).all();
      const total = rows.reduce((n, r) => n + r.count, 0);
      expect(total).toBe(4); // 2 milk products x 2 searches
      expect(rows.filter((r) => r.located)).toHaveLength(2);
      expect(rows.filter((r) => r.located)[0]).toMatchObject({ cellLat: 32.9, cellLon: -97.2 });
      expect(rows.filter((r) => !r.located)[0]).toMatchObject({ cellLat: 0, cellLon: 0 });
    });

    it('counts locked products too, and stops counting (but still answers) past the hourly cap', async () => {
      const app = build(true);
      const a = await signIn(app, 'a@example.com');
      const b = await signIn(app, 'b@example.com');
      await push(app, a, [...fillerReports('a', mk(DFW)), mk(DFW)('milk', 'Milk')]);
      await push(app, b, fillerReports('b', mk(DFW)));
      computeFreeTierForAllRegions(db);

      const token = await device(app);
      for (let i = 0; i < LIMITS.searchCountedPerCallerHour + 5; i++) {
        const body = await search(app, token, '?q=milk');
        expect(body.locked).toHaveLength(1);
      }
      const rows = db.select().from(productSearchCounts).all();
      expect(rows.reduce((n, r) => n + r.count, 0)).toBe(LIMITS.searchCountedPerCallerHour);
    });

    it('promotes a searched product only when the daily snapshot refreshes, not on the searches themselves', async () => {
      let clock = Date.now();
      const now = () => new Date(clock);
      const app = createApp({ db, corsOrigins: [], mailer, entitlementsEnforced: true, now });
      const a = await signIn(app, 'a@example.com');
      const b = await signIn(app, 'b@example.com');
      await push(app, a, [...fillerReports('a', mk(DFW)), mk(DFW)('milk', 'Milk')]);
      await push(app, b, fillerReports('b', mk(DFW)));
      computeFreeTierForAllRegions(db, 50, now);

      const token = await device(app);
      const here = `?q=milk&lat=${DFW.lat}&lon=${DFW.lon}`;
      for (let i = 0; i < 10; i++) expect((await search(app, token, here)).locked).toHaveLength(1);
      clock += 23 * 60 * 60 * 1000;
      expect((await search(app, token, here)).locked).toHaveLength(1); // still the old snapshot

      clock += 2 * 60 * 60 * 1000;
      await search(app, token, here); // past a day: this request refreshes the region...
      expect(names(await search(app, token, here))).toEqual(['Milk']); // ...and Milk, the only searched product, is now free
    });

    it('lets searching promote a locked product into the free set', async () => {
      const app = build(true);
      const a = await signIn(app, 'a@example.com');
      const b = await signIn(app, 'b@example.com');
      await push(app, a, [...fillerReports('a', mk(DFW)), mk(DFW)('milk', 'Milk')]);
      await push(app, b, fillerReports('b', mk(DFW)));
      computeFreeTierForAllRegions(db);

      const token = await device(app);
      expect((await search(app, token, '?q=milk')).locked).toHaveLength(1);
      computeFreeTierForAllRegions(db); // the search above counted; milk now outranks a tied filler
      expect(names(await search(app, token, '?q=milk'))).toEqual(['Milk']);
    });
  });
});
