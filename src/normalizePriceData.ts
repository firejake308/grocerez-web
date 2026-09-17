import PriceData from './PriceData';
import { newReportId } from '../shared/ids';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export type PartialPriceData = Partial<Omit<PriceData, 'price' | 'tags' | 'quantity'>> & {
  price?: string | number;
  tags?: string[] | string;
  quantity?: number | string;
};

export const normalizePriceData = (item: PartialPriceData): PriceData => {
  const normalizedTags = Array.isArray(item.tags)
    ? item.tags.filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.trim()).filter(Boolean)
    : typeof item.tags === 'string'
      ? item.tags.split(',').map((tag: string) => tag.trim()).filter(Boolean)
      : [];

  const normalizedQuantity = typeof item.quantity === 'number'
    ? item.quantity
    : Number(item.quantity);

  const date = typeof item.date === 'string' ? item.date : '';
  // Reports saved before sync existed have no id or updatedAt. Give them a
  // fresh id and treat the observed date as their last modification.
  const updatedAt = typeof item.updatedAt === 'string' && item.updatedAt
    ? item.updatedAt
    : DATE_ONLY.test(date) ? `${date}T00:00:00.000Z` : new Date().toISOString();

  return {
    id: typeof item.id === 'string' && item.id ? item.id : newReportId(),
    price: typeof item.price === 'string' ? item.price : String(item.price ?? ''),
    store: typeof item.store === 'string' ? item.store : '',
    date,
    priceImage: typeof item.priceImage === 'string' ? item.priceImage : null,
    productImage: typeof item.productImage === 'string' ? item.productImage : null,
    itemName: typeof item.itemName === 'string' ? item.itemName : '',
    brand: typeof item.brand === 'string' ? item.brand : '',
    tags: normalizedTags,
    quantity: Number.isFinite(normalizedQuantity) ? normalizedQuantity : 1,
    quantity_units: typeof item.quantity_units === 'string' ? item.quantity_units : '',
    latitude: typeof item.latitude === 'number' ? item.latitude : null,
    longitude: typeof item.longitude === 'number' ? item.longitude : null,
    updatedAt,
    origin: item.origin === 'community' ? 'community' : 'mine',
    isSale: item.isSale === true,
    expiresAt: typeof item.expiresAt === 'string' && DATE_ONLY.test(item.expiresAt) ? item.expiresAt : null,
  };
};
