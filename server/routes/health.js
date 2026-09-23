'use strict';
/**
 * 上線健檢 —— GET /api/v1/health
 *
 * 一個網址回答三件事：這個部署活著嗎、設定齊了嗎、資料庫是不是我以為的那個。
 * 換環境重建、交接給別人、或 n8n 每天自動巡檢時，都只需要看這一支。
 *
 * 兩種詳細程度：
 *   公開版  只有 status / db.up / checked_at。給 uptime 監控用，不洩漏任何設定。
 *   詳細版  多了「哪幾個環境變數沒設」「哪幾張表不見了」「幾筆資料」「還差什麼才能上線」。
 *
 * 詳細版在三種情況下打開：
 *   1. 帶店主的 token（settings.write）
 *   2. 帶 n8n 的 X-Notify-Token
 *   3. 「此刻沒有任何人能登入」—— 資料庫連不上，或 members 一筆都沒有。
 *
 * 第 3 條看起來像後門，但它補的是一個真實的死結：登入要查 members，
 * 查 members 要先連得上資料庫。資料庫掛掉時沒有人拿得到 token，而那正是
 * 最需要看「DATABASE_URL 到底設了沒」的時候。代價是這段期間會洩漏
 * 「某某環境變數未設」這件事 —— 例如 QR_SIGNING_KEY 未設，等於告訴人家
 * 標籤簽章金鑰是從公開網址推導的。所以這個窗口只在「系統本來就還不能用」
 * 時是開的，第一個店主一建立、資料庫一正常，就自動關上。回應裡的
 * open_reason 會寫明它為什麼開著，伺服器日誌也會留一筆。
 *
 * 任何情況下都不回傳值：只回傳「有沒有設」。連線字串只換算成
 * 「transaction-pooler:6543」這種模式描述，不含主機、帳號、密碼。
 */
const crypto = require('node:crypto');
const db = require('../lib/db');
const config = require('../lib/config');
const auth = require('../lib/auth');
const { get, ok } = require('../lib/http');
const { SHOP_FIELDS } = require('./dashboard');

/** 程式真的會用到的資料表。少一張，對應的功能就會在執行時炸掉。 */
const REQUIRED_TABLES = [
  'members', 'batches', 'price_table', 'products', 'orders', 'order_items',
  'order_status_rules', 'order_status_log', 'broadcast', 'cart_items', 'wishlist',
  'statements', 'payments', 'procurements', 'shipments', 'logistics_bindings',
  'restock_watch', 'audit_log', 'settings', 'expenses', 'fx_history',
  'notifications', 'idempotency', 'notification_outbox',
];

/**
 * 後來的 migration 加在既有表上的欄位。表都在不代表這些都跑過了 ——
 * 少了它們，對應的功能會在執行時才炸，所以一樣要列出來。
 */
const REQUIRED_COLUMNS = [
  { table: 'cart_items', column: 'ocr_attempts', migration: '006_ocr_pipeline.sql', feature: '拍照辨識領不到工作' },
];

/** 值得數一數的表。數量本身就是診斷：規則表空了，每一次狀態轉換都會失敗。 */
const COUNTED_TABLES = [
  'members', 'orders', 'order_items', 'price_table',
  'order_status_rules', 'settings', 'notification_outbox',
];

