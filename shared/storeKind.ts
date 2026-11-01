/**
 * Ranks OpenStreetMap shop tags by how likely they are to be "the store"
 * someone is shopping groceries in. Lower is better. Costco is tagged
 * shop=wholesale, so warehouse clubs rank with supermarkets.
 */
const GROCERY_KINDS = new Set(['supermarket', 'grocery', 'wholesale']);
const FOOD_ADJACENT_KINDS = new Set(['greengrocer', 'convenience', 'department_store']);

/** The tag value to remember for an Overpass element: its shop value, or "supermarket" for amenity=supermarket. */
export function osmStoreKind(tags: Record<string, string> | undefined): string | null {
  if (!tags) return null;
  if (tags.shop) return tags.shop;
  if (tags.amenity === 'supermarket') return 'supermarket';
  return null;
}

export function storeKindRank(kind: string | null | undefined): number {
  if (!kind) return 2;
  if (GROCERY_KINDS.has(kind)) return 0;
  if (FOOD_ADJACENT_KINDS.has(kind)) return 1;
  return 2;
}
