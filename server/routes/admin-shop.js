'use strict';
/**
 * 後台「把東西放進店裡」的入口 —— 開團、開喊單、許願報價、訂單報價、對帳單。
 *
 * 買家 API（routes/buyer*.js）是「拿」的那一側。這個檔案是「放」的那一側：
 * 沒有它，前台接上去是一間空的店 —— 首頁沒有團別與喊單、許願永遠待處理、
 * 報價寫不進價格、對帳單永遠是空的。
 *
 * 權限沿用 F-21 能力表：開團＝settings.write、喊單＝broadcast（店主），
 * 報價＝order.write（店主與小幫手），對帳＝payment.reconcile（店主）。
 */
const db = require('../lib/db');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const price = require('../lib/price');
const notify = require('../lib/notify');
const { currentBatch } = require('../lib/batch');
const { STATUS, transition } = require('../lib/state');
const { get, post, ok } = require('../lib/http');
const { now, uid, nextOrderId } = require('../lib/ids');
const { shipFee } = require('../lib/shipfee');

const err = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const round = (n) => Math.round(Number(n) * 100) / 100;

/** 台灣日期的 MMDD / YYYYMMDD —— 編號給人看，要跟業主的日曆對得上。 */
function twDate(d = new Date()) {
  const t = new Date(d.getTime() + 8 * 3600_000).toISOString();
  return { ymd: t.slice(0, 10).replace(/-/g, ''), md: t.slice(5, 10).replace('-', '') };
}


const isoOrNull = (v, label) => {
  if (v === undefined || v === null || v === '') return null;
  const t = new Date(v);
  if (Number.isNaN(t.getTime())) throw err('BAD_TIME', `${label}時間格式不正確`);
  return t.toISOString();
};

// ---- 開團 -----------------------------------------------------------------

post('/api/v1/settings/batch/create', async ({ actor, body }) => {
  auth.requireCap(actor, 'settings.write');
  const batch = String(body.batch ?? '').trim();
  if (!/^[A-Za-z0-9-]{3,20}$/.test(batch)) throw err('BAD_BATCH', '團號請用 3–20 個英數字或連字號，例：T-261015');
  const name = String(body.name ?? '').trim();
  if (!name) throw err('BAD_NAME', '請填團名，例：10/15 大阪採買');
  const res = await db.run(
    `INSERT INTO batches (batch, name, region, close_at, buy_at, back_at, ship_at, stage, opened_at, created_at)
     VALUES (?,?,?,?,?,?,?,0,?,?) ON CONFLICT (batch) DO NOTHING`,
    batch, name, body.region || null, isoOrNull(body.close_at, '截單'),
    body.buy_at || null, body.back_at || null, body.ship_at || null, now(), now());
  if (res.changes === 0) throw err('BATCH_EXISTS', '這個團號已經存在', 409);
  // 新開的團預設就是「目前團別」—— 開團卻還停在舊團，是最容易漏掉的一步。
  if (body.make_current !== false) await db.putSetting('current_batch', batch);
  await audit.record({ actor: actor.line_user_id, action: 'batch.create', target: batch, result: 'ok' });
  return ok(await db.one('SELECT * FROM batches WHERE batch = ?', batch));
});

// ---- 喊單 -----------------------------------------------------------------

const broadcastShape = (b) => ({
  send_id: b.send_id, batch: b.batch, name: b.name, jpy_taxed: num(b.jpy_taxed), price_twd: num(b.price_twd),
  quantity: b.quantity, remaining: b.remaining, sold: b.quantity - b.remaining,
  deadline_at: b.deadline_at, note: b.note || '', image_url: b.image_url || null, created_at: b.created_at,
  open: b.remaining > 0 && (!b.deadline_at || new Date(b.deadline_at).getTime() > Date.now()),
  waitlist: b.waitlist === undefined ? undefined : b.waitlist,
});