const ENV_CHECKS = [
  { key: 'DATABASE_URL', required: true,
    isSet: () => !!config.databaseUrl,
    note: '沒設就完全連不上資料庫，所有 API 一律 500。' },
  { key: 'SESSION_SIGNING_KEY', required: true,
    isSet: () => !config.derivedKeys.includes('SESSION_SIGNING_KEY'),
    note: '未設定時改用部署網址推導。每次重新部署金鑰就變一次，所有人被登出。' },
  { key: 'QR_SIGNING_KEY', required: true,
    isSet: () => !config.derivedKeys.includes('QR_SIGNING_KEY'),
    note: '未設定時改用部署網址推導。已經印出來貼在箱子上的標籤，下次部署後會驗不過。' },
  { key: 'ADMIN_LOGIN_PASSWORD', required: config.adminPasswordLogin,
    isSet: () => !!config.adminLoginPassword,
    note: '共用密碼入口用。沒設的話密碼入口鎖死（刻意設計成鎖死，不是放行）；ADMIN_PASSWORD_LOGIN=off 時不需要。' },
  { key: 'ADMIN_LIFF_ID', required: !config.adminPasswordLogin,
    isSet: () => !!config.adminLiffId,
    note: '後台 LINE 登入用的 LIFF ID。沒設的話後台只能用共用密碼登入；密碼入口也關掉的話就沒有門可以進。' },
  { key: 'LINE_LOGIN_CHANNEL_ID', required: true,
    isSet: () => !!config.lineLoginChannelId,
    note: '沒設的話買家前台一律 503 —— LIFF 的 ID Token 無從驗證，不會退化成不驗身分。' },
  { key: 'SUPABASE_URL', required: true,
    isSet: () => !!config.supabaseUrl,
    note: '客人照片的存放處。沒設的話照片只存在 Vercel 暫存區，冷啟動就消失，n8n 也拿不到。' },
  { key: 'SUPABASE_SERVICE_KEY', required: true,
    isSet: () => !!config.supabaseServiceKey,
    note: '上傳照片與簽發短效網址用。只在伺服器端，絕不可放進前端。' },
  { key: 'NOTIFY_SHARED_SECRET', required: true,
    isSet: () => !!config.notifyToken,
    note: '沒設 /api/v1/notify/* 一律回 503，出貨推播會靜靜地不送出。' },
  { key: 'DB_POOL_MAX', required: false,
    isSet: () => !!(process.env.DB_POOL_MAX || '').trim(),
    note: '未設時用預設值 3。Supabase 的連線數有上限，尖峰前建議明確設定。' },
  { key: 'ADMIN_PASSWORD_LOGIN', required: false,
    isSet: () => !!(process.env.ADMIN_PASSWORD_LOGIN || '').trim(),
    note: '設成 off 就關掉後台的共用密碼入口，只留 LINE 登入。LINE 登入確認可用之後再關。' },
  { key: 'NOTIFY_HOOK_URL', required: false,
    isSet: () => !!config.notifyHookUrl,
    note: '沒設也不會壞，通知會留在佇列等 n8n 排程來拿，只是慢一兩分鐘。' },
];

/** 把連線字串換算成模式描述。不含主機、帳號、密碼 —— 只夠判斷「接對地方沒」。 */
function dbMode() {
  const url = config.databaseUrl;
  if (!url) return 'unset';
  try {
    const u = new URL(url);
    const port = u.port || '5432';
    if (/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) return `local:${port}`;
    if (/\.pooler\./.test(u.hostname)) {
      return port === '6543' ? 'transaction-pooler:6543' : `session-pooler:${port}`;
    }
    return `direct:${port}`;
  } catch {
    return 'unparseable';
  }
}

async function probeDb() {
  const started = Date.now();
  try {
    await db.one('SELECT 1 AS ok');
    return { up: true, latency_ms: Date.now() - started, mode: dbMode() };
  } catch (e) {
    // 真正的原因只進日誌，不進回應（I-03 規則 3）。
    console.error('[health] 資料庫探測失敗：', e.message);
    return { up: false, latency_ms: Date.now() - started, mode: dbMode() };
  }
}

async function readSchema() {
  const rows = await db.all(
    "SELECT table_name FROM information_schema.tables " +
    "WHERE table_schema = 'public' AND table_type = 'BASE TABLE'");
  const present = new Set(rows.map((r) => r.table_name));
  const cols = await db.all(
    "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'");
  const haveCol = new Set(cols.map((c) => `${c.table_name}.${c.column_name}`));
  return {
    present,
    report: {
      expected: REQUIRED_TABLES.length,
      present: REQUIRED_TABLES.filter((t) => present.has(t)).length,
      missing: REQUIRED_TABLES.filter((t) => !present.has(t)),
      missing_migrations: REQUIRED_COLUMNS
        .filter((c) => present.has(c.table) && !haveCol.has(`${c.table}.${c.column}`))
        .map((c) => ({ migration: c.migration, feature: c.feature })),
    },
  };
}

async function readCounts(present) {
  const tables = COUNTED_TABLES.filter((t) => present.has(t));
  if (!tables.length) return {};
  // 表名來自上面那個白名單，不是使用者輸入，所以直接組字串是安全的。
  const parts = tables.map((t) => `(SELECT count(*) FROM "${t}") AS "${t}"`);
  if (present.has('notification_outbox')) {
    parts.push("(SELECT count(*) FROM notification_outbox " +
               "WHERE status IN ('pending','sending','failed')) AS notify_waiting");
  }
  return await db.one('SELECT ' + parts.join(', '));
}

/** 只回缺哪幾個欄位的「標籤」，永遠不回值 —— 收款帳號不該出現在這裡。 */
async function readShopGaps(present) {
  if (!present.has('settings')) return null;
  const missing = [];
  for (const f of SHOP_FIELDS) {
    if (!f.required) continue;
    if (!(await db.setting(f.key, ''))) missing.push(f.label);
  }
  return missing;
}

