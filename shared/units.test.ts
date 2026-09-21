import { describe, it, expect } from 'vitest';
import { parseQuantity, compareQuantities, canonicalUnit } from './units';
import fixture from './__fixtures__/price-reports-sample.json';

describe('canonicalUnit', () => {
  it('normalizes case, plurals, and trailing periods', () => {
    expect(canonicalUnit('OZ.')).toBe('ounce');
    expect(canonicalUnit('Oz')).toBe('ounce');
    expect(canonicalUnit('LBS')).toBe('pound');
    expect(canonicalUnit('GALLONS')).toBe('gallon');
    expect(canonicalUnit('gal')).toBe('gallon');
    expect(canonicalUnit('fl oz')).toBe('fluid ounce');
    expect(canonicalUnit('CT')).toBe('count');
    expect(canonicalUnit('rolls')).toBe('roll');
    expect(canonicalUnit('X 10 OZ')).toBeNull();
    expect(canonicalUnit('284-sheet rolls')).toBeNull();
  });
});

describe('parseQuantity', () => {
  it('converts within a family', () => {
    expect(compareQuantities(parseQuantity(64, 'fluid ounce'), parseQuantity(0.5, 'gallon'))).toBe('same');
    expect(compareQuantities(parseQuantity(1, 'pound'), parseQuantity(16, 'ounce'))).toBe('same');
    expect(compareQuantities(parseQuantity(1, 'gal'), parseQuantity(1, 'GALLONS'))).toBe('same');
    expect(compareQuantities(parseQuantity(12, 'count'), parseQuantity(1, 'dozen'))).toBe('same');
  });

  it('keeps different sizes and families apart', () => {
    expect(compareQuantities(parseQuantity(12, 'count'), parseQuantity(18, 'count'))).toBe('different');
    expect(compareQuantities(parseQuantity(1, 'pound'), parseQuantity(3, 'pound'))).toBe('different');
    expect(compareQuantities(parseQuantity(6, 'rolls'), parseQuantity(6, 'count'))).toBe('different');
    expect(compareQuantities(parseQuantity(16, 'ounce'), parseQuantity(16, 'fluid ounce'))).toBe('different');
  });

  it('treats generic count units as interchangeable', () => {
    expect(compareQuantities(parseQuantity(4, 'pack'), parseQuantity(4, 'package'))).toBe('same');
    expect(compareQuantities(parseQuantity(4, 'ct'), parseQuantity(4, 'each'))).toBe('same');
  });

  it('reports unknown rather than mismatch for unparseable or default sizes', () => {
    expect(parseQuantity(1, 'unit').family).toBe('unknown');
    expect(parseQuantity(4, 'X 10 OZ').family).toBe('unknown');
    expect(compareQuantities(parseQuantity(4, 'X 10 OZ'), parseQuantity(40, 'ounce'))).toBe('unknown');
  });

  it('recognizes the large majority of units in the real export', () => {
    const reports = fixture.priceData;
    const known = reports.filter((r) => parseQuantity(r.quantity, r.quantity_units).family !== 'unknown');
    expect(known.length / reports.length).toBeGreaterThan(0.9);
  });
});
