/**
 * Item search shared by the client's offline search and the server's
 * /api/search, so both match exactly the same things. Pure, no dependencies.
 */
import { tokenize, tokensMatch } from './normalize';

export interface SearchableItem {
  itemName?: string | null;
  brand?: string | null;
  tags?: readonly string[] | null;
}

/** Query tokens for a search string; empty when there is nothing to search for. */
export const queryTokens = (query: string): string[] => Array.from(tokenize(query.trim().toLowerCase()));

/** True when every query token matches (equal or prefix of, either way) some token of the item's name, brand or tags. */
export const matchesQuery = (item: SearchableItem, query: string): boolean => {
  if (!item.itemName) return false;
  const wanted = queryTokens(query);
  if (wanted.length === 0) return false;
  const haystack = [item.itemName, item.brand, ...(item.tags ?? [])].filter(Boolean).join(' ').toLowerCase();
  const itemTokens = Array.from(tokenize(haystack));
  return wanted.every((q) => itemTokens.some((t) => tokensMatch(q, t)));
};
