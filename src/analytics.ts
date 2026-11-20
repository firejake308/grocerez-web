/**
 * Self-hosted Umami analytics (server/docker-compose.yml `umami` service).
 *
 * Off unless both VITE_UMAMI_SCRIPT_URL and VITE_UMAMI_WEBSITE_ID are set at
 * build time, so local dev, tests and forks send nothing. Set
 * VITE_UMAMI_DOMAINS (e.g. "grocerez.app") as well so deploy previews built
 * with the same variables don't count as production traffic.
 *
 * Umami's script records the page view on load by itself, including the
 * referrer and any utm_* parameters in the URL, so campaign links need no
 * code here. The app's screens share one URL, so everything past the first
 * page view is a custom event sent through `track`.
 *
 * Never put personal data in event data: no emails, no search text, no
 * coordinates.
 */

type EventData = Record<string, string | number | boolean>;

interface UmamiTracker {
  track: (name: string, data?: EventData) => void;
}

declare global {
  interface Window {
    umami?: UmamiTracker;
  }
}

/** Every custom event the app sends, in roughly funnel order. Funnels in Umami are built from these names. */
export type AnalyticsEvent =
  | 'launch_installed'
  | 'app_installed'
  | 'home_area_set'
  | 'search'
  | 'scan_started'
  | 'scan_parsed'
  | 'scan_failed'
  | 'report_saved'
  | 'signin_code_requested'
  | 'signin_completed'
  | 'checkout_started'
  | 'subscribed';

const MAX_QUEUED = 50;
const queue: [AnalyticsEvent, EventData | undefined][] = [];
let enabled = false;

function flush() {
  const umami = window.umami;
  if (!umami) return;
  for (const [name, data] of queue.splice(0)) umami.track(name, data);
}

export function initAnalytics(): void {
  const src = import.meta.env.VITE_UMAMI_SCRIPT_URL;
  const websiteId = import.meta.env.VITE_UMAMI_WEBSITE_ID;
  if (!src || !websiteId || typeof document === 'undefined') return;
  enabled = true;

  const script = document.createElement('script');
  script.defer = true;
  script.src = src;
  script.dataset.websiteId = websiteId;
  const domains = import.meta.env.VITE_UMAMI_DOMAINS;
  if (domains) script.dataset.domains = domains;
  script.onload = flush;
  document.head.appendChild(script);

  // Opened from the home screen icon rather than a browser tab.
  if (window.matchMedia?.('(display-mode: standalone)').matches) track('launch_installed');
  window.addEventListener('appinstalled', () => track('app_installed'));
}

/** Sends a custom event. Safe to call before the script loads (events queue) or when analytics is off (no-op). */
export function track(name: AnalyticsEvent, data?: EventData): void {
  if (!enabled) return;
  if (window.umami) {
    window.umami.track(name, data);
  } else if (queue.length < MAX_QUEUED) {
    // Still loading, or blocked by a content blocker: in the blocked case the queue just stops growing.
    queue.push([name, data]);
  }
}
