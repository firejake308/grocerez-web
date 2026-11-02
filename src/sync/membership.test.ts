import { describe, it, expect } from 'vitest';
import type { Profile } from './api';
import { describeMembership, formatMonthlyPrice } from './membership';

const base: Profile['entitlement'] = {
  enforced: true,
  level: 'public',
  billingConfigured: true,
  priceCents: 199,
  plan: 'free',
  planExpiresAt: null,
  subscription: null,
  creditAccessUntil: null,
  credits: { balance: 0, perReport: 10, perFreeMonth: 200, expiryDays: 90 },
};

describe('formatMonthlyPrice', () => {
  it('formats cents as dollars', () => {
    expect(formatMonthlyPrice(199)).toBe('$1.99/month');
    expect(formatMonthlyPrice(500)).toBe('$5.00/month');
    expect(formatMonthlyPrice()).toBe('$1.99/month');
  });
});

describe('describeMembership', () => {
  it('a public user can subscribe but not redeem', () => {
    const m = describeMembership(base);
    expect(m).toMatchObject({ subscribed: false, canSubscribe: true, canRedeem: false, canManageBilling: false, creditsToGo: 200, creditPercent: 0 });
  });

  it('cannot subscribe when billing is not configured on the server', () => {
    expect(describeMembership({ ...base, billingConfigured: false }).canSubscribe).toBe(false);
  });

  it('can redeem at exactly 200 credits and not at 190', () => {
    expect(describeMembership({ ...base, credits: { ...base.credits, balance: 190 } })).toMatchObject({ canRedeem: false, creditsToGo: 10, creditPercent: 95 });
    expect(describeMembership({ ...base, credits: { ...base.credits, balance: 200 } })).toMatchObject({ canRedeem: true, creditsToGo: 0, creditPercent: 100 });
  });

  it('caps the progress bar at 100% for balances above 200', () => {
    expect(describeMembership({ ...base, credits: { ...base.credits, balance: 340 } }).creditPercent).toBe(100);
  });

  it('a subscriber sees renewal details and the billing portal, and can neither subscribe again nor redeem', () => {
    const m = describeMembership({
      ...base,
      level: 'subscriber',
      subscription: { status: 'active', currentPeriodEnd: '2026-12-01T00:00:00.000Z', cancelAtPeriodEnd: false },
      credits: { ...base.credits, balance: 300 },
    });
    expect(m).toMatchObject({ subscribed: true, canManageBilling: true, canSubscribe: false, canRedeem: false, renewal: { date: '2026-12-01T00:00:00.000Z', ending: false } });
  });

  it('flags a subscription that will end at the period end', () => {
    const m = describeMembership({ ...base, level: 'subscriber', subscription: { status: 'active', currentPeriodEnd: '2026-12-01T00:00:00.000Z', cancelAtPeriodEnd: true } });
    expect(m.renewal?.ending).toBe(true);
  });

  it('a subscriber with no Stripe subscription row has no portal to open', () => {
    expect(describeMembership({ ...base, level: 'subscriber' }).canManageBilling).toBe(false);
  });

  it('a free-month user sees when it ends and can still subscribe', () => {
    const m = describeMembership({ ...base, level: 'contributor', creditAccessUntil: '2026-11-15T00:00:00.000Z' });
    expect(m).toMatchObject({ freeMonthUntil: '2026-11-15T00:00:00.000Z', canSubscribe: true, subscribed: false });
  });
});
