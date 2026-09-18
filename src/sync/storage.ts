import type { SyncedPriceReport } from '../../shared/types';

export interface SyncAuth {
  sessionToken: string;
  userId: string;
  email: string;
  displayName?: string | null;
}

export interface HomeArea {
  label: string;
  lat: number;
  lon: number;
}

/** One geo region's pull cursor and cached community reports (plan section 7: at most two regions kept). */
export interface RegionCache {
  since: number;
  reports: SyncedPriceReport[];
  lastUsedAt: string;
}

/** Everything the sync engine persists between runs. Swappable so tests use an in-memory copy. */
export interface SyncStorage {
  getAuth(): SyncAuth | null;
  setAuth(auth: SyncAuth | null): void;
  getDeviceToken(): string | null;
  setDeviceToken(token: string | null): void;
  getRegions(): Record<string, RegionCache>;
  setRegions(regions: Record<string, RegionCache>): void;
  getCurrentRegionKey(): string | null;
  setCurrentRegionKey(key: string | null): void;
  getHomeArea(): HomeArea | null;
  setHomeArea(area: HomeArea | null): void;
  getLastSyncedAt(): string | null;
  setLastSyncedAt(iso: string | null): void;
}

const KEYS = {
  auth: 'syncAuth',
  device: 'syncDeviceToken',
  regions: 'syncRegions',
  currentRegion: 'syncCurrentRegion',
  home: 'syncHomeArea',
  lastSynced: 'syncLastSyncedAt',
} as const;

// localStorage can be missing or throw (private mode, cleared site data); every access is guarded.
function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Nothing sensible to do; the next run just starts from scratch.
  }
}

export const localSyncStorage: SyncStorage = {
  getAuth: () => read<SyncAuth | null>(KEYS.auth, null),
  setAuth: (auth) => write(KEYS.auth, auth),
  getDeviceToken: () => read<string | null>(KEYS.device, null),
  setDeviceToken: (token) => write(KEYS.device, token),
  getRegions: () => read<Record<string, RegionCache>>(KEYS.regions, {}),
  setRegions: (regions) => write(KEYS.regions, regions),
  getCurrentRegionKey: () => read<string | null>(KEYS.currentRegion, null),
  setCurrentRegionKey: (key) => write(KEYS.currentRegion, key),
  getHomeArea: () => read<HomeArea | null>(KEYS.home, null),
  setHomeArea: (area) => write(KEYS.home, area),
  getLastSyncedAt: () => read<string | null>(KEYS.lastSynced, null),
  setLastSyncedAt: (iso) => write(KEYS.lastSynced, iso),
};

/** In-memory implementation for tests. */
export function memorySyncStorage(): SyncStorage {
  let auth: SyncAuth | null = null;
  let device: string | null = null;
  let regions: Record<string, RegionCache> = {};
  let currentRegion: string | null = null;
  let home: HomeArea | null = null;
  let lastSynced: string | null = null;
  return {
    getAuth: () => auth,
    setAuth: (a) => { auth = a; },
    getDeviceToken: () => device,
    setDeviceToken: (t) => { device = t; },
    getRegions: () => regions,
    setRegions: (r) => { regions = r; },
    getCurrentRegionKey: () => currentRegion,
    setCurrentRegionKey: (k) => { currentRegion = k; },
    getHomeArea: () => home,
    setHomeArea: (h) => { home = h; },
    getLastSyncedAt: () => lastSynced,
    setLastSyncedAt: (t) => { lastSynced = t; },
  };
}
