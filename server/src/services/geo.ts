import { and, isNotNull } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { stores } from '../db/schema.js';
import { haversineMeters } from '../lib/geohash.js';
import { resolveStore } from './stores.js';

/**
 * Geo proxy (plan section 8.6): nearby-store lookup answered from our own
 * `stores` table first and Overpass second, plus thin Nominatim wrappers
 * for reverse geocoding and the home-area search. `fetchImpl` is
 * injectable so tests never touch the network.
 */
export interface GeoDeps {
  /** Overpass interpreter URL (e.g. http://overpass/api/interpreter). Empty disables the fallback. */
  overpassUrl: string;
  nominatimUrl: string;
  fetchImpl?: typeof fetch;
  /** Nominatim's usage policy asks for an identifying User-Agent and at most one request per second. */
  userAgent?: string;
  nominatimMinGapMs?: number;
  overpassTimeoutMs?: number;
}

export interface NearbyStore {
  storeId: string;
  name: string;
  address: string | null;
  lat: number;
  lon: number;
  distanceM: number;
}

export interface ReverseResult {
  houseNumber: string | null;
  road: string | null;
  suburb: string | null;
  /** "9150 North Tarrant Parkway", or the road, or the suburb -- whatever is most specific. */
  label: string | null;
}

export interface GeocodeResult {
  label: string;
  lat: number;
  lon: number;
}

/** Radius the client has always used for "what store am I standing in". */
const NEARBY_RADIUS_M = 150;
/** If a known store is at least this close, don't bother asking Overpass. */
const KNOWN_STORE_CLOSE_ENOUGH_M = 75;
const METERS_PER_DEG_LAT = 111_320;
const CACHE_MAX = 1000;

const reverseCache = new Map<string, ReverseResult | null>();
const geocodeCache = new Map<string, GeocodeResult[]>();

const remember = <T>(cache: Map<string, T>, key: string, value: T): T => {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
  return value;
};

/** Serializes Nominatim calls with a minimum gap between them (module-wide, since the policy is per server). */
let nominatimChain: Promise<void> = Promise.resolve();
let lastNominatimAt = 0;
const throttleNominatim = (minGapMs: number): Promise<void> => {
  const next = nominatimChain.then(async () => {
    const wait = lastNominatimAt + minGapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastNominatimAt = Date.now();
  });
  nominatimChain = next.catch(() => undefined);
  return next;
};