get('/api/v1/broadcast/admin-list', async ({ actor, query }) => {
  auth.requireCap(actor, 'broadcast');
  const batch = query.batch || await currentBatch();
  const rows = await db.all(
    `SELECT b.*, (SELECT count(*) FROM restock_watch w
                   WHERE w.item_ref = b.send_id AND w.kind = 'waitlist') AS waitlist
       FROM broadcast b WHERE (?::text IS NULL OR b.batch = ?) ORDER BY b.created_at DESC`, batch, batch);
  return ok({ batch, broadcasts: rows.map(broadcastShape) });
});

post('/api/v1/broadcast/create', async ({ actor, body }) => {
  auth.requireCap(actor, 'broadcast');
  const name = String(body.name ?? '').trim();
  if (!name) throw err('BAD_NAME', '請填品名');
  const quantity = Number(body.quantity);
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 9999) throw err('BAD_QTY', '數量請填 1–9999 的整數');
  const jpy = num(body.jpy_taxed);
  if (jpy !== null && !(jpy > 0)) throw err('BAD_PRICE', '日幣金額不正確');
  // 售價以查表為準；只有超出級距（或大型品加價）才讓店主直接填台幣。
  let twd = num(body.price_twd);
  if (twd === null && jpy !== null) twd = await price.twdOf(jpy);
  if (!(twd > 0)) throw err('BAD_PRICE', jpy !== null ? '超出價目表級距，請直接填台幣售價' : '請填日幣金額或台幣售價');
  const deadline = isoOrNull(body.deadline_at, '截止');
  if (deadline && new Date(deadline).getTime() <= Date.now()) throw err('BAD_TIME', '截止時間要在現在之後');

  const batch = await currentBatch();
  const { md } = twDate();
  // 編號沿用營運習慣 BC-MMDD-NNN。同時開兩張撞號時，主鍵擋下，換下一號重試。
  for (let attempt = 0; attempt < 5; attempt++) {
    const last = await db.one(
      "SELECT send_id FROM broadcast WHERE send_id LIKE ? ORDER BY send_id DESC LIMIT 1", `BC-${md}-%`);
    const seq = (last ? parseInt(last.send_id.split('-')[2], 10) || 0 : 0) + 1 + attempt;
    const sendId = `BC-${md}-${String(seq).padStart(3, '0')}`;
    const res = await db.run(
      `INSERT INTO broadcast (send_id, batch, name, jpy_taxed, price_twd, quantity, remaining, deadline_at, note, image_url, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (send_id) DO NOTHING`,
      sendId, batch, name, jpy, twd, quantity, quantity, deadline, body.note || null, body.image_url || null, now());
    if (res.changes > 0) {
      await audit.record({ actor: actor.line_user_id, action: 'broadcast.create', target: sendId,
        detail: { quantity, price_twd: twd }, result: 'ok' });
      return ok(broadcastShape(await db.one('SELECT * FROM broadcast WHERE send_id = ?', sendId)));
    }
  }
  throw err('BUSY', '同時開單的人太多，請再按一次', 409);
});

/** 提前截止。已被搶走的不受影響，只是之後不能再搶。 */
post('/api/v1/broadcast/close', async ({ actor, body }) => {
  auth.requireCap(actor, 'broadcast');
  const res = await db.run(
    `UPDATE broadcast SET deadline_at = now()
      WHERE send_id = ? AND (deadline_at IS NULL OR deadline_at > now())`, String(body.send_id ?? ''));
  if (res.changes === 0) throw err('NOT_OPEN', '找不到這個喊單，或它已經截止了', 409);
  await audit.record({ actor: actor.line_user_id, action: 'broadcast.close', target: body.send_id, result: 'ok' });
  return ok(broadcastShape(await db.one('SELECT * FROM broadcast WHERE send_id = ?', body.send_id)));
});

/**
 * 加減數量 —— 現場多找到幾件、或少拿到幾件。
 * 跟搶單一樣用條件式 UPDATE：減量時不能扣到已被搶走的那一份。
 */
