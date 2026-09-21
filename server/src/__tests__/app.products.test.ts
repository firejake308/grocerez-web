import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { createApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import type { AppDb } from '../db/client.js';
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

describe('product routes', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;
  let mailer: FakeMailer;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
    mailer = new FakeMailer();
    app = createApp({ db, corsOrigins: ['http://localhost:5173'], mailer, adminToken: 'test-admin-token' });
  });

  afterEach(() => {
    sqlite.close();
  });

  const json = (res: Response): Promise<Record<string, any>> => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

  const signIn = async (email: string): Promise<string> => {
    await app.request('/api/auth/request-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    const res = await app.request('/api/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: mailer.lastCode() }) });
    return (await json(res)).sessionToken as string;
  };

  const push = async (token: string, reports: Record<string, unknown>[]) =>
    json(await app.request('/api/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ reports }),
    }));

  const stok = (overrides: Record<string, unknown> = {}) => ({
    itemName: 'Cold Brew Coffee', brand: 'Stok', tags: ['coffee', 'cold brew'], quantity: 48, quantityUnits: 'fluid ounce',
    price: '6.79', store: 'Kroger @ 9150 North Tarrant Parkway', latitude: KROGER_LAT, longitude: KROGER_LON,
    observedDate: '2026-09-01', updatedAt: '2026-09-01T12:00:00.000Z',
    ...overrides,
  });

  describe('GET /api/products/match', () => {
    it('suggests an existing product at save time (plan section 8.4)', async () => {
      const token = await signIn('a@example.com');
      await push(token, [{ id: 'r1', ...stok() }]);

      const q = new URLSearchParams({ itemName: 'Unsweetened Cold Brew Coffee', brand: 'Stok', tags: 'coffee,cold brew,drink', quantity: '48', quantityUnits: 'fluid ounce' });
      const res = await app.request(`/api/products/match?${q}`, { headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.candidates).toHaveLength(1);
      expect(body.candidates[0]).toMatchObject({ canonicalName: 'Cold Brew Coffee', decision: 'attach', storeCount: 1 });
    });

    it('returns no candidates for a genuinely new item', async () => {
      const token = await signIn('a@example.com');
      const q = new URLSearchParams({ itemName: 'Completely Unrelated Item Xyz' });
      const body = await json(await app.request(`/api/products/match?${q}`, { headers: { Authorization: `Bearer ${token}` } }));
      expect(body.candidates).toEqual([]);
    });

    it('works for an anonymous device, not just a signed-in user', async () => {
      const token = await signIn('a@example.com');
      await push(token, [{ id: 'r1', ...stok() }]);
      const deviceRes = await app.request('/api/devices/register', { method: 'POST' });
      const { deviceToken } = await json(deviceRes);
      const q = new URLSearchParams({ itemName: 'Cold Brew Coffee', brand: 'Stok', quantity: '48', quantityUnits: 'fluid ounce' });
      const res = await app.request(`/api/products/match?${q}`, { headers: { Authorization: `Bearer ${deviceToken}` } });
      expect(res.status).toBe(200);
    });

    it('requires itemName', async () => {
      const token = await signIn('a@example.com');
      const res = await app.request('/api/products/match?brand=Stok', { headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/products/:id/prices', () => {
    it('returns current price per store plus history, newest first', async () => {
      const token = await signIn('a@example.com');
      const first = await push(token, [{ id: 'r1', ...stok({ observedDate: '2026-09-01', price: '6.79' }) }]);
      await push(token, [{ id: 'r2', ...stok({ observedDate: '2026-09-10', price: '5.97', updatedAt: '2026-09-10T00:00:00.000Z' }) }]);
      const productId = first.results[0].productId;

      const res = await app.request(`/api/products/${productId}/prices`, { headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.product.canonicalName).toBe('Cold Brew Coffee');
      expect(body.current).toHaveLength(1);
      expect(body.current[0].priceCents).toBe(597); // newest wins
      expect(body.history).toHaveLength(2);
      expect(body.history[0].observedDate).toBe('2026-09-10'); // newest first
      expect(body.history[1].observedDate).toBe('2026-09-01');
    });

    it('includes myVote when the caller has voted on a history entry', async () => {
      const author = await signIn('author@example.com');
      const pushed = await push(author, [{ id: 'r1', ...stok() }]);
      const productId = pushed.results[0].productId;
      const voter = await signIn('voter@example.com');
      await app.request('/api/reports/r1/confirm', { method: 'POST', headers: { Authorization: `Bearer ${voter}` } });

      const body = await json(await app.request(`/api/products/${productId}/prices`, { headers: { Authorization: `Bearer ${voter}` } }));
      expect(body.history[0].myVote).toBe('confirm');
    });

    it('follows a merged product to its target', async () => {
      const token = await signIn('a@example.com');
      const pushed = await push(token, [{ id: 'r1', ...stok() }]);
      const sourceId = pushed.results[0].productId;
      const targetRes = await push(token, [{ id: 'r2', itemName: 'Something Else Entirely', brand: '', tags: [], quantity: 1, quantityUnits: 'each', price: '1.00', store: 'Kroger @ 9150 North Tarrant Parkway', latitude: KROGER_LAT, longitude: KROGER_LON, observedDate: '2026-09-01', updatedAt: '2026-09-01T12:00:01.000Z' }]);
      const targetId = targetRes.results[0].productId;

      await app.request(`/api/admin/products/${sourceId}/merge-into/${targetId}`, { method: 'POST', headers: { Authorization: 'Bearer test-admin-token' } });

      const res = await app.request(`/api/products/${sourceId}/prices`, { headers: { Authorization: `Bearer ${token}` } });
      const body = await json(res);
      expect(body.product.id).toBe(targetId);
    });

    it('404s on an unknown product', async () => {
      const token = await signIn('a@example.com');
      const res = await app.request('/api/products/nope/prices', { headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBe(404);
    });
  });
});
