import { createHmac } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { runMigrations } from '../../db/migrate.js';
import type { AppDb } from '../../db/client.js';
import { subscriptions, users } from '../../db/schema.js';
import { newId } from '../../lib/ids.js';
import { applySubscriptionEvent, verifyWebhookSignature } from '../billing.js';

const SECRET = 'whsec_test';

function sign(payload: string, secret: string, timestamp: number): string {
  const hmac = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${hmac}`;
}

describe('verifyWebhookSignature', () => {
  const now = () => new Date('2026-06-01T00:00:00.000Z');

  it('accepts a correctly signed, fresh payload', () => {
    const payload = JSON.stringify({ hello: 'world' });
    const header = sign(payload, SECRET, Math.floor(now().getTime() / 1000));
    expect(verifyWebhookSignature(payload, header, SECRET, 300, now)).toBe(true);
  });

  it('rejects a payload signed with the wrong secret', () => {
    const payload = JSON.stringify({ hello: 'world' });
    const header = sign(payload, 'whsec_wrong', Math.floor(now().getTime() / 1000));
    expect(verifyWebhookSignature(payload, header, SECRET, 300, now)).toBe(false);
  });

  it('rejects a tampered payload', () => {
    const header = sign(JSON.stringify({ hello: 'world' }), SECRET, Math.floor(now().getTime() / 1000));
    expect(verifyWebhookSignature(JSON.stringify({ hello: 'tampered' }), header, SECRET, 300, now)).toBe(false);
  });

  it('rejects a stale timestamp outside the tolerance window', () => {
    const payload = JSON.stringify({ hello: 'world' });
    const oldTimestamp = Math.floor(now().getTime() / 1000) - 600;
    const header = sign(payload, SECRET, oldTimestamp);
    expect(verifyWebhookSignature(payload, header, SECRET, 300, now)).toBe(false);
  });

  it('rejects a malformed header', () => {
    expect(verifyWebhookSignature('{}', 'not-a-real-header', SECRET, 300, now)).toBe(false);
  });
});

describe('applySubscriptionEvent', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
  });

  afterEach(() => {
    sqlite.close();
  });

  it('checkout.session.completed creates a subscription row and marks the user paid', () => {
    const userId = newId();
    db.insert(users).values({ id: userId, email: `${userId}@example.com` }).run();

    applySubscriptionEvent(db, { type: 'checkout.session.completed', data: { object: { client_reference_id: userId, subscription: 'sub_123' } } });

    const user = db.select().from(users).where(eq(users.id, userId)).all()[0];
    expect(user.plan).toBe('paid');
    const sub = db.select().from(subscriptions).where(eq(subscriptions.providerRef, 'sub_123')).all()[0];
    expect(sub.userId).toBe(userId);
    expect(sub.status).toBe('active');
  });

  it('customer.subscription.updated refreshes status and period end, syncing the user', () => {
    const userId = newId();
    db.insert(users).values({ id: userId, email: `${userId}@example.com` }).run();
    applySubscriptionEvent(db, { type: 'checkout.session.completed', data: { object: { client_reference_id: userId, subscription: 'sub_456' } } });

    const periodEndUnix = Math.floor(new Date('2026-07-01T00:00:00.000Z').getTime() / 1000);
    applySubscriptionEvent(db, { type: 'customer.subscription.updated', data: { object: { id: 'sub_456', status: 'active', current_period_end: periodEndUnix } } });

    const user = db.select().from(users).where(eq(users.id, userId)).all()[0];
    expect(user.plan).toBe('paid');
    expect(user.planExpiresAt).toBe('2026-07-01T00:00:00.000Z');
  });

  it('customer.subscription.deleted drops the user back to free', () => {
    const userId = newId();
    db.insert(users).values({ id: userId, email: `${userId}@example.com`, plan: 'paid' }).run();
    applySubscriptionEvent(db, { type: 'checkout.session.completed', data: { object: { client_reference_id: userId, subscription: 'sub_789' } } });

    applySubscriptionEvent(db, { type: 'customer.subscription.deleted', data: { object: { id: 'sub_789', status: 'canceled' } } });

    const user = db.select().from(users).where(eq(users.id, userId)).all()[0];
    expect(user.plan).toBe('free');
    expect(user.planExpiresAt).toBeNull();
    const sub = db.select().from(subscriptions).where(eq(subscriptions.providerRef, 'sub_789')).all()[0];
    expect(sub.status).toBe('canceled');
  });

  it('ignores an update for a subscription id it has never seen', () => {
    // Should not throw even with no matching row.
    expect(() => applySubscriptionEvent(db, { type: 'customer.subscription.updated', data: { object: { id: 'sub_unknown', status: 'active' } } })).not.toThrow();
  });

  it('ignores unrelated event types', () => {
    expect(() => applySubscriptionEvent(db, { type: 'invoice.paid', data: { object: {} } })).not.toThrow();
  });
});
