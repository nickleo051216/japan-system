'use strict';
const db = require('../lib/db');
const { get, post, ok } = require('../lib/http');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const { STATUS, transition } = require('../lib/state');
const { uid, now } = require('../lib/ids');
const { round2 } = require('../lib/money');

const err = (code, message, status = 400) => Object.assign(new Error(message), { code, status });

function itemsOf(orderId) {
  return db.all(
    `SELECT oi.*, p.name_zh, p.name_local, p.brand, p.image_url
       FROM order_items oi JOIN products p ON p.sku = oi.sku
      WHERE oi.order_id = ? ORDER BY oi.item_id`, orderId);
}

/** Procurement state per order — drives 部分到貨 and the scan check 6. */
function procurementCoverage(orderId) {
  const rows = db.all(
    `SELECT oi.sku, oi.qty, pr.state, pr.got_qty, pr.need_qty
       FROM order_items oi
       JOIN orders o ON o.order_id = oi.order_id
       LEFT JOIN procurements pr ON pr.sku = oi.sku AND pr.batch = o.batch
      WHERE oi.order_id = ?`, orderId);
  const missing = rows.filter((r) => r.state !== 'got');
  return { total: rows.length, missing: missing.map((r) => r.sku), complete: rows.length > 0 && missing.length === 0 };
}

// F-03 訂單查詢 — a buyer only ever sees their own orders.
get('/api/v1/orders/list', ({ actor, query }) => {
  const where = [];
  const params = [];
  if (actor.role === 'buyer') { where.push('o.line_user_id = ?'); params.push(actor.line_user_id); }
  else auth.requireCap(actor, 'order.read');
  if (query.batch) { where.push('o.batch = ?'); params.push(query.batch); }
  if (query.status) { where.push('o.status = ?'); params.push(query.status); }
  if (query.q) { where.push('(o.order_id LIKE ? OR m.nickname LIKE ?)'); params.push(`%${query.q}%`, `%${query.q}%`); }
  const limit = Math.min(Number(query.limit) || 100, 500);
  const rows = db.all(
    `SELECT o.*, m.nickname FROM orders o JOIN members m ON m.line_user_id = o.line_user_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY o.created_at DESC LIMIT ?`, ...params, limit);
  const data = rows.map((o) => ({ ...o, paid: !!o.paid, items: itemsOf(o.order_id) }));
  return ok(auth.redact(actor, data));
});

get('/api/v1/orders/detail', ({ actor, query }) => {
  const order = db.one(
    `SELECT o.*, m.nickname, m.display_name FROM orders o JOIN members m ON m.line_user_id = o.line_user_id
      WHERE o.order_id = ?`, query.order_id);
  if (!order) throw err('ORDER_NOT_FOUND', '查無此訂單', 404);
  if (actor.role === 'buyer' && order.line_user_id !== actor.line_user_id) throw err('FORBIDDEN', '權限不足', 403);
  const data = {
    ...order,
    paid: !!order.paid,
    items: itemsOf(order.order_id),
    coverage: procurementCoverage(order.order_id),
    payments: db.all('SELECT * FROM payments WHERE order_id = ?', order.order_id),
    shipments: db.all('SELECT * FROM shipments WHERE order_id = ?', order.order_id),
    children: db.all('SELECT order_id, status, total_twd FROM orders WHERE parent_order_id = ?', order.order_id),
    status_log: db.all('SELECT * FROM order_status_log WHERE order_id = ? ORDER BY ts', order.order_id),
  };
  return ok(auth.redact(actor, data));
});

