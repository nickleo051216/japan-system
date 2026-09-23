'use strict';
/**
 * 買家 API —— 購物車、喊單、許願（合約端點 4～17）。
 *
 * 喊單是這裡唯一真正困難的部分：同一件限量商品，二十個人在同一秒按下去，
 * 不能賣掉二十一個。所以扣量完全交給資料庫的 shout()（列鎖＋原子扣量），
 * 程式端只負責把結果包成合約的形狀。任何「先讀 remaining 再減」的寫法都是錯的。
 */
const db = require('../lib/db');
const price = require('../lib/price');
const storage = require('../lib/storage');
const { ok, post } = require('../lib/http');
const notify = require('../lib/notify');
const { now, uid } = require('../lib/ids');
const { cartShape, bget, bpost, err, num } = require('./buyer');

// 合約 v1.2 #4：末八碼放寬為 [0-9a-z]，原本只收十六進位會把示範帳號擋掉。
const IMAGE_NAME = /^ocr_temp_[0-9a-z]{8}_\d{15}\.(jpg|png|webp|heic)$/i;
const DATA_URL = /^data:(image\/[a-z+]+);base64,(.+)$/i;
// Vercel 單一請求本體上限 4.5 MB，base64 又會膨脹約 1.33 倍。
// 超過這個大小的圖在到達這裡之前就會被 Vercel 擋掉 —— 前台要先壓縮再傳。
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

/** 把一批購物車品項的圖片參照換成可顯示的短效網址。 */
const shapeAll = async (rows) => storage.resolve(rows.map(cartShape), 'image_url');
const shapeOne = async (row) => (await shapeAll([row]))[0];

const qtyOf = (v, fallback = 1) => {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 999) throw err('BAD_QTY', '數量請填 1–999 的整數');
  return n;
};

/** 只回這位客人自己的購物車列，查不到一律 404，不透露是否存在於別人名下。 */
async function mine(cartId, user) {
  const row = await db.one(
    "SELECT * FROM cart_items WHERE cart_id = ? AND line_user_id = ? AND status IN ('pending','confirmed')",
    cartId, user);
  if (!row) throw err('CART_NOT_FOUND', '找不到這個品項', 404);
  return row;
}

// ---- 4 購物車列表 ----------------------------------------------------------

bget('/api/v1/cart/list', async ({ me }) => ok(await shapeAll(
  await db.all(
    `SELECT * FROM cart_items WHERE line_user_id = ? AND status IN ('pending','confirmed')
      ORDER BY created_at, cart_id`, me.line_user_id))));

// ---- 5 文字下單 ------------------------------------------------------------

bpost('/api/v1/cart/add-text', async ({ me, body }) => {
  const name = String(body.name ?? '').trim();
  if (!name) throw err('BAD_NAME', '品名不能空白');
  const qty = qtyOf(body.qty);
  const jpy = body.jpy_taxed === undefined || body.jpy_taxed === null || body.jpy_taxed === ''
    ? null : Number(body.jpy_taxed);
  if (jpy !== null && (!Number.isFinite(jpy) || jpy <= 0)) throw err('BAD_QTY', '日幣金額不正確');
  const source = body.source === 'reorder' ? 'reorder' : 'text';
  const cartId = uid('C');
  await db.run(
    `INSERT INTO cart_items (cart_id, line_user_id, source, name, jpy_taxed, price_twd, qty,
                             ai_confidence, status, note, created_at)
     VALUES (?,?,?,?,?,?,?,'high','pending',?,?)`,
    cartId, me.line_user_id, source, name, jpy, await price.twdOf(jpy), qty,
    body.note || null, now());
  return ok(cartShape(await db.one('SELECT * FROM cart_items WHERE cart_id = ?', cartId)));
});

// ---- 6 拍照下單 ------------------------------------------------------------

