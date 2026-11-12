import { describe, it, expect, vi, beforeEach } from 'vitest';

const api = vi.hoisted(() => ({ nearbyStores: vi.fn(), reverse: vi.fn() }));
vi.mock('./api', () => ({ createSyncApi: () => api }));
vi.mock('./config', () => ({ SYNC_API_URL: 'https://api.test', syncEnabled: () => true }));
vi.mock('./storage', () => ({ localSyncStorage: { getAuth: () => null, getDeviceToken: () => 'device-token' } }));

import { locateViaApi } from './storeLocator';

const store = (overrides: Record<string, unknown> = {}) => ({ name: 'WinCo Foods', address: null, lat: 32.9033, lon: -97.3208, distanceM: 20, ...overrides });

beforeEach(() => {
  api.nearbyStores.mockReset();
  api.reverse.mockReset();
});

describe('locateViaApi', () => {
  it('uses the address the server already knows, without a reverse lookup', async () => {
    api.nearbyStores.mockResolvedValue({ stores: [store({ address: '8968 Tehama Ridge Parkway' })] });
    expect(await locateViaApi(32.9, -97.3)).toEqual({ label: 'WinCo Foods @ 8968 Tehama Ridge Parkway', lat: 32.9033, lon: -97.3208 });
    expect(api.reverse).not.toHaveBeenCalled();
  });

  it('reverse-geocodes the store when the server has no address for it (OpenStreetMap lacks the tags)', async () => {
    api.nearbyStores.mockResolvedValue({ stores: [store()] });
    api.reverse.mockResolvedValue({ houseNumber: '8968', road: 'Tehama Ridge Parkway', suburb: null, label: '8968 Tehama Ridge Parkway' });
    expect(await locateViaApi(32.9, -97.3)).toEqual({ label: 'WinCo Foods @ 8968 Tehama Ridge Parkway', lat: 32.9033, lon: -97.3208 });
    expect(api.reverse).toHaveBeenCalledWith('device-token', 32.9033, -97.3208); // the store's position, not the user's
  });

  it('keeps the name-only label, and the API path, when the reverse lookup fails or finds nothing', async () => {
    api.nearbyStores.mockResolvedValue({ stores: [store()] });
    api.reverse.mockRejectedValueOnce(new Error('503'));
    expect(await locateViaApi(32.9, -97.3)).toEqual({ label: 'WinCo Foods', lat: 32.9033, lon: -97.3208 });
    api.reverse.mockResolvedValueOnce({ houseNumber: null, road: null, suburb: null, label: null });
    expect((await locateViaApi(32.9, -97.3))?.label).toBe('WinCo Foods');
  });

  it('still reverse-geocodes the user position when no store is known nearby', async () => {
    api.nearbyStores.mockResolvedValue({ stores: [] });
    api.reverse.mockResolvedValue({ houseNumber: null, road: 'Maple Avenue', suburb: null, label: 'Maple Avenue' });
    expect(await locateViaApi(32.8, -96.8)).toEqual({ label: 'Maple Avenue', lat: 32.8, lon: -96.8 });
  });
});
