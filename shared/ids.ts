/**
 * Minimal shape of the Web Crypto API used here, spelled out locally so this
 * file needs neither DOM lib (for the server's Node-only tsconfig) nor
 * @types/node's Node-flavored `crypto` global (for the client's browser one).
 */
interface MinimalCrypto {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

/** Client-generated report ids. UUID v4 where available, otherwise a random hex string. */
export const newReportId = (): string => {
  const c = (globalThis as { crypto?: MinimalCrypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  if (c && typeof c.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
};