post('/api/v1/broadcast/adjust', async ({ actor, body }) => {
  auth.requireCap(actor, 'broadcast');
  const delta = Number(body.delta);
  if (!Number.isInteger(delta) || delta === 0) throw err('BAD_QTY', '請填要增加或減少的數量');
  const res = await db.run(
    `UPDATE broadcast SET quantity = quantity + ?, remaining = remaining + ?
      WHERE send_id = ? AND remaining + ? >= 0`, delta, delta, String(body.send_id ?? ''), delta);
  if (res.changes === 0) throw err('SOLD_OUT', '已經被搶走的數量不能扣回來', 409);
  await audit.record({ actor: actor.line_user_id, action: 'broadcast.adjust', target: body.send_id,
    detail: { delta }, result: 'ok' });
  return ok(broadcastShape(await db.one('SELECT * FROM broadcast WHERE send_id = ?', body.send_id)));
});

// ---- 許願報價 -------------------------------------------------------------

const WISH_MARKS = ['待處理', '現場缺貨', '保留下團'];

get('/api/v1/wishes/admin-list', async ({ actor, query }) => {
  auth.requireCap(actor, 'order.read');
  const status = query.status || '待處理';
  const rows = await db.all(
    `SELECT w.*, m.nickname FROM wishlist w JOIN members m ON m.line_user_id = w.line_user_id
      WHERE (? = '全部' OR w.wish_status = ?) ORDER BY w.wished_at`, status, status);
  return ok(auth.redact(actor, rows.map((w) => ({ ...w, quote_twd: num(w.quote_twd) }))));
});

post('/api/v1/wishes/quote', async ({ actor, body }) => {
  auth.requireCap(actor, 'order.write');
  const w = await db.one('SELECT * FROM wishlist WHERE wish_id = ?', String(body.wish_id ?? ''));
  if (!w) throw err('NOT_FOUND', '找不到這個許願', 404);
  if (w.wish_status === '已下單') throw err('NOT_EDITABLE', '客人已經下單了，改價請到訂單報價', 409);
  const jpy = num(body.jpy_taxed);
  let twd = num(body.quote_twd);
  if (twd === null && jpy !== null) twd = await price.twdOf(jpy);
  if (!(twd > 0)) throw err('BAD_PRICE', jpy !== null ? '超出價目表級距，請直接填台幣售價' : '請填日幣金額或台幣售價');
  await db.run(
    `UPDATE wishlist SET wish_status = '已報價', quote_twd = ?,
            item_name = coalesce(?, item_name), item_name_ja = coalesce(?, item_name_ja), brand = coalesce(?, brand)
      WHERE wish_id = ?`,
    twd, body.item_name || null, body.item_name_ja || null, body.brand || null, w.wish_id);
  await audit.record({ actor: actor.line_user_id, action: 'wish.quote', target: w.wish_id,
    detail: { quote_twd: twd }, result: 'ok' });
  return ok(await db.one('SELECT * FROM wishlist WHERE wish_id = ?', w.wish_id));
});

post('/api/v1/wishes/mark', async ({ actor, body }) => {
  auth.requireCap(actor, 'order.write');
  if (!WISH_MARKS.includes(body.status)) throw err('BAD_STATUS', `狀態只能是：${WISH_MARKS.join('、')}`);
  const res = await db.run(
    "UPDATE wishlist SET wish_status = ? WHERE wish_id = ? AND wish_status <> '已下單'",
    body.status, String(body.wish_id ?? ''));
  if (res.changes === 0) throw err('NOT_EDITABLE', '找不到這個許願，或客人已經下單了', 409);
  await audit.record({ actor: actor.line_user_id, action: 'wish.mark', target: body.wish_id,
    detail: { status: body.status }, result: 'ok' });
  return ok(await db.one('SELECT * FROM wishlist WHERE wish_id = ?', body.wish_id));
});

// ---- 訂單報價 -------------------------------------------------------------

/**
 * 文字、拍照下單常常沒有日幣價，結帳時以 0 元計入總額。這支把價格補上、
 * 重算總額，並（預設）把訂單推到「已報價」。
 *
 * 品項價格的來源優先序：店主直接填的台幣 > 日幣查表。直接填台幣是給
 * 超出級距或大型品加價用的；一般情況填日幣，售價跟其他下單方式一致。
 */
