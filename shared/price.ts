/**
 * Price-string parsing. Reports arrive as strings like "2.99", "$2.99", "$10",
 * "3/10.00", "3 for $11.11", "548" (a missed decimal point), or junk like
 * "$1 off". The server stores integer cents; the client uses this for
 * validation before sync.
 */

export interface ParsedPrice {
  /** Price of a single unit in cents. */
  cents: number;
  /** Set when the string was a multi-buy deal ("3/10.00" → 3); cents is already divided. */
  multiBuyCount?: number;
  /**
   * Set for bare integers of 100 or more with no decimal point ("548"), which
   * are far more often a missed decimal than a real price. Holds the
   * "did you mean" value in cents (548 → 548, i.e. $5.48).
   */
  likelyMissingDecimalCents?: number;
}

const MAX_CENTS = 1_000_000 * 100;

const toCents = (amount: string): number | null => {
  const n = Number(amount.replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  const cents = Math.round(n * 100);
  return cents > MAX_CENTS ? null : cents;
};

export const parsePrice = (raw: string | number | null | undefined): ParsedPrice | null => {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    const cents = Math.round(raw * 100);
    return cents > MAX_CENTS ? null : { cents };
  }
  if (typeof raw !== 'string') return null;

  const s = raw.trim().toLowerCase().replace(/^\$\s*/, '').replace(/\s+/g, ' ');
  if (!s) return null;

  // "3/10.00", "3 for 11.11", "3 for $11.11", "2/$5"
  const multi = s.match(/^(\d+)\s*(?:\/|for)\s*\$?\s*(\d[\d,]*(?:\.\d{1,2})?)$/);
  if (multi) {
    const n = Number(multi[1]);
    const total = toCents(multi[2]);
    if (!n || total === null) return null;
    return { cents: Math.round(total / n), multiBuyCount: n };
  }

  const plain = s.match(/^(\d[\d,]*(?:\.\d{1,2})?)$/);
  if (!plain) return null;
  const cents = toCents(plain[1]);
  if (cents === null) return null;

  const isBareInteger = !plain[1].includes('.');
  if (isBareInteger && cents >= 100 * 100) {
    return { cents, likelyMissingDecimalCents: cents / 100 };
  }
  return { cents };
};

/** "2.99" → "$2.99"; used for display. */
export const formatCents = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
