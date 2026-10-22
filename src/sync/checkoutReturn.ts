/**
 * Stripe sends the browser back to `${APP_URL}/?checkout=success|cancel`.
 * The app has no URL routing, so this just reads the flag once on load,
 * removes it from the address bar (so a refresh doesn't replay it), and --
 * because the webhook that actually grants access can land a moment after
 * the redirect -- polls the account until the subscription shows up.
 */

export type CheckoutReturn = 'success' | 'cancel';

export function readCheckoutReturn(search: string): CheckoutReturn | null {
  const value = new URLSearchParams(search).get('checkout');
  return value === 'success' || value === 'cancel' ? value : null;
}

/** The same URL without the `checkout` parameter; path, other parameters, and hash are kept. */
export function withoutCheckoutParam(href: string): string {
  const url = new URL(href);
  url.searchParams.delete('checkout');
  return `${url.pathname}${url.search}${url.hash}`;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Polls `getLevel` until it returns `target`. A failed lookup counts as
 * "not yet" rather than aborting, since the point is to ride out a slow
 * webhook. Resolves false if it never gets there.
 */
export async function waitForLevel(
  getLevel: () => Promise<string | null>,
  target: string,
  { attempts = 5, delayMs = 2000, sleep = realSleep }: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      if ((await getLevel()) === target) return true;
    } catch {
      // keep trying
    }
    if (i < attempts - 1) await sleep(delayMs);
  }
  return false;
}
