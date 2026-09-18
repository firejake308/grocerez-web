import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq, gt } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { currentPrices, priceReports, stores, users } from '../db/schema.js';
import { haversineMiles } from '../lib/geohash.js';
import { requireAuth, requireUser, type AppEnv } from '../lib/authenticate.js';
import { resolveStore } from '../services/stores.js';
import { refreshProductStats, resolveProduct } from '../services/products.js';
import { trustTier } from '../services/trust.js';
import { parsePrice } from '../../../shared/price.js';
import type { PriceReportUpsert, PriceReportPushResult, SyncedPriceReport } from '../../../shared/types.js';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const reportSchema = z.object({
  id: z.string().min(1),
  itemName: z.string().trim().min(1).max(300),
  brand: z.string().trim().max(120).default(''),
  tags: z.array(z.string()).default([]),
  quantity: z.number().positive().nullable().default(null),
  quantityUnits: z.string().nullable().default(null),
  price: z.union([z.string(), z.number()]).transform(String),
  store: z.string().trim().min(1).max(300),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  observedDate: z.string().regex(DATE_ONLY),
  expiresAt: z.string().regex(DATE_ONLY).nullable().optional(),
  isSale: z.boolean().optional().default(false),
  updatedAt: z.string().min(1),
  deletedAt: z.string().nullable().optional(),
});

const pushSchema = z.object({ reports: z.array(reportSchema).max(500) });

/** Recomputes a product's cached stats from its current active reports. Call after any insert/update/delete that changes them. */
function refreshProductAfterWrite(db: AppDb, productId: string): void {
  const activePrices = db
    .select({ priceCents: priceReports.priceCents })
    .from(priceReports)
    .where(and(eq(priceReports.productId, productId), eq(priceReports.status, 'active')))
    .all()
    .map((r) => r.priceCents);
  refreshProductStats(db, productId, activePrices);
}

/** Current price for (product, store): newest observedDate wins; ties go to the latest push (plan section 10). */
function refreshCurrentPrice(db: AppDb, productId: string, storeId: string): void {
  const candidate = db
    .select()
    .from(priceReports)
    .where(and(eq(priceReports.productId, productId), eq(priceReports.storeId, storeId), eq(priceReports.status, 'active')))
    .all()
    .sort((a, b) => (a.observedDate === b.observedDate ? b.seq - a.seq : a.observedDate < b.observedDate ? 1 : -1))[0];

  if (!candidate) {
    db.delete(currentPrices).where(and(eq(currentPrices.productId, productId), eq(currentPrices.storeId, storeId))).run();
    return;
  }

  const existing = db
    .select()
    .from(currentPrices)
    .where(and(eq(currentPrices.productId, productId), eq(currentPrices.storeId, storeId)))
    .all()[0];

  const row = {
    productId,
    storeId,
    reportId: candidate.id,
    priceCents: candidate.priceCents,
    observedDate: candidate.observedDate,
    expiresAt: candidate.expiresAt,
    confidence: 1,
    isStale: false,
  };

  if (existing) {
    db.update(currentPrices).set(row).where(and(eq(currentPrices.productId, productId), eq(currentPrices.storeId, storeId))).run();
  } else {
    db.insert(currentPrices).values(row).run();
  }
}

function pushOneReport(db: AppDb, userId: string, input: PriceReportUpsert): PriceReportPushResult {
  const existing = db.select().from(priceReports).where(eq(priceReports.id, input.id)).all()[0];
  if (existing && existing.userId !== userId) {
    return { id: input.id, status: 'rejected', error: 'This report belongs to a different author.' };
  }
  // Last-writer-wins for the author's own report (multi-device case, plan section 7).
  if (existing && Date.parse(existing.updatedAt) >= Date.parse(input.updatedAt)) {
    return {
      id: input.id,
      status: existing.status,
      productId: existing.productId ?? undefined,
      storeId: existing.storeId ?? undefined,
      seq: existing.seq,
    };
  }

  if (input.deletedAt) {
    if (!existing) return { id: input.id, status: 'deleted' };
    db.update(priceReports)
      .set({ status: 'deleted', deletedAt: input.deletedAt, updatedAt: input.updatedAt })
      .where(eq(priceReports.id, input.id))
      .run();
    if (existing.productId) refreshProductAfterWrite(db, existing.productId);
    if (existing.productId && existing.storeId) refreshCurrentPrice(db, existing.productId, existing.storeId);
    return { id: input.id, status: 'deleted', productId: existing.productId ?? undefined, storeId: existing.storeId ?? undefined, seq: existing.seq };
  }

  const parsedPrice = parsePrice(input.price);
  if (!parsedPrice) {
    return { id: input.id, status: 'rejected', error: `Could not parse price "${input.price}".` };
  }

  const store = resolveStore(db, { rawStore: input.store, lat: input.latitude, lon: input.longitude });
  const matchable = {
    itemName: input.itemName,
    brand: input.brand,
    tags: input.tags,
    quantity: input.quantity,
    quantityUnits: input.quantityUnits,
  };
  const { productId } = resolveProduct(db, matchable, parsedPrice.cents);

  const reviewReason = parsedPrice.likelyMissingDecimalCents ? 'price_outlier' : null;

  if (existing) {
    db.update(priceReports)
      .set({
        productId,
        storeId: store.id,
        itemName: input.itemName,
        brand: input.brand,
        tags: JSON.stringify(input.tags),
        quantity: input.quantity,
        quantityUnits: input.quantityUnits,
        priceCents: parsedPrice.cents,
        priceRaw: String(input.price),
        observedDate: input.observedDate,
        expiresAt: input.expiresAt ?? null,
        isSale: input.isSale ?? false,
        status: 'active',
        reviewReason,
        updatedAt: input.updatedAt,
      })
      .where(eq(priceReports.id, input.id))
      .run();
    if (existing.productId && existing.productId !== productId) refreshProductAfterWrite(db, existing.productId);
    if (existing.productId && existing.storeId && (existing.productId !== productId || existing.storeId !== store.id)) {
      refreshCurrentPrice(db, existing.productId, existing.storeId);
    }
  } else {
    db.insert(priceReports)
      .values({
        id: input.id,
        userId,
        productId,
        storeId: store.id,
        itemName: input.itemName,
        brand: input.brand,
        tags: JSON.stringify(input.tags),
        quantity: input.quantity,
        quantityUnits: input.quantityUnits,
        priceCents: parsedPrice.cents,
        priceRaw: String(input.price),
        observedDate: input.observedDate,
        expiresAt: input.expiresAt ?? null,
        isSale: input.isSale ?? false,
        source: 'scan',
        status: 'active',
        reviewReason,
        updatedAt: input.updatedAt,
      })
      .run();
    db.update(users).set({ reportsCount: db.select({ c: users.reportsCount }).from(users).where(eq(users.id, userId)).all()[0]!.c + 1 }).where(eq(users.id, userId)).run();
  }

  refreshProductAfterWrite(db, productId);
  refreshCurrentPrice(db, productId, store.id);

  const saved = db.select().from(priceReports).where(eq(priceReports.id, input.id)).all()[0]!;
  return {
    id: input.id,
    status: 'active',
    productId,
    storeId: store.id,
    seq: saved.seq,
    normalized: { itemName: input.itemName, brand: input.brand, priceCents: parsedPrice.cents },
  };
}

