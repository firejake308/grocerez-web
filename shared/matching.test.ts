import { describe, it, expect } from 'vitest';
import {
  normalizeItem,
  scoreMatch,
  decideMatch,
  compareBrandKeys,
  narrowCanonicalName,
  type MatchableItem,
} from './matching';

const item = (overrides: Partial<MatchableItem>): MatchableItem => ({
  itemName: '',
  brand: '',
  tags: [],
  quantity: null,
  quantityUnits: null,
  ...overrides,
});

const decide = (a: MatchableItem, b: MatchableItem, pricePenalty = 0) =>
  decideMatch(scoreMatch(normalizeItem(a), normalizeItem(b), pricePenalty));

describe('real pairs from the export (docs/server-sync-plan.md section 11a)', () => {
  it('attaches two Stok Cold Brew reports at the same store chain, worded slightly differently', () => {
    const a = item({ itemName: 'Cold Brew Coffee', brand: 'Stok', tags: ['coffee', 'cold brew', 'beverage'], quantity: 48, quantityUnits: 'fluid ounce' });
    const b = item({ itemName: 'Unsweetened Cold Brew Coffee', brand: 'Stok', tags: ['coffee', 'cold brew', 'beverage', 'drink'], quantity: 48, quantityUnits: 'fluid ounce' });
    expect(decide(a, b)).toBe('attach');
  });

  it('attaches PanOxyl acne wash reported two different ways', () => {
    const a = item({ itemName: 'Acne Foaming Wash', brand: 'PanOxyl', tags: ['acne treatment', 'face wash', 'body wash', 'skin care'], quantity: 5.5, quantityUnits: 'ounce' });
    const b = item({ itemName: 'PanOxyl 10% Foam Acne Foaming Wash', brand: 'PanOxyl', tags: ['acne treatment', 'face wash', 'body wash', 'benzoyl peroxide'], quantity: 5.5, quantityUnits: 'ounce' });
    expect(decide(a, b)).toBe('attach');
  });

  it('attaches Annie\'s mac and cheese despite "Homegrown" and "Natural" wording differences', () => {
    const a = item({ itemName: 'Classic Macaroni and Cheese', brand: "Annie's Homegrown", tags: ['mac and cheese', 'pasta', 'dinner', 'comfort food'], quantity: 6, quantityUnits: 'ounce' });
    const b = item({ itemName: 'Natural Classic Macaroni and Cheese', brand: "Annie's", tags: ['macaroni', 'pasta', 'cheese', 'gluten free'], quantity: 6, quantityUnits: 'ounce' });
    expect(decide(a, b)).toBe('attach');
  });

  it('keeps the two different Oreo packs apart (different size, different flavor)', () => {
    const a = item({ itemName: 'Oreo BTS Brown Sugar Pancake Flavor Cream Sandwich Cookies', brand: 'Oreo', tags: ['cookies', 'snacks', 'dessert', 'limited edition'], quantity: 11.18, quantityUnits: 'ounce' });
    const b = item({ itemName: 'Oreo Double Stuf Chocolate Sandwich Cookies', brand: 'Oreo', tags: ['cookies', 'chocolate', 'sandwich cookies', 'dessert'], quantity: 2.71, quantityUnits: 'ounce' });
    expect(decide(a, b)).toBe('new');
  });

  it('never merges 12-count and 24-count eggs, even from the same brand family', () => {
    const a = item({ itemName: 'Large White Eggs', brand: 'Great Value', tags: ['eggs', 'dairy', 'breakfast'], quantity: 12, quantityUnits: 'count' });
    const b = item({ itemName: 'Large Grade A Eggs', brand: "Eggland's Best", tags: ['eggs', 'breakfast', 'protein'], quantity: 24, quantityUnits: 'count' });
    expect(decide(a, b)).toBe('new');
  });

  it('keeps different-brand eggs at the same size apart (brand mismatch is always a hard reject)', () => {
    const a = item({ itemName: 'Large White Eggs', brand: 'Great Value', tags: ['eggs', 'dairy', 'breakfast'], quantity: 12, quantityUnits: 'count' });
    const b = item({ itemName: 'Large Eggs', brand: "Eggland's Best", tags: ['eggs', 'breakfast', 'protein', 'baking'], quantity: 12, quantityUnits: 'count' });
    expect(decide(a, b)).toBe('new');
  });

  it('merges Buldak flavor variants under the flavor rule (same brand, same size)', () => {
    const a = item({ itemName: 'Buldak Spicy Ramen (Rose)', brand: 'Samyang', tags: [], quantity: 24.65, quantityUnits: 'ounce' });
    const b = item({ itemName: 'Buldak Spicy Ramen, Artificial Spicy Chicken Flavor', brand: 'Samyang', tags: ['ramen', 'noodles', 'instant noodles', 'spicy'], quantity: 24.65, quantityUnits: 'ounce' });
    expect(decide(a, b)).toBe('attach');
  });

  it('keeps six different-brand blueberry packers at the same size apart, same as any other item', () => {
    // An earlier version treated produce brand as a soft signal so these
    // would cluster into one product. That broke current_prices, which is
    // keyed by (product, store) only: two brands at the same store would
    // fight over one "current price" slot, and the newer scan would
    // silently hide the other brand's real, different price. Produce gets
    // no special treatment now -- a brand mismatch rejects the match here
    // exactly like it does for eggs.
    const driscolls = item({ itemName: 'Organic Blueberries', brand: "Driscoll's", tags: ['berries', 'fruit', 'organic produce', 'fresh fruit'], quantity: 18, quantityUnits: 'ounce' });
    const berryFresh = item({ itemName: 'Blueberries', brand: 'Berry Fresh', tags: ['berries', 'fruit', 'produce', 'fresh fruit'], quantity: 18, quantityUnits: 'ounce' });
    const twinRiver = item({ itemName: 'Blueberries', brand: 'Twin River', tags: ['fruit', 'berry', 'fresh produce'], quantity: 18, quantityUnits: 'ounce' });
    expect(decide(driscolls, berryFresh)).toBe('new');
    expect(decide(berryFresh, twinRiver)).toBe('new');
  });

  it('still merges same-brand blueberries reported with slightly different wording', () => {
    const a = item({ itemName: 'Blueberries', brand: 'Berry Fresh', tags: ['berries', 'fruit', 'produce'], quantity: 18, quantityUnits: 'ounce' });
    const b = item({ itemName: 'Fresh Blueberries', brand: 'Berry Fresh', tags: ['berries', 'fruit', 'fresh produce'], quantity: 18, quantityUnits: 'ounce' });
    expect(decide(a, b)).toBe('attach');
  });

  it('keeps 18 oz blueberries apart from 1-pint blueberries (size is always hard)', () => {
    const ounces = item({ itemName: 'Blueberries', brand: 'Berry Fresh', tags: ['berries', 'fruit', 'produce'], quantity: 18, quantityUnits: 'ounce' });
    const pint = item({ itemName: 'Organic Blueberries', brand: 'Berry Fresh', tags: ['berries', 'fruit', 'organic produce'], quantity: 1, quantityUnits: 'pint' });
    expect(decide(ounces, pint)).toBe('new');
  });

  it('lands the two Ferrero Collection boxes in review rather than auto-attaching (documented known miss)', () => {
    // Same brand, same 4.6 oz size, but "Fine Assorted Confections" and
    // "With Raffaello" share only one name token -- not enough to
    // auto-attach even under the lowered flavor threshold, but not
    // rejected either. This is one of the known misses from plan section
    // 11a: it lands as a new product with `possible_duplicate_of` set, for
    // an admin (or later, the Phase 2 save-time prompt) to merge by hand.
    const a = item({ itemName: 'Ferrero Collection Fine Assorted Confections', brand: 'Ferrero', tags: ['chocolate', 'assorted chocolates', 'gift', 'confections'], quantity: 4.6, quantityUnits: 'ounce' });
    const b = item({ itemName: 'Ferrero Collection With Raffaello', brand: 'Ferrero', tags: ['chocolate', 'candy', 'gift', 'sweets'], quantity: 4.6, quantityUnits: 'ounce' });
    expect(decide(a, b)).toBe('review');
  });

  it('a $4 item report at $1 is a real sale, not an error -- price never vetoes a match', () => {
    const usual = item({ itemName: 'Cosmic Crisp Apples', brand: 'Kroger', tags: ['fruit', 'produce', 'apples'], quantity: 1, quantityUnits: 'pound' });
    const onSale = item({ itemName: 'Cosmic Crisp Apples', brand: 'Kroger', tags: ['fruit', 'produce', 'apples'], quantity: 1, quantityUnits: 'pound' });
    // Identical brand and size put this on the flavor-rule's lowered
    // threshold (0.55), so even the maximum price penalty (0.15) applied
    // on top of an otherwise-perfect match still clears it comfortably.
    expect(decide(usual, onSale, 0.15)).toBe('attach');
  });
});

