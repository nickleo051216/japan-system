'use strict';
/**
 * Demo data. Enough to exercise every state in §2.3 and every scan-check
 * branch in F-18 without touching LINE, Google or Supabase.
 * Images are inline SVG data URIs so the prototype works offline.
 */
const db = require('./db');
const config = require('./config');
const { now } = require('./ids');
const { STATUS } = require('./state');

const img = (label, bg) =>
  'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="${bg}"/>` +
    `<text x="150" y="160" font-family="sans-serif" font-size="34" fill="#fff" text-anchor="middle">${label}</text></svg>`);

const BATCH = '0817';

const MEMBERS = [
  ['U_owner',  '周方',   '周方 HEEEHABABY', 'owner'],
  ['U_helper1','小美',   'Mei',             'helper'],
  ['U_helper2','阿哲',   'Jhe',             'helper'],
  ['U_packer', '阿包',   'Pack',            'packer'],
  ['U_buyer1', 'Wendy',  'Wendy L.',        'buyer'],
  ['U_buyer2', '小圓',   'Yuan',            'buyer'],
  ['U_buyer3', 'Kiki',   'Kiki C.',         'buyer'],
  ['U_buyer4', '大頭',   'Datou',           'buyer'],
];

const PRODUCTS = [
  ['P01', '抹茶 KitKat 大包', '抹茶キットカット', 'Nestlé',    320, 980,  '#3f7d5a'],
  ['P02', '雪肌精面膜',       '雪肌精マスク',     'KOSE',      450, 1580, '#5b6bbf'],
  ['P03', 'DHC 護唇膏',       'DHC リップ',       'DHC',       180, 620,  '#c2743a'],
  ['P04', 'Sante 眼藥水',     'サンテFX',         'Santen',    260, 780,  '#3c8fa8'],
  ['P05', '扭蛋 盲盒一組',     'ガチャ',           'Bandai',    590, 2000, '#a4508b'],
  ['P06', 'UCC 濾掛咖啡',      'UCC ドリップ',     'UCC',       390, 1280, '#6b4a2f'],
  ['P07', '東京香蕉禮盒',      '東京ばな奈',       'Tokyo Banana', 520, 1680, '#c9a227'],
  ['P08', '虎牌保溫瓶 500ml',  'タイガー水筒',     'Tiger',    1280, 4200, '#4a4a55'],
];

// [order_id, buyer, status, paid, items[[sku, qty]]]
const ORDERS = [
  ['HB2608-001', 'U_buyer1', STATUS.AWAITING_PAYMENT,   0, [['P04', 2], ['P06', 1]]],
  ['HB2608-002', 'U_buyer2', STATUS.AWAITING_PURCHASE,  1, [['P03', 1], ['P04', 2]]],
  ['HB2608-003', 'U_buyer3', STATUS.AWAITING_PURCHASE,  1, [['P05', 1], ['P06', 2], ['P08', 1]]],
  ['HB2608-004', 'U_buyer1', STATUS.AWAITING_SHIPMENT,  1, [['P01', 2], ['P07', 1]]],
  ['HB2608-005', 'U_buyer4', STATUS.PARTIALLY_ARRIVED,  1, [['P02', 1], ['P03', 2]]],
  ['HB2608-006', 'U_buyer2', STATUS.SHIPPED,            1, [['P01', 1]]],
  // 待出貨但未付款 —— 用來示範 F-18 第 5 段黃燈與店主覆寫
  ['HB2608-007', 'U_buyer3', STATUS.AWAITING_SHIPMENT,  0, [['P01', 1]]],
];

// [sku, need, state, claimed_by, got_qty, unit_cost_jpy|null]
const PROCUREMENTS = [
  ['P01', 4, 'got',          'U_helper1', 4, 960],
  ['P02', 1, 'got',          'U_helper1', 1, 1520],
  ['P03', 3, 'partial',      'U_helper2', 1, 640],
  ['P04', 4, 'open',         null,        null, null],
  ['P05', 1, 'claimed',      'U_helper2', null, null],
  ['P06', 3, 'open',         null,        null, null],
  ['P07', 1, 'got',          'U_helper1', 1, 1700],
  ['P08', 1, 'out_of_stock', 'U_helper1', 0, null],
];

function isSeeded() {
  return !!db.one('SELECT batch FROM batches WHERE batch = ?', BATCH);
}

