import type { Profile } from './api';

type Entitlement = Profile['entitlement'];

/** Shown before the profile has loaded; the server's `priceCents` replaces it. */
export const DEFAULT_PRICE_CENTS = 199;

export const formatMonthlyPrice = (cents: number = DEFAULT_PRICE_CENTS): string => `$${(cents / 100).toFixed(2)}/month`;

export const formatDate = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/** What the Membership card should show, derived from the server's entitlement summary. */
export function describeMembership(e: Entitlement) {
  const sub = e.subscription;
  const subscribed = e.level === 'subscriber';
  const percent = Math.min(100, Math.round((e.credits.balance / e.credits.perFreeMonth) * 100));
  return {
    subscribed,
    freeMonthUntil: e.level === 'contributor' ? e.creditAccessUntil : null,
    renewal: subscribed && sub?.currentPeriodEnd ? { date: sub.currentPeriodEnd, ending: sub.cancelAtPeriodEnd } : null,
    // Only a subscriber with a Stripe subscription has a billing portal to open.
    canManageBilling: subscribed && !!sub,
    canSubscribe: !subscribed && e.billingConfigured,
    canRedeem: !subscribed && e.credits.balance >= e.credits.perFreeMonth,
    creditPercent: percent,
    creditsToGo: Math.max(0, e.credits.perFreeMonth - e.credits.balance),
  };
}
