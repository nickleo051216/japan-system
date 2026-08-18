'use strict';
const fs = require('node:fs');
const path = require('node:path');
const db = require('../lib/db');
const { get, post, ok } = require('../lib/http');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const { STATUS, transition } = require('../lib/state');
const { uid, now } = require('../lib/ids');
const money = require('../lib/money');
const config = require('../lib/config');

const err = (code, message, status = 400) => Object.assign(new Error(message), { code, status });

const UPLOAD_DIR = path.join(path.dirname(config.dbPath), 'uploads');

function notifyOwner({ kind, title, body, target }) {
  db.run('INSERT INTO notifications (notif_id, audience, kind, title, body, target, created_at) VALUES (?,?,?,?,?,?,?)',
    uid('ntf'), 'owner', kind, title, body || null, target || null, now());
}

/**
 * Aggregate every 待採購 / 部分到貨 order in the batch into one row per sku.
 * Claims are never touched here — re-aggregating must not drop a claim.
 */
function syncBoard(batch) {
  const demand = db.all(
    `SELECT oi.sku, SUM(oi.qty) AS need_qty
       FROM order_items oi JOIN orders o ON o.order_id = oi.order_id
      WHERE o.batch = ? AND o.status IN (?, ?)
      GROUP BY oi.sku`, batch, STATUS.AWAITING_PURCHASE, STATUS.PARTIALLY_ARRIVED);
  for (const d of demand) {
    const existing = db.one('SELECT * FROM procurements WHERE batch = ? AND sku = ?', batch, d.sku);
    if (!existing) {
      db.run('INSERT INTO procurements (proc_id, batch, sku, need_qty, state, updated_at) VALUES (?,?,?,?,?,?)',
        uid('prc'), batch, d.sku, d.need_qty, 'open', now());
    } else if (existing.need_qty !== d.need_qty) {
      db.run('UPDATE procurements SET need_qty = ?, updated_at = ? WHERE proc_id = ?', d.need_qty, now(), existing.proc_id);
    }
  }
}

function boardRows(batch, actor) {
  syncBoard(batch);
  const rows = db.all(
    `SELECT pr.*, p.name_zh, p.name_local, p.brand, p.image_url, p.price_twd, p.est_cost_jpy,
            m.nickname AS claimed_by_nickname
       FROM procurements pr
       JOIN products p ON p.sku = pr.sku
       LEFT JOIN members m ON m.line_user_id = pr.claimed_by
      WHERE pr.batch = ?`, batch);

  const enriched = rows.map((r) => {
    const cost = money.weightedCost(r.proc_id);
    const buyers = db.all(
      `SELECT m.nickname, oi.qty FROM order_items oi
         JOIN orders o ON o.order_id = oi.order_id
         JOIN members m ON m.line_user_id = o.line_user_id
        WHERE o.batch = ? AND oi.sku = ? AND o.status IN (?, ?)`, batch, r.sku, STATUS.AWAITING_PURCHASE, STATUS.PARTIALLY_ARRIVED);
    return {
      ...r,
      amount_edited: !!r.amount_edited,
      claimed_by_me: !!actor && r.claimed_by === actor.line_user_id,
      buyers,
      unit_cost_jpy: cost ? cost.unit_cost_jpy : null,
      unit_cost_twd: cost ? cost.unit_cost_twd : null,
      margin_pct: cost ? money.margin(r.price_twd, cost.unit_cost_twd) : null,
      receipts: cost ? cost.receipts : 0,
    };
  });

  // F-08: unclaimed first, then larger demand first.
  enriched.sort((a, b) => (a.claimed_by ? 1 : 0) - (b.claimed_by ? 1 : 0) || b.need_qty - a.need_qty);
  return enriched;
}

// F-08 現場採購看板
get('/api/v1/procurement/board', ({ actor, query }) => {
  auth.requireCap(actor, 'procurement.read');
  const batch = query.batch || db.setting('current_batch');
  return ok(auth.redact(actor, { batch, rows: boardRows(batch, actor) }));
});

/**
 * F-08 認領 — conditional update. This is the whole point of the mechanism:
 * the write only lands when claimed_by is still NULL, so a concurrent second
 * claim changes zero rows and loses. Google Sheets cannot express this, which
 * is why F-08 depends on I-01.
 */
