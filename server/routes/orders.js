'use strict';
const db = require('../lib/db');
const { get, post, ok } = require('../lib/http');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const { STATUS, transition } = require('../lib/state');
const { uid, now } = require('../lib/ids');
const { round2 } = require('../lib/money');
const notify = require('../lib/notify');
// 買家合約的資料形狀。共用同一份，後台改欄位時買家端不會悄悄跟著跑掉。
const buyerShape = require('./buyer');

const err = (code, message, status = 400) => Object.assign(new Error(message), { code, status });

/**
 * LEFT JOIN 是刻意的：買家從前台下的單（文字、拍照、許願）沒有 SKU。
 * 用 INNER JOIN 的話，這些品項會整個從後台消失 —— 店主打開訂單看到零個品項，
 * 連報價都無從報起。沒有型錄資料時，品名與圖片退回訂單當下的快照。
 */
function itemsOf(orderId) {
  return db.all(
    `SELECT oi.*, coalesce(p.name_zh, oi.name) AS name_zh, p.name_local, p.brand,
            coalesce(p.image_url, oi.source_image_url) AS image_url
       FROM order_items oi LEFT JOIN products p ON p.sku = oi.sku
      WHERE oi.order_id = ? ORDER BY oi.item_id`, orderId);
}

/** Procurement state per order — drives the scan check 6. */
async function procurementCoverage(orderId) {
  const rows = await db.all(
    `SELECT oi.sku, oi.qty, pr.state, pr.got_qty, pr.need_qty
       FROM order_items oi
       JOIN orders o ON o.order_id = oi.order_id
       LEFT JOIN procurements pr ON pr.sku = oi.sku AND pr.batch = o.batch
      WHERE oi.order_id = ?`, orderId);
  const missing = rows.filter((r) => r.state !== 'got');
  return { total: rows.length, missing: missing.map((r) => r.sku), complete: rows.length > 0 && missing.length === 0 };
}

// F-03 訂單查詢 — a buyer only ever sees their own orders.
get('/api/v1/orders/list', async ({ actor, query }) => {
  // 買家看到的是買家合約的形狀（BUYER_API_CONTRACT §3 Order），後台看到的是
  // 後台的形狀。同一條路徑兩種輸出是刻意的 —— 合約把它列為「既有端點」，
  // 而這裡本來就已經依角色過濾了，再開一支只會多一份權限判斷要維護。
  if (actor.role === 'buyer') {
    const rows = await db.all(
      'SELECT * FROM orders WHERE line_user_id = ? ORDER BY created_at DESC, order_id DESC',
      actor.line_user_id);
    return ok(await Promise.all(rows.map(buyerShape.orderShape)));
  }
  const where = [];
  const params = [];
  if (actor.role === 'buyer') { where.push('o.line_user_id = ?'); params.push(actor.line_user_id); }
  else auth.requireCap(actor, 'order.read');
  if (query.batch) { where.push('o.batch = ?'); params.push(query.batch); }
  if (query.status) { where.push('o.status = ?'); params.push(query.status); }
  if (query.q) { where.push('(o.order_id LIKE ? OR m.nickname LIKE ?)'); params.push(`%${query.q}%`, `%${query.q}%`); }
  const limit = Math.min(Number(query.limit) || 100, 500);
  const rows = await db.all(
    `SELECT o.*, m.nickname FROM orders o JOIN members m ON m.line_user_id = o.line_user_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY o.created_at DESC LIMIT ?`, ...params, limit);
  const data = [];
  for (const o of rows) data.push({ ...o, paid: !!o.paid, items: await itemsOf(o.order_id) });
  return ok(auth.redact(actor, data));
});

