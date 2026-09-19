import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { createApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import type { AppDb } from '../db/client.js';
import { users } from '../db/schema.js';
import type { Mailer } from '../lib/mail.js';

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

describe('sync push: Phase 2 ingest checks', () => {
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

  const signIn = async (email: string): Promise<{ sessionToken: string; userId: string }> => {
    await app.request('/api/auth/request-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    const res = await app.request('/api/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: mailer.lastCode() }) });
    return json(res) as Promise<{ sessionToken: string; userId: string }>;
  };

  const push = (token: string, reports: Record<string, unknown>[]) =>
    app.request('/api/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ reports }),
    });

  const milk = (overrides: Record<string, unknown> = {}) => ({
    itemName: 'Milk', brand: 'Kroger', tags: [], quantity: 1, quantityUnits: 'gallon', price: '3.49',
    store: 'Kroger @ 9150 North Tarrant Parkway', latitude: KROGER_LAT, longitude: KROGER_LON,
    observedDate: '2026-09-01', updatedAt: '2026-09-01T12:00:00.000Z',
    ...overrides,
  });

  it('rejects a price above the $10,000 sanity limit', async () => {
    const { sessionToken } = await signIn('a@example.com');
    const res = await push(sessionToken, [{ id: 'r1', ...milk({ price: '10001' }) }]);
    const body = await json(res);
    expect(body.results[0].status).toBe('rejected');
  });

  it('flags a price far below the product median as an outlier hint, without rejecting it', async () => {
    const { sessionToken } = await signIn('a@example.com');
    // Distinct observedDates so these seed as 3 separate reports rather than
    // collapsing into one (duplicate collapse is keyed on same-day scans).
    for (let i = 0; i < 3; i++) {
      await push(sessionToken, [{ id: `base-${i}`, ...milk({ price: '3.49', observedDate: `2026-09-0${i + 1}`, updatedAt: `2026-09-0${i + 1}T00:00:00.000Z` }) }]);
    }
    const res = await push(sessionToken, [{ id: 'sale', ...milk({ price: '0.50', observedDate: '2026-09-05', updatedAt: '2026-09-05T00:00:00.000Z' }) }]);
    const body = await json(res);
    expect(body.results[0].status).toBe('active');
    expect(body.results[0].reviewReason).toBe('price_outlier');
  });

  it('collapses a second same-day scan of the same product and store into the first report', async () => {
    const { sessionToken } = await signIn('a@example.com');
    await push(sessionToken, [{ id: 'r1', ...milk({ price: '3.49' }) }]);
    const res = await push(sessionToken, [{ id: 'r2', ...milk({ price: '3.29', updatedAt: '2026-09-01T14:00:00.000Z' }) }]);
    const body = await json(res);
    expect(body.results[0].collapsedInto).toBe('r1');
    expect(body.results[0].status).toBe('active');

    const pull = await json(await app.request(`/api/sync/pull?since=0&lat=${KROGER_LAT}&lon=${KROGER_LON}&radiusMi=10`, { headers: { Authorization: `Bearer ${sessionToken}` } }));
    expect(pull.reports).toHaveLength(1); // r2 never became a second row
    expect(pull.reports[0].priceCents).toBe(329);
  });

  it('does not collapse two different-day scans', async () => {
    const { sessionToken } = await signIn('a@example.com');
    await push(sessionToken, [{ id: 'r1', ...milk({ price: '3.49', observedDate: '2026-09-01' }) }]);
    await push(sessionToken, [{ id: 'r2', ...milk({ price: '3.29', observedDate: '2026-09-02', updatedAt: '2026-09-02T00:00:00.000Z' }) }]);
    const pull = await json(await app.request(`/api/sync/pull?since=0&lat=${KROGER_LAT}&lon=${KROGER_LON}&radiusMi=10`, { headers: { Authorization: `Bearer ${sessionToken}` } }));
    expect(pull.reports).toHaveLength(2);
  });

  it('holds a restricted user\'s new reports as hidden with new_user, and they release after 2 confirmations', async () => {
    const author = await signIn('restricted@example.com');
    db.update(users).set({ status: 'restricted' }).where(eq(users.id, author.userId)).run();

    const res = await push(author.sessionToken, [{ id: 'r1', ...milk() }]);
    const body = await json(res);
    expect(body.results[0].status).toBe('hidden');
    expect(body.results[0].reviewReason).toBe('new_user');

    const voterA = await signIn('va@example.com');
    const voterB = await signIn('vb@example.com');
    await app.request('/api/reports/r1/confirm', { method: 'POST', headers: { Authorization: `Bearer ${voterA.sessionToken}` } });
    await app.request('/api/reports/r1/confirm', { method: 'POST', headers: { Authorization: `Bearer ${voterB.sessionToken}` } });

    const pull = await json(await app.request(`/api/sync/pull?since=0&lat=${KROGER_LAT}&lon=${KROGER_LON}&radiusMi=10`, { headers: { Authorization: `Bearer ${author.sessionToken}` } }));
    expect(pull.reports[0].status).toBe('active');
  });

  it('a banned user cannot push at all', async () => {
    const author = await signIn('banned@example.com');
    db.update(users).set({ status: 'banned' }).where(eq(users.id, author.userId)).run();
    const res = await push(author.sessionToken, [{ id: 'r1', ...milk() }]);
    expect(res.status).toBe(403);
  });

  it('rejects new reports once the per-user hourly limit is hit, without touching existing reports', async () => {
    const { sessionToken } = await signIn('busy@example.com');
    for (let i = 0; i < 60; i++) {
      const res = await push(sessionToken, [{ id: `r${i}`, ...milk({ price: '3.49', updatedAt: `2026-09-01T00:00:${String(i).padStart(2, '0')}.000Z` }) }]);
      expect((await json(res)).results[0].status).toBe('active');
    }
    const overLimit = await push(sessionToken, [{ id: 'r-over', ...milk({ price: '3.49', updatedAt: '2026-09-01T00:01:00.000Z' }) }]);
    expect((await json(overLimit)).results[0].status).toBe('rejected');

    // Re-pushing an existing id (an edit) is not rate-limited.
    const edit = await push(sessionToken, [{ id: 'r0', ...milk({ price: '2.99', updatedAt: '2026-09-01T00:02:00.000Z' }) }]);
    expect((await json(edit)).results[0].status).toBe('active');
  }, 15_000);

  it('attaches directly to a product the client confirmed at save time, bypassing the matcher', async () => {
    const { sessionToken } = await signIn('a@example.com');
    const first = await json(await push(sessionToken, [{ id: 'r1', ...milk({ itemName: 'Cold Brew Coffee', brand: 'Stok', quantity: 48, quantityUnits: 'fluid ounce', price: '6.79' }) }]));
    const productId = first.results[0].productId;

    // A totally different-looking name that would NOT match the matcher on its own,
    // but the client confirmed it via the section 8.4 prompt.
    const second = await json(await push(sessionToken, [{ id: 'r2', ...milk({ itemName: 'zzz not related at all', brand: '', quantity: 1, quantityUnits: 'each', price: '9.99', productId, updatedAt: '2026-09-02T00:00:00.000Z' }) }]));
    expect(second.results[0].productId).toBe(productId);
  });
});
