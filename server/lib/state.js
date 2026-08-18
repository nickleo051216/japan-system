'use strict';
/**
 * Order state machine — README §2.3.
 * Transitions only follow the arrows; no jumps. Every transition is logged.
 */
const db = require('./db');
const { uid, now } = require('./ids');
const audit = require('./audit');

const STATUS = {
  WISHLIST: '願望清單',
  AWAITING_PAYMENT: '待付款',
  AWAITING_PURCHASE: '待採購',
  PARTIALLY_ARRIVED: '部分到貨',
  AWAITING_SHIPMENT: '待出貨',
  SHIPPED: '已出貨',
  DONE: '已完成',
  AWAITING_REFUND: '待退款',
  REFUNDED: '已退款',
  CANCELLED: '已取消',
};

const TRANSITIONS = {
  [STATUS.WISHLIST]: [STATUS.AWAITING_PAYMENT],
  [STATUS.AWAITING_PAYMENT]: [STATUS.AWAITING_PURCHASE, STATUS.CANCELLED],
  [STATUS.AWAITING_PURCHASE]: [STATUS.PARTIALLY_ARRIVED, STATUS.AWAITING_SHIPMENT, STATUS.AWAITING_REFUND],
  [STATUS.PARTIALLY_ARRIVED]: [STATUS.AWAITING_SHIPMENT, STATUS.AWAITING_REFUND],
  [STATUS.AWAITING_SHIPMENT]: [STATUS.SHIPPED],
  [STATUS.SHIPPED]: [STATUS.DONE],
  [STATUS.AWAITING_REFUND]: [STATUS.REFUNDED],
  [STATUS.DONE]: [],
  [STATUS.REFUNDED]: [],
  [STATUS.CANCELLED]: [],
};

/** 2.3 rule 3: this is the only transition that notifies the customer. */
const NOTIFIES_CUSTOMER = (from, to) => from === STATUS.AWAITING_SHIPMENT && to === STATUS.SHIPPED;

const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

/**
 * Move an order forward. `force` is the §2.3 rule 4 escape hatch: only an owner
 * may correct a status backwards, and only with a reason, which is audited.
 */
function transition(orderId, to, { actor, reason = null, force = false } = {}) {
  const order = db.one('SELECT * FROM orders WHERE order_id = ?', orderId);
  if (!order) throw Object.assign(new Error('查無此訂單'), { code: 'ORDER_NOT_FOUND', status: 404 });

  const from = order.status;
  if (from === to) return order;

  if (!canTransition(from, to)) {
    if (!force) {
      audit.record({ actor, action: 'order.transition', target: orderId, detail: { from, to }, result: 'blocked' });
      throw Object.assign(new Error(`狀態不可由「${from}」轉為「${to}」`), { code: 'ILLEGAL_TRANSITION', status: 409 });
    }
    if (!reason) {
      throw Object.assign(new Error('狀態修正必須填寫原因'), { code: 'REASON_REQUIRED', status: 400 });
    }
  }

  db.run('UPDATE orders SET status = ? WHERE order_id = ?', to, orderId);
  db.run(
    'INSERT INTO order_status_log (log_id, order_id, from_status, to_status, actor, reason, ts) VALUES (?,?,?,?,?,?,?)',
    uid('slog'), orderId, from, to, actor || null, reason, now()
  );
  audit.record({
    actor, action: force ? 'order.transition.forced' : 'order.transition',
    target: orderId, detail: { from, to, reason }, result: force ? 'warn' : 'ok',
  });
  return { ...order, status: to, _notified: NOTIFIES_CUSTOMER(from, to) };
}

module.exports = { STATUS, TRANSITIONS, canTransition, transition, NOTIFIES_CUSTOMER };