get('/api/v1/orders/detail', async ({ actor, query }) => {
  const order = await db.one(
    `SELECT o.*, m.nickname, m.display_name FROM orders o JOIN members m ON m.line_user_id = o.line_user_id
      WHERE o.order_id = ?`, query.order_id);
  if (!order) throw err('ORDER_NOT_FOUND', '查無此訂單', 404);
  if (actor.role === 'buyer' && order.line_user_id !== actor.line_user_id) throw err('FORBIDDEN', '權限不足', 403);
  if (actor.role === 'buyer') return ok(await buyerShape.orderShape(order));
  const data = {
    ...order,
    paid: !!order.paid,
    items: await itemsOf(order.order_id),
    coverage: await procurementCoverage(order.order_id),
    payments: await db.all('SELECT * FROM payments WHERE order_id = ?', order.order_id),
    shipments: await db.all('SELECT * FROM shipments WHERE order_id = ?', order.order_id),
    children: await db.all('SELECT order_id, status, total_twd FROM orders WHERE parent_order_id = ?', order.order_id),
    status_log: await db.all('SELECT * FROM order_status_log WHERE order_id = ? ORDER BY ts', order.order_id),
  };
  return ok(auth.redact(actor, data));
});

// F-04 訂單拆分
post('/api/v1/orders/split', async ({ actor, body }) => {
  auth.requireCap(actor, 'order.write');
  if (actor.role !== 'owner') throw err('FORBIDDEN', '拆單需要店主權限', 403);
  const parent = await db.one('SELECT * FROM orders WHERE order_id = ?', body.order_id);
  if (!parent) throw err('ORDER_NOT_FOUND', '查無此訂單', 404);
  if (parent.status !== STATUS.QUOTED) {
    await audit.record({ actor: actor.line_user_id, action: 'order.split', target: parent.order_id, detail: { status: parent.status }, result: 'blocked' });
    throw err('ILLEGAL_STATE', `狀態為「${parent.status}」的訂單不可拆分`, 409);
  }
  const picks = Array.isArray(body.items) ? body.items.filter((i) => Number(i.qty) > 0) : [];
  if (!picks.length) throw err('EMPTY_SPLIT', '請至少選擇一項要拆出的品項');

  return db.tx(async () => {
    await db.setLocal('app.actor', actor.line_user_id);
    await db.setLocal('app.reason', `由 ${parent.order_id} 拆出`);

    const originalTotal = round2((await itemsOf(parent.order_id)).reduce((s, i) => s + i.qty * i.unit_price_twd, 0));
    const suffix = String.fromCharCode(65 + (await db.all('SELECT order_id FROM orders WHERE parent_order_id = ?', parent.order_id)).length);
    const childId = `${parent.order_id}-${suffix}`;
    // paid is generated from payment_status, so the child copies that instead.
    await db.run(
      'INSERT INTO orders (order_id, line_user_id, batch, status, payment_status, total_twd, paid_at, parent_order_id, created_at, note) VALUES (?,?,?,?,?,?,?,?,?,?)',
      childId, parent.line_user_id, parent.batch, parent.status, parent.payment_status, 0, parent.paid_at, parent.order_id, now(),
      `由 ${parent.order_id} 拆出`);

    for (const pick of picks) {
      const item = await db.one('SELECT * FROM order_items WHERE item_id = ? AND order_id = ?', pick.item_id, parent.order_id);
      if (!item) throw err('ITEM_NOT_FOUND', `品項 ${pick.item_id} 不屬於此訂單`);
      const qty = Number(pick.qty);
      if (qty > item.qty) throw err('QTY_EXCEEDS', `${item.sku} 拆出數量超過原數量`);
      if (qty === item.qty) {
        await db.run('UPDATE order_items SET order_id = ? WHERE item_id = ?', childId, item.item_id);
      } else {
        await db.run('UPDATE order_items SET qty = ? WHERE item_id = ?', item.qty - qty, item.item_id);
        await db.run('INSERT INTO order_items (item_id, order_id, sku, name, qty, unit_price_twd, source_image_url) VALUES (?,?,?,?,?,?,?)',
          uid('itm'), childId, item.sku, item.name, qty, item.unit_price_twd, item.source_image_url);
      }
    }

    const parentTotal = round2((await itemsOf(parent.order_id)).reduce((s, i) => s + i.qty * i.unit_price_twd, 0));
    const childTotal = round2((await itemsOf(childId)).reduce((s, i) => s + i.qty * i.unit_price_twd, 0));
    // F-04 例外: totals must reconcile exactly, otherwise roll the whole thing back.
    if (Math.abs(parentTotal + childTotal - originalTotal) > 0.01) {
      throw err('SPLIT_TOTAL_MISMATCH', '拆分後金額與原訂單不符，已回滾', 409);
    }
    await db.run('UPDATE orders SET total_twd = ? WHERE order_id = ?', parentTotal, parent.order_id);
    await db.run('UPDATE orders SET total_twd = ? WHERE order_id = ?', childTotal, childId);
    if (parentTotal === 0) await db.run('UPDATE orders SET note = ? WHERE order_id = ?', '已拆分完畢', parent.order_id);

    await audit.record({ actor: actor.line_user_id, action: 'order.split', target: parent.order_id,
      detail: { child: childId, parentTotal, childTotal, originalTotal }, result: 'ok' });
    return ok({ parent_order_id: parent.order_id, child_order_id: childId, parent_total_twd: parentTotal, child_total_twd: childTotal });
  });
});

