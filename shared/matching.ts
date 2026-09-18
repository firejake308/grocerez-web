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
  isProduce: boolean;
}

const PRODUCE_TAGS = new Set([
  'produce', 'fruit', 'fruits', 'vegetable', 'vegetables', 'veggie', 'veggies',
  'berries', 'berry', 'apples', 'apple', 'bulk', 'bagged',
]);

/** A short backstop vocabulary; tags carry most of the signal (the parse prompt already asks for them). */
const PRODUCE_NAME_WORDS = new Set([
  'apple', 'banana', 'onion', 'potato', 'avocado', 'blueberry', 'strawberry', 'blackberry',
  'raspberry', 'mango', 'tomato', 'lemon', 'lime', 'orange', 'grape', 'melon', 'spinach',
  'lettuce', 'carrot', 'cilantro', 'cucumber', 'pepper', 'broccoli', 'cauliflower', 'celery',
  'kale', 'peach', 'pear', 'plum', 'cherry', 'date', 'kiwi', 'grapefruit', 'pineapple',
]);

export function isProduceItem(item: Pick<MatchableItem, 'tags' | 'itemName' | 'brand'>): boolean {
  if (item.tags.some((t) => PRODUCE_TAGS.has(t.toLowerCase().trim()))) return true;
  const tokens = nameTokens(item.itemName, item.brand);
  for (const word of tokens) if (PRODUCE_NAME_WORDS.has(word)) return true;
  return false;
}

export function normalizeItem(item: MatchableItem): NormalizedItem {
  return {
    brandKey: brandKey(item.brand),
    nameTokens: nameTokens(item.itemName, item.brand),
    tagTokens: tokenize(item.tags.join(' ')),
    size: parseQuantity(item.quantity, item.quantityUnits),
    isProduce: isProduceItem(item),
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
  /** True when either side is produce, so brand was scored as a soft 0.5 rather than compared for real. */
  producePath: boolean;
}

/**
 * Scores how likely two normalized items are the same product (section
 * 8.3). `pricePenalty` is computed by the caller from the candidate
 * product's aggregate stats (report count, median price) since that's
 * server-side state this pure function doesn't have.
 */
export function scoreMatch(a: NormalizedItem, b: NormalizedItem, pricePenalty = 0): MatchScoreResult {
  const sizeCmp = compareQuantities(a.size, b.size);
  if (sizeCmp === 'different') {
    return { score: 0, sizeMismatch: true, brandsKnownAndEqual: false, sizesKnownAndEqual: false, producePath: false };
  }

  const produce = a.isProduce || b.isProduce;
  const brandCmp = compareBrandKeys(a, b);

  // A genuine brand mismatch rejects the candidate outright -- except for
  // produce, where brand is a soft signal (decision 8: six blueberry
  // packers are the same product at the same size).
  if (brandCmp === 'different' && !produce) {
    return {
      score: 0,
      sizeMismatch: false,
      brandsKnownAndEqual: false,
      sizesKnownAndEqual: sizeCmp === 'same',
      producePath: false,
    };
  }

  const brandScore = produce ? 0.5 : brandCmp === 'equal' ? 1 : brandCmp === 'unknown' ? 0.5 : 0;
  const nameSim = diceSimilarity(a.nameTokens, b.nameTokens);
  const tagSim = diceSimilarity(a.tagTokens, b.tagTokens);
  const score = 0.65 * nameSim + 0.2 * brandScore + 0.15 * tagSim - pricePenalty;

  return {
    score,
    sizeMismatch: false,
    brandsKnownAndEqual: brandCmp === 'equal',
    sizesKnownAndEqual: sizeCmp === 'same',
    producePath: produce,
  };
}

export type MatchDecision = 'attach' | 'review' | 'new';

/**
 * Turns a score into attach/review/new (section 8.3). Both the
 * flavor-variant rule and the produce rule lower the thresholds when brand
 * was never a real signal against attaching -- either because it's known
 * and matches (flavor variants of the same product) or because it was
 * scored as a soft 0.5 on purpose (produce, decision 8). Without this,
 * "six blueberry packers are one product" doesn't actually happen: their
 * differing brands keep the score in the review band under the standard
 * 0.8 threshold even though nothing else about them differs.
 */
export function decideMatch(result: MatchScoreResult): MatchDecision {
  if (result.sizeMismatch) return 'new';
  const lowered = result.sizesKnownAndEqual && (result.brandsKnownAndEqual || result.producePath);
  const attachThreshold = lowered ? 0.55 : 0.8;
  const reviewThreshold = lowered ? 0.4 : 0.6;
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
