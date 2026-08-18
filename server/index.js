'use strict';
/** Local development server. Vercel uses api/index.js instead. */
const http = require('node:http');
const config = require('./lib/config');
const app = require('./app');

const seeded = app.boot({ reset: process.argv.includes('--reset') });
if (process.argv.includes('--reset')) console.log('[seed] 資料已重置');
else if (seeded) console.log('[seed] 已載入雛型示範資料');

http.createServer(app.handleRequest).listen(config.port, () => {
  console.log(`HEEEHABABY 雛型已啟動： http://localhost:${config.port}`);
  console.log(`資料庫：${config.dbPath}`);
});
