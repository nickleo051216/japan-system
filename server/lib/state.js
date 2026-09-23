'use strict';
/**
 * Order state machine — 實際營運狀態（業主確認版）。
 *
 *   待確認 → 已報價 / 已取消
 *   已報價 → 已到貨 / 缺貨 / 已取消
 *   已到貨 → 已出貨
 *   已出貨 → 已送達
 *   已送達 / 缺貨 / 已取消 為終點
 *
 * The database owns both halves of this: order_status_rules plus the
 * trg_order_status_check trigger reject every illegal move, and
 * trg_order_status_log writes order_status_log by itself on insert and on
 * every status change. This module therefore never writes that log — doing so
 * would record each transition twice.
 *
 * The table below mirrors order_status_rules so the API can tell a plain
 * illegal move (409) from an owner correction that still needs a reason (400)
 * before the write reaches the database.
 */
const db = require('./db');
const audit = require('./audit');

const STATUS = {
  PENDING: '待確認',
  QUOTED: '已報價',
  ARRIVED: '已到貨',
  SHIPPED: '已出貨',
  DELIVERED: '已送達',
  OUT_OF_STOCK: '缺貨',
  CANCELLED: '已取消',
};

const TRANSITIONS = {
  [STATUS.PENDING]: [STATUS.QUOTED, STATUS.CANCELLED],
  [STATUS.QUOTED]: [STATUS.ARRIVED, STATUS.OUT_OF_STOCK, STATUS.CANCELLED],
  [STATUS.ARRIVED]: [STATUS.SHIPPED],
  [STATUS.SHIPPED]: [STATUS.DELIVERED],
  [STATUS.DELIVERED]: [],
  [STATUS.OUT_OF_STOCK]: [],
  [STATUS.CANCELLED]: [],
};

/** Only this transition notifies the customer. */
const NOTIFIES_CUSTOMER = (from, to) => from === STATUS.ARRIVED && to === STATUS.SHIPPED;

const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

/** What check_order_status() raises: SQLSTATE P0001, message ILLEGAL_TRANSITION … */
const isIllegalTransition = (e) =>
  !!e && e.code === 'P0001' && /^ILLEGAL_TRANSITION/.test(e.message || '');

/**
 * Move an order forward. `force` is the owner's escape hatch: only an owner may
 * correct a status backwards, and only with a reason, which is audited and
 * passed to the database as app.override so the trigger lets it through.
 */
async function transition(orderId, to, { actor, reason = null, force = false } = {}) {
  const order = await db.one('SELECT * FROM orders WHERE order_id = ?', orderId);
  if (!order) throw Object.assign(new Error('查無此訂單'), { code: 'ORDER_NOT_FOUND', status: 404 });

  const from = order.status;
  if (from === to) return order;

  // Checked before the write so an owner override without a reason is a 400,
  // not a database error.
  if (force && !canTransition(from, to) && !reason) {
    throw Object.assign(new Error('狀態修正必須填寫原因'), { code: 'REASON_REQUIRED', status: 400 });
  }

  // 「已報價」的意思是「客人要付的錢定了」。文字、拍照下單沒有日幣價時，
  // 品項是以 0 元入單的；讓它帶著 0 元變成已報價，總額就會少算，而且不會報錯。
  // 所以不論從哪條路徑（報價、收款認列、手動轉換、店主強制）都在這裡擋。
  if (to === STATUS.QUOTED) {
    const unpriced = await db.all(
      'SELECT name FROM order_items WHERE order_id = ? AND (unit_price_twd IS NULL OR unit_price_twd <= 0)', orderId);
    if (unpriced.length) {
      throw Object.assign(
        new Error(`還有 ${unpriced.length} 個品項沒有定價（${unpriced.map((i) => i.name).slice(0, 3).join('、')}），請先報價`),
        { code: 'UNPRICED_ITEMS', status: 409 });
    }
  }

  try {
    await db.tx(async () => {
      // Read back by trg_order_status_log; app.override by trg_order_status_check.
      await db.setLocal('app.actor', actor);
      await db.setLocal('app.reason', reason);
      if (force) await db.setLocal('app.override', 'on');
      await db.run('UPDATE orders SET status = ? WHERE order_id = ?', to, orderId);
    });
  } catch (e) {
    if (!isIllegalTransition(e)) throw e;
    // Best effort: when transition() runs inside a caller's transaction that
    // transaction is already aborted, so this write cannot land. The 409 is
    // what the caller needs either way.
    try {
      await audit.record({ actor, action: 'order.transition', target: orderId, detail: { from, to }, result: 'blocked' });
    } catch (_) { /* aborted transaction */ }
    throw Object.assign(new Error(`狀態不可由「${from}」轉為「${to}」`), { code: 'ILLEGAL_TRANSITION', status: 409 });
  }

  await audit.record({
    actor, action: force ? 'order.transition.forced' : 'order.transition',
    target: orderId, detail: { from, to, reason }, result: force ? 'warn' : 'ok',
  });
  return { ...order, status: to, _notified: NOTIFIES_CUSTOMER(from, to) };
}

module.exports = { STATUS, TRANSITIONS, canTransition, transition, NOTIFIES_CUSTOMER, isIllegalTransition };
