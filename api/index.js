'use strict';
/**
 * Vercel serverless entry. Only /api/* and /uploads/* reach here — the static
 * frontend in web/ is served straight from Vercel's CDN (see vercel.json).
 */
const path = require('node:path');
const app = require('../server/app');

module.exports = async function handler(req, res) {
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  if (pathname.startsWith('/uploads/')) {
    app.boot();
    return app.serveFile(res, path.join(app.UPLOAD_DIR, path.basename(pathname)));
  }
  return app.handleApi(req, res);
};
