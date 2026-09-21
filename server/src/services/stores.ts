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

const normalizeKeyPart = (raw: string): string =>
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
    return { chainRaw: chainPart || null, addressRaw: addressPart || null };
  }
  // A string starting with digits reads as a street address ("9410 Webb
  // Chapel Road"), not a store name.
  if (/^\d/.test(cleaned)) return { chainRaw: null, addressRaw: cleaned };
  return { chainRaw: cleaned, addressRaw: null };
}

export interface StoreInput {
  rawStore: string;
  lat?: number | null;
  lon?: number | null;
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
 * Resolves a raw, client-supplied store string (plus optional coordinates)
 * to a stable store row, creating one on first sight. See plan sections
 * 8.5 and 11a:
 *   chain + coords        -> keyed by chain + ~150m geohash cell
 *   chain + address only  -> keyed by chain + normalized address text
 *   chain alone           -> a chain-level store (no location)
 *   address + coords only -> attaches to a named store already known at
 *                            that cell, if any, else a new address-only store
 *   address only          -> keyed by the normalized address text alone
 */
export function resolveStore(db: AppDb, input: StoreInput): ResolvedStore {
  const { chainRaw, addressRaw } = splitStoreString(input.rawStore);
  const hasCoords = typeof input.lat === 'number' && typeof input.lon === 'number';
  const geohash7 = hasCoords ? geohash(input.lat as number, input.lon as number, GEOHASH_PRECISION) : null;

  let storeKey: string;
  let chainKey = '';
  let name: string;
  let isChainLevel = false;

  if (chainRaw) {
    chainKey = normalizeChainKey(chainRaw);
    name = chainRaw;
    if (geohash7) {
      storeKey = `${chainKey}:${geohash7}`;
    } else if (addressRaw) {
      storeKey = `${chainKey}:addr:${normalizeKeyPart(addressRaw)}`;
    } else {
      storeKey = `${chainKey}:chain`;
      isChainLevel = true;
    }
  } else if (geohash7) {
    const existing = db
      .select()
      .from(stores)
      .where(and(eq(stores.geohash7, geohash7), ne(stores.chainKey, '')))
      .limit(1)
      .all()[0];
    if (existing) return toResolved(existing);
    name = addressRaw ?? input.rawStore.trim();
    storeKey = `addr:${geohash7}`;
  } else {
    name = (addressRaw ?? input.rawStore).trim();
    storeKey = `addr:${normalizeKeyPart(addressRaw ?? input.rawStore)}`;
  }

  const found = db.select().from(stores).where(eq(stores.storeKey, storeKey)).all()[0];
  if (found) return toResolved(found);

  const id = newId();
  db.insert(stores)
    .values({
      id,
      name,
      address: addressRaw,
      lat: hasCoords ? (input.lat as number) : null,
      lon: hasCoords ? (input.lon as number) : null,
      geohash7,
      chainKey,
      isChainLevel,
      storeKey,
    })
    .run();

  return { id, name, chainKey, isChainLevel };
}
