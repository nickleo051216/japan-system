'use strict';
/**
 * 買家 API —— 結帳、訂單、物流、對帳單（合約端點 18～26）。
 *
 * 這裡有兩條線不能讓前台碰：
 *   金額  —— 售價、運費、總額全由後端算。前台送來的數字一律忽略。
 *   地址  —— 取貨地址從會員資料帶，不從請求讀，否則等於讓人改寄送目的地。
 */
const crypto = require('node:crypto');
const db = require('../lib/db');
const config = require('../lib/config');
const state = require('../lib/state');
const { ok } = require('../lib/http');
const { now, uid, nextOrderId } = require('../lib/ids');
const { orderShape, statementShape, bget, bpost, err, num, int } = require('./buyer');

// 台灣端運費。合約 [待確認] #2 要求改由 settings 讀，所以這裡以 settings 優先，
// 查不到才用合約寫死的數字 —— 業主日後在後台改，不用改程式。
const SHIP_FEE_DEFAULT = { cvs: 70, home: 120 };
async function shipFee(kind) {
  const v = await db.setting(kind === 'home' ? 'ship_fee_home' : 'ship_fee_cvs', '');
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n >= 0 ? n : SHIP_FEE_DEFAULT[kind];
}

async function myOrder(orderId, user) {
  const row = await db.one(
    'SELECT * FROM orders WHERE order_id = ? AND line_user_id = ?', orderId, user);
  if (!row) throw err('ORDER_NOT_FOUND', '找不到這張訂單', 404);
  return row;
}

// ---- 18 結帳 ---------------------------------------------------------------

function invoiceText(inv) {
  const type = String((inv && inv.type) || 'carrier');
  if (type === 'donate') return '捐贈發票';
  if (type === 'tax') {
    const id = String((inv && inv.tax_id) || '');
    if (!/^\d{8}$/.test(id)) throw err('BAD_TAX_ID', '統一編號必須是 8 碼數字');
    return `統編 ${id}`;
  }
  if (type !== 'carrier') throw err('BAD_INVOICE', '發票類型不正確');
  const carrier = String((inv && inv.carrier) || '');
  if (carrier && !/^\/[0-9A-Z.+-]{7}$/.test(carrier)) throw err('BAD_CARRIER', '載具格式不正確');
  return carrier ? `手機載具 ${carrier}` : '手機載具';
}

bpost('/api/v1/orders/checkout', async ({ me, body }) => {
  const ids = Array.isArray(body.cart_ids) ? body.cart_ids.map(String) : [];
  if (!ids.length) throw err('EMPTY_CART', '購物車是空的');

  const pickupType = String((body.pickup && body.pickup.type) || '');
  if (!['cvs', 'home'].includes(pickupType)) throw err('BAD_PICKUP', '請選擇取貨方式');
  const invoice = invoiceText(body.invoice);

  const items = await db.all(
    `SELECT * FROM cart_items WHERE line_user_id = ? AND cart_id = ANY(?::text[])
       AND status IN ('pending','confirmed') ORDER BY created_at, cart_id`,
    me.line_user_id, ids);
  if (!items.length) throw err('CART_NOT_FOUND', '購物車品項已不存在', 404);
  if (items.some((i) => i.status !== 'confirmed')) {
    throw err('NOT_CONFIRMED', '還有品項尚未確認，請先確認後再送出', 409);
  }

  // 取貨地址一律從會員資料帶 —— 前台不傳、也不採信。
  const pickup = pickupType === 'cvs'
    ? [me.cvs_brand, me.cvs_store_name].filter(Boolean).join(' ') || '超商取貨'
    : '宅配到府';
  const pickupAddr = pickupType === 'cvs' ? (me.cvs_addr || '') : (me.home_addr || '');
  const fee = await shipFee(pickupType);
  const subtotal = items.reduce((a, i) => a + (num(i.price_twd) || 0) * i.qty, 0);

  const orderId = await db.tx(async () => {
    const id = await nextOrderId(db);
    const batch = await db.one('SELECT batch FROM batches ORDER BY created_at DESC LIMIT 1');
    await db.run(
      `INSERT INTO orders (order_id, line_user_id, batch, status, payment_status, total_twd,
                           ship_fee_twd, pickup, pickup_addr, invoice, note, created_at)
       VALUES (?,?,?,'待確認','待付款',?,?,?,?,?,?,?)`,
      id, me.line_user_id, batch ? batch.batch : null, subtotal + fee, fee,
      pickup, pickupAddr, invoice, body.note || null, now());
    for (const i of items) {
      await db.run(
        `INSERT INTO order_items (item_id, order_id, name, qty, jpy_taxed, unit_price_twd,
                                  item_status, source, source_image_url)
         VALUES (?,?,?,?,?,?,'待採買',?,?)`,
        uid('IT'), id, i.name, i.qty, num(i.jpy_taxed), num(i.price_twd) || 0,
        i.source, i.image_url || null);
    }
    await db.run(
      "UPDATE cart_items SET status = 'ordered' WHERE cart_id = ANY(?::text[])",
      items.map((i) => i.cart_id));
    return id;
  });
  return ok(await orderShape(await db.one('SELECT * FROM orders WHERE order_id = ?', orderId)));
});

