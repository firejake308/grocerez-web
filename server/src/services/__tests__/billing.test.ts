import { createHmac } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { runMigrations } from '../../db/migrate.js';
import type { AppDb } from '../../db/client.js';
import { stripeEvents, subscriptions, users } from '../../db/schema.js';
import { entitlementLevel } from '../entitlements.js';
import { handleWebhookEvent, isLiveKey, verifyWebhookSignature, type StripeEvent } from '../billing.js';
import { checkoutCompleted, stripeEvent, subscriptionObject } from '../../__tests__/helpers/fakeStripe.js';

const SECRET = 'whsec_test';
const NOW = new Date('2026-06-01T00:00:00.000Z');
const now = () => NOW;
const nowSec = Math.floor(NOW.getTime() / 1000);
const DAY = 86400;
/** Events default to the test clock (not wall time) so "later" events are really later. */
const ev = (type: string, object: Record<string, unknown>, o: { id?: string; created?: number; livemode?: boolean } = {}) => stripeEvent(type, object, { created: nowSec, ...o });

const sign = (payload: string, secret: string, timestamp: number) =>
  `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex')}`;

describe('verifyWebhookSignature', () => {
  const payload = JSON.stringify({ hello: 'world' });

  it('accepts a correctly signed, fresh payload', () => {
    expect(verifyWebhookSignature(payload, sign(payload, SECRET, nowSec), SECRET, 300, now)).toBe(true);
  });

  it('rejects a payload signed with the wrong secret', () => {
    expect(verifyWebhookSignature(payload, sign(payload, 'whsec_wrong', nowSec), SECRET, 300, now)).toBe(false);
  });

  it('rejects a tampered payload', () => {
    expect(verifyWebhookSignature('{"hello":"tampered"}', sign(payload, SECRET, nowSec), SECRET, 300, now)).toBe(false);
  });

  it('rejects a stale timestamp, and one too far in the future', () => {
    expect(verifyWebhookSignature(payload, sign(payload, SECRET, nowSec - 600), SECRET, 300, now)).toBe(false);
    expect(verifyWebhookSignature(payload, sign(payload, SECRET, nowSec + 600), SECRET, 300, now)).toBe(false);
  });

  it('accepts a timestamp just inside the tolerance', () => {
    expect(verifyWebhookSignature(payload, sign(payload, SECRET, nowSec - 299), SECRET, 300, now)).toBe(true);
  });

  it('rejects a timestamp that is not a plain integer', () => {
    const hmac = (t: string) => createHmac('sha256', SECRET).update(`${t}.${payload}`).digest('hex');
    for (const t of ['abc', `${nowSec}.5`, `-${nowSec}`, '', '1e9']) {
      expect(verifyWebhookSignature(payload, `t=${t},v1=${hmac(t)}`, SECRET, 300, now)).toBe(false);
    }
  });

  it('rejects everything when the configured secret is empty, even an HMAC made with the empty string', () => {
    expect(verifyWebhookSignature(payload, sign(payload, '', nowSec), '', 300, now)).toBe(false);
  });

  it('ignores the v0 scheme', () => {
    const v0 = createHmac('sha256', SECRET).update(`${nowSec}.${payload}`).digest('hex');
    expect(verifyWebhookSignature(payload, `t=${nowSec},v0=${v0}`, SECRET, 300, now)).toBe(false);
  });

  it('accepts when any one of several v1 signatures matches (secret rotation)', () => {
    const good = createHmac('sha256', SECRET).update(`${nowSec}.${payload}`).digest('hex');
    const old = createHmac('sha256', 'whsec_old').update(`${nowSec}.${payload}`).digest('hex');
    expect(verifyWebhookSignature(payload, `t=${nowSec},v1=${old},v1=${good}`, SECRET, 300, now)).toBe(true);
    expect(verifyWebhookSignature(payload, `t=${nowSec},v1=${good},v1=${old}`, SECRET, 300, now)).toBe(true);
  });

  it('rejects malformed, truncated, non-hex, and missing headers', () => {
    const good = createHmac('sha256', SECRET).update(`${nowSec}.${payload}`).digest('hex');
    expect(verifyWebhookSignature(payload, 'not-a-real-header', SECRET, 300, now)).toBe(false);
    expect(verifyWebhookSignature(payload, '', SECRET, 300, now)).toBe(false);
    expect(verifyWebhookSignature(payload, `t=${nowSec}`, SECRET, 300, now)).toBe(false);
    expect(verifyWebhookSignature(payload, `v1=${good}`, SECRET, 300, now)).toBe(false);
    expect(verifyWebhookSignature(payload, `t=${nowSec},v1=${good.slice(0, 32)}`, SECRET, 300, now)).toBe(false);
    expect(verifyWebhookSignature(payload, `t=${nowSec},v1=${'z'.repeat(64)}`, SECRET, 300, now)).toBe(false);
  });
});

