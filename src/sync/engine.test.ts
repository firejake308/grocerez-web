import { describe, it, expect } from 'vitest';
import type PriceData from '../PriceData';
import type { PriceReportPushResult, SyncedPriceReport } from '../../shared/types';
import { ApiError, type SyncApi } from './api';
import {
  applyPushResults,
  communityToPriceData,
  evictRegions,
  mergePull,
  patchSyncedReport,
  pendingReports,
  regionKey,
  runSync,
  toUpsert,
} from './engine';
import { memorySyncStorage } from './storage';

const report = (overrides: Partial<PriceData>): PriceData => ({
  id: 'r1',
  price: '2.99',
  store: 'Kroger @ 9150 North Tarrant Parkway',
  date: '2026-09-01',
  priceImage: null,
  productImage: null,
  itemName: 'Milk',
  brand: 'Kroger',
  tags: ['dairy'],
  quantity: 1,
  quantity_units: 'gallon',
  latitude: 32.9019798,
  longitude: -97.1889734,
  updatedAt: '2026-09-01T12:00:00.000Z',
  origin: 'mine',
  isSale: false,
  expiresAt: null,
  ...overrides,
});

const synced = (overrides: Partial<SyncedPriceReport>): SyncedPriceReport => ({
  id: 'c1',
  seq: 1,
  userId: 'someone-else',
  authorTier: 'established',
  productId: 'p1',
  storeId: 's1',
  storeName: 'Kroger',
  itemName: 'Cold Brew Coffee',
  brand: 'Stok',
  tags: ['coffee'],
  quantity: 48,
  quantityUnits: 'fluid ounce',
  priceCents: 679,
  observedDate: '2026-09-01',
  expiresAt: null,
  isSale: false,
  status: 'active',
  reviewReason: null,
  confirmCount: 0,
  isStale: false,
  myVote: null,
  updatedAt: '2026-09-01T12:00:00.000Z',
  ...overrides,
});

describe('pendingReports', () => {
  it('includes never-synced, edited-since-sync, and tombstoned own reports, never community ones', () => {
    const data = [
      report({ id: 'never' }),
      report({ id: 'stale', syncedAt: '2026-09-01T11:00:00.000Z' }),
      report({ id: 'fresh', syncedAt: '2026-09-01T12:00:00.000Z' }),
      report({ id: 'gone', syncedAt: '2026-09-01T12:00:00.000Z', deletedAt: '2026-09-02T00:00:00.000Z' }),
      report({ id: 'theirs', origin: 'community' }),
    ];
    expect(pendingReports(data).map((r) => r.id)).toEqual(['never', 'stale', 'gone']);
  });
});

describe('toUpsert', () => {
  it('maps the client shape to the wire shape', () => {
    expect(toUpsert(report({ quantity: 0, quantity_units: '' }))).toMatchObject({
      id: 'r1',
      price: '2.99',
      store: 'Kroger @ 9150 North Tarrant Parkway',
      observedDate: '2026-09-01',
      quantity: null,
      quantityUnits: null,
      latitude: 32.9019798,
      deletedAt: null,
      productId: null,
    });
  });

  it('carries a save-time-confirmed productId (plan section 8.4) so the server attaches directly instead of matching', () => {
    expect(toUpsert(report({ productId: 'confirmed-product-1' }))).toMatchObject({ productId: 'confirmed-product-1' });
  });
});

describe('applyPushResults', () => {
  const results: PriceReportPushResult[] = [
    { id: 'ok', status: 'active', productId: 'p9', storeId: 's9', seq: 3 },
    { id: 'bad', status: 'rejected', error: 'Could not parse price' },
    { id: 'gone', status: 'deleted' },
  ];

  it('stamps accepted reports, purges accepted tombstones, leaves rejected ones pending', () => {
    const next = applyPushResults(
      [report({ id: 'ok' }), report({ id: 'bad' }), report({ id: 'gone', deletedAt: 'x' }), report({ id: 'untouched' })],
      results,
      '2026-09-03T00:00:00.000Z',
    );
    expect(next.map((r) => r.id)).toEqual(['ok', 'bad', 'untouched']);
    expect(next[0]).toMatchObject({ syncedAt: '2026-09-03T00:00:00.000Z', productId: 'p9', storeId: 's9' });
    expect(next[1].syncedAt).toBeUndefined();
  });
});

