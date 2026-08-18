'use strict';
/**
 * HEEEHABABY 代購自動化系統 — 後台雛型伺服器
 *
 * Everything the frontend can do goes through /api/v1/{resource}/{action}
 * (README I-02). The frontend holds no secrets and no business rules; roles,
 * state transitions and signature verification are all enforced here.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./lib/config');
const db = require('./lib/db');
const seed = require('./lib/seed');
const auth = require('./lib/auth');
const httpLib = require('./lib/http');

db.open();
if (process.argv.includes('--reset')) {
  seed.reset();
  console.log('[seed] 資料已重置');
} else if (seed.seed()) {
  console.log('[seed] 已載入雛型示範資料');
}

// Route modules register themselves on require.
require('./routes/auth');
require('./routes/orders');
require('./routes/procurement');
require('./routes/shipping');
require('./routes/dashboard');

const WEB_DIR = path.join(__dirname, '..', 'web');
const UPLOAD_DIR = path.join(path.dirname(config.dbPath), 'uploads');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon' };

function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  // --- static ------------------------------------------------------------
  if (!pathname.startsWith('/api/')) {
    if (pathname.startsWith('/uploads/')) {
      const name = path.basename(pathname);
      return serveFile(res, path.join(UPLOAD_DIR, name));
    }
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    const file = path.join(WEB_DIR, rel);
    if (!file.startsWith(WEB_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
    return serveFile(res, fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(WEB_DIR, 'index.html'));
  }

  // --- api ---------------------------------------------------------------
  const hit = httpLib.match(req.method, pathname);
  if (!hit) return httpLib.send(res, 404, httpLib.fail('NOT_FOUND', '找不到這個 API'));

  const idemKey = req.headers['idempotency-key'] || null;
  try {
    if (req.method === 'POST' && hit.route.idempotent && idemKey) {
      const cached = httpLib.idempotencyLookup(idemKey);
      if (cached) return httpLib.send(res, 200, cached);
    }

    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || null;
    const actor = auth.resolve(token);
    const isPublic = pathname === '/api/v1/auth/login' || pathname === '/api/v1/auth/personas';
    if (!actor && !isPublic) return httpLib.send(res, 401, httpLib.fail('UNAUTHENTICATED', '尚未登入'));

    const body = req.method === 'POST' ? await httpLib.readJson(req) : {};
    const query = Object.fromEntries(url.searchParams);
    const payload = await hit.route.handler({ actor, body, query, params: hit.params, req });

    if (req.method === 'POST' && hit.route.idempotent && idemKey) httpLib.idempotencyStore(idemKey, payload);
    return httpLib.send(res, 200, payload);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) {
      // I-03: users never see technical detail; it goes to the server log.
      console.error('[error]', pathname, e);
      return httpLib.send(res, 500, httpLib.fail('INTERNAL', '系統忙碌中，稍後再試'));
    }
    return httpLib.send(res, status, httpLib.fail(e.code || 'ERROR', e.message));
  }
});

server.listen(config.port, () => {
  console.log(`HEEEHABABY 雛型已啟動： http://localhost:${config.port}`);
  console.log(`資料庫：${config.dbPath}`);
});
