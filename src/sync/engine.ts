/**
 * The sync engine (docs/server-sync-plan.md section 7). Pure functions plus
 * one orchestrator, `runSync`, that takes every side effect as a dependency
 * (API client, storage, location) so it can be tested without a browser.
 */
import type PriceData from '../PriceData';
import type { LockedSummary, PriceReportPushResult, PriceReportUpsert, SyncedPriceReport } from '../../shared/types';
import { ApiError, type SyncApi } from './api';
import type { RegionCache, SyncStorage } from './storage';

export interface Point {
  lat: number;
  lon: number;
}

const PUSH_BATCH = 200;
const PULL_PAGE = 500;
const MAX_PULL_PAGES = 20;
const MAX_REGIONS = 2;

/** Own reports that the server hasn't seen in their current version, including tombstones. */
export function pendingReports(priceData: PriceData[]): PriceData[] {
  return priceData.filter((r) => {
    if (r.origin === 'community') return false;
    if (r.deletedAt) return true;
    if (!r.syncedAt) return true;
    return Date.parse(r.updatedAt) > Date.parse(r.syncedAt);
  });
}

export function toUpsert(item: PriceData): PriceReportUpsert {
  return {
    id: item.id,
    itemName: item.itemName,
    brand: item.brand ?? '',
    tags: item.tags ?? [],
    quantity: typeof item.quantity === 'number' && item.quantity > 0 ? item.quantity : null,
    quantityUnits: item.quantity_units || null,
    price: item.price,
    store: item.store,
    latitude: typeof item.latitude === 'number' ? item.latitude : null,
    longitude: typeof item.longitude === 'number' ? item.longitude : null,
    observedDate: item.date,
    expiresAt: item.expiresAt ?? null,
    isSale: item.isSale ?? false,
    updatedAt: item.updatedAt,
    deletedAt: item.deletedAt ?? null,
    // Set when the save-time match prompt (section 8.4) confirmed this is an
    // existing product; the server attaches directly instead of matching.
    productId: item.productId ?? null,
  };
}

/**
 * Folds push results back into local state: accepted reports get
 * `syncedAt` and their server ids; accepted tombstones are purged; rejected
 * reports are left untouched (still pending, surfaced in the settings
 * screen).
 */
export function applyPushResults(current: PriceData[], results: PriceReportPushResult[], nowIso: string): PriceData[] {
  const byId = new Map(results.map((r) => [r.id, r]));
  return current.flatMap((item) => {
    const result = byId.get(item.id);
    if (!result) return [item];
    if (result.status === 'rejected') return [item];
    if (result.status === 'deleted') return [];
    return [
      {
        ...item,
        syncedAt: nowIso,
        productId: result.productId ?? item.productId,
        storeId: result.storeId ?? item.storeId,
      },
    ];
  });
}

/** Cursor/cache key: center rounded to 0.1 degrees plus radius (plan section 7). */
export function regionKey(point: Point, radiusMi: number): string {
  return `${point.lat.toFixed(1)},${point.lon.toFixed(1)},${radiusMi}`;
}

/**
 * Merges a pull page into a region's cache: newer versions replace by id,
 * non-active reports (deleted, hidden) are dropped, and the caller's own
 * reports are excluded since those live in `priceData` already.
 */
export function mergePull(existing: SyncedPriceReport[], incoming: SyncedPriceReport[], ownUserId: string | null): SyncedPriceReport[] {
  const byId = new Map(existing.map((r) => [r.id, r]));
  for (const report of incoming) {
    if (report.status !== 'active' || (ownUserId && report.userId === ownUserId)) {
      byId.delete(report.id);
      continue;
    }
    byId.set(report.id, report);
  }
  return Array.from(byId.values()).sort((a, b) => a.seq - b.seq);
}

export function communityToPriceData(report: SyncedPriceReport): PriceData {
  return {
    id: report.id,
    price: (report.priceCents / 100).toFixed(2),
    store: report.storeName,
    date: report.observedDate,
    priceImage: null,
    productImage: null,
    itemName: report.itemName,
    brand: report.brand,
    tags: report.tags,
    quantity: report.quantity ?? 1,
    quantity_units: report.quantityUnits ?? '',
    latitude: null,
    longitude: null,
    updatedAt: report.updatedAt,
    origin: 'community',
    isSale: report.isSale,
    expiresAt: report.expiresAt,
    userId: report.userId,
    productId: report.productId,
    storeId: report.storeId,
    syncedAt: report.updatedAt,
    authorTier: report.authorTier,
    confirmCount: report.confirmCount,
    reviewReason: report.reviewReason,
    isStale: report.isStale,
    myVote: report.myVote,
  };
}

/** Applies a vote's resulting counts to one cached report, wherever it's cached. Used to reflect confirm/flag/withdraw immediately, without waiting for the next pull. */
export function patchSyncedReport(
  reports: SyncedPriceReport[],
  reportId: string,
  patch: Partial<Pick<SyncedPriceReport, 'status' | 'reviewReason' | 'confirmCount' | 'myVote'>>,
): SyncedPriceReport[] {
  return reports.map((r) => (r.id === reportId ? { ...r, ...patch } : r));
}

/** Drops the least-recently-used regions beyond the cap. */
export function evictRegions(regions: Record<string, RegionCache>, max = MAX_REGIONS): Record<string, RegionCache> {
  const entries = Object.entries(regions).sort((a, b) => b[1].lastUsedAt.localeCompare(a[1].lastUsedAt));
  return Object.fromEntries(entries.slice(0, max));
}