// ---- 19–20 訂單 ------------------------------------------------------------
//
// /orders/list 與 /orders/detail 沒有買家專屬版本，刻意的：它們早就存在，
// 而且早就依角色只回自己的單。再開一支同路徑的只會被路由器忽略，開不同路徑
// 又違背合約。所以改成既有端點在 role='buyer' 時輸出合約形狀 ——
// 見 routes/orders.js。一條路徑、一份權限判斷。

// ---- 21 申請先出貨 ---------------------------------------------------------

bpost('/api/v1/orders/split-request', async ({ me, body }) => {
  const order = await myOrder(String(body.order_id ?? ''), me.line_user_id);
  const on = body.on !== false;
  if (on) {
    // 「部分到貨」在這個系統裡不是訂單狀態，而是品項狀態的組合 ——
    // 有東西到了、但還沒到齊，才談得上先出一部分。
    if (!['已報價', '已到貨'].includes(order.status)) {
      throw err('NOT_SPLITTABLE', '這張訂單目前不能申請先出貨', 409);
    }
    const c = await db.one(
      `SELECT count(*) FILTER (WHERE item_status = '已到貨') AS arrived,
              count(*) FILTER (WHERE item_status <> '已到貨') AS waiting
         FROM order_items WHERE order_id = ?`, order.order_id);
    if (!(c.arrived > 0 && c.waiting > 0)) {
      throw err('NOT_SPLITTABLE', '還沒有部分到貨，暫時不能申請先出貨', 409);
    }
  }
  await db.run('UPDATE orders SET split_shipped = ? WHERE order_id = ?', on, order.order_id);
  return ok(await orderShape(await db.one('SELECT * FROM orders WHERE order_id = ?', order.order_id)));
});

// ---- 22 我已收到 -----------------------------------------------------------

bpost('/api/v1/orders/received', async ({ me, body }) => {
  const order = await myOrder(String(body.order_id ?? ''), me.line_user_id);
  // 合法與否由資料庫的狀態規則判定，程式端不重複一份規則 —— 兩份就會各自漂移。
  await state.transition(order.order_id, state.STATUS.DELIVERED, { actor: me.line_user_id });
  return ok(await orderShape(await db.one('SELECT * FROM orders WHERE order_id = ?', order.order_id)));
});

// ---- 23 物流追蹤 -----------------------------------------------------------

/**
 * 合約 [待確認] #3：貨態來源尚未決定（物流商 API 或人工輸入）。
 * 在那之前，events 由我們確實知道的事實組成 —— 出貨時間與送達時間。
 * 寧可少幾筆，也不要生出一段沒有根據的運送歷程。
 */
bget('/api/v1/shipments/track', async ({ me, query }) => {
  const order = await myOrder(String(query.order_id || ''), me.line_user_id);
  const rows = await db.all(
    'SELECT * FROM shipments WHERE order_id = ? ORDER BY shipped_at', order.order_id);
  const delivered = await db.one(
    "SELECT changed_at FROM order_status_log WHERE order_id = ? AND to_status = '已送達' ORDER BY changed_at DESC LIMIT 1",
    order.order_id);
  return ok(rows.map((s) => {
    const events = [{ ts: s.shipped_at, status: '已出貨', place: s.carrier || '' }];
    if (delivered) events.push({ ts: delivered.changed_at, status: '已送達', place: order.pickup || '' });
    return {
      shipment_id: s.shipment_id, carrier: s.carrier, tracking_no: s.tracking_no,
      shipped_at: s.shipped_at, eta: s.eta, events,
    };
  }));
});

// ---- 24 對帳單 -------------------------------------------------------------

async function myStatement(id, user) {
  const s = await db.one(
    'SELECT * FROM statements WHERE statement_id = ? AND line_user_id = ?', id, user);
  if (!s) throw err('STATEMENT_NOT_FOUND', '找不到這張對帳單', 404);
  return s;
}

bget('/api/v1/statements/list', async ({ me }) => {
  const rows = await db.all(
    'SELECT * FROM statements WHERE line_user_id = ? ORDER BY created_at DESC', me.line_user_id);
  const withOrders = await Promise.all(rows.map(async (s) => {
    const ids = await db.all('SELECT order_id FROM orders WHERE statement_id = ? ORDER BY order_id', s.statement_id);
    return statementShape({ ...s, order_ids: ids.map((o) => o.order_id) });
  }));
  // 未結算 = 已報價以上、還沒被歸進任何對帳單的訂單。
  const unbilled = await db.one(
    `SELECT count(*) AS count, coalesce(sum(total_twd), 0) AS amount FROM orders
      WHERE line_user_id = ? AND statement_id IS NULL
        AND status IN ('已報價','已到貨','已出貨','已送達')`, me.line_user_id);
  return ok({
    statements: withOrders,
    unbilled: { count: unbilled.count, amount: num(unbilled.amount) || 0 },
  });
});