post('/api/v1/orders/quote', async ({ actor, body }) => {
  auth.requireCap(actor, 'order.write');
  const order = await db.one('SELECT * FROM orders WHERE order_id = ?', String(body.order_id ?? ''));
  if (!order) throw err('ORDER_NOT_FOUND', '查無此訂單', 404);
  if (![STATUS.PENDING, STATUS.QUOTED].includes(order.status)) {
    throw err('NOT_EDITABLE', `訂單已是「${order.status}」，不能再改價`, 409);
  }
  const edits = Array.isArray(body.items) ? body.items : [];
  const current = await db.all('SELECT * FROM order_items WHERE order_id = ?', order.order_id);
  const byId = new Map(current.map((i) => [i.item_id, i]));

  // 先全部算好再寫，一項填錯不會留下半套價格。
  const planned = [];
  for (const e of edits) {
    const it = byId.get(String(e.item_id ?? ''));
    if (!it) throw err('ITEM_NOT_FOUND', '品項不屬於這張訂單', 404);
    const jpy = e.jpy_taxed !== undefined ? num(e.jpy_taxed) : num(it.jpy_taxed);
    let twd = num(e.unit_price_twd);
    if (twd === null && e.jpy_taxed !== undefined && jpy !== null) {
      twd = await price.twdOf(jpy);
      if (twd === null) throw err('BAD_PRICE', `「${it.name}」超出價目表級距，請直接填台幣售價`);
    }
    if (twd !== null && !(twd > 0)) throw err('BAD_PRICE', `「${it.name}」的售價必須大於 0`);
    planned.push({ it, jpy, twd: twd === null ? num(it.unit_price_twd) : twd, name: e.name ? String(e.name).trim() : null });
  }
  const shipFee = body.ship_fee_twd !== undefined ? num(body.ship_fee_twd) : num(order.ship_fee_twd);
  if (!(shipFee >= 0)) throw err('BAD_PRICE', '運費不正確');

  const advance = body.advance !== false && order.status === STATUS.PENDING;
  await db.tx(async () => {
    for (const p of planned) {
      await db.run('UPDATE order_items SET jpy_taxed = ?, unit_price_twd = ?, name = coalesce(?, name) WHERE item_id = ?',
        p.jpy, p.twd, p.name, p.it.item_id);
    }
    const sum = await db.one('SELECT coalesce(sum(qty * unit_price_twd), 0) AS s FROM order_items WHERE order_id = ?', order.order_id);
    await db.run('UPDATE orders SET total_twd = ?, ship_fee_twd = ? WHERE order_id = ?',
      round(Number(sum.s) + shipFee), shipFee, order.order_id);
    // 推到「已報價」時 state.transition 會再檢查一次沒有 0 元品項。
    if (advance) await transition(order.order_id, STATUS.QUOTED, { actor: actor.line_user_id, reason: '報價' });
  });
  await audit.record({ actor: actor.line_user_id, action: 'order.quote', target: order.order_id,
    detail: { items: planned.map((p) => ({ item_id: p.it.item_id, unit_price_twd: p.twd })), ship_fee_twd: shipFee },
    result: 'ok' });
  const fresh = await db.one('SELECT * FROM orders WHERE order_id = ?', order.order_id);
  return ok({
    order_id: fresh.order_id, status: fresh.status, total_twd: num(fresh.total_twd), ship_fee_twd: num(fresh.ship_fee_twd),
    items: (await db.all('SELECT item_id, name, qty, jpy_taxed, unit_price_twd FROM order_items WHERE order_id = ? ORDER BY item_id', order.order_id))
      .map((i) => ({ ...i, jpy_taxed: num(i.jpy_taxed), unit_price_twd: num(i.unit_price_twd) })),
  });
});

// ---- 對帳單 ---------------------------------------------------------------

