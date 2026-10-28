'use strict';
/**
 * 綠界（ECPay）全方位金流 AIO：檢查碼、金鑰、環境、查詢。
 *
 * 金鑰只存一份，在 Supabase Vault（009_ecpay.sql）：
 *   - 特店編號、末四碼、驗證結果 → payment_credentials（不是祕密）
 *   - HashKey、HashIV 本體        → vault.secrets（加密保存）
 * 任何回應、log、稽核都只出末四碼。這個檔案以外的程式碼拿不到完整金鑰，
 * 只能呼叫 sign／verify。
 *
 * 環境：settings.ecpay_env = 'stage' | 'live'，沒設是 stage。
 * stage 是綠界的測試環境（不會真的扣款），所以 stage 時只有店家自己的帳號能刷卡 ——
 * 否則客人拿公開的測試卡號就能「付清」對帳單。
 */
const crypto = require('node:crypto');
const db = require('./db');

const ENVS = ['stage', 'live'];
const BASE = {
  stage: 'https://payment-stage.ecpay.com.tw',
  live: 'https://payment.ecpay.com.tw',
};
const CHECKOUT_PATH = '/Cashier/AioCheckOut/V5';
const QUERY_PATH = '/Cashier/QueryTradeInfo/V5';

// ---- 檢查碼（CheckMacValue，SHA256）---------------------------------------
//
// 綠界的規則來自 PHP：參數依 key 不分大小寫排序 → 前後夾 HashKey／HashIV →
// PHP urlencode → 轉小寫 → 把 .NET 不編碼的 7 個字元還原 → SHA256 → 轉大寫。
// Node 的 encodeURIComponent 跟 PHP urlencode 有三處不同，要補：
//   空格 %20 → +、~ 要編成 %7e、' 要編成 %27（PHP 會編，encodeURIComponent 不編）。

function ecpayUrlEncode(source) {
  let s = encodeURIComponent(source).replace(/%20/g, '+').replace(/~/g, '%7e').replace(/'/g, '%27');
  s = s.toLowerCase();
  for (const [from, to] of [['%2d', '-'], ['%5f', '_'], ['%2e', '.'], ['%21', '!'], ['%2a', '*'], ['%28', '('], ['%29', ')']]) {
    s = s.split(from).join(to);
  }
  return s;
}

// PHP 用 strcasecmp 排序：先轉小寫，再逐位元組比。不用 localeCompare，避免受語系影響。
const byKey = (a, b) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
};

function checkMac(params, hashKey, hashIv) {
  const body = Object.keys(params).filter((k) => k !== 'CheckMacValue').sort(byKey)
    .map((k) => `${k}=${params[k] ?? ''}`).join('&');
  const raw = `HashKey=${hashKey}&${body}&HashIV=${hashIv}`;
  return crypto.createHash('sha256').update(ecpayUrlEncode(raw), 'utf8').digest('hex').toUpperCase();
}

