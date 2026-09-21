/**
 * Admin CLI (plan section 9.5). Talks to the database directly, so run it on
 * the box (or against a copy): `npm run admin -- <command>`.
 *
 *   flags [open|resolved]                 list flags
 *   resolve <flagId> upheld|dismissed     resolve every open flag on that report
 *   merge <sourceProductId> <targetId>    merge one product into another
 *   user <userId> active|restricted|banned
 *   recompute-trust                       recompute every user's trust score
 *   photo <reportId> <outFile>            save a report's price-tag photo evidence, if any
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { runMigrations } from './db/migrate.js';
import { env } from './env.js';
import { reportPhotos } from './db/schema.js';
import { listFlags, mergeProducts, resolveFlag, setUserStatus } from './services/admin.js';
import { recomputeAllTrust } from './services/trust.js';

const [command, ...args] = process.argv.slice(2);
const { db, sqlite } = runMigrations(env.DATABASE_PATH);

const out = (value: unknown) => console.log(JSON.stringify(value, null, 2));

try {
  switch (command) {
    case 'flags':
      out(listFlags(db, args[0] === 'resolved' ? 'resolved' : 'open'));
      break;
    case 'resolve': {
      const [flagId, resolution] = args;
      if (!flagId || (resolution !== 'upheld' && resolution !== 'dismissed')) throw new Error('usage: resolve <flagId> upheld|dismissed');
      out(resolveFlag(db, flagId, resolution));
      break;
    }
    case 'merge': {
      const [source, target] = args;
      if (!source || !target) throw new Error('usage: merge <sourceProductId> <targetProductId>');
      out(mergeProducts(db, source, target));
      break;
    }
    case 'user': {
      const [userId, status] = args;
      if (!userId || !['active', 'restricted', 'banned'].includes(status)) throw new Error('usage: user <userId> active|restricted|banned');
      out(setUserStatus(db, userId, status as 'active' | 'restricted' | 'banned'));
      break;
    }
    case 'recompute-trust':
      out({ users: recomputeAllTrust(db) });
      break;
    case 'photo': {
      const [reportId, outFile] = args;
      if (!reportId || !outFile) throw new Error('usage: photo <reportId> <outFile>');
      const has = db.select().from(reportPhotos).where(eq(reportPhotos.reportId, reportId)).all()[0];
      if (!has) throw new Error('No photo evidence stored for that report.');
      const safe = reportId.replace(/[^a-zA-Z0-9-]/g, '');
      await fs.copyFile(path.join(env.PHOTO_DIR, `${safe}.jpg`), outFile);
      out({ savedTo: outFile });
      break;
    }
    default:
      console.error('commands: flags [open|resolved] | resolve <flagId> upheld|dismissed | merge <src> <target> | user <id> <status> | recompute-trust | photo <reportId> <outFile>');
      process.exitCode = 1;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  sqlite.close();
}