describe('regionKey', () => {
  it('rounds to 0.1 degrees so nearby positions share a cursor', () => {
    expect(regionKey({ lat: 32.9019, lon: -97.1889 }, 50)).toBe('32.9,-97.2,50');
    expect(regionKey({ lat: 32.9019, lon: -97.1889 }, 50)).toBe(regionKey({ lat: 32.94, lon: -97.15 }, 50));
  });
});

describe('mergePull', () => {
  it('replaces by id, drops deleted/hidden, excludes own reports, keeps seq order', () => {
    const existing = [synced({ id: 'a', seq: 1 }), synced({ id: 'b', seq: 2, priceCents: 100 })];
    const incoming = [
      synced({ id: 'b', seq: 5, priceCents: 200 }), // newer version
      synced({ id: 'a', seq: 6, status: 'deleted' }),
      synced({ id: 'mine', seq: 7, userId: 'me' }),
      synced({ id: 'c', seq: 8, status: 'hidden' }),
      synced({ id: 'd', seq: 9 }),
    ];
    const merged = mergePull(existing, incoming, 'me');
    expect(merged.map((r) => [r.id, r.priceCents])).toEqual([
      ['b', 200],
      ['d', 679],
    ]);
  });
});

describe('communityToPriceData', () => {
  it('renders cents as a price string and marks the origin', () => {
    const pd = communityToPriceData(synced({ priceCents: 605, quantity: null, quantityUnits: null }));
    expect(pd).toMatchObject({ price: '6.05', store: 'Kroger', origin: 'community', authorTier: 'established', quantity: 1, quantity_units: '' });
  });

  it('carries the moderation fields badges are built from', () => {
    const pd = communityToPriceData(synced({ reviewReason: 'price_outlier', isStale: true, myVote: 'confirm' }));
    expect(pd).toMatchObject({ reviewReason: 'price_outlier', isStale: true, myVote: 'confirm' });
  });
});

describe('patchSyncedReport', () => {
  it('updates only the matching report', () => {
    const reports = [synced({ id: 'a', confirmCount: 0 }), synced({ id: 'b', confirmCount: 0 })];
    const patched = patchSyncedReport(reports, 'a', { confirmCount: 1, myVote: 'confirm' });
    expect(patched.find((r) => r.id === 'a')).toMatchObject({ confirmCount: 1, myVote: 'confirm' });
    expect(patched.find((r) => r.id === 'b')).toMatchObject({ confirmCount: 0, myVote: null });
  });

  it('is a no-op for an id that is not cached', () => {
    const reports = [synced({ id: 'a' })];
    expect(patchSyncedReport(reports, 'nope', { confirmCount: 5 })).toEqual(reports);
  });
});

describe('evictRegions', () => {
  it('keeps the two most recently used regions', () => {
    const regions = {
      old: { since: 1, reports: [], lastUsedAt: '2026-01-01T00:00:00.000Z' },
      mid: { since: 1, reports: [], lastUsedAt: '2026-06-01T00:00:00.000Z' },
      new: { since: 1, reports: [], lastUsedAt: '2026-09-01T00:00:00.000Z' },
    };
    expect(Object.keys(evictRegions(regions)).sort()).toEqual(['mid', 'new']);
  });
});