function seed() {
  if (isSeeded()) return false;
  const ts = now();
  db.run('INSERT INTO batches (batch, name, opened_at) VALUES (?,?,?)', BATCH, '0817 日本團', ts);
  db.putSetting('current_batch', BATCH);
  db.putSetting('fx_jpy_twd', config.defaultFxRate);
  db.putSetting('push_quota_remaining', '200');
  db.run('INSERT INTO fx_history (fx_id, rate, changed_by, changed_at) VALUES (?,?,?,?)', 'fx_seed', config.defaultFxRate, 'U_owner', ts);

  for (const [id, nick, display, role] of MEMBERS) {
    db.run('INSERT INTO members (line_user_id, nickname, display_name, phone, bound_at, role) VALUES (?,?,?,?,?,?)',
      id, nick, display, null, ts, role);
  }
  for (const [sku, zh, local, brand, price, est, color] of PRODUCTS) {
    db.run('INSERT INTO products (sku, name_zh, name_local, brand, price_twd, est_cost_jpy, image_url, batch, stock_limit, reserved) VALUES (?,?,?,?,?,?,?,?,?,?)',
      sku, zh, local, brand, price, est, img(sku, color), BATCH, null, 0);
  }

  let itemSeq = 0;
  for (const [orderId, buyer, status, paid, items] of ORDERS) {
    let total = 0;
    for (const [sku, qty] of items) {
      const p = db.one('SELECT price_twd FROM products WHERE sku = ?', sku);
      total += p.price_twd * qty;
    }
    db.run('INSERT INTO orders (order_id, line_user_id, batch, status, total_twd, paid, paid_at, parent_order_id, created_at, note) VALUES (?,?,?,?,?,?,?,?,?,?)',
      orderId, buyer, BATCH, status, total, paid, paid ? ts : null, null, ts, null);
    db.run('INSERT INTO order_status_log (log_id, order_id, from_status, to_status, actor, reason, ts) VALUES (?,?,?,?,?,?,?)',
      `slog_seed_${orderId}`, orderId, null, status, 'U_owner', '匯入雛型資料', ts);
    for (const [sku, qty] of items) {
      const p = db.one('SELECT price_twd, image_url FROM products WHERE sku = ?', sku);
      db.run('INSERT INTO order_items (item_id, order_id, sku, qty, unit_price_twd, source_image_url) VALUES (?,?,?,?,?,?)',
        `itm_seed_${String(++itemSeq).padStart(3, '0')}`, orderId, sku, qty, p.price_twd, p.image_url);
    }
    if (paid) {
      db.run('INSERT INTO payments (payment_id, order_id, amount_twd, method, last5, received_at, reconciled_by) VALUES (?,?,?,?,?,?,?)',
        `pay_seed_${orderId}`, orderId, total, 'transfer', '48120', ts, 'U_owner');
    }
  }

  db.run('INSERT INTO shipments (shipment_id, order_id, shipped_at, verified_by_scan, operator, override_reason) VALUES (?,?,?,?,?,?)',
    'shp_seed_006', 'HB2608-006', ts, 1, 'U_packer', null);

  const fx = config.defaultFxRate;
  for (const [sku, need, state, claimedBy, gotQty, cost] of PROCUREMENTS) {
    const procId = `prc_seed_${sku}`;
    db.run('INSERT INTO procurements (proc_id, batch, sku, need_qty, claimed_by, claimed_at, got_qty, state, unit_cost_jpy, fx_rate, receipt_url, amount_edited, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      procId, BATCH, sku, need, claimedBy, claimedBy ? ts : null, gotQty, state, cost, cost ? fx : null, null, 0, ts);
    if (cost) {
      db.run('INSERT INTO expenses (expense_id, proc_id, qty, unit_cost_jpy, fx_rate, receipt_url, amount_edited, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        `exp_seed_${sku}`, procId, gotQty || 1, cost, fx, null, 0, claimedBy, ts);
      db.run('UPDATE products SET actual_cost_jpy = ? WHERE sku = ?', cost, sku);
    }
  }

  db.run('INSERT INTO notifications (notif_id, audience, kind, title, body, target, created_at) VALUES (?,?,?,?,?,?,?)',
    'ntf_seed_1', 'owner', 'out_of_stock', '買不到：虎牌保溫瓶 500ml', '需求 1 件，實際 0 件，需要決策（補買 / 改品 / 退款）', 'prc_seed_P08', ts);
  db.run('INSERT INTO notifications (notif_id, audience, kind, title, body, target, created_at) VALUES (?,?,?,?,?,?,?)',
    'ntf_seed_2', 'owner', 'partial', '部分買到：DHC 護唇膏', '需求 3 件，實際 1 件，需要決策（補買 / 改品 / 退款）', 'prc_seed_P03', ts);
  return true;
}

function reset() {
  const d = db.get();
  for (const t of ['idempotency', 'notifications', 'fx_history', 'audit_log', 'logistics_bindings', 'shipments',
    'payments', 'expenses', 'procurements', 'order_status_log', 'order_items', 'orders', 'products', 'batches', 'members', 'settings']) {
    d.exec(`DELETE FROM ${t}`);
  }
  return seed();
}

module.exports = { seed, reset, isSeeded, BATCH };
