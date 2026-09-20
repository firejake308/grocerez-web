/**
 * Text normalization shared by the client search and the server-side product
 * matcher. Pure functions, no dependencies.
 */

/** Lowercase, strip punctuation, split on whitespace. `"Driscoll's"` → `driscolls`. */
export const tokenize = (s: string): Set<string> =>
  new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean));

/**
 * The prefix rule the search has always used: two tokens match when equal or
 * when one is a prefix of the other. `minPrefix` lets the matcher demand a
 * longer shared prefix than the search does (the search keeps `egg` ~ `eggs`).
 * The floor is 2, not 1: a stray single-letter token (e.g. "a" from "Grade A
 * Eggs") would otherwise prefix-match every query word starting with that
 * letter, e.g. "apple".
 */
export const tokensMatch = (a: string, b: string, minPrefix = 2): boolean => {
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = shorter === a ? b : a;
  return shorter.length >= minPrefix && longer.startsWith(shorter);
};

/** Words that carry no product identity. */
export const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'of', 'with', 'and', 'in', 'for', 'by', 'or', 'n', 'flavor', 'flavored',
]);

/** Irregular or ambiguous plurals seen in grocery names. */
const SINGULAR_EXCEPTIONS: Record<string, string> = {
  berries: 'berry',
  blueberries: 'blueberry',
  strawberries: 'strawberry',
  raspberries: 'raspberry',
  blackberries: 'blackberry',
  cherries: 'cherry',
  cranberries: 'cranberry',
  cookies: 'cookie',
  veggies: 'veggie',
  candies: 'candy',
  tomatoes: 'tomato',
  potatoes: 'potato',
  mangoes: 'mango',
  avocados: 'avocado',
  chips: 'chip',
  oats: 'oat',
  grits: 'grits',
  hummus: 'hummus',
  asparagus: 'asparagus',
  gas: 'gas',
  lens: 'lens',
};

/** Small rule-based singularizer. Consistency matters more than correctness. */
export const singularize = (token: string): string => {
  if (token.length <= 3) return token;
  const exception = SINGULAR_EXCEPTIONS[token];
  if (exception) return exception;
  if (token.endsWith('ss') || token.endsWith('us') || token.endsWith('is')) return token;
  if (token.endsWith('sses')) return token.slice(0, -2);
  if (/(sh|ch|x|z)es$/.test(token)) return token.slice(0, -2);
  if (token.endsWith('ies') && token.length > 4) return token.slice(0, -3) + 'y';
  if (token.endsWith('s')) return token.slice(0, -1);
  return token;
};

/**
 * Tokens that identify a product name: tokenized, stopwords removed,
 * singularized, and with the brand's own tokens removed so a brand repeated in
 * the name neither helps nor hurts a comparison.
 */
export const nameTokens = (name: string, brand = ''): Set<string> => {
  const brandTokens = new Set(Array.from(tokenize(brand)).map(singularize));
  const out = new Set<string>();
  for (const raw of tokenize(name)) {
    if (STOPWORDS.has(raw)) continue;
    const t = singularize(raw);
    if (brandTokens.has(t)) continue;
    out.add(t);
  }
  return out;
};

/** Normalized brand key. Store brands with long suffixes collapse to their short form. */
const BRAND_ALIASES: Record<string, string> = {
  '365 by whole foods market': '365',
  '365 whole foods market': '365',
  '365 by whole foods': '365',
  'kirkland signature': 'kirkland',
  'kroger brand': 'kroger',
  'kroger big k': 'big k',
  'h-e-b': 'heb',
  'hill country fare': 'hill country fare',
  'annies homegrown': 'annies',
  'clif bar': 'clif',
  'clif kid': 'clif',
};

export const brandKey = (brand: string): string => {
  const cleaned = brand.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  const aliased = BRAND_ALIASES[cleaned] ?? cleaned;
  // Brands are names, not plurals: "Annie's" must not become "anny".
  return Array.from(tokenize(aliased)).join(' ');
};

/** Dice coefficient over two token sets using the prefix rule for equality. */
export const diceSimilarity = (a: Set<string>, b: Set<string>, minPrefix = 4): number => {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let matches = 0;
  for (const ta of a) {
    for (const tb of b) {
      if (tokensMatch(ta, tb, minPrefix)) {
        matches++;
        break;
      }
    }
  }
  return (2 * matches) / (a.size + b.size);
};
