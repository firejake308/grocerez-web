import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { runMigrations } from '../../db/migrate.js';
import type { AppDb } from '../../db/client.js';
import { products } from '../../db/schema.js';
import { resolveProduct, refreshProductStats } from '../products.js';
import type { MatchableItem } from '../../../../shared/matching.js';

const item = (overrides: Partial<MatchableItem>): MatchableItem => ({
  itemName: '',
  brand: '',
  tags: [],
  quantity: null,
  quantityUnits: null,
  ...overrides,
});

describe('resolveProduct', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
  });

  afterEach(() => {
    sqlite.close();
  });

  it('creates a new product for the first report of an item', () => {
    const { productId, decision } = resolveProduct(
      db,
      item({ itemName: 'Cold Brew Coffee', brand: 'Stok', tags: ['coffee', 'cold brew'], quantity: 48, quantityUnits: 'fluid ounce' }),
      679,
    );
    expect(decision).toBe('new');
    const product = db.select().from(products).where(eq(products.id, productId)).all()[0];
    expect(product?.canonicalName).toBe('Cold Brew Coffee');
    expect(product?.brandKey).toBe('stok');
    expect(product?.sizeFamily).toBe('volume');
  });

  it('attaches a second, differently-worded report of the same product', () => {
    const first = resolveProduct(
      db,
      item({ itemName: 'Cold Brew Coffee', brand: 'Stok', tags: ['coffee', 'cold brew'], quantity: 48, quantityUnits: 'fluid ounce' }),
      679,
    );
    const second = resolveProduct(
      db,
      item({ itemName: 'Unsweetened Cold Brew Coffee', brand: 'Stok', tags: ['coffee', 'cold brew', 'drink'], quantity: 48, quantityUnits: 'fluid ounce' }),
      597,
    );
    expect(second.decision).toBe('attach');
    expect(second.productId).toBe(first.productId);
  });

  it('keeps different-brand eggs of the same size as separate products', () => {
    const a = resolveProduct(
      db,
      item({ itemName: 'Large White Eggs', brand: 'Great Value', tags: ['eggs'], quantity: 12, quantityUnits: 'count' }),
      147,
    );
    const b = resolveProduct(
      db,
      item({ itemName: 'Large Eggs', brand: "Eggland's Best", tags: ['eggs'], quantity: 12, quantityUnits: 'count' }),
      387,
    );
    expect(a.productId).not.toBe(b.productId);
  });

  it('never merges 12-count and 24-count eggs even from the same brand', () => {
    const a = resolveProduct(db, item({ itemName: 'Large White Eggs', brand: 'Great Value', tags: ['eggs'], quantity: 12, quantityUnits: 'count' }), 147);
    const b = resolveProduct(db, item({ itemName: 'Large White Eggs', brand: 'Great Value', tags: ['eggs'], quantity: 24, quantityUnits: 'count' }), 300);
    expect(a.productId).not.toBe(b.productId);
  });

  it('keeps six different-brand blueberry packers at 18 oz as separate products', () => {
    // Produce gets no special treatment: a brand mismatch rejects a match
    // here exactly like it does for eggs. An earlier version scored
    // produce brand as a soft signal so these would cluster into one
    // product, but that broke current_prices (keyed by product + store
    // only): two brands at the same store would fight over one "current
    // price" slot, silently hiding whichever brand wasn't scanned most
    // recently.
    const brands = ["Driscoll's", 'Berry Fresh', 'Twin River', 'Field & Vine', 'Simple Truth Organic', 'California Giant Berry Farms'];
    const ids = brands.map((brand) =>
      resolveProduct(db, item({ itemName: 'Blueberries', brand, tags: ['berries', 'fruit', 'produce'], quantity: 18, quantityUnits: 'ounce' }), 599).productId,
    );
    expect(new Set(ids).size).toBe(brands.length);
  });

  it('still merges same-brand blueberries reported with slightly different wording', () => {
    const a = resolveProduct(db, item({ itemName: 'Blueberries', brand: 'Berry Fresh', tags: ['berries', 'fruit', 'produce'], quantity: 18, quantityUnits: 'ounce' }), 599);
    const b = resolveProduct(db, item({ itemName: 'Fresh Blueberries', brand: 'Berry Fresh', tags: ['berries', 'fruit', 'fresh produce'], quantity: 18, quantityUnits: 'ounce' }), 599);
    expect(b.productId).toBe(a.productId);
  });

  it('narrows the canonical name toward shared words when flavor variants attach', () => {
    const first = resolveProduct(
      db,
      item({ itemName: 'Buldak Spicy Ramen (Rose)', brand: 'Samyang', tags: [], quantity: 24.65, quantityUnits: 'ounce' }),
      799,
    );
    resolveProduct(
      db,
      item({ itemName: 'Buldak Spicy Ramen, Artificial Spicy Chicken Flavor', brand: 'Samyang', tags: ['ramen'], quantity: 24.65, quantityUnits: 'ounce' }),
      799,
    );
    const product = db.select().from(products).where(eq(products.id, first.productId)).all()[0];
    expect(product?.canonicalName).toBe('Buldak Spicy Ramen');
  });

  it('flags a grey-zone pair for review with a possible_duplicate_of pointer, rather than silently merging or ignoring it', () => {
    const first = resolveProduct(
      db,
      item({ itemName: 'Ferrero Collection Fine Assorted Confections', brand: 'Ferrero', tags: ['chocolate', 'gift'], quantity: 4.6, quantityUnits: 'ounce' }),
      899,
    );
    const second = resolveProduct(
      db,
      item({ itemName: 'Ferrero Collection With Raffaello', brand: 'Ferrero', tags: ['chocolate', 'gift'], quantity: 4.6, quantityUnits: 'ounce' }),
      742,
    );
    expect(second.decision).toBe('review');
    expect(second.productId).not.toBe(first.productId);
    const secondProduct = db.select().from(products).where(eq(products.id, second.productId)).all()[0];
    expect(secondProduct?.possibleDuplicateOf).toBe(first.productId);
  });

  it('does not let a real sale price veto an otherwise-clear match', () => {
    // Seed enough history (>= 3 reports, per plan section 8.3) with a
    // median around $2.50 so a $1.00 sale actually crosses the outlier
    // ratio (< 0.35x median) and the 0.15 penalty genuinely applies --
    // not just a price penalty of zero that happens not to matter. Same
    // brand and size put this on the flavor rule's lowered threshold, so
    // the penalty alone isn't enough to knock it out of 'attach'.
    const productId = resolveProduct(db, item({ itemName: 'Cosmic Crisp Apples', brand: 'Kroger', tags: ['fruit', 'produce'], quantity: 1, quantityUnits: 'pound' }), 249).productId;
    const prices = [249];
    for (const cents of [259, 269, 239]) {
      resolveProduct(db, item({ itemName: 'Cosmic Crisp Apples', brand: 'Kroger', tags: ['fruit', 'produce'], quantity: 1, quantityUnits: 'pound' }), cents);
      prices.push(cents);
      refreshProductStats(db, productId, prices); // simulates what the push route does after each insert
    }
    const product = db.select().from(products).where(eq(products.id, productId)).all()[0]!;
    expect(product.reportCount).toBeGreaterThanOrEqual(3);
    expect(79 / product.medianPriceCents!).toBeLessThan(0.35); // confirms the penalty branch is actually exercised below

    const saleReport = resolveProduct(db, item({ itemName: 'Cosmic Crisp Apples', brand: 'Kroger', tags: ['fruit', 'produce'], quantity: 1, quantityUnits: 'pound' }), 79);
    expect(saleReport.decision).toBe('attach');
    expect(saleReport.productId).toBe(productId);
  });
});

