import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type PriceData from '../PriceData';
import { ApiError, createSyncApi, type GeocodeResult, type Profile } from './api';
import { PULL_RADIUS_MI, SYNC_API_URL, syncEnabled } from './config';
import { cachedCommunity, pendingReports, runSync } from './engine';
import { getSyncLocation } from './location';
import { localSyncStorage, type HomeArea, type SyncAuth } from './storage';

export interface SyncStatus {
  running: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
  pendingCount: number;
  rejected: { id: string; error: string }[];
  communityCount: number;
  skippedPull: 'no-location' | null;
}

export interface SyncController {
  enabled: boolean;
  auth: SyncAuth | null;
  profile: Profile | null;
  community: PriceData[];
  status: SyncStatus;
  homeArea: HomeArea | null;
  syncNow: () => Promise<void>;
  requestCode: (email: string) => Promise<void>;
  verifyCode: (email: string, code: string) => Promise<void>;
  signOut: () => Promise<void>;
  updateDisplayName: (name: string) => Promise<void>;
  searchHomeArea: (q: string) => Promise<GeocodeResult[]>;
  chooseHomeArea: (area: HomeArea | null) => Promise<void>;
}

/** Delay between a local change and the push it triggers, so a burst of edits becomes one request. */
const PUSH_DEBOUNCE_MS = 1500;

const describe = (err: unknown): string => {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.name === 'AbortError' ? 'The sync server did not respond in time.' : err.message;
  return 'Sync failed.';
};

/**
 * Owns all sync state for the app: auth, the community cache, and the
 * triggers from plan section 7 (app load, after a local change, on a manual
 * "Sync now", and when the browser comes back online). Everything is a
 * no-op when VITE_SYNC_API_URL is unset.
 */
