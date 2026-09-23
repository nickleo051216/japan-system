'use strict';
/**
 * 買家 API —— BUYER_API_CONTRACT.md 的 26 個端點。
 *
 * 這是 LIFF 前台與後端之間的唯一邊界。形狀以合約為準，合約要改先改文件。
 *
 * 三條貫穿全檔的規則：
 *
 * 1. **身分一律從 token 解，前台傳來的 line_user_id 一律不採信。**
 *    每一次查詢都帶 `line_user_id = actor`，所以換個 id 也查不到別人的東西。
 *
 * 2. **售價由後端算。** 前台送日幣税込，後端查 price_table 級距換台幣。
 *    前台送來的 price_twd 一律忽略 —— 那是客人改得動的東西。
 *
 * 3. **數量的帳在資料庫裡算。** 喊單走 DB 的 shout()（列鎖＋原子扣量），
 *    程式端不做「讀→算→寫」，否則兩個人同時喊最後一個就會超賣。
 */
const db = require('../lib/db');
const price = require('../lib/price');
const shipfee = require('../lib/shipfee');
const { currentBatch } = require('../lib/batch');
const { get, post, ok } = require('../lib/http');
const { now, uid } = require('../lib/ids');

const err = (code, message, status = 400) => Object.assign(new Error(message), { code, status });

// 身分已經在 app.js 的管線解好了（session token 或 LINE ID Token 都一樣）。
// 這層只是把它取個順手的名字，讓底下每支端點讀起來像在講「這位客人」。
const bget = (p, h) => get(p, (ctx) => h({ ...ctx, me: ctx.actor }));
const bpost = (p, h, opts) => post(p, (ctx) => h({ ...ctx, me: ctx.actor }), opts);

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const int = (v) => (v === null || v === undefined || v === '' ? null : parseInt(v, 10));

// ---- 形狀 -----------------------------------------------------------------

// 同一張圖最多辨識幾次。回寫過結果、或次數用完，都算「辨識結束」——
// 否則 AI 認不出來的圖會讓前台永遠停在「辨識中」。
const OCR_MAX_ATTEMPTS = 5;

const cartShape = (r) => ({
  cart_id: r.cart_id, source: r.source, ref: r.ref,
  name: r.name, name_ja: r.name_ja || '',
  jpy_taxed: num(r.jpy_taxed), price_twd: num(r.price_twd), qty: r.qty,
  ai_confidence: r.ai_confidence, status: r.status,
  note: r.note || '', file_name: r.file_name || null, image_url: r.image_url || null,
  created_at: r.created_at,
  // 合約 v1.2 #2：前台每 4 秒輪詢等辨識結果，這個旗標讓它不必自己拼湊判斷式。
  // 非拍照來源一律 true —— 沒有什麼好等的。
  ocr_done: r.source !== 'image' || r.price_twd !== null || r.ai_confidence !== 'low'
    || Number(r.ocr_attempts) >= OCR_MAX_ATTEMPTS,
});

const memberShape = (m) => ({
  // 會員編號是客人看得到、可以報給店家的號碼；line_user_id 只在系統內部用。
  member_no: m.member_no || null,
  line_user_id: m.line_user_id, nickname: m.nickname, display_name: m.display_name,
  status: m.status, role: m.role, phone: m.phone,
  cvs_brand: m.cvs_brand, cvs_store_id: m.cvs_store_id, cvs_store_name: m.cvs_store_name,
  cvs_addr: m.cvs_addr, home_addr: m.home_addr, carrier: m.carrier,
  shout_drops: m.shout_drops, bound_at: m.bound_at, created_at: m.created_at,
});

const statementShape = (s) => ({
  statement_id: s.statement_id, order_ids: s.order_ids || [],
  total_amount: num(s.total_amount), payment_status: s.payment_status, payway: s.payway || null,
  last_five_matched: s.last_five_matched || null, created_at: s.created_at, paid_at: s.paid_at || null,
  invoice_no: s.invoice_no || null, invoice_at: s.invoice_at || null, v_account: s.v_account || null,
});

/** 訂單附品項、狀態紀錄、出貨紀錄。只給這位客人自己的單。 */
async function orderShape(row) {
  const [items, log, shipments] = await Promise.all([
    db.all(`SELECT item_id, name, qty, jpy_taxed, unit_price_twd, item_status, source
              FROM order_items WHERE order_id = ? ORDER BY item_id`, row.order_id),
    db.all(`SELECT to_status, ts FROM order_status_log
              WHERE order_id = ? ORDER BY ts, log_id`, row.order_id),
    db.all(`SELECT shipment_id, carrier, tracking_no, shipped_at, eta
              FROM shipments WHERE order_id = ? ORDER BY shipped_at`, row.order_id),
  ]);
  return {
    order_id: row.order_id, batch: row.batch, status: row.status,
    payment_status: row.payment_status, paid: !!row.paid,
    total_twd: num(row.total_twd), ship_fee_twd: num(row.ship_fee_twd),
    split_shipped: !!row.split_shipped, statement_id: row.statement_id || null,
    pickup: row.pickup || '', pickup_addr: row.pickup_addr || '', invoice: row.invoice || '',
    note: row.note || '', created_at: row.created_at,
    items: items.map((i) => ({
      item_id: i.item_id, name: i.name, qty: i.qty, jpy_taxed: num(i.jpy_taxed),
      unit_price_twd: num(i.unit_price_twd), item_status: i.item_status, source: i.source,
    })),
    status_log: log.map((l) => ({ to_status: l.to_status, ts: l.ts })),
    shipments: shipments.map((s) => ({
      shipment_id: s.shipment_id, carrier: s.carrier, tracking_no: s.tracking_no,
      shipped_at: s.shipped_at, eta: s.eta,
    })),
  };
}

