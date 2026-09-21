import PriceData from './PriceData';
import { createSyncApi } from './sync/api';
import { SYNC_API_URL, syncEnabled } from './sync/config';
import { localSyncStorage } from './sync/storage';

/** Fields the scanner fills from the two photos. The rest of PriceData is added on save. */
export type ParsedPriceScan = Pick<
  PriceData,
  'price' | 'store' | 'priceImage' | 'productImage' | 'itemName' | 'brand' | 'tags' | 'quantity' | 'quantity_units'
> & { isSale: boolean; expiresAt: string | null };

async function callerToken(): Promise<string> {
  const session = localSyncStorage.getAuth()?.sessionToken;
  if (session) return session;
  const existing = localSyncStorage.getDeviceToken();
  if (existing) return existing;
  const { deviceToken } = await createSyncApi(SYNC_API_URL).registerDevice();
  localSyncStorage.setDeviceToken(deviceToken);
  return deviceToken;
}

/**
 * Calls the server's AI parse proxy (Phase 3, `POST /api/parse`) to extract
 * price and product fields from the two photos. Moved server-side so the
 * OpenRouter key never ships in the client bundle; anonymous scanning still
 * works (decision 9, plan section 15), since the server accepts a device
 * token, not just a signed-in session.
 */
export async function parsePriceImage(priceImageData: string, productImageData: string, reportId?: string): Promise<ParsedPriceScan> {
  if (!syncEnabled()) {
    throw new Error('Photo scanning needs the sync server to be configured (VITE_SYNC_API_URL). Enter the details by hand instead.');
  }

  const token = await callerToken();
  const fields = await createSyncApi(SYNC_API_URL).parseImages(token, priceImageData, productImageData, reportId);

  return {
    price: fields.price,
    store: '',
    // Date is set after the user is done editing, not from the parse result.
    priceImage: priceImageData,
    productImage: productImageData,
    itemName: fields.itemName,
    brand: fields.brand,
    tags: fields.tags,
    quantity: fields.quantity,
    quantity_units: fields.quantityUnits,
    isSale: fields.isSale,
    expiresAt: fields.expiresAt,
  };
}