describe('refreshProductStats', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
  });

  afterEach(() => {
    sqlite.close();
  });

  it('computes report count and median price', () => {
    const { productId } = resolveProduct(db, item({ itemName: 'Milk', quantity: 1, quantityUnits: 'gallon' }), 300);
    refreshProductStats(db, productId, [250, 300, 400]);
    const product = db.select().from(products).where(eq(products.id, productId)).all()[0];
    expect(product?.reportCount).toBe(3);
    expect(product?.medianPriceCents).toBe(300);
  });

  it('averages the two middle values for an even count', () => {
    const { productId } = resolveProduct(db, item({ itemName: 'Milk', quantity: 1, quantityUnits: 'gallon' }), 300);
    refreshProductStats(db, productId, [200, 300, 400, 500]);
    const product = db.select().from(products).where(eq(products.id, productId)).all()[0];
    expect(product?.medianPriceCents).toBe(350);
  });

  it('reports null median for zero active reports', () => {
    const { productId } = resolveProduct(db, item({ itemName: 'Milk', quantity: 1, quantityUnits: 'gallon' }), 300);
    refreshProductStats(db, productId, []);
    const product = db.select().from(products).where(eq(products.id, productId)).all()[0];
    expect(product?.reportCount).toBe(0);
    expect(product?.medianPriceCents).toBeNull();
  });
});
