import type { PriceReportUpsert, PullResponseBody, PushResponseBody } from '../../shared/types';

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface Profile {
  id: string;
  email: string;
  displayName: string | null;
  homeLat: number | null;
  homeLon: number | null;
  tier: 'new' | 'restricted' | 'established' | 'trusted';
  counts: { reports: number; confirmed: number; upheldFlags: number };
  entitlement: { enforced: boolean; plan: 'free' | 'paid'; planExpiresAt: string | null };
}

export interface NearbyStore {
  storeId: string;
  name: string;
  address: string | null;
  lat: number;
  lon: number;
  distanceM: number;
}

export interface ReverseResult {
  houseNumber: string | null;
  road: string | null;
  suburb: string | null;
  label: string | null;
}

export interface GeocodeResult {
  label: string;
  lat: number;
  lon: number;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH';
  token?: string | null;
  body?: unknown;
  timeoutMs?: number;
}

/** Thin typed client for the sync server. `fetchImpl` is injectable for tests. */
export function createSyncApi(baseUrl: string, fetchImpl: typeof fetch = (...args) => fetch(...args)) {
  async function request<T>(path: string, { method = 'GET', token, body, timeoutMs = 15_000 }: RequestOptions = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      if (!res.ok) {
        const message = (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
        throw new ApiError(res.status, message);
      }
      return data as T;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    registerDevice: () => request<{ deviceToken: string }>('/api/devices/register', { method: 'POST' }),
    requestCode: (email: string) => request<{ ok: true }>('/api/auth/request-code', { method: 'POST', body: { email } }),
    verifyCode: (email: string, code: string) =>
      request<{ userId: string; sessionToken: string; expiresAt: string }>('/api/auth/verify', { method: 'POST', body: { email, code } }),
    signOut: (token: string) => request<{ ok: true }>('/api/auth/signout', { method: 'POST', token }),
    getMe: (token: string) => request<Profile>('/api/me', { token }),
    patchMe: (token: string, patch: { displayName?: string; homeLat?: number | null; homeLon?: number | null }) =>
      request<Profile>('/api/me', { method: 'PATCH', token, body: patch }),
    push: (token: string, reports: PriceReportUpsert[]) =>
      request<PushResponseBody>('/api/sync/push', { method: 'POST', token, body: { reports }, timeoutMs: 60_000 }),
    pull: (token: string, params: { since: number; lat: number; lon: number; radiusMi: number; limit?: number }) => {
      const q = new URLSearchParams({
        since: String(params.since),
        lat: String(params.lat),
        lon: String(params.lon),
        radiusMi: String(params.radiusMi),
        limit: String(params.limit ?? 500),
      });
      return request<PullResponseBody>(`/api/sync/pull?${q.toString()}`, { token, timeoutMs: 30_000 });
    },
    nearbyStores: (token: string, lat: number, lon: number) =>
      request<{ stores: NearbyStore[] }>(`/api/geo/nearby-stores?lat=${lat}&lon=${lon}`, { token, timeoutMs: 12_000 }),
    reverse: (token: string, lat: number, lon: number) =>
      request<ReverseResult>(`/api/geo/reverse?lat=${lat}&lon=${lon}`, { token, timeoutMs: 12_000 }),
    geocode: (token: string, q: string) =>
      request<{ results: GeocodeResult[] }>(`/api/geo/geocode?q=${encodeURIComponent(q)}`, { token, timeoutMs: 12_000 }),
  };
}

export type SyncApi = ReturnType<typeof createSyncApi>;