/**
 * 只負責把圖收下來、先回一筆「待辨識」的品項。辨識由 n8n 做，完成後回寫。
 * 先回是刻意的：辨識要好幾秒，而 Vercel 單次請求上限 15 秒，客人也不該對著
 * 轉圈等。前台輪詢 /cart/list，price_twd 有值就代表報好價了。
 */
bpost('/api/v1/cart/add-image', async ({ me, body }) => {
  const fileName = String(body.file_name ?? '');
  if (!IMAGE_NAME.test(fileName)) {
    throw err('BAD_FILE_NAME', '圖片檔名不符規則，請從 LINE 內重新拍照上傳');
  }
  const m = DATA_URL.exec(String(body.data ?? ''));
  let imageUrl = null;
  if (m) {
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > MAX_IMAGE_BYTES) throw err('BAD_IMAGE', '圖片太大，請重新拍一張');
    try {
      // 依客人分資料夾。檔名已通過上面的白名單比對，不含路徑分隔字元。
      imageUrl = await storage.put(`cart/${me.line_user_id}/${fileName}`, buf, m[1]);
    } catch (e) {
      // 圖存不下來就不建品項 —— 沒有圖的拍照品項永遠辨識不了，只會卡在「辨識中」。
      // 回 5xx 讓前台自動重試；重試帶同一把 Idempotency-Key，不會多出一筆。
      console.error('[buyer] 圖片上傳失敗：', e.message);
      throw Object.assign(new Error('照片上傳失敗，請再試一次'), { code: 'UPLOAD_FAILED', status: 503 });
    }
  }
  const cartId = uid('C');
  await db.run(
    `INSERT INTO cart_items (cart_id, line_user_id, source, ref, name, jpy_taxed, price_twd, qty,
                             ai_confidence, status, file_name, image_url, note, created_at)
     VALUES (?,?,'image',?,?,NULL,NULL,?,'low','pending',?,?,?,?)`,
    cartId, me.line_user_id, fileName, String(body.orig_name || '辨識中的品項'),
    qtyOf(body.qty), fileName, imageUrl, 'AI 辨識中，完成後自動更新', now());
  return ok(await shapeOne(await db.one('SELECT * FROM cart_items WHERE cart_id = ?', cartId)));
});

// ---- 7 確認品項 ------------------------------------------------------------

bpost('/api/v1/cart/confirm', async ({ me, body }) => {
  const ids = Array.isArray(body.cart_ids) ? body.cart_ids.map(String) : [];
  if (!ids.length) return ok({ confirmed: [] });
  const res = await db.run(
    `UPDATE cart_items SET status = 'confirmed'
      WHERE line_user_id = ? AND status = 'pending' AND cart_id = ANY(?::text[])
      RETURNING cart_id`, me.line_user_id, ids);
  return ok({ confirmed: res.rows.map((r) => r.cart_id) });
});

// ---- 8 修改品項 ------------------------------------------------------------

bpost('/api/v1/cart/update', async ({ me, body }) => {
  const row = await mine(String(body.cart_id ?? ''), me.line_user_id);
  if (row.source === 'broadcast') {
    throw err('NOT_EDITABLE', '喊單品項不能修改內容，如不需要請直接移除', 409);
  }
  const name = body.name !== undefined ? String(body.name).trim() : row.name;
  if (!name) throw err('BAD_NAME', '品名不能空白');
  const jpy = body.jpy_taxed !== undefined
    ? (body.jpy_taxed === null || body.jpy_taxed === '' ? null : Number(body.jpy_taxed))
    : num(row.jpy_taxed);
  if (jpy !== null && (!Number.isFinite(jpy) || jpy <= 0)) throw err('BAD_QTY', '日幣金額不正確');
  const qty = body.qty !== undefined ? qtyOf(body.qty) : row.qty;
  // 客人親手改過的品項，就不再是 AI 猜的了 —— 信心提到 high、狀態直接確認。
  await db.run(
    `UPDATE cart_items SET name = ?, jpy_taxed = ?, price_twd = ?, qty = ?, note = ?,
                           ai_confidence = 'high', status = 'confirmed'
      WHERE cart_id = ?`,
    name, jpy, await price.twdOf(jpy), qty,
    body.note !== undefined ? body.note : row.note, row.cart_id);
  return ok(cartShape(await db.one('SELECT * FROM cart_items WHERE cart_id = ?', row.cart_id)));
});