function knownStoresNear(db: AppDb, lat: number, lon: number): NearbyStore[] {
  const latDelta = NEARBY_RADIUS_M / METERS_PER_DEG_LAT;
  const lonDelta = NEARBY_RADIUS_M / (METERS_PER_DEG_LAT * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  const rows = db
    .select()
    .from(stores)
    .where(and(isNotNull(stores.lat), isNotNull(stores.lon)))
    .all();
  return rows
    .filter((s) => s.lat !== null && s.lon !== null && Math.abs(s.lat - lat) <= latDelta && Math.abs(s.lon - lon) <= lonDelta)
    .map((s) => ({
      storeId: s.id,
      name: s.name,
      address: s.address,
      lat: s.lat as number,
      lon: s.lon as number,
      distanceM: haversineMeters(lat, lon, s.lat as number, s.lon as number),
    }))
    .filter((s) => s.distanceM <= NEARBY_RADIUS_M)
    .sort((a, b) => a.distanceM - b.distanceM);
}

interface OverpassElement {
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

async function overpassShopsNear(deps: GeoDeps, lat: number, lon: number): Promise<OverpassElement[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const query =
    `[out:json][timeout:8];(` +
    `node["shop"](around:${NEARBY_RADIUS_M},${lat},${lon});` +
    `way["shop"](around:${NEARBY_RADIUS_M},${lat},${lon});` +
    `node["amenity"="supermarket"](around:${NEARBY_RADIUS_M},${lat},${lon});` +
    `way["amenity"="supermarket"](around:${NEARBY_RADIUS_M},${lat},${lon});` +
    `);out center;`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.overpassTimeoutMs ?? 10_000);
  try {
    const res = await fetchImpl(deps.overpassUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': deps.userAgent ?? 'GrocerEZ' },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Overpass responded ${res.status}`);
    const body = (await res.json()) as { elements?: OverpassElement[] };
    return Array.isArray(body.elements) ? body.elements : [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stores within ~150 m of a point. Answers from our own table when a store
 * is already known close by; otherwise asks Overpass (if configured),
 * records what it finds as store rows so the next person at this spot
 * never triggers Overpass again, and returns the merged result. An
 * Overpass failure degrades to whatever the table already knows.
 */
export async function nearbyStores(db: AppDb, deps: GeoDeps, lat: number, lon: number): Promise<NearbyStore[]> {
  const known = knownStoresNear(db, lat, lon);
  if (!deps.overpassUrl || (known.length > 0 && known[0].distanceM <= KNOWN_STORE_CLOSE_ENOUGH_M)) {
    return known;
  }

  let elements: OverpassElement[];
  try {
    elements = await overpassShopsNear(deps, lat, lon);
  } catch (err) {
    console.warn('Overpass lookup failed; answering from known stores only:', err instanceof Error ? err.message : err);
    return known;
  }

  for (const el of elements) {
    const name = el.tags?.name?.trim();
    const elLat = el.lat ?? el.center?.lat;
    const elLon = el.lon ?? el.center?.lon;
    if (!name || elLat === undefined || elLon === undefined) continue; // a nameless "shop=yes" node is useless as a store name
    const house = el.tags?.['addr:housenumber'];
    const street = el.tags?.['addr:street'];
    const address = house && street ? `${house} ${street}` : street ?? null;
    resolveStore(db, { rawStore: address ? `${name} @ ${address}` : name, lat: elLat, lon: elLon });
  }

  return knownStoresNear(db, lat, lon);
}

export async function reverseGeocode(deps: GeoDeps, lat: number, lon: number): Promise<ReverseResult | null> {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`; // ~11 m cells
  const cached = reverseCache.get(key);
  if (cached !== undefined) return cached;

  const fetchImpl = deps.fetchImpl ?? fetch;
  await throttleNominatim(deps.nominatimMinGapMs ?? 1100);
  const res = await fetchImpl(`${deps.nominatimUrl}/reverse?format=json&lat=${lat}&lon=${lon}`, {
    headers: { 'User-Agent': deps.userAgent ?? 'GrocerEZ', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Nominatim responded ${res.status}`);
  const body = (await res.json()) as { address?: Record<string, string> };
  const addr = body.address ?? {};
  const houseNumber = addr.house_number ?? null;
  const road = addr.road ?? null;
  const suburb = addr.suburb ?? addr.neighbourhood ?? addr.city ?? null;
  const label = houseNumber && road ? `${houseNumber} ${road}` : road ?? suburb;
  return remember(reverseCache, key, { houseNumber, road, suburb, label });
}

export async function geocode(deps: GeoDeps, q: string): Promise<GeocodeResult[]> {
  const key = q.trim().toLowerCase();
  const cached = geocodeCache.get(key);
  if (cached) return cached;

  const fetchImpl = deps.fetchImpl ?? fetch;
  await throttleNominatim(deps.nominatimMinGapMs ?? 1100);
  const res = await fetchImpl(`${deps.nominatimUrl}/search?format=json&limit=5&q=${encodeURIComponent(q.trim())}`, {
    headers: { 'User-Agent': deps.userAgent ?? 'GrocerEZ', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Nominatim responded ${res.status}`);
  const body = (await res.json()) as { display_name?: string; lat?: string; lon?: string }[];
  const results = (Array.isArray(body) ? body : [])
    .map((r) => ({ label: r.display_name ?? '', lat: Number(r.lat), lon: Number(r.lon) }))
    .filter((r) => r.label && Number.isFinite(r.lat) && Number.isFinite(r.lon));
  return remember(geocodeCache, key, results);
}

/** Test hook: the module-level caches would otherwise leak between test files. */
export function _resetGeoCachesForTests(): void {
  reverseCache.clear();
  geocodeCache.clear();
  lastNominatimAt = 0;
}
