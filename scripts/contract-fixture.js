'use strict';
/**
 * 合約測試資料 —— 照 scripts/buyer-contract-server.js 的 seed() 一筆一筆搬進真資料庫，
 * 讓前端那份 47 項合約測試能對「真的後端程式＋真的 Postgres」跑。
 *
 * 只有一處刻意與參考實作不同：STMT-20260916-0032 預先配好一組虛擬帳號。
 * 參考實作的 ATM 是當場生一組帳號；真後端不會這樣做 —— 虛擬帳號要由銀行或金流商
 * 配號（合約待確認 #4），沒有來源時回 503，不發出不存在的帳號。預先配號讓測試驗
 * 「重複取號回同一組」這一半；「向銀行取號」那一半仍未開通，驗收報告會另外標註。
 *
 * 絕不可對正式資料庫執行 —— 這些都是假資料。scripts/contract-run.js 只會對本機
 * harness 跑它。
 */
const db = require('../server/lib/db');
const { now } = require('../server/lib/ids');

const BUYER = 'U0000000000000000000000000demo0001';

async function load() {
  const inFiveHours = new Date(Date.now() + 5 * 36e5).toISOString();
  const anHourAgo = new Date(Date.now() - 36e5).toISOString();

  await db.run(
    `INSERT INTO members (line_user_id, nickname, display_name, status, role, phone, cvs_brand, cvs_store_id,
                          cvs_store_name, cvs_addr, home_addr, carrier, shout_drops, bound_at, created_at)
     VALUES (?,?,?,'已綁定','buyer',?,?,?,?,?,?,?,0,?,?)`,
    BUYER, '周周', '周', '0912-345-678', '7-11', '148326', '板橋文化門市', '新北市板橋區文化路188號',
    '新北市板橋區文化路一段188號 5樓', '/AB12+3C', '2026-05-05T14:38:00.000Z', '2026-04-28T00:00:00.000Z');

  for (const [k, v] of [['shop_name', 'HEEEHABABY'], ['bank_name', '華南銀行'], ['bank_code', '008'],
    ['bank_account', '000000000000'], ['payment_deadline_days', '2'], ['bulky_add_min', '30'],
    ['bulky_add_max', '50'], ['statement_days', '1,16']]) await db.putSetting(k, v);

  await db.run(
    `INSERT INTO batches (batch, name, region, close_at, buy_at, back_at, ship_at, stage, created_at)
     VALUES ('T-260913','9/13 大阪採買','大阪・京都・神戶',?,'9/13–9/16','9/22','9/25',1,?),
            ('T-260817','8/17 東京採買','東京',NULL,NULL,NULL,NULL,4,'2026-08-10T00:00:00.000Z')
     ON CONFLICT (batch) DO NOTHING`,
    new Date(Date.now() + 2 * 864e5).toISOString(), now());
  await db.putSetting('current_batch', 'T-260913');

  for (const [id, name, jpy, twd, qty, left, deadline, note] of [
    ['BC-0913-004', '西松屋 六重紗布包巾 限定花色', 1639, 600, 8, 8, inFiveHours, '顏色：米／灰'],
    ['BC-0913-003', '日本製 嬰兒純棉短襪 三入組', 979, 350, 20, 14, inFiveHours, '尺寸：9-15cm'],
    ['BC-0913-002', '貝親 母乳實感奶嘴 SS', 649, 250, 12, 3, inFiveHours, ''],
    ['BC-0913-001', '麵包超人 造型圍兜 兩件', 1309, 490, 6, 0, anHourAgo, '款式：藍／紅'],
  ]) {
    await db.run(
      `INSERT INTO broadcast (send_id, batch, name, jpy_taxed, price_twd, quantity, remaining, deadline_at, note, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`, id, 'T-260913', name, jpy, twd, qty, left, deadline, note, now());
  }

  await db.run(
    `INSERT INTO wishlist (wish_id, line_user_id, item_name, quantity, note, wish_status, quote_twd, wished_at)
     VALUES ('W-104',?,?,2,'藍色那款','已報價',980,'2026-09-05T03:00:00.000Z')`,
    BUYER, '日本限定 麵包超人 溫度感應湯匙');

  await db.run(
    `INSERT INTO statements (statement_id, line_user_id, total_amount, payment_status, payway, last_five_matched,
                             created_at, paid_at, invoice_no, invoice_at)
     VALUES ('STMT-20260901-0031',?,960,'已核對','bank','31007','2026-08-31T18:00:00.000Z','2026-09-01T13:14:00.000Z',
             'AB-12345678','2026-09-01T13:20:00.000Z')`, BUYER);
  await db.run(
    `INSERT INTO statements (statement_id, line_user_id, total_amount, payment_status, v_account, v_bank, v_expire_at, created_at)
     VALUES ('STMT-20260916-0032',?,1940,'待付款','9103520012345678','華南銀行 008',?,'2026-09-15T18:00:00.000Z')`,
    BUYER, new Date(Date.now() + 3 * 864e5).toISOString());

  // 訂單直接以最終狀態寫入：狀態檢查 trigger 只管 UPDATE，INSERT 不受限；
  // 狀態紀錄由 INSERT trigger 自己寫一筆。
  await db.run(
    `INSERT INTO orders (order_id, line_user_id, batch, status, payment_status, total_twd, ship_fee_twd,
                         split_shipped, statement_id, pickup, pickup_addr, invoice, note, created_at)
     VALUES ('ORD-20260901-014',?,'T-260913','已到貨','待付款',1940,70,false,'STMT-20260916-0032',
             '7-11 板橋文化門市','新北市板橋區文化路188號','手機載具 /AB12+3C','','2026-09-01T13:40:00.000Z')`, BUYER);
  for (const [id, name, qty, jpy, twd, st, src] of [
    ['I1', '六重紗布浴巾 90×90 兩入', 1, 2519, 890, '已到貨', 'text'],
    ['I2', '米菓仙貝 7個月起 6袋', 4, 429, 180, '採買中', 'broadcast'],
    ['I3', '泡沫沐浴乳 補充包 400ml', 1, 869, 330, '已到貨', 'image'],
  ]) {
    await db.run(
      `INSERT INTO order_items (item_id, order_id, name, qty, jpy_taxed, unit_price_twd, item_status, source)
       VALUES (?,?,?,?,?,?,?,?)`, id, 'ORD-20260901-014', name, qty, jpy, twd, st, src);
  }
  await db.run(
    `INSERT INTO orders (order_id, line_user_id, batch, status, payment_status, total_twd, ship_fee_twd,
                         split_shipped, statement_id, pickup, pickup_addr, invoice, note, paid_at, created_at)
     VALUES ('ORD-20260828-007',?,'T-260817','已送達','已核對',960,70,false,'STMT-20260901-0031',
             '宅配到府','新北市板橋區文化路一段188號 5樓','手機載具 /AB12+3C','','2026-09-01T13:14:00.000Z',
             '2026-08-28T06:02:00.000Z')`, BUYER);
  await db.run(
    `INSERT INTO order_items (item_id, order_id, name, qty, jpy_taxed, unit_price_twd, item_status, source)
     VALUES ('I4','ORD-20260828-007','Combi 自然吸韻電動吸乳器',1,2519,890,'已到貨','text')`);
  await db.run(
    `INSERT INTO shipments (shipment_id, order_id, shipped_at, verified_by_scan, carrier, tracking_no, eta)
     VALUES ('SH1','ORD-20260828-007','2026-08-30T08:40:00.000Z',true,'tcat','4512-8890-2231','09/02 已簽收')`);
}

module.exports = { load, BUYER };