post('/api/v1/procurement/claim', ({ actor, body }) => {
  auth.requireCap(actor, 'procurement.write');
  return db.tx(() => {
    const res = db.run(
      'UPDATE procurements SET claimed_by = ?, claimed_at = ?, state = ?, updated_at = ? WHERE proc_id = ? AND claimed_by IS NULL',
      actor.line_user_id, now(), 'claimed', now(), body.proc_id);
    if (Number(res.changes) === 0) {
      const row = db.one(`SELECT pr.claimed_by, m.nickname FROM procurements pr LEFT JOIN members m ON m.line_user_id = pr.claimed_by WHERE pr.proc_id = ?`, body.proc_id);
      if (!row) throw err('PROC_NOT_FOUND', '查無此採購項目', 404);
      audit.record({ actor: actor.line_user_id, action: 'procurement.claim', target: body.proc_id, detail: { holder: row.claimed_by }, result: 'blocked' });
      throw err('ALREADY_CLAIMED', `已被 ${row.nickname || '其他人'} 認領`, 409);
    }
    audit.record({ actor: actor.line_user_id, action: 'procurement.claim', target: body.proc_id, result: 'ok' });
    return ok({ proc_id: body.proc_id, claimed_by: actor.line_user_id });
  });
});

post('/api/v1/procurement/release', ({ actor, body }) => {
  auth.requireCap(actor, 'procurement.write');
  const res = db.run(
    'UPDATE procurements SET claimed_by = NULL, claimed_at = NULL, state = ?, updated_at = ? WHERE proc_id = ? AND claimed_by = ? AND state = ?',
    'open', now(), body.proc_id, actor.line_user_id, 'claimed');
  if (Number(res.changes) === 0) throw err('NOT_CLAIMER', '只有認領者本人可以放掉，且已回報結果的項目不可放掉', 409);
  audit.record({ actor: actor.line_user_id, action: 'procurement.release', target: body.proc_id, result: 'ok' });
  return ok({ proc_id: body.proc_id });
});

// F-08 採購結果回報
post('/api/v1/procurement/result', ({ actor, body }) => {
  auth.requireCap(actor, 'procurement.write');
  const proc = db.one('SELECT * FROM procurements WHERE proc_id = ?', body.proc_id);
  if (!proc) throw err('PROC_NOT_FOUND', '查無此採購項目', 404);
  if (proc.claimed_by && proc.claimed_by !== actor.line_user_id && actor.role !== 'owner') {
    throw err('NOT_CLAIMER', '這項由其他人認領，無法回報', 409);
  }
  const got = Math.max(0, Number(body.got_qty ?? 0));
  let state;
  if (got === 0) state = 'out_of_stock';
  else if (got >= proc.need_qty) { state = 'got'; }
  else state = 'partial';
  // F-08 例外 2: reporting ≥ need must be recorded as 買足, not partial.
  const gotQty = state === 'got' ? proc.need_qty : got;

  db.run('UPDATE procurements SET got_qty = ?, state = ?, claimed_by = COALESCE(claimed_by, ?), updated_at = ? WHERE proc_id = ?',
    gotQty, state, actor.line_user_id, now(), proc.proc_id);

  const product = db.one('SELECT name_zh FROM products WHERE sku = ?', proc.sku);
  if (state !== 'got') {
    notifyOwner({
      kind: state, target: proc.proc_id,
      title: state === 'partial' ? `部分買到：${product.name_zh}` : `買不到：${product.name_zh}`,
      body: `需求 ${proc.need_qty} 件，實際 ${gotQty} 件，需要決策（補買 / 改品 / 退款）`,
    });
  }
  audit.record({ actor: actor.line_user_id, action: 'procurement.result', target: proc.proc_id, detail: { state, got_qty: gotQty }, result: state === 'got' ? 'ok' : 'warn' });
  refreshOrderProgress(proc.batch, actor.line_user_id);
  return ok({ proc_id: proc.proc_id, state, got_qty: gotQty });
});

/** Push order status forward as procurement completes (§2.3). */
function refreshOrderProgress(batch, actorId) {
  const orders = db.all('SELECT order_id, status FROM orders WHERE batch = ? AND status IN (?, ?)', batch, STATUS.AWAITING_PURCHASE, STATUS.PARTIALLY_ARRIVED);
  for (const o of orders) {
    const rows = db.all(
      `SELECT pr.state FROM order_items oi LEFT JOIN procurements pr ON pr.sku = oi.sku AND pr.batch = ?
        WHERE oi.order_id = ?`, batch, o.order_id);
    if (!rows.length) continue;
    const done = rows.every((r) => r.state === 'got');
    const anyDone = rows.some((r) => r.state === 'got');
    if (done && o.status !== STATUS.AWAITING_SHIPMENT) {
      transition(o.order_id, STATUS.AWAITING_SHIPMENT, { actor: actorId, reason: '全部採購完成' });
    } else if (!done && anyDone && o.status === STATUS.AWAITING_PURCHASE) {
      transition(o.order_id, STATUS.PARTIALLY_ARRIVED, { actor: actorId, reason: '部分品項採購完成' });
    }
  }
}

/**
 * F-07 收據 OCR — STUB.
 * Production sends the image to GPT-4o Vision with a prompt narrowed to
 * "return the amount only". The flow around it is the real deliverable:
 * the helper picks the product FIRST, so OCR only ever reads one number, and
 * the number ALWAYS needs human confirmation before it is written.
 */
