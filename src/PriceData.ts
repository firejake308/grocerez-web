export interface GroceryItem {
    id: string;
    name: string;
    quantity: number;
    unit: string;
    checked: boolean;
}

interface PriceData {
    /** Client-generated UUID. Stable across edits and sync. */
    id: string;
    price: string;
    store: string;
    /** Date the price was observed, YYYY-MM-DD. */
    date: string;
    priceImage: string | null;
    productImage: string | null;
    itemName: string;
    brand: string;
    tags: string[];
    quantity: number;
    quantity_units: string;
    latitude?: number | null;
    longitude?: number | null;
    /** ISO timestamp of the last local edit; drives last-writer-wins on sync. */
    updatedAt: string;
    /** 'mine' for reports this device authored; 'community' for pulled reports. */
    origin?: 'mine' | 'community';
    /** True when the tag showed a sale or promotional price. */
    isSale?: boolean;
    /** Sale end date, YYYY-MM-DD, when printed on the tag. */
    expiresAt?: string | null;

    // --- Sync fields (docs/server-sync-plan.md section 7). All optional so pre-sync data still loads. ---
    /** Author's server user id. Set on pulled community reports; on own reports after first push. */
    userId?: string;
    /** Assigned by the server after push (or carried on pulled reports). */
    productId?: string;
    storeId?: string;
    /** ISO timestamp of the last successful push of this version. Absent or older than updatedAt means "pending". */
    syncedAt?: string | null;
    /** Tombstone: set when the user deletes an already-synced report; purged once the delete is pushed. */
    deletedAt?: string | null;
    /** Trust tier of the author, for community reports only. */
    authorTier?: 'new' | 'restricted' | 'established' | 'trusted';
    confirmCount?: number;
}

export default PriceData;
export type { PriceData };
