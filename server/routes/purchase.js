'use strict';
/**
 * 採買端：掃標籤登記採買・補登漏喊商品（2026-11-25 照周小姐影片 3；020）。
 *
 * 小幫手在店裡拿到一件客人要的東西（客人忘了喊、或在 LINE 私訊說要），現場就登記：
 *   1. 拍條碼／QR（瀏覽器支援就自動讀）或手打貨號 → GET /purchase/lookup?code= 找商品（型錄、喊單）
 *   2. 選客人 → GET /purchase/customers?q=（暱稱或會員編號）→ GET /purchase/orders?member_no= 列他還能加的訂單
 *   3. 選「加進某張訂單」或「新增一筆到購物車」，填款式備註 → POST /purchase/record「確認已採買 1 件」
 * 加進訂單：品項直接是「已到貨」，訂單總額跟著加；已出對帳單或已付款的單不能加（改加購物車）。
 * 新增到購物車：客人在前台確認後才結帳，價錢由他自己看過。
 * 兩種都會 LINE 通知客人（種類 bought）。
 */
const db = require('../lib/db');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const config = require('../lib/config');
const notify = require('../lib/notify');
const storage = require('../lib/storage');
const { get, post, ok } = require('../lib/http');
const { now, uid } = require('../lib/ids');
const { STATUS } = require('../lib/state');
const { err, num } = require('./buyer');

const ntd = (v) => 'NT$' + Math.round(Number(v) || 0).toLocaleString('en-US');
const text = (v, max) => (v === undefined || v === null ? null : String(v).trim().slice(0, max) || null);
const like = (q) => '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';

get('/api/v1/purchase/lookup', async ({ actor, query }) => {
  auth.requireCap(actor, 'procurement.write');
  const code = String(query.code || '').trim().slice(0, 60);
  if (!code) throw err('BAD_CODE', '請掃條碼或輸入貨號');
  const l = like(code);
  const [products, broadcasts] = await Promise.all([
    db.all(`SELECT sku, name_zh, brand, price_twd, image_url FROM products
             WHERE upper(sku) = upper(?) OR name_zh ILIKE ? OR name_local ILIKE ? OR brand ILIKE ? ORDER BY (upper(sku) = upper(?)) DESC, sku LIMIT 10`,
      code, l, l, l, code),
    db.all(`SELECT send_id, name, price_twd, image_url FROM broadcast
             WHERE upper(send_id) = upper(?) OR name ILIKE ? ORDER BY (upper(send_id) = upper(?)) DESC, created_at DESC LIMIT 10`,
      code, l, code),
  ]);
  const matches = [
    ...products.map((p) => ({ key: `sku:${p.sku}`, id: p.sku, name: p.name_zh, brand: p.brand || null, price_twd: num(p.price_twd), image_url: p.image_url || null, source_zh: '型錄' })),
    ...broadcasts.map((b) => ({ key: `bc:${b.send_id}`, id: b.send_id, name: b.name, brand: null, price_twd: num(b.price_twd), image_url: b.image_url || null, source_zh: '喊單' })),
  ];
  return ok({ code, matches: await storage.resolve(matches, 'image_url') });
});

get('/api/v1/purchase/customers', async ({ actor, query }) => {
  auth.requireCap(actor, 'procurement.write');
  const q = String(query.q || '').trim().slice(0, 40);
  if (!q) return ok([]);
  const l = like(q);
  const rows = await db.all(
    `SELECT member_no, nickname, display_name FROM members
      WHERE role = 'buyer' AND (nickname ILIKE ? OR display_name ILIKE ? OR member_no ILIKE ?)
      ORDER BY nickname LIMIT 20`, l, l, l);
  // 不給 LINE userId：小幫手只需要認得人，用會員編號選。
  return ok(rows.map((m) => ({ member_no: m.member_no, nickname: m.nickname, display_name: m.display_name || null })));
});

async function memberOf(memberNo) {
  const m = await db.one("SELECT * FROM members WHERE member_no = ? AND role = 'buyer'", String(memberNo || ''));
  if (!m) throw err('MEMBER_NOT_FOUND', '找不到這位客人（請用會員編號選）', 404);
  return m;
}

/** 這位客人還能加品項的訂單：待確認或已報價、還沒出對帳單、還沒付款。 */
const OPEN_ORDER_SQL = `line_user_id = ? AND status IN ('待確認','已報價') AND statement_id IS NULL AND payment_status = '待付款'`;
// 這段 SQL 也用在 FROM orders o 的查詢：欄位名稱沒有和其他表重複，不加 o. 也不會混淆。

get('/api/v1/purchase/orders', async ({ actor, query }) => {
  auth.requireCap(actor, 'procurement.write');
  const m = await memberOf(query.member_no);
  const rows = await db.all(
    `SELECT o.order_id, o.status, o.total_twd, o.created_at,
            (SELECT count(*) FROM order_items oi WHERE oi.order_id = o.order_id) AS items
       FROM orders o WHERE ${OPEN_ORDER_SQL}
      ORDER BY o.created_at DESC LIMIT 10`, m.line_user_id);
  return ok(auth.redact(actor, rows.map((o) => ({ ...o, total_twd: num(o.total_twd), items: Number(o.items) }))));
});

