'use strict';
/**
 * Buyer API — contract reference server (in-memory).
 *
 * This is NOT the production backend. It exists so the LIFF front-end can be
 * built and tested against the exact contract (BUYER_API_CONTRACT.md) before
 * japan-system implements it. Conventions follow japan-system I-02:
 *   path     /api/v1/{resource}/{action}      (GET reads, POST writes)
 *   response { ok, data, error: { code, message } }
 *   writes   Idempotency-Key header honoured
 *   auth     Authorization: Bearer <LIFF ID token>  (here: any token = test user)
 *
 * Run:  node scripts/buyer-contract-server.js [port]
 */
const http = require('node:http');
const crypto = require('node:crypto');

const PRICE_TABLE = [[429,180],[539,220],[649,250],[869,330],[979,350],[1089,400],[1309,490],[1419,530],[1639,600],[1969,700],[2519,890]];
const twdOf = (j) => { for (const [max, t] of PRICE_TABLE) if (j <= max) return t; return null; };
const now = () => new Date().toISOString();
const id = (p) => `${p}-${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;

function seed() {
  const U = 'U0000000000000000000000000demo0001';
  return {
    me: { line_user_id: U, nickname: '周周', display_name: '周', status: '已綁定', role: 'buyer',
          phone: '0912-345-678', cvs_brand: '7-11', cvs_store_id: '148326', cvs_store_name: '板橋文化門市',
          cvs_addr: '新北市板橋區文化路188號', home_addr: '新北市板橋區文化路一段188號 5樓',
          carrier: '/AB12+3C', shout_drops: 0, bound_at: '2026-05-05T14:38:00.000Z', created_at: '2026-04-28T00:00:00.000Z' },
    shop: { name: 'HEEEHABABY', bank_name: '華南銀行', bank_code: '008', bank_account: '000000000000',
            payment_deadline_days: 2, bulky_add_min: 30, bulky_add_max: 50, statement_days: [1, 16] },
    batch: { batch: 'T-260913', name: '9/13 大阪採買', region: '大阪・京都・神戶',
             close_at: new Date(Date.now() + 2 * 864e5).toISOString(),
             buy_at: '9/13–9/16', back_at: '9/22', ship_at: '9/25', stage: 1 },
    broadcast: [
      { send_id: 'BC-0913-004', name: '西松屋 六重紗布包巾 限定花色', jpy_taxed: 1639, price_twd: 600, quantity: 8, remaining: 8,
        deadline_at: new Date(Date.now() + 5 * 36e5).toISOString(), note: '顏色：米／灰', image_url: null },
      { send_id: 'BC-0913-003', name: '日本製 嬰兒純棉短襪 三入組', jpy_taxed: 979, price_twd: 350, quantity: 20, remaining: 14,
        deadline_at: new Date(Date.now() + 5 * 36e5).toISOString(), note: '尺寸：9-15cm', image_url: null },
      { send_id: 'BC-0913-002', name: '貝親 母乳實感奶嘴 SS', jpy_taxed: 649, price_twd: 250, quantity: 12, remaining: 3,
        deadline_at: new Date(Date.now() + 5 * 36e5).toISOString(), note: '', image_url: null },
      { send_id: 'BC-0913-001', name: '麵包超人 造型圍兜 兩件', jpy_taxed: 1309, price_twd: 490, quantity: 6, remaining: 0,
        deadline_at: new Date(Date.now() - 36e5).toISOString(), note: '款式：藍／紅', image_url: null },
    ],
    cart: [],
    waitlist: new Set(),
    wishes: [
      { wish_id: 'W-104', item_name: '日本限定 麵包超人 溫度感應湯匙', item_name_ja: '', brand: '', ref_url: '',
        quantity: 2, note: '藍色那款', wish_status: '已報價', quote_twd: 980, picture: null, file_name: null, wished_at: '2026-09-05T03:00:00.000Z' },
    ],
    orders: [
      { order_id: 'ORD-20260901-014', batch: 'T-260913', status: '已到貨', payment_status: '待付款', paid: false,
        total_twd: 1940, ship_fee_twd: 70, split_shipped: false, statement_id: null,
        pickup: '7-11 板橋文化門市', pickup_addr: '新北市板橋區文化路188號', invoice: '手機載具 /AB12+3C', note: '',
        created_at: '2026-09-01T13:40:00.000Z',
        items: [
          { item_id: 'I1', name: '六重紗布浴巾 90×90 兩入', qty: 1, jpy_taxed: 2519, unit_price_twd: 890, item_status: '已到貨', source: 'text' },
          { item_id: 'I2', name: '米菓仙貝 7個月起 6袋', qty: 4, jpy_taxed: 429, unit_price_twd: 180, item_status: '採買中', source: 'broadcast' },
          { item_id: 'I3', name: '泡沫沐浴乳 補充包 400ml', qty: 1, jpy_taxed: 869, unit_price_twd: 330, item_status: '已到貨', source: 'image' }],
        status_log: [{ to_status: '待確認', ts: '2026-09-01T13:40:00.000Z' }, { to_status: '已報價', ts: '2026-09-02T02:12:00.000Z' },
                     { to_status: '已到貨', ts: '2026-09-14T10:05:00.000Z' }],
        shipments: [] },
      { order_id: 'ORD-20260828-007', batch: 'T-260817', status: '已送達', payment_status: '已核對', paid: true,
        total_twd: 960, ship_fee_twd: 70, split_shipped: false, statement_id: 'STMT-20260901-0031',
        pickup: '宅配到府', pickup_addr: '新北市板橋區文化路一段188號 5樓', invoice: '手機載具 /AB12+3C', note: '',
        created_at: '2026-08-28T06:02:00.000Z',
        items: [{ item_id: 'I4', name: 'Combi 自然吸韻電動吸乳器', qty: 1, jpy_taxed: 2519, unit_price_twd: 890, item_status: '已到貨', source: 'text' }],
        status_log: [{ to_status: '待確認', ts: '2026-08-28T06:02:00.000Z' }, { to_status: '已報價', ts: '2026-08-28T12:31:00.000Z' },
                     { to_status: '已到貨', ts: '2026-09-01T01:00:00.000Z' }, { to_status: '已出貨', ts: '2026-09-01T10:44:00.000Z' },
                     { to_status: '已送達', ts: '2026-09-02T03:10:00.000Z' }],
        shipments: [{ shipment_id: 'SH1', carrier: 'tcat', tracking_no: '4512-8890-2231', shipped_at: '2026-08-30T08:40:00.000Z', eta: '09/02 已簽收' }] },
    ],
    statements: [
      { statement_id: 'STMT-20260901-0031', order_ids: ['ORD-20260828-007'], total_amount: 960, payment_status: '已核對',
        payway: 'bank', last_five_matched: '31007', created_at: '2026-08-31T18:00:00.000Z', paid_at: '2026-09-01T13:14:00.000Z',
        invoice_no: 'AB-12345678', invoice_at: '2026-09-01T13:20:00.000Z', v_account: null },
      { statement_id: 'STMT-20260916-0032', order_ids: ['ORD-20260901-014'], total_amount: 1940, payment_status: '待付款',
        payway: null, last_five_matched: null, created_at: '2026-09-15T18:00:00.000Z', paid_at: null,
        invoice_no: null, invoice_at: null, v_account: null },
    ],
  };
}

let S = seed();
const idem = new Map();

// ---------------------------------------------------------------------------
const E = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const ok = (data) => ({ ok: true, data, error: null });
const need = (cond, code, msg, status = 400) => { if (!cond) throw E(code, msg, status); };
const cartOf = (cid) => { const c = S.cart.find((x) => x.cart_id === cid); need(c, 'CART_NOT_FOUND', '找不到這個品項', 404); return c; };
const orderOf = (oid) => { const o = S.orders.find((x) => x.order_id === oid); need(o, 'ORDER_NOT_FOUND', '查無此訂單', 404); return o; };
const stmtOf = (sid) => { const s = S.statements.find((x) => x.statement_id === sid); need(s, 'STATEMENT_NOT_FOUND', '查無此對帳單', 404); return s; };
const pub = (b) => ({ ...b, open: b.remaining > 0 && new Date(b.deadline_at) > new Date(), waitlisted: S.waitlist.has(b.send_id) });

const routes = {
  // ---- 身分與首頁 ----
  'GET /api/v1/me/profile': () => ok(S.me),
  'POST /api/v1/me/update': ({ body }) => {
    const allow = ['nickname', 'phone', 'cvs_brand', 'cvs_store_id', 'cvs_store_name', 'cvs_addr', 'home_addr', 'carrier'];
    if (body.nickname !== undefined) need(String(body.nickname).trim(), 'BAD_NICKNAME', '暱稱不能空白');
    if (body.phone) need(/^09\d{2}-?\d{3}-?\d{3}$/.test(body.phone), 'BAD_PHONE', '手機格式不正確');
    if (body.carrier) need(/^\/[0-9A-Z.+-]{7}$/.test(body.carrier), 'BAD_CARRIER', '載具格式不正確');
    for (const k of allow) if (body[k] !== undefined) S.me[k] = body[k];
    return ok(S.me);
  },
  'GET /api/v1/home/summary': () => ok({
    shop: S.shop, batch: S.batch, price_table: PRICE_TABLE.map(([jpy_taxed_max, twd]) => ({ jpy_taxed_max, twd })),
    broadcast: S.broadcast.map(pub),
    todo: { unpaid_statements: S.statements.filter((s) => s.payment_status !== '已核對').length,
            pending_cart: S.cart.filter((c) => c.status === 'pending').length },
  }),

  // ---- 購物車 ----
  'GET /api/v1/cart/list': () => ok(S.cart.filter((c) => c.status === 'pending' || c.status === 'confirmed')),
  'POST /api/v1/cart/add-text': ({ body }) => {
    need(String(body.name || '').trim(), 'BAD_NAME', '請輸入商品名稱');
    const qty = Math.max(1, parseInt(body.qty || 1, 10));
    const j = body.jpy_taxed ? Number(body.jpy_taxed) : null;
    const c = { cart_id: id('C'), source: body.source === 'reorder' ? 'reorder' : 'text', ref: null, name: body.name.trim(), name_ja: '',
      jpy_taxed: j, price_twd: j ? twdOf(j) : null, qty, ai_confidence: 'high', status: 'pending',
      note: body.note || '', file_name: null, image_url: null, created_at: now() };
    S.cart.push(c); return ok(c);
  },
  'POST /api/v1/cart/add-image': ({ body }) => {
    need(body.file_name && body.data, 'BAD_IMAGE', '沒有收到圖片');
    need(/^ocr_temp_[0-9a-f]{8}_\d{15}\.(jpg|png|webp|heic)$/.test(body.file_name), 'BAD_FILE_NAME', '檔名格式不符');
    const c = { cart_id: id('C'), source: 'image', ref: body.file_name, name: '辨識中的商品', name_ja: '', jpy_taxed: null,
      price_twd: null, qty: 1, ai_confidence: 'low', status: 'pending', note: 'AI 辨識中，完成後自動更新',
      file_name: body.file_name, image_url: null, created_at: now() };
    S.cart.push(c); return ok(c);
  },
  'POST /api/v1/cart/confirm': ({ body }) => {
    const ids = Array.isArray(body.cart_ids) ? body.cart_ids : [];
    need(ids.length, 'BAD_REQUEST', '沒有指定品項');
    const done = [];
    for (const cid of ids) { const c = cartOf(cid); if (c.status === 'pending') { c.status = 'confirmed'; done.push(cid); } }
    return ok({ confirmed: done });
  },
  'POST /api/v1/cart/update': ({ body }) => {
    const c = cartOf(body.cart_id);
    need(c.source !== 'broadcast', 'NOT_EDITABLE', '喊單品項不能修改內容', 409);
    if (body.name !== undefined) { need(String(body.name).trim(), 'BAD_NAME', '商品名稱不能空白'); c.name = body.name.trim(); }
    if (body.jpy_taxed !== undefined) { c.jpy_taxed = body.jpy_taxed ? Number(body.jpy_taxed) : null; c.price_twd = c.jpy_taxed ? twdOf(c.jpy_taxed) : null; }
    if (body.qty !== undefined) c.qty = Math.max(1, parseInt(body.qty, 10));
    if (body.note !== undefined) c.note = body.note;
    c.status = 'confirmed'; c.ai_confidence = 'high';
    return ok(c);
  },
  'POST /api/v1/cart/set-qty': ({ body }) => {
    const c = cartOf(body.cart_id); const q = parseInt(body.qty, 10);
    need(q >= 1, 'BAD_QTY', '數量至少 1');
    if (c.source === 'broadcast') {
      const b = S.broadcast.find((x) => x.send_id === c.ref); const delta = q - c.qty;
      if (delta > 0) { need(b.remaining >= delta, 'SOLD_OUT', `只剩 ${b.remaining} 份`, 409); b.remaining -= delta; }
      else b.remaining += -delta;
    }
    c.qty = q; return ok(c);
  },
  'POST /api/v1/cart/remove': ({ body }) => {
    const c = cartOf(body.cart_id);
    let drops = S.me.shout_drops;
    if (c.source === 'broadcast') {
      const b = S.broadcast.find((x) => x.send_id === c.ref); if (b) b.remaining += c.qty;
      drops = ++S.me.shout_drops;
    }
    c.status = 'removed';
    return ok({ cart_id: c.cart_id, shout_drops: drops });
  },

  // ---- 喊單 ----
  'POST /api/v1/broadcast/shout': ({ body }) => {
    const b = S.broadcast.find((x) => x.send_id === body.send_id);
    need(b, 'NOT_FOUND', '找不到這個喊單商品', 404);
    need(S.me.shout_drops < 3, 'SUSPENDED', '棄單已達 3 次，暫停喊單資格', 403);
    need(new Date(b.deadline_at) > new Date(), 'DEADLINE_PASSED', '這項喊單已經截止', 409);
    const want = Math.max(1, parseInt(body.qty || 1, 10));
    need(b.remaining > 0, 'SOLD_OUT', '已經被搶完了', 409);
    const granted = Math.min(want, b.remaining); b.remaining -= granted;
    let c = S.cart.find((x) => x.source === 'broadcast' && x.ref === b.send_id && x.status !== 'removed');
    if (c) c.qty += granted;
    else { c = { cart_id: id('C'), source: 'broadcast', ref: b.send_id, name: b.name, name_ja: '', jpy_taxed: b.jpy_taxed,
      price_twd: b.price_twd, qty: granted, ai_confidence: 'high', status: 'confirmed', note: b.note, file_name: null,
      image_url: b.image_url, created_at: now() }; S.cart.push(c); }
    return ok({ granted, remaining: b.remaining, rank: b.quantity - b.remaining, cart_item: c });
  },
  'POST /api/v1/broadcast/waitlist': ({ body }) => {
    need(S.broadcast.some((x) => x.send_id === body.send_id), 'NOT_FOUND', '找不到這個喊單商品', 404);
    if (body.on) S.waitlist.add(body.send_id); else S.waitlist.delete(body.send_id);
    return ok({ send_id: body.send_id, waitlisted: !!body.on });
  },

  // ---- 許願 ----
  'GET /api/v1/wishes/list': () => ok(S.wishes),
  'POST /api/v1/wishes/create': ({ body }) => {
    need(['photo', 'link', 'text'].includes(body.src), 'BAD_SRC', '許願方式不正確');
    if (body.src === 'link') need(/^https?:\/\//.test(body.ref_url || ''), 'BAD_URL', '請貼上完整網址');
    if (body.src === 'text') need(String(body.item_name || '').trim(), 'BAD_NAME', '請填寫內容');
    if (body.src === 'photo') need(body.file_name && body.data, 'BAD_IMAGE', '請先選擇一張照片');
    const w = { wish_id: id('W'), item_name: body.item_name || (body.src === 'link' ? '辨識中的商品連結' : '辨識中的商品照片'),
      item_name_ja: '', brand: '', ref_url: body.ref_url || '', quantity: Math.max(1, parseInt(body.quantity || 1, 10)),
      note: body.note || '', wish_status: '待處理', quote_twd: null, picture: null, file_name: body.file_name || null, wished_at: now() };
    S.wishes.unshift(w); return ok(w);
  },
  'POST /api/v1/wishes/to-cart': ({ body }) => {
    const w = S.wishes.find((x) => x.wish_id === body.wish_id); need(w, 'NOT_FOUND', '找不到這筆許願', 404);
    need(w.wish_status === '已報價', 'NOT_QUOTED', '還沒有報價，無法加入購物車', 409);
    const c = { cart_id: id('C'), source: 'wish', ref: w.wish_id, name: w.item_name, name_ja: w.item_name_ja, jpy_taxed: null,
      price_twd: w.quote_twd, qty: w.quantity, ai_confidence: 'high', status: 'confirmed', note: w.note,
      file_name: w.file_name, image_url: w.picture, created_at: now() };
    S.cart.push(c); w.wish_status = '已下單'; return ok({ wish: w, cart_item: c });
  },
  'POST /api/v1/wishes/keep': ({ body }) => {
    const w = S.wishes.find((x) => x.wish_id === body.wish_id); need(w, 'NOT_FOUND', '找不到這筆許願', 404);
    w.wish_status = '保留下團'; return ok(w);
  },
  'POST /api/v1/wishes/remove': ({ body }) => {
    const i = S.wishes.findIndex((x) => x.wish_id === body.wish_id); need(i >= 0, 'NOT_FOUND', '找不到這筆許願', 404);
    S.wishes.splice(i, 1); return ok({ wish_id: body.wish_id });
  },

  // ---- 訂單 ----
  'POST /api/v1/orders/checkout': ({ body }) => {
    const ids = Array.isArray(body.cart_ids) ? body.cart_ids : [];
    need(ids.length, 'EMPTY_CART', '沒有可以送出的品項');
    const items = ids.map(cartOf);
    need(items.every((c) => c.status === 'confirmed'), 'NOT_CONFIRMED', '還有品項沒確認', 409);
    const inv = body.invoice || {};
    need(['carrier', 'donate', 'tax'].includes(inv.type), 'BAD_INVOICE', '發票方式不正確');
    if (inv.type === 'tax') need(/^\d{8}$/.test(inv.tax_id || ''), 'BAD_TAX_ID', '統一編號需為 8 碼數字');
    const pk = body.pickup || {};
    need(['cvs', 'home'].includes(pk.type), 'BAD_PICKUP', '取貨方式不正確');
    const fee = pk.type === 'cvs' ? 70 : 120;
    const sub = items.reduce((a, c) => a + (c.price_twd || 0) * c.qty, 0);
    const o = { order_id: id('ORD'), batch: S.batch.batch, status: '待確認', payment_status: '待付款', paid: false,
      total_twd: sub + fee, ship_fee_twd: fee, split_shipped: false, statement_id: null,
      pickup: pk.type === 'cvs' ? `${S.me.cvs_brand} ${S.me.cvs_store_name}` : '宅配到府',
      pickup_addr: pk.type === 'cvs' ? S.me.cvs_addr : S.me.home_addr,
      invoice: inv.type === 'carrier' ? `手機載具 ${S.me.carrier}` : inv.type === 'donate' ? '捐贈發票' : `統編 ${inv.tax_id}`,
      note: body.note || '', created_at: now(),
      items: items.map((c) => ({ item_id: id('I'), name: c.name, qty: c.qty, jpy_taxed: c.jpy_taxed,
        unit_price_twd: c.price_twd || 0, item_status: '待採買', source: c.source })),
      status_log: [{ to_status: '待確認', ts: now() }], shipments: [] };
    items.forEach((c) => { c.status = 'ordered'; });
    S.orders.unshift(o); return ok(o);
  },
  'GET /api/v1/orders/list': () => ok(S.orders),
  'GET /api/v1/orders/detail': ({ query }) => ok(orderOf(query.order_id)),
  'POST /api/v1/orders/split-request': ({ body }) => {
    const o = orderOf(body.order_id);
    need(['已報價', '已到貨'].includes(o.status), 'NOT_SPLITTABLE', '這張訂單目前無法申請先出貨', 409);
    const arrived = o.items.filter((i) => i.item_status === '已到貨').length;
    need(!body.on || (arrived > 0 && arrived < o.items.length), 'NOT_SPLITTABLE', '需有部分品項已到貨才能申請', 409);
    o.split_shipped = !!body.on; return ok(o);
  },
  'POST /api/v1/orders/received': ({ body }) => {
    const o = orderOf(body.order_id);
    need(o.status === '已出貨', 'ILLEGAL_TRANSITION', '這張訂單尚未出貨', 409);
    o.status = '已送達'; o.status_log.push({ to_status: '已送達', ts: now() }); return ok(o);
  },
  'GET /api/v1/shipments/track': ({ query }) => {
    const o = orderOf(query.order_id);
    return ok(o.shipments.map((s) => ({ ...s, events: [
      { ts: s.shipped_at, status: '賣家已出貨', place: '集貨倉' },
      { ts: s.shipped_at, status: '可取貨／已送達', place: '板橋' }] })));
  },

  // ---- 對帳單與付款 ----
  'GET /api/v1/statements/list': () => ok({
    statements: S.statements,
    unbilled: { count: S.orders.filter((o) => !o.statement_id && o.status !== '待確認' && o.status !== '已取消').length,
                amount: S.orders.filter((o) => !o.statement_id && o.status !== '待確認' && o.status !== '已取消').reduce((a, o) => a + o.total_twd, 0) },
  }),
  'POST /api/v1/statements/report-transfer': ({ body }) => {
    const s = stmtOf(body.statement_id);
    need(s.payment_status !== '已核對', 'ALREADY_PAID', '這張對帳單已完成付款', 409);
    need(/^\d{5}$/.test(body.last5 || ''), 'BAD_LAST5', '請輸入 5 碼數字');
    s.payment_status = '待官方確認'; s.payway = 'bank'; s.last_five_matched = body.last5;
    return ok(s);
  },
  'POST /api/v1/statements/pay-init': ({ body }) => {
    const s = stmtOf(body.statement_id);
    need(s.payment_status !== '已核對', 'ALREADY_PAID', '這張對帳單已完成付款', 409);
    need(['credit', 'atm', 'linepay'].includes(body.payway), 'BAD_PAYWAY', '付款方式不正確');
    s.payway = body.payway;
    if (body.payway === 'atm') {
      if (!s.v_account) { s.v_account = '9552' + String(Math.floor(1e8 + Math.random() * 9e8)); s.v_bank = '(009) 彰化銀行';
                          s.v_expire_at = new Date(Date.now() + 3 * 864e5).toISOString(); }
      return ok({ flow: 'vacc', v_account: s.v_account, v_bank: s.v_bank, v_expire_at: s.v_expire_at });
    }
    return ok({ flow: 'redirect', action: 'https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5',
                fields: { MerchantID: '2000132', MerchantTradeNo: 'HB' + Date.now(), TotalAmount: String(s.total_amount), CheckMacValue: 'STUB' } });
  },
};

// ---------------------------------------------------------------------------
async function readJson(req) {
  let buf = ''; for await (const c of req) buf += c;
  if (!buf) return {};
  try { return JSON.parse(buf); } catch { throw E('BAD_JSON', '請求格式錯誤'); }
}

function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const send = (status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key' });
    res.end(JSON.stringify(payload));
  };
  if (req.method === 'OPTIONS') return send(204, {});
  if (url.pathname === '/__reset') { S = seed(); idem.clear(); return send(200, ok(true)); }
  const fn = routes[`${req.method} ${url.pathname}`];
  if (!fn) return send(404, { ok: false, data: null, error: { code: 'NOT_FOUND', message: '找不到這個 API' } });
  (async () => {
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!auth) return send(401, { ok: false, data: null, error: { code: 'UNAUTHENTICATED', message: '尚未登入' } });
    const key = req.headers['idempotency-key'];
    if (req.method === 'POST' && key && idem.has(key)) return send(200, idem.get(key));
    const body = req.method === 'POST' ? await readJson(req) : {};
    const out = await fn({ body, query: Object.fromEntries(url.searchParams) });
    if (req.method === 'POST' && key) idem.set(key, out);
    send(200, out);
  })().catch((e) => {
    const status = e.status || 500;
    send(status, { ok: false, data: null, error: { code: e.code || 'INTERNAL', message: status >= 500 ? '系統忙碌中，稍後再試' : e.message } });
  });
}

if (require.main === module) {
  const port = Number(process.argv[2] || 4010);
  http.createServer(handler).listen(port, () => console.log(`buyer contract server on :${port}`));
}
module.exports = { handler, routes: Object.keys(routes) };
