'use strict';
const crypto = require('node:crypto');

const now = () => new Date().toISOString();
const uid = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;

/** Order id format from README §3.1: HB{YYMM}-{序號} */
function nextOrderId(db, at = new Date()) {
  const yymm = `${String(at.getUTCFullYear()).slice(2)}${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
  const prefix = `HB${yymm}-`;
  const row = db.one(
    "SELECT order_id FROM orders WHERE order_id LIKE ? AND parent_order_id IS NULL ORDER BY order_id DESC LIMIT 1",
    `${prefix}%`
  );
  const seq = row ? Number(String(row.order_id).slice(prefix.length).split('-')[0]) + 1 : 1;
  return `${prefix}${String(seq).padStart(3, '0')}`;
}

module.exports = { now, uid, nextOrderId };