// ---- 9 改數量 --------------------------------------------------------------

bpost('/api/v1/cart/set-qty', async ({ me, body }) => {
  const row = await mine(String(body.cart_id ?? ''), me.line_user_id);
  const qty = qtyOf(body.qty);
  const delta = qty - row.qty;
  if (delta === 0) return ok(cartShape(row));

  await db.tx(async () => {
    if (row.source === 'broadcast' && row.ref) {
      // 條件式 UPDATE 就是鎖：餘量不夠時這句改不到任何列，不會有讀寫之間的空窗。
      const sql = delta > 0
        ? 'UPDATE broadcast SET remaining = remaining - ? WHERE send_id = ? AND remaining >= ?'
        : 'UPDATE broadcast SET remaining = remaining + ? WHERE send_id = ?';
      const args = delta > 0 ? [delta, row.ref, delta] : [-delta, row.ref];
      const res = await db.run(sql, ...args);
      if (res.changes === 0) throw err('SOLD_OUT', '剩餘數量不足', 409);
    }
    await db.run('UPDATE cart_items SET qty = ? WHERE cart_id = ?', qty, row.cart_id);
  });
  return ok(cartShape(await db.one('SELECT * FROM cart_items WHERE cart_id = ?', row.cart_id)));
});

// ---- 10 移除品項 -----------------------------------------------------------

bpost('/api/v1/cart/remove', async ({ me, body }) => {
  const row = await mine(String(body.cart_id ?? ''), me.line_user_id);
  let drops = me.shout_drops;
  await db.tx(async () => {
    if (row.source === 'broadcast' && row.ref) {
      // 餘量回補與棄單計數必須同一筆交易：只回補不計次，等於讓人無限佔位。
      await db.run('UPDATE broadcast SET remaining = remaining + ? WHERE send_id = ?', row.qty, row.ref);
      const r = await db.run(
        'UPDATE members SET shout_drops = shout_drops + 1 WHERE line_user_id = ? RETURNING shout_drops',
        me.line_user_id);
      drops = r.rows[0].shout_drops;
    }
    await db.run("UPDATE cart_items SET status = 'removed' WHERE cart_id = ?", row.cart_id);
  });
  return ok({ cart_id: row.cart_id, shout_drops: drops });
});

// ---- 11 喊單 ---------------------------------------------------------------

/** shout() 內部用 raise exception 表達業務錯誤，這裡翻成合約的錯誤碼。 */
function mapShoutError(e) {
  if (e && e.code === 'P0002') return err('SUSPENDED', '棄單已達 3 次，暫停喊單資格', 403);
  if (e && e.code === 'P0001') {
    if (/NOT_FOUND/.test(e.message || '')) return err('NOT_FOUND', '找不到這個喊單', 404);
    if (/BAD_QTY/.test(e.message || '')) return err('BAD_QTY', '數量不正確');
  }
  return e;
}

/**
 * 同一會員對同一喊單只留一筆（合約 §11）。shout() 每次都插新列，所以扣完量
 * 之後在同一筆交易裡併起來。併的是這位客人自己的列，數量總帳仍然由資料庫掌握。
 */
async function mergeRows(user, sendId) {
  const rows = await db.all(
    `SELECT cart_id, qty FROM cart_items
      WHERE line_user_id = ? AND source = 'broadcast' AND ref = ? AND status IN ('pending','confirmed')
      ORDER BY created_at, cart_id`, user, sendId);
  if (rows.length <= 1) return rows[0] ? rows[0].cart_id : null;
  const total = rows.reduce((a, r) => a + r.qty, 0);
  await db.run('UPDATE cart_items SET qty = ? WHERE cart_id = ?', total, rows[0].cart_id);
  await db.run('DELETE FROM cart_items WHERE cart_id = ANY(?::text[])',
    rows.slice(1).map((r) => r.cart_id));
  return rows[0].cart_id;
}

