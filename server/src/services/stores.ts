import { and, eq, ne } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { stores } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { geohash } from '../lib/geohash.js';

const GEOHASH_PRECISION = 7;

/**
 * Chain spelling variants seen in the real export (plan section 11a):
 * "HEB"/"H-E-B", "Walmart"/"Walmart Supercenter", "Kroger"/"Kroger
 * Marketplace", "Halal Imports"/"Halal Import Foods". Keyed by the string
 * after punctuation is stripped and whitespace is collapsed.
 */
const CHAIN_ALIASES: Record<string, string> = {
  'h e b': 'heb',
  'walmart supercenter': 'walmart',
  'kroger marketplace': 'kroger',
  'halal imports': 'halal import foods',
};

const stripUndefined = (raw: string): string => raw.replace(/\bundefined\b/gi, ' ');

export const normalizeKeyPart = (raw: string): string =>
  stripUndefined(raw)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function normalizeChainKey(raw: string): string {
  const cleaned = normalizeKeyPart(raw);
  return CHAIN_ALIASES[cleaned] ?? cleaned;
}

/**
 * Splits the client's "Name @ Address" convention, tolerating the messy
 * real-world forms: a bare chain name ("Kroger "), a bare address with no
 * chain ("9410 Webb Chapel Road"), and "undefined" fragments left over
 * from a reverse-geocode miss ("undefined La Cima").
 */
export function splitStoreString(raw: string): { chainRaw: string | null; addressRaw: string | null } {
  const cleaned = stripUndefined(raw).replace(/\s+/g, ' ').trim();
  if (!cleaned) return { chainRaw: null, addressRaw: null };
  if (cleaned.includes('@')) {
    const [chainPart, addressPart] = cleaned.split('@').map((s) => s.trim());
    // "4901 Maple Avenue @ 4901 Maple Avenue" is what the client builds from a
    // stored address-only row; there is no chain in it.
    if (chainPart && addressPart && normalizeKeyPart(chainPart) === normalizeKeyPart(addressPart)) {
      return { chainRaw: null, addressRaw: addressPart };
    }
    return { chainRaw: chainPart || null, addressRaw: addressPart || null };
  }
  // A string starting with digits reads as a street address ("9410 Webb
  // Chapel Road"), not a store name.
  if (/^\d/.test(cleaned)) return { chainRaw: null, addressRaw: cleaned };
  return { chainRaw: cleaned, addressRaw: null };
}

/**
 * A store row that is really just an address: a scan with no detected store
 * ("4901 Maple Avenue"), or the "addr @ addr" label the client built from
 * such a row and pushed back.
 */
export function isAddressOnlyStore(row: { name: string; address: string | null; chainKey: string }): boolean {
  return row.chainKey === '' || (row.address !== null && normalizeKeyPart(row.name) === normalizeKeyPart(row.address));
}

export interface StoreInput {
  rawStore: string;
  /** Every store has a location: a price is only useful to people near it. */
  lat: number;
  lon: number;
  /** OSM shop value, when known (from Overpass). */
  shopType?: string | null;
}

export interface ResolvedStore {
  id: string;
  name: string;
  chainKey: string;
  isChainLevel: boolean;
}

const toResolved = (row: typeof stores.$inferSelect): ResolvedStore => ({
  id: row.id,
  name: row.name,
  chainKey: row.chainKey,
  isChainLevel: row.isChainLevel,
});

/**
 * Resolves a raw, client-supplied store string plus coordinates to a stable
 * store row, creating one on first sight. See plan sections 8.5 and 11a:
 *   chain + coords    -> keyed by chain + ~150m geohash cell
 *   address + coords  -> attaches to a named store already known at that
 *                        cell, if any, else a new address-only store
 * Coordinates are required (the API and the database both refuse a store
 * without them), so there are no chain-level or location-less stores.
 */
export function resolveStore(db: AppDb, input: StoreInput): ResolvedStore {
  if (!Number.isFinite(input.lat) || !Number.isFinite(input.lon)) throw new Error('A store needs a location (lat and lon).');
  const { chainRaw, addressRaw } = splitStoreString(input.rawStore);
  const geohash7 = geohash(input.lat, input.lon, GEOHASH_PRECISION);

  let storeKey: string;
  let chainKey = '';
  let name: string;

  if (chainRaw) {
    chainKey = normalizeChainKey(chainRaw);
    name = chainRaw;
    storeKey = `${chainKey}:${geohash7}`;
  } else {
    const existing = db
      .select()
      .from(stores)
      .where(and(eq(stores.geohash7, geohash7), ne(stores.chainKey, '')))
      .limit(1)
      .all()[0];
    if (existing) return toResolved(existing);
    name = addressRaw ?? input.rawStore.trim();
    storeKey = `addr:${geohash7}`;
  }

  const found = db.select().from(stores).where(eq(stores.storeKey, storeKey)).all()[0];
  if (found) {
    if (input.shopType && !found.shopType) db.update(stores).set({ shopType: input.shopType }).where(eq(stores.id, found.id)).run();
    return toResolved(found);
  }

  const id = newId();
  db.insert(stores)
    .values({
      id,
      name,
      address: addressRaw,
      lat: input.lat,
      lon: input.lon,
      geohash7,
      chainKey,
      isChainLevel: false,
      storeKey,
      shopType: input.shopType ?? null,
    })
    .run();

  return { id, name, chainKey, isChainLevel: false };
}
