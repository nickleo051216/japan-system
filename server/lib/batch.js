'use strict';
/**
 * 「目前團別」只有一個來源：店主在後台設定的 current_batch。
 * 沒設過才退回最新建立的一團。首頁顯示、結帳歸團、開喊單都讀這裡 ——
 * 各自去猜「最新的一團」，店主切回舊團補單時就會對不上。
 */
const db = require('./db');

async function currentBatch() {
  const b = await db.setting('current_batch', '');
  if (b) return b;
  const row = await db.one('SELECT batch FROM batches ORDER BY created_at DESC LIMIT 1');
  return row ? row.batch : null;
}

module.exports = { currentBatch };