bpost('/api/v1/broadcast/shout', async ({ me, body }) => {
  const sendId = String(body.send_id ?? '');
  const qty = qtyOf(body.qty);
  let result, cartId;
  try {
    ({ result, cartId } = await db.tx(async () => {
      const r = await db.one('SELECT granted, remaining FROM shout(?,?,?)', sendId, me.line_user_id, qty);
      const id = r.granted > 0 ? await mergeRows(me.line_user_id, sendId) : null;
      return { result: r, cartId: id };
    }));
  } catch (e) { throw mapShoutError(e); }

  if (result.granted === 0) {
    // shout() 對「過期」和「搶完」都回 granted=0。到這裡才分辨是哪一種 ——
    // 這一讀只用來挑錯誤訊息，不參與任何數量的帳。
    const b = await db.one('SELECT deadline_at, remaining FROM broadcast WHERE send_id = ?', sendId);
    if (b && b.deadline_at && new Date(b.deadline_at).getTime() <= Date.now()) {
      throw err('DEADLINE_PASSED', '這個喊單已經截止了', 409);
    }
    throw err('SOLD_OUT', '已經被搶完了', 409);
  }

  const cart = await db.one('SELECT * FROM cart_items WHERE cart_id = ?', cartId);
  const rank = await db.one(
    `SELECT count(DISTINCT line_user_id) AS n FROM cart_items
      WHERE source = 'broadcast' AND ref = ? AND status IN ('pending','confirmed','ordered')
        AND created_at <= ?`, sendId, cart.created_at);
  return ok({
    granted: result.granted, remaining: result.remaining, rank: rank.n,
    cart_item: cartShape(cart),
  });
});

// ---- 12 候補 ---------------------------------------------------------------

bpost('/api/v1/broadcast/waitlist', async ({ me, body }) => {
  const sendId = String(body.send_id ?? '');
  if (!sendId) throw err('BAD_SRC', '缺少喊單編號');
  if (body.on === false) {
    await db.run(
      "DELETE FROM restock_watch WHERE line_user_id = ? AND item_ref = ? AND kind = 'waitlist'",
      me.line_user_id, sendId);
    return ok({ send_id: sendId, waitlisted: false });
  }
  await db.run(
    `INSERT INTO restock_watch (line_user_id, item_ref, kind, created_at)
     VALUES (?,?,'waitlist',?) ON CONFLICT DO NOTHING`,
    me.line_user_id, sendId, now());
  return ok({ send_id: sendId, waitlisted: true });
});

// ---- 13–17 許願 ------------------------------------------------------------

const wishShape = (w) => ({
  wish_id: w.wish_id, item_name: w.item_name, item_name_ja: w.item_name_ja || null,
  brand: w.brand || null, ref_url: w.ref_url || null, quantity: w.quantity,
  note: w.note || '', wish_status: w.wish_status, quote_twd: num(w.quote_twd),
  picture: w.picture || null, file_name: w.file_name || null, wished_at: w.wished_at,
});

async function myWish(wishId, user) {
  const w = await db.one('SELECT * FROM wishlist WHERE wish_id = ? AND line_user_id = ?', wishId, user);
  if (!w) throw err('NOT_FOUND', '找不到這個許願', 404);
  return w;
}

bget('/api/v1/wishes/list', async ({ me }) => ok(
  (await db.all(
    "SELECT * FROM wishlist WHERE line_user_id = ? AND wish_status <> '已下單' ORDER BY wished_at DESC",
    me.line_user_id)).map(wishShape)));

