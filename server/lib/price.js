'use strict';
/**
 * 售價換算 —— 查 price_table 的日幣税込級距，不是匯率乘出來的。
 *
 * 這是業務規則不是計算：同一個日幣金額，不論當天匯率多少，客人看到的台幣
 * 售價都一樣。匯率只用在成本與毛利那一側（F-07 / F-23），跟這裡無關。
 */
const db = require('./db');

/** 找第一個 jpy_taxed_max >= 金額的級距。超出最大級距 → null（現場報價）。 */
async function twdOf(jpyTaxed) {
  const n = Number(jpyTaxed);
  if (!Number.isFinite(n) || n <= 0) return null;
  const row = await db.one(
    'SELECT twd FROM price_table WHERE jpy_taxed_max >= ? ORDER BY jpy_taxed_max LIMIT 1', n);
  return row ? Number(row.twd) : null;
}

async function table() {
  const rows = await db.all('SELECT jpy_taxed_max, twd FROM price_table ORDER BY jpy_taxed_max');
  return rows.map((r) => ({ jpy_taxed_max: Number(r.jpy_taxed_max), twd: Number(r.twd) }));
}

module.exports = { twdOf, table };
