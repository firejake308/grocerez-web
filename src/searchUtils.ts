import { PriceData } from './PriceData';

export const tokenize = (s: string) =>
  new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean));

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
      itemTokens.some(itemToken =>
        queryToken === itemToken || queryToken.startsWith(itemToken) || itemToken.startsWith(queryToken)
      )
    );
  });
};