// F-04 訂單拆分
post('/api/v1/orders/split', ({ actor, body }) => {
  auth.requireCap(actor, 'order.write');
  if (actor.role !== 'owner') throw err('FORBIDDEN', '拆單需要店主權限', 403);
  const parent = db.one('SELECT * FROM orders WHERE order_id = ?', body.order_id);
  if (!parent) throw err('ORDER_NOT_FOUND', '查無此訂單', 404);
  if (![STATUS.AWAITING_PURCHASE, STATUS.PARTIALLY_ARRIVED].includes(parent.status)) {
    audit.record({ actor: actor.line_user_id, action: 'order.split', target: parent.order_id, detail: { status: parent.status }, result: 'blocked' });
    throw err('ILLEGAL_STATE', `狀態為「${parent.status}」的訂單不可拆分`, 409);
  }
  const picks = Array.isArray(body.items) ? body.items.filter((i) => Number(i.qty) > 0) : [];
  if (!picks.length) throw err('EMPTY_SPLIT', '請至少選擇一項要拆出的品項');

  return db.tx(() => {
    const originalTotal = round2(itemsOf(parent.order_id).reduce((s, i) => s + i.qty * i.unit_price_twd, 0));
    const suffix = String.fromCharCode(65 + db.all('SELECT order_id FROM orders WHERE parent_order_id = ?', parent.order_id).length);
    const childId = `${parent.order_id}-${suffix}`;
    db.run(
      'INSERT INTO orders (order_id, line_user_id, batch, status, total_twd, paid, paid_at, parent_order_id, created_at, note) VALUES (?,?,?,?,?,?,?,?,?,?)',
      childId, parent.line_user_id, parent.batch, parent.status, 0, parent.paid, parent.paid_at, parent.order_id, now(),
      `由 ${parent.order_id} 拆出`);

    for (const pick of picks) {
      const item = db.one('SELECT * FROM order_items WHERE item_id = ? AND order_id = ?', pick.item_id, parent.order_id);
      if (!item) throw err('ITEM_NOT_FOUND', `品項 ${pick.item_id} 不屬於此訂單`);
      const qty = Number(pick.qty);
      if (qty > item.qty) throw err('QTY_EXCEEDS', `${item.sku} 拆出數量超過原數量`);
      if (qty === item.qty) {
        db.run('UPDATE order_items SET order_id = ? WHERE item_id = ?', childId, item.item_id);
      } else {
        db.run('UPDATE order_items SET qty = ? WHERE item_id = ?', item.qty - qty, item.item_id);
        db.run('INSERT INTO order_items (item_id, order_id, sku, qty, unit_price_twd, source_image_url) VALUES (?,?,?,?,?,?)',
          uid('itm'), childId, item.sku, qty, item.unit_price_twd, item.source_image_url);
      }
    }

    const parentTotal = round2(itemsOf(parent.order_id).reduce((s, i) => s + i.qty * i.unit_price_twd, 0));
    const childTotal = round2(itemsOf(childId).reduce((s, i) => s + i.qty * i.unit_price_twd, 0));
    // F-04 例外: totals must reconcile exactly, otherwise roll the whole thing back.
    if (Math.abs(parentTotal + childTotal - originalTotal) > 0.01) {
      throw err('SPLIT_TOTAL_MISMATCH', '拆分後金額與原訂單不符，已回滾', 409);
    }
    db.run('UPDATE orders SET total_twd = ? WHERE order_id = ?', parentTotal, parent.order_id);
    db.run('UPDATE orders SET total_twd = ? WHERE order_id = ?', childTotal, childId);
    if (parentTotal === 0) db.run('UPDATE orders SET note = ? WHERE order_id = ?', '已拆分完畢', parent.order_id);

    audit.record({ actor: actor.line_user_id, action: 'order.split', target: parent.order_id,
      detail: { child: childId, parentTotal, childTotal, originalTotal }, result: 'ok' });
    return ok({ parent_order_id: parent.order_id, child_order_id: childId, parent_total_twd: parentTotal, child_total_twd: childTotal });
  });
});

