/**
 * Wire types for the sync API (docs/server-sync-plan.md section 7). Kept
 * separate from PriceData (src/PriceData.ts) because the wire format is a
 * contract between client and server, while PriceData is free to grow
 * client-only fields (images, local-only state) without touching this.
 */

export interface PriceReportUpsert {
  /** Client-generated UUID; pushed as-is so push is idempotent. */
  id: string;
  itemName: string;
  brand: string;
  tags: string[];
  quantity: number | null;
  quantityUnits: string | null;
  /** As typed/scanned, e.g. "2.99", "$2.99", "3/10.00". Parsed server-side (shared/price.ts). */
  price: string;
  /** Raw store string, e.g. "Kroger @ 9150 North Tarrant Parkway", or just "Kroger". Resolved server-side. */
  store: string;
  latitude?: number | null;
  longitude?: number | null;
  /** YYYY-MM-DD, the date the price was observed. */
  observedDate: string;
  /** YYYY-MM-DD sale end date, when the tag printed one. */
  expiresAt?: string | null;
  isSale?: boolean;
  /** ISO timestamp of the last local edit; last-writer-wins for a given author's own report. */
  updatedAt: string;
  /** Set (to any value) to soft-delete this report. */
  deletedAt?: string | null;
  /**
   * A product the user confirmed at save time (plan section 8.4). The
   * server attaches to it directly instead of running the matcher.
   */
  productId?: string | null;
}

export type PriceReportStatus = 'active' | 'hidden' | 'deleted' | 'rejected';

export interface PriceReportPushResult {
  id: string;
  status: PriceReportStatus;
  productId?: string;
  storeId?: string;
  seq?: number;
  /** Set when status is 'rejected' -- the price didn't parse, or this id belongs to a different author. */
  error?: string;
  /** The server's resolved view, so the client can show the canonical product name. */
  normalized?: { itemName: string; brand: string; priceCents: number };
  /** Set when this push updated an existing report of the same product, store, date, and author instead of inserting (section 9.4). */
  collapsedInto?: string;
  /** 'price_outlier' when the price is far from the product's median; 'new_user' when held for review (section 9.4). */
  reviewReason?: 'price_outlier' | 'new_user' | 'flagged' | 'banned' | null;
}

export interface PushRequestBody {
  reports: PriceReportUpsert[];
}

export interface PushResponseBody {
  results: PriceReportPushResult[];
}

/** A price_reports row as the pull endpoint sends it -- the fields a client needs to render and re-sync. */
export interface SyncedPriceReport {
  id: string;
  seq: number;
  userId: string;
  authorTier: 'new' | 'restricted' | 'established' | 'trusted';
  productId: string;
  storeId: string;
  storeName: string;
  itemName: string;
  brand: string;
  tags: string[];
  quantity: number | null;
  quantityUnits: string | null;
  priceCents: number;
  observedDate: string;
  expiresAt: string | null;
  isSale: boolean;
  status: PriceReportStatus;
  reviewReason: 'price_outlier' | 'new_user' | 'flagged' | 'banned' | null;
  confirmCount: number;
  /** Section 10: sale expired, or no confirmation/rescan in 45 days. Still shown, ranked lower and dimmed. */
  isStale: boolean;
  /** The caller's own vote on this report, when signed in. */
  myVote: 'confirm' | 'flag' | null;
  updatedAt: string;
}

export interface ProductCurrentPrice {
  storeId: string;
  storeName: string;
  storeAddress: string | null;
  reportId: string;
  priceCents: number;
  observedDate: string;
  expiresAt: string | null;
  isStale: boolean;
  confidence: number;
  authorTier: 'new' | 'restricted' | 'established' | 'trusted';
  /** A newer report from an unverified author that disagreed with this one (section 10's override). */
  contested: { reportId: string; priceCents: number; observedDate: string } | null;
}

export interface ProductPricesResponse {
  product: { id: string; canonicalName: string; brandKey: string; sizeLabel: string | null; reportCount: number; medianPriceCents: number | null };
  current: ProductCurrentPrice[];
  history: SyncedPriceReport[];
}

export interface ProductMatchCandidate {
  productId: string;
  canonicalName: string;
  brandKey: string;
  sizeLabel: string | null;
  reportCount: number;
  storeCount: number;
  medianPriceCents: number | null;
  score: number;
  decision: 'attach' | 'review';
}

/**
 * Fields extracted from a price-tag + product photo pair (Phase 3's
 * `POST /api/parse`, replacing the client's direct OpenRouter call). Image
 * data never round-trips through the server response -- the client already
 * has the photos it sent.
 */
export interface ParsedPriceFields {
  price: string;
  itemName: string;
  brand: string;
  tags: string[];
  quantity: number;
  quantityUnits: string;
  isSale: boolean;
  expiresAt: string | null;
}

/** A product outside the free set, shown to a 'public'-level caller with no price (section 6.3). */
export interface LockedSummary {
  productId: string;
  canonicalName: string;
  storeCount: number;
  reportCount: number;
  newestDate: string;
}

export interface PullResponseBody {
  /**
   * 'unrestricted' while ENTITLEMENTS_ENFORCED is off (plan section 6.3.3,
   * off by default); otherwise the caller's real level, with `locked`
   * populated only for a 'public' caller.
   */
  accessLevel: 'unrestricted' | 'public' | 'contributor' | 'subscriber';
  reports: SyncedPriceReport[];
  locked: LockedSummary[];
  nextSince: number;
}