// ---- 25 回報末五碼 ---------------------------------------------------------

bpost('/api/v1/statements/report-transfer', async ({ me, body }) => {
  const s = await myStatement(String(body.statement_id ?? ''), me.line_user_id);
  const last5 = String(body.last5 ?? '');
  if (!/^\d{5}$/.test(last5)) throw err('BAD_LAST5', '請填轉帳帳號末五碼（5 碼數字）');
  if (s.payment_status === '已核對') throw err('ALREADY_PAID', '這張對帳單已經付清了', 409);
  await db.tx(async () => {
    await db.run(
      `UPDATE statements SET payment_status = '待官方確認', payway = 'bank', last_five_matched = ?
        WHERE statement_id = ?`, last5, s.statement_id);
    // 留一筆待核對紀錄，店主在後台對帳時看得到 —— 光改狀態沒有金流軌跡。
    await db.run(
      `INSERT INTO payments (payment_id, statement_id, amount_twd, method, last5, received_at)
       VALUES (?,?,?,'transfer',?,?)`,
      uid('PAY'), s.statement_id, num(s.total_amount), last5, now());
  });
  return ok(statementShape(await db.one('SELECT * FROM statements WHERE statement_id = ?', s.statement_id)));
});

// ---- 26 線上付款 -----------------------------------------------------------

/** 綠界 CheckMacValue。HashKey／HashIV 只在伺服器端，永遠不進回應。 */
function checkMac(params, key, iv) {
  const sorted = Object.keys(params).sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1)
    .map((k) => `${k}=${params[k]}`).join('&');
  const raw = `HashKey=${key}&${sorted}&HashIV=${iv}`;
  const encoded = encodeURIComponent(raw).toLowerCase()
    .replace(/%20/g, '+').replace(/%21/g, '!').replace(/%2a/g, '*')
    .replace(/%28/g, '(').replace(/%29/g, ')').replace(/%27/g, "'");
  return crypto.createHash('sha256').update(encoded).digest('hex').toUpperCase();
}

const ecpayReady = () => !!(config.ecpayMerchantId && config.ecpayHashKey && config.ecpayHashIv);

bpost('/api/v1/statements/pay-init', async ({ me, body }) => {
  const s = await myStatement(String(body.statement_id ?? ''), me.line_user_id);
  const payway = String(body.payway ?? '');
  // 合約 v1.1 #2：第一波綠界只走信用卡與 ATM，LINE Pay 第二波另外串。
  if (!['credit', 'atm'].includes(payway)) throw err('BAD_PAYWAY', '暫時只支援信用卡與 ATM');
  if (s.payment_status === '已核對') throw err('ALREADY_PAID', '這張對帳單已經付清了', 409);

  if (payway === 'atm') {
    // 重複取號要回同一組，否則客人手上會有兩組帳號，入帳對不起來。
    if (s.v_account) {
      return ok({ flow: 'vacc', v_account: s.v_account, v_bank: s.v_bank, v_expire_at: s.v_expire_at });
    }
    // 虛擬帳號要由銀行或金流商配號，我們生不出來。合約 [待確認] #4 未決之前
    // 寧可明講「還沒開通」，也不要發一組不存在的帳號出去。
    throw Object.assign(new Error('ATM 轉帳尚未開通，請改用信用卡或銀行轉帳'),
      { code: 'NOT_CONFIGURED', status: 503 });
  }

  if (!ecpayReady()) {
    throw Object.assign(new Error('線上刷卡尚未開通，請改用銀行轉帳'),
      { code: 'NOT_CONFIGURED', status: 503 });
  }
  const tradeNo = (s.trade_no || `HB${Date.now()}${Math.floor(Math.random() * 1000)}`).slice(0, 20);
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19).replace(/-/g, '/');
  const fields = {
    MerchantID: config.ecpayMerchantId,
    MerchantTradeNo: tradeNo,
    MerchantTradeDate: stamp,
    PaymentType: 'aio',
    TotalAmount: String(Math.round(num(s.total_amount))),
    TradeDesc: 'HEEEHABABY daigou',
    ItemName: `對帳單 ${s.statement_id}`,
    ReturnURL: config.ecpayReturnUrl || '',
    ChoosePayment: 'Credit',
    EncryptType: '1',
    InvoiceMark: 'Y',
  };
  fields.CheckMacValue = checkMac(fields, config.ecpayHashKey, config.ecpayHashIv);
  await db.run('UPDATE statements SET payway = ?, trade_no = ? WHERE statement_id = ?',
    payway, tradeNo, s.statement_id);
  return ok({ flow: 'redirect', action: config.ecpayApiUrl, fields });
});
