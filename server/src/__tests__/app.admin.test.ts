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

describe('admin routes', () => {
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

  const json = (res: Response): Promise<Record<string, any>> => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

  it('answers 503 when no ADMIN_TOKEN is configured', async () => {
    const app = createApp({ db, corsOrigins: ['http://localhost:5173'], mailer }); // adminToken defaults to ''
    const res = await app.request('/api/admin/flags', { headers: { Authorization: 'Bearer anything' } });
    expect(res.status).toBe(503);
  });

  it('rejects a request with the wrong token', async () => {
    const app = createApp({ db, corsOrigins: ['http://localhost:5173'], mailer, adminToken: 'secret' });
    const res = await app.request('/api/admin/flags', { headers: { Authorization: 'Bearer wrong' } });
    expect(res.status).toBe(401);
  });

  it('rejects a request with no token at all', async () => {
    const app = createApp({ db, corsOrigins: ['http://localhost:5173'], mailer, adminToken: 'secret' });
    expect((await app.request('/api/admin/flags')).status).toBe(401);
  });

  it('lists flags, resolves one, merges products, and changes a user\'s status, all behind the token', async () => {
    const app = createApp({ db, corsOrigins: ['http://localhost:5173'], mailer, adminToken: 'secret' });
    const admin = { Authorization: 'Bearer secret' };

    const signIn = async (email: string) => {
      await app.request('/api/auth/request-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
      const res = await app.request('/api/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: mailer.lastCode() }) });
      return (await json(res)).sessionToken as string;
    };
    const push = async (token: string, id: string, overrides: Record<string, unknown> = {}) =>
      json(await app.request('/api/sync/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          reports: [{
            id, itemName: 'Milk', brand: '', tags: [], quantity: 1, quantityUnits: 'gallon', price: '3.49',
            store: 'Kroger @ 9150 North Tarrant Parkway', latitude: KROGER_LAT, longitude: KROGER_LON,
            observedDate: '2026-09-01', updatedAt: '2026-09-01T12:00:00.000Z', ...overrides,
          }],
        }),
      }));

    const author = await signIn('author@example.com');
    const authorPush = await push(author, 'r1');
    const productId = authorPush.results[0].productId;

    const flaggerA = await signIn('a@example.com');
    const flaggerB = await signIn('b@example.com');
    await app.request('/api/reports/r1/flag', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${flaggerA}` }, body: JSON.stringify({ reason: 'wrong_price' }) });
    await app.request('/api/reports/r1/flag', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${flaggerB}` }, body: JSON.stringify({ reason: 'wrong_price' }) });

    // List flags (weight from two fresh accounts is 1.0, below the hide threshold, but the flags are still open).
    const flags = await json(await app.request('/api/admin/flags', { headers: admin }));
    expect(flags.flags.length).toBeGreaterThanOrEqual(2);

    const flagId = flags.flags[0].flagId;
    const resolveRes = await app.request(`/api/admin/flags/${flagId}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...admin }, body: JSON.stringify({ resolution: 'dismissed' }) });
    expect(resolveRes.status).toBe(200);
    expect((await json(await app.request('/api/admin/flags?status=resolved', { headers: admin }))).flags.length).toBeGreaterThanOrEqual(1);

    // Merge: create a second, distinct product then fold it in.
    const second = await push(author, 'r2', { itemName: 'Something Totally Different', quantity: 1, quantityUnits: 'each' });
    const secondProductId = second.results[0].productId;
    expect(secondProductId).not.toBe(productId);
    const mergeRes = await app.request(`/api/admin/products/${secondProductId}/merge-into/${productId}`, { method: 'POST', headers: admin });
    expect(mergeRes.status).toBe(200);
    expect((await json(mergeRes)).targetId).toBe(productId);
  });

  it('bans and restricts a user via PATCH /api/admin/users/:id', async () => {
    const app = createApp({ db, corsOrigins: ['http://localhost:5173'], mailer, adminToken: 'secret' });
    const admin = { Authorization: 'Bearer secret' };
    const signIn = async (email: string) => {
      await app.request('/api/auth/request-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
      const res = await app.request('/api/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: mailer.lastCode() }) });
      return json(res);
    };
    const session = await signIn('user@example.com');
    const res = await app.request(`/api/admin/users/${session.userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...admin },
      body: JSON.stringify({ status: 'banned' }),
    });
    expect(res.status).toBe(200);

    // The banned user can no longer push.
    const pushRes = await app.request('/api/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.sessionToken}` },
      body: JSON.stringify({ reports: [] }),
    });
    expect(pushRes.status).toBe(403);
  });

  it('validates the resolution and status enums', async () => {
    const app = createApp({ db, corsOrigins: ['http://localhost:5173'], mailer, adminToken: 'secret' });
    const admin = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' };
    expect((await app.request('/api/admin/flags/nope/resolve', { method: 'POST', headers: admin, body: JSON.stringify({ resolution: 'maybe' }) })).status).toBe(400);
    expect((await app.request('/api/admin/users/nope', { method: 'PATCH', headers: admin, body: JSON.stringify({ status: 'super-banned' }) })).status).toBe(400);
  });

  it('404s resolving an unknown flag and merging an unknown product', async () => {
    const app = createApp({ db, corsOrigins: ['http://localhost:5173'], mailer, adminToken: 'secret' });
    const admin = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' };
    expect((await app.request('/api/admin/flags/nope/resolve', { method: 'POST', headers: admin, body: JSON.stringify({ resolution: 'upheld' }) })).status).toBe(404);
    expect((await app.request('/api/admin/products/nope/merge-into/also-nope', { method: 'POST', headers: { Authorization: 'Bearer secret' } })).status).toBe(404);
    expect((await app.request('/api/admin/users/nope', { method: 'PATCH', headers: admin, body: JSON.stringify({ status: 'banned' }) })).status).toBe(404);
  });

  it('recomputes trust for every user via the maintenance endpoint', async () => {
    const app = createApp({ db, corsOrigins: ['http://localhost:5173'], mailer, adminToken: 'secret' });
    const res = await app.request('/api/admin/trust/recompute', { method: 'POST', headers: { Authorization: 'Bearer secret' } });
    expect(res.status).toBe(200);
    expect((await json(res)).users).toBe(0);
  });
});
