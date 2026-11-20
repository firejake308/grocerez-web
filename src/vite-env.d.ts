/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SYNC_API_URL?: string;
  /** Umami tracker script, e.g. https://stats.grocerez.app/script.js. Unset = no analytics. */
  readonly VITE_UMAMI_SCRIPT_URL?: string;
  readonly VITE_UMAMI_WEBSITE_ID?: string;
  /** Comma-separated hostnames the tracker may report from, e.g. grocerez.app. */
  readonly VITE_UMAMI_DOMAINS?: string;
}