// F-10 確認出貨與通知 (manual path — not scan verified)
post('/api/v1/orders/ship', ({ actor, body }) => {
  auth.requireCap(actor, 'shipment.write');
  const order = db.one('SELECT * FROM orders WHERE order_id = ?', body.order_id);
  if (!order) throw err('ORDER_NOT_FOUND', '查無此訂單', 404);
  if (order.status === STATUS.SHIPPED) throw err('ALREADY_SHIPPED', '這張單已經出過貨了', 409);
  if (order.status !== STATUS.AWAITING_SHIPMENT) throw err('ILLEGAL_STATE', `狀態為「${order.status}」的訂單不可出貨`, 409);

  const overrideReason = body.override_reason ? String(body.override_reason).trim() : null;
  if (!order.paid) {
    if (!overrideReason || !auth.can(actor, 'override.blocked')) {
      audit.record({ actor: actor.line_user_id, action: 'order.ship', target: order.order_id, detail: { reason: 'unpaid' }, result: 'blocked' });
      throw err('UNPAID', '這位客人還沒付款，需店主填寫原因後覆寫', 409);
    }
  }

  db.run('INSERT INTO shipments (shipment_id, order_id, shipped_at, verified_by_scan, operator, override_reason) VALUES (?,?,?,?,?,?)',
    uid('shp'), order.order_id, now(), body.verified_by_scan ? 1 : 0, actor.line_user_id, overrideReason);
  const moved = transition(order.order_id, STATUS.SHIPPED, { actor: actor.line_user_id, reason: overrideReason });
  audit.record({ actor: actor.line_user_id, action: 'order.ship', target: order.order_id,
    detail: { verified_by_scan: !!body.verified_by_scan, override_reason: overrideReason }, result: overrideReason ? 'warn' : 'ok' });

  return ok({ order_id: order.order_id, status: STATUS.SHIPPED, verified_by_scan: !!body.verified_by_scan, notification: moved._notified ? notificationText(order) : null });
});

/** F-10 通知範本. The prototype renders it instead of calling LINE push. */
function notificationText(order) {
  const member = db.one('SELECT nickname FROM members WHERE line_user_id = ?', order.line_user_id);
  const items = itemsOf(order.order_id);
  const summary = items.map((i) => `${i.name_zh} ×${i.qty}`).join('、') || '（無品項）';
  return `📦 出貨通知\n\n${member ? member.nickname : ''} 您好，您的訂單 ${order.order_id} 已出貨囉！\n\n品項：${summary}\n預計 3 個工作天內送達\n\n有任何問題歡迎直接回覆這則訊息 🙌`;
}

// §2.3 rule 4 — owner-only backwards correction, reason required, audited.
post('/api/v1/orders/transition', ({ actor, body }) => {
  auth.requireCap(actor, 'order.write');
  const force = !!body.force;
  if (force) auth.requireCap(actor, 'override.blocked');
  const result = transition(body.order_id, body.to, { actor: actor.line_user_id, reason: body.reason || null, force });
  return ok({ order_id: result.order_id, status: result.status });
});

// F-06 付款對帳
get('/api/v1/payments/candidates', ({ actor, query }) => {
  auth.requireCap(actor, 'payment.reconcile');
  const amount = Number(query.amount);
  if (!amount) throw err('BAD_AMOUNT', '請輸入入帳金額');
  const rows = db.all(
    `SELECT o.order_id, o.total_twd, o.status, m.nickname FROM orders o JOIN members m ON m.line_user_id = o.line_user_id
      WHERE o.paid = 0 AND o.status = ? AND ABS(o.total_twd - ?) < 0.01`, STATUS.AWAITING_PAYMENT, amount);
  return ok({ amount, exact_matches: rows, unique: rows.length === 1 });
});

