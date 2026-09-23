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
const ACTIVE = [STATUS.PENDING, STATUS.QUOTED, STATUS.ARRIVED, STATUS.SHIPPED, STATUS.DELIVERED];

// F-22 營運儀表板
get('/api/v1/dashboard/summary', async ({ actor, query }) => {
  auth.requireCap(actor, 'order.read');
  const batch = query.batch || await db.setting('current_batch');
  const placeholders = ACTIVE.map(() => '?').join(',');

  const orders = await db.all(`SELECT * FROM orders WHERE batch = ? AND status IN (${placeholders})`, batch, ...ACTIVE);
  const revenue = money.round2(orders.reduce((s, o) => s + o.total_twd, 0));
  const unpaid = money.round2(orders.filter((o) => !o.paid).reduce((s, o) => s + o.total_twd, 0));

  // Per-sku cost, from the fx-snapshotted expenses only. Estimates never count.
  const costBySku = new Map();
  for (const pr of await db.all('SELECT proc_id, sku FROM procurements WHERE batch = ?', batch)) {
    const c = await money.weightedCost(pr.proc_id);
    if (c) costBySku.set(pr.sku, c.unit_cost_twd);
  }

  const lines = await db.all(
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

  const pendingPieces = (await db.one(
    `SELECT COALESCE(SUM(need_qty - COALESCE(got_qty,0)),0) AS n FROM procurements WHERE batch = ? AND state != 'got'`, batch)).n;

  const todo = [];
  for (const n of await db.all("SELECT * FROM notifications WHERE audience = 'owner' AND read_at IS NULL ORDER BY created_at DESC LIMIT 20")) {
    todo.push({ urgency: 1, kind: n.kind, title: n.title, body: n.body, link: '#/board', notif_id: n.notif_id });
  }
  const unpaidCount = orders.filter((o) => !o.paid && o.status === STATUS.PENDING).length;
  if (unpaidCount) todo.push({ urgency: 2, kind: 'unpaid', title: `${unpaidCount} 張訂單待收款`, body: `未收款 ${ntw(unpaid)}`, link: '#/orders?status=待確認' });
  const toShip = orders.filter((o) => o.status === STATUS.ARRIVED).length;
  if (toShip) todo.push({ urgency: 3, kind: 'to_ship', title: `${toShip} 張訂單待出貨`, body: '可列印標籤後掃碼核對', link: '#/packing' });
  if (uncostedRevenue > 0) todo.push({ urgency: 4, kind: 'uncosted', title: '尚有品項未登錄成本', body: `對應營收 ${ntw(uncostedRevenue)} 未計入毛利`, link: '#/board' });
  todo.sort((a, b) => a.urgency - b.urgency);

  const data = {
    batch,
    fx_rate: await money.currentFxRate(),
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

post('/api/v1/notifications/read', async ({ actor, body }) => {
  auth.requireCap(actor, 'order.read');
  await db.run('UPDATE notifications SET read_at = ? WHERE notif_id = ?', now(), body.notif_id);
  return ok({ notif_id: body.notif_id });
});

// F-23 匯率管理
get('/api/v1/settings/fx', async ({ actor }) => {
  auth.requireCap(actor, 'order.read');
  return ok({
    fx_jpy_twd: await money.currentFxRate(),
    history: await db.all('SELECT * FROM fx_history ORDER BY changed_at DESC LIMIT 50'),
  });
});

post('/api/v1/settings/fx', async ({ actor, body }) => {
  auth.requireCap(actor, 'settings.write');
  const rate = Number(body.fx_jpy_twd);
  if (!Number.isFinite(rate) || rate <= 0) throw err('BAD_RATE', '匯率必須是大於 0 的數字');
  const previous = await money.currentFxRate();
  await db.putSetting('fx_jpy_twd', rate);
  await db.run('INSERT INTO fx_history (fx_id, rate, changed_by, changed_at) VALUES (?,?,?,?)', uid('fx'), rate, actor.line_user_id, now());
  await audit.record({ actor: actor.line_user_id, action: 'settings.fx', detail: { from: previous, to: rate }, result: 'ok' });
  // Existing procurements keep their snapshot; only new writes use the new rate.
  return ok({ fx_jpy_twd: rate, previous });
});

get('/api/v1/settings/batches', async ({ actor }) => {
  auth.requireCap(actor, 'order.read');
  return ok({ current_batch: await db.setting('current_batch'), batches: await db.all('SELECT * FROM batches ORDER BY batch DESC') });
});

post('/api/v1/settings/batch', async ({ actor, body }) => {
  auth.requireCap(actor, 'settings.write');
  const batch = await db.one('SELECT batch FROM batches WHERE batch = ?', body.batch);
  if (!batch) throw err('BATCH_NOT_FOUND', '查無此團', 404);
  await db.putSetting('current_batch', body.batch);
  await audit.record({ actor: actor.line_user_id, action: 'settings.batch', detail: { batch: body.batch }, result: 'ok' });
  return ok({ current_batch: body.batch });
});

// ---- 店家與結算設定 -------------------------------------------------------
/**
 * These rows live in `settings` and are deliberately absent from the seed
 * migration: this repository is public and a real collection account does not
 * belong in it. This page is where the owner fills them in, and the only place
 * they can be changed.
 */
const SHOP_FIELDS = [
  { key: 'shop_name',             label: '店名',           type: 'text',   max: 40, required: true,
    hint: '出現在對帳單與客人通知上' },
  { key: 'bank_name',             label: '銀行名稱',        type: 'text',   max: 20, required: true,
    hint: '例：華南銀行' },
  { key: 'bank_code',             label: '銀行代碼',        type: 'digits', len: 3,  required: true,
    hint: '三碼數字' },
  { key: 'bank_account',          label: '收款帳號',        type: 'digits', minLen: 5, maxLen: 16, required: true,
    hint: '只有店主看得到，不會寫進稽核紀錄' },
  { key: 'payment_deadline_days', label: '付款期限（天）',   type: 'int',    lo: 1, hi: 30, required: true,
    hint: '客人收到對帳單後幾天內要完成付款' },
  { key: 'statement_days',        label: '對帳單結算日',     type: 'days',   required: true,
    hint: '每月的哪幾天結算，逗號分隔，例：1,16' },
  { key: 'bulky_add_min',         label: '大型品加價下限',   type: 'int',    lo: 0, hi: 9999,
    hint: '盒裝或大型物品的加價區間（台幣）' },
  { key: 'bulky_add_max',         label: '大型品加價上限',   type: 'int',    lo: 0, hi: 9999,
    hint: '' },
  { key: 'ship_fee_cvs',          label: '運費：超商取貨',   type: 'int',    lo: 0, hi: 9999,
    hint: '台幣。留空＝暫定 70 元；客人結帳頁與實際收費都照這裡' },
  { key: 'ship_fee_home',         label: '運費：宅配到府',   type: 'int',    lo: 0, hi: 9999,
    hint: '台幣。留空＝暫定 120 元' },
];

/** Normalise one field for storage, or throw a 400 the owner can act on. */
function shopValue(field, raw) {
  const v = String(raw ?? '').trim();
  if (!v) {
    if (field.required) throw err('BAD_SETTING', `${field.label}不能空白`);
    return '';
  }
  if (field.type === 'digits') {
    if (!/^[0-9]+$/.test(v)) throw err('BAD_SETTING', `${field.label}只能填數字`);
    if (field.len && v.length !== field.len) throw err('BAD_SETTING', `${field.label}必須是 ${field.len} 碼`);
    if (field.minLen && v.length < field.minLen) throw err('BAD_SETTING', `${field.label}至少 ${field.minLen} 碼`);
    if (field.maxLen && v.length > field.maxLen) throw err('BAD_SETTING', `${field.label}最多 ${field.maxLen} 碼`);
    return v;
  }
  if (field.type === 'int') {
    const n = Number(v);
    if (!Number.isInteger(n) || n < field.lo || n > field.hi) {
      throw err('BAD_SETTING', `${field.label}必須是 ${field.lo}–${field.hi} 的整數`);
    }
    return String(n);
  }
  if (field.type === 'days') {
    const days = [...new Set(v.split(/[,，\s]+/).filter(Boolean).map(Number))];
    if (!days.length || days.some((d) => !Number.isInteger(d) || d < 1 || d > 28)) {
      throw err('BAD_SETTING', `${field.label}請填 1–28 之間的日期，逗號分隔（例：1,16）`);
    }
    return days.sort((a, b) => a - b).join(',');
  }
  if (field.max && v.length > field.max) throw err('BAD_SETTING', `${field.label}最多 ${field.max} 個字`);
  return v;
}

async function readShop() {
  const values = {};
  for (const f of SHOP_FIELDS) values[f.key] = (await db.setting(f.key, '')) || '';
  return values;
}
const shopMissing = (values) => SHOP_FIELDS.filter((f) => f.required && !values[f.key]).map((f) => f.label);

// 收款帳號只有店主看得到 —— 讀寫都要 settings.write
get('/api/v1/settings/shop', async ({ actor }) => {
  auth.requireCap(actor, 'settings.write');
  const values = await readShop();
  return ok({ values, missing: shopMissing(values), fields: SHOP_FIELDS });
});

post('/api/v1/settings/shop', async ({ actor, body }) => {
  auth.requireCap(actor, 'settings.write');
  const incoming = SHOP_FIELDS.filter((f) => body[f.key] !== undefined);
  if (!incoming.length) throw err('NO_CHANGE', '沒有要更新的欄位');

  // Validate everything first: a bad field must not leave half the settings written.
  const next = {};
  for (const f of incoming) next[f.key] = shopValue(f, body[f.key]);

  // The surcharge range has to hold against whatever the other half already is.
  const current = await readShop();
  const lo = next.bulky_add_min ?? current.bulky_add_min;
  const hi = next.bulky_add_max ?? current.bulky_add_max;
  if (lo !== '' && hi !== '' && Number(lo) > Number(hi)) {
    throw err('BAD_SETTING', '大型品加價下限不可高於上限');
  }

  await db.tx(async () => {
    for (const f of incoming) await db.putSetting(f.key, next[f.key]);
  });
  // detail records which keys changed, never their values — the collection
  // account must not be copied into audit_log.
  await audit.record({ actor: actor.line_user_id, action: 'settings.shop',
    detail: { keys: incoming.map((f) => f.key) }, result: 'ok' });

  const values = await readShop();
  return ok({ updated: incoming.map((f) => f.key), values, missing: shopMissing(values) });
});

get('/api/v1/products/list', async ({ actor, query }) => {
  auth.requireCap(actor, 'order.read');
  const rows = query.batch
    ? await db.all('SELECT * FROM products WHERE batch = ? ORDER BY sku', query.batch)
    : await db.all('SELECT * FROM products ORDER BY sku');
  return ok(auth.redact(actor, rows));
});

get('/api/v1/members/list', async ({ actor }) => {
  auth.requireCap(actor, 'order.read');
  return ok(await db.all('SELECT line_user_id, nickname, display_name, role, bound_at FROM members ORDER BY role, nickname'));
});

// 健檢要知道「哪幾個必填欄位還空著」，但不能碰值 —— 只借欄位定義出去。
module.exports = { SHOP_FIELDS };