export function syncRoutes(db: AppDb) {
  const router = new Hono<AppEnv>();

  router.post('/push', requireUser(db), async (c) => {
    const auth = c.get('auth');
    if (auth.kind !== 'session') return c.json({ error: 'Sign-in required' }, 401);
    const body = await c.req.json().catch(() => null);
    const parsed = pushSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request.' }, 400);

    const results = parsed.data.reports.map((r) => pushOneReport(db, auth.userId, r));
    return c.json({ results });
  });

  router.get('/pull', requireAuth(db), (c) => {
    const since = Number(c.req.query('since') ?? '0');
    const lat = Number(c.req.query('lat'));
    const lon = Number(c.req.query('lon'));
    const radiusMi = Math.min(Number(c.req.query('radiusMi') ?? '50') || 50, 100);
    const limit = Math.min(Number(c.req.query('limit') ?? '500') || 500, 500);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return c.json({ error: 'lat and lon are required.' }, 400);
    }

    // Bounding-box prequery (indexed) followed by an exact haversine check
    // (plan section 7) -- fine at this scale, no spatial extension needed.
    const latDelta = radiusMi / 69; // ~69 miles per degree of latitude
    const lonDelta = radiusMi / (69 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));

    const rows = db
      .select({
        report: priceReports,
        store: stores,
        author: users,
      })
      .from(priceReports)
      .innerJoin(stores, eq(priceReports.storeId, stores.id))
      .innerJoin(users, eq(priceReports.userId, users.id))
      .where(gt(priceReports.seq, Number.isFinite(since) ? since : 0))
      .orderBy(asc(priceReports.seq))
      .all();

    // Chain-level stores (no location, see plan section 8.5/11a) are
    // excluded from geo-scoped pulls for now; the "approximate location
    // from the reporter's other reports" fallback in plan section 7 isn't
    // implemented yet, so there's nothing to filter them by.
    const inRange = rows.filter(({ store }) => {
      if (store.lat == null || store.lon == null) return false;
      if (Math.abs(store.lat - lat) > latDelta || Math.abs(store.lon - lon) > lonDelta) return false;
      return haversineMiles(lat, lon, store.lat, store.lon) <= radiusMi;
    });

    const page = inRange.slice(0, limit);
    const nextSince = page.length > 0 ? page[page.length - 1].report.seq : since;

    const reports: SyncedPriceReport[] = page.map(({ report, store, author }) => ({
      id: report.id,
      seq: report.seq,
      userId: report.userId,
      authorTier: trustTier(author.reportsCount, author.confirmedCount, author.upheldFlagsCount),
      productId: report.productId ?? '',
      storeId: report.storeId ?? '',
      storeName: store.name,
      itemName: report.itemName,
      brand: report.brand,
      tags: JSON.parse(report.tags) as string[],
      quantity: report.quantity,
      quantityUnits: report.quantityUnits,
      priceCents: report.priceCents,
      observedDate: report.observedDate,
      expiresAt: report.expiresAt,
      isSale: report.isSale,
      status: report.status,
      confirmCount: report.confirmCount,
      updatedAt: report.updatedAt,
    }));

    // Entitlement enforcement (locked summaries, accessLevel other than
    // 'unrestricted') lands in Phase 3 -- see plan section 6.3.3.
    return c.json({ accessLevel: 'unrestricted', reports, locked: [], nextSince });
  });

  return router;
}