bpost('/api/v1/wishes/create', async ({ me, body }) => {
  const src = String(body.src ?? '');
  if (!['photo', 'link', 'text'].includes(src)) throw err('BAD_SRC', '請選擇許願方式');
  let name = String(body.item_name ?? '').trim();
  if (src === 'link') {
    if (!/^https?:\/\/.+/i.test(String(body.ref_url ?? ''))) {
      throw err('BAD_URL', '請貼完整的商品連結（要有 https://）');
    }
    if (!name) name = String(body.ref_url);
  } else if (src === 'text') {
    if (!name) throw err('BAD_NAME', '請描述你想要的商品');
  } else {
    if (!body.file_name || !body.data) throw err('BAD_IMAGE', '請附上商品照片');
    if (!name) name = '照片許願';
  }
  const wishId = uid('W');
  await db.run(
    `INSERT INTO wishlist (wish_id, line_user_id, item_name, ref_url, quantity, note,
                           wish_status, file_name, wished_at)
     VALUES (?,?,?,?,?,?,'待處理',?,?)`,
    wishId, me.line_user_id, name, body.ref_url || null,
    Math.max(1, parseInt(body.quantity, 10) || 1), body.note || null,
    body.file_name || null, now());
  return ok(wishShape(await db.one('SELECT * FROM wishlist WHERE wish_id = ?', wishId)));
});

bpost('/api/v1/wishes/to-cart', async ({ me, body }) => {
  const w = await myWish(String(body.wish_id ?? ''), me.line_user_id);
  if (w.wish_status !== '已報價') throw err('NOT_QUOTED', '這個許願還沒報價，請等店家回覆', 409);
  const cartId = uid('C');
  await db.tx(async () => {
    await db.run(
      `INSERT INTO cart_items (cart_id, line_user_id, source, ref, name, jpy_taxed, price_twd, qty,
                               ai_confidence, status, note, created_at)
       VALUES (?,?,'wish',?,?,NULL,?,?,'high','confirmed',?,?)`,
      cartId, me.line_user_id, w.wish_id, w.item_name, num(w.quote_twd), w.quantity,
      w.note || null, now());
    await db.run("UPDATE wishlist SET wish_status = '已下單' WHERE wish_id = ?", w.wish_id);
  });
  return ok({
    wish: wishShape(await db.one('SELECT * FROM wishlist WHERE wish_id = ?', w.wish_id)),
    cart_item: cartShape(await db.one('SELECT * FROM cart_items WHERE cart_id = ?', cartId)),
  });
});

bpost('/api/v1/wishes/keep', async ({ me, body }) => {
  const w = await myWish(String(body.wish_id ?? ''), me.line_user_id);
  await db.run("UPDATE wishlist SET wish_status = '保留下團' WHERE wish_id = ?", w.wish_id);
  return ok(wishShape(await db.one('SELECT * FROM wishlist WHERE wish_id = ?', w.wish_id)));
});

bpost('/api/v1/wishes/remove', async ({ me, body }) => {
  const w = await myWish(String(body.wish_id ?? ''), me.line_user_id);
  if (w.wish_status === '已下單') throw err('NOT_EDITABLE', '已經下單的許願不能刪除', 409);
  await db.run('DELETE FROM wishlist WHERE wish_id = ?', w.wish_id);
  return ok({ wish_id: w.wish_id, removed: true });
});

// ---- n8n 領取待辨識的圖 ----------------------------------------------------
//
// 跟出貨通知佇列同一套模式：一句 UPDATE … FOR UPDATE SKIP LOCKED 同時挑出與蓋章，
// 兩個 n8n 執行不會領到同一張；租約 10 分鐘，逾時沒回寫就回到佇列；
// 同一張圖最多試 5 次，壞圖不會被無限重試。沒有圖的拍照品項不發出去 ——
// 那種品項辨識不了，前台輪詢一分鐘後會請客人自己填。
const OCR_LEASE_MINUTES = 10;
const OCR_MAX_ATTEMPTS = 5;

