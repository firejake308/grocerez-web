import { createHmac } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { createApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import type { AppDb } from '../db/client.js';
import type { Mailer } from '../lib/mail.js';
import { users } from '../db/schema.js';

const json = (res: Response): Promise<Record<string, any>> => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

class FakeMailer implements Mailer {
  sent: string[] = [];
  async send(_to: string, _subject: string, text: string): Promise<void> {
    this.sent.push(text);
  }
  lastCode(): string {
    return this.sent.at(-1)!.match(/\d{6}/)![0];
  }
}

function signStripe(payload: string, secret: string, timestamp: number): string {
  const hmac = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${hmac}`;
}

describe('billing routes', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;
  let mailer: FakeMailer;

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
    mailer = new FakeMailer();
  });

  afterEach(() => {
    sqlite.close();
    vi.unstubAllGlobals();
  });

  const signIn = async (app: ReturnType<typeof createApp>, email: string): Promise<string> => {
    await app.request('/api/auth/request-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    const res = await app.request('/api/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: mailer.lastCode() }) });
    return (await json(res)).sessionToken as string;
  };

  describe('POST /api/billing/checkout', () => {
    it('503s when Stripe is not configured', async () => {
      const app = createApp({ db, corsOrigins: ['http://localhost:5173'], mailer });
      const token = await signIn(app, 'shopper@example.com');
      const res = await app.request('/api/billing/checkout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBe(503);
    });

    it('requires a session, not just a device token', async () => {
      const app = createApp({ db, corsOrigins: ['http://localhost:5173'], mailer, billing: { secretKey: 'sk_test', webhookSecret: '', priceId: 'price_1', appUrl: 'http://localhost:5173' } });
      const deviceRes = await app.request('/api/devices/register', { method: 'POST' });
      const { deviceToken } = await json(deviceRes);
      const res = await app.request('/api/billing/checkout', { method: 'POST', headers: { Authorization: `Bearer ${deviceToken}` } });
      expect(res.status).toBe(401);
    });

    it('returns the checkout URL from Stripe when configured', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'cs_test_123', url: 'https://checkout.stripe.com/pay/cs_test_123' }),
      }));
      const app = createApp({ db, corsOrigins: ['http://localhost:5173'], mailer, billing: { secretKey: 'sk_test', webhookSecret: '', priceId: 'price_1', appUrl: 'http://localhost:5173' } });
      const token = await signIn(app, 'shopper@example.com');
      const res = await app.request('/api/billing/checkout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      expect((await json(res)).url).toBe('https://checkout.stripe.com/pay/cs_test_123');
    });

    it('surfaces a Stripe error as 502', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: { message: 'Invalid API key.' } }) }));
      const app = createApp({ db, corsOrigins: ['http://localhost:5173'], mailer, billing: { secretKey: 'sk_bad', webhookSecret: '', priceId: 'price_1', appUrl: 'http://localhost:5173' } });
      const token = await signIn(app, 'shopper@example.com');
      const res = await app.request('/api/billing/checkout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBe(502);
    });
  });

  describe('POST /api/billing/webhook', () => {
    it('503s when no webhook secret is configured', async () => {
      const app = createApp({ db, corsOrigins: ['http://localhost:5173'], mailer });
      const res = await app.request('/api/billing/webhook', { method: 'POST', body: '{}' });
      expect(res.status).toBe(503);
    });

    it('400s on a bad signature', async () => {
      const app = createApp({ db, corsOrigins: ['http://localhost:5173'], mailer, billing: { secretKey: '', webhookSecret: 'whsec_test', priceId: '', appUrl: 'http://localhost:5173' } });
      const res = await app.request('/api/billing/webhook', {
        method: 'POST',
        headers: { 'Stripe-Signature': 't=1,v1=deadbeef' },
        body: '{}',
      });
      expect(res.status).toBe(400);
    });

    it('applies a correctly signed checkout.session.completed event', async () => {
      const userId = 'user-1';
      db.insert(users).values({ id: userId, email: 'shopper@example.com' }).run();
      const secret = 'whsec_test';
      const app = createApp({ db, corsOrigins: ['http://localhost:5173'], mailer, billing: { secretKey: '', webhookSecret: secret, priceId: '', appUrl: 'http://localhost:5173' } });

      const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: { client_reference_id: userId, subscription: 'sub_abc' } } });
      const timestamp = Math.floor(Date.now() / 1000);
      const res = await app.request('/api/billing/webhook', {
        method: 'POST',
        headers: { 'Stripe-Signature': signStripe(payload, secret, timestamp) },
        body: payload,
      });
      expect(res.status).toBe(200);

      const user = db.select().from(users).where(eq(users.id, userId)).all()[0];
      expect(user.plan).toBe('paid');
    });
  });
});
