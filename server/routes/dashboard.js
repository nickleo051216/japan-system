'use strict';
const db = require('../lib/db');
const { get, post, ok } = require('../lib/http');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const { STATUS } = require('../lib/state');
const { uid, now } = require('../lib/ids');
const money = require('../lib/money');

const ntw = (n) => 'NT$' + Number(n).toLocaleString('zh-TW', { maximumFractionDigits: 0 });
const err = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const ACTIVE = [STATUS.AWAITING_PAYMENT, STATUS.AWAITING_PURCHASE, STATUS.PARTIALLY_ARRIVED, STATUS.AWAITING_SHIPMENT, STATUS.SHIPPED, STATUS.DONE];

// F-22 營運儀表板
get('/api/v1/dashboard/summary', ({ actor, query }) => {
  auth.requireCap(actor, 'order.read');
  const batch = query.batch || db.setting('current_batch');
  const placeholders = ACTIVE.map(() => '?').join(',');

  const orders = db.all(`SELECT * FROM orders WHERE batch = ? AND status IN (${placeholders})`, batch, ...ACTIVE);
  const revenue = money.round2(orders.reduce((s, o) => s + o.total_twd, 0));
  const unpaid = money.round2(orders.filter((o) => !o.paid).reduce((s, o) => s + o.total_twd, 0));

  // Per-sku cost, from the fx-snapshotted expenses only. Estimates never count.
  const costBySku = new Map();
  for (const pr of db.all('SELECT proc_id, sku FROM procurements WHERE batch = ?', batch)) {
    const c = money.weightedCost(pr.proc_id);
    if (c) costBySku.set(pr.sku, c.unit_cost_twd);
  }

  const lines = db.all(
    `SELECT oi.sku, oi.qty, oi.unit_price_twd, p.name_zh FROM order_items oi
       JOIN orders o ON o.order_id = oi.order_id
       JOIN products p ON p.sku = oi.sku
      WHERE o.batch = ? AND o.status IN (${placeholders})`, batch, ...ACTIVE);

  let costedRevenue = 0, costedCost = 0, uncostedRevenue = 0;
  const perSku = new Map();
  for (const l of lines) {
    const lineRevenue = l.qty * l.unit_price_twd;
    const unitCost = costBySku.get(l.sku);
    if (unitCost == null) { uncostedRevenue += lineRevenue; continue; }
    const lineCost = l.qty * unitCost;
    costedRevenue += lineRevenue;
    costedCost += lineCost;
    const agg = perSku.get(l.sku) || { sku: l.sku, name_zh: l.name_zh, revenue_twd: 0, cost_twd: 0, qty: 0 };
    agg.revenue_twd += lineRevenue; agg.cost_twd += lineCost; agg.qty += l.qty;
    perSku.set(l.sku, agg);
  }

  const ranking = [...perSku.values()]
    .map((a) => ({
      ...a,
      revenue_twd: money.round2(a.revenue_twd),
      cost_twd: money.round2(a.cost_twd),
      gross_profit_twd: money.round2(a.revenue_twd - a.cost_twd),
      margin_pct: money.margin(a.revenue_twd, a.cost_twd),
    }))
    .sort((a, b) => b.gross_profit_twd - a.gross_profit_twd)
    .slice(0, 10);

  const pendingPieces = db.one(
    `SELECT COALESCE(SUM(need_qty - COALESCE(got_qty,0)),0) AS n FROM procurements WHERE batch = ? AND state != 'got'`, batch).n;

  const todo = [];
  for (const n of db.all("SELECT * FROM notifications WHERE audience = 'owner' AND read_at IS NULL ORDER BY created_at DESC LIMIT 20")) {
    todo.push({ urgency: 1, kind: n.kind, title: n.title, body: n.body, link: '#/board', notif_id: n.notif_id });
  }
  const unpaidCount = orders.filter((o) => !o.paid && o.status === STATUS.AWAITING_PAYMENT).length;
  if (unpaidCount) todo.push({ urgency: 2, kind: 'unpaid', title: `${unpaidCount} 張訂單待收款`, body: `未收款 ${ntw(unpaid)}`, link: '#/orders?status=待付款' });
  const toShip = orders.filter((o) => o.status === STATUS.AWAITING_SHIPMENT).length;
  if (toShip) todo.push({ urgency: 3, kind: 'to_ship', title: `${toShip} 張訂單待出貨`, body: '可列印標籤後掃碼核對', link: '#/packing' });
  if (uncostedRevenue > 0) todo.push({ urgency: 4, kind: 'uncosted', title: '尚有品項未登錄成本', body: `對應營收 ${ntw(uncostedRevenue)} 未計入毛利`, link: '#/board' });
  todo.sort((a, b) => a.urgency - b.urgency);

  const data = {
    batch,
    fx_rate: money.currentFxRate(),
    revenue_twd: revenue,
    unpaid_twd: unpaid,
    order_count: orders.length,
    pending_procurement_pieces: pendingPieces,
    pending_shipment_count: toShip,
    // F-22 毛利呈現規則: uncosted lines are excluded from the denominator and
    // reported separately, never filled in with estimates.
    cost_registered_twd: money.round2(costedCost),
    gross_profit_twd: money.round2(costedRevenue - costedCost),
    margin_pct: money.margin(costedRevenue, costedCost),
    margin_basis_revenue_twd: money.round2(costedRevenue),
    uncosted_revenue_twd: money.round2(uncostedRevenue),
    ranking,
    todo,
  };
  return ok(auth.redact(actor, data));
});