function machineTokenOk(req) {
  const secret = config.notifyToken;
  const given = String((req && req.headers && req.headers['x-notify-token']) || '');
  if (!secret || !given) return false;
  const a = Buffer.from(secret);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * 誰看得到詳細版。第三條是安裝期窗口 —— 見檔頭說明：它只在「沒有任何人
 * 能登入」時開著，因為那時候要求登入等於把診斷鎖在門外。
 */
function detailGate({ actor, req, probe }) {
  if (auth.can(actor, 'settings.write')) return { allowed: true, reason: '店主 token' };
  if (machineTokenOk(req)) return { allowed: true, reason: '機器金鑰（X-Notify-Token）' };
  if (!probe.up) {
    // 只剩這一種真死結：登入要查 members，查 members 要先連得上資料庫。
    // 資料庫掛掉時沒有人拿得到 token，而那正是最需要看診斷的時候。
    //
    // 原本「members 為 0」也開放，已收掉（合約 v1.2 #1）：那時候資料庫是通的，
    // 機器金鑰照樣進得來，窗口沒有存在的必要，卻會讓買家前台的 /health 看到
    // 「後台密碼未設定」這類內部狀態。窗口愈窄愈好。
    const reason = '資料庫連不上，此刻無人能登入，開放診斷';
    console.warn('[health] 詳細健檢以緊急窗口開放：' + reason);
    return { allowed: true, reason };
  }
  return { allowed: false, hint: '詳細資訊需要店主登入，或帶上 X-Notify-Token。' };
}

/** 還差什麼才能上線 —— 照「先修哪一個」的順序排。 */
function blockers({ probe, envs, schema, counts, shopGaps }) {
  const out = [];
  if (!probe.up) {
    out.push(config.databaseUrl
      ? '資料庫連不上：DATABASE_URL 有設但連不過去，檢查密碼、專案是否暫停、是否用了 transaction pooler（6543）。'
      : 'DATABASE_URL 未設定，或設定後還沒重新部署。');
    return out;                       // 資料庫沒通，其餘都量不到，先修這個
  }
  for (const e of envs) if (e.required && !e.set) out.push(`${e.key} 未設定 —— ${e.note}`);
  if (schema && schema.missing.length) {
    out.push(`資料表少了 ${schema.missing.length} 張：${schema.missing.join('、')}。到 Supabase SQL Editor 依序跑 supabase/migrations/。`);
  }
  for (const m of (schema && schema.missing_migrations) || []) {
    out.push(`資料庫還沒跑 ${m.migration}：${m.feature}。到 Supabase SQL Editor 執行 supabase/migrations/${m.migration}。`);
  }
  if (counts && counts.order_status_rules === 0) {
    out.push('order_status_rules 是空的：狀態機沒有規則，任何訂單狀態轉換都會被擋下。');
  }
  if (counts && counts.price_table === 0) {
    out.push('price_table 是空的：算不出售價，下單與報價都會失敗。');
  }
  if (counts && counts.members === 0) {
    out.push('members 一個人都沒有：還沒有人能登入，後台進不去。需要先建立第一位店主。');
  }
  // 太短的共用密碼等於沒擋。只回報「太短」，不回報長度也不回報值。
  if (config.adminLoginPassword && config.adminLoginPassword.length < 16) {
    out.push('ADMIN_LOGIN_PASSWORD 太短：這是公開端點上的共用密碼，請改用 16 字以上的隨機字串。');
  }
  if (shopGaps && shopGaps.length) {
    out.push(`店家與收款設定未完成（${shopGaps.join('、')}）：客人會拿不到匯款帳號。到後台「設定 → 店家與收款設定」填寫。`);
  }
  return out;
}

function buildInfo() {
  return {
    env: process.env.VERCEL_ENV || (config.onVercel ? 'vercel' : 'local'),
    commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null,
    region: process.env.VERCEL_REGION || null,
    node: process.version,
  };
}

get('/api/v1/health', async ({ actor, req }) => {
  const checked_at = new Date().toISOString();
  const probe = await probeDb();

  let schema = null, counts = null, shopGaps = null;
  if (probe.up) {
    try {
      const s = await readSchema();
      schema = s.report;
      counts = await readCounts(s.present);
      shopGaps = await readShopGaps(s.present);
    } catch (e) {
      // 連得上但查不動（權限、schema 被改）。照樣回報，不要整支掛掉。
      console.error('[health] 讀取結構失敗：', e.message);
    }
  }

  const envs = ENV_CHECKS.map((c) => ({ key: c.key, required: c.required, set: c.isSet(), note: c.note }));
  const list = blockers({ probe, envs, schema, counts, shopGaps });
  const status = !probe.up ? 'down' : (list.length ? 'degraded' : 'ok');

  const data = { status, checked_at, db: probe };

  const gate = detailGate({ actor, req, probe });
  if (!gate.allowed) {
    data.detail = null;
    data.detail_hint = gate.hint;
    return ok(data);
  }

  data.detail = {
    open_reason: gate.reason,
    blocking: list,
    config: envs,
    schema,
    rows: counts,
    shop_settings_missing: shopGaps,
    build: buildInfo(),
  };
  return ok(data);
});
