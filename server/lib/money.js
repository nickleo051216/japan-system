'use strict';
/**
 * Cost & margin arithmetic.
 *
 * Two rules from the spec that are easy to get wrong:
 *  - F-23: every procurement stores the fx rate in force at write time.
 *    Cost is always computed from that snapshot, never from today's rate,
 *    otherwise a rate change silently rewrites past margins.
 *  - F-22: items with no registered actual cost are excluded from the margin
 *    denominator and surfaced separately. Estimated cost must never stand in
 *    for actual cost.
 */
const db = require('./db');
const config = require('./config');

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const currentFxRate = () => Number(db.setting('fx_jpy_twd', config.defaultFxRate));

/** Weighted average across every receipt logged for a procurement (F-07 例外 3). */
function weightedCost(procId) {
  const rows = db.all('SELECT qty, unit_cost_jpy, fx_rate FROM expenses WHERE proc_id = ?', procId);
  if (!rows.length) return null;
  const qty = rows.reduce((s, r) => s + r.qty, 0);
  if (qty <= 0) return null;
  const jpy = rows.reduce((s, r) => s + r.qty * r.unit_cost_jpy, 0) / qty;
  const twd = rows.reduce((s, r) => s + r.qty * r.unit_cost_jpy * r.fx_rate, 0) / qty;
  return { qty, unit_cost_jpy: round2(jpy), unit_cost_twd: round2(twd), receipts: rows.length };
}

function margin(priceTwd, costTwd) {
  if (costTwd == null || !priceTwd) return null;
  return round2(((priceTwd - costTwd) / priceTwd) * 100);
}

const LOW_MARGIN_THRESHOLD = 20; // F-07 輸出：毛利率 < 20% 附加提醒

module.exports = { round2, currentFxRate, weightedCost, margin, LOW_MARGIN_THRESHOLD };
