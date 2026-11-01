import { createHmac } from 'node:crypto';

/**
 * A fake Stripe for billing tests: inject `fake.fetch` as StripeConfig.fetch.
 * It records every request (headers + decoded form body) and answers the
 * handful of endpoints this app uses, with payload shapes taken from
 * Stripe's API reference. Individual endpoints can be told to fail.
 */

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  form: Record<string, string>;
}

export const GOOD_PRICE = {
  id: 'price_199',
  object: 'price',
  active: true,
  currency: 'usd',
  unit_amount: 199,
  type: 'recurring',
  recurring: { interval: 'month', interval_count: 1 },
  livemode: false,
};

export class FakeStripe {
  requests: RecordedRequest[] = [];
  price: Record<string, unknown> | null = { ...GOOD_PRICE };
  /** path prefix -> status to answer with instead of the normal response */
  failing = new Map<string, number>();
  /** paths that should throw a network error */
  networkDown = new Set<string>();
  private customers = new Map<string, string>(); // idempotency key -> customer id
  private n = 0;

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const form = Object.fromEntries(new URLSearchParams(typeof init?.body === 'string' ? init.body : ''));
    const method = init?.method ?? 'GET';
    this.requests.push({ method, path: url.pathname, headers, form });

    if (this.networkDown.has(url.pathname)) throw new TypeError('fetch failed');
    for (const [prefix, status] of this.failing) {
      if (url.pathname.startsWith(prefix)) return json({ error: { message: 'Stripe says no.' } }, status);
    }

    if (method === 'GET' && url.pathname.startsWith('/v1/prices/')) {
      return this.price ? json(this.price) : json({ error: { message: 'No such price' } }, 404);
    }
    if (method === 'POST' && url.pathname === '/v1/customers') {
      const key = headers['Idempotency-Key'] ?? `auto-${this.n++}`;
      if (!this.customers.has(key)) this.customers.set(key, `cus_${this.customers.size + 1}`);
      return json({ id: this.customers.get(key), object: 'customer' });
    }
    if (method === 'POST' && url.pathname === '/v1/checkout/sessions') {
      return json({ id: 'cs_test_1', object: 'checkout.session', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    }
    if (method === 'POST' && url.pathname === '/v1/billing_portal/sessions') {
      return json({ id: 'bps_1', object: 'billing_portal.session', url: 'https://billing.stripe.com/p/session/bps_1' });
    }
    return json({ error: { message: `Unexpected ${method} ${url.pathname}` } }, 500);
  };

  requestsTo(path: string): RecordedRequest[] {
    return this.requests.filter((r) => r.path === path);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// --- Webhook payload builders ------------------------------------------------

let eventCounter = 0;

export function signPayload(payload: string, secret: string, timestampSeconds: number): string {
  return `t=${timestampSeconds},v1=${createHmac('sha256', secret).update(`${timestampSeconds}.${payload}`).digest('hex')}`;
}

export interface SubscriptionOpts {
  id?: string;
  customer?: string;
  status?: string;
  userId?: string | null;
  cancelAtPeriodEnd?: boolean;
  /** Unix seconds. */
  periodEnd?: number;
  /** 'top' = classic API versions; 'items' = 2025-03-31.basil and later. */
  layout?: 'top' | 'items';
}

export function subscriptionObject(o: SubscriptionOpts = {}) {
  const periodEnd = o.periodEnd ?? Math.floor(Date.now() / 1000) + 30 * 86400;
  return {
    id: o.id ?? 'sub_1',
    object: 'subscription',
    customer: o.customer ?? 'cus_1',
    status: o.status ?? 'active',
    cancel_at_period_end: o.cancelAtPeriodEnd ?? false,
    metadata: o.userId === null ? {} : { user_id: o.userId ?? 'user-1' },
    ...(o.layout === 'items'
      ? { items: { data: [{ id: 'si_1', current_period_end: periodEnd, price: { id: 'price_199' } }] } }
      : { current_period_end: periodEnd }),
  };
}

export function stripeEvent(type: string, object: Record<string, unknown>, o: { id?: string; created?: number; livemode?: boolean } = {}) {
  return {
    id: o.id ?? `evt_${++eventCounter}`,
    object: 'event',
    type,
    created: o.created ?? Math.floor(Date.now() / 1000),
    livemode: o.livemode ?? false,
    data: { object },
  };
}

export function checkoutCompleted(userId: string, customer = 'cus_1', o: { id?: string; created?: number } = {}) {
  return stripeEvent('checkout.session.completed', { id: 'cs_test_1', object: 'checkout.session', mode: 'subscription', client_reference_id: userId, customer, subscription: 'sub_1' }, o);
}
