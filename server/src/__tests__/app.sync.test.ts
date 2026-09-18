import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { createApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import type { AppDb } from '../db/client.js';
import type { Mailer } from '../lib/mail.js';

class FakeMailer implements Mailer {
  sent: string[] = [];
  async send(_to: string, _subject: string, text: string): Promise<void> {
    this.sent.push(text);
  }
  lastCode(): string {
    return this.sent.at(-1)!.match(/\d{6}/)![0];
  }
}

// Kroger @ 9150 North Tarrant Parkway, from the real export.
const KROGER_LAT = 32.9019798;
const KROGER_LON = -97.1889734;

describe('sync push/pull', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;
  let mailer: FakeMailer;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
    mailer = new FakeMailer();
    app = createApp({ db, corsOrigins: ['http://localhost:5173'], mailer });
  });

  afterEach(() => {
    sqlite.close();
  });

  const json = (res: Response): Promise<Record<string, any>> => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

  const signIn = async (email: string): Promise<string> => {
    await app.request('/api/auth/request-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const res = await app.request('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code: mailer.lastCode() }),
    });
    return (await json(res)).sessionToken as string;
  };

  const push = (token: string, reports: unknown[]) =>
    app.request('/api/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ reports }),
    });

  const pull = (token: string, since = 0) =>
    app.request(`/api/sync/pull?since=${since}&lat=${KROGER_LAT}&lon=${KROGER_LON}&radiusMi=10`, {
      headers: { Authorization: `Bearer ${token}` },
    });

  it('the phone-A/phone-B deliverable: scan on one account, pull from another device', async () => {
    const scannerToken = await signIn('scanner@example.com');
    const pushRes = await push(scannerToken, [
      {
        id: 'report-1',
        itemName: 'Cold Brew Coffee',
        brand: 'Stok',
        tags: ['coffee', 'cold brew'],
        quantity: 48,
        quantityUnits: 'fluid ounce',
        price: '6.79',
        store: 'Kroger @ 9150 North Tarrant Parkway',
        latitude: KROGER_LAT,
        longitude: KROGER_LON,
        observedDate: '2026-09-01',
        updatedAt: '2026-09-01T12:00:00.000Z',
      },
    ]);
    expect(pushRes.status).toBe(200);
    const pushBody = await json(pushRes);
    expect(pushBody.results[0].status).toBe('active');
    expect(pushBody.results[0].productId).toBeTruthy();

    // A second, unregistered device (registered via device token, not
    // signed in) pulls near the same store and sees the price.
    const deviceRes = await app.request('/api/devices/register', { method: 'POST' });
    const { deviceToken } = await json(deviceRes);
    const pullRes = await pull(deviceToken);
    expect(pullRes.status).toBe(200);
    const pullBody = await json(pullRes);
    expect(pullBody.accessLevel).toBe('unrestricted');
    expect(pullBody.reports).toHaveLength(1);
    expect(pullBody.reports[0].itemName).toBe('Cold Brew Coffee');
    expect(pullBody.reports[0].priceCents).toBe(679);
    expect(pullBody.reports[0].storeName).toBe('Kroger');
    expect(pullBody.reports[0].authorTier).toBe('new');
  });

  it('excludes reports outside the requested radius', async () => {
    const token = await signIn('far@example.com');
    await push(token, [
      {
        id: 'far-report',
        itemName: 'Milk',
        brand: '',
        tags: [],
        quantity: 1,
        quantityUnits: 'gallon',
        price: '3.49',
        store: 'Some Store',
        latitude: 40.7128, // New York, far from Kroger's Tarrant Parkway location
        longitude: -74.006,
        observedDate: '2026-09-01',
        updatedAt: '2026-09-01T12:00:00.000Z',
      },
    ]);
    const pullBody = await json(await pull(token));
    expect(pullBody.reports).toHaveLength(0);
  });

  it('is idempotent by id: pushing the same report twice does not duplicate it', async () => {
    const token = await signIn('dup@example.com');
    const report = {
      id: 'dup-report',
      itemName: 'Bananas',
      brand: 'Dole',
      tags: ['fruit', 'produce'],
      quantity: 1,
      quantityUnits: 'lb',
      price: '0.54',
      store: 'Kroger @ 9150 North Tarrant Parkway',
      latitude: KROGER_LAT,
      longitude: KROGER_LON,
      observedDate: '2026-09-01',
      updatedAt: '2026-09-01T12:00:00.000Z',
    };
    await push(token, [report]);
    await push(token, [report]);
    const pullBody = await json(await pull(token));
    expect(pullBody.reports).toHaveLength(1);
  });

  it('rejects an edit to someone else\'s report', async () => {
    const author = await signIn('author@example.com');
    const other = await signIn('other@example.com');
    const report = {
      id: 'owned-report',
      itemName: 'Eggs',
      brand: 'Great Value',
      tags: ['eggs'],
      quantity: 12,
      quantityUnits: 'count',
      price: '1.47',
      store: 'Kroger @ 9150 North Tarrant Parkway',
      latitude: KROGER_LAT,
      longitude: KROGER_LON,
      observedDate: '2026-09-01',
      updatedAt: '2026-09-01T12:00:00.000Z',
    };
    await push(author, [report]);
    const res = await push(other, [{ ...report, price: '99.99', updatedAt: '2026-09-02T12:00:00.000Z' }]);
    const body = await json(res);
    expect(body.results[0].status).toBe('rejected');

    const pullBody = await json(await pull(author));
    expect(pullBody.reports[0].priceCents).toBe(147); // unchanged
  });

  it('lets a newer push from the same author update the price (last-writer-wins)', async () => {
    const token = await signIn('editor@example.com');
    const report = {
      id: 'editable-report',
      itemName: 'Eggs',
      brand: 'Great Value',
      tags: ['eggs'],
      quantity: 12,
      quantityUnits: 'count',
      price: '1.47',
      store: 'Kroger @ 9150 North Tarrant Parkway',
      latitude: KROGER_LAT,
      longitude: KROGER_LON,
      observedDate: '2026-09-01',
      updatedAt: '2026-09-01T12:00:00.000Z',
    };
    await push(token, [report]);
    await push(token, [{ ...report, price: '1.99', updatedAt: '2026-09-02T12:00:00.000Z' }]);
    const pullBody = await json(await pull(token));
    expect(pullBody.reports).toHaveLength(1);
    expect(pullBody.reports[0].priceCents).toBe(199);
  });

  it('soft-deletes a report, which pull reports as a tombstone rather than omitting it', async () => {
    const token = await signIn('deleter@example.com');
    const report = {
      id: 'deletable-report',
      itemName: 'Chips',
      brand: "Lay's",
      tags: ['chips'],
      quantity: 7.75,
      quantityUnits: 'ounce',
      price: '1.99',
      store: 'Kroger @ 9150 North Tarrant Parkway',
      latitude: KROGER_LAT,
      longitude: KROGER_LON,
      observedDate: '2026-09-01',
      updatedAt: '2026-09-01T12:00:00.000Z',
    };
    await push(token, [report]);
    await push(token, [{ ...report, deletedAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z' }]);
    // Plan section 7: pull includes deleted/hidden state changes rather
    // than omitting them, so an already-synced client can drop its own
    // cached copy. A brand-new client (this test's since=0) just sees a
    // status it should never render, which is harmless.
    const pullBody = await json(await pull(token));
    expect(pullBody.reports).toHaveLength(1);
    expect(pullBody.reports[0].status).toBe('deleted');
  });

  it('rejects a report with an unparseable price without failing the whole batch', async () => {
    const token = await signIn('badprice@example.com');
    const res = await push(token, [
      {
        id: 'good-report',
        itemName: 'Milk',
        brand: '',
        tags: [],
        quantity: 1,
        quantityUnits: 'gallon',
        price: '3.49',
        store: 'Kroger @ 9150 North Tarrant Parkway',
        latitude: KROGER_LAT,
        longitude: KROGER_LON,
        observedDate: '2026-09-01',
        updatedAt: '2026-09-01T12:00:00.000Z',
      },
      {
        id: 'bad-report',
        itemName: 'Gum',
        brand: '',
        tags: [],
        quantity: 1,
        quantityUnits: 'each',
        price: '$1 off',
        store: 'Kroger @ 9150 North Tarrant Parkway',
        latitude: KROGER_LAT,
        longitude: KROGER_LON,
        observedDate: '2026-09-01',
        updatedAt: '2026-09-01T12:00:00.000Z',
      },
    ]);
    const body = await json(res);
    expect(body.results[0].status).toBe('active');
    expect(body.results[1].status).toBe('rejected');
  });

  it('attaches a second, differently-worded report to the same product across two authors', async () => {
    const alice = await signIn('alice@example.com');
    const bob = await signIn('bob@example.com');
    await push(alice, [
      {
        id: 'alice-report',
        itemName: 'Cold Brew Coffee',
        brand: 'Stok',
        tags: ['coffee', 'cold brew'],
        quantity: 48,
        quantityUnits: 'fluid ounce',
        price: '6.79',
        store: 'Kroger @ 9150 North Tarrant Parkway',
        latitude: KROGER_LAT,
        longitude: KROGER_LON,
        observedDate: '2026-09-01',
        updatedAt: '2026-09-01T12:00:00.000Z',
      },
    ]);
    const bobRes = await push(bob, [
      {
        id: 'bob-report',
        itemName: 'Unsweetened Cold Brew Coffee',
        brand: 'Stok',
        tags: ['coffee', 'cold brew', 'drink'],
        quantity: 48,
        quantityUnits: 'fluid ounce',
        price: '5.97',
        store: 'Kroger @ 9150 North Tarrant Parkway',
        latitude: KROGER_LAT,
        longitude: KROGER_LON,
        observedDate: '2026-09-02',
        updatedAt: '2026-09-02T12:00:00.000Z',
      },
    ]);
    const bobBody = await json(bobRes);
    const pullBody = await json(await pull(alice));
    expect(pullBody.reports).toHaveLength(2);
    const productIds = new Set(pullBody.reports.map((r: { productId: string }) => r.productId));
    expect(productIds.size).toBe(1);
    expect(bobBody.results[0].productId).toBe([...productIds][0]);
  });

  it('requires sign-in to push but allows a device token to pull', async () => {
    const noAuth = await app.request('/api/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reports: [] }),
    });
    expect(noAuth.status).toBe(401);

    const deviceRes = await app.request('/api/devices/register', { method: 'POST' });
    const { deviceToken } = await json(deviceRes);
    const devicePush = await push(deviceToken, []);
    expect(devicePush.status).toBe(401);

    const devicePull = await pull(deviceToken);
    expect(devicePull.status).toBe(200);
  });
});
