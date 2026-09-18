/**
 * Product matching: "are these two price reports the same item?" Pure
 * functions per docs/server-sync-plan.md section 8, so the client can reuse
 * them later to suggest matches at scan time (section 8.4). The server's
 * orchestration (candidate lookup, reading/writing product rows) lives in
 * server/src/services/products.ts and calls into here for the scoring.
 */
import { nameTokens, brandKey, diceSimilarity, tokenize, singularize } from './normalize';
import { parseQuantity, compareQuantities, type ParsedQuantity } from './units';

export interface MatchableItem {
  itemName: string;
  brand: string;
  tags: string[];
  quantity: number | null;
  quantityUnits: string | null;
}

/** A pre-normalized item, ready to compare. Build once per side with normalizeItem(). */
export interface NormalizedItem {
  brandKey: string;
  nameTokens: Set<string>;
  tagTokens: Set<string>;
  size: ParsedQuantity;
}

export function normalizeItem(item: MatchableItem): NormalizedItem {
  return {
    brandKey: brandKey(item.brand),
    nameTokens: nameTokens(item.itemName, item.brand),
    tagTokens: tokenize(item.tags.join(' ')),
    size: parseQuantity(item.quantity, item.quantityUnits),
  };
}

export type BrandComparison = 'equal' | 'unknown' | 'different';

/**
 * Compares two already-normalized items' brands. A blank brand on either
 * side counts as 'equal' when the known brand's words all appear in the
 * blank side's name tokens (handles brand "Oreo" next to itemName "Oreo
 * Double Stuf", brand ""), otherwise 'unknown' (no signal either way).
 * Two known, differing brands are 'different' -- unless one brand key is a
 * subset of the other's words, which counts as 'equal' (plan section 11a).
 */
export function compareBrandKeys(a: NormalizedItem, b: NormalizedItem): BrandComparison {
  if (!a.brandKey || !b.brandKey) {
    const known = a.brandKey || b.brandKey;
    if (!known) return 'unknown';
    const blank = a.brandKey ? b : a;
    const knownWords = known.split(' ');
    return knownWords.every((w) => blank.nameTokens.has(w)) ? 'equal' : 'unknown';
  }
  if (a.brandKey === b.brandKey) return 'equal';
  const aWords = a.brandKey.split(' ');
  const bWords = b.brandKey.split(' ');
  const [shorter, longer] = aWords.length <= bWords.length ? [aWords, bWords] : [bWords, aWords];
  return shorter.every((w) => longer.includes(w)) ? 'equal' : 'different';
}

export interface MatchScoreResult {
  score: number;
  /** Size families differ, or both known and outside 3% tolerance -- an unconditional reject regardless of score. */
  sizeMismatch: boolean;
  brandsKnownAndEqual: boolean;
  sizesKnownAndEqual: boolean;
}

/**
 * Scores how likely two normalized items are the same product (section
 * 8.3). `pricePenalty` is computed by the caller from the candidate
 * product's aggregate stats (report count, median price) since that's
 * server-side state this pure function doesn't have.
 *
 * Brand is treated the same for every item, produce included: a genuine
 * mismatch rejects the candidate outright. An earlier version scored
 * produce brand as a soft signal instead (six blueberry packers are "the
 * same" for search purposes), but that broke `current_prices`, which is
 * keyed by (product, store) only -- Driscoll's and Berry Fresh blueberries
 * at the same store would fight over one "current price" slot, and
 * whichever was scanned more recently would silently hide the other
 * brand's real, different price. Fixing that properly means keying
 * `current_prices` by variant too, which is more machinery than the
 * search benefit is worth right now; different produce brands are simply
 * different products, like any other brand mismatch.
 */
export function scoreMatch(a: NormalizedItem, b: NormalizedItem, pricePenalty = 0): MatchScoreResult {
  const sizeCmp = compareQuantities(a.size, b.size);
  if (sizeCmp === 'different') {
    return { score: 0, sizeMismatch: true, brandsKnownAndEqual: false, sizesKnownAndEqual: false };
  }

  const brandCmp = compareBrandKeys(a, b);
  if (brandCmp === 'different') {
    return { score: 0, sizeMismatch: false, brandsKnownAndEqual: false, sizesKnownAndEqual: sizeCmp === 'same' };
  }

  const brandScore = brandCmp === 'equal' ? 1 : 0.5; // 'unknown'
  const nameSim = diceSimilarity(a.nameTokens, b.nameTokens);
  const tagSim = diceSimilarity(a.tagTokens, b.tagTokens);
  const score = 0.65 * nameSim + 0.2 * brandScore + 0.15 * tagSim - pricePenalty;

  return {
    score,
    sizeMismatch: false,
    brandsKnownAndEqual: brandCmp === 'equal',
    sizesKnownAndEqual: sizeCmp === 'same',
  };
}

export type MatchDecision = 'attach' | 'review' | 'new';

/**
 * Turns a score into attach/review/new (section 8.3). The flavor-variant
 * rule lowers both thresholds when brand and size already agree, so
 * differently-worded variants of the same product (a Buldak flavor, a
 * blueberry size) cluster together without needing a near-identical name.
 */
export function decideMatch(result: MatchScoreResult): MatchDecision {
  if (result.sizeMismatch) return 'new';
  const flavorEligible = result.brandsKnownAndEqual && result.sizesKnownAndEqual;
  const attachThreshold = flavorEligible ? 0.55 : 0.8;
  const reviewThreshold = flavorEligible ? 0.4 : 0.6;
  if (result.score >= attachThreshold) return 'attach';
  if (result.score >= reviewThreshold) return 'review';
  return 'new';
}

/**
 * Narrows a product's display name toward the words it shares with a newly
 * attached report, preserving the existing name's word order and casing.
 * "Buldak Spicy Ramen (Rose)" attaching "Buldak Spicy Ramen, Artificial
 * Spicy Chicken Flavor" drops "(Rose)" (not shared) and keeps "Buldak Spicy
 * Ramen" (plan section 8.3's own example). Never returns an empty string --
 * falls back to the existing name if nothing would be left.
 */
export function narrowCanonicalName(existingName: string, existing: NormalizedItem, incoming: NormalizedItem): string {
  const shared = new Set([...existing.nameTokens].filter((t) => incoming.nameTokens.has(t)));
  if (shared.size === 0) return existingName;
  const words = existingName.split(/\s+/).filter(Boolean);
  const kept = words.filter((w) => shared.has(singularize(w.toLowerCase().replace(/[^a-z0-9]/g, ''))));
  const result = kept.join(' ').trim();
  return result || existingName;
}
