/**
 * Sync is opt-in per deployment: the whole feature (settings screen, home
 * button, background sync, geo proxy) stays hidden unless VITE_SYNC_API_URL
 * is set, so the existing Netlify deploy is unaffected until the server is
 * live (docs/server-sync-plan.md section 13.2).
 */
const configuredUrl = ((import.meta.env.VITE_SYNC_API_URL as string | undefined) ?? '').replace(/\/+$/, '');

// TEMPORARY: Netlify deploy previews talk to the real API so production data can be debugged from a phone. Remove before merging.
const isDeployPreview = typeof window !== 'undefined' && window.location.hostname.startsWith('deploy-preview-');
export const SYNC_API_URL: string = isDeployPreview ? 'https://api.grocerez.app' : configuredUrl;

export const syncEnabled = (): boolean => SYNC_API_URL.length > 0;

/** Default pull radius (plan section 7); the server caps it at 100. */
export const PULL_RADIUS_MI = 50;
