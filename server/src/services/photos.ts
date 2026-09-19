import path from 'node:path';
import fs from 'node:fs/promises';
import { eq, lt } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { priceReports, reportPhotos } from '../db/schema.js';

/**
 * Photo evidence (Phase 3, plan section "Photo evidence"): the price-tag
 * photo the parse proxy already receives is kept, downscaled client-side,
 * keyed by the report id the client plans to save with. It is saved before
 * the report itself is ever pushed (the parse call happens first), so
 * there is no foreign key to price_reports -- see report_photos in the
 * schema. Visible only to the report's author and to admins.
 */

const RETENTION_DAYS = 90;

function photoPath(photoDir: string, reportId: string): string {
  // reportId is a client-generated UUID (shared/ids.ts); no path traversal risk, but guard anyway.
  const safe = reportId.replace(/[^a-zA-Z0-9-]/g, '');
  return path.join(photoDir, `${safe}.jpg`);
}

/** Decodes a `data:image/...;base64,...` URL (or bare base64) and writes it under PHOTO_DIR/<reportId>.jpg. */
export async function savePhoto(db: AppDb, photoDir: string, reportId: string, dataUrl: string, now: () => Date = () => new Date()): Promise<void> {
  const base64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
  await fs.mkdir(photoDir, { recursive: true });
  await fs.writeFile(photoPath(photoDir, reportId), Buffer.from(base64, 'base64'));
  db.insert(reportPhotos)
    .values({ reportId, createdAt: now().toISOString() })
    .onConflictDoUpdate({ target: reportPhotos.reportId, set: { createdAt: now().toISOString() } })
    .run();
}

export interface PhotoAccess {
  allowed: boolean;
  filePath: string | null;
}

/** A photo is visible to the report's own author, or to an admin (checked by the caller via ADMIN_TOKEN). */
export function checkPhotoAccess(db: AppDb, photoDir: string, reportId: string, requesterUserId: string | null, isAdmin: boolean): PhotoAccess {
  const has = db.select().from(reportPhotos).where(eq(reportPhotos.reportId, reportId)).all()[0];
  if (!has) return { allowed: false, filePath: null };
  if (isAdmin) return { allowed: true, filePath: photoPath(photoDir, reportId) };
  const report = db.select().from(priceReports).where(eq(priceReports.id, reportId)).all()[0];
  const allowed = !!report && !!requesterUserId && report.userId === requesterUserId;
  return { allowed, filePath: allowed ? photoPath(photoDir, reportId) : null };
}

/**
 * Deletes photos older than 90 days, unless their report is currently
 * hidden with an open flag (reviewReason 'flagged') -- those are kept
 * indefinitely until an admin resolves the flag. Run from the periodic
 * maintenance timer alongside trust recomputation.
 */
export async function cleanupPhotos(db: AppDb, photoDir: string, now: () => Date = () => new Date()): Promise<number> {
  const cutoff = new Date(now().getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const expired = db.select().from(reportPhotos).where(lt(reportPhotos.createdAt, cutoff)).all();
  let deleted = 0;
  for (const row of expired) {
    const report = db.select().from(priceReports).where(eq(priceReports.id, row.reportId)).all()[0];
    const openFlag = report?.status === 'hidden' && report.reviewReason === 'flagged';
    if (openFlag) continue;
    await fs.rm(photoPath(photoDir, row.reportId), { force: true });
    db.delete(reportPhotos).where(eq(reportPhotos.reportId, row.reportId)).run();
    deleted++;
  }
  return deleted;
}
