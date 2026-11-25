'use strict';
const db = require('../lib/db');
const { get, post, ok } = require('../lib/http');
const auth = require('../lib/auth');
const config = require('../lib/config');
const audit = require('../lib/audit');
const { STATUS } = require('../lib/state');
const { uid, now } = require('../lib/ids');
const money = require('../lib/money');

const ntw = (n) => 'NT$' + Number(n).toLocaleString('zh-TW', { maximumFractionDigits: 0 });
const err = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const ACTIVE = [STATUS.PENDING, STATUS.QUOTED, STATUS.ARRIVED, STATUS.SHIPPED, STATUS.DELIVERED];

// F-22 營運儀表板
get('/api/v1/dashboard/summary', async ({ actor, query }) => {
  auth.requireCap(actor, 'order.read');
  const batch = query.batch || await db.setting('current_batch');
  const placeholders = ACTIVE.map(() => '?').join(',');

  const orders = await db.all(`SELECT * FROM orders WHERE batch = ? AND status IN (${placeholders})`, batch, ...ACTIVE);
  const revenue = money.round2(orders.reduce((s, o) => s + o.total_twd, 0));
  const unpaid = money.round2(orders.filter((o) => !o.paid).reduce((s, o) => s + o.total_twd, 0));

  // Per-sku cost, from the fx-snapshotted expenses only. Estimates never count.
  const costBySku = new Map();
  for (const pr of await db.all('SELECT proc_id, sku FROM procurements WHERE batch = ?', batch)) {
    const c = await money.weightedCost(pr.proc_id);
    if (c) costBySku.set(pr.sku, c.unit_cost_twd);
  }

  const lines = await db.all(
    `SELECT oi.sku, oi.qty, oi.unit_price_twd, p.name_zh FROM order_items oi
       JOIN orders o ON o.order_id = oi.order_id
       JOIN products p ON p.sku = oi.sku
      WHERE o.batch = ? AND o.status IN (${placeholders})`, batch, ...ACTIVE);

  let costedRevenue = 0, costedCost = 0, uncostedRevenue = 0;
  const perSku = new Map();
  for (const l of lines) {
    const lineRevenue = l.qty * l.unit_price_twd;
    const unitCost = costBySku.get(l.sku);
    if (unitCost == null) { uncostedRevenue += lineRevenue; continue; }
    const lineCost = l.qty * unitCost;
    costedRevenue += lineRevenue;
    costedCost += lineCost;
    const agg = perSku.get(l.sku) || { sku: l.sku, name_zh: l.name_zh, revenue_twd: 0, cost_twd: 0, qty: 0 };
    agg.revenue_twd += lineRevenue; agg.cost_twd += lineCost; agg.qty += l.qty;
    perSku.set(l.sku, agg);
  }

  const ranking = [...perSku.values()]
    .map((a) => ({
      ...a,
      revenue_twd: money.round2(a.revenue_twd),
      cost_twd: money.round2(a.cost_twd),
      gross_profit_twd: money.round2(a.revenue_twd - a.cost_twd),
      margin_pct: money.margin(a.revenue_twd, a.cost_twd),
    }))
    .sort((a, b) => b.gross_profit_twd - a.gross_profit_twd)
    .slice(0, 10);

  const pendingPieces = (await db.one(
    `SELECT COALESCE(SUM(need_qty - COALESCE(got_qty,0)),0) AS n FROM procurements WHERE batch = ? AND state != 'got'`, batch)).n;

  const todo = [];
  for (const n of await db.all("SELECT * FROM notifications WHERE audience = 'owner' AND read_at IS NULL ORDER BY created_at DESC LIMIT 20")) {
    todo.push({ urgency: 1, kind: n.kind, title: n.title, body: n.body, link: '#/board', notif_id: n.notif_id });
  }
  const unpaidCount = orders.filter((o) => !o.paid && o.status === STATUS.PENDING).length;
  if (unpaidCount) todo.push({ urgency: 2, kind: 'unpaid', title: `${unpaidCount} 張訂單待收款`, body: `未收款 ${ntw(unpaid)}`, link: '#/orders?status=待確認' });
  const toShip = orders.filter((o) => o.status === STATUS.ARRIVED).length;
  if (toShip) todo.push({ urgency: 3, kind: 'to_ship', title: `${toShip} 張訂單待出貨`, body: '可列印標籤後掃碼核對', link: '#/packing' });
  if (uncostedRevenue > 0) todo.push({ urgency: 4, kind: 'uncosted', title: '尚有品項未登錄成本', body: `對應營收 ${ntw(uncostedRevenue)} 未計入毛利`, link: '#/board' });
  // 許願：等報價、等審核上牆。周小姐每天要看的兩件事，放進「今天要處理」。
  const wishCounts = await db.one(
    `SELECT count(*) FILTER (WHERE wish_status = '待處理') AS to_quote,
            count(*) FILTER (WHERE wall_status = 'pending') AS to_review
       FROM wishlist`);
  const toReview = Number(wishCounts.to_review);
  const toQuote = Number(wishCounts.to_quote);
  if (toReview) todo.push({ urgency: 2, kind: 'wall', title: `${toReview} 則許願等你審核上牆`, body: '客人勾了「公開到許願牆」', link: '#/wishes?tab=待上牆' });
  if (toQuote) todo.push({ urgency: 3, kind: 'wish', title: `${toQuote} 則許願等報價`, body: '報了價客人才能加購物車', link: '#/wishes' });
  // 出貨申請（014）：正式庫還沒跑 014 時沒有這張表，首頁照常。
  try {
    const sr = Number((await db.one("SELECT count(*) AS n FROM ship_requests WHERE status = 'pending'")).n);
    if (sr) todo.push({ urgency: 2, kind: 'ship_request', title: `${sr} 筆出貨申請等你審核`, body: '客人申請併單或拆單', link: '#/ship-requests' });
  } catch { /* 014 還沒跑 */ }
  // 自動結算的燈號：被擋下來或太久沒檢查就放進「今天要處理」（店主才看得到）。
  let autoStatement = null;
  if (auth.can(actor, 'payment.reconcile')) {
    try {
      autoStatement = await require('./admin-shop').autoStatementStatus();
      if (autoStatement.light === 'red') todo.push({ urgency: 0, kind: 'auto_statement', title: '自動結算沒有正常執行', body: autoStatement.say, link: '#/statements' });
    } catch (e) { console.warn('[dashboard] 讀不到自動結算狀態：', e.message); }
  }
  // 小幫手請款（015）：店主才看得到。
  if (auth.can(actor, 'payment.reconcile')) {
    try {
      const hc = await db.one("SELECT count(*) AS n, COALESCE(sum(total_twd),0) AS twd FROM helper_claims WHERE status = 'pending'");
      if (Number(hc.n)) todo.push({ urgency: 2, kind: 'helper_claim', title: `${hc.n} 張小幫手請款單等你審核`, body: `合計 ${ntw(hc.twd)}`, link: '#/helper?tab=' + encodeURIComponent('請款審核') });
    } catch { /* 015 還沒跑 */ }
  }
  todo.sort((a, b) => a.urgency - b.urgency);

  // 訂單狀態數字格：點了直接跳到訂單管理的同一個篩選，所以數字跟清單要一致（都是這一團）。
  const counts = await db.one(
    `SELECT count(*) FILTER (WHERE NOT paid AND status NOT IN ('缺貨','已取消')) AS unpaid,
            count(*) FILTER (WHERE status IN ('待確認','已報價')) AS to_buy,
            count(*) FILTER (WHERE status = '已到貨') AS to_ship,
            count(*) FILTER (WHERE status = '已出貨') AS shipping,
            count(*) FILTER (WHERE status = '已送達') AS done,
            count(*) FILTER (WHERE status IN ('缺貨','已取消')) AS failed
       FROM orders WHERE batch = ?`, batch);
  const batchRow = batch ? await db.one('SELECT batch, name, region, close_at, buy_at, back_at, ship_at FROM batches WHERE batch = ?', batch) : null;

  // 營運總覽（2026-11-25 照周小姐影片 2）：彩色數字格＋「優先確認」。
  // 數字格看這一團；「優先確認」看全部（逾期付款、缺貨不會只發生在這一團）。
  const overview = await overviewNumbers(batch, batchRow, actor);
  const openBroadcasts = Number((await db.one(
    `SELECT count(*) AS n FROM broadcast WHERE batch = ? AND remaining > 0
        AND (deadline_at IS NULL OR deadline_at > now())`, batch)).n);

  const data = {
    batch,
    fx_rate: await money.currentFxRate(),
    revenue_twd: revenue,
    unpaid_twd: unpaid,
    order_count: orders.length,
    pending_procurement_pieces: pendingPieces,
    pending_shipment_count: toShip,
    // 首頁大按鈕版（2026-11-19）
    batch_info: batchRow,
    open_broadcasts: openBroadcasts,
    wishes_to_quote: toQuote,
    wall_to_review: toReview,
    status_counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v)])),
    // F-22 毛利呈現規則: uncosted lines are excluded from the denominator and
    // reported separately, never filled in with estimates.
    cost_registered_twd: money.round2(costedCost),
    gross_profit_twd: money.round2(costedRevenue - costedCost),
    margin_pct: money.margin(costedRevenue, costedCost),
    margin_basis_revenue_twd: money.round2(costedRevenue),
    uncosted_revenue_twd: money.round2(uncostedRevenue),
    ranking,
    todo,
    // 自動結算燈號（店主才有；其他角色是 null）
    auto_statement: autoStatement,
    overview,
    // 「開啟客人頁 ↗」：買家 LIFF 網址（不是機密，本來就印在 LINE 訊息裡）
    buyer_url: config.buyerLiffUrl,
  };
  return ok(auth.redact(actor, data));
});

