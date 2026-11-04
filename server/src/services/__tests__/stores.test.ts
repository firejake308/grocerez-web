import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { runMigrations } from '../../db/migrate.js';
import type { AppDb } from '../../db/client.js';
import { normalizeChainKey, resolveStore, splitStoreString } from '../stores.js';

describe('splitStoreString', () => {
  it('splits the normal "Name @ Address" form', () => {
    expect(splitStoreString('Kroger @ 9150 North Tarrant Parkway')).toEqual({
      chainRaw: 'Kroger',
      addressRaw: '9150 North Tarrant Parkway',
    });
  });

  it('treats a bare chain name (with trailing whitespace) as chain-only', () => {
    expect(splitStoreString('Kroger ')).toEqual({ chainRaw: 'Kroger', addressRaw: null });
  });

  it('treats a bare address as address-only', () => {
    expect(splitStoreString('9410 Webb Chapel Road')).toEqual({ chainRaw: null, addressRaw: '9410 Webb Chapel Road' });
  });

  it('strips "undefined" fragments from a reverse-geocode miss', () => {
    expect(splitStoreString('undefined La Cima')).toEqual({ chainRaw: 'La Cima', addressRaw: null });
    expect(splitStoreString('WinCo Foods @ undefined Presidio Vista Drive')).toEqual({
      chainRaw: 'WinCo Foods',
      addressRaw: 'Presidio Vista Drive',
    });
  });

  it('returns nulls for an empty string', () => {
    expect(splitStoreString('   ')).toEqual({ chainRaw: null, addressRaw: null });
  });
});

describe('normalizeChainKey', () => {
  it('collapses known spelling variants', () => {
    expect(normalizeChainKey('HEB')).toBe(normalizeChainKey('H-E-B'));
    expect(normalizeChainKey('Walmart Supercenter')).toBe(normalizeChainKey('Walmart Supercenter')); // sanity
    expect(normalizeChainKey('Walmart Supercenter')).toBe('walmart');
    expect(normalizeChainKey('Kroger Marketplace')).toBe('kroger');
    expect(normalizeChainKey('Halal Imports')).toBe(normalizeChainKey('Halal Import Foods'));
  });
});

describe('resolveStore', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
  });

  afterEach(() => {
    sqlite.close();
  });

  it('resolves the same chain + location to the same store across spelling variants', () => {
    const a = resolveStore(db, { rawStore: 'HEB @ 3451 Heritage Trace Parkway', lat: 32.9159533, lon: -97.3080462 });
    const b = resolveStore(db, { rawStore: 'H-E-B @ 3451 Heritage Trace Parkway', lat: 32.9159533, lon: -97.3080462 });
    expect(b.id).toBe(a.id);
  });

  it('resolves Walmart and Walmart Supercenter at the same location to the same store', () => {
    const a = resolveStore(db, { rawStore: 'Walmart Supercenter @ 9410 Webb Chapel Road', lat: 32.8622349, lon: -96.8569436 });
    const b = resolveStore(db, { rawStore: 'Walmart @ 9410 Webb Chapel Road', lat: 32.8622349, lon: -96.8569436 });
    expect(b.id).toBe(a.id);
  });

  it('refuses a store without a location', () => {
    expect(() => resolveStore(db, { rawStore: 'Kroger ' } as never)).toThrow(/location/);
    expect(() => resolveStore(db, { rawStore: 'Kroger', lat: NaN, lon: -97 })).toThrow(/location/);
  });

  it('keeps the same chain at different places as different stores', () => {
    const a = resolveStore(db, { rawStore: 'Kroger', lat: 32.9019798, lon: -97.1889734 });
    const b = resolveStore(db, { rawStore: 'Kroger', lat: 30.2672, lon: -97.7431 });
    expect(b.id).not.toBe(a.id);
    expect(a.isChainLevel).toBe(false);
  });

  it('attaches a bare address with coordinates to the named store already known there', () => {
    const named = resolveStore(db, { rawStore: 'Walmart Supercenter @ 9410 Webb Chapel Road', lat: 32.8622349, lon: -96.8569436 });
    const bare = resolveStore(db, { rawStore: '9410 Webb Chapel Road', lat: 32.8622349, lon: -96.8569436 });
    expect(bare.id).toBe(named.id);
    expect(bare.name).toBe(named.name);
  });

  it('creates a standalone store for a bare address with no named store known there', () => {
    const a = resolveStore(db, { rawStore: '5055 Northwest Loop 410', lat: 29.5, lon: -98.5 });
    const b = resolveStore(db, { rawStore: '5025 Northwest Loop 410', lat: 29.6, lon: -98.6 });
    expect(a.id).not.toBe(b.id);
  });

  it('is idempotent for the exact same input', () => {
    const a = resolveStore(db, { rawStore: 'Kroger @ 9150 North Tarrant Parkway', lat: 32.9019798, lon: -97.1889734 });
    const b = resolveStore(db, { rawStore: 'Kroger @ 9150 North Tarrant Parkway', lat: 32.9019798, lon: -97.1889734 });
    expect(a.id).toBe(b.id);
  });

  it('keeps different chains at the same location apart', () => {
    const kroger = resolveStore(db, { rawStore: 'Kroger @ 9150 North Tarrant Parkway', lat: 32.9019798, lon: -97.1889734 });
    const gnc = resolveStore(db, { rawStore: 'GNC @ 9160 North Tarrant Parkway', lat: 32.9022718, lon: -97.1879827 });
    expect(kroger.id).not.toBe(gnc.id);
  });
});
