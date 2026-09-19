import { eq, sql } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { parseSpendDaily } from '../db/schema.js';
import type { ParsedPriceFields } from '../../../shared/types.js';

/**
 * The AI parse proxy (Phase 3): the prompt, the OpenRouter call, and the
 * response parsing that used to live client-side in `src/parsePriceImage.ts`.
 * Moved server-side so the OpenRouter key never ships in the client bundle.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const PROMPT_TEXT = "I will show you two images. The first is a price tag and the second is the product itself. "
  + "Please extract the price, itemName, brand, quantity, and quantityUnits. "
  + "Use both images to improve accuracy. The product image may help identify the brand and item name. "
  + "Expand all abbreviations in itemName and brand (e.g. 'Org' → 'Organic', 'Chkn' → 'Chicken', 'Stk' → 'Steak', 'Whl' → 'Whole', 'Veg' → 'Vegetable'). "
  + "For quantityUnits, always use the full singular unit name (e.g. 'oz' → 'ounce', 'lb' → 'pound', 'fl oz' → 'fluid ounce', 'ct' → 'count', 'pkg' → 'package', 'gal' → 'gallon', 'qt' → 'quart', 'pt' → 'pint'). "
  + "For products sold as a multipack of individually-used disposable items (e.g. tissues, wipes, paper towels, diapers, napkins), report quantity as the total count of individual units across the whole package, not the number of boxes/rolls/packs — for example, 4 boxes of tissues at 65 tissues per box is quantity 260 with quantityUnits 'tissue'. Use the count printed per box/roll together with the number of boxes/rolls to compute this total when both are visible; otherwise fall back to the box/roll/pack count. "
  + "The price is normally just the single dollar amount shown as the main price on the tag — report that number as-is. Only divide it when the tag is explicitly advertising a multi-buy deal for multiple separate purchases, phrased like '10/10.00', '3 for $11.11', 'buy 3 get 1 free', or a discount tier — in that case only, compute and report price as the price of a single unit, as a plain decimal number, never a slash, fraction, or the word 'for' (e.g. '10/10.00' becomes 1.00). Do NOT divide the price just because the package itself contains multiple items (e.g. a '4 count' box, a '12 pack', a '4/160 ct' multi-box case) — that count describes the package contents, not a multi-buy price deal, so the full tag price is the answer as long as only one item of that package is being purchased. "
  + "If the tag lists two prices gated by a loyalty card or membership, which one to report depends on whether that card/membership is free: if it's a free loyalty card (e.g. a store's free rewards/plus card, the common case for 'regular price' vs 'price with card' tags), report the lower with-card price. If the discount requires a paid membership on top of otherwise-normal shopping (e.g. a 'Prime member price' shown next to a regular price), report the higher regular, non-member price instead, since most shoppers won't have paid for that membership. At a warehouse club where membership is required just to shop there at all (e.g. Costco, Sam's Club), there is no separate non-member price to choose between — just report whatever single price is shown. "
  + "For loose produce sold by weight with no packaging (e.g. apples piled in a bin, priced per pound), include the tag 'bulk' and do not report a 'bagged' or 'bag' tag. For the same kind of item sold pre-packaged in a bag (e.g. a 3 lb bag of apples), include the tag 'bagged' and do not report a 'bulk' tag. Never include both. "
  + "In addition to price, itemName, brand, quantity, and quantityUnits, infer 2-4 tags: lowercase "
  + "generic grocery search terms a shopper might type to find this product, based on what kind of "
  + "product it is — not text printed on the packaging or price tag. Favor broader category words that "
  + "don't already appear in itemName. A common, accurate category phrase for how this type of product is "
  + "normally sold (e.g. 'shredded cheese' for a bag of shredded cheese, 'sliced cheese' for deli-style "
  + "cheese slices) is a good tag on its own and should NOT be swapped out for a narrower-sounding "
  + "alternative just to seem more specific (e.g. don't replace 'shredded cheese' with 'italian cheese' or "
  + "'pizza cheese'). The only tags to avoid are whole-department, catch-all words that describe a huge "
  + "swath of unrelated grocery items rather than this product specifically — e.g. 'produce', 'food', "
  + "'grocery', 'snack', 'dairy', or 'beverage' used by themselves. It's fine, and often correct, to use a "
  + "well-known brand name generically as a tag even when the actual brand is a different manufacturer "
  + "(e.g. tagging a store-brand facial tissue 'kleenex', or a store-brand sandwich cookie 'oreo'), since "
  + "shoppers commonly search that way — just don't put that generic name in the brand field itself, which "
  + "should always be the true manufacturer/brand shown on the packaging. Tags must describe only the "
  + "product actually pictured, not other products commonly bought alongside it (e.g. a bag of pita chips "
  + "should not be tagged 'dip' or 'hummus' just because people often eat them together). For example, a "
  + "package showing 'Buldak Spicy Ramen' should get tags like 'noodles' and 'instant noodles' even though "
  + "neither word is printed on it; 'Frozen Greek Yogurt Bars' should get 'yogurt' and 'frozen dessert'. "
  + "Return tags as a JSON array of strings. "
  + "If the tag shows a sale, promotional, or temporarily reduced price (words like 'sale', 'special', 'save', a crossed-out regular price, or a date range), set isSale to true; otherwise set it to false. "
  + "If a sale end date is printed on the tag, report it as saleEndDate in YYYY-MM-DD form; if no end date is visible, omit saleEndDate. "
  + "Return the data as a JSON object. Skip any fields not clearly visible in either image.";

interface OpenRouterResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { total_tokens?: number };
  error?: { message: string };
}

export class ParseError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

/** No API key configured: same canned response the client used to return in Vite dev mode. */
function mockResponse(): { content: string; totalTokens: number } {
  return {
    content: '{"price": "$2.99", "itemName": "Milk", "quantity": 1, "quantityUnits": "gallon", "tags": "dairy, beverage"}',
    totalTokens: 0,
  };
}

