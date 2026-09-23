'use strict';
/**
 * 買家身分 —— LINE Login ID Token 驗證（合約 §1）。
 *
 * 前台送 `Authorization: Bearer <liff.getIDToken()>`，後端向 LINE 驗證後取
 * `sub` 當 line_user_id。**前端從不傳 userId** —— 傳了也不會被採信，因為那
 * 等於讓任何人宣稱自己是別人。
 *
 * 白名單的問題：買家不需要白名單。任何 LINE 使用者都可以是客人，所以第一次
 * 進來會自動建立一列 role='buyer' 的 members。需要白名單的是「員工」——
 * owner/helper/packer 這三個角色只有店主能給，自動建立永遠只給 buyer。
 *
 * 測試與後台自動化走第二條路：後端自己簽發的 session token 也接受。它不是
 * 後門 —— 要拿到它得先過 /auth/login 的共用密碼。兩種 token 用段數分辨：
 * LINE 的 ID Token 是 JWT（三段），我們自己的是兩段。
 */
const crypto = require('node:crypto');
const config = require('./config');
const db = require('./db');
const { now } = require('./ids');

const err = (code, message, status = 400) => Object.assign(new Error(message), { code, status });

const VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify';
const VERIFY_TIMEOUT_MS = 5000;

// 驗過的 token 先記著，避免每個請求都往 LINE 打一趟（Vercel 單次請求上限 15 秒）。
// key 是 token 的雜湊，不是 token 本身；記憶體隨實例生滅，過期自動失效。
const verified = new Map();

function cacheGet(hash) {
  const hit = verified.get(hash);
  if (!hit) return null;
  if (hit.exp <= Date.now()) { verified.delete(hash); return null; }
  return hit;
}

function cachePut(hash, claims) {
  // LINE 的 exp 是秒。再扣 30 秒緩衝，寧可多驗一次也不要用到剛過期的。
  const exp = Math.min(Number(claims.exp || 0) * 1000 - 30_000, Date.now() + 15 * 60_000);
  if (exp > Date.now()) verified.set(hash, { sub: claims.sub, name: claims.name || null, exp });
  if (verified.size > 1000) for (const [k, v] of verified) if (v.exp <= Date.now()) verified.delete(k);
}

/** 向 LINE 驗一張 ID Token。回 { sub, name }，失敗一律 401。 */
async function verifyIdToken(token) {
  const channelId = config.lineLoginChannelId;
  if (!channelId) {
    throw err('LOGIN_NOT_CONFIGURED', '尚未設定 LINE 登入，請聯絡店家', 503);
  }
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const hit = cacheGet(hash);
  if (hit) return { sub: hit.sub, name: hit.name };

  let res, json;
  try {
    res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: token, client_id: channelId }),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    json = await res.json();
  } catch (e) {
    // 連不到 LINE 是我們的問題，不是客人的 —— 回 5xx 讓前台重試，別叫他重新登入。
    console.error('[liff] 驗證 ID Token 失敗：', e.message);
    throw err('INTERNAL', '系統忙碌中，稍後再試', 503);
  }
  if (!res.ok || !json || !json.sub) {
    console.warn('[liff] ID Token 被 LINE 拒絕：', (json && json.error_description) || res.status);
    throw err('UNAUTHENTICATED', '登入已失效，請重新開啟', 401);
  }
  cachePut(hash, json);
  return { sub: json.sub, name: json.name || null };
}

/**
 * 第一次用 LIFF 進來的客人自動建檔。只會是 buyer ——
 * 員工角色一律由店主在後台指派，這條路給不出來。
 */
async function ensureMember(sub, displayName) {
  const existing = await db.one('SELECT * FROM members WHERE line_user_id = ?', sub);
  if (existing) return existing;
  const nickname = String(displayName || '').trim() || `客人${sub.slice(-4)}`;
  await db.run(
    `INSERT INTO members (line_user_id, nickname, display_name, role, status, bound_at)
     VALUES (?,?,?,'buyer','已綁定',?) ON CONFLICT (line_user_id) DO NOTHING`,
    sub, nickname, displayName || null, now());
  return await db.one('SELECT * FROM members WHERE line_user_id = ?', sub);
}

/** 一張 LINE ID Token → members 一列。驗不過一律 401。 */
async function fromIdToken(token) {
  const { sub, name } = await verifyIdToken(token);
  const member = await ensureMember(sub, name);
  if (!member) throw err('UNAUTHENTICATED', '登入已失效，請重新開啟', 401);
  if (member.status === '停用') throw err('FORBIDDEN', '帳號已停用，請聯絡店家', 403);
  return member;
}

module.exports = { fromIdToken, verifyIdToken, ensureMember };