// F-10 確認出貨與通知 (manual path — not scan verified)
post('/api/v1/orders/ship', async ({ actor, body }) => {
  auth.requireCap(actor, 'shipment.write');
  const order = await db.one('SELECT * FROM orders WHERE order_id = ?', body.order_id);
  if (!order) throw err('ORDER_NOT_FOUND', '查無此訂單', 404);
  if (order.status === STATUS.SHIPPED) throw err('ALREADY_SHIPPED', '這張單已經出過貨了', 409);
  if (order.status !== STATUS.ARRIVED) throw err('ILLEGAL_STATE', `狀態為「${order.status}」的訂單不可出貨`, 409);

  const overrideReason = body.override_reason ? String(body.override_reason).trim() : null;
  if (!order.paid) {
    if (!overrideReason || !auth.can(actor, 'override.blocked')) {
      await audit.record({ actor: actor.line_user_id, action: 'order.ship', target: order.order_id, detail: { reason: 'unpaid' }, result: 'blocked' });
      throw err('UNPAID', '這位客人還沒付款，需店主填寫原因後覆寫', 409);
    }
  }

  const text = await notificationText(order);
  // Same atomicity as the scan path: shipment, status and queued notification
  // commit together, so 已出貨 can never exist with nothing scheduled to send.
  let moved;
  await db.tx(async () => {
    await db.run('INSERT INTO shipments (shipment_id, order_id, shipped_at, verified_by_scan, operator, override_reason) VALUES (?,?,?,?,?,?)',
      uid('shp'), order.order_id, now(), !!body.verified_by_scan, actor.line_user_id, overrideReason);
    moved = await transition(order.order_id, STATUS.SHIPPED, { actor: actor.line_user_id, reason: overrideReason });
    if (moved._notified) {
      await notify.queue({ kind: 'shipped', lineUserId: order.line_user_id, orderId: order.order_id,
        payload: await shipmentPayload(order, text) });
    }
  });
  notify.poke();
  await audit.record({ actor: actor.line_user_id, action: 'order.ship', target: order.order_id,
    detail: { verified_by_scan: !!body.verified_by_scan, override_reason: overrideReason }, result: overrideReason ? 'warn' : 'ok' });

  return ok({ order_id: order.order_id, status: STATUS.SHIPPED, verified_by_scan: !!body.verified_by_scan, notification: moved._notified ? text : null });
});