/** 店主本人，或排程（n8n 帶機器金鑰）。其他人一律擋。 */
function requireBilling(actor, req) {
  if (actor && auth.can(actor, 'payment.reconcile')) return actor.line_user_id;
  notify.requireMachine(req);
  return 'n8n';
}

get('/api/v1/statements/admin-list', async ({ actor, query }) => {
  auth.requireCap(actor, 'payment.reconcile');
  const rows = await db.all(
    `SELECT s.*, m.nickname, (SELECT count(*) FROM orders o WHERE o.statement_id = s.statement_id) AS order_count
       FROM statements s JOIN members m ON m.line_user_id = s.line_user_id
      WHERE (?::text IS NULL OR s.payment_status = ?) ORDER BY s.created_at DESC LIMIT 500`,
    query.status || null, query.status || null);
  return ok(rows.map((s) => ({ ...s, total_amount: num(s.total_amount) })));
});

/**
 * 結算：把「已報價以上、尚未入帳、還沒付清」的訂單，依客人歸成一張對帳單。
 *
 * 重跑是安全的 —— 已經歸進對帳單的訂單不會再被挑出來。兩個人同時按（或排程
 * 剛好撞上店主手動按）也不會重複開單：交易一開始先拿同一把 advisory lock，
 * 第二個人會等第一個做完，再看到的就是已經結算過的訂單。
 */
post('/api/v1/statements/generate', async ({ actor, body, req }) => {
  const by = requireBilling(actor, req);
  const deadlineDays = parseInt(await db.setting('payment_deadline_days', '2'), 10) || 2;
  const created = await db.tx(async () => {
    await db.one("SELECT pg_advisory_xact_lock(hashtext('statements.generate')) AS locked");
    const orders = await db.all(
      `SELECT order_id, line_user_id, total_twd FROM orders
        WHERE statement_id IS NULL AND payment_status <> '已核對'
          AND status IN ('已報價','已到貨','已出貨','已送達')
          AND (?::text IS NULL OR line_user_id = ?)
        ORDER BY line_user_id, order_id FOR UPDATE`,
      body.line_user_id || null, body.line_user_id || null);
    const byUser = new Map();
    for (const o of orders) {
      if (!byUser.has(o.line_user_id)) byUser.set(o.line_user_id, []);
      byUser.get(o.line_user_id).push(o);
    }
    const { ymd } = twDate();
    const last = await db.one(
      'SELECT statement_id FROM statements WHERE statement_id LIKE ? ORDER BY statement_id DESC LIMIT 1', `STMT-${ymd}-%`);
    let seq = last ? parseInt(last.statement_id.split('-')[2], 10) || 0 : 0;

    const out = [];
    for (const [user, list] of byUser) {
      const statementId = `STMT-${ymd}-${String(++seq).padStart(4, '0')}`;
      const total = round(list.reduce((a, o) => a + Number(o.total_twd), 0));
      await db.run(
        "INSERT INTO statements (statement_id, line_user_id, total_amount, payment_status, created_at) VALUES (?,?,?,'待付款',?)",
        statementId, user, total, now());
      await db.run('UPDATE orders SET statement_id = ? WHERE order_id = ANY(?::text[])',
        statementId, list.map((o) => o.order_id));
      const deadline = new Date(Date.now() + deadlineDays * 86400_000).toISOString();
      await notify.queue({ kind: 'statement', lineUserId: user, statementId,
        payload: { statement_id: statementId, total_amount: total, order_ids: list.map((o) => o.order_id), pay_by: deadline } });
      out.push({ statement_id: statementId, line_user_id: user, total_amount: total, order_count: list.length });
    }
    return out;
  });
  if (created.length) notify.poke();
  await audit.record({ actor: by, action: 'statements.generate', detail: { created: created.length }, result: 'ok' });
  return ok({ created });
}, { idempotent: false });

/**
 * 核帳：確認對帳單的錢真的進來了。對帳單與底下每一張訂單一起標成已核對。
 * 金額對不上時不自動認列（F-06 例外），要店主明確確認差額。
 */
