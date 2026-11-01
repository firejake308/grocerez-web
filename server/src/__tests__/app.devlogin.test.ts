import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { createApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import type { AppDb } from '../db/client.js';
import { ResendMailer, type Mailer } from '../lib/mail.js';
import { users, authCodes } from '../db/schema.js';

const json = (res: Response): Promise<Record<string, any>> => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

class FakeMailer implements Mailer {
  sent: { to: string; text: string }[] = [];
  async send(to: string, _subject: string, text: string): Promise<void> {
    this.sent.push({ to, text });
  }
  lastCode(): string {
    return this.sent.at(-1)!.text.match(/\d{6}/)![0];
  }
}

const CODE = '424242';

describe('dev login shortcut', () => {
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

  const appWith = (devLogin?: { code: string }) => createApp({ db, corsOrigins: ['http://localhost:5173'], mailer, devLogin });
  const post = (app: ReturnType<typeof createApp>, path: string, body: unknown) =>
    app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  describe('enabled', () => {
    it('signs a test address in with the fixed code and no email, and the session works', async () => {
      const app = appWith({ code: CODE });
      expect((await post(app, '/api/auth/request-code', { email: 'me@example.test' })).status).toBe(200);
      expect(mailer.sent).toHaveLength(0);
      expect(db.select().from(authCodes).all()).toHaveLength(0);

      const res = await post(app, '/api/auth/verify', { email: 'me@example.test', code: CODE });
      expect(res.status).toBe(200);
      const { sessionToken, userId } = await json(res);
      const me = await json(await app.request('/api/me', { headers: { Authorization: `Bearer ${sessionToken}` } }));
      expect(me.id).toBe(userId);
      expect(me.email).toBe('me@example.test');
    });

    it('works without requesting a code first, and any number of times, resolving to the same account', async () => {
      const app = appWith({ code: CODE });
      const a = await json(await post(app, '/api/auth/verify', { email: 'me@example.test', code: CODE }));
      const b = await json(await post(app, '/api/auth/verify', { email: 'ME@Example.Test', code: CODE }));
      expect(a.userId).toBe(b.userId);
      expect(a.sessionToken).not.toBe(b.sessionToken);
      expect(db.select().from(users).all()).toHaveLength(1);
      // Repeated requests are never throttled, since nothing is sent.
      for (let i = 0; i < 3; i++) expect((await post(app, '/api/auth/request-code', { email: 'me@example.test' })).status).toBe(200);
    });

    it('rejects a wrong code for a test address, with no attempt lockout to hide behind', async () => {
      const app = appWith({ code: CODE });
      for (let i = 0; i < 8; i++) expect((await post(app, '/api/auth/verify', { email: 'me@example.test', code: '000000' })).status).toBe(401);
      expect((await post(app, '/api/auth/verify', { email: 'me@example.test', code: CODE })).status).toBe(200);
    });

    it('does NOT work for a real address, before or after requesting a real code', async () => {
      const app = appWith({ code: CODE });
      expect((await post(app, '/api/auth/verify', { email: 'real@gmail.com', code: CODE })).status).toBe(401);
      expect(db.select().from(users).all()).toHaveLength(0);

      await post(app, '/api/auth/request-code', { email: 'real@gmail.com' });
      expect(mailer.sent).toHaveLength(1); // real addresses still get real mail
      expect(mailer.sent[0].to).toBe('real@gmail.com');
      expect((await post(app, '/api/auth/verify', { email: 'real@gmail.com', code: CODE })).status).toBe(401);
      expect((await post(app, '/api/auth/verify', { email: 'real@gmail.com', code: mailer.lastCode() })).status).toBe(200);
    });

    it('does NOT work for lookalike domains', async () => {
      const app = appWith({ code: CODE });
      for (const email of ['me@sub.example.test', 'me@example.test.evil.com', 'me@notexample.test', 'example.test@gmail.com']) {
        expect((await post(app, '/api/auth/verify', { email, code: CODE })).status, email).toBe(401);
      }
      expect(db.select().from(users).all()).toHaveLength(0);
    });
  });

  describe('disabled (the default, and production)', () => {
    it('gives test addresses no special treatment: mail is attempted and the fixed code is useless', async () => {
      const app = appWith(undefined);
      expect((await post(app, '/api/auth/verify', { email: 'me@example.test', code: CODE })).status).toBe(401);
      await post(app, '/api/auth/request-code', { email: 'me@example.test' });
      expect(mailer.sent).toHaveLength(1);
      const real = mailer.lastCode();
      expect((await post(app, '/api/auth/verify', { email: 'me@example.test', code: real === CODE ? '000001' : CODE })).status).toBe(401);
      expect((await post(app, '/api/auth/verify', { email: 'me@example.test', code: real })).status).toBe(200);
    });
  });

  describe('refuses to be misconfigured', () => {
    const base = { db: undefined as unknown as AppDb, corsOrigins: [] as string[] };

    it('will not build the app next to a live Stripe key', () => {
      for (const apiKey of ['sk_live_abc', 'rk_live_abc']) {
        expect(() =>
          createApp({ ...base, db, mailer, devLogin: { code: CODE }, billing: { apiKey, webhookSecret: '', priceId: '', appUrl: 'https://x' } }),
        ).toThrow(/live Stripe/);
      }
    });

    it('will not build the app with a real mail provider', () => {
      expect(() => createApp({ ...base, db, mailer: new ResendMailer('key', 'from'), devLogin: { code: CODE } })).toThrow(/mail provider/);
    });

    it('will not build the app with a malformed code', () => {
      expect(() => createApp({ ...base, db, mailer, devLogin: { code: 'abc' } })).toThrow(/6 digits/);
    });

    it('builds fine with a test Stripe key', () => {
      expect(() =>
        createApp({ ...base, db, mailer, devLogin: { code: CODE }, billing: { apiKey: 'sk_test_abc', webhookSecret: '', priceId: '', appUrl: 'https://x' } }),
      ).not.toThrow();
    });
  });
});