describe('isLiveKey', () => {
  it('recognizes live secret and restricted keys only', () => {
    expect(isLiveKey('sk_live_abc')).toBe(true);
    expect(isLiveKey('rk_live_abc')).toBe(true);
    expect(isLiveKey('sk_test_abc')).toBe(false);
    expect(isLiveKey('rk_test_abc')).toBe(false);
    expect(isLiveKey('')).toBe(false);
  });
});

describe('handleWebhookEvent', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;
  const apply = (event: StripeEvent | ReturnType<typeof stripeEvent>, livemode: boolean | null = false) =>
    handleWebhookEvent(db, event as StripeEvent, { livemode }, now);
  const user = () => db.select().from(users).where(eq(users.id, 'user-1')).all()[0];
  const subRow = (id = 'sub_1') => db.select().from(subscriptions).where(eq(subscriptions.providerRef, id)).all()[0];

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
    db.insert(users).values({ id: 'user-1', email: 'one@example.com' }).run();
  });

  afterEach(() => {
    sqlite.close();
  });

  describe('subscription lifecycle', () => {
    it('subscription.created grants paid access until the period end', () => {
      const periodEnd = nowSec + 30 * DAY;
      expect(apply(ev('customer.subscription.created', subscriptionObject({ periodEnd })))).toBe('applied');
      expect(user().plan).toBe('paid');
      expect(user().planExpiresAt).toBe(new Date(periodEnd * 1000).toISOString());
      expect(user().stripeCustomerId).toBe('cus_1');
      expect(subRow().status).toBe('active');
      expect(entitlementLevel(user(), now)).toBe('subscriber');
    });

    it('reads the period end from items.data for newer Stripe API versions', () => {
      const periodEnd = nowSec + 30 * DAY;
      apply(ev('customer.subscription.created', subscriptionObject({ periodEnd, layout: 'items' })));
      expect(user().plan).toBe('paid');
      expect(user().planExpiresAt).toBe(new Date(periodEnd * 1000).toISOString());
    });

    it('a trialing subscription grants access', () => {
      apply(ev('customer.subscription.created', subscriptionObject({ status: 'trialing' })));
      expect(user().plan).toBe('paid');
    });

    it('past_due keeps access only until the period end, and the grace window then lapses', () => {
      const periodEnd = nowSec + 2 * DAY;
      apply(ev('customer.subscription.created', subscriptionObject({ status: 'past_due', periodEnd })));
      expect(user().plan).toBe('paid');
      expect(entitlementLevel(user(), now)).toBe('subscriber');

      const later = (days: number) => () => new Date(NOW.getTime() + days * DAY * 1000);
      expect(entitlementLevel(user(), later(4))).toBe('subscriber'); // period ended 2d ago, within 3d grace
      expect(entitlementLevel(user(), later(6))).toBe('public'); // grace over
    });

    it.each(['canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'])('status %s gives no access', (status) => {
      apply(ev('customer.subscription.created', subscriptionObject({ status })));
      expect(user().plan).toBe('free');
      expect(user().planExpiresAt).toBeNull();
      expect(entitlementLevel(user(), now)).toBe('public');
    });

    it('records cancel_at_period_end and keeps access until the period ends', () => {
      apply(ev('customer.subscription.created', subscriptionObject()));
      apply(ev('customer.subscription.updated', subscriptionObject({ cancelAtPeriodEnd: true }), { created: nowSec + 10 }));
      expect(subRow().cancelAtPeriodEnd).toBe(true);
      expect(user().plan).toBe('paid');
    });

    it('a renewal extends planExpiresAt', () => {
      apply(ev('customer.subscription.created', subscriptionObject({ periodEnd: nowSec + 30 * DAY })));
      apply(ev('customer.subscription.updated', subscriptionObject({ periodEnd: nowSec + 60 * DAY }), { created: nowSec + 100 }));
      expect(user().planExpiresAt).toBe(new Date((nowSec + 60 * DAY) * 1000).toISOString());
    });

    it('subscription.deleted ends access immediately', () => {
      apply(ev('customer.subscription.created', subscriptionObject()));
      apply(ev('customer.subscription.deleted', subscriptionObject({ status: 'canceled' }), { created: nowSec + 10 }));
      expect(user().plan).toBe('free');
      expect(user().planExpiresAt).toBeNull();
      expect(subRow().status).toBe('canceled');
    });

    it('treats subscription.deleted as canceled even if the payload status says otherwise', () => {
      apply(ev('customer.subscription.created', subscriptionObject()));
      apply(ev('customer.subscription.deleted', subscriptionObject({ status: 'active' }), { created: nowSec + 10 }));
      expect(subRow().status).toBe('canceled');
      expect(user().plan).toBe('free');
    });

    it('keeps the stored period end when a later event omits it', () => {
      const periodEnd = nowSec + 30 * DAY;
      apply(ev('customer.subscription.created', subscriptionObject({ periodEnd })));
      const bare = { ...subscriptionObject(), current_period_end: undefined };
      apply(ev('customer.subscription.updated', bare, { created: nowSec + 10 }));
      expect(user().planExpiresAt).toBe(new Date(periodEnd * 1000).toISOString());
    });

    it('an active subscription with no period end anywhere grants nothing (never open-ended access)', () => {
      apply(ev('customer.subscription.created', { ...subscriptionObject(), current_period_end: undefined }));
      expect(user().plan).toBe('free');
      expect(entitlementLevel(user(), now)).toBe('public');
    });
  });

  describe('ordering and replay', () => {
    it('a duplicate event id is a no-op', () => {
      const event = ev('customer.subscription.created', subscriptionObject(), { id: 'evt_dup' });
      expect(apply(event)).toBe('applied');
      db.update(users).set({ plan: 'free', planExpiresAt: null }).where(eq(users.id, 'user-1')).run();
      expect(apply(event)).toBe('duplicate');
      expect(user().plan).toBe('free'); // not re-applied
      expect(db.select().from(stripeEvents).all()).toHaveLength(1);
    });

    it('an older event arriving after a newer one is ignored', () => {
      apply(ev('customer.subscription.created', subscriptionObject(), { created: nowSec - 100 }));
      apply(ev('customer.subscription.updated', subscriptionObject({ status: 'past_due', cancelAtPeriodEnd: true }), { created: nowSec }));
      // A stale "active" update from before the past_due one shows up late.
      expect(apply(ev('customer.subscription.updated', subscriptionObject({ status: 'active', cancelAtPeriodEnd: false }), { created: nowSec - 50 }))).toBe('ignored');
      expect(subRow().status).toBe('past_due');
      expect(subRow().cancelAtPeriodEnd).toBe(true);
    });

    it('a late "updated: active" can never resurrect a canceled subscription', () => {
      apply(ev('customer.subscription.created', subscriptionObject(), { created: nowSec - 100 }));
      apply(ev('customer.subscription.deleted', subscriptionObject({ status: 'canceled' }), { created: nowSec }));
      // Same-second tie, and a later-stamped one: neither may reactivate it.
      expect(apply(ev('customer.subscription.updated', subscriptionObject({ status: 'active' }), { created: nowSec }))).toBe('ignored');
      expect(apply(ev('customer.subscription.updated', subscriptionObject({ status: 'active' }), { created: nowSec + 5 }))).toBe('ignored');
      expect(subRow().status).toBe('canceled');
      expect(user().plan).toBe('free');
    });

    it('subscription.created arriving before checkout.session.completed still works, and the later event just links', () => {
      apply(ev('customer.subscription.created', subscriptionObject()));
      expect(user().plan).toBe('paid');
      expect(apply(checkoutCompleted('user-1', 'cus_1', { created: nowSec }))).toBe('applied');
      expect(user().plan).toBe('paid');
      expect(db.select().from(subscriptions).all()).toHaveLength(1);
    });

    it('checkout.session.completed alone links the customer but grants no access', () => {
      apply(checkoutCompleted('user-1', 'cus_9'));
      expect(user().stripeCustomerId).toBe('cus_9');
      expect(user().plan).toBe('free');
      expect(db.select().from(subscriptions).all()).toHaveLength(0);
    });

    it('ignores checkout sessions that are not subscriptions', () => {
      const event = ev('checkout.session.completed', { mode: 'payment', client_reference_id: 'user-1', customer: 'cus_9' });
      expect(apply(event)).toBe('ignored');
      expect(user().stripeCustomerId).toBeNull();
    });
  });

  describe('finding the user', () => {
    it('falls back to the stored customer id when the subscription has no metadata', () => {
      db.update(users).set({ stripeCustomerId: 'cus_77' }).where(eq(users.id, 'user-1')).run();
      apply(ev('customer.subscription.created', subscriptionObject({ customer: 'cus_77', userId: null })));
      expect(subRow().userId).toBe('user-1');
      expect(user().plan).toBe('paid');
    });

    it('later events find the user from the existing subscription row', () => {
      apply(ev('customer.subscription.created', subscriptionObject()));
      apply(ev('customer.subscription.updated', subscriptionObject({ userId: null, cancelAtPeriodEnd: true }), { created: nowSec + 5 }));
      expect(subRow().cancelAtPeriodEnd).toBe(true);
    });

    it('acknowledges (ignores) an event for a user that does not exist, without throwing', () => {
      expect(apply(ev('customer.subscription.created', subscriptionObject({ userId: 'ghost' })))).toBe('ignored');
      expect(apply(checkoutCompleted('ghost'))).toBe('ignored');
      expect(db.select().from(subscriptions).all()).toHaveLength(0);
    });

    it('does not steal a Stripe customer id that belongs to another user', () => {
      db.insert(users).values({ id: 'user-2', email: 'two@example.com', stripeCustomerId: 'cus_shared' }).run();
      apply(ev('customer.subscription.created', subscriptionObject({ customer: 'cus_shared', userId: 'user-1' })));
      expect(user().stripeCustomerId).toBeNull();
      expect(db.select().from(users).where(eq(users.id, 'user-2')).all()[0].stripeCustomerId).toBe('cus_shared');
    });

    it('an existing subscription never moves to another user, even if a later event\'s metadata names someone else', () => {
      db.insert(users).values({ id: 'user-2', email: 'two@example.com' }).run();
      apply(ev('customer.subscription.created', subscriptionObject({ userId: 'user-1' })));
      // The cancellation names user-2 in its metadata. It must still end user-1's access, and never touch user-2.
      apply(ev('customer.subscription.deleted', subscriptionObject({ userId: 'user-2', status: 'canceled' }), { created: nowSec + 5 }));
      expect(subRow().userId).toBe('user-1');
      expect(subRow().status).toBe('canceled');
      expect(user().plan).toBe('free');
      expect(db.select().from(users).where(eq(users.id, 'user-2')).all()[0].plan).toBe('free');
    });

    it('a user with two subscriptions keeps access while either is active', () => {
      apply(ev('customer.subscription.created', subscriptionObject({ id: 'sub_a' })));
      apply(ev('customer.subscription.created', subscriptionObject({ id: 'sub_b' })));
      apply(ev('customer.subscription.deleted', subscriptionObject({ id: 'sub_a', status: 'canceled' }), { created: nowSec + 5 }));
      expect(user().plan).toBe('paid');
      apply(ev('customer.subscription.deleted', subscriptionObject({ id: 'sub_b', status: 'canceled' }), { created: nowSec + 6 }));
      expect(user().plan).toBe('free');
    });

    it("one user's events never change another user's plan", () => {
      db.insert(users).values({ id: 'user-2', email: 'two@example.com' }).run();
      apply(ev('customer.subscription.created', subscriptionObject({ userId: 'user-2', customer: 'cus_2', id: 'sub_2' })));
      expect(user().plan).toBe('free');
      expect(db.select().from(users).where(eq(users.id, 'user-2')).all()[0].plan).toBe('paid');
    });
  });

  describe('modes and unrelated events', () => {
    it('ignores a live event on a test-key server, and vice versa, without recording it', () => {
      const live = ev('customer.subscription.created', subscriptionObject(), { livemode: true });
      expect(apply(live, false)).toBe('ignored');
      expect(user().plan).toBe('free');
      expect(db.select().from(stripeEvents).all()).toHaveLength(0);

      const test = ev('customer.subscription.created', subscriptionObject(), { livemode: false });
      expect(apply(test, true)).toBe('ignored');
      expect(user().plan).toBe('free');
    });

    it('accepts either mode when no API key is configured to infer one from', () => {
      expect(apply(ev('customer.subscription.created', subscriptionObject(), { livemode: true }), null)).toBe('applied');
    });

    it('ignores unrelated event types but still records them', () => {
      expect(apply(ev('invoice.paid', {}, { id: 'evt_inv' }))).toBe('ignored');
      expect(db.select().from(stripeEvents).where(eq(stripeEvents.id, 'evt_inv')).all()).toHaveLength(1);
    });

    it('ignores a subscription object missing id or status', () => {
      expect(apply(ev('customer.subscription.created', { customer: 'cus_1' }))).toBe('ignored');
    });
  });

  describe('failure handling', () => {
    it('rolls back the dedupe record when applying throws, so a retry can succeed', () => {
      const event = ev('customer.subscription.created', subscriptionObject(), { id: 'evt_retry' });
      // Make the subscription insert fail: provider_ref is unique and 'sub_1' already belongs to a row we hide from the lookup.
      sqlite.exec(`create trigger boom before insert on subscriptions begin select raise(abort, 'boom'); end`);
      expect(() => apply(event)).toThrow();
      expect(db.select().from(stripeEvents).all()).toHaveLength(0);
      expect(user().plan).toBe('free');

      sqlite.exec('drop trigger boom');
      expect(apply(event)).toBe('applied');
      expect(user().plan).toBe('paid');
    });
  });
});
