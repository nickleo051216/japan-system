'use strict';
/**
 * 後台設定裡原本只能進資料庫改的兩件事：價目表、成員與權限。
 * （運費走「店家與收款設定」，見 routes/dashboard.js 的 SHOP_FIELDS。）
 *
 * 權限的一條硬規則：**店主（owner）這個角色，後台給不出去也拿不走。**
 * 後台只能在「客人／日本小幫手／包貨人員」之間調整。要新增或移除店主，得由
 * 系統管理者直接改資料庫 —— 共用密碼時代任何人都能點店主的名字登入，一個
 * 能「把自己升成店主」的按鈕等於把整間店交出去。改成 LINE 登入後這條仍然
 * 保留：最高權限不該能從網頁上被轉移。
 */
const db = require('../lib/db');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const price = require('../lib/price');
const { get, post, ok } = require('../lib/http');
const { now } = require('../lib/ids');

const err = (code, message, status = 400) => Object.assign(new Error(message), { code, status });

// ---- 價目表 ---------------------------------------------------------------

const PRICE_ROWS_MAX = 100;
const JPY_MAX = 10_000_000;
const TWD_MAX = 1_000_000;

/** 驗證整張價目表，回傳依日幣排序好的列；任何一列不對就整張不收。 */
function normalisePriceRows(rows) {
  if (!Array.isArray(rows) || !rows.length) throw err('BAD_PRICE_TABLE', '價目表至少要有一列');
  if (rows.length > PRICE_ROWS_MAX) throw err('BAD_PRICE_TABLE', `價目表最多 ${PRICE_ROWS_MAX} 列`);
  const out = rows.map((r, i) => {
    const jpy = Number(r && r.jpy_taxed_max);
    const twd = Number(r && r.twd);
    if (!Number.isInteger(jpy) || jpy < 1 || jpy > JPY_MAX) {
      throw err('BAD_PRICE_TABLE', `第 ${i + 1} 列：日幣上限必須是 1–${JPY_MAX} 的整數`);
    }
    if (!Number.isInteger(twd) || twd < 1 || twd > TWD_MAX) {
      throw err('BAD_PRICE_TABLE', `第 ${i + 1} 列：台幣售價必須是 1–${TWD_MAX} 的整數`);
    }
    return { jpy_taxed_max: jpy, twd };
  }).sort((a, b) => a.jpy_taxed_max - b.jpy_taxed_max);
  for (let i = 1; i < out.length; i++) {
    if (out[i].jpy_taxed_max === out[i - 1].jpy_taxed_max) {
      throw err('BAD_PRICE_TABLE', `日幣上限 ¥${out[i].jpy_taxed_max} 重複了`);
    }
    // 日幣越貴、台幣反而越便宜，幾乎一定是打錯字；擋下來比讓客人撿便宜好。
    if (out[i].twd < out[i - 1].twd) {
      throw err('BAD_PRICE_TABLE',
        `¥${out[i].jpy_taxed_max} 的售價 NT$${out[i].twd} 比前一級 ¥${out[i - 1].jpy_taxed_max} 的 NT$${out[i - 1].twd} 還低`);
    }
  }
  return out;
}

// 價目表本來就公開在客人首頁，員工都能看；只有店主能改。
get('/api/v1/settings/price-table', async ({ actor }) => {
  auth.requireCap(actor, 'order.read');
  return ok({ rows: await price.table() });
});

post('/api/v1/settings/price-table', async ({ actor, body }) => {
  auth.requireCap(actor, 'settings.write');
  const next = normalisePriceRows(body.rows);
  const before = await price.table();
  await db.tx(async () => {
    await db.run('DELETE FROM price_table');
    for (const r of next) await db.run('INSERT INTO price_table (jpy_taxed_max, twd) VALUES (?,?)', r.jpy_taxed_max, r.twd);
  });
  // 價目表不是機密，前後兩版都記下來，改錯了才查得回原本的數字。
  await audit.record({ actor: actor.line_user_id, action: 'settings.price_table',
    detail: { before, after: next }, result: 'ok' });
  return ok({ rows: await price.table(), note: '已報價的訂單與購物車品項不會跟著改價' });
});

// ---- 成員與權限 -----------------------------------------------------------

const ASSIGNABLE = ['buyer', 'helper', 'packer'];      // owner 刻意不在裡面
const STAFF_ADDABLE = ['helper', 'packer'];
const LINE_USER_ID = /^U[0-9a-f]{32}$/;

const memberShape = (m) => ({
  member_no: m.member_no, line_user_id: m.line_user_id, nickname: m.nickname, display_name: m.display_name,
  role: m.role, status: m.status, bound_at: m.bound_at, created_at: m.created_at,
});

