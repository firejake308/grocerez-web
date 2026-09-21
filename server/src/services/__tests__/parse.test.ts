import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { runMigrations } from '../../db/migrate.js';
import type { AppDb } from '../../db/client.js';
import { dailySpendCents, estimateCostCents, parseImages, ParseError, recordSpend } from '../parse.js';

describe('parseImages', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
  });

  afterEach(() => {
    sqlite.close();
    vi.unstubAllGlobals();
  });

  it('returns mock data and records no spend when no API key is configured', async () => {
    const fields = await parseImages(db, '', 0.2, 'data:image/jpeg;base64,aaa', 'data:image/jpeg;base64,bbb');
    expect(fields.itemName).toBe('Milk');
    expect(fields.quantityUnits).toBe('gallon');
    expect(dailySpendCents(db)).toBe(0);
  });

  it('calls OpenRouter and extracts the JSON object from its response when a key is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: 'Sure, here you go: {"price": "$4.29", "itemName": "Eggs", "brand": "Happy Hen", "quantity": 12, "quantityUnits": "egg", "tags": ["eggs"]}' } }],
        usage: { total_tokens: 1000 },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const fields = await parseImages(db, 'sk-test', 0.2, 'data:image/jpeg;base64,aaa', 'data:image/jpeg;base64,bbb');
    expect(fields).toEqual({
      price: '4.29',
      itemName: 'Eggs',
      brand: 'Happy Hen',
      tags: ['eggs'],
      quantity: 12,
      quantityUnits: 'egg',
      isSale: false,
      expiresAt: null,
    });
    expect(fetchMock).toHaveBeenCalledWith('https://openrouter.ai/api/v1/chat/completions', expect.objectContaining({ method: 'POST' }));
    // 1000 tokens at 0.2 cents/1K = 0.2 cents.
    expect(dailySpendCents(db)).toBeCloseTo(0.2);
  });

  it('throws a 429 ParseError when OpenRouter itself rate-limits', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 429, text: async () => '' }));
    await expect(parseImages(db, 'sk-test', 0.2, 'a', 'b')).rejects.toMatchObject({ status: 429 });
  });

  it('throws a 422 ParseError when the response has no JSON object', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: 'no data here' } }] }),
    }));
    await expect(parseImages(db, 'sk-test', 0.2, 'a', 'b')).rejects.toBeInstanceOf(ParseError);
  });
});

describe('spend tracking', () => {
  let db: AppDb;
  let sqlite: SqliteDatabase;

  beforeEach(() => {
    ({ db, sqlite } = runMigrations(':memory:'));
  });

  afterEach(() => {
    sqlite.close();
  });

  it('accumulates spend within the same UTC day and resets on a new day', () => {
    const day1 = () => new Date('2026-06-01T10:00:00.000Z');
    recordSpend(db, 1.5, day1);
    recordSpend(db, 2.5, day1);
    expect(dailySpendCents(db, day1)).toBeCloseTo(4);

    const day2 = () => new Date('2026-06-02T00:00:01.000Z');
    expect(dailySpendCents(db, day2)).toBe(0);
  });

  it('estimateCostCents scales linearly with tokens', () => {
    expect(estimateCostCents(1000, 0.2)).toBeCloseTo(0.2);
    expect(estimateCostCents(5000, 0.2)).toBeCloseTo(1.0);
    expect(estimateCostCents(0, 0.2)).toBe(0);
  });
});
