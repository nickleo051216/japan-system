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
// Supabase Vault 的替身：正式庫內建 supabase_vault（金鑰加密存放），PGlite 沒有。
// 這裡只做出同名的函式與 view 讓程式碼跑得起來 —— 測試資料庫不加密，正式庫才加密。
await db.exec(`
  create schema vault;
  create table vault.secrets (
    id uuid primary key default gen_random_uuid(), name text unique,
    description text not null default '', secret text not null,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now());
  create view vault.decrypted_secrets as
    select id, name, description, secret, secret as decrypted_secret, created_at, updated_at from vault.secrets;
  create function vault.create_secret(new_secret text, new_name text default null,
      new_description text default '', new_key_id uuid default null) returns uuid
    language sql as $$ insert into vault.secrets (secret, name, description)
      values (new_secret, new_name, coalesce(new_description, '')) returning id $$;
  create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null,
      new_description text default null, new_key_id uuid default null) returns void
    language sql as $$ update vault.secrets set secret = coalesce(new_secret, secret),
      name = coalesce(new_name, name), description = coalesce(new_description, description),
      updated_at = now() where id = secret_id $$;
`);
// Everything except 000 (rollback) and 003 (self-test — designed to be run by
// hand in the Supabase SQL Editor, and it drops its own fixtures afterwards).
const SKIP = /^(000|003)_/;
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql') && !SKIP.test(f)).sort()) {
  await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
}
const srv = new PGLiteSocketServer({ db, port: PORT, host: '127.0.0.1' });
await srv.start();
console.log(`DATABASE_URL=postgres://postgres@127.0.0.1:${PORT}/postgres`);
// NOTE: PGlite serves ONE connection at a time → run the app with DB_POOL_MAX=1.
process.on('SIGINT', async () => { await srv.stop(); process.exit(0); });