get('/api/v1/members/admin-list', async ({ actor, query }) => {
  auth.requireCap(actor, 'settings.write');
  const q = String(query.q || '').trim().slice(0, 40);
  const order = "ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'helper' THEN 1 WHEN 'packer' THEN 2 ELSE 3 END, created_at DESC";
  // 客人可能上千人：預設只列最近 50 位，要找特定的人用搜尋。
  // 搜尋同時套用在員工與客人 —— 用會員編號找自己（HB-00001）或某位員工也要找得到。
  const like = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
  const match = '(nickname ILIKE ? OR display_name ILIKE ? OR member_no ILIKE ? OR line_user_id ILIKE ?)';
  const staff = q
    ? await db.all(`SELECT * FROM members WHERE role <> 'buyer' AND ${match} ${order}`, like, like, like, like)
    : await db.all(`SELECT * FROM members WHERE role <> 'buyer' ${order}`);
  const buyers = q
    ? await db.all(`SELECT * FROM members WHERE role = 'buyer'
        AND (nickname ILIKE ? OR display_name ILIKE ? OR member_no ILIKE ? OR line_user_id ILIKE ?) ${order} LIMIT 50`,
      like, like, like, like)
    : await db.all(`SELECT * FROM members WHERE role = 'buyer' ${order} LIMIT 50`);
  return ok({ staff: staff.map(memberShape), buyers: buyers.map(memberShape), me: actor.line_user_id });
});

post('/api/v1/members/set-role', async ({ actor, body }) => {
  auth.requireCap(actor, 'settings.write');
  const role = String(body.role || '');
  if (!ASSIGNABLE.includes(role)) throw err('BAD_ROLE', '角色只能是客人、日本小幫手或包貨人員');
  const target = await db.one('SELECT * FROM members WHERE line_user_id = ?', String(body.line_user_id || ''));
  if (!target) throw err('MEMBER_NOT_FOUND', '找不到這位成員', 404);
  if (target.role === 'owner') throw err('OWNER_LOCKED', '店主的權限不能從後台調整，請聯絡系統管理者', 403);
  if (target.line_user_id === actor.line_user_id) throw err('SELF_CHANGE', '不能調整自己的角色', 409);
  if (target.role === role) return ok({ member: memberShape(target), changed: false });

  await db.run('UPDATE members SET role = ? WHERE line_user_id = ?', role, target.line_user_id);
  await audit.record({ actor: actor.line_user_id, action: 'members.role',
    detail: { line_user_id: target.line_user_id, from: target.role, to: role }, result: 'ok' });
  const fresh = await db.one('SELECT * FROM members WHERE line_user_id = ?', target.line_user_id);
  return ok({ member: memberShape(fresh), changed: true });
});

/**
 * 系統管理者專用：員工還沒開過 LINE 前台、名單裡找不到時，用 LINE userId 直接加。
 *
 * 後台畫面已經拿掉這個入口（2026-09-24）。正常流程是員工先用自己的 LINE 打開一次
 * 買家頁面自動建檔，店家再用名字或會員編號找到人、用 set-role 改角色 —— 店家
 * 不必接觸那串 33 碼的 userId。這支 API 留著給系統管理者處理例外情況。
 */
post('/api/v1/members/add', async ({ actor, body }) => {
  auth.requireCap(actor, 'settings.write');
  const id = String(body.line_user_id || '').trim();
  const nickname = String(body.nickname || '').trim();
  const role = String(body.role || '');
  if (!LINE_USER_ID.test(id)) throw err('BAD_LINE_USER_ID', 'LINE userId 格式不對：應為 U 開頭加 32 碼英數字');
  if (!nickname || nickname.length > 20) throw err('BAD_NICKNAME', '稱呼請填 1–20 個字');
  if (!STAFF_ADDABLE.includes(role)) throw err('BAD_ROLE', '只能新增日本小幫手或包貨人員');
  if (await db.one('SELECT 1 AS x FROM members WHERE line_user_id = ?', id)) {
    throw err('MEMBER_EXISTS', '這位已經在名單裡了，請直接在名單上調整角色', 409);
  }
  if (await db.one('SELECT 1 AS x FROM members WHERE lower(trim(nickname)) = lower(?)', nickname)) {
    throw err('NICKNAME_TAKEN', '這個稱呼已經有人用了，請換一個', 409);
  }
  await db.run(
    'INSERT INTO members (line_user_id, nickname, display_name, role, created_at) VALUES (?,?,?,?,?)',
    id, nickname, nickname, role, now());
  await audit.record({ actor: actor.line_user_id, action: 'members.add',
    detail: { line_user_id: id, role }, result: 'ok' });
  return ok({ member: memberShape(await db.one('SELECT * FROM members WHERE line_user_id = ?', id)) });
});

module.exports = { normalisePriceRows };