describe('runSync', () => {
  const fakeApi = (overrides: Partial<SyncApi> = {}) => {
    const calls: { name: string; args: unknown[] }[] = [];
    const record = <T>(name: string, impl: (...args: never[]) => T) =>
      ((...args: unknown[]) => {
        calls.push({ name, args });
        return (impl as (...a: unknown[]) => T)(...args);
      }) as never;
    const api: SyncApi = {
      registerDevice: record('registerDevice', async () => ({ deviceToken: 'dev-1' })),
      requestCode: record('requestCode', async () => ({ ok: true as const })),
      verifyCode: record('verifyCode', async () => ({ userId: 'u', sessionToken: 't', expiresAt: '' })),
      signOut: record('signOut', async () => ({ ok: true as const })),
      getMe: record('getMe', async () => { throw new Error('unused'); }),
      patchMe: record('patchMe', async () => { throw new Error('unused'); }),
      push: record('push', async (_t: string, reports: { id: string }[]) => ({
        results: reports.map((r) => ({ id: r.id, status: 'active' as const, productId: 'p', storeId: 's', seq: 1 })),
      })),
      pull: record('pull', async () => ({ accessLevel: 'unrestricted' as const, reports: [synced({ id: 'c1', seq: 1 })], locked: [], nextSince: 1 })),
      nearbyStores: record('nearbyStores', async () => ({ stores: [] })),
      reverse: record('reverse', async () => ({ houseNumber: null, road: null, suburb: null, label: null })),
      geocode: record('geocode', async () => ({ results: [] })),
      confirmReport: record('confirmReport', async () => { throw new Error('unused'); }),
      flagReport: record('flagReport', async () => { throw new Error('unused'); }),
      removeVote: record('removeVote', async () => { throw new Error('unused'); }),
      matchProduct: record('matchProduct', async () => ({ candidates: [] })),
      productPrices: record('productPrices', async () => { throw new Error('unused'); }),
      parseImages: record('parseImages', async () => { throw new Error('unused'); }),
      checkoutSubscription: record('checkoutSubscription', async () => { throw new Error('unused'); }),
      openBillingPortal: record('openBillingPortal', async () => { throw new Error('unused'); }),
      redeemCredits: record('redeemCredits', async () => { throw new Error('unused'); }),
      ...overrides,
    };
    return { api, calls };
  };

  const deps = (api: SyncApi, initial: PriceData[], signedIn: boolean, location: { lat: number; lon: number } | null = { lat: 32.9, lon: -97.2 }) => {
    const storage = memorySyncStorage();
    if (signedIn) storage.setAuth({ sessionToken: 'sess', userId: 'me', email: 'me@example.com' });
    let data = initial;
    return {
      storage,
      getData: () => data,
      deps: {
        api,
        storage,
        getPriceData: () => data,
        setPriceData: (update: (c: PriceData[]) => PriceData[]) => { data = update(data); },
        getLocation: async () => location,
        radiusMi: 50,
        now: () => new Date('2026-09-10T00:00:00.000Z'),
      },
    };
  };

  it('anonymous: registers a device, skips push, pulls the region into the cache', async () => {
    const { api, calls } = fakeApi();
    const d = deps(api, [report({ id: 'local' })], false);
    const summary = await runSync(d.deps);
    expect(calls.map((c) => c.name)).toEqual(['registerDevice', 'pull']);
    expect(d.storage.getDeviceToken()).toBe('dev-1');
    expect(summary.signedIn).toBe(false);
    expect(summary.pushed).toBe(0);
    expect(summary.community.map((r) => r.id)).toEqual(['c1']);
    expect(d.storage.getRegions()['32.9,-97.2,50'].since).toBe(1);
    expect(d.storage.getLastSyncedAt()).toBe('2026-09-10T00:00:00.000Z');
    expect(d.getData()[0].syncedAt).toBeUndefined(); // nothing was pushed
  });

  it('signed in: pushes pending reports first, stamps them, then pulls with the session token', async () => {
    const { api, calls } = fakeApi();
    const d = deps(api, [report({ id: 'local' }), report({ id: 'done', syncedAt: '2026-09-02T00:00:00.000Z' })], true);
    d.storage.setDeviceToken('dev-1'); // every install has one; runSync registers it otherwise
    const summary = await runSync(d.deps);
    expect(calls.map((c) => c.name)).toEqual(['push', 'pull']);
    expect((calls[0].args[1] as { id: string }[]).map((r) => r.id)).toEqual(['local']);
    expect(calls[1].args[0]).toBe('sess');
    expect(summary.pushed).toBe(1);
    expect(d.getData().find((r) => r.id === 'local')?.syncedAt).toBe('2026-09-10T00:00:00.000Z');
  });

  it('resumes the pull from the stored cursor for a known region', async () => {
    const { api, calls } = fakeApi();
    const d = deps(api, [], false);
    d.storage.setDeviceToken('dev-1');
    d.storage.setRegions({ '32.9,-97.2,50': { since: 41, reports: [synced({ id: 'old', seq: 40 })], lastUsedAt: '2026-09-01T00:00:00.000Z' } });
    const summary = await runSync(d.deps);
    expect((calls[0].args[1] as { since: number }).since).toBe(41);
    expect(summary.community.map((r) => r.id).sort()).toEqual(['c1', 'old']);
  });

  it('keeps a previously-seen locked summary when a later sync finds nothing new (section 6.3)', async () => {
    const locked1 = { productId: 'p1', canonicalName: 'Olipop', storeCount: 1, reportCount: 1, newestDate: '2026-06-01' };
    const { api } = fakeApi({
      pull: async () => ({ accessLevel: 'public' as const, reports: [], locked: [locked1], nextSince: 1 }),
    });
    const d = deps(api, [], false);
    const first = await runSync(d.deps);
    expect(first.locked).toEqual([locked1]);

    // A second sync with the cursor already at 1 finds nothing new -- the locked cache must not be wiped.
    const d2 = { ...d.deps, api: { ...api, pull: async () => ({ accessLevel: 'public' as const, reports: [], locked: [], nextSince: 1 }) } };
    const second = await runSync(d2);
    expect(second.locked).toEqual([locked1]);
  });

  it('drops a product from the locked cache once a full report for it arrives', async () => {
    const locked1 = { productId: 'p1', canonicalName: 'Olipop', storeCount: 1, reportCount: 1, newestDate: '2026-06-01' };
    const { api } = fakeApi({
      pull: async () => ({ accessLevel: 'public' as const, reports: [], locked: [locked1], nextSince: 1 }),
    });
    const d = deps(api, [], false);
    const first = await runSync(d.deps);
    expect(first.locked).toEqual([locked1]);

    // The product entered the free set: now a real report for it comes back instead of a locked summary.
    const d2 = {
      ...d.deps,
      api: { ...api, pull: async () => ({ accessLevel: 'public' as const, reports: [synced({ id: 'r1', seq: 2, productId: 'p1' })], locked: [], nextSince: 2 }) },
    };
    const second = await runSync(d2);
    expect(second.locked).toEqual([]);
    expect(second.community.map((r) => r.id)).toEqual(['r1']);
  });

  describe('when the caller\'s access level changes', () => {
    const locked1 = { productId: 'p1', canonicalName: 'Olipop', storeCount: 1, reportCount: 1, newestDate: '2026-06-01' };

    /** A pull that answers by `since`: honours a cursor like the real server, and returns full data only when `level` isn't public. */
    const serverAt = (level: 'public' | 'subscriber') => async (_t: string, q: { since: number }) => {
      if (level === 'public') return { accessLevel: 'public' as const, reports: [], locked: q.since === 0 ? [locked1] : [], nextSince: 1 };
      return { accessLevel: 'subscriber' as const, reports: q.since === 0 ? [synced({ id: 'r1', seq: 1, productId: 'p1' })] : [], locked: [], nextSince: 1 };
    };

    it('rebuilds from the start after subscribing, so reports withheld while locked finally arrive', async () => {
      const { api, calls } = fakeApi({ pull: serverAt('public') });
      const d = deps(api, [], false);
      const first = await runSync(d.deps);
      expect(first.locked).toEqual([locked1]);
      expect(first.community).toEqual([]);

      // They subscribe. A plain delta from since=1 would return nothing -- the old report was never queued for them.
      const subscribed = { ...api, pull: serverAt('subscriber') };
      calls.length = 0;
      const second = await runSync({ ...d.deps, api: subscribed });
      expect(second.community.map((r) => r.id)).toEqual(['r1']);
      expect(second.locked).toEqual([]);
      expect(d.storage.getRegions()['32.9,-97.2,50'].since).toBe(1);
      expect(d.storage.getRegions()['32.9,-97.2,50'].accessLevel).toBe('subscriber');
    });

    it('rebuilds after a subscription lapses, dropping prices that are locked again', async () => {
      const { api } = fakeApi({ pull: serverAt('subscriber') });
      const d = deps(api, [], false);
      expect((await runSync(d.deps)).community.map((r) => r.id)).toEqual(['r1']);

      const lapsed = await runSync({ ...d.deps, api: { ...api, pull: serverAt('public') } });
      expect(lapsed.community).toEqual([]);
      expect(lapsed.locked).toEqual([locked1]);
    });

    it('does not rebuild when the level is unchanged -- the cursor is honoured', async () => {
      const seen: number[] = [];
      const { api } = fakeApi({ pull: async (t, q) => { seen.push(q.since); return serverAt('subscriber')(t, q); } });
      const d = deps(api, [], false);
      await runSync(d.deps);
      await runSync(d.deps);
      expect(seen).toEqual([0, 1]);
    });

    it('adopts the level without a rebuild for a cache saved before levels were recorded', async () => {
      const seen: number[] = [];
      const { api } = fakeApi({ pull: async (t, q) => { seen.push(q.since); return serverAt('subscriber')(t, q); } });
      const d = deps(api, [], false);
      d.storage.setRegions({ '32.9,-97.2,50': { since: 41, reports: [synced({ id: 'old', seq: 40 })], lastUsedAt: '2026-09-01T00:00:00.000Z' } });
      const summary = await runSync(d.deps);
      expect(seen).toEqual([41]);
      expect(summary.community.map((r) => r.id)).toEqual(['old']);
      expect(d.storage.getRegions()['32.9,-97.2,50'].accessLevel).toBe('subscriber');
    });

    it('rebuilds when a product enters the free set, so a report first seen while locked finally arrives', async () => {
      // Server: p1 is locked at fingerprint "a"; once it enters the free set (fingerprint "b") the old report is behind the cursor.
      const at = (freeSet: string) => async (_t: string, q: { since: number }) =>
        freeSet === 'a'
          ? { accessLevel: 'public' as const, reports: [], locked: q.since === 0 ? [locked1] : [], nextSince: 1, freeSet }
          : { accessLevel: 'public' as const, reports: q.since === 0 ? [synced({ id: 'r1', seq: 1, productId: 'p1' })] : [], locked: [], nextSince: 1, freeSet };
      const { api } = fakeApi({ pull: at('a') });
      const d = deps(api, [], false);
      const first = await runSync(d.deps);
      expect(first.locked).toEqual([locked1]);

      const second = await runSync({ ...d.deps, api: { ...api, pull: at('b') } });
      expect(second.community.map((r) => r.id)).toEqual(['r1']);
      expect(second.locked).toEqual([]);
      expect(d.storage.getRegions()['32.9,-97.2,50'].freeSet).toBe('b');
    });

    it('keeps using the cursor while the free set is unchanged', async () => {
      const seen: number[] = [];
      const { api } = fakeApi({ pull: async (_t, q) => { seen.push(q.since); return { accessLevel: 'public' as const, reports: [], locked: [], nextSince: 1, freeSet: 'a' }; } });
      const d = deps(api, [], false);
      await runSync(d.deps);
      await runSync(d.deps);
      expect(seen).toEqual([0, 1]);
    });

    it('does not rebuild for a server that sends no fingerprint (older servers) or null', async () => {
      const seen: number[] = [];
      const { api } = fakeApi({ pull: async (_t, q) => { seen.push(q.since); return { accessLevel: 'subscriber' as const, reports: [], locked: [], nextSince: 1 }; } });
      const d = deps(api, [], false);
      await runSync(d.deps);
      await runSync(d.deps);
      expect(seen).toEqual([0, 1]);
    });

    it.each([['omits it', undefined], ['sends null', null]])('does not rebuild when the cache has a fingerprint but the server %s (e.g. a rolled-back server)', async (_name, freeSet) => {
      const seen: number[] = [];
      const { api } = fakeApi({ pull: async (_t, q) => { seen.push(q.since); return { accessLevel: 'public' as const, reports: [], locked: [], nextSince: 5, ...(freeSet === undefined ? {} : { freeSet }) }; } });
      const d = deps(api, [], false);
      d.storage.setRegions({ '32.9,-97.2,50': { since: 5, reports: [synced({ id: 'old', seq: 4 })], accessLevel: 'public', freeSet: 'a', lastUsedAt: '2026-09-01T00:00:00.000Z' } });
      const summary = await runSync(d.deps);
      expect(seen).toEqual([5]);
      expect(summary.community.map((r) => r.id)).toEqual(['old']);
    });

    it('rebuilds at most once per sync even if the level keeps flip-flopping', async () => {
      let n = 0;
      const { api } = fakeApi({ pull: async (_t, q) => ({ accessLevel: (n++ % 2 === 0 ? 'public' : 'subscriber') as 'public' | 'subscriber', reports: [], locked: [], nextSince: q.since + 1 }) });
      const d = deps(api, [], false);
      d.storage.setRegions({ '32.9,-97.2,50': { since: 5, reports: [], accessLevel: 'unrestricted', lastUsedAt: '2026-09-01T00:00:00.000Z' } });
      await runSync(d.deps);
      expect(n).toBeLessThanOrEqual(3);
    });
  });

  it('signs out locally and continues as a device when the session is rejected', async () => {
    const { api, calls } = fakeApi({ push: async () => { throw new ApiError(401, 'Sign-in required'); } });
    const d = deps(api, [report({ id: 'local' })], true);
    d.storage.setDeviceToken('dev-1');
    const summary = await runSync(d.deps);
    expect(d.storage.getAuth()).toBeNull();
    expect(summary.signedIn).toBe(false);
    expect(calls.find((c) => c.name === 'pull')?.args[0]).toBe('dev-1');
  });

  it('reports rejected reports and leaves them pending', async () => {
    const { api } = fakeApi({
      push: async (_t, reports) => ({ results: reports.map((r) => ({ id: r.id, status: 'rejected' as const, error: 'Could not parse price "$1 off".' })) }),
    });
    const d = deps(api, [report({ id: 'junk', price: '$1 off' })], true);
    const summary = await runSync(d.deps);
    expect(summary.rejected).toEqual([{ id: 'junk', error: 'Could not parse price "$1 off".' }]);
    expect(d.getData()[0].syncedAt).toBeUndefined();
  });

  it('skips the pull but still pushes when no location can be determined', async () => {
    const { api, calls } = fakeApi();
    const d = deps(api, [report({ id: 'local' })], true, null);
    d.storage.setDeviceToken('dev-1');
    const summary = await runSync(d.deps);
    expect(calls.map((c) => c.name)).toEqual(['push']);
    expect(summary.skippedPull).toBe('no-location');
    expect(summary.pushed).toBe(1);
  });

  it('surfaces a server outage as an error rather than swallowing it', async () => {
    const { api } = fakeApi({ pull: async () => { throw new TypeError('Failed to fetch'); } });
    const d = deps(api, [], false);
    await expect(runSync(d.deps)).rejects.toThrow('Failed to fetch');
  });
});