/** F-10 通知範本. The prototype renders it instead of calling LINE push. */
async function notificationText(order) {
  const member = await db.one('SELECT nickname FROM members WHERE line_user_id = ?', order.line_user_id);
  const items = await itemsOf(order.order_id);
  const summary = items.map((i) => `${i.name_zh} ×${i.qty}`).join('、') || '（無品項）';
  return `📦 出貨通知\n\n${member ? member.nickname : ''} 您好，您的訂單 ${order.order_id} 已出貨囉！\n\n品項：${summary}\n預計 3 個工作天內送達\n\n有任何問題歡迎直接回覆這則訊息 🙌`;
}

/**
 * What n8n needs to render the LINE message. The ready-made text is included so
 * a plain push works with no extra lookups; the structured fields are there for
 * a Flex card without n8n having to call back for them.
 */
async function shipmentPayload(order, text) {
  const member = await db.one('SELECT nickname FROM members WHERE line_user_id = ?', order.line_user_id);
  const items = await itemsOf(order.order_id);
  const shipments = await db.all(
    'SELECT carrier, tracking_no, eta FROM shipments WHERE order_id = ? ORDER BY shipped_at DESC', order.order_id);
  return {
    text,
    order_id: order.order_id,
    nickname: member ? member.nickname : null,
    pieces: items.reduce((s, i) => s + i.qty, 0),
    items: items.map((i) => ({ name: i.name_zh, qty: i.qty })),
    shipment: shipments[0] || null,
  };
}

// ---- 通知佇列：n8n 取件與回報 --------------------------------------------
// 這兩個端點不走會員 token（n8n 不是會員），改驗共用金鑰。

post('/api/v1/notify/pending', async ({ body, req }) => {
  notify.requireMachine(req);
  // POST, not GET: taking a batch mutates state — it marks the rows as claimed.
  const rows = await notify.claim(body && body.limit);
  return ok({ notifications: rows, count: rows.length });
}, { idempotent: false });

post('/api/v1/notify/result', async ({ body, req }) => {
  notify.requireMachine(req);
  if (!body || !body.notif_id) throw err('BAD_REQUEST', '缺少 notif_id');
  const r = await notify.report({
    notifId: body.notif_id,
    ok: body.ok === true,
    error: body.error || null,
    lineResponse: body.line_response || null,
  });
  if (!r) throw err('NOT_FOUND', '查無此通知', 404);
  return ok(r);
}, { idempotent: false });

// 店主倒退修正：需填原因，資料庫以 app.override 放行，全程稽核。
post('/api/v1/orders/transition', async ({ actor, body }) => {
  auth.requireCap(actor, 'order.write');
  const force = !!body.force;
  if (force) auth.requireCap(actor, 'override.blocked');
  const result = await transition(body.order_id, body.to, { actor: actor.line_user_id, reason: body.reason || null, force });
  return ok({ order_id: result.order_id, status: result.status });
});

// F-06 付款對帳
get('/api/v1/payments/candidates', async ({ actor, query }) => {
  auth.requireCap(actor, 'payment.reconcile');
  const amount = Number(query.amount);
  if (!amount) throw err('BAD_AMOUNT', '請輸入入帳金額');
  const rows = await db.all(
    `SELECT o.order_id, o.total_twd, o.status, m.nickname FROM orders o JOIN members m ON m.line_user_id = o.line_user_id
      WHERE o.paid = false AND o.status = ? AND ABS(o.total_twd - ?) < 0.01`, STATUS.PENDING, amount);
  return ok({ amount, exact_matches: rows, unique: rows.length === 1 });
});

