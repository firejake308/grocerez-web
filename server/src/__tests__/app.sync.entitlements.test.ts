import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { createApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import type { AppDb } from '../db/client.js';
import type { Mailer } from '../lib/mail.js';
import { users } from '../db/schema.js';
import { computeFreeTier } from '../services/entitlements.js';
import { fillerReports } from './helpers/freeSet.js';

const json = (res: Response): Promise<Record<string, any>> => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

const KROGER_LAT = 32.9019798;
const KROGER_LON = -97.1889734;

class FakeMailer implements Mailer {
  sent: string[] = [];
  async send(_to: string, _subject: string, text: string): Promise<void> {
    this.sent.push(text);
  }
  lastCode(): string {
    return this.sent.at(-1)!.match(/\d{6}/)![0];
  }
}

/** A movable clock, so the free-set refresh throttle can be stepped past without sleeping. */
const clock = {
  t: Date.now(),
  now: () => new Date(clock.t),
  advance: (ms: number) => { clock.t += ms; },
  reset: () => { clock.t = Date.now(); },
};

describe('pull with ENTITLEMENTS_ENFORCED on', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;
  let mailer: FakeMailer;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
    mailer = new FakeMailer();
    clock.reset();
    app = createApp({ db, corsOrigins: ['http://localhost:5173'], mailer, entitlementsEnforced: true, now: clock.now });
  });

  afterEach(() => {
    sqlite.close();
  });

  const signIn = async (email: string): Promise<string> => {
    await app.request('/api/auth/request-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    const res = await app.request('/api/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: mailer.lastCode() }) });
    return (await json(res)).sessionToken as string;
  };

  const report = (id: string, itemName: string, overrides: Record<string, unknown> = {}) => ({
    id, itemName, brand: '', tags: [], quantity: 1, quantityUnits: 'each',
    price: '4.99', store: 'Kroger @ 9150 North Tarrant Parkway', latitude: KROGER_LAT, longitude: KROGER_LON,
    observedDate: '2026-06-01', updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  });

  /** 25 distinct products, each reported by two users, so the region's free set is full and a product reported once ranks below it. */
  const fillFreeSet = async (tokens: string[]) => {
    for (const [i, token] of tokens.entries()) {
      await app.request('/api/sync/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ reports: fillerReports(`filler-${i}`, report) }),
      });
    }
  };

  it('shows a locked summary instead of the price for a public caller, for a product outside the free set', async () => {
    const scannerToken = await signIn('scanner@example.com');
    const otherToken = await signIn('other@example.com');
    await fillFreeSet([scannerToken, otherToken]);
    const pushRes = await app.request('/api/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${scannerToken}` },
      body: JSON.stringify({ reports: [report('r1', 'Olipop')] }),
    });
    expect(pushRes.status).toBe(200);

    const deviceRes = await app.request('/api/devices/register', { method: 'POST' });
    const { deviceToken } = await json(deviceRes);
    const pullRes = await app.request(`/api/sync/pull?since=0&lat=${KROGER_LAT}&lon=${KROGER_LON}&radiusMi=10`, { headers: { Authorization: `Bearer ${deviceToken}` } });
    const body = await json(pullRes);

    expect(body.accessLevel).toBe('public');
    expect(body.reports.map((r: { itemName: string }) => r.itemName)).not.toContain('Olipop');
    expect(body.locked).toHaveLength(1);
    expect(body.locked[0].canonicalName).toBe('Olipop');
    expect(body.locked[0].storeCount).toBe(1);
  });

  it('shows the full report once its product is in the region\'s free set', async () => {
    const scannerToken = await signIn('scanner@example.com');
    await app.request('/api/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${scannerToken}` },
      body: JSON.stringify({ reports: [report('r1', 'Milk')] }),
    });
    computeFreeTier(db, KROGER_LAT, KROGER_LON, 10);

    const deviceRes = await app.request('/api/devices/register', { method: 'POST' });
    const { deviceToken } = await json(deviceRes);
    const pullRes = await app.request(`/api/sync/pull?since=0&lat=${KROGER_LAT}&lon=${KROGER_LON}&radiusMi=10`, { headers: { Authorization: `Bearer ${deviceToken}` } });
    const body = await json(pullRes);

    expect(body.accessLevel).toBe('public');
    expect(body.reports).toHaveLength(1);
    expect(body.reports[0].itemName).toBe('Milk');
    expect(body.locked).toHaveLength(0);
  });

  describe('a young region (fewer than 25 products)', () => {
    const publicPull = async (since = 0) => {
      const { deviceToken } = await json(await app.request('/api/devices/register', { method: 'POST' }));
      return json(await app.request(`/api/sync/pull?since=${since}&lat=${KROGER_LAT}&lon=${KROGER_LON}&radiusMi=10`, { headers: { Authorization: `Bearer ${deviceToken}` } }));
    };

    it('shows a brand-new product to a public caller straight away, without waiting for the periodic free-tier job', async () => {
      const scannerToken = await signIn('scanner@example.com');
      await app.request('/api/sync/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${scannerToken}` },
        body: JSON.stringify({ reports: [report('r1', 'Milk')] }),
      });
      // computeFreeTier is deliberately NOT called here: the timer has not run since this report was pushed.
      const body = await publicPull();
      expect(body.accessLevel).toBe('public');
      expect(body.reports.map((r: { itemName: string }) => r.itemName)).toEqual(['Milk']);
      expect(body.locked).toHaveLength(0);
    });

    it('reports a free-set fingerprint to public callers that changes when a product enters the set, and is null otherwise', async () => {
      const scannerToken = await signIn('scanner@example.com');
      const push = (reports: unknown[]) =>
        app.request('/api/sync/push', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${scannerToken}` }, body: JSON.stringify({ reports }) });
      await push([report('r1', 'Milk')]);
      const first = await publicPull();
      expect(typeof first.freeSet).toBe('string');
      expect(await publicPull()).toMatchObject({ freeSet: first.freeSet }); // stable while nothing changes

      clock.advance(2 * 60 * 1000); // past the refresh throttle
      await push([report('r2', 'Eggs')]);
      const second = await publicPull();
      expect(second.freeSet).not.toBe(first.freeSet);

      const subscriberToken = await signIn('sub@example.com');
      const subscriberId = (await json(await app.request('/api/me', { headers: { Authorization: `Bearer ${subscriberToken}` } }))).id as string;
      db.update(users).set({ plan: 'paid', planExpiresAt: new Date(clock.now().getTime() + 30 * 86400_000).toISOString() }).where(eq(users.id, subscriberId)).run();
      const paid = await json(await app.request(`/api/sync/pull?since=0&lat=${KROGER_LAT}&lon=${KROGER_LON}&radiusMi=10`, { headers: { Authorization: `Bearer ${subscriberToken}` } }));
      expect(paid.freeSet).toBeNull();
    });

    it('does not rescan on every pull: the free set is refreshed at most once a minute per region', async () => {
      const scannerToken = await signIn('scanner@example.com');
      const push = (name: string, id: string) =>
        app.request('/api/sync/push', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${scannerToken}` }, body: JSON.stringify({ reports: [report(id, name)] }) });
      await push('Milk', 'r1');
      await publicPull();
      await push('Eggs', 'r2');
      const within = await publicPull(); // still inside the throttle window: Eggs is not yet in the free set
      expect(within.locked.map((l: { canonicalName: string }) => l.canonicalName)).toContain('Eggs');
      clock.advance(61_000);
      const after = await publicPull();
      expect(after.reports.map((r: { itemName: string }) => r.itemName)).toContain('Eggs');
    });
  });

  it('an active subscriber sees everything, locked list stays empty', async () => {
    const scannerToken = await signIn('scanner@example.com');
    await app.request('/api/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${scannerToken}` },
      body: JSON.stringify({ reports: [report('r1', 'Olipop')] }),
    });

    const subscriberToken = await signIn('subscriber@example.com');
    const subscriberRes = await app.request('/api/me', { headers: { Authorization: `Bearer ${subscriberToken}` } });
    const subscriberId = (await json(subscriberRes)).id as string;
    db.update(users).set({ plan: 'paid', planExpiresAt: '2099-01-01T00:00:00.000Z' }).where(eq(users.id, subscriberId)).run();

    const pullRes = await app.request(`/api/sync/pull?since=0&lat=${KROGER_LAT}&lon=${KROGER_LON}&radiusMi=10`, { headers: { Authorization: `Bearer ${subscriberToken}` } });
    const body = await json(pullRes);

    expect(body.accessLevel).toBe('subscriber');
    expect(body.reports).toHaveLength(1);
    expect(body.locked).toHaveLength(0);
  });
});