post('/api/v1/notifications/read', async ({ actor, body }) => {
  auth.requireCap(actor, 'order.read');
  await db.run('UPDATE notifications SET read_at = ? WHERE notif_id = ?', now(), body.notif_id);
  return ok({ notif_id: body.notif_id });
});

// F-23 匯率管理
get('/api/v1/settings/fx', async ({ actor }) => {
  auth.requireCap(actor, 'order.read');
  return ok({
    fx_jpy_twd: await money.currentFxRate(),
    // 變更者給「稱呼（會員編號）」，畫面上不出現 LINE userId。
    history: await db.all(
      `SELECT f.*, CASE WHEN m.line_user_id IS NULL THEN f.changed_by
                        ELSE m.nickname || '（' || m.member_no || '）' END AS changed_by_label
         FROM fx_history f LEFT JOIN members m ON m.line_user_id = f.changed_by
        ORDER BY f.changed_at DESC LIMIT 50`),
  });
});

post('/api/v1/settings/fx', async ({ actor, body }) => {
  auth.requireCap(actor, 'settings.write');
  const rate = Number(body.fx_jpy_twd);
  if (!Number.isFinite(rate) || rate <= 0) throw err('BAD_RATE', '匯率必須是大於 0 的數字');
  const previous = await money.currentFxRate();
  await db.putSetting('fx_jpy_twd', rate);
  await db.run('INSERT INTO fx_history (fx_id, rate, changed_by, changed_at) VALUES (?,?,?,?)', uid('fx'), rate, actor.line_user_id, now());
  await audit.record({ actor: actor.line_user_id, action: 'settings.fx', detail: { from: previous, to: rate }, result: 'ok' });
  // Existing procurements keep their snapshot; only new writes use the new rate.
  return ok({ fx_jpy_twd: rate, previous });
});