post('/api/v1/notifications/read', ({ actor, body }) => {
  auth.requireCap(actor, 'order.read');
  db.run('UPDATE notifications SET read_at = ? WHERE notif_id = ?', now(), body.notif_id);
  return ok({ notif_id: body.notif_id });
});

// F-23 匯率管理
get('/api/v1/settings/fx', ({ actor }) => {
  auth.requireCap(actor, 'order.read');
  return ok({
    fx_jpy_twd: money.currentFxRate(),
    history: db.all('SELECT * FROM fx_history ORDER BY changed_at DESC LIMIT 50'),
  });
});

post('/api/v1/settings/fx', ({ actor, body }) => {
  auth.requireCap(actor, 'settings.write');
  const rate = Number(body.fx_jpy_twd);
  if (!Number.isFinite(rate) || rate <= 0) throw err('BAD_RATE', '匯率必須是大於 0 的數字');
  const previous = money.currentFxRate();
  db.putSetting('fx_jpy_twd', rate);
  db.run('INSERT INTO fx_history (fx_id, rate, changed_by, changed_at) VALUES (?,?,?,?)', uid('fx'), rate, actor.line_user_id, now());
  audit.record({ actor: actor.line_user_id, action: 'settings.fx', detail: { from: previous, to: rate }, result: 'ok' });
  // Existing procurements keep their snapshot; only new writes use the new rate.
  return ok({ fx_jpy_twd: rate, previous });
});

get('/api/v1/settings/batches', ({ actor }) => {
  auth.requireCap(actor, 'order.read');
  return ok({ current_batch: db.setting('current_batch'), batches: db.all('SELECT * FROM batches ORDER BY batch DESC') });
});

post('/api/v1/settings/batch', ({ actor, body }) => {
  auth.requireCap(actor, 'settings.write');
  const batch = db.one('SELECT batch FROM batches WHERE batch = ?', body.batch);
  if (!batch) throw err('BATCH_NOT_FOUND', '查無此團', 404);
  db.putSetting('current_batch', body.batch);
  audit.record({ actor: actor.line_user_id, action: 'settings.batch', detail: { batch: body.batch }, result: 'ok' });
  return ok({ current_batch: body.batch });
});

get('/api/v1/products/list', ({ actor, query }) => {
  auth.requireCap(actor, 'order.read');
  const rows = query.batch
    ? db.all('SELECT * FROM products WHERE batch = ? ORDER BY sku', query.batch)
    : db.all('SELECT * FROM products ORDER BY sku');
  return ok(auth.redact(actor, rows));
});

get('/api/v1/members/list', ({ actor }) => {
  auth.requireCap(actor, 'order.read');
  return ok(db.all('SELECT line_user_id, nickname, display_name, role, bound_at FROM members ORDER BY role, nickname'));
});