post('/api/v1/statements/reconcile', async ({ actor, body }) => {
  auth.requireCap(actor, 'payment.reconcile');
  const s = await db.one('SELECT * FROM statements WHERE statement_id = ?', String(body.statement_id ?? ''));
  if (!s) throw err('STATEMENT_NOT_FOUND', '找不到這張對帳單', 404);
  if (s.payment_status === '已核對') throw err('ALREADY_PAID', '這張對帳單已經核對過了', 409);
  const amount = Number(body.amount_twd);
  if (!(amount > 0)) throw err('BAD_AMOUNT', '金額必須大於 0');
  const diff = round(amount - Number(s.total_amount));
  if (Math.abs(diff) > 0.01 && !body.accept_difference) {
    throw err('AMOUNT_MISMATCH', `金額與對帳單相差 NT$${diff}，請確認後再認列`, 409);
  }
  await db.tx(async () => {
    await db.run(
      `INSERT INTO payments (payment_id, statement_id, amount_twd, method, last5, received_at, reconciled_by)
       VALUES (?,?,?,?,?,?,?)`,
      uid('pay'), s.statement_id, amount, body.method || 'transfer',
      body.last5 || s.last_five_matched || null, now(), actor.line_user_id);
    await db.run("UPDATE statements SET payment_status = '已核對', paid_at = ? WHERE statement_id = ?", now(), s.statement_id);
    // orders.paid 是生成欄位，寫 payment_status 就好。
    await db.run("UPDATE orders SET payment_status = '已核對', paid_at = ? WHERE statement_id = ?", now(), s.statement_id);
  });
  await audit.record({ actor: actor.line_user_id, action: 'statement.reconcile', target: s.statement_id,
    detail: { amount, diff }, result: diff ? 'warn' : 'ok' });
  return ok({ statement_id: s.statement_id, payment_status: '已核對', difference_twd: diff });
});
// ---- 代客下單 ---------------------------------------------------------------
//
// 客人在 LINE 私訊或電話裡說要買什麼，店家直接在後台替他建單。同類的代購／團購
// 系統幾乎都有這個入口（「代客下單」「批次建單」）：不是每位客人都會自己開前台。
//
// 跟客人自己結帳走同一條路：訂單一律從「待確認」開始、品項從「待採買」開始、
// 台幣售價照價目表換算；店家已經談好價錢的品項才直接填台幣。沒有價錢的品項
// 以 0 元先記著，之後在「訂單報價」補上 —— 狀態機會擋住「還有 0 元品項就報價」。

const MEMBER_NO = /^HB-\d{5,}$/;

/** 用會員編號、稱呼或 LINE 名稱找客人。只回畫面需要的欄位，不回 LINE userId。 */
get('/api/v1/members/lookup', async ({ actor, query }) => {
  auth.requireCap(actor, 'order.write');
  const q = String(query.q || '').trim().slice(0, 40);
  if (!q) return ok([]);
  const like = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
  const rows = await db.all(
    `SELECT member_no, nickname, display_name, role, cvs_brand, cvs_store_name, cvs_addr, home_addr
       FROM members
      WHERE status <> '停用' AND (member_no ILIKE ? OR nickname ILIKE ? OR display_name ILIKE ?)
      ORDER BY created_at DESC LIMIT 10`, like, like, like);
  return ok(rows.map((m) => ({
    member_no: m.member_no, nickname: m.nickname, display_name: m.display_name, role: m.role,
    cvs: [m.cvs_brand, m.cvs_store_name].filter(Boolean).join(' ') || null,
    home_addr: m.home_addr || null,
  })));
});

