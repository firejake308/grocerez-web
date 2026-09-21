import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { runMigrations } from '../../db/migrate.js';
import type { AppDb } from '../../db/client.js';
import { priceReports, products, stores, users } from '../../db/schema.js';
import { newId } from '../../lib/ids.js';
import { checkPhotoAccess, cleanupPhotos, savePhoto } from '../photos.js';

const PIXEL_BASE64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';

function seedUser(db: AppDb, overrides: Partial<typeof users.$inferInsert> = {}): string {
  const id = newId();
  db.insert(users).values({ id, email: `${id}@example.com`, ...overrides }).run();
  return id;
}

function seedReport(db: AppDb, id: string, userId: string, overrides: Partial<typeof priceReports.$inferInsert> = {}) {
  const productId = newId();
  const storeId = newId();
  db.insert(products).values({ id: productId, canonicalName: 'Milk' }).run();
  db.insert(stores).values({ id: storeId, name: 'Kroger', chainKey: 'kroger', storeKey: newId() }).run();
  db.insert(priceReports).values({
    id,
    userId,
    productId,
    storeId,
    itemName: 'Milk',
    priceCents: 300,
    priceRaw: '3.00',
    observedDate: '2026-06-01',
    freshnessDate: '2026-06-01',
    status: 'active',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  }).run();
}

describe('photos', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;
  let photoDir: string;

  beforeEach(async () => {
    ({ db, sqlite } = runMigrations(':memory:'));
    photoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grocerez-photos-'));
  });

  afterEach(async () => {
    sqlite.close();
    await fs.rm(photoDir, { recursive: true, force: true });
  });

  it('saves a data URL to disk and tracks it', async () => {
    const reportId = newId();
    await savePhoto(db, photoDir, reportId, `data:image/jpeg;base64,${PIXEL_BASE64}`);
    const bytes = await fs.readFile(path.join(photoDir, `${reportId}.jpg`));
    expect(bytes.length).toBeGreaterThan(0);
  });

  it('an author can access their own report photo', async () => {
    const author = seedUser(db);
    const reportId = newId();
    seedReport(db, reportId, author);
    await savePhoto(db, photoDir, reportId, `data:image/jpeg;base64,${PIXEL_BASE64}`);

    const access = checkPhotoAccess(db, photoDir, reportId, author, false);
    expect(access.allowed).toBe(true);
    expect(access.filePath).toBe(path.join(photoDir, `${reportId}.jpg`));
  });

  it('a stranger cannot access someone else\'s report photo', async () => {
    const author = seedUser(db);
    const stranger = seedUser(db);
    const reportId = newId();
    seedReport(db, reportId, author);
    await savePhoto(db, photoDir, reportId, `data:image/jpeg;base64,${PIXEL_BASE64}`);

    expect(checkPhotoAccess(db, photoDir, reportId, stranger, false).allowed).toBe(false);
  });

  it('an admin can access any report photo', async () => {
    const author = seedUser(db);
    const reportId = newId();
    seedReport(db, reportId, author);
    await savePhoto(db, photoDir, reportId, `data:image/jpeg;base64,${PIXEL_BASE64}`);

    expect(checkPhotoAccess(db, photoDir, reportId, null, true).allowed).toBe(true);
  });

  it('denies access to a photo that was never saved', () => {
    const reportId = newId();
    expect(checkPhotoAccess(db, photoDir, reportId, null, true).allowed).toBe(false);
  });

  it('a photo saved before its report is ever pushed is still not accessible to a random caller', async () => {
    // The parse call happens before push, so a photo can exist with no matching price_reports row yet.
    const reportId = newId();
    await savePhoto(db, photoDir, reportId, `data:image/jpeg;base64,${PIXEL_BASE64}`);
    expect(checkPhotoAccess(db, photoDir, reportId, newId(), false).allowed).toBe(false);
    expect(checkPhotoAccess(db, photoDir, reportId, null, true).allowed).toBe(true);
  });

  it('cleanupPhotos deletes photos older than 30 days', async () => {
    const author = seedUser(db);
    const reportId = newId();
    seedReport(db, reportId, author);
    const savedAt = () => new Date('2026-01-01T00:00:00.000Z');
    await savePhoto(db, photoDir, reportId, `data:image/jpeg;base64,${PIXEL_BASE64}`, savedAt);

    const stillWithinWindow = () => new Date('2026-01-20T00:00:00.000Z'); // 19 days later
    expect(await cleanupPhotos(db, photoDir, stillWithinWindow)).toBe(0);

    const pastWindow = () => new Date('2026-02-15T00:00:00.000Z'); // 45 days later
    expect(await cleanupPhotos(db, photoDir, pastWindow)).toBe(1);
    await expect(fs.readFile(path.join(photoDir, `${reportId}.jpg`))).rejects.toThrow();
  });

  it('keeps a photo past 30 days when its report is hidden with an open flag', async () => {
    const author = seedUser(db);
    const reportId = newId();
    seedReport(db, reportId, author, { status: 'hidden', reviewReason: 'flagged' });
    const savedAt = () => new Date('2026-01-01T00:00:00.000Z');
    await savePhoto(db, photoDir, reportId, `data:image/jpeg;base64,${PIXEL_BASE64}`, savedAt);

    const pastWindow = () => new Date('2026-04-15T00:00:00.000Z');
    expect(await cleanupPhotos(db, photoDir, pastWindow)).toBe(0);
    const bytes = await fs.readFile(path.join(photoDir, `${reportId}.jpg`));
    expect(bytes.length).toBeGreaterThan(0);
  });
});
