import { describe, it, expect } from 'vitest';
import { matchesQuery, queryTokens } from './search';

describe('matchesQuery', () => {
  const eggs = { itemName: 'Large Eggs', brand: "Vital Farms", tags: ['organic'] };

  it('needs every query token to match a token of the name, brand or tags', () => {
    expect(matchesQuery(eggs, 'eggs')).toBe(true);
    expect(matchesQuery(eggs, 'vital eggs')).toBe(true);
    expect(matchesQuery(eggs, 'organic')).toBe(true);
    expect(matchesQuery(eggs, 'eggs milk')).toBe(false);
  });

  it('matches by prefix in either direction, but not on a single letter', () => {
    expect(matchesQuery(eggs, 'egg')).toBe(true);
    expect(matchesQuery({ itemName: 'Egg Noodles' }, 'eggs')).toBe(true);
    expect(matchesQuery({ itemName: 'Grade A Eggs' }, 'apple')).toBe(false);
  });

  it('ignores case and punctuation', () => {
    expect(matchesQuery({ itemName: "Driscoll's Strawberries" }, "DRISCOLLS")).toBe(true);
  });

  it('never matches an empty query or an item without a name', () => {
    expect(matchesQuery(eggs, '   ')).toBe(false);
    expect(matchesQuery(eggs, '!!')).toBe(false);
    expect(matchesQuery({ itemName: '' }, 'eggs')).toBe(false);
    expect(queryTokens('  Large  EGGS ')).toEqual(['large', 'eggs']);
  });
});
