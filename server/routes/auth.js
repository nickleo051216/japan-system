'use strict';
/**
 * Prototype authentication.
 *
 * In production this slot is a LIFF ID Token / backend JWT verified inside n8n
 * (README I-02). Here it is an HMAC-signed opaque token so the shape is the
 * same: the client sends a token, the SERVER resolves role and enforces it.
 *
 * 過渡措施 —— 後台共用密碼（ADMIN_LOGIN_PASSWORD）
 * ------------------------------------------------------------------
 * 原本的雛型登入「只要知道 line_user_id 就發 token」，而列出所有
 * line_user_id 的 /auth/personas 又是公開的。在本機那是方便，部署到公開
 * 網址上就是一扇沒有鎖的門：任何人都能以店主身分進後台，看到成本、毛利、
 * 客人個資與收款帳號。
 *
 * 所以這兩支入口都先擋一道共用密碼。它不是最終答案 —— 正解是 LINE Login
 * 的 ID Token 驗證，白名單就是 members 表本身（拿 idToken 換到的 sub 就是
 * line_user_id，查不到就擋掉）。那件事跟 Step 4 前台的 LIFF 驗證是同一套
 * 東西，值得一次做對，不該為了今晚趕出半套。
 *
 * 這道密碼的設計取捨：
 *   - 沒設 ADMIN_LOGIN_PASSWORD 就整個鎖死（fail closed），不留後門。
 *   - 比對走 sha256 + timingSafeEqual，長度與內容都不從回應時間洩漏。
 *   - 失敗只寫 console，不寫 audit_log —— 這是未經驗證的公開端點，
 *     每次失敗都寫一筆等於給人一個灌爆資料表的方法。
 *   - 附一個行程內的失敗節流。serverless 每個實例記憶體各自獨立、冷啟動就
 *     重置，所以它擋不住分散式暴力破解；它擋的是「一支腳本對著一個實例
 *     狂試」這種最常見的情況。真正的防線是密碼夠長。
 */
const crypto = require('node:crypto');
const db = require('../lib/db');
const config = require('../lib/config');
const { get, post, ok } = require('../lib/http');
const auth = require('../lib/auth');
const audit = require('../lib/audit');

const err = (code, message, status = 400) => Object.assign(new Error(message), { code, status });

// ---- 共用密碼 -------------------------------------------------------------

const FAIL_LIMIT = 5;              // 同一來源連續失敗幾次後鎖住
const FAIL_WINDOW_MS = 5 * 60_000; // 鎖多久，也是計數的滑動視窗
const fails = new Map();           // ip -> { count, first, until }

const clientIp = (req) =>
  String((req && req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim()
  || (req && req.socket && req.socket.remoteAddress) || 'unknown';

/** 固定長度摘要後再比，長度與內容都不會從回應時間洩漏。 */
const digest = (v) => crypto.createHash('sha256').update(String(v ?? ''), 'utf8').digest();

/** 過期的紀錄該被忘掉：滑動視窗內沒再失敗，就當作沒發生過。 */
const expired = (rec, now) => !rec.until && now - rec.first > FAIL_WINDOW_MS;

function throttle(ip) {
  const now = Date.now();
  const rec = fails.get(ip);
  if (rec && rec.until > now) {
    throw err('TOO_MANY_ATTEMPTS', '嘗試次數過多，請稍後再試', 429);
  }
  if (rec && (expired(rec, now) || (rec.until && rec.until <= now))) fails.delete(ip);
  // Map 會隨著不同來源的失敗一直長大，順手清掉過期的。
  if (fails.size > 500) {
    for (const [k, v] of fails) if (expired(v, now) || (v.until && v.until <= now)) fails.delete(k);
  }
}

function noteFailure(ip, where) {
  const now = Date.now();
  let rec = fails.get(ip);
  if (!rec || expired(rec, now)) rec = { count: 0, first: now, until: 0 };
  rec.count += 1;
  // 鎖定時間只在真的達到上限時才設。每次失敗都往後推的話，第一次打錯就等於被鎖住。
  if (rec.count >= FAIL_LIMIT) rec.until = now + FAIL_WINDOW_MS;
  fails.set(ip, rec);
  console.warn(`[auth] ${where} 密碼錯誤（來源 ${ip}，第 ${rec.count} 次）`);
  if (rec.until) throw err('TOO_MANY_ATTEMPTS', '嘗試次數過多，請稍後再試', 429);
}

/**
 * 沒設密碼時一律 503 而不是放行。部署漏設會「登不進去」，不會變成
 * 「誰都進得去」—— 前者看得見，後者看不見。
 */
function requirePassword(given, req, where) {
  const secret = config.adminLoginPassword;
  if (!secret) {
    throw err('LOGIN_NOT_CONFIGURED',
      '後台登入尚未設定密碼，請先在環境變數設定 ADMIN_LOGIN_PASSWORD', 503);
  }
  const ip = clientIp(req);
  throttle(ip);
  if (!crypto.timingSafeEqual(digest(secret), digest(given))) {
    noteFailure(ip, where);
    throw err('BAD_PASSWORD', '後台密碼不正確', 401);
  }
  fails.delete(ip);
}

// ---- 路由 -----------------------------------------------------------------

/**
 * Prototype login: pick one of the seeded personas. Production replaces this
 * with LIFF ID Token verification (I-02) — the token shape and the server-side
 * role resolution stay the same.
 *
 * 名單本身就是個資（誰在幫你採買、誰是店主），所以跟 login 擋同一道密碼。
 * GET 沒有 body，密碼走 x-admin-password header。
 */
get('/api/v1/auth/personas', async ({ req }) => {
  requirePassword(req.headers['x-admin-password'], req, 'personas');
  // 只列員工。客人第一次開 LINE 前台就會自動進 members —— 列出來等於把
  // 全部客人的名字與 LINE userId 交給任何知道後台密碼的人。
  return ok(await db.all(
    "SELECT line_user_id, nickname, display_name, role FROM members WHERE role <> 'buyer' " +
    "ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'helper' THEN 1 ELSE 2 END, nickname"));
});

// 刻意不是冪等路由。冪等快取會把回應整包存起來，而這支的回應裡有 token ——
// 存一份憑證起來，等於多開一條不用密碼就能拿到它的路。重複登入本來就無害，
// 不需要冪等。
post('/api/v1/auth/login', async ({ body, req }) => {
  requirePassword(body.password, req, 'login');
  const member = await db.one('SELECT * FROM members WHERE line_user_id = ?', body.line_user_id);
  if (!member) throw err('NO_SUCH_MEMBER', '查無此使用者', 404);
  await audit.record({ actor: member.line_user_id, action: 'auth.login', result: 'ok' });
  return ok({
    token: auth.issue(member.line_user_id),
    member: { line_user_id: member.line_user_id, nickname: member.nickname, display_name: member.display_name, role: member.role },
    capabilities: Object.keys(auth.CAPABILITIES).filter((c) => auth.can(member, c)),
  });
}, { idempotent: false });

get('/api/v1/auth/me', ({ actor }) => {
  if (!actor) throw err('UNAUTHENTICATED', '尚未登入', 401);
  return ok({ member: actor, capabilities: Object.keys(auth.CAPABILITIES).filter((c) => auth.can(actor, c)) });
});