post('/api/v1/orders/create', async ({ actor, body }) => {
  auth.requireCap(actor, 'order.write');
  const memberNo = String(body.member_no || '').trim().toUpperCase();
  if (!MEMBER_NO.test(memberNo)) throw err('BAD_MEMBER_NO', '請先選擇客人（會員編號）');
  const member = await db.one('SELECT * FROM members WHERE member_no = ?', memberNo);
  if (!member) throw err('MEMBER_NOT_FOUND', `找不到會員編號 ${memberNo}`, 404);
  if (member.status === '停用') throw err('MEMBER_DISABLED', '這位會員已停用', 409);

  const raw = Array.isArray(body.items) ? body.items : [];
  if (!raw.length) throw err('NO_ITEMS', '至少要有一個品項');
  if (raw.length > 50) throw err('TOO_MANY_ITEMS', '一張訂單最多 50 個品項');
  const items = [];
  for (const [i, it] of raw.entries()) {
    const n = i + 1;
    const name = String((it && it.name) || '').trim();
    if (!name || name.length > 80) throw err('BAD_ITEM', `第 ${n} 項：請填品名（80 字以內）`);
    const qty = Number(it.qty ?? 1);
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) throw err('BAD_QTY', `第 ${n} 項：數量要是 1–99 的整數`);
    const jpy = num(it.jpy_taxed);
    if (jpy !== null && (!Number.isInteger(jpy) || jpy < 1 || jpy > 10_000_000)) {
      throw err('BAD_JPY', `第 ${n} 項：日幣含稅價要是正整數`);
    }
    const manual = num(it.price_twd);
    if (manual !== null && (!Number.isInteger(manual) || manual < 0 || manual > 1_000_000)) {
      throw err('BAD_PRICE', `第 ${n} 項：台幣售價要是 0 以上的整數`);
    }
    // 台幣售價：店家直接填的優先（已經跟客人談好的價錢），否則照價目表換算。
    const twd = manual !== null ? manual : (jpy !== null ? await price.twdOf(jpy) : null);
    items.push({ name, qty, jpy, twd, note: String(it.note || '').trim().slice(0, 200) || null });
  }

  const pickupType = String(body.pickup_type || 'cvs');
  if (!['cvs', 'home'].includes(pickupType)) throw err('BAD_PICKUP', '取貨方式只能是超商或宅配');
  const pickup = pickupType === 'cvs'
    ? [member.cvs_brand, member.cvs_store_name].filter(Boolean).join(' ') || '超商取貨'
    : '宅配到府';
  const pickupAddr = pickupType === 'cvs' ? (member.cvs_addr || '') : (member.home_addr || '');
  const fee = await shipFee(pickupType);
  const subtotal = items.reduce((a, i) => a + (i.twd || 0) * i.qty, 0);
  const note = ['代客下單', String(body.note || '').trim().slice(0, 300)].filter(Boolean).join('：');

  const orderId = await db.tx(async () => {
    await db.setLocal('app.actor', actor.line_user_id);
    const id = await nextOrderId(db);
    await db.run(
      `INSERT INTO orders (order_id, line_user_id, batch, status, payment_status, total_twd,
                           ship_fee_twd, pickup, pickup_addr, note, created_at)
       VALUES (?,?,?,'待確認','待付款',?,?,?,?,?,?)`,
      id, member.line_user_id, await currentBatch(), subtotal + fee, fee, pickup, pickupAddr, note, now());
    for (const i of items) {
      await db.run(
        `INSERT INTO order_items (item_id, order_id, name, qty, jpy_taxed, unit_price_twd, item_status, source)
         VALUES (?,?,?,?,?,?,'待採買','text')`,
        uid('IT'), id, i.note ? `${i.name}（${i.note}）` : i.name, i.qty, i.jpy, i.twd || 0);
    }
    return id;
  });

  const unpriced = items.filter((i) => i.twd === null).length;
  await audit.record({ actor: actor.line_user_id, action: 'order.create', target: orderId,
    detail: { line_user_id: member.line_user_id, items: items.length, total_twd: subtotal + fee, unpriced }, result: 'ok' });
  return ok({
    order_id: orderId, member_no: member.member_no, nickname: member.nickname,
    total_twd: subtotal + fee, ship_fee_twd: fee, items: items.length, unpriced,
    next: unpriced ? `還有 ${unpriced} 個品項沒有價錢，請到訂單報價補上` : '訂單已成立，確認後即可報價',
  });
});

