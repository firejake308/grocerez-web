import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { priceReports, products, productTokens } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import {
  compareBrandKeys,
  decideMatch,
  narrowCanonicalName,
  normalizeItem,
  scoreMatch,
  type MatchableItem,
  type MatchDecision,
  type NormalizedItem,
} from '../../../shared/matching.js';
import type { ParsedQuantity, UnitFamily } from '../../../shared/units.js';

type ProductRow = typeof products.$inferSelect;

const parseTags = (json: string): string[] => {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
};

/** Rebuilds a NormalizedItem from a stored product row, for scoring a new report against it. */
function normalizeProductRow(product: ProductRow): NormalizedItem {
  const size: ParsedQuantity = {
    family: product.sizeFamily as UnitFamily,
    baseQuantity: product.sizeBaseQty,
    label: product.sizeLabel ?? '',
  };
  const asItem: MatchableItem = {
    itemName: product.canonicalName,
    brand: '', // brandKey is already computed; feeding it back through brandKey() would double-normalize
    tags: parseTags(product.tags),
    quantity: null,
    quantityUnits: null,
  };
  const normalized = normalizeItem(asItem);
  return { ...normalized, brandKey: product.brandKey, size };
}

/** 0.15 once a product has enough history and the new price is far outside its usual range; never higher, never a veto (plan section 8.3). */
function pricePenalty(product: ProductRow, priceCents: number): number {
  if (product.reportCount < 3 || !product.medianPriceCents) return 0;
  const ratio = priceCents / product.medianPriceCents;
  return ratio < 0.35 || ratio > 3.0 ? 0.15 : 0;
}

/** Candidate lookup (section 8.2): products sharing a name token, then filtered to brand/size compatibility. */
function findCandidates(db: AppDb, normalized: NormalizedItem): ProductRow[] {
  const tokens = Array.from(normalized.nameTokens);
  if (tokens.length === 0) return [];

  const tokenRows = db
    .select({ productId: productTokens.productId })
    .from(productTokens)
    .where(inArray(productTokens.token, tokens))
    .all();
  const candidateIds = Array.from(new Set(tokenRows.map((r) => r.productId)));
  if (candidateIds.length === 0) return [];

  const rows = db
    .select()
    .from(products)
    .where(and(inArray(products.id, candidateIds), isNull(products.mergedInto)))
    .all();

  return rows.filter((row) => {
    const rowNormalized = normalizeProductRow(row);
    const brandOk = compareBrandKeys(normalized, rowNormalized) !== 'different';
    const sizeOk = row.sizeFamily === 'unknown' || normalized.size.family === 'unknown' || row.sizeFamily === normalized.size.family;
    return brandOk && sizeOk;
  });
}

function insertProductTokens(db: AppDb, productId: string, tokens: Iterable<string>): void {
  for (const token of tokens) {
    db.insert(productTokens).values({ productId, token }).onConflictDoNothing().run();
  }
}

function createProduct(db: AppDb, item: MatchableItem, normalized: NormalizedItem, possibleDuplicateOf: string | null): string {
  const id = newId();
  db.insert(products)
    .values({
      id,
      canonicalName: item.itemName.trim(),
      brandKey: normalized.brandKey,
      sizeFamily: normalized.size.family,
      sizeBaseQty: normalized.size.baseQuantity,
      sizeLabel: normalized.size.label || null,
      tags: JSON.stringify(Array.from(new Set(item.tags.map((t) => t.toLowerCase().trim()).filter(Boolean)))),
      reportCount: 0,
      medianPriceCents: null,
      possibleDuplicateOf,
    })
    .run();
  insertProductTokens(db, id, normalized.nameTokens);
  return id;
}

function attachToProduct(db: AppDb, product: ProductRow, item: MatchableItem, normalized: NormalizedItem): void {
  const existingNormalized = normalizeProductRow(product);
  const narrowedName = narrowCanonicalName(product.canonicalName, existingNormalized, normalized);

  const mixedBrands = compareBrandKeys(existingNormalized, normalized) === 'different';
  const nextBrandKey = mixedBrands ? '' : product.brandKey || normalized.brandKey;

  const nextSize: { sizeFamily: UnitFamily; sizeBaseQty: number | null; sizeLabel: string | null } =
    product.sizeFamily === 'unknown' && normalized.size.family !== 'unknown'
      ? { sizeFamily: normalized.size.family, sizeBaseQty: normalized.size.baseQuantity, sizeLabel: normalized.size.label || null }
      : { sizeFamily: product.sizeFamily as UnitFamily, sizeBaseQty: product.sizeBaseQty, sizeLabel: product.sizeLabel };

  const mergedTags = Array.from(new Set([...parseTags(product.tags), ...item.tags.map((t) => t.toLowerCase().trim())])).filter(Boolean);

  db.update(products)
    .set({ canonicalName: narrowedName, brandKey: nextBrandKey, tags: JSON.stringify(mergedTags), ...nextSize })
    .where(eq(products.id, product.id))
    .run();
}

