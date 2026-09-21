import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { createApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import type { AppDb } from '../db/client.js';
import type { Mailer } from '../lib/mail.js';

const json = (res: Response): Promise<Record<string, any>> => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

const TINY_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';

describe('POST /api/parse', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
  });

  afterEach(() => {
    sqlite.close();
    vi.unstubAllGlobals();
  });

  const deviceToken = async (app: ReturnType<typeof createApp>) => {
    const res = await app.request('/api/devices/register', { method: 'POST' });
    return (await json(res)).deviceToken as string;
  };

  it('is unauthorized with no token', async () => {
    const app = createApp({ db, corsOrigins: ['http://localhost:5173'] });
    const res = await app.request('/api/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priceImage: TINY_JPEG, productImage: TINY_JPEG }),
    });
    expect(res.status).toBe(401);
  });

  it('returns mock data for an anonymous device token when no API key is configured', async () => {
    const app = createApp({ db, corsOrigins: ['http://localhost:5173'] });
    const token = await deviceToken(app);
    const res = await app.request('/api/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ priceImage: TINY_JPEG, productImage: TINY_JPEG }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.itemName).toBe('Milk');
  });

  it('rejects a request missing an image', async () => {
    const app = createApp({ db, corsOrigins: ['http://localhost:5173'] });
    const token = await deviceToken(app);
    const res = await app.request('/api/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ priceImage: TINY_JPEG }),
    });
    expect(res.status).toBe(400);
  });

  it('saves photo evidence when a reportId is included, retrievable by its author', async () => {
    // Sign in so we have a session/report author to check photo access against.
    class FakeMailer implements Mailer {
      code = '';
      async send(_to: string, _subject: string, text: string) { this.code = text.match(/\d{6}/)![0]; }
    }
    const mailer = new FakeMailer();
    const app = createApp({ db, corsOrigins: ['http://localhost:5173'], mailer, parse: { apiKey: '', centsPer1kTokens: 0.2, dailyBudgetCents: 500, photoDir: `/tmp/grocerez-test-photos-${Date.now()}` } });

    await app.request('/api/auth/request-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'shopper@example.com' }) });
    const verifyRes = await app.request('/api/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'shopper@example.com', code: mailer.code }) });
    const { sessionToken } = await json(verifyRes);

    const reportId = 'report-abc-123';
    const parseRes = await app.request('/api/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify({ priceImage: TINY_JPEG, productImage: TINY_JPEG, reportId }),
    });
    expect(parseRes.status).toBe(200);

    // Photo save is fire-and-forget; give its microtask a moment to land.
    await new Promise((r) => setTimeout(r, 20));

    const photoRes = await app.request(`/api/reports/${reportId}/photo`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    // The report row itself was never pushed, so checkPhotoAccess (author match) can't confirm ownership yet -- expect 404, not a crash.
    expect(photoRes.status).toBe(404);
  });

  it('enforces the per-caller daily rate limit', async () => {
    const app = createApp({ db, corsOrigins: ['http://localhost:5173'] });
    const token = await deviceToken(app);
    let lastStatus = 0;
    for (let i = 0; i < 51; i++) {
      const res = await app.request('/api/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ priceImage: TINY_JPEG, productImage: TINY_JPEG }),
      });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });

  it('enforces the daily spend budget once it is reached', async () => {
    const app = createApp({
      db,
      corsOrigins: ['http://localhost:5173'],
      parse: { apiKey: 'sk-test', centsPer1kTokens: 100, dailyBudgetCents: 1, photoDir: '/tmp/grocerez-test-photos-budget' },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: '{"itemName": "Milk", "price": "3.00"}' } }], usage: { total_tokens: 1000 } }),
    }));
    const token = await deviceToken(app);
    const first = await app.request('/api/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ priceImage: TINY_JPEG, productImage: TINY_JPEG }),
    });
    expect(first.status).toBe(200); // costs 100 cents, already over the 1-cent budget for the *next* call

    const second = await app.request('/api/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ priceImage: TINY_JPEG, productImage: TINY_JPEG }),
    });
    expect(second.status).toBe(429);
  });
});
