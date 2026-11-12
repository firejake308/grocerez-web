import { and, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { contributionCredits, currentPrices, priceReports, products, reportVotes, stores } from '../db/schema.js';
import { refreshCurrentPrice } from './freshness.js';
import { refreshProductFromReports } from './products.js';
import { isAddressOnlyStore, normalizeChainKey, normalizeKeyPart, splitStoreString } from './stores.js';

export interface UnlocatedStore {
  id: string;
  name: string;
  address: string | null;
  reports: number;
  activeReports: number;
}

/**
 * "Move everything at the unlocated store `from` to the located store `to`."
 * `from` is a bare chain name ("Kroger"), the street address of an address-only
 * store ("9410 Webb Chapel Road"), or a full "Chain @ Street Address" label;
 * an address alone matches only stores that are just an address, never a named
 * store that happens to be at that address. `to` is "Chain @ Street Address",
 * or just a chain name when exactly one located store of that chain exists
 * (OpenStreetMap doesn't always know a store's address).
 */
export interface StoreMove {
  from: string;
  to: string;
}

export interface ResolvedMove {
  from: string;
  to: { id: string; name: string; address: string | null; lat: number; lon: number };
  /** The unlocated stores that were (or would be) emptied into the target. */
  stores: UnlocatedStore[];
  reports: number;
}

export interface UnlocatedSummary {
  moves: ResolvedMove[];
  /** Unlocated stores left after the moves; these are what gets deleted. */
  stores: UnlocatedStore[];
  reports: number;
  activeReports: number;
  /** Rows removed or moved (only when applying). */
  deleted: { reports: number; votes: number; credits: number; currentPrices: number; stores: number };
  moved: { reports: number; stores: number };
}

export class CleanupError extends Error {}

/** Street-type abbreviations people type, expanded so "9410 Webb Chapel Rd" finds "9410 Webb Chapel Road". */
const ADDRESS_WORDS: Record<string, string> = {
  rd: 'road', pkwy: 'parkway', ave: 'avenue', blvd: 'boulevard', st: 'street', dr: 'drive', ln: 'lane', hwy: 'highway', fwy: 'freeway', ct: 'court', pl: 'place', cir: 'circle',
};
const normalizeAddress = (raw: string): string =>
  normalizeKeyPart(raw).split(' ').map((w) => ADDRESS_WORDS[w] ?? w).join(' ');

/** Finds the one located store a move points at, or says why it can't. */
function resolveTarget(tx: AppDb, to: string): ResolvedMove['to'] {
  const { chainRaw, addressRaw } = splitStoreString(to);
  if (!chainRaw) throw new CleanupError(`"${to}" must be "Chain @ Street Address", or just a chain name.`);
  const located = tx.select().from(stores).where(and(eq(stores.chainKey, normalizeChainKey(chainRaw)), isNotNull(stores.lat), isNotNull(stores.lon))).all();
  // With an address, match it (so "Rd" finds "Road"); without one, the chain must be unambiguous.
  const matches = addressRaw === null ? located : located.filter((s) => s.address !== null && normalizeAddress(s.address) === normalizeAddress(addressRaw));
  if (matches.length !== 1) {
    const known = located.map((s) => `${s.name} @ ${s.address ?? '(no address)'}`).join('; ') || 'none';
    throw new CleanupError(`${matches.length === 0 ? 'No' : 'More than one'} located store matches "${to}". Located ${chainRaw} stores: ${known}.`);
  }
  const [s] = matches;
  return { id: s.id, name: s.name, address: s.address, lat: s.lat as number, lon: s.lon as number };
}

/** Which unlocated stores a move's `from` names (see StoreMove). */
function matchesSource(store: typeof stores.$inferSelect, from: string): boolean {
  const { chainRaw, addressRaw } = splitStoreString(from);
  if (chainRaw && addressRaw) return store.address !== null && normalizeChainKey(store.name) === normalizeChainKey(chainRaw) && normalizeAddress(store.address) === normalizeAddress(addressRaw);
  if (chainRaw) return store.address === null && normalizeChainKey(store.name) === normalizeChainKey(chainRaw);
  return addressRaw !== null && isAddressOnlyStore(store) && normalizeAddress(store.address ?? store.name) === normalizeAddress(addressRaw);
}

/**
 * Stores without coordinates predate the rule that every store has a location
 * (see the stores_require_location_* triggers). No one can be shown their
 * prices -- we can't tell who is near -- so each is either moved to a real,
 * located store (`moves`, for the bare chain names where the right store is
 * known) or, with `apply`, deleted along with everything that hangs off it.
 * Everything runs in one transaction. Photo files on disk are left to the
 * normal retention sweep.
 */
export function cleanupUnlocatedStores(db: AppDb, { apply, moves = [] }: { apply: boolean; moves?: StoreMove[] }): UnlocatedSummary {
  const run = (tx: AppDb): UnlocatedSummary => {
    const unlocated = tx.select().from(stores).where(or(isNull(stores.lat), isNull(stores.lon))).all();
    const reportsOf = (storeIds: string[]) => (storeIds.length === 0 ? [] : tx.select().from(priceReports).where(inArray(priceReports.storeId, storeIds)).all());
    const describe = (rows: typeof unlocated, reports: ReturnType<typeof reportsOf>): UnlocatedStore[] =>
      rows.map((store) => {
        const mine = reports.filter((r) => r.storeId === store.id);
        return { id: store.id, name: store.name, address: store.address, reports: mine.length, activeReports: mine.filter((r) => r.status === 'active').length };
      });

    const summary: UnlocatedSummary = {
      moves: [],
      stores: [],
      reports: 0,
      activeReports: 0,
      deleted: { reports: 0, votes: 0, credits: 0, currentPrices: 0, stores: 0 },
      moved: { reports: 0, stores: 0 },
    };

    // 1. Moves: a bare chain name, an address-only store or a "Chain @ Address" store goes to the one located store named for it.
    const movedStoreIds = new Set<string>();
    const unmatched: string[] = [];
    for (const move of moves) {
      const sources = unlocated.filter((s) => !movedStoreIds.has(s.id) && matchesSource(s, move.from));
      if (sources.length === 0) {
        unmatched.push(move.from);
        continue;
      }
      const target = resolveTarget(tx, move.to);
      const sourceReports = reportsOf(sources.map((s) => s.id));
      sources.forEach((s) => movedStoreIds.add(s.id));
      summary.moves.push({ from: move.from, to: target, stores: describe(sources, sourceReports), reports: sourceReports.length });
      if (!apply) continue;

      const productIds = [...new Set(sourceReports.map((r) => r.productId).filter((id): id is string => !!id))];
      const sourceIds = sources.map((s) => s.id);
      if (sourceReports.length > 0) tx.update(priceReports).set({ storeId: target.id }).where(inArray(priceReports.storeId, sourceIds)).run();
      tx.delete(currentPrices).where(inArray(currentPrices.storeId, sourceIds)).run();
      for (const productId of productIds) refreshCurrentPrice(tx, productId, target.id);
      tx.delete(stores).where(inArray(stores.id, sourceIds)).run();
      summary.moved.reports += sourceReports.length;
      summary.moved.stores += sources.length;
    }

    // 2. Whatever is still unlocated can't be placed: list it, and with `apply` delete it.
    const remaining = unlocated.filter((s) => !movedStoreIds.has(s.id));
    if (unmatched.length > 0 && remaining.length > 0) {
      // A typo here would otherwise delete the very prices the move was meant to save.
      throw new CleanupError(`No unlocated store is called ${unmatched.map((n) => `"${n}"`).join(', ')}. Nothing was changed.`);
    }
    if (remaining.length === 0) return summary;

    const storeIds = remaining.map((s) => s.id);
    const reports = reportsOf(storeIds);
    summary.stores = describe(remaining, reports);
    summary.reports = reports.length;
    summary.activeReports = reports.filter((r) => r.status === 'active').length;
    if (!apply) return summary;

    const reportIds = reports.map((r) => r.id);
    const productIds = [...new Set(reports.map((r) => r.productId).filter((id): id is string => !!id))];
    if (reportIds.length > 0) {
      // current_prices can point at these reports from a store that does have coordinates (contested_report_id).
      for (const row of tx.select().from(currentPrices).where(inArray(currentPrices.contestedReportId, reportIds)).all()) {
        tx.update(currentPrices).set({ contestedReportId: null }).where(eq(currentPrices.reportId, row.reportId)).run();
      }
      summary.deleted.votes = tx.delete(reportVotes).where(inArray(reportVotes.reportId, reportIds)).run().changes;
      summary.deleted.credits = tx.delete(contributionCredits).where(inArray(contributionCredits.reportId, reportIds)).run().changes;
    }
    summary.deleted.currentPrices = tx.delete(currentPrices).where(inArray(currentPrices.storeId, storeIds)).run().changes;
    if (reportIds.length > 0) summary.deleted.reports = tx.delete(priceReports).where(inArray(priceReports.id, reportIds)).run().changes;
    summary.deleted.stores = tx.delete(stores).where(inArray(stores.id, storeIds)).run().changes;

    for (const productId of productIds) {
      if (tx.select({ id: products.id }).from(products).where(eq(products.id, productId)).all()[0]) refreshProductFromReports(tx, productId);
    }
    return summary;
  };
  return apply ? db.transaction((tx) => run(tx as unknown as AppDb)) : run(db);
}
