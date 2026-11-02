import { describe, it, expect } from 'vitest';
import { excludeOwnReports } from './excludeOwnReports';
import PriceData from './PriceData';

const report = (id: string, origin: 'mine' | 'community', extra: Partial<PriceData> = {}): PriceData => ({
  id,
  price: '7.99',
  store: 'Kroger',
  date: '2026-07-18',
  priceImage: null,
  productImage: null,
  itemName: 'Buldak Spicy Ramen',
  brand: 'Samyang',
  tags: [],
  quantity: 24.65,
  quantity_units: 'ounce',
  updatedAt: '2026-07-18T00:00:00.000Z',
  origin,
  ...extra,
});

describe('excludeOwnReports', () => {
  it('drops community copies of the user\'s own uploads', () => {
    const own = [report('a', 'mine')];
    const pulled = [report('a', 'community'), report('b', 'community')];
    expect(excludeOwnReports(pulled, own).map((r) => r.id)).toEqual(['b']);
  });

  it('also hides community copies of locally deleted (tombstoned) reports', () => {
    const own = [report('a', 'mine', { deletedAt: '2026-10-01T00:00:00.000Z' })];
    expect(excludeOwnReports([report('a', 'community')], own)).toEqual([]);
  });

  it('keeps everything when there is no overlap', () => {
    const pulled = [report('b', 'community'), report('c', 'community')];
    expect(excludeOwnReports(pulled, [report('a', 'mine')])).toEqual(pulled);
  });
});
