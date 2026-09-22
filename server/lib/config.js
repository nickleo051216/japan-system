'use strict';
/**
 * Config. Every secret comes from the environment (README §0.2 rule 3, §10).
 * Nothing here is ever written to disk or returned by an API.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Minimal .env loader so the prototype starts without extra dependencies.
const envFile = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const ON_VERCEL = !!process.env.VERCEL;

// Prototype convenience: an unset signing key gets an ephemeral random one so
// nobody is tempted to commit a default. Labels printed before a restart stop
// verifying after it — which is the correct behaviour for a rotated key.
//
// On Vercel one deployment answers from several instances, and a per-instance
// random key would make a token issued by one instance fail on the next. So the
// demo derives a key from the deployment's own public URL — stable across the
// instances of one deployment, different for every deployment, and not a secret
// committed to the repository. Setting the real env var overrides it, and any
// deployment handling real orders MUST set it.
const DERIVED_KEYS = [];
function keyOrEphemeral(name) {
  const v = process.env[name];
  if (v && v.trim()) return v.trim();
  // Remember the fallback so /api/v1/health can report the key as unset
  // without ever reading — let alone returning — its value.
  DERIVED_KEYS.push(name);
  if (ON_VERCEL) {
    const anchor = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || 'hb-demo';
    console.warn(`[config] ${name} 未設定，示範站以部署網址推導金鑰。正式環境必須設定真正的金鑰。`);
    return crypto.createHash('sha256').update(`hb-demo:${name}:${anchor}`).digest('hex');
  }
  const generated = crypto.randomBytes(32).toString('hex');
  console.warn(`[config] ${name} 未設定，本次啟動使用臨時隨機金鑰（重啟後失效）。正式環境必須設定。`);
  return generated;
}

// Receipt images only. The database itself lives in Supabase (DATABASE_URL);
// nothing durable is kept on disk any more. Serverless filesystems are
// read-only apart from /tmp, so on Vercel uploads land there and disappear on
// a cold start — acceptable for the demo, replaced by object storage later.
const defaultUploadDir = ON_VERCEL
  ? '/tmp/hb-prototype/uploads'
  : path.join(__dirname, '..', '..', 'data', 'uploads');

module.exports = {
  onVercel: ON_VERCEL,
  port: Number(process.env.PORT || 3000),
  // 哪幾把簽章金鑰是推導出來的（＝環境變數沒設）。健檢用，只回報名稱不回報值。
  derivedKeys: DERIVED_KEYS,
  // Supabase → Connect → Transaction pooler (port 6543). Read by lib/db.js
  // straight from the environment; exposed here only so startup can tell the
  // operator it is missing instead of failing on the first query.
  databaseUrl: process.env.DATABASE_URL || '',
  uploadDir: path.resolve(process.env.UPLOAD_DIR || defaultUploadDir),
  // 後台登入的共用密碼。刻意沒有預設值也沒有推導 fallback —— 沒設就是任何人
  // 都登不進去（fail closed）。這是 LIFF ID Token 上線前的過渡措施，
  // 因為雛型的 /auth/login 只比對 line_user_id，而那支 API 是公開的。
  adminLoginPassword: (process.env.ADMIN_LOGIN_PASSWORD || '').trim(),
  // 通知佇列：n8n 取件時要帶的共用金鑰，以及後端排隊後戳 n8n 的網址。
  // 兩者都沒設也不影響出貨 —— 通知會留在佇列裡等人來拿。
  notifyToken: (process.env.NOTIFY_SHARED_SECRET || '').trim(),
  notifyHookUrl: (process.env.NOTIFY_HOOK_URL || '').trim(),
  qrSigningKey: keyOrEphemeral('QR_SIGNING_KEY'),
  sessionSigningKey: keyOrEphemeral('SESSION_SIGNING_KEY'),
  defaultFxRate: Number(process.env.FX_JPY_TWD || 0.215),
};