/** Recomputes report_count and median_price_cents for a product from its own active reports. Called after each write. */
export function refreshProductStats(db: AppDb, productId: string, activePriceCentsList: number[]): void {
  const sorted = [...activePriceCentsList].sort((a, b) => a - b);
  const median =
    sorted.length === 0
      ? null
      : sorted.length % 2 === 1
        ? sorted[(sorted.length - 1) / 2]
        : Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);
  db.update(products).set({ reportCount: sorted.length, medianPriceCents: median }).where(eq(products.id, productId)).run();
}

/** Follows merged_into pointers to the live product, or null if the id is unknown. */
export function followMerge(db: AppDb, productId: string, depth = 0): string | null {
  const row = db.select({ id: products.id, mergedInto: products.mergedInto }).from(products).where(eq(products.id, productId)).all()[0];
  if (!row) return null;
  if (row.mergedInto && depth < 10) return followMerge(db, row.mergedInto, depth + 1) ?? row.id;
  return row.id;
}

/** Recomputes a product's cached stats from its active reports. Call after any write that changes them. */
export function refreshProductFromReports(db: AppDb, productId: string): void {
  const prices = db
    .select({ priceCents: priceReports.priceCents })
    .from(priceReports)
    .where(and(eq(priceReports.productId, productId), eq(priceReports.status, 'active')))
    .all()
    .map((r) => r.priceCents);
  refreshProductStats(db, productId, prices);
}

export interface MatchCandidate {
  productId: string;
  canonicalName: string;
  brandKey: string;
  sizeLabel: string | null;
  sizeBaseQty: number | null;
  reportCount: number;
  medianPriceCents: number | null;
  score: number;
  decision: MatchDecision;
}

/** Section 8.4's save-time prompt: the same candidates and scores push would use, without writing anything. */
export function matchCandidates(db: AppDb, item: MatchableItem, priceCents: number | null, limit = 3): MatchCandidate[] {
  const normalized = normalizeItem(item);
  return findCandidates(db, normalized)
    .map((product) => {
      const penalty = priceCents === null ? 0 : pricePenalty(product, priceCents);
      const result = scoreMatch(normalized, normalizeProductRow(product), penalty);
      return {
        productId: product.id,
        canonicalName: product.canonicalName,
        brandKey: product.brandKey,
        sizeLabel: product.sizeLabel,
        sizeBaseQty: product.sizeBaseQty,
        reportCount: product.reportCount,
        medianPriceCents: product.medianPriceCents,
        score: result.score,
        decision: decideMatch(result),
      };
    })
    .filter((c) => c.decision !== 'new')
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export interface ResolveProductResult {
  productId: string;
  decision: MatchDecision;
}

/**
 * Finds or creates the product this report belongs to (plan section 8).
 * `priceCents` is used only for the price-plausibility penalty (8.3) --
 * it never vetoes a match on its own, so a real sale never gets rejected
 * as "not the same item."
 */
export function resolveProduct(db: AppDb, item: MatchableItem, priceCents: number): ResolveProductResult {
  const normalized = normalizeItem(item);
  const candidates = findCandidates(db, normalized);

  let best: { product: ProductRow; score: ReturnType<typeof scoreMatch> } | null = null;
  for (const product of candidates) {
    const penalty = pricePenalty(product, priceCents);
    const score = scoreMatch(normalized, normalizeProductRow(product), penalty);
    if (!best || score.score > best.score.score) best = { product, score };
  }

  if (best) {
    const decision = decideMatch(best.score);
    if (decision === 'attach') {
      attachToProduct(db, best.product, item, normalized);
      return { productId: best.product.id, decision };
    }
    if (decision === 'review') {
      const productId = createProduct(db, item, normalized, best.product.id);
      return { productId, decision };
    }
  }

  const productId = createProduct(db, item, normalized, null);
  return { productId, decision: 'new' };
}
