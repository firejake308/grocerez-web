import { describe, it, expect } from 'vitest';
import { filterBySearchQuery, tokenize } from './searchUtils';
import PriceData from './PriceData';

describe('tokenize', () => {
  it('converts to lowercase and splits by whitespace', () => {
    const tokens = tokenize('Cold Brew Coffee');
    expect(tokens).toEqual(new Set(['cold', 'brew', 'coffee']));
  });

  it('removes punctuation', () => {
    const tokens = tokenize("Driscoll's Blueberries");
    expect(tokens).toEqual(new Set(['driscolls', 'blueberries']));
  });

  it('handles empty strings', () => {
    expect(tokenize('')).toEqual(new Set());
  });
});

describe('filterBySearchQuery', () => {
  const mockData: PriceData[] = [
    {
      price: '3.49',
      store: 'Kroger @ 9150 North Tarrant Parkway',
      date: '2026-07-15',
      priceImage: null,
      productImage: null,
      itemName: 'Oreo BTS Brown Sugar Pancake Flavor Cream Sandwich Cookies',
      brand: 'Oreo',
      tags: ['cookies', 'snacks', 'dessert'],
      quantity: 11.18,
      quantity_units: 'ounce',
      latitude: 32.9019798,
      longitude: -97.1889734,
    },
    {
      price: '3.49',
      store: 'Kroger @ 9150 North Tarrant Parkway',
      date: '2026-07-15',
      priceImage: null,
      productImage: null,
      itemName: 'Oreo Double Stuf Chocolate Sandwich Cookies',
      brand: 'Oreo',
      tags: ['cookies', 'chocolate', 'sandwich cookies', 'dessert'],
      quantity: 2.71,
      quantity_units: 'ounce',
      latitude: 32.9019798,
      longitude: -97.1889734,
    },
    {
      price: '1.47',
      store: 'Walmart Supercenter @ 9410 Webb Chapel Road',
      date: '2026-08-01',
      priceImage: null,
      productImage: null,
      itemName: 'Large White Eggs',
      brand: 'Great Value',
      tags: ['eggs', 'dairy', 'breakfast'],
      quantity: 12,
      quantity_units: 'count',
      latitude: 32.8622349,
      longitude: -96.8569436,
    },
    {
      price: '3.87',
      store: 'Walmart',
      date: '2026-08-23',
      priceImage: null,
      productImage: null,
      itemName: 'Large Eggs',
      brand: 'Eggland\'s Best',
      tags: ['eggs', 'breakfast', 'protein', 'baking'],
      quantity: 12,
      quantity_units: 'count',
      latitude: null,
      longitude: null,
    },
    {
      price: '6.79',
      store: 'Kroger',
      date: '2026-08-23',
      priceImage: null,
      productImage: null,
      itemName: 'Cold Brew Coffee',
      brand: 'Stok',
      tags: ['coffee', 'cold brew', 'beverage'],
      quantity: 48,
      quantity_units: 'fluid ounce',
      latitude: null,
      longitude: null,
    },
    {
      price: '5.97',
      store: 'Walmart Supercenter @ 9410 Webb Chapel Road',
      date: '2026-08-01',
      priceImage: null,
      productImage: null,
      itemName: 'Cold Brew Coffee',
      brand: 'Stok',
      tags: ['coffee', 'cold brew', 'beverage'],
      quantity: 48,
      quantity_units: 'fluid ounce',
      latitude: 32.8622349,
      longitude: -96.8569436,
    },
    {
      price: '1.29',
      store: 'Kroger',
      date: '2026-07-16',
      priceImage: null,
      productImage: null,
      itemName: 'Soon Veggie Cup Noodles',
      brand: 'Nongshim',
      tags: ['instant noodles', 'ramen', 'cup noodles', 'vegetarian'],
      quantity: 2.64,
      quantity_units: 'ounce',
      latitude: null,
      longitude: null,
    },
  ];

  it('finds items by exact word match', () => {
    const results = filterBySearchQuery(mockData, 'eggs');
    expect(results).toHaveLength(2);
    expect(results.map(r => r.itemName)).toContain('Large White Eggs');
    expect(results.map(r => r.itemName)).toContain('Large Eggs');
  });

  it('handles plural "oreos" matching singular "oreo" brand', () => {
    const results = filterBySearchQuery(mockData, 'oreos');
    expect(results).toHaveLength(2);
    expect(results.every(r => r.brand === 'Oreo')).toBe(true);
  });

  it('finds items by singular word when plural exists', () => {
    const results = filterBySearchQuery(mockData, 'oreo');
    expect(results).toHaveLength(2);
    expect(results.every(r => r.brand === 'Oreo')).toBe(true);
  });

  it('prevents false positive: "egg" does not match "veggie"', () => {
    const results = filterBySearchQuery(mockData, 'egg');
    expect(results).not.toContainEqual(
      expect.objectContaining({
        itemName: 'Soon Veggie Cup Noodles',
      })
    );
    expect(results.every(r => r.tags?.includes('eggs') || r.itemName.includes('Eggs'))).toBe(true);
  });

  it('finds items by multi-word search', () => {
    const results = filterBySearchQuery(mockData, 'cold brew');
    expect(results).toHaveLength(2);
    expect(results.every(r => r.brand === 'Stok')).toBe(true);
  });

  it('finds items from multiple stores with same product', () => {
    const results = filterBySearchQuery(mockData, 'coffee');
    const stores = new Set(results.map(r => r.store));
    expect(stores.size).toBeGreaterThanOrEqual(2);
  });

  it('returns empty array for no matches', () => {
    const results = filterBySearchQuery(mockData, 'xyz123notfound');
    expect(results).toHaveLength(0);
  });

  it('handles case insensitivity', () => {
    const resultsLower = filterBySearchQuery(mockData, 'oreo');
    const resultsUpper = filterBySearchQuery(mockData, 'OREO');
    const resultsMixed = filterBySearchQuery(mockData, 'OrEo');
    expect(resultsLower).toHaveLength(resultsUpper.length);
    expect(resultsLower).toHaveLength(resultsMixed.length);
  });

  it('searches in tags as well as item name and brand', () => {
    const results = filterBySearchQuery(mockData, 'beverage');
    expect(results.map(r => r.itemName)).toContain('Cold Brew Coffee');
    expect(results.length).toBeGreaterThan(0);
  });

  it('handles empty query', () => {
    expect(filterBySearchQuery(mockData, '')).toHaveLength(0);
    expect(filterBySearchQuery(mockData, '   ')).toHaveLength(0);
  });

  it('finds partial word matches using prefixes', () => {
    const results = filterBySearchQuery(mockData, 'cook');
    expect(results.some(r => r.itemName.includes('Cookies'))).toBe(true);
  });
});
