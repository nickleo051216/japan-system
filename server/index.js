'use strict';
/** Local development server. Vercel uses api/index.js instead. */
const http = require('node:http');
const config = require('./lib/config');
const app = require('./app');
const seed = require('./lib/seed');

(async () => {
  app.boot();
  // Demo data is only ever written on an explicit `npm run reset`.
  if (process.argv.includes('--reset')) {
    await seed.reset();
    console.log('[seed] 資料已重置');
  }
  http.createServer(app.handleRequest).listen(config.port, () => {
    console.log(`HEEEHABABY 雛型已啟動： http://localhost:${config.port}`);
    console.log(`資料庫：Postgres（DATABASE_URL，連線數上限 ${process.env.DB_POOL_MAX || 3}）`);
  });
})().catch((e) => {
  console.error('[boot] 啟動失敗：', e.message);
  process.exit(1);
});
