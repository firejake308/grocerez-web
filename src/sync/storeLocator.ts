/**
 * "What store am I standing in?" for the scanner. Prefers the sync server's
 * geo proxy (plan section 8.6: answered from known stores first, your own
 * Overpass second) and falls back to the public Overpass/Nominatim
 * endpoints the app has always used when sync is off or the server is
 * unreachable, so anonymous users are never broken by an API outage.
 */
import { createSyncApi } from './api';
import { SYNC_API_URL, syncEnabled } from './config';
import { localSyncStorage } from './storage';

export interface LocatedStore {
  /** "Kroger @ 9150 North Tarrant Parkway", "Kroger", "9150 North Tarrant Parkway", or "" when nothing was found. */
  label: string;
  lat: number;
  lon: number;
}

interface OverpassNode {
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: {
    name?: string;
    shop?: string;
    'addr:housenumber'?: string;
    'addr:street'?: string;
  };
}

// overpass-api.de (the main public instance) intermittently rejects or
// rate-limits requests with a 406/CORS-looking failure; fall back to mirrors
// so a single flaky instance doesn't break store lookup for anonymous users.
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
];

async function fetchOverpass(query: string, signal: AbortSignal): Promise<{ elements?: OverpassNode[] }> {
  let lastError: unknown;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(`${endpoint}?data=${encodeURIComponent(query)}`, { signal });
      if (!res.ok) throw new Error(`Overpass request to ${endpoint} failed with status ${res.status}`);
      return await res.json();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Failed to fetch location data');
}

const withTimeout = (ms: number): { signal: AbortSignal; done: () => void } => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
};

async function publicReverse(lat: number, lon: number): Promise<string> {
  const t = withTimeout(10_000);
  try {
    // addressdetails=1 is required -- Nominatim omits the `address` breakdown without it.
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&addressdetails=1&lat=${lat}&lon=${lon}`, { signal: t.signal });
    if (!res.ok) return '';
    const data = await res.json();
    const addr = data.address || {};
    if (addr.house_number && addr.road) return `${addr.house_number} ${addr.road}`;
    return addr.road || addr.suburb || '';
  } catch {
    return '';
  } finally {
    t.done();
  }
}

export async function locateViaPublicServices(latitude: number, longitude: number): Promise<LocatedStore> {
  const query = `[out:json];(node["shop"](around:150,${latitude},${longitude});way["shop"](around:150,${latitude},${longitude});node["amenity"="supermarket"](around:150,${latitude},${longitude});way["amenity"="supermarket"](around:150,${latitude},${longitude}););out center;`;
  const t = withTimeout(10_000);
  let elements: OverpassNode[] = [];
  try {
    const data = await fetchOverpass(query, t.signal);
    if (Array.isArray(data.elements)) elements = data.elements;
  } catch (err) {
    console.error('Overpass lookup failed:', err);
  } finally {
    t.done();
  }

  if (elements.length === 0) {
    return { label: await publicReverse(latitude, longitude), lat: latitude, lon: longitude };
  }

  const elemLat = (el: OverpassNode) => el.lat ?? el.center?.lat ?? latitude;
  const elemLon = (el: OverpassNode) => el.lon ?? el.center?.lon ?? longitude;
  const nearest = elements.reduce((prev, curr) => {
    const pd = Math.hypot(elemLat(prev) - latitude, elemLon(prev) - longitude);
    const cd = Math.hypot(elemLat(curr) - latitude, elemLon(curr) - longitude);
    return cd < pd ? curr : prev;
  }, elements[0]);

  const name = nearest.tags?.name || nearest.tags?.shop || '';
  const lat = elemLat(nearest);
  const lon = elemLon(nearest);
  const house = nearest.tags?.['addr:housenumber'];
  const street = nearest.tags?.['addr:street'];
  const address = house && street ? `${house} ${street}` : await publicReverse(lat, lon);

  return { label: name && address ? `${name} @ ${address}` : name || address, lat, lon };
}

/** Returns null (not '') on any failure so the caller can fall back to the public services. */
export async function locateViaApi(latitude: number, longitude: number): Promise<LocatedStore | null> {
  const token = localSyncStorage.getAuth()?.sessionToken ?? localSyncStorage.getDeviceToken();
  if (!token) return null;
  const api = createSyncApi(SYNC_API_URL);
  try {
    const { stores } = await api.nearbyStores(token, latitude, longitude);
    if (stores.length > 0) {
      const nearest = stores[0]; // server sorts by distance
      return { label: nearest.address ? `${nearest.name} @ ${nearest.address}` : nearest.name, lat: nearest.lat, lon: nearest.lon };
    }
    const reverse = await api.reverse(token, latitude, longitude);
    return { label: reverse.label ?? '', lat: latitude, lon: longitude };
  } catch (err) {
    console.warn('Geo proxy unavailable, falling back to public services:', err);
    return null;
  }
}

export async function locateStore(latitude: number, longitude: number): Promise<LocatedStore> {
  if (syncEnabled()) {
    const viaApi = await locateViaApi(latitude, longitude);
    if (viaApi) return viaApi;
  }
  return locateViaPublicServices(latitude, longitude);
}
