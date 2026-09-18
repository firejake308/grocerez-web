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

describe('auth, device, and me routes', () => {
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

  const post = (path: string, body?: unknown, token?: string) =>
    app.request(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  /** Response.json() types as unknown; tests only need a loosely-typed bag of fields. */
  const json = (res: Response): Promise<Record<string, any>> => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

  it('signs a user in end to end: request code, verify, call /api/me', async () => {
    const requestRes = await post('/api/auth/request-code', { email: 'shopper@example.com' });
    expect(requestRes.status).toBe(200);

    const verifyRes = await post('/api/auth/verify', { email: 'shopper@example.com', code: mailer.lastCode() });
    expect(verifyRes.status).toBe(200);
    const { sessionToken } = await json(verifyRes);

    const meRes = await app.request('/api/me', { headers: { Authorization: `Bearer ${sessionToken}` } });
    expect(meRes.status).toBe(200);
    const me = await json(meRes);
    expect(me.email).toBe('shopper@example.com');
    expect(me.tier).toBe('new');
    expect(me.entitlement).toEqual({ enforced: false, plan: 'free', planExpiresAt: null });
  });

  it('rejects a malformed email or code before touching the database', async () => {
    const res1 = await post('/api/auth/request-code', { email: 'not-an-email' });
    expect(res1.status).toBe(400);

    const res2 = await post('/api/auth/verify', { email: 'x@example.com', code: 'abc' });
    expect(res2.status).toBe(400);
  });

  it('rejects a wrong code with 401 and an expired-attempts lockout with 429', async () => {
    await post('/api/auth/request-code', { email: 'y@example.com' });
    const wrong = mailer.lastCode() === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      const res = await post('/api/auth/verify', { email: 'y@example.com', code: wrong });
      expect(res.status).toBe(401);
    }
    const lockedRes = await post('/api/auth/verify', { email: 'y@example.com', code: wrong });
    expect(lockedRes.status).toBe(429);
  });

  it('requires sign-in for /api/me, and a device token alone is not enough', async () => {
    const noAuth = await app.request('/api/me');
    expect(noAuth.status).toBe(401);

    const deviceRes = await post('/api/devices/register');
    const { deviceToken } = await json(deviceRes);
    const withDevice = await app.request('/api/me', { headers: { Authorization: `Bearer ${deviceToken}` } });
    expect(withDevice.status).toBe(401);
  });

  it('lets PATCH /api/me update the display name and home location', async () => {
    await post('/api/auth/request-code', { email: 'z@example.com' });
    const { sessionToken } = await json(
      await post('/api/auth/verify', { email: 'z@example.com', code: mailer.lastCode() }),
    );

    const patchRes = await app.request('/api/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify({ displayName: 'Sean', homeLat: 32.9, homeLon: -97.1 }),
    });
    expect(patchRes.status).toBe(200);
    const me = await json(patchRes);
    expect(me.displayName).toBe('Sean');
    expect(me.homeLat).toBe(32.9);
  });

  it('signs out and invalidates the session token', async () => {
    await post('/api/auth/request-code', { email: 'w@example.com' });
    const { sessionToken } = await json(
      await post('/api/auth/verify', { email: 'w@example.com', code: mailer.lastCode() }),
    );

    const signoutRes = await post('/api/auth/signout', undefined, sessionToken);
    expect(signoutRes.status).toBe(200);

    const meRes = await app.request('/api/me', { headers: { Authorization: `Bearer ${sessionToken}` } });
    expect(meRes.status).toBe(401);
  });

  it('registers a device and issues a distinct token each time', async () => {
    const first = await json(await post('/api/devices/register'));
    const second = await json(await post('/api/devices/register'));
    expect(first.deviceToken).not.toBe(second.deviceToken);
  });
});
