'use strict';
/**
 * Demo data. Enough to exercise every state in the 實際營運 state machine and
 * every scan-check branch in F-18 without touching LINE, Google or Supabase's
 * production project.
 *
 * Only `npm run reset` writes it. Normal startup never seeds — the database is
 * owned by supabase/migrations and by whatever real data already lives there.
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

/** settings rows this demo owns. 002_seed.sql's rows are reference data and stay. */
const DEMO_SETTINGS = ['current_batch', 'fx_jpy_twd', 'push_quota_remaining'];

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
  ['HB2608-001', 'U_buyer1', STATUS.PENDING, false, [['P04', 2], ['P06', 1]]],
  ['HB2608-002', 'U_buyer2', STATUS.QUOTED,  true,  [['P03', 1], ['P04', 2]]],
  ['HB2608-003', 'U_buyer3', STATUS.QUOTED,  true,  [['P05', 1], ['P06', 2], ['P08', 1]]],
  ['HB2608-004', 'U_buyer1', STATUS.ARRIVED, true,  [['P01', 2], ['P07', 1]]],
  // 已付款但品項還沒買齊 —— 用來示範 F-18 第 6 段黃燈
  ['HB2608-005', 'U_buyer4', STATUS.QUOTED,  true,  [['P02', 1], ['P03', 2]]],
  ['HB2608-006', 'U_buyer2', STATUS.SHIPPED, true,  [['P01', 1]]],
  // 已到貨但未付款 —— 用來示範 F-18 第 5 段黃燈與店主覆寫
  ['HB2608-007', 'U_buyer3', STATUS.ARRIVED, false, [['P01', 1]]],
];

/** procurements.state → order_items.item_status; 'partial' leaves the lines
 *  where they are (see syncItemStatus in routes/procurement.js). */
const ITEM_STATUS_BY_PROC_STATE = {
  open: '待採買', claimed: '採買中', got: '已到貨', out_of_stock: '缺貨',
};

// [sku, need, state, claimed_by, got_qty, unit_cost_jpy|null]
const PROCUREMENTS = [
  ['P01', 4, 'got',          'U_helper1', 4, 960],
  ['P02', 1, 'got',          'U_helper1', 1, 1520],
  ['P03', 3, 'partial',      'U_helper2', 1, 640],
  ['P04', 4, 'open',         null,        0, null],
  ['P05', 1, 'claimed',      'U_helper2', 0, null],
  ['P06', 3, 'open',         null,        0, null],
  ['P07', 1, 'got',          'U_helper1', 1, 1700],
  ['P08', 1, 'out_of_stock', 'U_helper1', 0, null],
];

async function isSeeded() {
  return !!(await db.one('SELECT batch FROM batches WHERE batch = ?', BATCH));
}

/**
 * All of it in one transaction, with app.actor set so the order_status_log
 * rows the database writes on insert carry an author.
 */