post('/api/v1/procurement/ocr', ({ actor, body }) => {
  auth.requireCap(actor, 'procurement.write');
  const proc = db.one('SELECT pr.*, p.est_cost_jpy FROM procurements pr JOIN products p ON p.sku = pr.sku WHERE pr.proc_id = ?', body.proc_id);
  if (!proc) throw err('PROC_NOT_FOUND', '查無此採購項目', 404);

  let receiptUrl = null;
  if (body.image_data_url) {
    const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(body.image_data_url);
    if (!m) throw err('BAD_IMAGE', '圖片格式無法辨識');
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const ext = m[1].split('/')[1].replace('jpeg', 'jpg');
    const name = `${uid('rcp')}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), Buffer.from(m[2], 'base64'));
    receiptUrl = `/uploads/${name}`;
  }

  // Deterministic pseudo-reading so the demo is reproducible.
  const base = proc.est_cost_jpy || 1000;
  const jitter = (proc.proc_id.split('').reduce((s, c) => s + c.charCodeAt(0), 0) % 11) - 5;
  const amount = Math.max(1, Math.round((base * (1 + jitter / 100)) / 10) * 10);

  return ok({
    proc_id: proc.proc_id,
    receipt_url: receiptUrl,
    amount_jpy: amount,
    confidence: 0.82,
    source: 'stub',                 // 正式版為 GPT-4o Vision
    requires_confirmation: true,    // F-07 處理 3：必須等待人工確認
    note: '雛型未接 OCR，此金額為模擬值，請以收據實際金額為準。',
  });
});

// F-07 小幫手拍照請款 — writes cost with an fx snapshot.
post('/api/v1/procurement/expense', ({ actor, body }) => {
  auth.requireCap(actor, 'procurement.write');   // 非 helper/owner 不得寫入成本
  const proc = db.one('SELECT pr.*, p.price_twd, p.name_zh FROM procurements pr JOIN products p ON p.sku = pr.sku WHERE pr.proc_id = ?', body.proc_id);
  if (!proc) throw err('PROC_NOT_FOUND', '查無此採購項目', 404);

  const unitCost = Number(body.unit_cost_jpy);
  if (!Number.isFinite(unitCost) || unitCost <= 0) throw err('BAD_AMOUNT', '金額必須是大於 0 的數字');
  const qty = Math.max(1, Number(body.qty || proc.got_qty || proc.need_qty));
  const fx = money.currentFxRate();               // F-23 snapshot at write time

  db.run('INSERT INTO expenses (expense_id, proc_id, qty, unit_cost_jpy, fx_rate, receipt_url, amount_edited, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    uid('exp'), proc.proc_id, qty, unitCost, fx, body.receipt_url || null, body.amount_edited ? 1 : 0, actor.line_user_id, now());

  const agg = money.weightedCost(proc.proc_id);
  db.run('UPDATE procurements SET unit_cost_jpy = ?, fx_rate = ?, receipt_url = COALESCE(?, receipt_url), amount_edited = MAX(amount_edited, ?), updated_at = ? WHERE proc_id = ?',
    agg.unit_cost_jpy, fx, body.receipt_url || null, body.amount_edited ? 1 : 0, now(), proc.proc_id);
  db.run('UPDATE products SET actual_cost_jpy = ? WHERE sku = ?', agg.unit_cost_jpy, proc.sku);

  const marginPct = money.margin(proc.price_twd, agg.unit_cost_twd);
  audit.record({ actor: actor.line_user_id, action: 'procurement.expense', target: proc.proc_id,
    detail: { unit_cost_jpy: unitCost, fx, qty, amount_edited: !!body.amount_edited }, result: 'ok' });

  const result = {
    proc_id: proc.proc_id,
    name_zh: proc.name_zh,
    qty,
    unit_cost_jpy: agg.unit_cost_jpy,
    fx_rate: fx,
    unit_cost_twd: agg.unit_cost_twd,
    price_twd: proc.price_twd,
    margin_pct: marginPct,
    receipts: agg.receipts,
    low_margin: marginPct != null && marginPct < money.LOW_MARGIN_THRESHOLD,
  };
  return ok(auth.redact(actor, result));
});

get('/api/v1/procurement/expenses', ({ actor, query }) => {
  auth.requireCap(actor, 'order.read.cost');
  return ok(db.all(
    `SELECT e.*, pr.sku, p.name_zh FROM expenses e JOIN procurements pr ON pr.proc_id = e.proc_id
       JOIN products p ON p.sku = pr.sku ${query.proc_id ? 'WHERE e.proc_id = ?' : ''} ORDER BY e.created_at DESC LIMIT 200`,
    ...(query.proc_id ? [query.proc_id] : [])));
});

module.exports = { syncBoard, boardRows, notifyOwner, refreshOrderProgress };
