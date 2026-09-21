import { describe, it, expect } from 'vitest';
import { normalizePriceData } from './normalizePriceData';
import fixture from '../shared/__fixtures__/price-reports-sample.json';

describe('normalizePriceData migration', () => {
  const legacy = fixture.priceData; // exported before ids, updatedAt, or sale fields existed

  it('gives every legacy report a unique id and an updatedAt derived from its date', () => {
    const migrated = legacy.map(normalizePriceData);
    const ids = new Set(migrated.map((r) => r.id));
    expect(ids.size).toBe(legacy.length);
    expect(migrated[0].updatedAt).toBe('2025-04-15T00:00:00.000Z');
    expect(migrated.every((r) => r.origin === 'mine')).toBe(true);
    expect(migrated.every((r) => r.isSale === false && r.expiresAt === null)).toBe(true);
  });

  it('is idempotent: re-normalizing keeps the id and updatedAt', () => {
    const once = normalizePriceData(legacy[3]);
    const twice = normalizePriceData(once);
    expect(twice.id).toBe(once.id);
    expect(twice.updatedAt).toBe(once.updatedAt);
    expect(twice).toEqual(once);
  });

  it('falls back to now when the date is unusable', () => {
    const before = Date.now();
    const r = normalizePriceData({ itemName: 'Milk', price: 2.99, date: 'not a date' });
    expect(Date.parse(r.updatedAt)).toBeGreaterThanOrEqual(before);
    expect(r.price).toBe('2.99');
  });

  it('keeps valid sale fields and drops malformed ones', () => {
    expect(normalizePriceData({ itemName: 'x', price: '1', isSale: true, expiresAt: '2026-10-01' }).expiresAt).toBe('2026-10-01');
    expect(normalizePriceData({ itemName: 'x', price: '1', isSale: true, expiresAt: 'Oct 1' }).expiresAt).toBeNull();
    expect(normalizePriceData({ itemName: 'x', price: '1', origin: 'community' }).origin).toBe('community');
  });
});
