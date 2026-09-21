import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

/**
 * Opens (creating parent directories as needed) the SQLite database at
 * `databasePath` and returns a Drizzle client over it. Each caller that
 * wants a fresh, isolated database (tests) should pass a distinct path,
 * e.g. an in-memory ':memory:' path or a temp file.
 */
export function openDb(databasePath: string) {
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }
  const sqlite = new Database(databasePath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

export type AppDb = ReturnType<typeof openDb>['db'];
