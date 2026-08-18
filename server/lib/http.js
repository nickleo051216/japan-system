'use strict';
/**
 * Tiny router + the I-02 API Gateway conventions:
 *   路徑    /api/v1/{resource}/{action}
 *   回應    { ok, data, error }
 *   寫入    需 Idempotency-Key header
 * Errors shown to users never carry technical detail (I-03 rule 3); the real
 * error goes to the server log instead.
 */
const db = require('./db');
const { now } = require('./ids');

const routes = [];
const add = (method, path, handler, opts = {}) => routes.push({ method, path, handler, ...opts });

const get = (path, handler, opts) => add('GET', path, handler, opts);
const post = (path, handler, opts) => add('POST', path, handler, { idempotent: true, ...opts });

function match(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const rp = r.path.split('/');
    const pp = pathname.split('/');
    if (rp.length !== pp.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < rp.length; i++) {
      if (rp[i].startsWith(':')) params[rp[i].slice(1)] = decodeURIComponent(pp[i]);
      else if (rp[i] !== pp[i]) { ok = false; break; }
    }
    if (ok) return { route: r, params };
  }
  return null;
}

const ok = (data) => ({ ok: true, data, error: null });
const fail = (code, message) => ({ ok: false, data: null, error: { code, message } });

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 8 * 1024 * 1024) throw Object.assign(new Error('payload too large'), { status: 413, code: 'PAYLOAD_TOO_LARGE' });
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('請求格式錯誤'), { status: 400, code: 'BAD_JSON' }); }
}

/** Replay protection for writes — I-02 rule 4. */
function idempotencyLookup(key) {
  if (!key) return null;
  const row = db.one('SELECT response FROM idempotency WHERE key = ?', key);
  return row ? JSON.parse(row.response) : null;
}
function idempotencyStore(key, payload) {
  if (!key) return;
  db.run('INSERT OR REPLACE INTO idempotency (key, response, created_at) VALUES (?,?,?)', key, JSON.stringify(payload), now());
}

module.exports = { get, post, add, match, ok, fail, send, readJson, idempotencyLookup, idempotencyStore, routes };