// ---- 1–2 會員 --------------------------------------------------------------

bget('/api/v1/me/profile', async ({ me }) => ok(memberShape(me)));

const ME_FIELDS = ['nickname', 'phone', 'cvs_brand', 'cvs_store_id', 'cvs_store_name',
  'cvs_addr', 'home_addr', 'carrier'];

bpost('/api/v1/me/update', async ({ me, body }) => {
  if (body.nickname !== undefined && !String(body.nickname).trim()) {
    throw err('BAD_NICKNAME', '暱稱不能空白');
  }
  if (body.phone) {
    if (!/^09\d{2}-?\d{3}-?\d{3}$/.test(String(body.phone))) throw err('BAD_PHONE', '手機格式不正確');
  }
  if (body.carrier) {
    if (!/^\/[0-9A-Z.+-]{7}$/.test(String(body.carrier))) throw err('BAD_CARRIER', '載具格式不正確');
  }
  const fields = ME_FIELDS.filter((f) => body[f] !== undefined);
  if (fields.length) {
    const sets = fields.map((f) => `${f} = ?`).join(', ');   // 欄名來自上面的白名單，非使用者輸入
    await db.run(`UPDATE members SET ${sets} WHERE line_user_id = ?`,
      ...fields.map((f) => (body[f] === '' ? null : body[f])), me.line_user_id);
  }
  return ok(memberShape(await db.one('SELECT * FROM members WHERE line_user_id = ?', me.line_user_id)));
});

// ---- 3 首頁 ----------------------------------------------------------------

bget('/api/v1/home/summary', async ({ me }) => {
  const [shopRows, batch, priceTable, broadcast, watch, todo] = await Promise.all([
    db.all('SELECT key, value FROM settings'),
    currentBatch().then((b) => (b ? db.one('SELECT * FROM batches WHERE batch = ?', b) : null)),
    price.table(),
    db.all('SELECT * FROM broadcast ORDER BY created_at DESC'),
    db.all("SELECT item_ref FROM restock_watch WHERE line_user_id = ? AND kind = 'waitlist'", me.line_user_id),
    db.one(`SELECT
        (SELECT count(*) FROM statements WHERE line_user_id = ? AND payment_status <> '已核對') AS unpaid_statements,
        (SELECT count(*) FROM cart_items WHERE line_user_id = ? AND status = 'pending') AS pending_cart`,
      me.line_user_id, me.line_user_id),
  ]);
  const s = Object.fromEntries(shopRows.map((r) => [r.key, r.value]));
  const waitlisted = new Set(watch.map((w) => w.item_ref));
  const t = Date.now();
  return ok({
    shop: {
      name: s.shop_name || '', bank_name: s.bank_name || '', bank_code: s.bank_code || '',
      bank_account: s.bank_account || '',
      bank_holder: s.bank_holder || '',
      // 合約 v1.1 #5：缺值時前台改引導信用卡／ATM，所以直接給一個旗標，
      // 不要逼前台去判斷空字串。
      bank_ready: !!(s.bank_name && s.bank_code && s.bank_account),
      payment_deadline_days: int(s.payment_deadline_days),
      bulky_add_min: int(s.bulky_add_min), bulky_add_max: int(s.bulky_add_max),
      statement_days: s.statement_days || '',
      // 前台結帳頁顯示的運費；跟結帳實際收的同一個來源（lib/shipfee）。
      ship_fee: shipfee.fromSettings(s),
    },
    batch: batch ? {
      batch: batch.batch, name: batch.name, region: batch.region, close_at: batch.close_at,
      buy_at: batch.buy_at, back_at: batch.back_at, ship_at: batch.ship_at, stage: batch.stage,
    } : null,
    price_table: priceTable,
    broadcast: broadcast.map((b) => ({
      send_id: b.send_id, name: b.name, jpy_taxed: num(b.jpy_taxed), price_twd: num(b.price_twd),
      quantity: b.quantity, remaining: b.remaining, deadline_at: b.deadline_at,
      note: b.note || '', image_url: b.image_url || null,
      open: b.remaining > 0 && (!b.deadline_at || new Date(b.deadline_at).getTime() > t),
      waitlisted: waitlisted.has(b.send_id),
    })),
    todo: { unpaid_statements: todo.unpaid_statements, pending_cart: todo.pending_cart },
  });
});

module.exports = { OCR_MAX_ATTEMPTS, cartShape, orderShape, memberShape, statementShape, bget, bpost, err, num, int };
