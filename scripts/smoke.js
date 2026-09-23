'use strict';
/**
 * End-to-end smoke test. Boots the server against the PGlite harness (a real
 * Postgres speaking the wire protocol, same as Supabase) on freshly reset demo
 * data, and walks the acceptance conditions that matter most in README §4.
 *
 *   node scripts/pg-harness.mjs        # in another terminal, then
 *   DATABASE_URL=… npm run smoke
 *
 * With no DATABASE_URL set it starts a harness of its own. It never touches
 * the production Supabase project.
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');

/**
 * 假的 Supabase Storage：照 Supabase 的 REST 介面回應（上傳、批次簽名網址），
 * 讓驗收真的走過 lib/storage.js 的程式路徑。路徑含 failfail 的上傳會回 500，
 * 用來驗「照片存不下來時不建品項」。
 */
const http = require('node:http');
const storageMock = { objects: new Map(), requests: [] };
function startStorageMock() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        storageMock.requests.push({ method: req.method, url: req.url, apikey: req.headers.apikey, auth: req.headers.authorization });
        const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        const sign = /^\/storage\/v1\/object\/sign\/cart-images$/.exec(req.url);
        const up = /^\/storage\/v1\/object\/cart-images\/(.+)$/.exec(req.url);
        if (req.method === 'POST' && sign) {
          const { expiresIn, paths } = JSON.parse(body.toString() || '{}');
          storageMock.lastExpiresIn = expiresIn;
          return send(200, paths.map((p) => storageMock.objects.has(p)
            ? { path: p, signedURL: `/object/sign/cart-images/${p}?token=t${expiresIn}`, error: null }
            : { path: p, signedURL: null, error: 'Object not found' }));
        }
        if (req.method === 'POST' && up) {
          const key = decodeURIComponent(up[1]);
          if (key.includes('failfail')) return send(500, { error: 'boom' });
          storageMock.objects.set(key, body);
          return send(200, { Key: `cart-images/${key}` });
        }
        send(404, { error: 'not found' });
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
let STORAGE_MOCK_URL = '';

/** PGlite serves one connection at a time, hence DB_POOL_MAX=1. */
const envFor = (databaseUrl) => ({
  ...process.env,
  PORT: String(PORT),
  DATABASE_URL: databaseUrl,
  DB_POOL_MAX: '1',
  QR_SIGNING_KEY: 'smoke-test-signing-key',
  SESSION_SIGNING_KEY: 'smoke-test-session-key',
  ADMIN_LOGIN_PASSWORD: 'smoke-admin-password-0123456789',
  LINE_LOGIN_CHANNEL_ID: '2011699944',
  // 後台 LINE 登入。LINE 的驗證端點由 scripts/line-verify-mock.cjs 換成假資料。
  ADMIN_LIFF_ID: '2011699944-smokeAdm',
  NODE_OPTIONS: `--require ${path.join(ROOT, 'scripts', 'line-verify-mock.cjs')}`,
  SUPABASE_URL: STORAGE_MOCK_URL,
  SUPABASE_SERVICE_KEY: 'smoke-supabase-secret',
  // 綠界官方測試商店的參數不放進原始碼；這裡用假值，只驗「有沒有簽、簽出來的值
  // 有沒有外洩」，不驗綠界端是否接受 —— 那要真的打到綠界才算數。
  ECPAY_MERCHANT_ID: '3002607',
  ECPAY_HASH_KEY: 'smokeEcpayHashKey00',
  ECPAY_HASH_IV: 'smokeEcpayHashIv000',
  ECPAY_API_URL: 'https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5',
  NOTIFY_SHARED_SECRET: 'smoke-notify-secret',
  // NOTIFY_HOOK_URL 刻意不設：驗證「沒接 n8n 也照常出貨」
  FX_JPY_TWD: '0.215',
});

/** Start scripts/pg-harness.mjs and resolve with the DATABASE_URL it prints. */
function startHarness() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'pg-harness.mjs')],
      { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const timer = setTimeout(() => reject(new Error('harness 啟動逾時')), 120000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const m = /DATABASE_URL=(\S+)/.exec(buf);
      if (m) { clearTimeout(timer); resolve({ child, url: m[1] }); }
    });
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`harness 結束，代碼 ${code}`)); });
  });
}

