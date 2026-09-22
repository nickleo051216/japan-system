'use strict';
/**
 * Data layer — Postgres (Supabase) edition.
 *
 * Same surface as the original SQLite helper (open/get/all/one/run/tx/
 * setting/putSetting) so route code only needs `await` added, but every call
 * is now async.
 *
 * - Connection: DATABASE_URL, Supabase *transaction pooler* (port 6543) —
 *   required on Vercel serverless, where each instance must hold few sockets.
 * - Placeholders: routes keep writing `?`; they are rewritten to $1..$n here.
 * - Transactions: tx(fn) pins one client; any all/one/run called inside fn
 *   (however deep) is routed to that client via AsyncLocalStorage, so helper
 *   functions don't need a client argument.
 * - Types: numeric/bigint come back as JS numbers and timestamptz as ISO
 *   strings, matching what the SQLite version returned.
 * - Schema is owned by migrations (supabase/*.sql), never created at runtime.
 */
const { Pool, types } = require('pg');
const { AsyncLocalStorage } = require('node:async_hooks');

// ---- type parsers: keep the shapes the rest of the app already expects ----
types.setTypeParser(20,   (v) => (v === null ? null : Number(v)));       // int8 (count(*))
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));       // numeric
types.setTypeParser(1184, (v) => (v === null ? null : new Date(v).toISOString())); // timestamptz
types.setTypeParser(1114, (v) => (v === null ? null : new Date(v + 'Z').toISOString())); // timestamp

let pool = null;
const txStore = new AsyncLocalStorage();

function open() {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL 未設定');
  const local = /localhost|127\.0\.0\.1/.test(url);
  pool = new Pool({
    connectionString: url,
    max: Number(process.env.DB_POOL_MAX || 3),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
    ssl: local ? false : { rejectUnauthorized: false },
  });
  pool.on('error', (e) => console.error('[db] idle client error', e.message));
  return pool;
}

const get = () => pool || open();

/** Rewrite `?` placeholders to $1..$n, skipping ones inside quoted literals. */
function toPg(sql) {
  let n = 0, out = '', quote = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (quote) { out += c; if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"') { quote = c; out += c; continue; }
    out += c === '?' ? '$' + (++n) : c;
  }
  return out;
}

/** Booleans pass through; everything else as-is (pg handles numbers/strings/null). */
const norm = (params) => params.map((p) => (p === undefined ? null : p));

/**
 * SQL errors raised by Postgres (constraint, ILLEGAL_TRANSITION, CONFLICT…)
 * carry a 5-char SQLSTATE and leave the connection healthy — keep it.
 * Only transport failures (no SQLSTATE) should throw the client away.
 * pool.query() would destroy the client on *any* error, forcing a fresh TLS
 * handshake per business error — costly exactly when a 喊單 rush produces
 * many "sold out" / conflict errors at once.
 */
const isSqlError = (e) => !!(e && typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code));

async function q(sql, params) {
  const pinned = txStore.getStore();
  if (pinned) return pinned.query(toPg(sql), norm(params));
  const client = await get().connect();
  let failure;
  try {
    return await client.query(toPg(sql), norm(params));
  } catch (e) {
    failure = e;
    throw e;
  } finally {
    client.release(failure && !isSqlError(failure) ? failure : undefined);
  }
}

const all = async (sql, ...params) => (await q(sql, params)).rows;
const one = async (sql, ...params) => (await q(sql, params)).rows[0] || null;
/** `changes` mirrors the old SQLite driver so existing `res.changes === 0` checks still work. */
const run = async (sql, ...params) => {
  const r = await q(sql, params);
  return { changes: r.rowCount, rows: r.rows };
};

/**
 * Run fn inside a transaction. Nested tx() calls reuse the outer one.
 * Throwing (or a rejected promise) rolls everything back.
 */
async function tx(fn) {
  if (txStore.getStore()) return fn();
  const client = await get().connect();
  try {
    await client.query('BEGIN');
    const out = await txStore.run(client, fn);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* connection already broken */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Per-transaction session setting, e.g. actor/reason read by DB triggers. */
async function setLocal(key, value) {
  if (!txStore.getStore()) throw new Error('setLocal 必須在 tx() 內呼叫');
  await q('SELECT set_config(?, ?, true)', [key, value == null ? '' : String(value)]);
}

const setting = async (key, fallback = null) => {
  const row = await one('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : fallback;
};
const putSetting = (key, value) =>
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      key, String(value));

async function close() { if (pool) { await pool.end(); pool = null; } }

module.exports = { open, get, all, one, run, tx, setLocal, setting, putSetting, close, toPg, isSqlError };