export interface SyncDeps {
  api: SyncApi;
  storage: SyncStorage;
  getPriceData: () => PriceData[];
  setPriceData: (update: (current: PriceData[]) => PriceData[]) => void;
  /** Device position if already granted, else last located report, else home area, else null. */
  getLocation: () => Promise<Point | null>;
  radiusMi: number;
  now?: () => Date;
}

export interface SyncSummary {
  signedIn: boolean;
  pushed: number;
  rejected: { id: string; error: string }[];
  pulled: number;
  location: Point | null;
  /** Set when the pull was skipped because no location could be determined. */
  skippedPull: 'no-location' | null;
  community: PriceData[];
  /** Section 6.3: products outside the free set for a 'public'-level caller, deduped by product across pull pages. Always empty while ENTITLEMENTS_ENFORCED is off. */
  locked: LockedSummary[];
}

/** The community reports for the region last synced, as PriceData, from cache. */
export function cachedCommunity(storage: SyncStorage): PriceData[] {
  const key = storage.getCurrentRegionKey();
  if (!key) return [];
  const region = storage.getRegions()[key];
  return region ? region.reports.map(communityToPriceData) : [];
}

/** The locked summaries for the region last synced, from cache (see RegionCache.locked). */
export function cachedLocked(storage: SyncStorage): LockedSummary[] {
  const key = storage.getCurrentRegionKey();
  if (!key) return [];
  return storage.getRegions()[key]?.locked ?? [];
}

async function ensureDeviceToken(deps: SyncDeps): Promise<string> {
  const existing = deps.storage.getDeviceToken();
  if (existing) return existing;
  const { deviceToken } = await deps.api.registerDevice();
  deps.storage.setDeviceToken(deviceToken);
  return deviceToken;
}

/**
 * One full sync: push pending own reports (if signed in), then pull the
 * region around the best-known location and refresh the community cache.
 * Throws only on failures that mean the whole run should be reported as an
 * error; a session that the server no longer accepts is handled by signing
 * out locally and continuing as an anonymous device.
 */
export async function runSync(deps: SyncDeps): Promise<SyncSummary> {
  const now = deps.now ?? (() => new Date());
  const deviceToken = await ensureDeviceToken(deps);

  let auth = deps.storage.getAuth();
  let pushed = 0;
  const rejected: { id: string; error: string }[] = [];

  if (auth) {
    const pending = pendingReports(deps.getPriceData());
    for (let i = 0; i < pending.length; i += PUSH_BATCH) {
      const batch = pending.slice(i, i + PUSH_BATCH).map(toUpsert);
      let results: PriceReportPushResult[];
      try {
        ({ results } = await deps.api.push(auth.sessionToken, batch));
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          // Session expired or revoked: drop it and carry on as a device.
          deps.storage.setAuth(null);
          auth = null;
          break;
        }
        throw err;
      }
      const stamp = now().toISOString();
      deps.setPriceData((current) => applyPushResults(current, results, stamp));
      for (const r of results) {
        if (r.status === 'rejected') rejected.push({ id: r.id, error: r.error ?? 'Rejected' });
        else pushed++;
      }
    }
  }

  const token = auth?.sessionToken ?? deviceToken;
  const location = await deps.getLocation();
  if (!location) {
    return { signedIn: Boolean(auth), pushed, rejected, pulled: 0, location: null, skippedPull: 'no-location', community: cachedCommunity(deps.storage), locked: cachedLocked(deps.storage) };
  }

  const key = regionKey(location, deps.radiusMi);
  const regions = deps.storage.getRegions();
  const region: RegionCache = regions[key] ?? { since: 0, reports: [], lastUsedAt: now().toISOString() };
  let pulled = 0;
  // Seeded from cache and merged (not replaced) across pages/syncs: a pull
  // only resends a locked summary for products in this call's delta since
  // the cursor, so a resync with nothing new must not wipe out what's
  // already known to be locked (see RegionCache.locked).
  const lockedById = new Map<string, LockedSummary>((region.locked ?? []).map((l) => [l.productId, l]));

  for (let page = 0; page < MAX_PULL_PAGES; page++) {
    const res = await deps.api.pull(token, { since: region.since, lat: location.lat, lon: location.lon, radiusMi: deps.radiusMi, limit: PULL_PAGE });
    region.reports = mergePull(region.reports, res.reports, auth?.userId ?? null);
    pulled += res.reports.length;
    for (const summary of res.locked) lockedById.set(summary.productId, summary);
    // A product that now arrives as a full report is no longer locked (it entered the free set, or the caller's level changed).
    for (const report of res.reports) lockedById.delete(report.productId);
    const advanced = res.nextSince > region.since;
    region.since = Math.max(region.since, res.nextSince);
    if (!advanced || res.reports.length < PULL_PAGE) break;
  }

  region.lastUsedAt = now().toISOString();
  region.locked = [...lockedById.values()];
  deps.storage.setRegions(evictRegions({ ...regions, [key]: region }));
  deps.storage.setCurrentRegionKey(key);
  deps.storage.setLastSyncedAt(now().toISOString());

  return {
    signedIn: Boolean(auth),
    pushed,
    rejected,
    pulled,
    location,
    skippedPull: null,
    community: region.reports.map(communityToPriceData),
    locked: region.locked,
  };
}