get('/api/v1/settings/batches', async ({ actor }) => {
  auth.requireCap(actor, 'order.read');
  return ok({ current_batch: await db.setting('current_batch'), batches: await db.all('SELECT * FROM batches ORDER BY batch DESC') });
});

post('/api/v1/settings/batch', async ({ actor, body }) => {
  auth.requireCap(actor, 'settings.write');
  const batch = await db.one('SELECT batch FROM batches WHERE batch = ?', body.batch);
  if (!batch) throw err('BATCH_NOT_FOUND', '查無此團', 404);
  await db.putSetting('current_batch', body.batch);
  await audit.record({ actor: actor.line_user_id, action: 'settings.batch', detail: { batch: body.batch }, result: 'ok' });
  return ok({ current_batch: body.batch });
});

/**
 * 營運總覽的數字。每一格都附 link，點了跳到已經篩選好的清單 —— 數字跟清單要對得上。
 *   tiles   待採買喊單、許願池人氣、待核對出貨、付款與發票資料、進行中訂單、七日內預計到貨、待處理問題
 *           （待收款金額沿用 unpaid_twd）
 *   action  優先確認：待確認、逾期付款、即將到貨、缺貨與延遲
 * 「七日內預計到貨」= 已出貨、7 天內寄出的單（還在路上），加上這一團回台日在 7 天內、已報價的單。
 */
