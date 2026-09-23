'use strict';
/**
 * 測試專用：把 LINE 的 ID Token 驗證（https://api.line.me/oauth2/v2.1/verify）
 * 換成本機假資料。只由 scripts/smoke.js 透過 NODE_OPTIONS=--require 載入，
 * 正式環境的程式碼裡沒有任何「跳過驗證」的開關 —— 要假造身分，得先能改到
 * 伺服器的啟動參數。
 *
 * 假 token 的格式：mock-idtoken:<LINE userId>[:<顯示名稱>]
 * 其餘一律照 LINE 的樣子回 400（Invalid IdToken）。client_id 不對也回 400，
 * 跟 LINE 一樣：別的 channel 核發的 token 不算數。
 */
const VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify';
const realFetch = globalThis.fetch;

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

globalThis.fetch = async (url, opts = {}) => {
  if (String(url) !== VERIFY_URL) return realFetch(url, opts);
  const form = new URLSearchParams(String(opts.body || ''));
  const m = /^mock-idtoken:(U\w+)(?::(.*))?$/.exec(form.get('id_token') || '');
  if (!m || form.get('client_id') !== process.env.LINE_LOGIN_CHANNEL_ID) {
    return json(400, { error: 'invalid_request', error_description: 'Invalid IdToken.' });
  }
  return json(200, {
    iss: 'https://access.line.me', sub: m[1], aud: form.get('client_id'),
    exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000), name: m[2] || null,
  });
};