describe('pull with ENTITLEMENTS_ENFORCED off (default)', () => {
  it('always reports unrestricted and never locks anything', async () => {
    const { db, sqlite } = runMigrations(':memory:');
    const mailer = new FakeMailer();
    const app = createApp({ db, corsOrigins: ['http://localhost:5173'], mailer });

    await app.request('/api/auth/request-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'scanner@example.com' }) });
    const verifyRes = await app.request('/api/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'scanner@example.com', code: mailer.lastCode() }) });
    const { sessionToken } = await json(verifyRes);
    await app.request('/api/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify({ reports: [{
        id: 'r1', itemName: 'Olipop', brand: '', tags: [], quantity: 1, quantityUnits: 'each',
        price: '4.99', store: 'Kroger @ 9150 North Tarrant Parkway', latitude: KROGER_LAT, longitude: KROGER_LON,
        observedDate: '2026-06-01', updatedAt: '2026-06-01T00:00:00.000Z',
      }] }),
    });

    const deviceRes = await app.request('/api/devices/register', { method: 'POST' });
    const { deviceToken } = await json(deviceRes);
    const pullRes = await app.request(`/api/sync/pull?since=0&lat=${KROGER_LAT}&lon=${KROGER_LON}&radiusMi=10`, { headers: { Authorization: `Bearer ${deviceToken}` } });
    const body = await json(pullRes);

    expect(body.accessLevel).toBe('unrestricted');
    expect(body.reports).toHaveLength(1);
    expect(body.locked).toHaveLength(0);
    sqlite.close();
  });
});
