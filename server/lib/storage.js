'use strict';
/**
 * 客人照片的存放處 —— Supabase Storage 的私有 bucket。
 *
 * 為什麼不是 Vercel 的 /tmp：serverless 每個實例的 /tmp 各自獨立、冷啟動就清空，
 * 圖可能在 n8n 來拿之前就不見了，而且別的實例根本讀不到。
 *
 * 為什麼是私有：客人拍的照片可能帶到收件資訊或臉。資料庫裡存的是
 * `storage:<路徑>` 這種參照，不是網址；要顯示時才換成 15 分鐘就失效的簽名網址。
 * service key 只在伺服器端，永遠不進 API 回應。
 *
 * 本機開發沒設 SUPABASE_URL 時退回寫硬碟（/uploads/…），只為了能跑起來。
 * 正式環境沒設的話，/api/v1/health 會把它列進 blocking。
 */
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

const PREFIX = 'storage:';
const TIMEOUT_MS = 8000;

const configured = () => !!(config.supabaseUrl && config.supabaseServiceKey);

function headers(extra = {}) {
  // 舊版 service_role 金鑰走 Authorization，新版 secret key 走 apikey；兩個都帶。
  return { apikey: config.supabaseServiceKey, Authorization: `Bearer ${config.supabaseServiceKey}`, ...extra };
}

const base = () => `${config.supabaseUrl.replace(/\/+$/, '')}/storage/v1`;
// 路徑裡每一段都要編碼，但斜線要留著 —— 那是資料夾。
const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

/**
 * 存一張圖，回傳要寫進資料庫的參照字串。
 * 失敗一律丟例外 —— 呼叫端決定要不要讓客人重拍。
 */
async function put(objectPath, buf, contentType) {
  if (!configured()) {
    fs.mkdirSync(config.uploadDir, { recursive: true });
    const name = path.basename(objectPath);
    fs.writeFileSync(path.join(config.uploadDir, name), buf);
    return `/uploads/${name}`;
  }
  const res = await fetch(`${base()}/object/${config.supabaseBucket}/${encodePath(objectPath)}`, {
    method: 'POST',
    headers: headers({ 'Content-Type': contentType || 'application/octet-stream', 'x-upsert': 'true' }),
    body: buf,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Storage 上傳失敗 ${res.status} ${text.slice(0, 200)}`);
  }
  return PREFIX + objectPath;
}

/**
 * 把一批 `storage:` 參照換成短效簽名網址（一次請求）。
 * 其他形式的值（型錄圖、本機 /uploads/…）原樣回傳。簽不出來的回 null ——
 * 圖片顯示不出來不該讓整個購物車 API 失敗。
 */
async function signMany(refs, expiresIn = 900) {
  const out = new Map();
  const wanted = [...new Set(refs.filter((r) => typeof r === 'string' && r.startsWith(PREFIX)))];
  for (const r of refs) if (typeof r === 'string' && !r.startsWith(PREFIX)) out.set(r, r);
  if (!wanted.length || !configured()) {
    for (const r of wanted) out.set(r, null);
    return out;
  }
  try {
    const res = await fetch(`${base()}/object/sign/${config.supabaseBucket}`, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ expiresIn, paths: wanted.map((r) => r.slice(PREFIX.length)) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const list = res.ok ? await res.json() : [];
    const byPath = new Map((Array.isArray(list) ? list : []).map((x) => [x.path, x.signedURL || x.signedUrl]));
    for (const r of wanted) {
      const signed = byPath.get(r.slice(PREFIX.length));
      out.set(r, signed ? (/^https?:/.test(signed) ? signed : base() + signed) : null);
    }
  } catch (e) {
    console.error('[storage] 簽名網址失敗：', e.message);
    for (const r of wanted) out.set(r, null);
  }
  return out;
}

/** 把一批資料列的某個欄位換成可顯示的網址（原地修改後回傳）。 */
async function resolve(rows, field) {
  const list = Array.isArray(rows) ? rows : [rows];
  const map = await signMany(list.map((r) => r && r[field]));
  for (const r of list) if (r && r[field]) r[field] = map.has(r[field]) ? map.get(r[field]) : r[field];
  return rows;
}

module.exports = { configured, put, signMany, resolve, PREFIX };