post('/api/v1/ocr/pending', async ({ body, req }) => {
  notify.requireMachine(req);
  const n = Math.min(Math.max(parseInt(body && body.limit, 10) || 10, 1), 50);
  const res = await db.run(
    `UPDATE cart_items SET ocr_claimed_at = now(), ocr_attempts = ocr_attempts + 1
      WHERE cart_id IN (
        SELECT cart_id FROM cart_items
         WHERE source = 'image' AND ai_confidence = 'low' AND price_twd IS NULL
           AND status = 'pending' AND image_url IS NOT NULL AND ocr_attempts < ?
           AND (ocr_claimed_at IS NULL OR ocr_claimed_at < now() - (? || ' minutes')::interval)
         ORDER BY created_at LIMIT ? FOR UPDATE SKIP LOCKED)
      RETURNING cart_id, line_user_id, file_name, image_url, name, created_at, ocr_attempts`,
    OCR_MAX_ATTEMPTS, String(OCR_LEASE_MINUTES), n);
  // 給 n8n 的是 15 分鐘就失效的簽名網址，不是永久連結。
  const jobs = await storage.resolve(res.rows.map((r) => ({ ...r })), 'image_url');
  return ok({ jobs, count: jobs.length, lease_minutes: OCR_LEASE_MINUTES });
}, { idempotent: false });

// ---- n8n 回寫辨識結果 ------------------------------------------------------
//
// 前台輪詢等的就是這一支。沒有它，拍照下單的品項會永遠停在「辨識中」——
// 輪詢再勤也等不到結果。
//
// 這是機器對機器的介面，身分驗 X-Notify-Token（跟通知佇列同一把），不走會員
// token —— n8n 不是會員。刻意不是冪等路由：同一張圖辨識兩次應該以最後一次為準，
// 而不是回放第一次的答案。
post('/api/v1/ocr/result', async ({ body, req }) => {
  notify.requireMachine(req);
  const cartId = String(body.cart_id ?? '');
  const row = await db.one(
    "SELECT * FROM cart_items WHERE cart_id = ? AND status IN ('pending','confirmed')", cartId);
  if (!row) throw err('CART_NOT_FOUND', '找不到這個品項', 404);
  if (row.source !== 'image') throw err('NOT_EDITABLE', '這個品項不是拍照下單', 409);

  // 客人已經自己改過內容（信心被提到 high）就不要覆蓋 ——
  // 人工判斷永遠贏過 AI，晚到的辨識結果不該把客人剛打的字蓋掉。
  if (row.ai_confidence !== 'low') {
    return ok({ cart_id: cartId, applied: false, reason: '客人已自行確認，不覆蓋' });
  }

  const name = String(body.name ?? '').trim() || row.name;
  const jpy = body.jpy_taxed === undefined || body.jpy_taxed === null || body.jpy_taxed === ''
    ? null : Number(body.jpy_taxed);
  if (jpy !== null && (!Number.isFinite(jpy) || jpy <= 0)) throw err('BAD_QTY', '日幣金額不正確');
  const confidence = ['high', 'medium', 'low'].includes(body.ai_confidence) ? body.ai_confidence : 'medium';

  // 售價一律後端查表換算。n8n 送來的 price_twd 不採信 —— 價格只有一個來源。
  await db.run(
    `UPDATE cart_items SET name = ?, name_ja = ?, jpy_taxed = ?, price_twd = ?,
                           ai_confidence = ?, note = ?
      WHERE cart_id = ?`,
    name, body.name_ja || row.name_ja, jpy, await price.twdOf(jpy), confidence,
    jpy === null ? '無法辨識金額，請自行填寫' : null, cartId);
  return ok({ cart_id: cartId, applied: true,
    cart_item: await shapeOne(await db.one('SELECT * FROM cart_items WHERE cart_id = ?', cartId)) });
}, { idempotent: false });