describe('compareBrandKeys', () => {
  it('treats a blank brand as equal when the known brand word is in the other name', () => {
    const oreo = normalizeItem(item({ itemName: 'Oreo Thins', brand: 'Oreo' }));
    const blank = normalizeItem(item({ itemName: 'Oreo Double Stuf', brand: '' }));
    expect(compareBrandKeys(oreo, blank)).toBe('equal');
  });

  it('treats two blank brands as unknown, not equal', () => {
    const a = normalizeItem(item({ itemName: 'Apples' }));
    const b = normalizeItem(item({ itemName: 'Apples' }));
    expect(compareBrandKeys(a, b)).toBe('unknown');
  });

  it('collapses known aliases to equal', () => {
    const a = normalizeItem(item({ brand: "Annie's" }));
    const b = normalizeItem(item({ brand: "Annie's Homegrown" }));
    expect(compareBrandKeys(a, b)).toBe('equal');
  });

  it('rejects genuinely different brands', () => {
    const a = normalizeItem(item({ brand: 'Great Value' }));
    const b = normalizeItem(item({ brand: "Eggland's Best" }));
    expect(compareBrandKeys(a, b)).toBe('different');
  });
});

describe('narrowCanonicalName', () => {
  it('drops words not shared with the newly attached report, keeping order and casing', () => {
    const existingItem = item({ itemName: 'Buldak Spicy Ramen (Rose)', brand: 'Samyang' });
    const incomingItem = item({ itemName: 'Buldak Spicy Ramen, Artificial Spicy Chicken Flavor', brand: 'Samyang' });
    const existing = normalizeItem(existingItem);
    const incoming = normalizeItem(incomingItem);
    expect(narrowCanonicalName(existingItem.itemName, existing, incoming)).toBe('Buldak Spicy Ramen');
  });

  it('falls back to the existing name when nothing is shared', () => {
    const existingItem = item({ itemName: 'Blueberries' });
    const incomingItem = item({ itemName: 'Strawberries' });
    expect(narrowCanonicalName(existingItem.itemName, normalizeItem(existingItem), normalizeItem(incomingItem))).toBe('Blueberries');
  });

  it('is a no-op when the names already match exactly', () => {
    const a = item({ itemName: 'Cold Brew Coffee', brand: 'Stok' });
    const b = item({ itemName: 'Cold Brew Coffee', brand: 'Stok' });
    expect(narrowCanonicalName(a.itemName, normalizeItem(a), normalizeItem(b))).toBe('Cold Brew Coffee');
  });
});
