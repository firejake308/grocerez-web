import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { currentPrices, priceReports, products, reportVotes, stores, users } from '../db/schema.js';
import { requireAuth, type AppEnv } from '../lib/authenticate.js';
import { followMerge, matchCandidates } from '../services/products.js';
import { isStaleReport, todayOf } from '../services/freshness.js';
import { tierForUser } from '../services/trust.js';
import { parsePrice } from '../../../shared/price.js';
import type { ProductCurrentPrice, ProductMatchCandidate, ProductPricesResponse, SyncedPriceReport } from '../../../shared/types.js';

const matchQuery = z.object({
  itemName: z.string().trim().min(1).max(300),
  brand: z.string().trim().max(120).default(''),
  tags: z.string().default(''),
  quantity: z.coerce.number().positive().optional(),
  quantityUnits: z.string().optional(),
  price: z.string().optional(),
});

const HISTORY_LIMIT = 200;

export function productRoutes(db: AppDb, now: () => Date = () => new Date()) {
  const router = new Hono<AppEnv>();
  router.use('*', requireAuth(db));

  /** Section 8.4: "Is this the same as X (seen at N stores)?" -- the matcher's view, without writing anything. */
  router.get('/match', (c) => {
    const q = matchQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
    if (!q.success) return c.json({ error: 'itemName is required.' }, 400);
    const priceCents = q.data.price ? parsePrice(q.data.price)?.cents ?? null : null;
    const candidates = matchCandidates(
      db,
      {
        itemName: q.data.itemName,
        brand: q.data.brand,
        tags: q.data.tags.split(',').map((t) => t.trim()).filter(Boolean),
        quantity: q.data.quantity ?? null,
        quantityUnits: q.data.quantityUnits ?? null,
      },
      priceCents,
    );
    const storeCounts = new Map<string, number>();
    if (candidates.length > 0) {
      for (const row of db
        .select({ productId: currentPrices.productId })
        .from(currentPrices)
        .where(inArray(currentPrices.productId, candidates.map((x) => x.productId)))
        .all()) {
        storeCounts.set(row.productId, (storeCounts.get(row.productId) ?? 0) + 1);
      }
    }
    const results: ProductMatchCandidate[] = candidates.map((x) => ({
      productId: x.productId,
      canonicalName: x.canonicalName,
      brandKey: x.brandKey,
      sizeLabel: x.sizeLabel,
      reportCount: x.reportCount,
      storeCount: storeCounts.get(x.productId) ?? 0,
      medianPriceCents: x.medianPriceCents,
      score: Number(x.score.toFixed(3)),
      decision: x.decision as 'attach' | 'review',
    }));
    return c.json({ candidates: results });
  });

  /** Current price per store plus history (plan section 10). */
  router.get('/:id/prices', (c) => {
    const auth = c.get('auth');
    const productId = followMerge(db, c.req.param('id'));
    if (!productId) return c.json({ error: 'Product not found.' }, 404);
    const product = db.select().from(products).where(eq(products.id, productId)).all()[0]!;

    const today = todayOf(now());
    const currentRows = db
      .select({ cp: currentPrices, store: stores })
      .from(currentPrices)
      .innerJoin(stores, eq(currentPrices.storeId, stores.id))
      .where(eq(currentPrices.productId, productId))
      .all();

    const reportIds = currentRows.flatMap((r) => [r.cp.reportId, r.cp.contestedReportId].filter((x): x is string => !!x));
    const reportMap = new Map(
      (reportIds.length ? db.select().from(priceReports).where(inArray(priceReports.id, reportIds)).all() : []).map((r) => [r.id, r]),
    );
    const authorIds = Array.from(new Set(Array.from(reportMap.values()).map((r) => r.userId)));
    const authorMap = new Map((authorIds.length ? db.select().from(users).where(inArray(users.id, authorIds)).all() : []).map((u) => [u.id, u]));

    const current: ProductCurrentPrice[] = currentRows
      .map(({ cp, store }) => {
        const report = reportMap.get(cp.reportId);
        const author = report ? authorMap.get(report.userId) : undefined;
        const contested = cp.contestedReportId ? reportMap.get(cp.contestedReportId) : undefined;
        return {
          storeId: store.id,
          storeName: store.name,
          storeAddress: store.address,
          reportId: cp.reportId,
          priceCents: cp.priceCents,
          observedDate: cp.observedDate,
          expiresAt: cp.expiresAt,
          isStale: cp.isStale,
          confidence: cp.confidence,
          authorTier: author ? tierForUser(author) : 'new',
          contested: contested ? { reportId: contested.id, priceCents: contested.priceCents, observedDate: contested.observedDate } : null,
        } satisfies ProductCurrentPrice;
      })
      // Fresh before stale, then cheapest first (section 10: stale is ranked below fresh).
      .sort((a, b) => Number(a.isStale) - Number(b.isStale) || a.priceCents - b.priceCents);

    const historyRows = db
      .select({ report: priceReports, store: stores, author: users })
      .from(priceReports)
      .innerJoin(stores, eq(priceReports.storeId, stores.id))
      .innerJoin(users, eq(priceReports.userId, users.id))
      .where(and(eq(priceReports.productId, productId), inArray(priceReports.status, ['active', 'hidden'])))
      .orderBy(desc(priceReports.observedDate), desc(priceReports.seq))
      .limit(HISTORY_LIMIT)
      .all();

    const myVotes = new Map<string, 'confirm' | 'flag'>();
    if (auth.kind === 'session' && historyRows.length > 0) {
      for (const v of db
        .select({ reportId: reportVotes.reportId, kind: reportVotes.kind })
        .from(reportVotes)
        .where(and(eq(reportVotes.userId, auth.userId), inArray(reportVotes.reportId, historyRows.map((h) => h.report.id))))
        .all()) {
        myVotes.set(v.reportId, v.kind);
      }
    }

    const history: SyncedPriceReport[] = historyRows.map(({ report, store, author }) => ({
      id: report.id,
      seq: report.seq,
      userId: report.userId,
      authorTier: tierForUser(author),
      productId,
      storeId: store.id,
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
      reviewReason: report.reviewReason,
      confirmCount: report.confirmCount,
      isStale: isStaleReport(report, today),
      myVote: myVotes.get(report.id) ?? null,
      updatedAt: report.updatedAt,
    }));

    const body: ProductPricesResponse = {
      product: {
        id: product.id,
        canonicalName: product.canonicalName,
        brandKey: product.brandKey,
        sizeLabel: product.sizeLabel,
        reportCount: product.reportCount,
        medianPriceCents: product.medianPriceCents,
      },
      current,
      history,
    };
    return c.json(body);
  });

  return router;
}