let passed = 0, failed = 0;
const check = (name, cond, extra) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? ' — ' + JSON.stringify(extra) : ''}`); }
};
const section = (t) => console.log(`\n${t}`);

async function api(method, url, { token, body, idem, headers: extra } = {}) {
  const headers = { 'Content-Type': 'application/json', ...extra };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (idem) headers['Idempotency-Key'] = idem;
  const res = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json() };
}
const ADMIN_PW = 'smoke-admin-password-0123456789';
const login = async (id) =>
  (await api('POST', '/api/v1/auth/login', { body: { line_user_id: id, password: ADMIN_PW } })).json.data.token;

(async () => {
  const storageSrv = await startStorageMock();
  STORAGE_MOCK_URL = `http://127.0.0.1:${storageSrv.address().port}`;
  let harness = null;
  let databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    harness = await startHarness();
    databaseUrl = harness.url;
    console.log(`[smoke] 已啟動 harness：${databaseUrl}`);
  }

  // --reset wipes the demo tables and re-seeds; the schema itself belongs to
  // supabase/migrations and is already in place.
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js'), '--reset'],
    { cwd: ROOT, env: envFor(databaseUrl), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (d) => { const s = d.toString(); if (!/Warning/.test(s)) process.stderr.write(s); });
  for (let i = 0; i < 300; i++) {
    try { await fetch(BASE + '/api/v1/health'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  try {
    const owner = await login('U_owner');
    const helper = await login('U_helper1');
    const helper2 = await login('U_helper2');
    const packer = await login('U_packer');
    const buyer = await login('U_buyer1');
    // 先拿好：後面「登入的門」會把本機來源鎖住，之後不能再登入。成員權限那節用它驗升降級。
    const buyer2 = await login('U_buyer2');

    section('F-21 權限（伺服器端強制）');
    check('店主可讀成本清單', (await api('GET', '/api/v1/procurement/expenses', { token: owner })).status === 200);
    check('助手直接呼叫成本 API 回 403', (await api('GET', '/api/v1/procurement/expenses', { token: helper })).status === 403);
    check('理貨直接呼叫成本 API 回 403', (await api('GET', '/api/v1/procurement/expenses', { token: packer })).status === 403);
    check('無 token 被擋下', (await api('GET', '/api/v1/orders/list')).status === 401);

    const boardOwner = (await api('GET', '/api/v1/procurement/board', { token: owner })).json.data;
    const boardHelper = (await api('GET', '/api/v1/procurement/board', { token: helper })).json.data;
    check('店主看得到毛利欄位', 'margin_pct' in boardOwner.rows[0]);
    check('助手看板不含成本/毛利欄位', !('margin_pct' in boardHelper.rows[0]) && !('unit_cost_twd' in boardHelper.rows[0]));
    check('助手看板仍可見售價', 'price_twd' in boardHelper.rows[0]);
    const packing = (await api('GET', '/api/v1/packing/list', { token: packer })).json.data;
    check('理貨看不到售價欄位', packing.length > 0 && !('total_twd' in packing[0]));

    section('F-03 訂單查詢隔離');
    const mine = (await api('GET', '/api/v1/orders/list', { token: buyer })).json.data;
    const allIds = (await api('GET', '/api/v1/orders/list?limit=500', { token: owner })).json.data.map((o) => o.order_id);
    check('買家只查得到自己的訂單',
      mine.length > 0 && mine.length < allIds.length && !mine.some((o) => o.order_id === 'HB2608-005'),
      { mine: mine.length, all: allIds.length });
    check('買家拿到的是合約形狀（含 items / status_log / shipments）',
      mine.every((o) => Array.isArray(o.items) && Array.isArray(o.status_log) && Array.isArray(o.shipments))
      && !('line_user_id' in mine[0]), mine[0]);
    check('買家查他人訂單回 403', (await api('GET', '/api/v1/orders/detail?order_id=HB2608-005', { token: buyer })).status === 403);

    // 品項層級的「部分到貨」：order_items.item_status 跟著採購狀態走
    const itemStatusOf = async (orderId, sku) => {
      const d = (await api('GET', `/api/v1/orders/detail?order_id=${orderId}`, { token: owner })).json.data;
      const it = d.items.find((i) => i.sku === sku);
      return it ? it.item_status : null;
    };
    const quotedOrderWith = async (sku) => {
      const rows = (await api('GET', '/api/v1/orders/list?status=已報價', { token: owner })).json.data;
      const hit = rows.find((o) => o.items.some((i) => i.sku === sku));
      return hit ? hit.order_id : null;
    };

    section('F-08 認領併發（條件更新）');
    const open = boardOwner.rows.find((r) => r.state === 'open');
    const [a, b] = await Promise.all([
      api('POST', '/api/v1/procurement/claim', { token: helper, body: { proc_id: open.proc_id } }),
      api('POST', '/api/v1/procurement/claim', { token: helper2, body: { proc_id: open.proc_id } }),
    ]);
    const wins = [a, b].filter((r) => r.json.ok).length;
    check('同時認領只有一個成功', wins === 1, { a: a.json, b: b.json });
    check('落敗者收到「已被認領」', [a, b].some((r) => r.json.error && r.json.error.code === 'ALREADY_CLAIMED'));
    check('非認領者不可放掉', (await api('POST', '/api/v1/procurement/release', { token: packer, body: { proc_id: open.proc_id } })).status !== 200);

    section('品項狀態（部分到貨在品項層級）');
    const tracked = await quotedOrderWith(open.sku);
    check('認領後品項轉為採買中', tracked && (await itemStatusOf(tracked, open.sku)) === '採買中', { tracked, sku: open.sku });

    section('F-08 回報結果');
    const r1 = await api('POST', '/api/v1/procurement/result', { token: helper, body: { proc_id: open.proc_id, got_qty: open.need_qty + 5 } });
    check('回報數量 ≥ 需求記為買足', r1.json.data.state === 'got' && r1.json.data.got_qty === open.need_qty);
    check('買足後品項轉為已到貨', tracked && (await itemStatusOf(tracked, open.sku)) === '已到貨', { tracked, sku: open.sku });
    const oos = boardOwner.rows.find((r) => r.state === 'claimed');
    if (oos) {
      await api('POST', '/api/v1/procurement/result', { token: owner, body: { proc_id: oos.proc_id, got_qty: 0 } });
      const dash = (await api('GET', '/api/v1/dashboard/summary', { token: owner })).json.data;
      check('缺貨立即產生店主待辦', dash.todo.some((t) => t.kind === 'out_of_stock'));
    }

    section('F-07 請款：匯率快照與毛利');
    const target = (await api('GET', '/api/v1/procurement/board', { token: owner })).json.data.rows.find((r) => r.state === 'got' && r.receipts === 0)
      || (await api('GET', '/api/v1/procurement/board', { token: owner })).json.data.rows.find((r) => r.state === 'got');
    const ocr = (await api('POST', '/api/v1/procurement/ocr', { token: helper, body: { proc_id: target.proc_id } })).json.data;
    check('OCR 結果標記必須人工確認', ocr.requires_confirmation === true);
    const exp = (await api('POST', '/api/v1/procurement/expense', { token: helper, body: { proc_id: target.proc_id, unit_cost_jpy: 1000, qty: 1 } })).json;
    check('助手可寫入成本', exp.ok);
    check('助手拿不到毛利回傳值', !('margin_pct' in exp.data));
    const ownerExp = (await api('POST', '/api/v1/procurement/expense', { token: owner, body: { proc_id: target.proc_id, unit_cost_jpy: 1000, qty: 1 } })).json.data;
    check('店主看得到毛利率', typeof ownerExp.margin_pct === 'number');
    check('金額 ≤ 0 被拒絕', (await api('POST', '/api/v1/procurement/expense', { token: helper, body: { proc_id: target.proc_id, unit_cost_jpy: 0 } })).status === 400);
    const costBefore = ownerExp.unit_cost_twd;
    await api('POST', '/api/v1/settings/fx', { token: owner, body: { fx_jpy_twd: 0.3 } });
    const after = (await api('GET', '/api/v1/procurement/board', { token: owner })).json.data.rows.find((r) => r.proc_id === target.proc_id);
    check('改匯率後既有紀錄台幣成本不變', Math.abs(after.unit_cost_twd - costBefore) < 0.01, { costBefore, after: after.unit_cost_twd });
    check('助手改匯率回 403', (await api('POST', '/api/v1/settings/fx', { token: helper, body: { fx_jpy_twd: 0.2 } })).status === 403);
    await api('POST', '/api/v1/settings/fx', { token: owner, body: { fx_jpy_twd: 0.215 } });

    section('F-18 掃碼六段攔截');
    const label = (await api('GET', '/api/v1/labels/data?order_ids=HB2608-004', { token: packer })).json.data.labels[0];
    check('標籤內容為純 ASCII', /^[\x20-\x7E]+$/.test(label.payload));
    const v = async (code) => (await api('POST', '/api/v1/scan/verify', { token: packer, body: { code } })).json.data;
    check('1 格式錯誤 → 紅', (await v('隨便一串')).code === 'BAD_FORMAT');
    check('2 查無訂單 → 紅', (await v('HB|HB2608-999|ABCD')).code === 'ORDER_NOT_FOUND');
    check('3 竄改簽章 → 紅', (await v(label.payload.slice(0, -1) + (label.payload.slice(-1) === 'Z' ? 'Y' : 'Z'))).code === 'BAD_SIGNATURE');
    const shipped = (await api('GET', '/api/v1/labels/data?order_ids=HB2608-006', { token: packer })).json.data.labels[0];
    check('4 已出貨 → 黃', (await v(shipped.payload)).code === 'ALREADY_SHIPPED');
    const unpaid = (await api('GET', '/api/v1/labels/data?order_ids=HB2608-007', { token: packer })).json.data.labels[0];
    check('5 未付款 → 黃', (await v(unpaid.payload)).code === 'UNPAID');
    const partial = (await api('GET', '/api/v1/labels/data?order_ids=HB2608-005', { token: packer })).json.data.labels[0];
    check('6 品項未買齊 → 黃', (await v(partial.payload)).code === 'INCOMPLETE_PROCUREMENT');
    const green = await v(label.payload);
    check('全部通過 → 綠', green.level === 'green' && green.code === 'PASS');

    section('F-18 覆寫規則');
    check('理貨覆寫黃燈被擋', (await api('POST', '/api/v1/scan/commit', { token: packer, body: { code: unpaid.payload, override_reason: '客人說會補' } })).status === 403);
    check('店主覆寫黃燈需填原因', (await api('POST', '/api/v1/scan/commit', { token: owner, body: { code: unpaid.payload } })).status === 400);
    const ov = await api('POST', '/api/v1/scan/commit', { token: owner, body: { code: unpaid.payload, override_reason: '客人現場付現，已收款' } });
    check('店主填原因後可覆寫', ov.json.ok, ov.json);
    check('紅燈永遠不可覆寫', (await api('POST', '/api/v1/scan/commit', { token: owner, body: { code: 'HB|HB2608-999|ABCD', override_reason: '硬出' } })).status === 409);

    section('F-17/F-10 掃碼出貨與通知');
    const commit = (await api('POST', '/api/v1/scan/commit', { token: packer, body: { code: label.payload } })).json.data;
    check('綠燈掃碼即出貨', commit.status === '已出貨' && commit.verified_by_scan === true);
    check('產生出貨通知文案', typeof commit.notification === 'string' && commit.notification.includes('出貨通知'));
    check('重複掃同一張 → 已出貨黃燈', (await v(label.payload)).code === 'ALREADY_SHIPPED');

    section('出貨推播佇列');
    const NKEY = { headers: { 'X-Notify-Token': 'smoke-notify-secret' } };
    const claim = (limit = 20) => api('POST', '/api/v1/notify/pending', { ...NKEY, body: { limit } });
    check('沒帶金鑰的取件被擋', (await api('POST', '/api/v1/notify/pending', { body: {} })).status === 401);
    check('金鑰錯誤的取件被擋',
      (await api('POST', '/api/v1/notify/pending', { headers: { 'X-Notify-Token': 'wrong' }, body: {} })).status === 401);
    const batch1 = (await claim()).json.data;
    // 這一輪測試前已出貨兩張單（HB2608-007 覆寫、HB2608-004 掃碼）
    check('出貨後通知進佇列，一張單一筆', batch1.count === 2
      && new Set(batch1.notifications.map((n) => n.order_id)).size === 2
      && batch1.notifications.every((n) => n.kind === 'shipped'), batch1.notifications.map((n) => n.order_id));
    check('通知內容含文案與訂單資訊',
      batch1.notifications.every((n) => n.payload && typeof n.payload.text === 'string'
        && n.payload.text.includes('出貨通知') && n.payload.order_id));
    check('取件即上鎖，第二次拿不到同一批', (await claim()).json.data.count === 0);

    const first = batch1.notifications[0], second = batch1.notifications[1];
    check('回報成功後不會再被取件',
      (await api('POST', '/api/v1/notify/result', { ...NKEY, body: { notif_id: first.notif_id, ok: true } })).json.ok);
    const failed = (await api('POST', '/api/v1/notify/result', { ...NKEY,
      body: { notif_id: second.notif_id, ok: false, error: '429 rate limit', line_response: { message: 'quota' } } })).json;
    check('回報失敗會排重試，不會立刻再拿到',
      failed.ok && failed.data.status === 'failed' && failed.data.gave_up === false
      && (await claim()).json.data.count === 0, failed.data);
    check('查無通知回 404',
      (await api('POST', '/api/v1/notify/result', { ...NKEY, body: { notif_id: 'nope', ok: true } })).status === 404);

    section('F-19 稽核軌跡');
    const logs = (await api('GET', '/api/v1/audit/list?limit=300', { token: owner })).json.data;
    check('覆寫留下 warn 紀錄', logs.some((l) => l.action === 'scan.commit' && l.result === 'warn' && l.detail && l.detail.override_reason));
    check('被擋下的操作留下 blocked 紀錄', logs.some((l) => l.result === 'blocked'));
    const ships = (await api('GET', '/api/v1/shipments/list', { token: owner })).json.data;
    check('出貨紀錄標記是否經掃碼', ships.every((s) => typeof s.verified_by_scan === 'boolean'));

    section('F-04 拆單');
    const detail = (await api('GET', '/api/v1/orders/detail?order_id=HB2608-003', { token: owner })).json.data;
    const totalBefore = detail.total_twd;
    const split = (await api('POST', '/api/v1/orders/split', { token: owner, body: { order_id: 'HB2608-003', items: [{ item_id: detail.items[0].item_id, qty: 1 }] } })).json;
    check('拆單成功', split.ok, split);
    check('拆分前後總額一致', Math.abs(split.data.parent_total_twd + split.data.child_total_twd - totalBefore) < 0.01);
    check('助手不可拆單', (await api('POST', '/api/v1/orders/split', { token: helper, body: { order_id: 'HB2608-002', items: [{ item_id: 'x', qty: 1 }] } })).status === 403);
    check('已出貨訂單不可拆', (await api('POST', '/api/v1/orders/split', { token: owner, body: { order_id: 'HB2608-006', items: [{ item_id: 'x', qty: 1 }] } })).status === 409);

    section('狀態機（資料庫為唯一真相）');
    check('不可跳躍狀態', (await api('POST', '/api/v1/orders/transition', { token: owner, body: { order_id: 'HB2608-002', to: '已送達' } })).status === 409);
    check('狀態被擋下後資料庫未改變',
      (await api('GET', '/api/v1/orders/detail?order_id=HB2608-002', { token: owner })).json.data.status === '已報價');
    check('強制修正需填原因', (await api('POST', '/api/v1/orders/transition', { token: owner, body: { order_id: 'HB2608-002', to: '已送達', force: true } })).status === 400);
    const shippedLog = (await api('GET', '/api/v1/orders/detail?order_id=HB2608-004', { token: owner })).json.data.status_log;
    check('一次狀態轉換只留一筆紀錄', shippedLog.filter((l) => l.to_status === '已出貨').length === 1, shippedLog);

    section('F-06 對帳 / I-02 冪等');
    const key = 'smoke-idem-1';
    const p1 = await api('POST', '/api/v1/payments/reconcile', { token: owner, idem: key, body: { order_id: 'HB2608-001', amount_twd: 1300 } });
    const p2 = await api('POST', '/api/v1/payments/reconcile', { token: owner, idem: key, body: { order_id: 'HB2608-001', amount_twd: 1300 } });
    check('相同 Idempotency-Key 不重複認列', JSON.stringify(p1.json) === JSON.stringify(p2.json));
    check('金額不符不自動認列', (await api('POST', '/api/v1/payments/reconcile', { token: owner, body: { order_id: 'HB2608-002', amount_twd: 1 } })).status === 409);

    section('F-22 儀表板毛利規則');
    const dash = (await api('GET', '/api/v1/dashboard/summary', { token: owner })).json.data;
    check('未登錄成本的營收另行揭露', typeof dash.uncosted_revenue_twd === 'number');
    check('毛利分母不含未登錄成本品項', dash.margin_basis_revenue_twd + dash.uncosted_revenue_twd <= dash.revenue_twd + 0.01);
    const dashHelper = (await api('GET', '/api/v1/dashboard/summary', { token: helper })).json.data;
    check('助手看不到毛利數字', !('gross_profit_twd' in dashHelper) && !('margin_pct' in dashHelper));

    section('店家與收款設定');
    check('助手讀店家設定回 403', (await api('GET', '/api/v1/settings/shop', { token: helper })).status === 403);
    const shop0 = (await api('GET', '/api/v1/settings/shop', { token: owner })).json.data;
    check('店主可讀，且標出未填的必填欄位', Array.isArray(shop0.missing) && shop0.missing.length > 0, shop0.missing);
    check('銀行代碼非 3 碼被拒絕',
      (await api('POST', '/api/v1/settings/shop', { token: owner, body: { bank_code: '12' } })).status === 400);
    check('結算日超出 1–28 被拒絕',
      (await api('POST', '/api/v1/settings/shop', { token: owner, body: { statement_days: '1,40' } })).status === 400);
    check('加價下限高於上限被拒絕',
      (await api('POST', '/api/v1/settings/shop', { token: owner, body: { bulky_add_min: 80, bulky_add_max: 50 } })).status === 400);
    const ACCT = '1234567890123';
    const saved = (await api('POST', '/api/v1/settings/shop', { token: owner, body: {
      shop_name: 'HEEEHABABY', bank_name: '測試銀行', bank_code: '008', bank_account: ACCT,
      payment_deadline_days: 2, statement_days: '16,1', bulky_add_min: 30, bulky_add_max: 50 } })).json;
    check('店主可寫入，寫完不再有缺項', saved.ok && saved.data.missing.length === 0, saved);
    check('結算日已正規化為 1,16', saved.ok && saved.data.values.statement_days === '1,16');
    check('助手寫店家設定回 403',
      (await api('POST', '/api/v1/settings/shop', { token: helper, body: { bank_name: '亂改' } })).status === 403);
    const auditAll = JSON.stringify((await api('GET', '/api/v1/audit/list?limit=300', { token: owner })).json.data);
    check('稽核紀錄不含收款帳號，只記改了哪些欄位',
      !auditAll.includes(ACCT) && auditAll.includes('settings.shop') && auditAll.includes('bank_account'));

    section('F-20 物流綁定');
    check('綁定成功', (await api('POST', '/api/v1/logistics/bind', { token: owner, body: { tracking_no: 'BX123', order_id: 'HB2608-002', carrier: '黑貓' } })).json.ok);
    check('重複單號被擋下', (await api('POST', '/api/v1/logistics/bind', { token: owner, body: { tracking_no: 'BX123', order_id: 'HB2608-004' } })).status === 409);
    check('一單多包裹可綁', (await api('POST', '/api/v1/logistics/bind', { token: owner, body: { tracking_no: 'BX124', order_id: 'HB2608-002' } })).json.ok);

    section('後台登入的門');
    check('沒帶密碼拿不到人員名單',
      (await api('GET', '/api/v1/auth/personas')).status === 401);
    check('密碼錯了拿不到人員名單',
      (await api('GET', '/api/v1/auth/personas', { headers: { 'X-Admin-Password': 'wrong' } })).status === 401);
    const pl = await api('GET', '/api/v1/auth/personas', { headers: { 'X-Admin-Password': ADMIN_PW } });
    check('密碼正確才列出人員', pl.status === 200 && pl.json.data.length > 0);
    check('後台登入名單只列員工，不列客人', pl.status === 200 && pl.json.data.every((p) => p.role !== 'buyer'),
      pl.json.data.map((p) => p.role));
    check('沒帶密碼不發 token',
      (await api('POST', '/api/v1/auth/login', { body: { line_user_id: 'U_owner' } })).status === 401);
    check('密碼錯了不發 token',
      (await api('POST', '/api/v1/auth/login', { body: { line_user_id: 'U_owner', password: 'wrong' } })).status === 401);
    check('密碼對但查無此人回 404，不是 401（不洩漏密碼對錯以外的事）',
      (await api('POST', '/api/v1/auth/login', { body: { line_user_id: 'U-nobody', password: ADMIN_PW } })).status === 404);
    // 登入回應含 token，被冪等快取存起來等於多一條不用密碼就能拿到它的路
    const idem = 'smoke-login-replay';
    const relogin = await api('POST', '/api/v1/auth/login', { body: { line_user_id: 'U_owner', password: ADMIN_PW }, idem });
    check('登入本身成功', relogin.status === 200 && !!relogin.json.data.token);
    check('同一把 Idempotency-Key 重播、但不帶密碼，仍然被擋下',
      (await api('POST', '/api/v1/auth/login', { body: { line_user_id: 'U_owner' }, idem })).status === 401);
    // 冪等快取綁定身分：猜中別人的 key 也領不走別人的回應
    const shopKey = 'smoke-shop-scope';
    await api('POST', '/api/v1/settings/shop', { token: owner, body: { shop_name: 'HEEEHABABY' }, idem: shopKey });
    check('助手用同一把 Idempotency-Key 領不到店主的回應',
      (await api('POST', '/api/v1/settings/shop', { token: helper, body: { shop_name: 'X' }, idem: shopKey })).status === 403);

    // 這一項放在最後：它會把這個來源鎖住幾分鐘，後面的檢查都改用既有 token。
    let locked = 0;
    for (let i = 0; i < 6; i++) {
      locked = (await api('POST', '/api/v1/auth/login', { body: { line_user_id: 'U_owner', password: 'nope' } })).status;
    }
    check('連續打錯會被鎖住（429），不是無限次讓人猜', locked === 429, { locked });
    // 沒預期到的例外仍然只回 INTERNAL，不洩漏技術細節（I-03）
    const boom = await api('GET', '/api/v1/orders/detail?order_id=' + encodeURIComponent("x'"), { token: owner });
    check('沒預期到的錯誤只回 INTERNAL 或一般 4xx，不含技術細節',
      boom.status < 500 || (boom.json.error.code === 'INTERNAL' && !/pg|postgres|syntax|SELECT/i.test(boom.json.error.message)),
      boom.json);

    section('買家 API（BUYER_API_CONTRACT）— 會員與首頁');
    const B = (m, u, o) => api(m, u, { token: buyer, ...o });
    check('未帶 token 一律 401', (await api('GET', '/api/v1/home/summary')).status === 401);
    const prof = (await B('GET', '/api/v1/me/profile')).json.data;
    check('會員資料欄位齊全',
      ['line_user_id','nickname','cvs_store_name','carrier','shout_drops'].every((k) => k in prof), prof);
    check('手機格式錯 → BAD_PHONE',
      (await B('POST', '/api/v1/me/update', { body: { phone: '123' } })).json.error?.code === 'BAD_PHONE');
    check('載具格式錯 → BAD_CARRIER',
      (await B('POST', '/api/v1/me/update', { body: { carrier: 'ABC' } })).json.error?.code === 'BAD_CARRIER');
    const upd = (await B('POST', '/api/v1/me/update',
      { body: { nickname: '小周', cvs_brand: '全家', cvs_store_name: '板橋溪城店', carrier: '/AB12+3C' } })).json.data;
    check('更新暱稱與取貨門市', upd.nickname === '小周' && upd.cvs_store_name === '板橋溪城店');

    const home = (await B('GET', '/api/v1/home/summary')).json.data;
    check('首頁一次取回 shop/batch/價目表/喊單/待辦',
      ['shop','batch','price_table','broadcast','todo'].every((k) => k in home));
    check('價目表 11 級距且第二級 220', home.price_table.length === 11 && home.price_table[1].twd === 220);
    check('已截止的喊單 open=false',
      home.broadcast.find((b) => b.send_id === 'BC-SEED-001').open === false);
    check('銀行資訊備妥旗標', home.shop.bank_ready === true);

    section('買家 API — 購物車');
    check('空白品名 → BAD_NAME',
      (await B('POST', '/api/v1/cart/add-text', { body: { name: '  ' } })).json.error?.code === 'BAD_NAME');
    const t1 = (await B('POST', '/api/v1/cart/add-text',
      { body: { name: 'Pigeon 奶瓶', jpy_taxed: 1000, qty: 2 }, idem: 'bk-text-1' })).json.data;
    check('文字下單 → pending 且套用級距價', t1.status === 'pending' && t1.price_twd === 400, { p: t1.price_twd });
    const t1b = (await B('POST', '/api/v1/cart/add-text',
      { body: { name: 'Pigeon 奶瓶', jpy_taxed: 1000, qty: 2 }, idem: 'bk-text-1' })).json.data;
    check('同一 Idempotency-Key 不重複建立', t1b.cart_id === t1.cart_id);
    check('圖片檔名不符規則 → BAD_FILE_NAME',
      (await B('POST', '/api/v1/cart/add-image', { body: { file_name: 'IMG_001.jpg', data: 'x' } }))
        .json.error?.code === 'BAD_FILE_NAME');
    const im = (await B('POST', '/api/v1/cart/add-image',
      { body: { file_name: 'ocr_temp_2993299f_202609221430123.jpg', data: 'x' } })).json.data;
    check('拍照下單 → pending、低信心、待報價',
      im.status === 'pending' && im.ai_confidence === 'low' && im.price_twd === null);
    check('拍照品項標記為辨識未完成', im.ocr_done === false);
    check('n8n 沒帶金鑰寫不回辨識結果',
      (await api('POST', '/api/v1/ocr/result', { body: { cart_id: im.cart_id, jpy_taxed: 1000 } })).status === 401);
    const ocrBack = await api('POST', '/api/v1/ocr/result', {
      headers: { 'X-Notify-Token': 'smoke-notify-secret' },
      body: { cart_id: im.cart_id, name: '貝親 母乳實感奶嘴', jpy_taxed: 649, ai_confidence: 'high' } });
    check('n8n 回寫辨識結果 → 套用級距價、辨識完成',
      ocrBack.json.data.cart_item.price_twd === 250 && ocrBack.json.data.cart_item.ocr_done === true, ocrBack.json);
    check('客人已自行確認過就不覆蓋',
      (await api('POST', '/api/v1/ocr/result', {
        headers: { 'X-Notify-Token': 'smoke-notify-secret' },
        body: { cart_id: im.cart_id, name: '蓋掉它', jpy_taxed: 100 } })).json.data.applied === false);
    const ed = (await B('POST', '/api/v1/cart/update',
      { body: { cart_id: im.cart_id, name: 'EDWIN 牛仔褲', jpy_taxed: 2519 } })).json.data;
    check('修改內容 → 自動確認並重算價格', ed.status === 'confirmed' && ed.price_twd === 890);
    check('確認品項', (await B('POST', '/api/v1/cart/confirm', { body: { cart_ids: [t1.cart_id] } }))
      .json.data.confirmed.includes(t1.cart_id));

    section('買家 API — 喊單（原子搶量）');
    const sh = (await B('POST', '/api/v1/broadcast/shout', { body: { send_id: 'BC-SEED-002', qty: 9 } })).json.data;
    check('喊 9 但只剩 3 → 得 3、餘 0', sh.granted === 3 && sh.remaining === 0, sh);
    check('喊單品項直接為 confirmed', sh.cart_item.status === 'confirmed');
    check('搶完 → 409 SOLD_OUT',
      (await B('POST', '/api/v1/broadcast/shout', { body: { send_id: 'BC-SEED-002', qty: 1 } })).status === 409);
    check('已截止 → 409 DEADLINE_PASSED',
      (await B('POST', '/api/v1/broadcast/shout', { body: { send_id: 'BC-SEED-001', qty: 1 } }))
        .json.error?.code === 'DEADLINE_PASSED');
    check('喊單品項不能改內容 → 409 NOT_EDITABLE',
      (await B('POST', '/api/v1/cart/update', { body: { cart_id: sh.cart_item.cart_id, name: '改名' } }))
        .json.error?.code === 'NOT_EDITABLE');
    check('排候補',
      (await B('POST', '/api/v1/broadcast/waitlist', { body: { send_id: 'BC-SEED-002', on: true } }))
        .json.data.waitlisted === true);
    const drop = (await B('POST', '/api/v1/cart/remove', { body: { cart_id: sh.cart_item.cart_id } })).json.data;
    check('取消喊單 → 記一次棄單', drop.shout_drops === 1, drop);
    check('餘量已回補',
      (await B('GET', '/api/v1/home/summary')).json.data.broadcast
        .find((b) => b.send_id === 'BC-SEED-002').remaining === 3);

    section('買家 API — 二十人搶五個名額');
    const race = await Promise.all(Array.from({ length: 20 }, () =>
      B('POST', '/api/v1/broadcast/shout', { body: { send_id: 'BC-SEED-003', qty: 1 } })));
    const granted = race.filter((r) => r.json.ok).reduce((a, r) => a + r.json.data.granted, 0);
    const left = (await B('GET', '/api/v1/home/summary')).json.data.broadcast
      .find((b) => b.send_id === 'BC-SEED-003').remaining;
    check('二十次併發喊單不超賣', granted + left === 14 && left >= 0, { granted, left });

    section('買家 API — 許願');
    check('連結不完整 → BAD_URL',
      (await B('POST', '/api/v1/wishes/create', { body: { src: 'link', ref_url: 'rakuten.co.jp/x' } }))
        .json.error?.code === 'BAD_URL');
    const w = (await B('POST', '/api/v1/wishes/create',
      { body: { src: 'text', item_name: '阪急嬰兒襪', quantity: 3 } })).json.data;
    check('文字許願 → 待處理', w.wish_status === '待處理');
    check('未報價不能加購物車 → 409 NOT_QUOTED',
      (await B('POST', '/api/v1/wishes/to-cart', { body: { wish_id: w.wish_id } }))
        .json.error?.code === 'NOT_QUOTED');
    const q = (await B('POST', '/api/v1/wishes/to-cart', { body: { wish_id: 'W-SEED-002' } })).json.data;
    check('已報價許願 → 加入購物車（已確認）',
      q.cart_item.status === 'confirmed' && q.wish.wish_status === '已下單');
    check('別人的許願查不到 → 404',
      (await api('POST', '/api/v1/wishes/to-cart', { token: owner, body: { wish_id: 'W-SEED-002' } })).status === 404);

    section('買家 API — 結帳');
    await B('POST', '/api/v1/cart/add-text', { body: { name: '還沒確認的品項', qty: 1 } });
    const cart = (await B('GET', '/api/v1/cart/list')).json.data;
    check('結帳前購物車有待確認品項', cart.some((c) => c.status === 'pending'));
    check('含未確認品項 → 409 NOT_CONFIRMED',
      (await B('POST', '/api/v1/orders/checkout',
        { body: { cart_ids: cart.map((c) => c.cart_id), pickup: { type: 'cvs' }, invoice: { type: 'carrier' } } }))
        .json.error?.code === 'NOT_CONFIRMED');
    const conf = cart.filter((c) => c.status === 'confirmed').map((c) => c.cart_id);
    check('統編非 8 碼 → BAD_TAX_ID',
      (await B('POST', '/api/v1/orders/checkout',
        { body: { cart_ids: conf, pickup: { type: 'cvs' }, invoice: { type: 'tax', tax_id: '123' } } }))
        .json.error?.code === 'BAD_TAX_ID');
    const co = await B('POST', '/api/v1/orders/checkout', {
      body: { cart_ids: conf, pickup: { type: 'cvs' }, invoice: { type: 'carrier' }, note: '低調包裝' },
      idem: 'bk-checkout-1' });
    const order = co.json.data;
    check('送出訂單 → 待確認／待付款',
      order.status === '待確認' && order.payment_status === '待付款', { id: order.order_id, t: order.total_twd });
    check('運費為超商 70', order.ship_fee_twd === 70);
    check('取貨資訊由會員資料帶入，不由前台傳', /全家|板橋溪城店/.test(order.pickup), { pickup: order.pickup });
    check('結帳重送不會成立第二張單',
      (await B('POST', '/api/v1/orders/checkout', {
        body: { cart_ids: conf, pickup: { type: 'cvs' }, invoice: { type: 'carrier' } },
        idem: 'bk-checkout-1' })).json.data.order_id === order.order_id);
    check('已送出品項離開購物車',
      !(await B('GET', '/api/v1/cart/list')).json.data.some((c) => conf.includes(c.cart_id)));
    check('待確認訂單不能申請先出貨 → 409 NOT_SPLITTABLE',
      (await B('POST', '/api/v1/orders/split-request', { body: { order_id: order.order_id, on: true } }))
        .json.error?.code === 'NOT_SPLITTABLE');
    check('未出貨不能按「我已收到」→ 409 ILLEGAL_TRANSITION',
      (await B('POST', '/api/v1/orders/received', { body: { order_id: order.order_id } }))
        .json.error?.code === 'ILLEGAL_TRANSITION');
    // 走完一張單：已報價 → 已到貨 → 出貨 → 客人按已收到 → 查物流。
    // /shipments/track 在已送達時要讀狀態紀錄，欄位名錯過一次（changed_at），正式站回 500。
    const tr = (await B('POST', '/api/v1/orders/checkout', { body: {
      cart_ids: [(await B('POST', '/api/v1/cart/update', { body: {
        cart_id: (await B('POST', '/api/v1/cart/add-text', { body: { name: '物流測試品', jpy_taxed: 500, qty: 1 } })).json.data.cart_id,
        name: '物流測試品' } })).json.data.cart_id],
      pickup: { type: 'cvs' }, invoice: { type: 'carrier' } } })).json.data;
    await api('POST', '/api/v1/orders/transition', { token: owner, body: { order_id: tr.order_id, to: '已報價' } });
    await api('POST', '/api/v1/orders/transition', { token: owner, body: { order_id: tr.order_id, to: '已到貨' } });
    await api('POST', '/api/v1/orders/ship', { token: owner, body: { order_id: tr.order_id, override_reason: '測試', verified_by_scan: false } });
    check('已出貨 → 客人按「我已收到」→ 已送達',
      (await B('POST', '/api/v1/orders/received', { body: { order_id: tr.order_id } })).json.data?.status === '已送達');
    const trk = await B('GET', `/api/v1/shipments/track?order_id=${tr.order_id}`);
    check('已送達的單查物流：含出貨與送達兩筆事件',
      trk.status === 200 && trk.json.data[0].events.map((e) => e.status).join('>') === '已出貨>已送達', trk.json);
    check('別人的訂單一律 404',
      (await B('POST', '/api/v1/orders/received', { body: { order_id: 'HB2608-005' } })).status === 404);

    section('買家 API — 對帳單與付款');
    const st = (await B('GET', '/api/v1/statements/list')).json.data;
    check('對帳單列表＋未結算彙總', Array.isArray(st.statements) && 'unbilled' in st);
    check('末五碼非 5 碼 → BAD_LAST5',
      (await B('POST', '/api/v1/statements/report-transfer',
        { body: { statement_id: 'STMT-SEED-001', last5: '12' } })).json.error?.code === 'BAD_LAST5');
    check('回報末五碼 → 待官方確認',
      (await B('POST', '/api/v1/statements/report-transfer',
        { body: { statement_id: 'STMT-SEED-001', last5: '48210' } })).json.data.payment_status === '待官方確認');
    check('已付清不能再付 → 409 ALREADY_PAID',
      (await B('POST', '/api/v1/statements/pay-init',
        { body: { statement_id: 'STMT-SEED-002', payway: 'credit' } })).json.error?.code === 'ALREADY_PAID');
    check('LINE Pay 第一波不支援 → BAD_PAYWAY',
      (await B('POST', '/api/v1/statements/pay-init',
        { body: { statement_id: 'STMT-SEED-001', payway: 'linepay' } })).json.error?.code === 'BAD_PAYWAY');
    const pay = await B('POST', '/api/v1/statements/pay-init',
      { body: { statement_id: 'STMT-SEED-001', payway: 'credit' } });
    check('信用卡 → 導轉表單，且 CheckMacValue 在後端產生',
      pay.json.data.flow === 'redirect' && !!pay.json.data.action && !!pay.json.data.fields.CheckMacValue, pay.json.error);
    check('回應不含綠界金鑰',
      !JSON.stringify(pay.json).includes(process.env.SMOKE_ECPAY_HASH_KEY || 'smokeEcpayHashKey00'));

    section('後台 — 開團');
    check('小幫手不能開團',
      (await api('POST', '/api/v1/settings/batch/create', { token: helper, body: { batch: 'T-SMOKE', name: 'x' } })).status === 403);
    const nb = await api('POST', '/api/v1/settings/batch/create',
      { token: owner, body: { batch: 'T-SMOKE-01', name: '10/15 大阪採買', region: '大阪' } });
    check('店主開團成功', nb.status === 200 && nb.json.data.batch === 'T-SMOKE-01', nb.json);
    check('重複團號 → 409',
      (await api('POST', '/api/v1/settings/batch/create', { token: owner, body: { batch: 'T-SMOKE-01', name: 'x' } })).status === 409);
    check('新開的團自動成為目前團別，客人首頁看得到',
      (await B('GET', '/api/v1/home/summary')).json.data.batch?.batch === 'T-SMOKE-01');

    section('後台 — 開喊單');
    check('小幫手不能開喊單（僅店主）',
      (await api('POST', '/api/v1/broadcast/create', { token: helper, body: { name: 'x', jpy_taxed: 500, quantity: 1 } })).status === 403);
    check('超出級距又沒填台幣 → BAD_PRICE',
      (await api('POST', '/api/v1/broadcast/create', { token: owner, body: { name: 'x', jpy_taxed: 99999, quantity: 1 } }))
        .json.error?.code === 'BAD_PRICE');
    const inHour = new Date(Date.now() + 3600_000).toISOString();
    const bc = (await api('POST', '/api/v1/broadcast/create',
      { token: owner, body: { name: '西松屋 紗布巾', jpy_taxed: 1639, quantity: 4, deadline_at: inHour } })).json.data;
    check('開喊單 → 售價查表（¥1639 → 600）、歸入目前團', bc.price_twd === 600 && bc.batch === 'T-SMOKE-01', bc);
    const seen = (await B('GET', '/api/v1/home/summary')).json.data.broadcast.find((b) => b.send_id === bc.send_id);
    check('客人首頁立刻看到新喊單、可以搶', !!seen && seen.open === true);
    await B('POST', '/api/v1/broadcast/shout', { body: { send_id: bc.send_id, qty: 3 } });
    check('減量不能扣到已被搶走的份 → 409',
      (await api('POST', '/api/v1/broadcast/adjust', { token: owner, body: { send_id: bc.send_id, delta: -2 } })).status === 409);
    check('現場多找到 2 件 → 加量',
      (await api('POST', '/api/v1/broadcast/adjust', { token: owner, body: { send_id: bc.send_id, delta: 2 } })).json.data.remaining === 3);
    check('提前截止後，客人首頁顯示不可搶',
      (await api('POST', '/api/v1/broadcast/close', { token: owner, body: { send_id: bc.send_id } })).status === 200
      && (await B('GET', '/api/v1/home/summary')).json.data.broadcast.find((b) => b.send_id === bc.send_id).open === false);

    section('後台 — 許願報價');
    const aw = (await B('POST', '/api/v1/wishes/create', { body: { src: 'text', item_name: 'Combi 吸乳器', quantity: 1 } })).json.data;
    check('店主看得到待處理的許願',
      (await api('GET', '/api/v1/wishes/admin-list', { token: owner })).json.data.some((w) => w.wish_id === aw.wish_id));
    const qw = (await api('POST', '/api/v1/wishes/quote', { token: helper, body: { wish_id: aw.wish_id, jpy_taxed: 2519 } })).json.data;
    check('報價 → 已報價、查表 890', qw.wish_status === '已報價' && Number(qw.quote_twd) === 890, qw);
    check('報價後客人就能加入購物車',
      (await B('POST', '/api/v1/wishes/to-cart', { body: { wish_id: aw.wish_id } })).json.data.cart_item.price_twd === 890);
    check('已下單的許願不能再改價 → 409',
      (await api('POST', '/api/v1/wishes/quote', { token: owner, body: { wish_id: aw.wish_id, quote_twd: 1 } })).status === 409);

    section('後台 — 訂單報價（0 元品項不能漏）');
    const nx = (await B('POST', '/api/v1/cart/add-text', { body: { name: '藥妝店限定面膜', qty: 2 } })).json.data;
    check('沒填日幣的文字品項價格為 null', nx.price_twd === null);
    await B('POST', '/api/v1/cart/confirm', { body: { cart_ids: [nx.cart_id] } });
    const qo = (await B('POST', '/api/v1/orders/checkout',
      { body: { cart_ids: [nx.cart_id], pickup: { type: 'cvs' }, invoice: { type: 'carrier' } } })).json.data;
    check('結帳成立，但這一項以 0 元入單', qo.items[0].unit_price_twd === 0 && qo.total_twd === 70, qo);
    const blocked = await api('POST', '/api/v1/orders/transition', { token: owner, body: { order_id: qo.order_id, to: '已報價' } });
    check('有 0 元品項時，直接轉「已報價」被擋 → 409 UNPRICED_ITEMS', blocked.json.error?.code === 'UNPRICED_ITEMS', blocked.json);
    check('店主強制轉換也一樣擋',
      (await api('POST', '/api/v1/orders/transition',
        { token: owner, body: { order_id: qo.order_id, to: '已報價', force: true, reason: 'x' } })).json.error?.code === 'UNPRICED_ITEMS');
    check('理貨不能報價', (await api('POST', '/api/v1/orders/quote',
      { token: packer, body: { order_id: qo.order_id, items: [] } })).status === 403);
    const quoted = (await api('POST', '/api/v1/orders/quote', { token: helper,
      body: { order_id: qo.order_id, items: [{ item_id: qo.items[0].item_id, jpy_taxed: 979 }] } })).json.data;
    check('報價 → 查表 350 × 2 + 運費 70 = 770，並轉為已報價',
      quoted.status === '已報價' && quoted.total_twd === 770 && quoted.items[0].unit_price_twd === 350, quoted);
    const adminView = (await api('GET', `/api/v1/orders/detail?order_id=${qo.order_id}`, { token: owner })).json.data;
    check('店主在後台看得到客人從前台下的品項（沒有 SKU 也不會消失）',
      adminView.items.length === 1 && adminView.items[0].name_zh === '藥妝店限定面膜', adminView.items);
    check('客人看到的訂單同步更新',
      (await B('GET', `/api/v1/orders/detail?order_id=${qo.order_id}`)).json.data.total_twd === 770);

    section('後台 — 對帳單');
    check('沒帶身分不能結算 → 401',
      (await api('POST', '/api/v1/statements/generate', { body: {} })).status === 401);
    check('小幫手不能結算',
      (await api('POST', '/api/v1/statements/generate', { token: helper, body: {} })).status === 401);
    const gen = (await api('POST', '/api/v1/statements/generate', { token: owner, body: { line_user_id: 'U_buyer1' } })).json.data;
    const mine1 = gen.created.find((c) => c.line_user_id === 'U_buyer1');
    check('結算：已報價的單歸進一張新對帳單', !!mine1 && mine1.total_amount >= 770, gen);
    check('重跑不會重複開單',
      (await api('POST', '/api/v1/statements/generate', { token: owner, body: { line_user_id: 'U_buyer1' } })).json.data.created.length === 0);
    check('n8n 帶機器金鑰也能結算（排程用）',
      (await api('POST', '/api/v1/statements/generate',
        { headers: { 'X-Notify-Token': 'smoke-notify-secret' }, body: { line_user_id: 'U_nobody' } })).status === 200);
    const cst = (await B('GET', '/api/v1/statements/list')).json.data.statements.find((x) => x.statement_id === mine1.statement_id);
    check('客人看得到這張對帳單與底下的訂單',
      !!cst && cst.payment_status === '待付款' && cst.order_ids.includes(qo.order_id), cst);
    const pend = (await api('POST', '/api/v1/notify/pending',
      { headers: { 'X-Notify-Token': 'smoke-notify-secret' }, body: { limit: 50 } })).json.data.notifications;
    check('對帳單通知已排入佇列，等 n8n 發 LINE',
      pend.some((n) => n.kind === 'statement' && n.statement_id === mine1.statement_id), pend.map((n) => n.kind));
    check('金額對不上不自動認列 → 409',
      (await api('POST', '/api/v1/statements/reconcile',
        { token: owner, body: { statement_id: mine1.statement_id, amount_twd: 1 } })).json.error?.code === 'AMOUNT_MISMATCH');
    const rec = (await api('POST', '/api/v1/statements/reconcile',
      { token: owner, body: { statement_id: mine1.statement_id, amount_twd: mine1.total_amount } })).json.data;
    check('核帳 → 對帳單已核對', rec.payment_status === '已核對', rec);
    check('底下的訂單一起變成已付款',
      (await B('GET', `/api/v1/orders/detail?order_id=${qo.order_id}`)).json.data.paid === true);

    section('拍照辨識迴路（Storage ＋ 領工作 ＋ 回寫）');
    const jpgUrl = 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg-bytes').toString('base64');
    const shot = (await B('POST', '/api/v1/cart/add-image',
      { body: { file_name: 'ocr_temp_abcd1234_202609231100001.jpg', data: jpgUrl } })).json.data;
    check('照片存進 Storage 的私有空間，依客人分資料夾',
      storageMock.objects.has('cart/U_buyer1/ocr_temp_abcd1234_202609231100001.jpg'), [...storageMock.objects.keys()]);
    check('上傳時帶的是伺服器端的 service key',
      storageMock.requests.some((r) => r.url.includes('/object/cart-images/') && r.apikey === 'smoke-supabase-secret'));
    check('客人拿到的是短效簽名網址（15 分鐘），不是永久連結',
      typeof shot.image_url === 'string' && shot.image_url.startsWith(STORAGE_MOCK_URL + '/storage/v1/object/sign/')
      && storageMock.lastExpiresIn === 900, shot.image_url);
    check('回應裡不含 service key', !JSON.stringify(shot).includes('smoke-supabase-secret'));

    const before = (await B('GET', '/api/v1/cart/list')).json.data.length;
    const upFail = await B('POST', '/api/v1/cart/add-image',
      { body: { file_name: 'ocr_temp_failfail_202609231100002.jpg', data: jpgUrl } });
    check('Storage 掛了 → 503 讓前台重試，而且不會多出一筆卡住的品項',
      upFail.status === 503 && upFail.json.error.code === 'UPLOAD_FAILED'
      && (await B('GET', '/api/v1/cart/list')).json.data.length === before, upFail.json);
    const noImg = (await B('POST', '/api/v1/cart/add-image',
      { body: { file_name: 'ocr_temp_abcd1234_202609231100003.jpg', data: 'not-a-data-url' } })).json.data;

    check('n8n 沒帶金鑰領不到工作',
      (await api('POST', '/api/v1/ocr/pending', { body: {} })).status === 401);
    const jobs = (await api('POST', '/api/v1/ocr/pending',
      { headers: { 'X-Notify-Token': 'smoke-notify-secret' }, body: { limit: 10 } })).json.data;
    const job = jobs.jobs.find((j) => j.cart_id === shot.cart_id);
    check('n8n 領到剛拍的那張，附簽名網址', !!job && job.image_url.startsWith(STORAGE_MOCK_URL), jobs);
    check('沒有圖的拍照品項不發給 n8n（辨識不了）', !jobs.jobs.some((j) => j.cart_id === noImg.cart_id));
    const again = (await api('POST', '/api/v1/ocr/pending',
      { headers: { 'X-Notify-Token': 'smoke-notify-secret' }, body: { limit: 10 } })).json.data;
    check('租約中，第二個 n8n 執行不會領到同一張', !again.jobs.some((j) => j.cart_id === shot.cart_id));

    await api('POST', '/api/v1/ocr/result', { headers: { 'X-Notify-Token': 'smoke-notify-secret' },
      body: { cart_id: shot.cart_id, name: 'Pigeon 奶瓶 240ml', jpy_taxed: 1089, ai_confidence: 'high' } });
    const done = (await B('GET', '/api/v1/cart/list')).json.data.find((c) => c.cart_id === shot.cart_id);
    check('辨識完成：品名、查表價（¥1089 → 400）、ocr_done 都到位',
      done.name === 'Pigeon 奶瓶 240ml' && done.price_twd === 400 && done.ocr_done === true, done);

    const blurry = (await B('POST', '/api/v1/cart/add-image',
      { body: { file_name: 'ocr_temp_blurry00_202609231100004.jpg', data: jpgUrl } })).json.data;
    await api('POST', '/api/v1/ocr/pending',
      { headers: { 'X-Notify-Token': 'smoke-notify-secret' }, body: { limit: 10 } });
    await api('POST', '/api/v1/ocr/result', { headers: { 'X-Notify-Token': 'smoke-notify-secret' },
      body: { cart_id: blurry.cart_id, jpy_taxed: null, ai_confidence: 'low' } });
    const gaveUp = (await B('GET', '/api/v1/cart/list')).json.data.find((c) => c.cart_id === blurry.cart_id);
    check('AI 認不出來也算辨識結束：前台不會永遠停在「辨識中」，並請客人自己填',
      gaveUp.ocr_done === true && gaveUp.price_twd === null && /自行填寫/.test(gaveUp.note), gaveUp);
    await B('POST', '/api/v1/cart/confirm', { body: { cart_ids: [shot.cart_id] } });
    const po = (await B('POST', '/api/v1/orders/checkout',
      { body: { cart_ids: [shot.cart_id], pickup: { type: 'cvs' }, invoice: { type: 'carrier' } } })).json.data;
    const pod = (await api('GET', `/api/v1/orders/detail?order_id=${po.order_id}`, { token: owner })).json.data;
    check('店主在後台訂單明細看得到客人拍的照片（簽名網址）',
      typeof pod.items[0].image_url === 'string' && pod.items[0].image_url.startsWith(STORAGE_MOCK_URL), pod.items[0]);

    section('上線健檢 /api/v1/health');
    const hPublic = await api('GET', '/api/v1/health');
    check('不帶 token 也答得出話', hPublic.status === 200 && hPublic.json.ok, hPublic.json);
    check('資料庫探測為通', hPublic.json.data.db.up === true, hPublic.json.data.db);
    check('連線模式已脫敏（只回模式與埠）', /^local:\d+$/.test(hPublic.json.data.db.mode), hPublic.json.data.db.mode);
    check('有成員時，未登入看不到詳細內容',
      hPublic.json.data.detail === null && !!hPublic.json.data.detail_hint, hPublic.json.data);

    const hOwner = (await api('GET', '/api/v1/health', { token: owner })).json.data;
    check('店主看得到詳細內容', !!hOwner.detail && hOwner.detail.open_reason === '店主 token');
    check('資料表一張不缺', hOwner.detail.schema.missing.length === 0, hOwner.detail.schema);
    check('必要環境變數全部就緒',
      hOwner.detail.config.filter((c) => c.required && !c.set).length === 0,
      hOwner.detail.config.filter((c) => c.required && !c.set).map((c) => c.key));
    check('刻意不設的 NOTIFY_HOOK_URL 標為未設且非必要',
      hOwner.detail.config.some((c) => c.key === 'NOTIFY_HOOK_URL' && c.set === false && c.required === false));
    check('店家設定已填完，不再列為缺項', hOwner.detail.shop_settings_missing.length === 0, hOwner.detail.shop_settings_missing);
    check('狀態為 ok 且無待辦', hOwner.status === 'ok' && hOwner.detail.blocking.length === 0, hOwner.detail.blocking);
    check('筆數看得到而且合理', hOwner.detail.rows.order_status_rules > 0 && hOwner.detail.rows.price_table > 0, hOwner.detail.rows);

    const hMachine = (await api('GET', '/api/v1/health', { headers: { 'X-Notify-Token': 'smoke-notify-secret' } })).json.data;
    check('n8n 帶機器金鑰看得到詳細內容', !!hMachine.detail && /機器金鑰/.test(hMachine.detail.open_reason));
    check('機器金鑰錯了就看不到',
      (await api('GET', '/api/v1/health', { headers: { 'X-Notify-Token': 'wrong-secret-here' } })).json.data.detail === null);

    // 健檢回的是「有沒有設」，不是「設成什麼」——這條守住金鑰與收款帳號。
    const hDump = JSON.stringify(hOwner);
    check('回應不含收款帳號', !hDump.includes(ACCT));
    check('回應不含任何金鑰值',
      !hDump.includes('smoke-notify-secret') && !hDump.includes('smoke-test-signing-key')
      && !hDump.includes('smoke-test-session-key'));
    check('回應不含連線字串', !hDump.includes('postgres://') && !hDump.includes('postgresql://'));

    section('後台設定 — 運費（結帳與首頁同一個來源）');
    check('首頁回傳運費，未設定時為暫定 70／120',
      JSON.stringify((await B('GET', '/api/v1/home/summary')).json.data.shop.ship_fee) === JSON.stringify({ cvs: 70, home: 120 }));
    check('運費不能是負數',
      (await api('POST', '/api/v1/settings/shop', { token: owner, body: { ship_fee_cvs: -1 } })).status === 400);
    check('小幫手不能改運費',
      (await api('POST', '/api/v1/settings/shop', { token: helper, body: { ship_fee_cvs: 1 } })).status === 403);
    await api('POST', '/api/v1/settings/shop', { token: owner, body: { ship_fee_cvs: 90, ship_fee_home: 150 } });
    check('改了運費，首頁跟著變',
      JSON.stringify((await B('GET', '/api/v1/home/summary')).json.data.shop.ship_fee) === JSON.stringify({ cvs: 90, home: 150 }));
    const feeItem = (await B('POST', '/api/v1/cart/add-text', { body: { name: '運費測試品', jpy_taxed: 500, qty: 1 } })).json.data;
    await B('POST', '/api/v1/cart/confirm', { body: { cart_ids: [feeItem.cart_id] } });
    const feeOrder = (await B('POST', '/api/v1/orders/checkout',
      { body: { cart_ids: [feeItem.cart_id], pickup: { type: 'cvs' }, invoice: { type: 'carrier' } } })).json.data;
    check('改了運費，結帳實收也跟著變', feeOrder.ship_fee_twd === 90, feeOrder.ship_fee_twd);
    await api('POST', '/api/v1/settings/shop', { token: owner, body: { ship_fee_cvs: '', ship_fee_home: '' } });
    await api('POST', '/api/v1/settings/shop', { token: owner, body: { bank_holder: '冉冉國際企業有限公司' } });
    check('首頁回傳收款戶名', (await B('GET', '/api/v1/home/summary')).json.data.shop.bank_holder === '冉冉國際企業有限公司');
    check('清空運費回到暫定值',
      (await B('GET', '/api/v1/home/summary')).json.data.shop.ship_fee.cvs === 70);

    section('後台設定 — 價目表');
    const pt0 = (await api('GET', '/api/v1/settings/price-table', { token: helper })).json.data.rows;
    check('小幫手看得到價目表', pt0.length === 11);
    const PT = (token, rows) => api('POST', '/api/v1/settings/price-table', { token, body: { rows } });
    check('小幫手不能改價目表', (await PT(helper, pt0)).status === 403);
    check('空的價目表被拒絕', (await PT(owner, [])).json.error?.code === 'BAD_PRICE_TABLE');
    check('日幣上限重複被拒絕',
      (await PT(owner, [{ jpy_taxed_max: 500, twd: 200 }, { jpy_taxed_max: 500, twd: 210 }])).json.error?.code === 'BAD_PRICE_TABLE');
    check('日幣較高卻較便宜被拒絕（打錯字）',
      (await PT(owner, [{ jpy_taxed_max: 500, twd: 200 }, { jpy_taxed_max: 1000, twd: 20 }])).json.error?.code === 'BAD_PRICE_TABLE');
    check('小數售價被拒絕',
      (await PT(owner, [{ jpy_taxed_max: 500, twd: 199.5 }])).json.error?.code === 'BAD_PRICE_TABLE');
    check('被拒絕時原價目表一列都沒動',
      JSON.stringify((await api('GET', '/api/v1/settings/price-table', { token: owner })).json.data.rows) === JSON.stringify(pt0));
    const ptSaved = (await PT(owner, [{ jpy_taxed_max: 1000, twd: 400 }, { jpy_taxed_max: 300, twd: 150 }])).json.data;
    check('店主可存，伺服器依日幣排序', ptSaved.rows.length === 2 && ptSaved.rows[0].jpy_taxed_max === 300, ptSaved.rows);
    check('客人首頁的價目表立即更新',
      JSON.stringify((await B('GET', '/api/v1/home/summary')).json.data.price_table) === JSON.stringify(ptSaved.rows));
    check('新的報價照新價目表換算',
      (await B('POST', '/api/v1/cart/add-text', { body: { name: '換價測試品', jpy_taxed: 500, qty: 1 } })).json.data.price_twd === 400);
    check('已成立的訂單不跟著改價',
      (await B('GET', '/api/v1/orders/list')).json.data.find((o) => o.order_id === feeOrder.order_id).total_twd === feeOrder.total_twd);
    const ptAudit = JSON.stringify((await api('GET', '/api/v1/audit/list?limit=50', { token: owner })).json.data);
    check('稽核軌跡記下改前改後', ptAudit.includes('settings.price_table'));
    await PT(owner, pt0);
    check('價目表還原', JSON.stringify((await api('GET', '/api/v1/settings/price-table', { token: owner })).json.data.rows) === JSON.stringify(pt0));

    section('後台設定 — 成員與權限');
    check('小幫手看不到成員管理', (await api('GET', '/api/v1/members/admin-list', { token: helper })).status === 403);
    const ml = (await api('GET', '/api/v1/members/admin-list', { token: owner })).json.data;
    check('員工清單不含客人、客人清單不含員工',
      ml.staff.every((m) => m.role !== 'buyer') && ml.buyers.every((m) => m.role === 'buyer') && ml.staff.length === 4, ml.staff.length);
    check('可用名稱搜尋客人',
      (await api('GET', '/api/v1/members/admin-list?q=' + encodeURIComponent('Kiki'), { token: owner })).json.data.buyers.map((m) => m.line_user_id).join() === 'U_buyer3');
    check('搜尋字串裡的 % 不會變成萬用字元',
      (await api('GET', '/api/v1/members/admin-list?q=%25', { token: owner })).json.data.buyers.length === 0);
    const SR = (token, line_user_id, role) => api('POST', '/api/v1/members/set-role', { token, body: { line_user_id, role } });
    check('小幫手不能調整角色', (await SR(helper, 'U_buyer2', 'helper')).status === 403);
    check('不能從後台給出店主權限', (await SR(owner, 'U_buyer2', 'owner')).json.error?.code === 'BAD_ROLE');
    check('不能從後台拿走店主權限（連店主自己也不行）', (await SR(owner, 'U_owner', 'buyer')).json.error?.code === 'OWNER_LOCKED');
    check('查無此人 → 404', (await SR(owner, 'U_nobody', 'helper')).status === 404);
    const up = (await SR(owner, 'U_buyer2', 'packer')).json.data;
    check('客人升為理貨', up.changed && up.member.role === 'packer');
    check('升級後移到員工清單',
      (await api('GET', '/api/v1/members/admin-list', { token: owner })).json.data.staff.some((m) => m.line_user_id === 'U_buyer2'));
    const packer2 = buyer2;
    check('新理貨進得了出貨、看不到價格',
      (await api('GET', '/api/v1/packing/list', { token: packer2 })).status === 200
      && (await api('GET', '/api/v1/settings/shop', { token: packer2 })).status === 403);
    check('調回客人', (await SR(owner, 'U_buyer2', 'buyer')).json.data.member.role === 'buyer');
    check('調回後就進不了出貨', (await api('GET', '/api/v1/packing/list', { token: packer2 })).status === 403);
    const MA = (body) => api('POST', '/api/v1/members/add', { token: owner, body });
    const NEW_ID = 'U' + 'a1'.repeat(16);
    check('LINE userId 格式錯被拒絕', (await MA({ line_user_id: '@heeehababy', nickname: '新人', role: 'helper' })).json.error?.code === 'BAD_LINE_USER_ID');
    check('不能直接新增店主', (await MA({ line_user_id: NEW_ID, nickname: '新人', role: 'owner' })).json.error?.code === 'BAD_ROLE');
    check('稱呼重複被拒絕', (await MA({ line_user_id: NEW_ID, nickname: '小美', role: 'helper' })).json.error?.code === 'NICKNAME_TAKEN');
    check('新增日本小幫手', (await MA({ line_user_id: NEW_ID, nickname: '新人', role: 'helper' })).json.data?.member.role === 'helper');
    check('重複新增被拒絕', (await MA({ line_user_id: NEW_ID, nickname: '新人2', role: 'helper' })).json.error?.code === 'MEMBER_EXISTS');
    const mAudit = JSON.stringify((await api('GET', '/api/v1/audit/list?limit=50', { token: owner })).json.data);
    check('角色異動都記在稽核軌跡', mAudit.includes('members.role') && mAudit.includes('members.add'));

    section('後台 LINE 登入（白名單就是 members）');
    const cfg = (await api('GET', '/api/v1/auth/config')).json.data;
    check('登入頁拿得到 LIFF ID，兩扇門都開著（過渡期）',
      cfg.line.liff_id === '2011699944-smokeAdm' && cfg.line.ready === true && cfg.password === true, cfg);
    const LL = (id_token) => api('POST', '/api/v1/auth/line', { body: { id_token } });
    const ownerLine = await LL('mock-idtoken:U_owner:周方');
    check('店主用 LINE 登入拿到 token 與店主權限',
      ownerLine.status === 200 && ownerLine.json.data.member.role === 'owner'
      && ownerLine.json.data.capabilities.includes('settings.write'), ownerLine.json);
    check('LINE 換來的 token 跟密碼登入的一樣能用',
      (await api('GET', '/api/v1/auth/me', { token: ownerLine.json.data.token })).json.data.member.line_user_id === 'U_owner');
    check('小幫手用 LINE 登入，拿到的是小幫手的權限',
      (await LL('mock-idtoken:U_helper1')).json.data.capabilities.includes('settings.write') === false);
    check('店主從後台新增的員工，可以直接用 LINE 登入',
      (await LL(`mock-idtoken:${NEW_ID}`)).json.data?.member.role === 'helper');
    const buyerLine = await LL('mock-idtoken:U_buyer1');
    check('客人用 LINE 登入後台 → 403 NOT_STAFF',
      buyerLine.status === 403 && buyerLine.json.error.code === 'NOT_STAFF', buyerLine.json);
    check('擋下時附上他自己的 LINE userId，店主才知道要加誰',
      /U_buyer1/.test(buyerLine.json.error.message), buyerLine.json.error.message);
    const STRANGER = 'U' + 'b2'.repeat(16);
    check('陌生的 LINE 帳號 → 403', (await LL(`mock-idtoken:${STRANGER}:路人`)).status === 403);
    check('陌生人不會被順手建成會員（後台不自動建檔）',
      (await api('GET', `/api/v1/members/admin-list?q=${STRANGER}`, { token: owner })).json.data.buyers.length === 0);
    check('假造或過期的 ID Token → 401', (await LL('eyJhbGciOi.forged.token')).status === 401);
    check('沒帶 id_token → 400', (await LL('')).status === 400);
    const lAudit = JSON.stringify((await api('GET', '/api/v1/audit/list?limit=50', { token: owner })).json.data);
    check('LINE 登入記在稽核軌跡', /"via":"line"|via.{0,6}line/.test(lAudit));

    // 關掉共用密碼入口：另開一台不接資料庫的伺服器就夠了 —— 密碼入口在碰資料庫之前就擋掉。
    const OFF_PORT = PORT + 7;
    const off = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
      cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...envFor('postgres://nobody@127.0.0.1:1/none'), PORT: String(OFF_PORT), ADMIN_PASSWORD_LOGIN: 'off' },
    });
    try {
      const OFF = `http://127.0.0.1:${OFF_PORT}`;
      let offCfg = null;
      for (let i = 0; i < 100 && !offCfg; i++) {
        try { offCfg = await (await fetch(OFF + '/api/v1/auth/config')).json(); } catch { await new Promise((r) => setTimeout(r, 100)); }
      }
      check('ADMIN_PASSWORD_LOGIN=off：登入頁不再顯示密碼入口', offCfg && offCfg.data.password === false, offCfg);
      const offPersonas = await (await fetch(OFF + '/api/v1/auth/personas', { headers: { 'X-Admin-Password': ADMIN_PW } })).json();
      check('密碼正確也拿不到人員名單（入口已關）', offPersonas.error?.code === 'PASSWORD_LOGIN_DISABLED', offPersonas);
      const offLogin = await (await fetch(OFF + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ line_user_id: 'U_owner', password: ADMIN_PW }) })).json();
      check('密碼正確也換不到 token（入口已關）', offLogin.error?.code === 'PASSWORD_LOGIN_DISABLED', offLogin);
    } finally { off.kill(); }
  } catch (e) {
    failed++;
    console.error('\n測試中止：', e);
  } finally {
    storageSrv.close();
    child.kill();
    if (harness) harness.child.kill();
  }

  console.log(`\n通過 ${passed} 項，失敗 ${failed} 項`);
  process.exit(failed ? 1 : 0);
})();
