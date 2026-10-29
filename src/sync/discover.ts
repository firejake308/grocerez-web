/**
 * Home screen "discover" sample: before we know where the user is (or when
 * their own area has nothing to show), ask the server for the newest prices
 * anywhere, so the home screen shows real activity instead of an empty
 * state. For a free account the server returns full prices only for products
 * in the free set, plus a few price-less teasers for the rest -- the nudge
 * toward subscribing (plan section 6.3). One cheap request; no location needed.
 */
import type PriceData from '../PriceData';
import type { LockedSummary } from '../../shared/types';
import { communityToPriceData } from './engine';
import type { SyncApi } from './api';

export interface DiscoverSample {
  items: PriceData[];
  locked: LockedSummary[];
}

/** Best-effort: the caller treats a failure as "nothing to show". */
export async function fetchDiscover(api: SyncApi, token: string, count = 6): Promise<DiscoverSample> {
  const res = await api.discover(token, count);
  return {
    items: res.reports.filter((r) => r.status === 'active').map(communityToPriceData),
    locked: res.locked,
  };
}
