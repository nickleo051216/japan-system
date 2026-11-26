'use strict';
/**
 * 後台「客人購物車」（2026-11-26，周小姐實測回饋：客人上傳的拍照下單、按的 +1 都只在客人的購物車裡，
 * 結帳前後台完全看不到，她以為「後台沒有同步」）。
 *
 *   GET  /carts/admin-list?only=photo|all&q=   客人還沒結帳的品項（拍照下單、喊單 +1、文字下單、許願）
 *   POST /carts/quote                          替拍照下單填品名、報價 → LINE 通知客人到購物車確認
 *
 * 店家報價後：信心改成 high（之後 AI 的結果不會蓋掉店家填的）、不再送 AI 辨識、狀態回到「待確認」——
 * 客人確認了才算數，跟客人自己填一樣要按確認才能結帳。
 * 價格：填日幣就照價目表換算；超出級距或談好的價錢直接填台幣。
 */
const db = require('../lib/db');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const price = require('../lib/price');
const notify = require('../lib/notify');
const storage = require('../lib/storage');
const { link } = require('../lib/customer-notify');
const { get, post, ok } = require('../lib/http');
const { cartShape, err, num, OCR_MAX_ATTEMPTS } = require('./buyer');

const SOURCE_ZH = { image: '拍照下單', broadcast: '喊單 +1', text: '文字下單', wish: '許願', reorder: '再買一次' };
const ntd = (v) => 'NT$' + Math.round(Number(v) || 0).toLocaleString('en-US');

get('/api/v1/carts/admin-list', async ({ actor, query }) => {
  auth.requireCap(actor, 'order.read');
  const onlyPhoto = query.only === 'photo';
  const q = String(query.q || '').trim().slice(0, 40);
  const like = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
  const rows = await db.all(
    `SELECT c.*, m.nickname, m.member_no FROM cart_items c JOIN members m ON m.line_user_id = c.line_user_id
      WHERE c.status IN ('pending','confirmed') AND c.created_at > now() - interval '60 days'
        ${onlyPhoto ? "AND c.source = 'image'" : ''}
        ${q ? 'AND (c.name ILIKE ? OR m.nickname ILIKE ? OR m.member_no ILIKE ?)' : ''}
      ORDER BY (c.source = 'image' AND c.price_twd IS NULL) DESC, c.created_at DESC LIMIT 300`,
    ...(q ? [like, like, like] : []));
  const shaped = rows.map((r) => {
    const s = cartShape(r);
    return { ...s, source_zh: SOURCE_ZH[r.source] || r.source, nickname: r.nickname, member_no: r.member_no || null,
      needs_quote: r.source === 'image' && r.price_twd === null && s.ocr_status !== 'pending' };
  });
  const out = await storage.resolve(shaped, 'image_url');
  return ok(auth.redact(actor, {
    items: out,
    needs_quote: out.filter((i) => i.needs_quote).length,
    customers: new Set(out.map((i) => i.member_no || i.nickname)).size,
  }));
});

post('/api/v1/carts/quote', async ({ actor, body }) => {
  auth.requireCap(actor, 'order.write');
  const c = await db.one('SELECT * FROM cart_items WHERE cart_id = ?', String(body.cart_id ?? ''));
  if (!c) throw err('CART_NOT_FOUND', '找不到這個品項', 404);
  if (!['pending', 'confirmed'].includes(c.status)) throw err('NOT_EDITABLE', '客人已經結帳或移除了這個品項', 409);
  if (c.source !== 'image') throw err('NOT_PHOTO', '只有拍照下單可以在這裡報價（其他品項的價格是喊單或許願定的）', 409);
  const name = String(body.name ?? '').trim().slice(0, 80);
  if (!name) throw err('BAD_NAME', '請填品名，客人才知道是什麼');
  const jpy = num(body.jpy_taxed);
  if (jpy !== null && !(Number.isInteger(jpy) && jpy > 0 && jpy <= 10_000_000)) throw err('BAD_JPY', '日幣含稅價要是正整數');
  let twd = num(body.price_twd);
  if (twd !== null && !(Number.isInteger(twd) && twd > 0 && twd <= 1_000_000)) throw err('BAD_PRICE', '台幣售價要是正整數');
  if (twd === null && jpy !== null) twd = await price.twdOf(jpy);
  if (!(twd > 0)) throw err('BAD_PRICE', jpy !== null ? '超出價目表級距，請直接填台幣售價' : '請填日幣含稅價或台幣售價');
  const first = c.price_twd === null;
  await db.run(
    `UPDATE cart_items SET name = ?, jpy_taxed = ?, price_twd = ?, ai_confidence = 'high', status = 'pending',
            ocr_attempts = GREATEST(ocr_attempts, ?), note = ? WHERE cart_id = ?`,
    name, jpy, twd, OCR_MAX_ATTEMPTS, '店家報價：請確認後結帳', c.cart_id);
  await audit.record({ actor: actor.line_user_id, action: 'cart.quote', target: c.cart_id,
    detail: { name, jpy_taxed: jpy, price_twd: twd, from_price: num(c.price_twd), customer: c.line_user_id }, result: 'ok' });
  // 第一次報價才通知（改價不重複發）。通知失敗不影響報價。
  if (first) {
    const text = `💰 你拍照下單的商品，店家報價了\n\n「${name}」×${c.qty}　${ntd(twd * c.qty)}\n`
      + `請到購物車確認，確認後就能結帳 🙏\n\n查看購物車 👉\n${link('cart')}`;
    try {
      if (await notify.queue({ kind: 'quoted', lineUserId: c.line_user_id, payload: { cart_id: c.cart_id, path: 'cart', price_twd: twd, text } })) notify.poke();
    } catch (e) { console.warn('[carts] 報價通知沒排進佇列（不影響報價）：', e.code || '', e.message); }
  }
  const fresh = await db.one('SELECT c.*, m.nickname, m.member_no FROM cart_items c JOIN members m ON m.line_user_id = c.line_user_id WHERE c.cart_id = ?', c.cart_id);
  return ok({ ...cartShape(fresh), nickname: fresh.nickname, member_no: fresh.member_no || null, notified: first });
});

module.exports = {};
