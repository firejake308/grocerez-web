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
  confirmCount: number;
  updatedAt: string;
}

export interface PullResponseBody {
  /**
   * Always 'unrestricted' until entitlement enforcement ships in Phase 3
   * (plan section 6.3.3); `locked` is always empty until then too.
   */
  accessLevel: 'unrestricted' | 'public' | 'contributor' | 'subscriber';
  reports: SyncedPriceReport[];
  locked: { productId: string; canonicalName: string; storeCount: number; reportCount: number; newestDate: string }[];
  nextSince: number;
}
