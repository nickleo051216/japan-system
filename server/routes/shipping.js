'use strict';
const QRCode = require('qrcode');
const db = require('../lib/db');
const { get, post, ok } = require('../lib/http');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const { STATUS, transition } = require('../lib/state');
const { uid, now } = require('../lib/ids');
const sig = require('../lib/signature');
const { itemsOf, procurementCoverage, notificationText } = require('./orders');

const err = (code, message, status = 400) => Object.assign(new Error(message), { code, status });

/**
 * F-18 例外攔截 — checks run IN ORDER and stop at the first failure.
 * red   = never overridable
 * yellow = overridable by 店主 with a written reason (audited)
 */
function runChecks(raw) {
  const parsed = sig.parse(raw);
  if (!parsed) return { level: 'red', code: 'BAD_FORMAT', step: 1, message: '格式不是本店標籤' };

  const order = db.one('SELECT * FROM orders WHERE order_id = ?', parsed.orderId);
  if (!order) return { level: 'red', code: 'ORDER_NOT_FOUND', step: 2, message: '查無此訂單', order_id: parsed.orderId };

  if (!sig.verify(parsed.orderId, parsed.signature)) {
    return { level: 'red', code: 'BAD_SIGNATURE', step: 3, message: '驗證碼不符，這張標籤不是系統印的', order_id: parsed.orderId };
  }

  const context = {
    order_id: order.order_id,
    status: order.status,
    nickname: (db.one('SELECT nickname FROM members WHERE line_user_id = ?', order.line_user_id) || {}).nickname,
    items: itemsOf(order.order_id).map((i) => ({ sku: i.sku, name_zh: i.name_zh, qty: i.qty })),
  };

  if (order.status === STATUS.SHIPPED) return { level: 'yellow', code: 'ALREADY_SHIPPED', step: 4, message: '這張單已經出過貨了', ...context };
  if (!order.paid) return { level: 'yellow', code: 'UNPAID', step: 5, message: '這位客人還沒付款', ...context };
  const coverage = procurementCoverage(order.order_id);
  if (!coverage.complete) return { level: 'yellow', code: 'INCOMPLETE_PROCUREMENT', step: 6, message: '這張單還有品項沒買到', missing: coverage.missing, ...context };

  return { level: 'green', code: 'PASS', step: 7, message: '核對通過，可以出貨', ...context };
}

// F-17 掃碼核對工作站 — verify only, never mutates.
post('/api/v1/scan/verify', ({ actor, body }) => {
  auth.requireCap(actor, 'shipment.write');
  const result = runChecks(body.code);
  audit.record({ actor: actor.line_user_id, action: 'scan.verify', target: result.order_id || null,
    detail: { code: String(body.code || '').slice(0, 64), level: result.level, check: result.code },
    result: result.level === 'green' ? 'ok' : result.level === 'yellow' ? 'warn' : 'blocked' });
  return ok(result);
});

/**
 * Commit a scan into an actual shipment. Re-runs the checks server-side so a
 * client cannot ship by claiming it saw a green light.
 */
