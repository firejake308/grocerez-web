import PriceData from './PriceData';
import { tokenize, tokensMatch } from '../shared/normalize';

export { tokenize };

export const filterBySearchQuery = (priceData: PriceData[], query: string): PriceData[] => {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const queryTokens = tokenize(q);
  const searchable = (it: PriceData) =>
    [it.itemName, it.brand, ...(it.tags ?? [])].filter(Boolean).join(' ').toLowerCase();

  return priceData.filter(it => {
    if (!it.itemName) return false;
    const itemTokens = Array.from(tokenize(searchable(it)));
    return Array.from(queryTokens).every(queryToken =>
      itemTokens.some(itemToken => tokensMatch(queryToken, itemToken))
    );
  });
};
