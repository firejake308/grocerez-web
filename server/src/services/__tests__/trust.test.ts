import { describe, it, expect } from 'vitest';
import { trustScore, trustTier } from '../trust.js';

describe('trustScore', () => {
  it('is 0.5 for a user with no confirmations or flags', () => {
    expect(trustScore(0, 0)).toBe(0.5);
  });

  it('rises with confirmations and falls with upheld flags', () => {
    expect(trustScore(10, 0)).toBeGreaterThan(trustScore(0, 0));
    expect(trustScore(0, 3)).toBeLessThan(trustScore(0, 0));
  });
});

describe('trustTier', () => {
  it('is "new" below 3 reports regardless of score', () => {
    expect(trustTier(0, 0, 0)).toBe('new');
    expect(trustTier(2, 50, 0)).toBe('new');
  });

  it('graduates from established to trusted as confirmations pile up', () => {
    expect(trustTier(3, 0, 0)).toBe('established'); // score 0.5
    expect(trustTier(3, 10, 0)).toBe('trusted'); // score 11/12
  });

  it('drops to restricted once upheld flags dominate', () => {
    expect(trustTier(3, 0, 5)).toBe('restricted'); // score 1/17
  });
});