async function overviewNumbers(batch, batchRow, actor) {
  const deadlineDays = parseInt(await db.setting('payment_deadline_days', '2'), 10) || 2;
  const o = await db.one(
    `SELECT count(*) FILTER (WHERE status IN ('待確認','已報價','已到貨','已出貨') AND batch = ?) AS active,
            count(*) FILTER (WHERE status = '已到貨') AS to_ship,
            count(*) FILTER (WHERE status = '待確認') AS pending,
            count(*) FILTER (WHERE status = '缺貨') AS oos,
            count(*) FILTER (WHERE status = '已報價' AND batch = ?) AS quoted_in_batch
       FROM orders`, batch || '', batch || '');
  const shippedRecent = Number((await db.one(
    `SELECT count(DISTINCT o.order_id) AS n FROM orders o JOIN shipments s ON s.order_id = o.order_id
      WHERE o.status = '已出貨' AND s.shipped_at > now() - interval '7 days'`)).n);
  let backSoon = 0;
  if (batchRow && batchRow.back_at) {
    const back = new Date(batchRow.back_at);
    const days = (back.getTime() - Date.now()) / 86400e3;
    if (!Number.isNaN(back.getTime()) && days >= -1 && days <= 7) backSoon = Number(o.quoted_in_batch);
  }
  const st = await db.one(
    `SELECT count(*) FILTER (WHERE payment_status = '待官方確認') AS to_check,
            count(*) FILTER (WHERE payment_status = '待付款' AND created_at < now() - make_interval(days => ?::int)) AS overdue
       FROM statements`, deadlineDays);
  const votes = Number((await db.one(
    `SELECT count(*) AS n FROM wish_votes v JOIN wishlist w ON w.wish_id = v.wish_id WHERE w.wall_status = 'public'`)).n);
  const openBroadcasts = Number((await db.one(
    'SELECT count(*) AS n FROM broadcast WHERE remaining > 0 AND (deadline_at IS NULL OR deadline_at > now())')).n);
  const issues = Number((await db.one("SELECT count(*) AS n FROM notifications WHERE audience = 'owner' AND read_at IS NULL")).n);
  const procIssues = batch ? Number((await db.one(
    "SELECT count(*) AS n FROM procurements WHERE batch = ? AND state IN ('partial','out_of_stock')", batch)).n) : 0;
  let claims = null;
  if (auth.can(actor, 'payment.reconcile')) {
    try {
      const c = await db.one(
        "SELECT count(*) FILTER (WHERE status = 'pending') AS pending, count(*) FILTER (WHERE status = 'approved') AS to_pay FROM helper_claims");
      claims = { pending: Number(c.pending), to_pay: Number(c.to_pay) };
    } catch { /* 015 還沒跑 */ }
  }
  const arriving = shippedRecent + backSoon;
  const q = (v) => encodeURIComponent(v);
  return {
    tiles: {
      to_buy: { n: openBroadcasts, link: '#/shop' },
      wish_votes: { n: votes, link: '#/wishes?tab=' + q('牆上') },
      to_ship: { n: Number(o.to_ship), link: '#/packing' },
      payment_info: { n: Number(st.to_check), link: '#/statements?status=' + q('待官方確認') },
      active_orders: { n: Number(o.active), link: '#/orders?status=' + q('待確認,已報價,已到貨,已出貨') + (batch ? '&batch=' + q(batch) : '') },
      arriving_7d: { n: arriving, link: '#/orders?status=' + q('已出貨') },
      open_issues: { n: issues, link: '#/board' },
    },
    action: {
      pending: { n: Number(o.pending), link: '#/orders?status=' + q('待確認') },
      overdue: { n: Number(st.overdue), link: '#/statements?status=' + q('待付款') },
      arriving: { n: arriving, link: '#/orders?status=' + q('已出貨') },
      delayed: { n: Number(o.oos) + procIssues, link: '#/orders?status=' + q('缺貨') },
    },
    helper_claims: claims,
    payment_deadline_days: deadlineDays,
  };
}