export function useSync(priceData: PriceData[], setPriceData: Dispatch<SetStateAction<PriceData[]>>): SyncController {
  const enabled = syncEnabled();
  const api = useMemo(() => createSyncApi(SYNC_API_URL), []);
  const storage = localSyncStorage;

  const [auth, setAuthState] = useState<SyncAuth | null>(() => (enabled ? storage.getAuth() : null));
  const [profile, setProfile] = useState<Profile | null>(null);
  const [homeArea, setHomeAreaState] = useState<HomeArea | null>(() => (enabled ? storage.getHomeArea() : null));
  const [community, setCommunity] = useState<PriceData[]>(() => (enabled ? cachedCommunity(storage) : []));
  const [status, setStatus] = useState<SyncStatus>(() => ({
    running: false,
    lastSyncedAt: enabled ? storage.getLastSyncedAt() : null,
    lastError: null,
    pendingCount: 0,
    rejected: [],
    communityCount: 0,
    skippedPull: null,
  }));

  // Latest values for callbacks that outlive a render.
  const priceDataRef = useRef(priceData);
  priceDataRef.current = priceData;
  const homeAreaRef = useRef(homeArea);
  homeAreaRef.current = homeArea;
  const runningRef = useRef(false);
  const queuedRef = useRef(false);

  const pendingCount = useMemo(() => (enabled ? pendingReports(priceData).length : 0), [enabled, priceData]);

  const syncNow = useCallback(async () => {
    if (!enabled) return;
    if (runningRef.current) {
      queuedRef.current = true; // a change landed mid-sync; run once more when this one finishes
      return;
    }
    runningRef.current = true;
    setStatus((s) => ({ ...s, running: true, lastError: null }));
    try {
      const summary = await runSync({
        api,
        storage,
        getPriceData: () => priceDataRef.current,
        setPriceData: (update) => setPriceData(update),
        getLocation: () => getSyncLocation(priceDataRef.current, homeAreaRef.current),
        radiusMi: PULL_RADIUS_MI,
      });
      setCommunity(summary.community);
      setAuthState(storage.getAuth()); // runSync signs out locally on a 401
      setStatus((s) => ({
        ...s,
        lastSyncedAt: storage.getLastSyncedAt(),
        rejected: summary.rejected,
        communityCount: summary.community.length,
        skippedPull: summary.skippedPull,
      }));
    } catch (err) {
      console.error('Sync failed:', err);
      setStatus((s) => ({ ...s, lastError: describe(err) }));
    } finally {
      runningRef.current = false;
      setStatus((s) => ({ ...s, running: false }));
      if (queuedRef.current) {
        queuedRef.current = false;
        void syncNow();
      }
    }
  }, [api, enabled, setPriceData, storage]);

  // Trigger: app load.
  useEffect(() => {
    if (!enabled) return;
    void syncNow();
    if (storage.getAuth()) {
      api.getMe(storage.getAuth()!.sessionToken).then(setProfile).catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Trigger: a local change that left something pending (debounced).
  useEffect(() => {
    setStatus((s) => (s.pendingCount === pendingCount ? s : { ...s, pendingCount }));
    if (!enabled || pendingCount === 0 || !auth) return;
    const timer = setTimeout(() => void syncNow(), PUSH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [enabled, pendingCount, auth, syncNow]);

  // Trigger: the browser comes back online.
  useEffect(() => {
    if (!enabled) return;
    const onOnline = () => void syncNow();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [enabled, syncNow]);

  const requestCode = useCallback(async (email: string) => {
    await api.requestCode(email);
  }, [api]);

  const verifyCode = useCallback(async (email: string, code: string) => {
    const session = await api.verifyCode(email, code);
    const me = await api.getMe(session.sessionToken);
    const next: SyncAuth = { sessionToken: session.sessionToken, userId: session.userId, email: me.email, displayName: me.displayName };
    storage.setAuth(next);
    setAuthState(next);
    setProfile(me);
    // A home area chosen before signing in becomes the account's too.
    const home = homeAreaRef.current;
    if (home && (me.homeLat === null || me.homeLon === null)) {
      api.patchMe(session.sessionToken, { homeLat: home.lat, homeLon: home.lon }).then(setProfile).catch(() => undefined);
    }
    void syncNow();
  }, [api, storage, syncNow]);

  const signOut = useCallback(async () => {
    const current = storage.getAuth();
    storage.setAuth(null);
    setAuthState(null);
    setProfile(null);
    if (current) {
      await api.signOut(current.sessionToken).catch(() => undefined); // the local sign-out already happened
    }
  }, [api, storage]);

  const updateDisplayName = useCallback(async (name: string) => {
    const current = storage.getAuth();
    if (!current) return;
    const me = await api.patchMe(current.sessionToken, { displayName: name.trim() });
    setProfile(me);
    const next = { ...current, displayName: me.displayName };
    storage.setAuth(next);
    setAuthState(next);
  }, [api, storage]);

  const searchHomeArea = useCallback(async (q: string) => {
    const token = storage.getAuth()?.sessionToken ?? storage.getDeviceToken();
    if (!token) {
      const { deviceToken } = await api.registerDevice();
      storage.setDeviceToken(deviceToken);
      return (await api.geocode(deviceToken, q)).results;
    }
    return (await api.geocode(token, q)).results;
  }, [api, storage]);

  const chooseHomeArea = useCallback(async (area: HomeArea | null) => {
    storage.setHomeArea(area);
    setHomeAreaState(area);
    const current = storage.getAuth();
    if (current) {
      api.patchMe(current.sessionToken, { homeLat: area?.lat ?? null, homeLon: area?.lon ?? null }).then(setProfile).catch(() => undefined);
    }
    void syncNow();
  }, [api, storage, syncNow]);

  return {
    enabled,
    auth,
    profile,
    community,
    status,
    homeArea,
    syncNow,
    requestCode,
    verifyCode,
    signOut,
    updateDisplayName,
    searchHomeArea,
    chooseHomeArea,
  };
}
