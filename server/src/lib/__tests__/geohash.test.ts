import { describe, it, expect } from 'vitest';
import { geohash, haversineMiles } from '../geohash.js';

describe('geohash', () => {
  it('matches the well-known Wikipedia example', () => {
    // https://en.wikipedia.org/wiki/Geohash#Worked_example
    expect(geohash(42.6, -5.6, 5)).toBe('ezs42');
  });

  it('produces the requested precision', () => {
    expect(geohash(32.9019798, -97.1889734, 7)).toHaveLength(7);
  });

  it('gives nearby points the same cell and far points different ones', () => {
    const a = geohash(32.9019798, -97.1889734, 7);
    const bNearby = geohash(32.9019800, -97.1889730, 7); // a few meters away
    const cFar = geohash(40.7128, -74.006, 7); // New York
    expect(a).toBe(bNearby);
    expect(a).not.toBe(cFar);
  });
});

describe('haversineMiles', () => {
  it('is zero for the same point', () => {
    expect(haversineMiles(32.9, -97.1, 32.9, -97.1)).toBe(0);
  });

  it('is roughly right for a known distance (Dallas to Fort Worth, ~30 mi)', () => {
    const d = haversineMiles(32.7767, -96.797, 32.7555, -97.3308);
    expect(d).toBeGreaterThan(25);
    expect(d).toBeLessThan(35);
  });
});