post('/api/v1/scan/commit', ({ actor, body }) => {
  auth.requireCap(actor, 'shipment.write');
  const result = runChecks(body.code);
  const reason = body.override_reason ? String(body.override_reason).trim() : null;

  if (result.level === 'red') {
    audit.record({ actor: actor.line_user_id, action: 'scan.commit', target: result.order_id || null, detail: { check: result.code }, result: 'blocked' });
    throw err(result.code, `${result.message}（紅燈不可覆寫）`, 409);
  }
  if (result.level === 'yellow') {
    if (!auth.can(actor, 'override.blocked')) {
      audit.record({ actor: actor.line_user_id, action: 'scan.commit', target: result.order_id, detail: { check: result.code }, result: 'blocked' });
      throw err(result.code, `${result.message}（需店主覆寫）`, 403);
    }
    if (!reason) throw err('REASON_REQUIRED', `${result.message}，覆寫必須填寫原因`, 400);
    if (result.code === 'ALREADY_SHIPPED') throw err('ALREADY_SHIPPED', '這張單已經出過貨了，不可重複出貨', 409);
  }

  const order = db.one('SELECT * FROM orders WHERE order_id = ?', result.order_id);
  if (order.status !== STATUS.AWAITING_SHIPMENT) {
    audit.record({ actor: actor.line_user_id, action: 'scan.commit', target: order.order_id, detail: { status: order.status }, result: 'blocked' });
    throw err('ILLEGAL_STATE', `狀態為「${order.status}」的訂單還不能出貨`, 409);
  }
  db.run('INSERT INTO shipments (shipment_id, order_id, shipped_at, verified_by_scan, operator, override_reason) VALUES (?,?,?,?,?,?)',
    uid('shp'), order.order_id, now(), 1, actor.line_user_id, reason);
  transition(order.order_id, STATUS.SHIPPED, { actor: actor.line_user_id, reason: reason || '掃碼核對通過' });
  audit.record({ actor: actor.line_user_id, action: 'scan.commit', target: order.order_id,
    detail: { check: result.code, override_reason: reason, verified_by_scan: true }, result: reason ? 'warn' : 'ok' });

  return ok({ order_id: order.order_id, status: STATUS.SHIPPED, verified_by_scan: true, override_reason: reason, notification: notificationText(order) });
});

// F-15 QR 出貨標籤產生器
get('/api/v1/labels/data', async ({ actor, query }) => {
  auth.requireCap(actor, 'shipment.write');
  const ids = String(query.order_ids || '').split(',').map((s) => s.trim()).filter(Boolean);
  const rows = ids.length
    ? ids.map((id) => db.one(`SELECT o.*, m.nickname FROM orders o JOIN members m ON m.line_user_id = o.line_user_id WHERE o.order_id = ?`, id)).filter(Boolean)
    : db.all(`SELECT o.*, m.nickname FROM orders o JOIN members m ON m.line_user_id = o.line_user_id WHERE o.status = ? ORDER BY o.created_at`, STATUS.AWAITING_SHIPMENT);

  const labels = [];
  for (const o of rows) {
    const payload = sig.payload(o.order_id);
    // Error correction level Q (~25%), 4-module quiet zone — README F-15 標籤規格
    const svg = await QRCode.toString(payload, { type: 'svg', errorCorrectionLevel: 'Q', margin: 4, width: 200 });
    const items = itemsOf(o.order_id);
    labels.push({
      order_id: o.order_id,
      nickname: o.nickname,
      pieces: items.reduce((s, i) => s + i.qty, 0),
      date: new Date().toISOString().slice(0, 10),
      shop: 'HEEEHABABY',
      payload,
      qr_svg: svg,
    });
  }
  audit.record({ actor: actor.line_user_id, action: 'label.print', detail: { count: labels.length }, result: 'ok' });
  return ok({ labels });
});

// F-19 出貨稽核軌跡
get('/api/v1/audit/list', ({ actor, query }) => {
  auth.requireCap(actor, 'audit.read');
  return ok(audit.list({ from: query.from, to: query.to, actor: query.actor, result: query.result, limit: Number(query.limit) || 200 }));
});

get('/api/v1/shipments/list', ({ actor, query }) => {
  auth.requireCap(actor, 'order.read');
  const rows = db.all(
    `SELECT s.*, o.status, m.nickname FROM shipments s
       JOIN orders o ON o.order_id = s.order_id
       JOIN members m ON m.line_user_id = o.line_user_id
      ORDER BY s.shipped_at DESC LIMIT ?`, Number(query.limit) || 100);
  return ok(rows.map((r) => ({ ...r, verified_by_scan: !!r.verified_by_scan })));
});

module.exports = { runChecks };