/** 驗證對方送來的檢查碼。一定要用 timing-safe 比較。 */
function verifyMac(params, hashKey, hashIv) {
  const got = Buffer.from(String(params.CheckMacValue || '').toUpperCase());
  const want = Buffer.from(checkMac(params, hashKey, hashIv));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// ---- 時間與交易編號 ---------------------------------------------------------

/** 綠界要台灣時間 yyyy/MM/dd HH:mm:ss。台灣沒有日光節約，固定 +8。 */
function taipeiStamp(date = new Date()) {
  const d = new Date(date.getTime() + 8 * 3600_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} `
    + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** MerchantTradeNo：永久唯一、只能英數、最長 20。HB + 台灣時間 12 碼 + 隨機 6 碼 = 20。 */
function newTradeNo(date = new Date()) {
  const t = taipeiStamp(date).replace(/\D/g, '').slice(2);          // yyMMddHHmmss
  const rand = crypto.randomBytes(6).toString('base64').replace(/[^A-Za-z0-9]/g, '').padEnd(6, '0').slice(0, 6);
  return `HB${t}${rand}`;
}

const last4 = (s) => String(s || '').slice(-4);

// ---- 環境與金鑰 -------------------------------------------------------------

async function currentEnv() {
  const v = await db.setting('ecpay_env', '');
  return v === 'live' ? 'live' : 'stage';
}

const secretName = (env, part) => `ecpay_${env}_${part}`;

async function readSecret(name) {
  const row = await db.one('SELECT decrypted_secret AS v FROM vault.decrypted_secrets WHERE name = ?', name);
  return row ? row.v : null;
}

async function writeSecret(name, value) {
  const row = await db.one('SELECT id FROM vault.secrets WHERE name = ?', name);
  if (row) await db.run('SELECT vault.update_secret(?::uuid, ?)', row.id, value);
  else await db.run("SELECT vault.create_secret(?, ?, '綠界金流金鑰（後台「金流設定」寫入）')", value, name);
}

/** 給後台看的樣子：沒有完整金鑰。 */
const publicShape = (row) => (row ? {
  configured: true, merchant_id: row.merchant_id, key_last4: row.key_last4, iv_last4: row.iv_last4,
  verify_ok: !!row.verify_ok, verify_msg: row.verify_msg || null, verified_at: row.verified_at || null,
  updated_at: row.updated_at,
} : { configured: false });

async function credentialRow(env) {
  return db.one('SELECT * FROM payment_credentials WHERE env = ?', env);
}

/**
 * 完整金鑰。只給這個模組內的 sign／verify 和交易流程用，不要往外傳。
 * 回傳 null = 這個環境還沒設定（或 Vault 裡少了一半）。
 */
async function credentials(env) {
  const row = await credentialRow(env);
  if (!row) return null;
  const [hashKey, hashIv] = await Promise.all([
    readSecret(secretName(env, 'hash_key')), readSecret(secretName(env, 'hash_iv'))]);
  if (!hashKey || !hashIv) return null;
  return { env, merchantId: row.merchant_id, hashKey, hashIv, verified: !!row.verify_ok };
}

async function saveCredentials(env, { merchantId, hashKey, hashIv, verifyMsg }, actor) {
  await db.tx(async () => {
    await writeSecret(secretName(env, 'hash_key'), hashKey);
    await writeSecret(secretName(env, 'hash_iv'), hashIv);
    await db.run(
      `INSERT INTO payment_credentials (env, merchant_id, key_last4, iv_last4, verified_at, verify_ok, verify_msg, updated_by, updated_at)
       VALUES (?,?,?,?,now(),true,?,?,now())
       ON CONFLICT (env) DO UPDATE SET merchant_id = excluded.merchant_id, key_last4 = excluded.key_last4,
         iv_last4 = excluded.iv_last4, verified_at = now(), verify_ok = true, verify_msg = excluded.verify_msg,
         updated_by = excluded.updated_by, updated_at = now()`,
      env, merchantId, last4(hashKey), last4(hashIv), verifyMsg || null, actor);
  });
}

// ---- 查詢（QueryTradeInfo）-------------------------------------------------

/** 綠界回的是 key=value&… 的字串。 */
const parseEncoded = (text) => Object.fromEntries(new URLSearchParams(String(text || '').trim()));

async function queryTrade(creds, merchantTradeNo) {
  const params = {
    MerchantID: creds.merchantId,
    MerchantTradeNo: merchantTradeNo,
    TimeStamp: String(Math.floor(Date.now() / 1000)),     // 3 分鐘有效，每次重新產生
  };
  params.CheckMacValue = checkMac(params, creds.hashKey, creds.hashIv);
  const res = await fetch(BASE[creds.env] + QUERY_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw Object.assign(new Error(`綠界回 HTTP ${res.status}`), { code: 'ECPAY_HTTP', status: 502 });
  return parseEncoded(await res.text());
}

/**
 * 用一筆不存在的交易編號問綠界，看金鑰對不對：
 *   - 10200073 = 檢查碼驗證失敗 → HashKey／HashIV 錯
 *   - 10200047 = 查無此訂單      → 金鑰對（綠界算得出同一個檢查碼才會往下查訂單）
 *   - 綠界回的資料若帶 CheckMacValue，也要用同一組金鑰驗得過
 * 回 { ok, message }。連不上綠界時丟錯，讓呼叫端決定（後台會說「暫時連不上綠界」）。
 */
async function verifyCredentials(creds) {
  let r;
  try {
    r = await queryTrade(creds, `HBVERIFY${Date.now().toString().slice(-12)}`);
  } catch (e) {
    if (e.code === 'ECPAY_HTTP') throw e;
    throw Object.assign(new Error('暫時連不上綠界，請稍後再試'), { code: 'ECPAY_UNREACHABLE', status: 502 });
  }
  const status = String(r.TradeStatus || r.RtnCode || '');
  if (r.CheckMacValue && !verifyMac(r, creds.hashKey, creds.hashIv)) {
    return { ok: false, message: '綠界回傳的檢查碼對不上：HashKey 或 HashIV 不正確' };
  }
  if (status === '10200073') return { ok: false, message: 'HashKey 或 HashIV 不正確（綠界：檢查碼驗證失敗）' };
  if (status === '10200047' || status === '0' || status === '1' || status === '10200095') {
    return { ok: true, message: '綠界驗證通過' };
  }
  const msg = r.RtnMsg ? `：${String(r.RtnMsg).slice(0, 100)}` : '';
  return { ok: false, message: `綠界回傳代碼 ${status || '（空白）'}${msg}，請確認特店編號與環境是否對應` };
}

module.exports = {
  ENVS, BASE, CHECKOUT_PATH, QUERY_PATH,
  ecpayUrlEncode, checkMac, verifyMac, taipeiStamp, newTradeNo, last4,
  currentEnv, credentials, credentialRow, saveCredentials, publicShape,
  queryTrade, verifyCredentials, parseEncoded,
};