post('/api/v1/payments/reconcile', ({ actor, body }) => {
  auth.requireCap(actor, 'payment.reconcile');
  const order = db.one('SELECT * FROM orders WHERE order_id = ?', body.order_id);
  if (!order) throw err('ORDER_NOT_FOUND', '查無此訂單', 404);
  if (order.paid) throw err('ALREADY_PAID', '這張訂單已經認列過款項了', 409);
  const amount = Number(body.amount_twd);
  if (!(amount > 0)) throw err('BAD_AMOUNT', '金額必須大於 0');
  // F-06 例外: over/under payment is recorded but never auto-reconciled.
  const diff = round2(amount - order.total_twd);
  if (Math.abs(diff) > 0.01 && !body.accept_difference) {
    throw err('AMOUNT_MISMATCH', `金額與訂單相差 NT$${diff}，請確認後再認列`, 409);
  }
  db.run('INSERT INTO payments (payment_id, order_id, amount_twd, method, last5, received_at, reconciled_by) VALUES (?,?,?,?,?,?,?)',
    uid('pay'), order.order_id, amount, body.method || 'transfer', body.last5 || null, body.received_at || now(), actor.line_user_id);
  db.run('UPDATE orders SET paid = 1, paid_at = ? WHERE order_id = ?', now(), order.order_id);
  transition(order.order_id, STATUS.AWAITING_PURCHASE, { actor: actor.line_user_id, reason: '收款認列' });
  audit.record({ actor: actor.line_user_id, action: 'payment.reconcile', target: order.order_id, detail: { amount, diff }, result: diff ? 'warn' : 'ok' });
  return ok({ order_id: order.order_id, status: STATUS.AWAITING_PURCHASE, difference_twd: diff });
});

// F-09 看圖理貨 — 待出貨 orders rendered with the customer's original photo.
get('/api/v1/packing/list', ({ actor, query }) => {
  auth.requireCap(actor, 'order.read');
  const rows = db.all(
    `SELECT o.*, m.nickname FROM orders o JOIN members m ON m.line_user_id = o.line_user_id
      WHERE o.status = ? ${query.batch ? 'AND o.batch = ?' : ''} ORDER BY o.created_at`,
    ...(query.batch ? [STATUS.AWAITING_SHIPMENT, query.batch] : [STATUS.AWAITING_SHIPMENT]));
  const data = rows.map((o) => ({ ...o, paid: !!o.paid, items: itemsOf(o.order_id), coverage: procurementCoverage(o.order_id) }));
  return ok(auth.redact(actor, data));
});

// F-20 進貨物流綁定
post('/api/v1/logistics/bind', ({ actor, body }) => {
  auth.requireCap(actor, 'shipment.write');
  const tracking = String(body.tracking_no || '').trim();
  if (!tracking) throw err('BAD_TRACKING', '請輸入物流單號');
  const existing = db.one('SELECT * FROM logistics_bindings WHERE tracking_no = ?', tracking);
  if (existing) throw err('ALREADY_BOUND', `此單號已綁定訂單 ${existing.order_id}`, 409);
  const order = db.one('SELECT order_id FROM orders WHERE order_id = ?', body.order_id);
  if (!order) throw err('ORDER_NOT_FOUND', '查無此訂單', 404);
  db.run('INSERT INTO logistics_bindings (tracking_no, order_id, carrier, bound_at, bound_by) VALUES (?,?,?,?,?)',
    tracking, order.order_id, body.carrier || null, now(), actor.line_user_id);
  audit.record({ actor: actor.line_user_id, action: 'logistics.bind', target: order.order_id, detail: { tracking }, result: 'ok' });
  return ok({ tracking_no: tracking, order_id: order.order_id });
});

get('/api/v1/logistics/list', ({ actor, query }) => {
  auth.requireCap(actor, 'order.read');
  const rows = query.order_id
    ? db.all('SELECT * FROM logistics_bindings WHERE order_id = ? ORDER BY bound_at DESC', query.order_id)
    : db.all('SELECT * FROM logistics_bindings ORDER BY bound_at DESC LIMIT 200');
  return ok(rows);
});

module.exports = { itemsOf, procurementCoverage, notificationText };
