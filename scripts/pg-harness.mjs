// scripts/pg-harness.mjs — local "fake Supabase" for tests.
// Boots PGlite (real Postgres in WASM), applies supabase/migrations, and serves
// it over the Postgres wire protocol so node-postgres connects exactly as it
// would to Supabase. Usage: node scripts/pg-harness.mjs  (prints DATABASE_URL)
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.PG_HARNESS_PORT || 55432);
const dir = path.resolve('supabase/migrations');
const db = new PGlite();
await db.exec('create role anon; create role authenticated;');
for (const f of fs.readdirSync(dir).filter((f) => /^00[124]_.*\.sql$/.test(f)).sort()) {
  await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
}
const srv = new PGLiteSocketServer({ db, port: PORT, host: '127.0.0.1' });
await srv.start();
console.log(`DATABASE_URL=postgres://postgres@127.0.0.1:${PORT}/postgres`);
// NOTE: PGlite serves ONE connection at a time → run the app with DB_POOL_MAX=1.
process.on('SIGINT', async () => { await srv.stop(); process.exit(0); });
