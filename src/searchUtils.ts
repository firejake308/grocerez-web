import PriceData from './PriceData';
import { tokenize } from '../shared/normalize';
import { matchesQuery } from '../shared/search';

export { tokenize };

export const filterBySearchQuery = (priceData: PriceData[], query: string): PriceData[] =>
  priceData.filter((it) => matchesQuery(it, query));