async function seed() {
  if (await isSeeded()) return false;
  const ts = now();

  await db.tx(async () => {
    await db.setLocal('app.actor', 'U_owner');
    await db.setLocal('app.reason', '匯入雛型資料');

    await db.run('INSERT INTO batches (batch, name, opened_at) VALUES (?,?,?)', BATCH, '0817 日本團', ts);
    await db.putSetting('current_batch', BATCH);
    await db.putSetting('fx_jpy_twd', config.defaultFxRate);
    await db.putSetting('push_quota_remaining', '200');
    await db.run('INSERT INTO fx_history (fx_id, rate, changed_by, changed_at) VALUES (?,?,?,?)', 'fx_seed', config.defaultFxRate, 'U_owner', ts);

    for (const [id, nick, display, role] of MEMBERS) {
      await db.run('INSERT INTO members (line_user_id, nickname, display_name, phone, bound_at, role) VALUES (?,?,?,?,?,?)',
        id, nick, display, null, ts, role);
    }
    for (const [sku, zh, local, brand, price, est, color] of PRODUCTS) {
      await db.run('INSERT INTO products (sku, name_zh, name_local, brand, price_twd, est_cost_jpy, image_url, batch, stock_limit, reserved) VALUES (?,?,?,?,?,?,?,?,?,?)',
        sku, zh, local, brand, price, est, img(sku, color), BATCH, null, 0);
    }

    let itemSeq = 0;
    for (const [orderId, buyer, status, paid, items] of ORDERS) {
      let total = 0;
      for (const [sku, qty] of items) {
        const p = await db.one('SELECT price_twd FROM products WHERE sku = ?', sku);
        total += p.price_twd * qty;
      }
      // orders.paid is a generated column — payment_status is what gets written.
      await db.run(
        'INSERT INTO orders (order_id, line_user_id, batch, status, payment_status, total_twd, paid_at, parent_order_id, created_at, note) VALUES (?,?,?,?,?,?,?,?,?,?)',
        orderId, buyer, BATCH, status, paid ? '已核對' : '待付款', total, paid ? ts : null, null, ts, null);
      // order_status_log is written by trg_order_status_log; never insert it here.
      for (const [sku, qty] of items) {
        const p = await db.one('SELECT name_zh, price_twd, image_url FROM products WHERE sku = ?', sku);
        await db.run('INSERT INTO order_items (item_id, order_id, sku, name, qty, unit_price_twd, source_image_url) VALUES (?,?,?,?,?,?,?)',
          `itm_seed_${String(++itemSeq).padStart(3, '0')}`, orderId, sku, p.name_zh, qty, p.price_twd, p.image_url);
      }
      if (paid) {
        await db.run('INSERT INTO payments (payment_id, order_id, amount_twd, method, last5, received_at, reconciled_by) VALUES (?,?,?,?,?,?,?)',
          `pay_seed_${orderId}`, orderId, total, 'transfer', '48120', ts, 'U_owner');
      }
    }

    await db.run('INSERT INTO shipments (shipment_id, order_id, shipped_at, verified_by_scan, operator, override_reason) VALUES (?,?,?,?,?,?)',
      'shp_seed_006', 'HB2608-006', ts, true, 'U_packer', null);

    const fx = config.defaultFxRate;
    for (const [sku, need, state, claimedBy, gotQty, cost] of PROCUREMENTS) {
      const procId = `prc_seed_${sku}`;
      await db.run('INSERT INTO procurements (proc_id, batch, sku, need_qty, claimed_by, claimed_at, got_qty, state, unit_cost_jpy, fx_rate, receipt_url, amount_edited, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        procId, BATCH, sku, need, claimedBy, claimedBy ? ts : null, gotQty, state, cost, cost ? fx : null, null, false, ts);
      // Keep the order lines consistent with the procurement they belong to.
      const itemStatus = ITEM_STATUS_BY_PROC_STATE[state];
      if (itemStatus) {
        await db.run(
          `UPDATE order_items SET item_status = ?
            WHERE sku = ? AND order_id IN (SELECT order_id FROM orders WHERE batch = ?)`,
          itemStatus, sku, BATCH);
      }
      if (cost) {
        await db.run('INSERT INTO expenses (expense_id, proc_id, qty, unit_cost_jpy, fx_rate, receipt_url, amount_edited, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
          `exp_seed_${sku}`, procId, gotQty || 1, cost, fx, null, false, claimedBy, ts);
        await db.run('UPDATE products SET actual_cost_jpy = ? WHERE sku = ?', cost, sku);
      }
    }

    // ---- 買家端示範資料（BUYER_API_CONTRACT）----
    // 喊單刻意做出三種狀態：還有量、剩最後幾個、已截止。前台三種 UI 都看得到，
    // 驗收也才驗得到「搶完」與「過期」這兩條不同的錯誤路徑。
    const inAnHour = new Date(Date.now() + 3600_000).toISOString();
    const lastWeek = new Date(Date.now() - 7 * 86400_000).toISOString();
    for (const [id, name, jpy, twd, quantity, remaining, deadline] of [
      ['BC-SEED-001', '麵包超人 造型圍兜 兩件', 1309, 490, 6, 0, lastWeek],
      ['BC-SEED-002', '貝親 母乳實感奶嘴 SS', 649, 250, 12, 3, inAnHour],
      ['BC-SEED-003', '日本製 嬰兒純棉短襪 三入組', 979, 350, 20, 14, inAnHour],
    ]) {
      await db.run(
        'INSERT INTO broadcast (send_id, batch, name, jpy_taxed, price_twd, quantity, remaining, deadline_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        id, BATCH, name, jpy, twd, quantity, remaining, deadline, ts);
    }

    // 兩筆許願：一筆還沒報價（加購物車要被擋），一筆已報價（可以加）。
    await db.run(
      "INSERT INTO wishlist (wish_id, line_user_id, item_name, quantity, wish_status, wished_at) VALUES (?,?,?,?,'待處理',?)",
      'W-SEED-001', 'U_buyer1', '阪急限定 嬰兒襪', 3, ts);
    await db.run(
      "INSERT INTO wishlist (wish_id, line_user_id, item_name, quantity, wish_status, quote_twd, wished_at) VALUES (?,?,?,?,'已報價',?,?)",
      'W-SEED-002', 'U_buyer1', 'EDWIN 牛仔褲', 1, 890, ts);

    // 一張待付款的對帳單，外加一張已核對的 —— 驗收要驗「已付清不能再付」。
    await db.run(
      "INSERT INTO statements (statement_id, line_user_id, total_amount, payment_status, created_at) VALUES (?,?,?,'待付款',?)",
      'STMT-SEED-001', 'U_buyer1', 1940, ts);
    await db.run(
      "INSERT INTO statements (statement_id, line_user_id, total_amount, payment_status, payway, paid_at, created_at) VALUES (?,?,?,'已核對','credit',?,?)",
      'STMT-SEED-002', 'U_buyer1', 760, ts, ts);

    await db.run('INSERT INTO notifications (notif_id, audience, kind, title, body, target, created_at) VALUES (?,?,?,?,?,?,?)',
      'ntf_seed_1', 'owner', 'out_of_stock', '買不到：虎牌保溫瓶 500ml', '需求 1 件，實際 0 件，需要決策（補買 / 改品 / 退款）', 'prc_seed_P08', ts);
    await db.run('INSERT INTO notifications (notif_id, audience, kind, title, body, target, created_at) VALUES (?,?,?,?,?,?,?)',
      'ntf_seed_2', 'owner', 'partial', '部分買到：DHC 護唇膏', '需求 3 件，實際 1 件，需要決策（補買 / 改品 / 退款）', 'prc_seed_P03', ts);
  });
  return true;
}

/**
 * Wipe the demo tables and re-seed. Deletion order follows the foreign keys;
 * price_table and order_status_rules are migration-owned reference data and are
 * never touched, and only the settings keys this file writes are cleared.
 */
const RESET_TABLES = [
  'idempotency', 'notifications', 'fx_history', 'audit_log', 'logistics_bindings',
  'shipments', 'payments', 'expenses', 'procurements', 'restock_watch',
  'cart_items', 'wishlist', 'broadcast', 'order_status_log', 'order_items',
  'orders', 'statements', 'products', 'batches', 'members',
];

async function reset() {
  for (const t of RESET_TABLES) await db.run(`DELETE FROM ${t}`);
  // 示範資料的會員編號每次都從 HB-00001 開始，驗收才對得上號。只有 --reset 會走到這裡。
  await db.run("SELECT setval('member_no_seq', 1, false)");
  await db.run(`DELETE FROM settings WHERE key IN (${DEMO_SETTINGS.map(() => '?').join(',')})`, ...DEMO_SETTINGS);
  return seed();
}

module.exports = { seed, reset, isSeeded, BATCH };
