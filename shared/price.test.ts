import { describe, it, expect } from 'vitest';
import { parsePrice, formatCents } from './price';
import fixture from './__fixtures__/price-reports-sample.json';

describe('parsePrice', () => {
  it('parses plain and dollar-prefixed prices', () => {
    expect(parsePrice('2.99')).toEqual({ cents: 299 });
    expect(parsePrice('$2.99')).toEqual({ cents: 299 });
    expect(parsePrice('$10')).toEqual({ cents: 1000 });
    expect(parsePrice('$19.7')).toEqual({ cents: 1970 });
    expect(parsePrice('6.5')).toEqual({ cents: 650 });
    expect(parsePrice(3.49)).toEqual({ cents: 349 });
    expect(parsePrice('1,234.56')).toEqual({ cents: 123456 });
  });

  it('divides multi-buy deals', () => {
    expect(parsePrice('3/10.00')).toEqual({ cents: 333, multiBuyCount: 3 });
    expect(parsePrice('3 for $11.11')).toEqual({ cents: 370, multiBuyCount: 3 });
    expect(parsePrice('2/$5')).toEqual({ cents: 250, multiBuyCount: 2 });
  });

  it('flags a likely missed decimal point', () => {
    expect(parsePrice('548')).toEqual({ cents: 54800, likelyMissingDecimalCents: 548 });
    expect(parsePrice('99')).toEqual({ cents: 9900 });
  });

  it('rejects junk', () => {
    expect(parsePrice('$1 off')).toBeNull();
    expect(parsePrice('')).toBeNull();
    expect(parsePrice('free')).toBeNull();
    expect(parsePrice('0')).toBeNull();
    expect(parsePrice(-1)).toBeNull();
    expect(parsePrice(null)).toBeNull();
  });

  it('accepts every price in the real export except the one known junk value', () => {
    const rejected = fixture.priceData.filter((r) => parsePrice(r.price) === null).map((r) => r.price);
    expect(rejected).toEqual(['$1 off']);
  });
});

describe('formatCents', () => {
  it('formats for display', () => {
    expect(formatCents(299)).toBe('$2.99');
    expect(formatCents(1000)).toBe('$10.00');
  });
});
