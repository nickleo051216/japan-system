'use strict';
/**
 * npm run test:contract —— 用前端那份 47 項合約測試，驗「真的後端程式＋真的 Postgres」。
 *
 *   1. 起一個本機 harness（PGlite，講 Postgres 協定，跟 Supabase 一樣）
 *   2. 重置示範資料，再照參考實作搬進合約測試資料（scripts/contract-fixture.js）
 *   3. 起真的後端（server/index.js），用後台密碼替測試客人換一張 session token
 *   4. 以 BASE ＋ BUYER_TOKEN 執行 scripts/buyer-contract.test.js，原封不動
 *
 * 永遠不碰正式資料庫：沒有 harness 就不跑。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 3994;
const ADMIN_PW = 'contract-admin-password-0123456789';

function startHarness() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'pg-harness.mjs')],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const timer = setTimeout(() => reject(new Error('harness 啟動逾時')), 120000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const m = /DATABASE_URL=(\S+)/.exec(buf);
      if (m) { clearTimeout(timer); resolve({ child, url: m[1] }); }
    });
    child.stderr.on('data', (d) => process.stderr.write(d));
  });
}

(async () => {
  if (process.env.DATABASE_URL) {
    console.error('請不要帶 DATABASE_URL 執行合約測試 —— 它會寫入假資料，只能對本機 harness 跑。');
    process.exit(2);
  }
  const harness = await startHarness();
  let server = null;
  let code = 1;
  try {
    // 資料要在後端啟動前載好：harness 一次只服務一條連線。
    process.env.DATABASE_URL = harness.url;
    process.env.DB_POOL_MAX = '1';
    const db = require('../server/lib/db');
    const seed = require('../server/lib/seed');
    const fixture = require('./contract-fixture');
    await seed.reset();
    await fixture.load();
    await db.close();

    server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
      cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env, PORT: String(PORT), DATABASE_URL: harness.url, DB_POOL_MAX: '1',
        QR_SIGNING_KEY: 'contract-qr', SESSION_SIGNING_KEY: 'contract-session',
        ADMIN_LOGIN_PASSWORD: ADMIN_PW, LINE_LOGIN_CHANNEL_ID: '2011699944', NOTIFY_SHARED_SECRET: 'contract-notify',
        // 綠界用假參數：只驗「後端有產生導轉表單與簽章」，不驗綠界是否接受。
        ECPAY_MERCHANT_ID: '3002607', ECPAY_HASH_KEY: 'contractHashKey0', ECPAY_HASH_IV: 'contractHashIv00',
        ECPAY_API_URL: 'https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5',
      },
    });
    server.stderr.on('data', (d) => { const s = d.toString(); if (/Error|error/.test(s)) process.stderr.write(s); });
    const base = `http://127.0.0.1:${PORT}`;
    for (let i = 0; i < 300; i++) {
      try { await fetch(base + '/api/v1/health'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    const login = await (await fetch(base + '/api/v1/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ line_user_id: fixture.BUYER, password: ADMIN_PW }),
    })).json();
    if (!login.ok) throw new Error('無法替測試客人登入：' + JSON.stringify(login.error));

    code = await new Promise((resolve) => {
      const t = spawn(process.execPath, [path.join(ROOT, 'scripts', 'buyer-contract.test.js')], {
        cwd: ROOT, stdio: 'inherit',
        env: { ...process.env, BASE: base + '/api/v1', BUYER_TOKEN: login.data.token, DATABASE_URL: '' },
      });
      t.on('exit', (c) => resolve(c));
    });
    console.log('\n（附註）ATM 兩項靠測試資料預先配好的虛擬帳號通過；向銀行取號尚未開通，見合約待確認 #4。');
  } catch (e) {
    console.error('合約測試中止：', e);
  } finally {
    if (server) server.kill();
    harness.child.kill();
  }
  process.exit(code);
})();
