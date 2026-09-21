/**
 * Quantity/unit normalization. Follows the benchmark's unit-equivalence
 * policy: weight and volume convert within their family; count-like units are
 * interchangeable only inside the generic "count" group; everything else keeps
 * its label and only equals itself.
 */

export type UnitFamily = 'weight' | 'volume' | 'count' | 'unknown';

export interface ParsedQuantity {
  family: UnitFamily;
  /** Grams for weight, milliliters for volume, items for count, null when unknown. */
  baseQuantity: number | null;
  /** Canonical singular unit label (`ounce`, `count`, `roll`, ...) or the raw string when unknown. */
  label: string;
}

const WEIGHT_G: Record<string, number> = {
  ounce: 28.349523125,
  pound: 453.59237,
  gram: 1,
  kilogram: 1000,
};

const VOLUME_ML: Record<string, number> = {
  'fluid ounce': 29.5735295625,
  cup: 236.5882365,
  pint: 473.176473,
  quart: 946.352946,
  gallon: 3785.411784,
  liter: 1000,
  milliliter: 1,
};

/** Units that all mean "N items" and compare with each other. */
const GENERIC_COUNT = new Set(['count', 'each', 'pack', 'package', 'piece', 'unit', 'item']);

/** Count-like units that keep their own label: 6 rolls is not 6 count. */
const LABELED_COUNT = new Set([
  'can', 'bottle', 'roll', 'bag', 'box', 'bar', 'jar', 'tissue', 'sheet', 'bunch', 'head',
  'stick', 'cup', 'pouch', 'carton', 'tray', 'ear', 'slice', 'link', 'tablet', 'capsule',
]);

const ALIASES: Record<string, string> = {
  oz: 'ounce', ozs: 'ounce', ounce: 'ounce', ounces: 'ounce',
  'fl oz': 'fluid ounce', floz: 'fluid ounce', 'fluid oz': 'fluid ounce',
  'fluid ounce': 'fluid ounce', 'fluid ounces': 'fluid ounce', 'fl. oz': 'fluid ounce',
  lb: 'pound', lbs: 'pound', pound: 'pound', pounds: 'pound', '#': 'pound',
  g: 'gram', gram: 'gram', grams: 'gram', gr: 'gram',
  kg: 'kilogram', kilogram: 'kilogram', kilograms: 'kilogram',
  ml: 'milliliter', milliliter: 'milliliter', milliliters: 'milliliter', millilitre: 'milliliter', millilitres: 'milliliter',
  l: 'liter', liter: 'liter', liters: 'liter', litre: 'liter', litres: 'liter', ltr: 'liter',
  gal: 'gallon', gallon: 'gallon', gallons: 'gallon',
  qt: 'quart', quart: 'quart', quarts: 'quart',
  pt: 'pint', pint: 'pint', pints: 'pint',
  cup: 'cup', cups: 'cup',
  ct: 'count', count: 'count', counts: 'count', cnt: 'count',
  ea: 'each', each: 'each',
  pk: 'pack', pack: 'pack', packs: 'pack',
  pkg: 'package', pkgs: 'package', package: 'package', packages: 'package',
  pc: 'piece', pcs: 'piece', piece: 'piece', pieces: 'piece',
  unit: 'unit', units: 'unit', item: 'item', items: 'item',
  dozen: 'dozen', dz: 'dozen', doz: 'dozen',
  can: 'can', cans: 'can',
  bottle: 'bottle', bottles: 'bottle', btl: 'bottle',
  roll: 'roll', rolls: 'roll',
  bag: 'bag', bags: 'bag',
  box: 'box', boxes: 'box',
  bar: 'bar', bars: 'bar',
  jar: 'jar', jars: 'jar',
  tissue: 'tissue', tissues: 'tissue',
  sheet: 'sheet', sheets: 'sheet',
  bunch: 'bunch', bunches: 'bunch',
  head: 'head', heads: 'head',
  stick: 'stick', sticks: 'stick',
  pouch: 'pouch', pouches: 'pouch',
  carton: 'carton', cartons: 'carton',
  tray: 'tray', trays: 'tray',
  ear: 'ear', ears: 'ear',
  slice: 'slice', slices: 'slice',
  link: 'link', links: 'link',
  tablet: 'tablet', tablets: 'tablet',
  capsule: 'capsule', capsules: 'capsule',
};

/** Lowercase, trim, drop trailing periods, collapse whitespace. */
export const normalizeUnitString = (units: string): string =>
  units.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();

/** Canonical singular unit name, or null when unrecognized. */
export const canonicalUnit = (units: string): string | null => {
  const key = normalizeUnitString(units);
  if (!key) return null;
  return ALIASES[key] ?? null;
};

export const parseQuantity = (quantity: number | null | undefined, units: string | null | undefined): ParsedQuantity => {
  const raw = units ?? '';
  const unit = canonicalUnit(raw);
  const qty = typeof quantity === 'number' && Number.isFinite(quantity) && quantity > 0 ? quantity : null;
  const unknown: ParsedQuantity = { family: 'unknown', baseQuantity: null, label: normalizeUnitString(raw) };

  if (!unit || qty === null) return unknown;
  // The parser's fallback of "1 unit" carries no size information.
  if (unit === 'unit' && qty === 1) return unknown;

  if (unit in WEIGHT_G) return { family: 'weight', baseQuantity: qty * WEIGHT_G[unit], label: unit };
  if (unit in VOLUME_ML) return { family: 'volume', baseQuantity: qty * VOLUME_ML[unit], label: unit };
  if (unit === 'dozen') return { family: 'count', baseQuantity: qty * 12, label: 'count' };
  if (GENERIC_COUNT.has(unit)) return { family: 'count', baseQuantity: qty, label: 'count' };
  if (LABELED_COUNT.has(unit)) return { family: 'count', baseQuantity: qty, label: unit };
  return unknown;
};

/**
 * Whether two parsed quantities describe the same size. Unknown on either side
 * is "not comparable", which callers treat as neither a match nor a mismatch.
 */
export const compareQuantities = (
  a: ParsedQuantity,
  b: ParsedQuantity,
  tolerance = 0.03,
): 'same' | 'different' | 'unknown' => {
  if (a.family === 'unknown' || b.family === 'unknown') return 'unknown';
  if (a.baseQuantity === null || b.baseQuantity === null) return 'unknown';
  if (a.family !== b.family) return 'different';
  if (a.family === 'count' && a.label !== b.label) return 'different';
  const larger = Math.max(a.baseQuantity, b.baseQuantity);
  const diff = Math.abs(a.baseQuantity - b.baseQuantity);
  return diff / larger <= tolerance ? 'same' : 'different';
};