post('/api/v1/purchase/record', async ({ actor, body }) => {
  auth.requireCap(actor, 'procurement.write');
  const m = await memberOf(body.member_no);
  let item = null;
  if (body.key) {
    const km = /^(sku|bc):(.+)$/.exec(String(body.key));
    if (!km) throw err('BAD_KEY', '商品 key 不正確');
    item = km[1] === 'sku'
      ? await db.one('SELECT sku, name_zh AS name, price_twd, image_url FROM products WHERE sku = ?', km[2])
      : await db.one('SELECT NULL AS sku, name, price_twd, image_url FROM broadcast WHERE send_id = ?', km[2]);
    if (!item) throw err('NOT_FOUND', '找不到這個商品', 404);
  }
  const name = text(body.name, 60) || (item && item.name);
  if (!name) throw err('BAD_NAME', '請填商品名稱（或先掃條碼找商品）');
  const qty = body.qty === undefined ? 1 : Number(body.qty);
  if (!Number.isInteger(qty) || qty < 1 || qty > 20) throw err('BAD_QTY', '數量要是 1～20');
  const priceIn = body.price_twd === undefined || body.price_twd === null || body.price_twd === '' ? null : Number(body.price_twd);
  if (priceIn !== null && !(priceIn > 0 && priceIn < 1000000)) throw err('BAD_PRICE', '台幣售價要大於 0');
  const priceTwd = priceIn ?? (item ? num(item.price_twd) : null);
  const note = text(body.note, 80);
  const code = text(body.code, 60);
  const ref = uid('BUY');
  let target;
  let link;
  await db.tx(async () => {
    if (body.order_id) {
      const o = await db.one(`SELECT * FROM orders WHERE order_id = ? AND ${OPEN_ORDER_SQL} FOR UPDATE`, String(body.order_id), m.line_user_id);
      if (!o) throw err('ORDER_LOCKED', '這張訂單已經出了對帳單、付款或出貨，不能再加。請改成「新增一筆到購物車」', 409);
      if (o.status === STATUS.QUOTED && !(priceTwd > 0)) throw err('BAD_PRICE', '這張訂單已經報價了，請填台幣售價');
      // 不掛 sku：這件已經買到了，掛 sku 會被現場採購看板當成「還要買」再算一次需求。
      await db.run(
        `INSERT INTO order_items (item_id, order_id, sku, name, qty, unit_price_twd, item_status, source, source_image_url)
         VALUES (?,?,NULL,?,?,?,'已到貨','text',?)`,
        uid('IT'), o.order_id, note ? `${name}（${note}）` : name, qty, priceTwd || 0, item ? item.image_url : null);
      if (priceTwd) await db.run('UPDATE orders SET total_twd = total_twd + ? WHERE order_id = ?', priceTwd * qty, o.order_id);
      target = { type: 'order', order_id: o.order_id };
      link = 'orders';
    } else {
      const cartId = uid('C');
      await db.run(
        `INSERT INTO cart_items (cart_id, line_user_id, source, ref, name, price_twd, qty, ai_confidence, status, note, image_url, created_at)
         VALUES (?,?,'text',?,?,?,?,'high','pending',?,?,?)`,
        cartId, m.line_user_id, body.key || code || null, name, priceTwd, qty,
        ['小幫手現場幫你買到了', note].filter(Boolean).join('：'), item ? item.image_url : null, now());
      target = { type: 'cart', cart_id: cartId };
      link = 'cart';
    }
  });
  // 通知放在交易外面：正式庫還沒跑 020 時種類不被接受，排不進去也不能讓登記本身失敗
  // （在交易裡出錯，整個交易會被 Postgres 作廢）。
  const where = target.type === 'order' ? `已加進你的訂單 ${target.order_id}` : '已放進你的購物車，請到購物車確認';
  const msg = `🛍️ 小幫手幫你買到了\n\n「${name}」${note ? `（${note}）` : ''}×${qty}${priceTwd ? `　${ntd(priceTwd * qty)}` : ''}\n${where}。\n\n`
    + `有問題直接回覆這則訊息 🙌\n${config.buyerLiffUrl}?path=${link}`;
  let notified = false;
  try {
    notified = await notify.queue({ kind: 'bought', lineUserId: m.line_user_id, payload: { ref, ...target, name, qty, text: msg } });
    if (notified) notify.poke();
  } catch (e) {
    console.warn('[purchase] 通知沒排進佇列（不影響登記）：', e.code || '', e.message);
  }
  await audit.record({ actor: actor.line_user_id, action: 'purchase.record', target: target.order_id || target.cart_id,
    detail: { name, qty, price_twd: priceTwd, to: target.type, member_no: m.member_no, code }, result: 'ok' });
  return ok({ ref, ...target, name, qty, price_twd: priceTwd, notified, member: { member_no: m.member_no, nickname: m.nickname } });
});