// ---- 店家與結算設定 -------------------------------------------------------
/**
 * These rows live in `settings` and are deliberately absent from the seed
 * migration: this repository is public and a real collection account does not
 * belong in it. This page is where the owner fills them in, and the only place
 * they can be changed.
 */
const SHOP_FIELDS = [
  { key: 'shop_name',             label: '店名',           type: 'text',   max: 40, required: true,
    hint: '出現在對帳單與客人通知上' },
  { key: 'bank_name',             label: '銀行名稱',        type: 'text',   max: 20, required: true,
    hint: '例：華南銀行' },
  { key: 'bank_code',             label: '銀行代碼',        type: 'digits', len: 3,  required: true,
    hint: '三碼數字' },
  { key: 'bank_holder',           label: '收款戶名',        type: 'text',   max: 40,
    hint: '客人匯款時看到的戶名；留空就不顯示' },
  { key: 'bank_account',          label: '收款帳號',        type: 'digits', minLen: 5, maxLen: 16, required: true,
    hint: '只有店主看得到，不會寫進稽核紀錄' },
  { key: 'payment_deadline_days', label: '付款期限（天）',   type: 'int',    lo: 1, hi: 30, required: true,
    hint: '客人收到對帳單後幾天內要完成付款' },
  { key: 'statement_days',        label: '對帳單結算日',     type: 'days',   required: true,
    hint: '每月的哪幾天自動結算，逗號分隔，可以寫「月底」。例：15,月底（預設）' },
  { key: 'statement_auto',        label: '自動結算',         type: 'choice',
    options: [['', '開（結算日晚上 11 點自動產生對帳單並通知客人）'], ['off', '關（只能手動按「結算」）']],
    hint: '關掉之後，對帳單要到「對帳單」頁手動結算' },
  { key: 'bulky_add_min',         label: '大型品加價下限',   type: 'int',    lo: 0, hi: 9999,
    hint: '盒裝或大型物品的加價區間（台幣）' },
  { key: 'bulky_add_max',         label: '大型品加價上限',   type: 'int',    lo: 0, hi: 9999,
    hint: '' },
  { key: 'ship_fee_cvs',          label: '運費：超商取貨',   type: 'int',    lo: 0, hi: 9999,
    hint: '台幣。留空＝暫定 70 元；客人結帳頁與實際收費都照這裡' },
  { key: 'ship_fee_home',         label: '運費：宅配到府',   type: 'int',    lo: 0, hi: 9999,
    hint: '台幣。留空＝暫定 120 元' },
  { key: 'ship_free_cvs',         label: '超商滿額免運門檻', type: 'int',    lo: 0, hi: 1000000,
    hint: '單張訂單商品小計（不含運費）滿多少免運。留空或 0＝不免運' },
  { key: 'ship_free_home',        label: '宅配滿額免運門檻', type: 'int',    lo: 0, hi: 1000000,
    hint: '同上，宅配到府用' },
  { key: 'shout_drop_limit',      label: '喊單棄單上限（次）', type: 'int',    lo: 1, hi: 99,
    hint: '客人取消喊單累積到這個次數就暫停喊單，對帳單付清後自動恢復。留空＝1 次' },
  { key: 'show_trip_card',        label: '客人首頁的團卡',   type: 'choice',
    options: [['', '自動（有開團才顯示）'], ['show', '一律顯示'], ['hide', '一律隱藏']],
    hint: '客人 LINE 首頁上方那張「這一團」卡片要不要出現' },
];

