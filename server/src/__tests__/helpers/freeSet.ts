/**
 * Test helper: reports for 25 distinct products. Pushed by two different
 * users, they fill a region's free set (25 products ranked by reporters x
 * stores), so a product reported by just one user falls outside it and is
 * locked for a public caller. Without this, a region with fewer than 25
 * products has everything free.
 */
export const FILLER_NAMES = ['apple', 'banana', 'cherry', 'mango', 'peach', 'plum', 'grape', 'lemon', 'lime', 'melon', 'pear', 'kiwi', 'fig', 'date', 'guava',
  'papaya', 'quince', 'apricot', 'nectarine', 'tangerine', 'cranberry', 'raspberry', 'blueberry', 'blackberry', 'pomegranate'];

export function fillerReports(prefix: string, make: (id: string, itemName: string) => Record<string, unknown>) {
  return FILLER_NAMES.map((name, i) => make(`${prefix}-${i}`, name));
}
