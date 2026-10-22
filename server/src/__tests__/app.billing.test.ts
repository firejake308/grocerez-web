import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { createApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import type { AppDb } from '../db/client.js';
import type { Mailer } from '../lib/mail.js';
import { contributionCredits, creditRedemptions, priceReports, products, stores, stripeEvents, subscriptions, users } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { fillerReports } from './helpers/freeSet.js';
import { checkoutCompleted, FakeStripe, GOOD_PRICE, signPayload, stripeEvent, subscriptionObject } from './helpers/fakeStripe.js';

/** The Olipop reports in a pull response; other (free) products are expected alongside it. */
const olipop = (body: Record<string, any>) => (body.reports as { itemName: string }[]).filter((r) => r.itemName === 'Olipop'); // eslint-disable-line @typescript-eslint/no-explicit-any

const json = (res: Response): Promise<Record<string, any>> => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

const API_KEY = 'sk_test_123';
const WEBHOOK_SECRET = 'whsec_test';
const DAY = 86400_000;
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

describe('billing routes', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;
  let mailer: FakeMailer;
  let stripe: FakeStripe;
  let clock: number;
  let app: ReturnType<typeof createApp>;

  const now = () => new Date(clock);
  const build = (overrides: Partial<Parameters<typeof createApp>[0]> = {}) =>
    createApp({
      db,
      corsOrigins: ['http://localhost:5173'],
      mailer,
      entitlementsEnforced: true,
      now,
      billing: { apiKey: API_KEY, webhookSecret: WEBHOOK_SECRET, priceId: 'price_199', appUrl: 'https://grocerez.app/', fetch: stripe.fetch as typeof fetch },
      ...overrides,
    });

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
    mailer = new FakeMailer();
    stripe = new FakeStripe();
    clock = Date.now();
    app = build();
  });

  afterEach(() => {
    sqlite.close();
  });

  const post = (path: string, token?: string, body?: string, extra: Record<string, string> = {}) =>
    app.request(path, { method: 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body });

  const signIn = async (email: string, a = app): Promise<{ token: string; userId: string }> => {
    await a.request('/api/auth/request-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    const res = await a.request('/api/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: mailer.lastCode() }) });
    const { sessionToken, userId } = await json(res);
    return { token: sessionToken, userId };
  };

  const getUser = (id: string) => db.select().from(users).where(eq(users.id, id)).all()[0];
  const me = async (token: string) => (await json(await app.request('/api/me', { headers: { Authorization: `Bearer ${token}` } }))).entitlement;

  const webhook = (event: object, opts: { secret?: string; timestamp?: number; header?: string | null } = {}) => {
    const payload = JSON.stringify(event);
    const header = opts.header === null ? undefined : opts.header ?? signPayload(payload, opts.secret ?? WEBHOOK_SECRET, opts.timestamp ?? Math.floor(clock / 1000));
    return app.request('/api/billing/webhook', { method: 'POST', headers: header ? { 'Stripe-Signature': header } : {}, body: payload });
  };

  // =====================================================================
  describe('POST /api/billing/checkout', () => {
    it('503s when no API key is configured, and makes no Stripe calls', async () => {
      app = build({ billing: { apiKey: '', webhookSecret: '', priceId: 'price_199', appUrl: 'https://grocerez.app', fetch: stripe.fetch as typeof fetch } });
      const { token } = await signIn('a@example.com');
      expect((await post('/api/billing/checkout', token)).status).toBe(503);
      expect(stripe.requests).toHaveLength(0);
    });

    it('503s when STRIPE_PRICE_ID is unset', async () => {
      app = build({ billing: { apiKey: API_KEY, webhookSecret: '', priceId: '', appUrl: 'https://grocerez.app', fetch: stripe.fetch as typeof fetch } });
      const { token } = await signIn('a@example.com');
      expect((await post('/api/billing/checkout', token)).status).toBe(503);
      expect(stripe.requests).toHaveLength(0);
    });

    it('requires a session: 401 with no auth and with only a device token', async () => {
      expect((await post('/api/billing/checkout')).status).toBe(401);
      const { deviceToken } = await json(await post('/api/devices/register'));
      expect((await post('/api/billing/checkout', deviceToken)).status).toBe(401);
      expect((await post('/api/billing/checkout', 'garbage')).status).toBe(401);
      expect(stripe.requests).toHaveLength(0);
    });

    it('creates a customer and a subscription Checkout Session with exactly the parameters we rely on', async () => {
      const { token, userId } = await signIn('shopper@example.com');
      const res = await post('/api/billing/checkout', token);
      expect(res.status).toBe(200);
      expect((await json(res)).url).toBe('https://checkout.stripe.com/c/pay/cs_test_1');

      expect(stripe.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /v1/prices/price_199', 'POST /v1/customers', 'POST /v1/checkout/sessions']);
      for (const r of stripe.requests) expect(r.headers.Authorization).toBe(`Bearer ${API_KEY}`);

      const customer = stripe.requestsTo('/v1/customers')[0];
      expect(customer.headers['Idempotency-Key']).toBe(`grocerez-customer-${userId}`);
      expect(customer.form).toEqual({ email: 'shopper@example.com', 'metadata[user_id]': userId });

      const session = stripe.requestsTo('/v1/checkout/sessions')[0];
      expect(session.form).toEqual({
        mode: 'subscription',
        customer: 'cus_1',
        'line_items[0][price]': 'price_199',
        'line_items[0][quantity]': '1',
        success_url: 'https://grocerez.app/?checkout=success',
        cancel_url: 'https://grocerez.app/?checkout=cancel',
        client_reference_id: userId,
        'metadata[user_id]': userId,
        'subscription_data[metadata][user_id]': userId,
      });
      expect(getUser(userId).stripeCustomerId).toBe('cus_1');
    });

    it('never takes the price, customer, or amount from the request', async () => {
      const { token } = await signIn('shopper@example.com');
      await app.request('/api/billing/checkout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ priceId: 'price_evil', customer: 'cus_victim', userId: 'someone-else', amount: 1 }),
      });
      const session = stripe.requestsTo('/v1/checkout/sessions')[0];
      expect(session.form['line_items[0][price]']).toBe('price_199');
      expect(session.form.customer).toBe('cus_1');
      expect(JSON.stringify(stripe.requests)).not.toMatch(/price_evil|cus_victim|someone-else/);
    });

    it('reuses the customer and the verified price on a second checkout', async () => {
      const { token } = await signIn('shopper@example.com');
      await post('/api/billing/checkout', token);
      await post('/api/billing/checkout', token);
      expect(stripe.requestsTo('/v1/customers')).toHaveLength(1);
      expect(stripe.requests.filter((r) => r.path.startsWith('/v1/prices/'))).toHaveLength(1);
      expect(stripe.requestsTo('/v1/checkout/sessions')).toHaveLength(2);
      expect(stripe.requestsTo('/v1/checkout/sessions')[1].form.customer).toBe('cus_1');
    });

    it.each([
      ['wrong amount', { unit_amount: 299 }],
      ['wrong currency', { currency: 'eur' }],
      ['inactive', { active: false }],
      ['one-time, not recurring', { type: 'one_time', recurring: null }],
      ['yearly', { recurring: { interval: 'year', interval_count: 1 } }],
      ['every two months', { recurring: { interval: 'month', interval_count: 2 } }],
      ['free', { unit_amount: 0 }],
    ])('refuses to check out when the configured price is %s', async (_name, patch) => {
      stripe.price = { ...GOOD_PRICE, ...patch };
      const { token, userId } = await signIn('shopper@example.com');
      const res = await post('/api/billing/checkout', token);
      expect(res.status).toBe(503);
      expect(stripe.requestsTo('/v1/customers')).toHaveLength(0);
      expect(stripe.requestsTo('/v1/checkout/sessions')).toHaveLength(0);
      expect(getUser(userId).stripeCustomerId).toBeNull();
    });

    it('503s when Stripe does not know the price id, and recovers once it is fixed (failures are not cached)', async () => {
      stripe.price = null;
      const { token } = await signIn('shopper@example.com');
      expect((await post('/api/billing/checkout', token)).status).toBe(503);
      stripe.price = { ...GOOD_PRICE };
      expect((await post('/api/billing/checkout', token)).status).toBe(200);
    });

    it('502s (not 503) when Stripe itself is erroring while checking the price', async () => {
      stripe.failing.set('/v1/prices', 500);
      const { token } = await signIn('shopper@example.com');
      expect((await post('/api/billing/checkout', token)).status).toBe(502);
    });

    it('502s on a Stripe error creating the customer, and stores no customer id', async () => {
      stripe.failing.set('/v1/customers', 500);
      const { token, userId } = await signIn('shopper@example.com');
      const res = await post('/api/billing/checkout', token);
      expect(res.status).toBe(502);
      expect(getUser(userId).stripeCustomerId).toBeNull();
      expect(stripe.requestsTo('/v1/checkout/sessions')).toHaveLength(0);
    });

    it('502s on a Stripe error creating the session, without leaking the provider message', async () => {
      stripe.failing.set('/v1/checkout/sessions', 400);
      const { token } = await signIn('shopper@example.com');
      const res = await post('/api/billing/checkout', token);
      expect(res.status).toBe(502);
      expect(JSON.stringify(await json(res))).not.toContain('Stripe says no');
    });

    it('502s when the network call itself throws', async () => {
      stripe.networkDown.add('/v1/checkout/sessions');
      const { token } = await signIn('shopper@example.com');
      expect((await post('/api/billing/checkout', token)).status).toBe(502);
    });

    it('409s for someone already subscribed, without touching Stripe', async () => {
      const { token, userId } = await signIn('shopper@example.com');
      db.update(users).set({ plan: 'paid', planExpiresAt: new Date(clock + 10 * DAY).toISOString() }).where(eq(users.id, userId)).run();
      const res = await post('/api/billing/checkout', token);
      expect(res.status).toBe(409);
      expect(stripe.requests).toHaveLength(0);
    });

    it('lets someone whose paid plan has lapsed subscribe again', async () => {
      const { token, userId } = await signIn('shopper@example.com');
      db.update(users).set({ plan: 'paid', planExpiresAt: new Date(clock - 30 * DAY).toISOString() }).where(eq(users.id, userId)).run();
      expect((await post('/api/billing/checkout', token)).status).toBe(200);
    });

    it('lets someone on a credit-earned free month subscribe', async () => {
      const { token, userId } = await signIn('shopper@example.com');
      db.update(users).set({ creditAccessUntil: new Date(clock + 10 * DAY).toISOString() }).where(eq(users.id, userId)).run();
      expect((await post('/api/billing/checkout', token)).status).toBe(200);
    });

    it('rate-limits to 10 attempts an hour per user, independently per user', async () => {
      const a = await signIn('a@example.com');
      const b = await signIn('b@example.com');
      for (let i = 0; i < 10; i++) expect((await post('/api/billing/checkout', a.token)).status).toBe(200);
      expect((await post('/api/billing/checkout', a.token)).status).toBe(429);
      expect((await post('/api/billing/checkout', b.token)).status).toBe(200);
      clock += 61 * 60 * 1000;
      expect((await post('/api/billing/checkout', a.token)).status).toBe(200);
    });
  });

  // =====================================================================
  describe('POST /api/billing/portal', () => {
    it('503s when Stripe is not configured', async () => {
      app = build({ billing: { apiKey: '', webhookSecret: '', priceId: '', appUrl: 'https://grocerez.app', fetch: stripe.fetch as typeof fetch } });
      const { token } = await signIn('a@example.com');
      expect((await post('/api/billing/portal', token)).status).toBe(503);
    });

    it('requires a session', async () => {
      expect((await post('/api/billing/portal')).status).toBe(401);
      const { deviceToken } = await json(await post('/api/devices/register'));
      expect((await post('/api/billing/portal', deviceToken)).status).toBe(401);
    });

    it('404s for a user who never started checkout', async () => {
      const { token } = await signIn('a@example.com');
      expect((await post('/api/billing/portal', token)).status).toBe(404);
      expect(stripe.requests).toHaveLength(0);
    });

    it('opens the portal for the signed-in user\'s own customer, returning to the app', async () => {
      const { token, userId } = await signIn('a@example.com');
      db.update(users).set({ stripeCustomerId: 'cus_mine' }).where(eq(users.id, userId)).run();
      db.insert(users).values({ id: 'other', email: 'o@example.com', stripeCustomerId: 'cus_other' }).run();
      const res = await post('/api/billing/portal', token);
      expect(res.status).toBe(200);
      expect((await json(res)).url).toBe('https://billing.stripe.com/p/session/bps_1');
      const req = stripe.requestsTo('/v1/billing_portal/sessions')[0];
      expect(req.form).toEqual({ customer: 'cus_mine', return_url: 'https://grocerez.app/' });
    });

    it('502s when Stripe fails', async () => {
      stripe.failing.set('/v1/billing_portal', 500);
      const { token, userId } = await signIn('a@example.com');
      db.update(users).set({ stripeCustomerId: 'cus_mine' }).where(eq(users.id, userId)).run();
      expect((await post('/api/billing/portal', token)).status).toBe(502);
    });
  });

  // =====================================================================
  describe('POST /api/billing/webhook', () => {
    it('503s when no webhook secret is configured', async () => {
      app = build({ billing: { apiKey: API_KEY, webhookSecret: '', priceId: 'price_199', appUrl: 'https://grocerez.app' } });
      expect((await webhook(stripeEvent('invoice.paid', {}))).status).toBe(503);
    });

    it('rejects a missing signature, a wrong secret, a stale timestamp, and a tampered body', async () => {
      const { userId } = await signIn('a@example.com');
      const event = stripeEvent('customer.subscription.created', subscriptionObject({ userId }));
      expect((await webhook(event, { header: null })).status).toBe(400);
      expect((await webhook(event, { secret: 'whsec_wrong' })).status).toBe(400);
      expect((await webhook(event, { timestamp: Math.floor(clock / 1000) - 3600 })).status).toBe(400);

      const payload = JSON.stringify(event);
      const tampered = await app.request('/api/billing/webhook', {
        method: 'POST',
        headers: { 'Stripe-Signature': signPayload(payload, WEBHOOK_SECRET, Math.floor(clock / 1000)) },
        body: payload.replace('"active"', '"trialing"'),
      });
      expect(tampered.status).toBe(400);

      expect(getUser(userId).plan).toBe('free');
      expect(db.select().from(stripeEvents).all()).toHaveLength(0);
    });

    it('does not require (or accept as a substitute) a user session', async () => {
      const { token, userId } = await signIn('a@example.com');
      const event = stripeEvent('customer.subscription.created', subscriptionObject({ userId }));
      // Valid session, no signature -> still rejected.
      const res = await app.request('/api/billing/webhook', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(event) });
      expect(res.status).toBe(400);
      expect(getUser(userId).plan).toBe('free');
    });

    it('400s on a validly signed body that is not JSON, or not an event', async () => {
      for (const body of ['not json {', '[]', '{}', JSON.stringify({ id: 'evt', type: 'x' }), JSON.stringify({ id: 'evt', type: 'x', created: 'now', livemode: false, data: { object: {} } })]) {
        const res = await app.request('/api/billing/webhook', {
          method: 'POST',
          headers: { 'Stripe-Signature': signPayload(body, WEBHOOK_SECRET, Math.floor(clock / 1000)) },
          body,
        });
        expect(res.status).toBe(400);
      }
    });

    it('rejects an oversized body, by declared length and by actual size, even when it is otherwise a valid signed event', async () => {
      // A valid event padded past 1 MB: only the size cap can be what rejects it.
      const big = JSON.stringify(stripeEvent('invoice.paid', { pad: 'x'.repeat(1_100_000) }));
      const signed = { 'Stripe-Signature': signPayload(big, WEBHOOK_SECRET, Math.floor(clock / 1000)) };
      expect((await app.request('/api/billing/webhook', { method: 'POST', headers: { ...signed, 'Content-Length': String(big.length) }, body: big })).status).toBe(400);
      expect((await app.request('/api/billing/webhook', { method: 'POST', headers: signed, body: big })).status).toBe(400);
      // A small, valid, signed body that merely *declares* a huge length is refused before it is read.
      const small = JSON.stringify(stripeEvent('invoice.paid', {}));
      const smallSigned = { 'Stripe-Signature': signPayload(small, WEBHOOK_SECRET, Math.floor(clock / 1000)) };
      expect((await app.request('/api/billing/webhook', { method: 'POST', headers: { ...smallSigned, 'Content-Length': '2000000' }, body: small })).status).toBe(400);
      // The same event, small, is accepted -- so the 400s above really were about size.
      expect((await webhook(stripeEvent('invoice.paid', { pad: 'x' }))).status).toBe(200);
    });

    it('applies a correctly signed subscription event', async () => {
      const { userId } = await signIn('a@example.com');
      const periodEnd = Math.floor(clock / 1000) + 30 * 86400;
      const res = await webhook(stripeEvent('customer.subscription.created', subscriptionObject({ userId, periodEnd }), { created: Math.floor(clock / 1000) }));
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({ received: true });
      expect(getUser(userId).plan).toBe('paid');
      expect(getUser(userId).planExpiresAt).toBe(new Date(periodEnd * 1000).toISOString());
    });

    it('acknowledges unrelated and unmatched events with 200 so Stripe stops retrying', async () => {
      expect((await webhook(stripeEvent('invoice.paid', {}))).status).toBe(200);
      expect((await webhook(stripeEvent('customer.subscription.created', subscriptionObject({ userId: 'ghost' })))).status).toBe(200);
    });

    it('treats a replayed event as a no-op, answering 200 with duplicate: true', async () => {
      const { userId } = await signIn('a@example.com');
      const event = stripeEvent('customer.subscription.created', subscriptionObject({ userId }), { id: 'evt_replay', created: Math.floor(clock / 1000) });
      expect(await json(await webhook(event))).toEqual({ received: true });
      db.update(users).set({ plan: 'free', planExpiresAt: null }).where(eq(users.id, userId)).run();
      expect(await json(await webhook(event))).toEqual({ received: true, duplicate: true });
      expect(getUser(userId).plan).toBe('free');
    });

    it('ignores events from the other Stripe mode', async () => {
      const { userId } = await signIn('a@example.com');
      const res = await webhook(stripeEvent('customer.subscription.created', subscriptionObject({ userId }), { livemode: true }));
      expect(res.status).toBe(200);
      expect(getUser(userId).plan).toBe('free');
    });

    it('answers 500 and leaves no trace when applying fails, so Stripe\'s retry succeeds', async () => {
      const { userId } = await signIn('a@example.com');
      const event = stripeEvent('customer.subscription.created', subscriptionObject({ userId }), { id: 'evt_flaky', created: Math.floor(clock / 1000) });
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      sqlite.exec(`create trigger boom before insert on subscriptions begin select raise(abort, 'boom'); end`);
      expect((await webhook(event)).status).toBe(500);
      errorLog.mockRestore();
      expect(db.select().from(stripeEvents).all()).toHaveLength(0);
      sqlite.exec('drop trigger boom');
      expect((await webhook(event)).status).toBe(200);
      expect(getUser(userId).plan).toBe('paid');
    });
  });

  // =====================================================================
  describe('end to end: subscribe, unlock, cancel', () => {
    const report = (id: string, itemName: string) => ({
      id, itemName, brand: '', tags: [], quantity: 1, quantityUnits: 'each',
      price: '4.99', store: 'Kroger @ 9150 North Tarrant Parkway', latitude: KROGER_LAT, longitude: KROGER_LON,
      observedDate: '2026-06-01', updatedAt: '2026-06-01T00:00:00.000Z',
    });
    const pull = async (token: string) =>
      json(await app.request(`/api/sync/pull?since=0&lat=${KROGER_LAT}&lon=${KROGER_LON}&radiusMi=10`, { headers: { Authorization: `Bearer ${token}` } }));

    it('locked -> checkout -> webhooks -> unlocked -> cancellation -> locked again', async () => {
      const scanner = await signIn('scanner@example.com');
      const other = await signIn('other@example.com');
      for (const [who, user] of [['a', scanner], ['b', other]] as const) {
        await app.request('/api/sync/push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
          body: JSON.stringify({ reports: fillerReports(`filler-${who}`, report) }),
        });
      }
      await app.request('/api/sync/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${scanner.token}` },
        body: JSON.stringify({ reports: [report('r1', 'Olipop')] }),
      });

      const shopper = await signIn('shopper@example.com');
      const before = await pull(shopper.token);
      expect(before.accessLevel).toBe('public');
      expect(olipop(before)).toHaveLength(0);
      expect(before.locked).toHaveLength(1);
      expect((await me(shopper.token)).level).toBe('public');

      expect((await post('/api/billing/checkout', shopper.token)).status).toBe(200);
      const created = Math.floor(clock / 1000);
      expect((await webhook(checkoutCompleted(shopper.userId, 'cus_1', { created }))).status).toBe(200);
      // Between the redirect and the subscription event, nothing is unlocked yet.
      expect((await me(shopper.token)).level).toBe('public');

      const periodEnd = created + 30 * 86400;
      expect((await webhook(stripeEvent('customer.subscription.created', subscriptionObject({ userId: shopper.userId, periodEnd }), { created }))).status).toBe(200);

      const ent = await me(shopper.token);
      expect(ent.level).toBe('subscriber');
      expect(ent.subscription).toEqual({ status: 'active', currentPeriodEnd: new Date(periodEnd * 1000).toISOString(), cancelAtPeriodEnd: false });
      expect(ent.priceCents).toBe(199);
      expect(ent.billingConfigured).toBe(true);

      const unlocked = await pull(shopper.token);
      expect(unlocked.accessLevel).toBe('subscriber');
      expect(olipop(unlocked)).toHaveLength(1);
      expect(unlocked.locked).toHaveLength(0);

      // Already subscribed: no second checkout, and the portal is available.
      expect((await post('/api/billing/checkout', shopper.token)).status).toBe(409);
      expect((await post('/api/billing/portal', shopper.token)).status).toBe(200);

      // Cancel at period end: still unlocked, flagged as ending.
      await webhook(stripeEvent('customer.subscription.updated', subscriptionObject({ userId: shopper.userId, periodEnd, cancelAtPeriodEnd: true }), { created: created + 60 }));
      expect((await me(shopper.token)).subscription.cancelAtPeriodEnd).toBe(true);
      expect((await pull(shopper.token)).accessLevel).toBe('subscriber');

      // Period ends: Stripe sends deleted.
      await webhook(stripeEvent('customer.subscription.deleted', subscriptionObject({ userId: shopper.userId, status: 'canceled', periodEnd }), { created: created + 120 }));
      const after = await pull(shopper.token);
      expect(after.accessLevel).toBe('public');
      expect(olipop(after)).toHaveLength(0);
      expect(after.locked).toHaveLength(1);
      expect((await me(shopper.token)).level).toBe('public');
    });

    it('access ends on its own at the period end plus grace even if the cancellation webhook is lost', async () => {
      const shopper = await signIn('shopper@example.com');
      const created = Math.floor(clock / 1000);
      await webhook(stripeEvent('customer.subscription.created', subscriptionObject({ userId: shopper.userId, periodEnd: created + 30 * 86400 }), { created }));
      expect((await me(shopper.token)).level).toBe('subscriber');
      clock += 32 * DAY;
      expect((await me(shopper.token)).level).toBe('subscriber'); // 2 days past the period end, inside the 3-day grace
      clock += 2 * DAY; // 4 days past
      expect((await me(shopper.token)).level).toBe('public');
    });

    it('a user\'s subscription never unlocks anyone else', async () => {
      const a = await signIn('a@example.com');
      const b = await signIn('b@example.com');
      await webhook(stripeEvent('customer.subscription.created', subscriptionObject({ userId: a.userId }), { created: Math.floor(clock / 1000) }));
      expect((await me(a.token)).level).toBe('subscriber');
      expect((await me(b.token)).level).toBe('public');
      const { deviceToken } = await json(await post('/api/devices/register'));
      const devicePull = await json(await app.request(`/api/sync/pull?since=0&lat=${KROGER_LAT}&lon=${KROGER_LON}&radiusMi=10`, { headers: { Authorization: `Bearer ${deviceToken}` } }));
      expect(devicePull.accessLevel).toBe('public');
    });
  });

  // =====================================================================
  describe('POST /api/billing/redeem-credits', () => {
    let storeId: string;
    let productId: string;

    beforeEach(() => {
      storeId = newId();
      productId = newId();
      db.insert(stores).values({ id: storeId, name: 'Kroger', lat: KROGER_LAT, lon: KROGER_LON, chainKey: 'kroger', storeKey: newId() }).run();
      db.insert(products).values({ id: productId, canonicalName: 'Milk' }).run();
    });

    /** Gives the user `n` credit rows (10 credits each), earned `daysAgo` days ago. */
    const grantCredits = (userId: string, n: number, daysAgo = 1, extra: Partial<typeof contributionCredits.$inferInsert> = {}): string[] => {
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        const reportId = newId();
        db.insert(priceReports).values({
          id: reportId, userId, productId, storeId, itemName: 'Milk', priceCents: 300, priceRaw: '3.00',
          observedDate: '2026-06-01', freshnessDate: '2026-06-01', status: 'active', createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z',
        }).run();
        const id = newId();
        // Earlier rows are older, so "oldest first" is observable.
        db.insert(contributionCredits).values({ id, userId, reportId, earnedAt: new Date(clock - daysAgo * DAY - (n - i) * 1000).toISOString(), ...extra }).run();
        ids.push(id);
      }
      return ids;
    };

    it('requires a session', async () => {
      expect((await post('/api/billing/redeem-credits')).status).toBe(401);
      const { deviceToken } = await json(await post('/api/devices/register'));
      expect((await post('/api/billing/redeem-credits', deviceToken)).status).toBe(401);
    });

    it('works with Stripe completely unconfigured', async () => {
      app = build({ billing: { apiKey: '', webhookSecret: '', priceId: '', appUrl: 'https://grocerez.app' } });
      const { token, userId } = await signIn('a@example.com');
      grantCredits(userId, 20);
      expect((await post('/api/billing/redeem-credits', token)).status).toBe(200);
    });

    it('409s below 200 credits and spends nothing (19 rows = 190 credits)', async () => {
      const { token, userId } = await signIn('a@example.com');
      const ids = grantCredits(userId, 19);
      const res = await post('/api/billing/redeem-credits', token);
      expect(res.status).toBe(409);
      expect((await json(res)).error).toContain('200');
      expect((await me(token)).credits.balance).toBe(190);
      expect(db.select().from(creditRedemptions).all()).toHaveLength(0);
      expect(getUser(userId).creditAccessUntil).toBeNull();
      expect(ids).toHaveLength(19);
    });

    it('at exactly 200 credits grants 30 days, spends the 20 oldest rows, and keeps the rest', async () => {
      const { token, userId } = await signIn('a@example.com');
      const ids = grantCredits(userId, 25);
      expect((await me(token)).credits.balance).toBe(250);

      const res = await post('/api/billing/redeem-credits', token);
      expect(res.status).toBe(200);
      const ent = (await json(res)).entitlement;
      expect(ent.level).toBe('contributor');
      expect(ent.creditAccessUntil).toBe(new Date(clock + 30 * DAY).toISOString());
      expect(ent.credits.balance).toBe(50);

      const spent = db.select().from(contributionCredits).where(eq(contributionCredits.userId, userId)).all().filter((c) => c.spentRedemptionId);
      expect(spent.map((c) => c.id).sort()).toEqual(ids.slice(0, 20).sort());
      const redemption = db.select().from(creditRedemptions).all();
      expect(redemption).toHaveLength(1);
      expect(redemption[0].credits).toBe(200);
      expect(redemption[0].userId).toBe(userId);
    });

    it('a second redemption stacks onto the end of the first', async () => {
      const { token, userId } = await signIn('a@example.com');
      grantCredits(userId, 40);
      await post('/api/billing/redeem-credits', token);
      const res = await post('/api/billing/redeem-credits', token);
      expect(res.status).toBe(200);
      expect((await json(res)).entitlement.creditAccessUntil).toBe(new Date(clock + 60 * DAY).toISOString());
      expect((await me(token)).credits.balance).toBe(0);
    });

    it('two simultaneous taps with exactly 200 credits spend them once', async () => {
      const { token, userId } = await signIn('a@example.com');
      grantCredits(userId, 20);
      const results = await Promise.all([post('/api/billing/redeem-credits', token), post('/api/billing/redeem-credits', token)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(db.select().from(creditRedemptions).all()).toHaveLength(1);
      expect(getUser(userId).creditAccessUntil).toBe(new Date(clock + 30 * DAY).toISOString());
    });

    it('back-to-back redeems with 200 credits: the second is refused and nothing is double-spent', async () => {
      const { token, userId } = await signIn('a@example.com');
      grantCredits(userId, 20);
      expect((await post('/api/billing/redeem-credits', token)).status).toBe(200);
      expect((await post('/api/billing/redeem-credits', token)).status).toBe(409);
      expect(getUser(userId).creditAccessUntil).toBe(new Date(clock + 30 * DAY).toISOString());
    });

    it('does not count credits older than 90 days, revoked credits, or already-spent credits', async () => {
      const { token, userId } = await signIn('a@example.com');
      grantCredits(userId, 10, 91); // expired
      grantCredits(userId, 5, 1, { revokedAt: new Date(clock).toISOString() }); // revoked
      grantCredits(userId, 10, 1); // good: 100 credits
      expect((await me(token)).credits.balance).toBe(100);
      expect((await post('/api/billing/redeem-credits', token)).status).toBe(409);

      grantCredits(userId, 9, 89); // just inside the window -> 190
      expect((await post('/api/billing/redeem-credits', token)).status).toBe(409);
      grantCredits(userId, 1, 89); // -> 200
      expect((await post('/api/billing/redeem-credits', token)).status).toBe(200);
    });

    it('a credit expires mid-way: it counts today and stops counting after day 90', async () => {
      const { token, userId } = await signIn('a@example.com');
      grantCredits(userId, 20, 89);
      expect((await me(token)).credits.balance).toBe(200);
      clock += 2 * DAY;
      expect((await me(token)).credits.balance).toBe(0);
      expect((await post('/api/billing/redeem-credits', token)).status).toBe(409);
    });

    it('is refused while subscribed, and the credits stay intact', async () => {
      const { token, userId } = await signIn('a@example.com');
      grantCredits(userId, 20);
      db.update(users).set({ plan: 'paid', planExpiresAt: new Date(clock + 10 * DAY).toISOString() }).where(eq(users.id, userId)).run();
      const res = await post('/api/billing/redeem-credits', token);
      expect(res.status).toBe(409);
      expect(db.select().from(contributionCredits).where(and(eq(contributionCredits.userId, userId))).all().every((c) => !c.spentRedemptionId)).toBe(true);
      expect((await me(token)).credits.balance).toBe(200);
    });

    it('works once a lapsed subscription has expired', async () => {
      const { token, userId } = await signIn('a@example.com');
      grantCredits(userId, 20);
      db.update(users).set({ plan: 'paid', planExpiresAt: new Date(clock - 10 * DAY).toISOString() }).where(eq(users.id, userId)).run();
      expect((await post('/api/billing/redeem-credits', token)).status).toBe(200);
    });

    it('only spends the caller\'s own credits', async () => {
      const a = await signIn('a@example.com');
      const b = await signIn('b@example.com');
      grantCredits(a.userId, 20);
      expect((await post('/api/billing/redeem-credits', b.token)).status).toBe(409);
      expect(getUser(a.userId).creditAccessUntil).toBeNull();
      expect((await me(a.token)).credits.balance).toBe(200);
    });

    it('a redeemed month unlocks the pull, then lapses after 30 days; a later revoke does not claw it back', async () => {
      const scanner = await signIn('scanner@example.com');
      const other = await signIn('other@example.com');
      const fillerBase = (id: string, itemName: string) => ({
        id, itemName, brand: '', tags: [], quantity: 1, quantityUnits: 'each', price: '4.99',
        store: 'Kroger @ 9150 North Tarrant Parkway', latitude: KROGER_LAT, longitude: KROGER_LON, observedDate: '2026-06-01', updatedAt: '2026-06-01T00:00:00.000Z',
      });
      for (const [who, user] of [['a', scanner], ['b', other]] as const) {
        await app.request('/api/sync/push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
          body: JSON.stringify({ reports: fillerReports(`filler-${who}`, fillerBase) }),
        });
      }
      await app.request('/api/sync/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${scanner.token}` },
        body: JSON.stringify({ reports: [{
          id: 'r1', itemName: 'Olipop', brand: '', tags: [], quantity: 1, quantityUnits: 'each', price: '4.99',
          store: 'Kroger @ 9150 North Tarrant Parkway', latitude: KROGER_LAT, longitude: KROGER_LON, observedDate: '2026-06-01', updatedAt: '2026-06-01T00:00:00.000Z',
        }] }),
      });
      const { token, userId } = await signIn('a@example.com');
      const ids = grantCredits(userId, 20);
      const pull = async () => json(await app.request(`/api/sync/pull?since=0&lat=${KROGER_LAT}&lon=${KROGER_LON}&radiusMi=10`, { headers: { Authorization: `Bearer ${token}` } }));

      expect((await pull()).accessLevel).toBe('public');
      await post('/api/billing/redeem-credits', token);
      const unlocked = await pull();
      expect(unlocked.accessLevel).toBe('contributor');
      expect(olipop(unlocked)).toHaveLength(1);

      db.update(contributionCredits).set({ revokedAt: new Date(clock).toISOString() }).where(eq(contributionCredits.id, ids[0])).run();
      expect((await pull()).accessLevel).toBe('contributor');

      clock += 29 * DAY;
      expect((await pull()).accessLevel).toBe('contributor');
      clock += 2 * DAY;
      const lapsed = await pull();
      expect(lapsed.accessLevel).toBe('public');
      expect(olipop(lapsed)).toHaveLength(0);
    });
  });

  // =====================================================================
  describe('GET /api/me entitlement summary', () => {
    it('reports the price, credit rules, and that billing is configured', async () => {
      const { token } = await signIn('a@example.com');
      expect(await me(token)).toMatchObject({
        enforced: true,
        level: 'public',
        billingConfigured: true,
        priceCents: 199,
        subscription: null,
        creditAccessUntil: null,
        credits: { balance: 0, perReport: 10, perFreeMonth: 200, expiryDays: 90 },
      });
    });

    it('reports billingConfigured false when Stripe has no key or price', async () => {
      app = build({ billing: { apiKey: '', webhookSecret: '', priceId: '', appUrl: 'https://grocerez.app' } });
      const { token } = await signIn('a@example.com');
      expect((await me(token)).billingConfigured).toBe(false);
    });

    it('prefers a live subscription over an older canceled one', async () => {
      const { token, userId } = await signIn('a@example.com');
      const created = Math.floor(clock / 1000);
      await webhook(stripeEvent('customer.subscription.created', subscriptionObject({ userId, id: 'sub_old', periodEnd: created - 40 * 86400 }), { created }));
      await webhook(stripeEvent('customer.subscription.deleted', subscriptionObject({ userId, id: 'sub_old', status: 'canceled', periodEnd: created - 40 * 86400 }), { created: created + 1 }));
      await webhook(stripeEvent('customer.subscription.created', subscriptionObject({ userId, id: 'sub_new', periodEnd: created + 30 * 86400 }), { created: created + 2 }));
      expect((await me(token)).subscription.status).toBe('active');
      expect(db.select().from(subscriptions).all()).toHaveLength(2);
    });
  });

  it('does not leak the API key or webhook secret in any response body', async () => {
    const { token } = await signIn('a@example.com');
    const responses = [await post('/api/billing/checkout', token), await post('/api/billing/portal', token), await webhook({}, { header: null }), await app.request('/api/me', { headers: { Authorization: `Bearer ${token}` } })];
    for (const r of responses) {
      const text = await r.text();
      expect(text).not.toContain(API_KEY);
      expect(text).not.toContain(WEBHOOK_SECRET);
    }
  });
});