post('/api/v1/payments/reconcile', async ({ actor, body }) => {
  auth.requireCap(actor, 'payment.reconcile');
  const order = await db.one('SELECT * FROM orders WHERE order_id = ?', body.order_id);
  if (!order) throw err('ORDER_NOT_FOUND', '查無此訂單', 404);
  if (order.paid) throw err('ALREADY_PAID', '這張訂單已經認列過款項了', 409);
  const amount = Number(body.amount_twd);
  if (!(amount > 0)) throw err('BAD_AMOUNT', '金額必須大於 0');
  // F-06 例外: over/under payment is recorded but never auto-reconciled.
  const diff = round2(amount - order.total_twd);
  if (Math.abs(diff) > 0.01 && !body.accept_difference) {
    throw err('AMOUNT_MISMATCH', `金額與訂單相差 NT$${diff}，請確認後再認列`, 409);
  }
  await db.run('INSERT INTO payments (payment_id, order_id, amount_twd, method, last5, received_at, reconciled_by) VALUES (?,?,?,?,?,?,?)',
    uid('pay'), order.order_id, amount, body.method || 'transfer', body.last5 || null, body.received_at || now(), actor.line_user_id);
  // orders.paid is generated from payment_status and cannot be written to.
  await db.run("UPDATE orders SET payment_status = '已核對', paid_at = ? WHERE order_id = ?", now(), order.order_id);
  await transition(order.order_id, STATUS.QUOTED, { actor: actor.line_user_id, reason: '收款認列' });
  await audit.record({ actor: actor.line_user_id, action: 'payment.reconcile', target: order.order_id, detail: { amount, diff }, result: diff ? 'warn' : 'ok' });
  return ok({ order_id: order.order_id, status: STATUS.QUOTED, difference_twd: diff });
});

// F-09 看圖理貨 — 已到貨 orders rendered with the customer's original photo.
get('/api/v1/packing/list', async ({ actor, query }) => {
  auth.requireCap(actor, 'order.read');
  const rows = await db.all(
    `SELECT o.*, m.nickname FROM orders o JOIN members m ON m.line_user_id = o.line_user_id
      WHERE o.status = ? ${query.batch ? 'AND o.batch = ?' : ''} ORDER BY o.created_at`,
    ...(query.batch ? [STATUS.ARRIVED, query.batch] : [STATUS.ARRIVED]));
  const data = [];
  for (const o of rows) data.push({ ...o, paid: !!o.paid, items: await itemsOf(o.order_id), coverage: await procurementCoverage(o.order_id) });
  return ok(auth.redact(actor, data));
});

// F-20 進貨物流綁定
post('/api/v1/logistics/bind', async ({ actor, body }) => {
  auth.requireCap(actor, 'shipment.write');
  const tracking = String(body.tracking_no || '').trim();
  if (!tracking) throw err('BAD_TRACKING', '請輸入物流單號');
  const existing = await db.one('SELECT * FROM logistics_bindings WHERE tracking_no = ?', tracking);
  if (existing) throw err('ALREADY_BOUND', `此單號已綁定訂單 ${existing.order_id}`, 409);
  const order = await db.one('SELECT order_id FROM orders WHERE order_id = ?', body.order_id);
  if (!order) throw err('ORDER_NOT_FOUND', '查無此訂單', 404);
  await db.run('INSERT INTO logistics_bindings (tracking_no, order_id, carrier, bound_at, bound_by) VALUES (?,?,?,?,?)',
    tracking, order.order_id, body.carrier || null, now(), actor.line_user_id);
  await audit.record({ actor: actor.line_user_id, action: 'logistics.bind', target: order.order_id, detail: { tracking }, result: 'ok' });
  return ok({ tracking_no: tracking, order_id: order.order_id });
});

get('/api/v1/logistics/list', async ({ actor, query }) => {
  auth.requireCap(actor, 'order.read');
  const rows = query.order_id
    ? await db.all('SELECT * FROM logistics_bindings WHERE order_id = ? ORDER BY bound_at DESC', query.order_id)
    : await db.all('SELECT * FROM logistics_bindings ORDER BY bound_at DESC LIMIT 200');
  return ok(rows);
});

module.exports = { itemsOf, procurementCoverage, notificationText, shipmentPayload };