/** Normalise one field for storage, or throw a 400 the owner can act on. */
function shopValue(field, raw) {
  const v = String(raw ?? '').trim();
  if (!v) {
    if (field.required) throw err('BAD_SETTING', `${field.label}不能空白`);
    return '';
  }
  if (field.type === 'choice') {
    if (!field.options.some(([k]) => k === v)) throw err('BAD_SETTING', `${field.label}的選項不正確`);
    return v;
  }
  if (field.type === 'digits') {
    if (!/^[0-9]+$/.test(v)) throw err('BAD_SETTING', `${field.label}只能填數字`);
    if (field.len && v.length !== field.len) throw err('BAD_SETTING', `${field.label}必須是 ${field.len} 碼`);
    if (field.minLen && v.length < field.minLen) throw err('BAD_SETTING', `${field.label}至少 ${field.minLen} 碼`);
    if (field.maxLen && v.length > field.maxLen) throw err('BAD_SETTING', `${field.label}最多 ${field.maxLen} 碼`);
    return v;
  }
  if (field.type === 'int') {
    const n = Number(v);
    if (!Number.isInteger(n) || n < field.lo || n > field.hi) {
      throw err('BAD_SETTING', `${field.label}必須是 ${field.lo}–${field.hi} 的整數`);
    }
    return String(n);
  }
  if (field.type === 'days') {
    const toks = [...new Set(v.split(/[,，\s]+/).filter(Boolean))];
    const nums = toks.filter((t) => t !== '月底').map(Number);
    if (!toks.length || nums.some((d) => !Number.isInteger(d) || d < 1 || d > 28)) {
      throw err('BAD_SETTING', `${field.label}請填 1–28 之間的日期或「月底」，逗號分隔（例：15,月底）`);
    }
    return [...nums.sort((a, b) => a - b), ...(toks.includes('月底') ? ['月底'] : [])].join(',');
  }
  if (field.max && v.length > field.max) throw err('BAD_SETTING', `${field.label}最多 ${field.max} 個字`);
  return v;
}

async function readShop() {
  const values = {};
  for (const f of SHOP_FIELDS) values[f.key] = (await db.setting(f.key, '')) || '';
  return values;
}
const shopMissing = (values) => SHOP_FIELDS.filter((f) => f.required && !values[f.key]).map((f) => f.label);

// 收款帳號只有店主看得到 —— 讀寫都要 settings.write
get('/api/v1/settings/shop', async ({ actor }) => {
  auth.requireCap(actor, 'settings.write');
  const values = await readShop();
  return ok({ values, missing: shopMissing(values), fields: SHOP_FIELDS });
});

post('/api/v1/settings/shop', async ({ actor, body }) => {
  auth.requireCap(actor, 'settings.write');
  const incoming = SHOP_FIELDS.filter((f) => body[f.key] !== undefined);
  if (!incoming.length) throw err('NO_CHANGE', '沒有要更新的欄位');

  // Validate everything first: a bad field must not leave half the settings written.
  const next = {};
  for (const f of incoming) next[f.key] = shopValue(f, body[f.key]);

  // The surcharge range has to hold against whatever the other half already is.
  const current = await readShop();
  const lo = next.bulky_add_min ?? current.bulky_add_min;
  const hi = next.bulky_add_max ?? current.bulky_add_max;
  if (lo !== '' && hi !== '' && Number(lo) > Number(hi)) {
    throw err('BAD_SETTING', '大型品加價下限不可高於上限');
  }

  await db.tx(async () => {
    for (const f of incoming) await db.putSetting(f.key, next[f.key]);
  });
  // detail records which keys changed, never their values — the collection
  // account must not be copied into audit_log.
  await audit.record({ actor: actor.line_user_id, action: 'settings.shop',
    detail: { keys: incoming.map((f) => f.key) }, result: 'ok' });

  const values = await readShop();
  return ok({ updated: incoming.map((f) => f.key), values, missing: shopMissing(values) });
});

get('/api/v1/products/list', async ({ actor, query }) => {
  auth.requireCap(actor, 'order.read');
  const rows = query.batch
    ? await db.all('SELECT * FROM products WHERE batch = ? ORDER BY sku', query.batch)
    : await db.all('SELECT * FROM products ORDER BY sku');
  return ok(auth.redact(actor, rows));
});

get('/api/v1/members/list', async ({ actor }) => {
  auth.requireCap(actor, 'order.read');
  return ok(await db.all('SELECT line_user_id, member_no, nickname, display_name, role, bound_at FROM members ORDER BY role, nickname'));
});

// 健檢要知道「哪幾個必填欄位還空著」，但不能碰值 —— 只借欄位定義出去。
module.exports = { SHOP_FIELDS };