async function callOpenRouter(apiKey: string, priceImageData: string, productImageData: string): Promise<{ content: string; totalTokens: number }> {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'google/gemma-4-26b-a4b-it',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: PROMPT_TEXT },
            { type: 'image_url', image_url: { url: priceImageData } },
            { type: 'image_url', image_url: { url: productImageData } },
          ],
        },
      ],
      max_tokens: 4000,
    }),
  });

  if (response.status === 429) throw new ParseError(429, 'Rate limit exceeded. Please try again later.');

  const rawBody = await response.text();
  let data: OpenRouterResponse;
  try {
    data = JSON.parse(rawBody);
  } catch {
    throw new ParseError(502, 'The price parsing service is temporarily unavailable. Please try again.');
  }
  if (data.error) throw new ParseError(502, data.error.message);

  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new ParseError(502, 'The AI service returned an empty response. Please try again.');
  return { content, totalTokens: data.usage?.total_tokens ?? 0 };
}

function parseTags(rawTags: unknown): string[] {
  if (!rawTags) return [];
  if (Array.isArray(rawTags)) return rawTags;
  if (typeof rawTags === 'string') return rawTags.split(',').map((t) => t.trim());
  return [];
}

function parsePrice(rawPrice: unknown): string {
  if (typeof rawPrice === 'string' && rawPrice.startsWith('$')) return rawPrice.slice(1);
  return String(rawPrice ?? '');
}

function extractFields(content: string): ParsedPriceFields {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new ParseError(422, "Couldn't read the price and product details from that photo. Please try again.");
  }
  const parsed = JSON.parse(content.substring(start, end + 1));
  const saleEndDate = typeof parsed.saleEndDate === 'string' && DATE_ONLY.test(parsed.saleEndDate) ? parsed.saleEndDate : null;
  return {
    price: parsePrice(parsed.price),
    itemName: parsed.itemName || '',
    brand: parsed.brand || '',
    tags: parseTags(parsed.tags),
    quantity: parsed.quantity || 1,
    quantityUnits: parsed.quantityUnits || 'unit',
    isSale: parsed.isSale === true || saleEndDate !== null,
    expiresAt: saleEndDate,
  };
}

/** Rough $/1K-token estimate, not real billing -- see PARSE_DAILY_BUDGET_CENTS in .env.example. */
export function estimateCostCents(totalTokens: number, centsPer1kTokens: number): number {
  return (totalTokens / 1000) * centsPer1kTokens;
}

function utcDay(now: () => Date): string {
  return now().toISOString().slice(0, 10);
}

/** Today's accumulated parse spend, in cents. */
export function dailySpendCents(db: AppDb, now: () => Date = () => new Date()): number {
  const row = db.select().from(parseSpendDaily).where(eq(parseSpendDaily.day, utcDay(now))).all()[0];
  return row?.costCents ?? 0;
}

/** Adds to today's running total, creating the day's row if needed. */
export function recordSpend(db: AppDb, costCents: number, now: () => Date = () => new Date()): void {
  const day = utcDay(now);
  db.insert(parseSpendDaily)
    .values({ day, costCents })
    .onConflictDoUpdate({ target: parseSpendDaily.day, set: { costCents: sql`${parseSpendDaily.costCents} + ${costCents}` } })
    .run();
}

/**
 * Runs the parse: mock data when no API key is configured (same fallback
 * the client used to use in Vite dev mode, now available in any
 * environment without a key), otherwise a real OpenRouter call. Records
 * the estimated spend either way (mock costs nothing, so it's a no-op).
 */
export async function parseImages(
  db: AppDb,
  apiKey: string,
  centsPer1kTokens: number,
  priceImageData: string,
  productImageData: string,
  now: () => Date = () => new Date(),
): Promise<ParsedPriceFields> {
  const { content, totalTokens } = apiKey
    ? await callOpenRouter(apiKey, priceImageData, productImageData)
    : mockResponse();
  const fields = extractFields(content);
  if (totalTokens > 0) recordSpend(db, estimateCostCents(totalTokens, centsPer1kTokens), now);
  return fields;
}
