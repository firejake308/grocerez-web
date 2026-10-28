import { describe, it, expect } from 'vitest';
import type { SyncedPriceReport, LockedSummary } from '../../shared/types';
import type { SyncApi } from './api';
import { fetchDiscover } from './discover';

const synced = (o: Partial<SyncedPriceReport>): SyncedPriceReport => ({
  id: 'r1', seq: 1, userId: 'u', authorTier: 'new', productId: 'p1', storeId: 's1', storeName: 'Kroger', itemName: 'Milk', brand: '', tags: [],
  quantity: 1, quantityUnits: 'gallon', priceCents: 349, observedDate: '2026-10-20', expiresAt: null, isSale: false, status: 'active',
  reviewReason: null, confirmCount: 0, isStale: false, myVote: null, updatedAt: '2026-10-20T00:00:00.000Z', ...o,
});

const apiReturning = (reports: SyncedPriceReport[], locked: LockedSummary[] = []) =>
  ({ discover: async () => ({ accessLevel: 'public' as const, reports, locked }) }) as unknown as SyncApi;

describe('fetchDiscover', () => {
  it('maps reports to community PriceData with the price formatted, and passes teasers through', async () => {
    const teaser = { productId: 'p2', canonicalName: 'Olipop', storeCount: 2, reportCount: 3, newestDate: '2026-10-20' };
    const sample = await fetchDiscover(apiReturning([synced({})], [teaser]), 'tok');
    expect(sample.items).toHaveLength(1);
    expect(sample.items[0]).toMatchObject({ itemName: 'Milk', price: '3.49', store: 'Kroger', origin: 'community' });
    expect(sample.locked).toEqual([teaser]);
  });

  it('drops anything that is not active', async () => {
    const sample = await fetchDiscover(apiReturning([synced({ id: 'a' }), synced({ id: 'b', status: 'hidden' })]), 'tok');
    expect(sample.items.map((i) => i.id)).toEqual(['a']);
  });

  it('asks the server for the requested number of items and passes the token', async () => {
    const calls: unknown[][] = [];
    const api = { discover: async (...args: unknown[]) => { calls.push(args); return { accessLevel: 'public', reports: [], locked: [] }; } } as unknown as SyncApi;
    await fetchDiscover(api, 'tok', 4);
    expect(calls).toEqual([['tok', 4]]);
  });

  it('lets a failure propagate so the caller can treat it as "nothing to show"', async () => {
    const api = { discover: async () => { throw new Error('offline'); } } as unknown as SyncApi;
    await expect(fetchDiscover(api, 'tok')).rejects.toThrow('offline');
  });
});
