'use strict';
/**
 * Request handling, shared by both entry points:
 *   server/index.js — long-running local server (npm start)
 *   api/index.js    — Vercel serverless function
 *
 * Everything the frontend can do goes through /api/v1/{resource}/{action}
 * (README I-02). The frontend holds no secrets and no business rules; roles,
 * state transitions and signature verification are all enforced here.
 */
const fs = require('node:fs');
const path = require('node:path');
const config = require('./lib/config');
const auth = require('./lib/auth');
const liff = require('./lib/liff');
const httpLib = require('./lib/http');

const WEB_DIR = path.join(__dirname, '..', 'web');
const UPLOAD_DIR = config.uploadDir;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon' };

let booted = false;

/**
 * Register routes. Idempotent because a serverless instance calls it on every
 * invocation but only the first does work. Schema belongs to
 * supabase/migrations and demo data to `npm run reset`, so boot() never writes
 * anything.
 *
 * It deliberately does NOT open the connection pool: lib/db opens lazily on the
 * first query, so a deployment with no DATABASE_URL can still answer
 * /api/v1/health with "that is exactly what is missing" instead of failing
 * before routing even happens.
 */
function boot() {
  if (booted) return false;
  // Route modules register themselves on require.
  require('./routes/health');
  require('./routes/auth');
  require('./routes/orders');
  require('./routes/procurement');
  require('./routes/shipping');
  require('./routes/dashboard');
  // 買家 API（BUYER_API_CONTRACT.md）。buyer.js 要先載入 —— 另外兩支共用它的
  // 身分包裝與資料形狀。
  require('./routes/buyer');
  require('./routes/buyer-cart');
  require('./routes/buyer-orders');
  // 後台「放東西進店裡」的入口：開團、喊單、許願報價、訂單報價、對帳單。
  require('./routes/admin-shop');
  // 後台設定：價目表、成員與權限。
  require('./routes/admin-config');
  booted = true;
  return true;
}

function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  const idemKey = req.headers['idempotency-key'] || null;
  try {
    // Inside the try: boot() now throws when DATABASE_URL is missing, and a
    // misconfigured deployment must still answer in the I-03 error shape.
    boot();

    const hit = httpLib.match(req.method, pathname);
    if (!hit) return httpLib.send(res, 404, httpLib.fail('NOT_FOUND', '找不到這個 API'));

    // /notify/* 是 n8n 對打的機器介面，身分由路由自己驗共用金鑰，
    // 不經過會員 token —— n8n 不是會員。/health 則必須在資料庫掛掉時還答得出話。
    const isPublic = pathname === '/api/v1/auth/login' || pathname === '/api/v1/auth/personas'
      || pathname === '/api/v1/health' || pathname.startsWith('/api/v1/notify/')
      || pathname === '/api/v1/ocr/result' || pathname === '/api/v1/ocr/pending'
      || pathname === '/api/v1/statements/generate';

    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || null;
    let actor = null;
    try {
      // 兩種憑證，同一個出口：後端自簽的 session token（兩段）給後台與自動化，
      // LINE 的 ID Token（JWT，三段）給 LIFF 買家。路由拿到的一律是 members 一列，
      // 不必各自判斷身分是從哪來的。
      actor = await auth.resolve(token);
      if (!actor && token && token.split('.').length === 3) {
        actor = await liff.fromIdToken(token);
      }
    } catch (e) {
      // 解析 token 要查資料庫。資料庫不通時，公開路由不該跟著一起 500 ——
      // /health 的工作就是在這種時候告訴你哪裡壞了。
      if (!isPublic) throw e;
      console.warn('[auth] 公開路由解析 token 失敗，視為未登入：', e.message);
    }
    if (!actor && !isPublic) return httpLib.send(res, 401, httpLib.fail('UNAUTHENTICATED', '尚未登入'));

    // 查冪等快取必須在身分解析之後 —— 快取鍵綁定發話者，否則猜中一把
    // Idempotency-Key 就能在完全不驗身分的情況下領走別人的回應。
    const actorId = actor ? actor.line_user_id : null;
    if (req.method === 'POST' && hit.route.idempotent && idemKey) {
      const cached = await httpLib.idempotencyLookup(idemKey, actorId);
      if (cached) return httpLib.send(res, 200, cached);
    }

    const body = req.method === 'POST' ? await httpLib.readJson(req) : {};
    const query = Object.fromEntries(url.searchParams);
    const payload = await hit.route.handler({ actor, body, query, params: hit.params, req });

    if (req.method === 'POST' && hit.route.idempotent && idemKey) await httpLib.idempotencyStore(idemKey, payload, actorId);
    return httpLib.send(res, 200, payload);
  } catch (e) {
    // 有明確 status 的是我們自己丟的，訊息本來就是寫給人看的（例如「後台登入
    // 尚未設定密碼」），照原樣回。先前一律用 status >= 500 判斷，結果刻意丟的
    // 503 也被收斂成「系統忙碌中」—— 設定漏了卻看不出漏在哪，剛好違背初衷。
    // 沒帶 status 的才是沒預期到的例外，一律收斂：I-03 規定使用者不該看到技術細節。
    if (e.status) {
      if (e.status >= 500) console.error('[error]', pathname, e.code, e.message);
      return httpLib.send(res, e.status, httpLib.fail(e.code || 'ERROR', e.message));
    }
    console.error('[error]', pathname, e);
    return httpLib.send(res, 500, httpLib.fail('INTERNAL', '系統忙碌中，稍後再試'));
  }
}

/** Local server also serves the static frontend; on Vercel that is done by the CDN. */
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith('/api/')) return handleApi(req, res);

  if (pathname.startsWith('/uploads/')) {
    return serveFile(res, path.join(UPLOAD_DIR, path.basename(pathname)));
  }
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  const file = path.join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  return serveFile(res, fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(WEB_DIR, 'index.html'));
}

module.exports = { boot, handleApi, handleRequest, serveFile, UPLOAD_DIR, WEB_DIR };
