'use strict';
/**
 * 站內通知中心 —— v1.6 第 ⑥ 項（016）。
 *
 *   GET  /inbox/list?limit=&before=  我的通知（新的在前）
 *   GET  /inbox/unread-count         還沒看過的則數（首頁鈴鐺）
 *   POST /inbox/read                 { notif_ids:[…] } 或 { all:true } 標成看過
 *
 * 資料就是 notification_outbox —— 跟 LINE 通知同一份，不另外存一份會漂移的副本。
 * 文案跟 LINE 上一字不差（text）；另外給 body（拿掉 LIFF 網址那幾行，前台畫面用）和 path（點了要去哪一頁）。
 * 對帳單通知的文案原本是 n8n 組的（payload 沒有 text），這裡照同一個範本組一份。
 */
const db = require('../lib/db');
const { statementText } = require('../lib/customer-notify');
const { ok } = require('../lib/http');
const { bget, bpost, err } = require('./buyer');

const KIND = {
  shipped: ['出貨通知', 'orders'], arrived: ['到貨通知', 'orders'], statement: ['對帳單', 'stmt'],
  payment_reminder: ['付款提醒', 'stmt'], payment_received: ['付款成功', 'stmt'], transfer_verified: ['收到款項', 'stmt'],
  wish_broadcast: ['許願開喊單了', 'live'], quoted: ['報價好了', 'orders'], out_of_stock: ['缺貨通知', 'orders'],
  ship_request: ['出貨申請', 'orders'], bought: ['小幫手幫你買到了', 'cart'],
  wish_auto: ['許願預算自動處理', 'wish'],
};
const MAX = 50;


function shape(n) {
  const p = typeof n.payload === 'string' ? JSON.parse(n.payload) : (n.payload || {});
  const [title, defaultPath] = KIND[n.kind] || ['通知', null];
  const text = p.text || (n.kind === 'statement' ? statementText(p) : '');
  const m = /[?&]path=([a-z_-]+)/i.exec(text);
  // 前台畫面不需要 LIFF 網址那一行（已經在 LIFF 裡了）；「查看訂單 👉」這種引導句也一起拿掉。
  const body = text.split('\n').filter((l) => !/liff\.line\.me|https?:\/\//.test(l)).join('\n')
    .replace(/\n[^\n]*👉\s*$/u, '').replace(/\n{3,}/g, '\n\n').trim();
  return {
    notif_id: n.notif_id, kind: n.kind, title, text, body,
    // 點了要去哪：payload.path（v1.7 起每則都有）→ 文案裡的 ?path= → 舊的許願通知（有 wish_id 沒 path）→ 種類預設。
    path: p.path || (m ? m[1] : null) || (p.wish_id && ['quoted', 'out_of_stock'].includes(n.kind) ? 'wish' : defaultPath),
    order_id: n.order_id || p.order_id || null, statement_id: n.statement_id || p.statement_id || null,
    created_at: n.created_at, read: !!n.read_at, read_at: n.read_at || null,
  };
}

bget('/api/v1/inbox/list', async ({ me, query }) => {
  const limit = Math.min(MAX, Math.max(1, parseInt(query.limit, 10) || 30));
  const before = query.before ? new Date(String(query.before)) : null;
  if (before && Number.isNaN(before.getTime())) throw err('BAD_BEFORE', 'before 要是時間（上一頁最後一則的 created_at）');
  const rows = await db.all(
    `SELECT * FROM notification_outbox WHERE line_user_id = ? ${before ? 'AND created_at < ?' : ''}
      ORDER BY created_at DESC, notif_id DESC LIMIT ?`,
    me.line_user_id, ...(before ? [before.toISOString()] : []), limit + 1);
  const items = rows.slice(0, limit).map(shape).filter((x) => x.text);
  let unread = 0;
  try { unread = await unreadCount(me.line_user_id); } catch { /* 016 還沒跑 */ }
  return ok({ items, unread, next_before: rows.length > limit ? rows[limit - 1].created_at : null });
});

async function unreadCount(user) {
  return Number((await db.one(
    'SELECT count(*) AS n FROM notification_outbox WHERE line_user_id = ? AND read_at IS NULL', user)).n);
}

bget('/api/v1/inbox/unread-count', async ({ me }) => ok({ unread: await unreadCount(me.line_user_id) }));

bpost('/api/v1/inbox/read', async ({ me, body }) => {
  let changed;
  if (body.all === true) {
    changed = (await db.run('UPDATE notification_outbox SET read_at = now() WHERE line_user_id = ? AND read_at IS NULL', me.line_user_id)).changes;
  } else {
    const ids = Array.isArray(body.notif_ids) ? body.notif_ids.map(String).slice(0, 200) : [];
    if (!ids.length) throw err('BAD_REQUEST', '請帶 notif_ids（陣列）或 all:true');
    // 只改自己的：別人的 notif_id 就算猜到也改不到。
    changed = (await db.run(
      'UPDATE notification_outbox SET read_at = now() WHERE line_user_id = ? AND notif_id = ANY(?::text[]) AND read_at IS NULL',
      me.line_user_id, ids)).changes;
  }
  return ok({ marked: Number(changed), unread: await unreadCount(me.line_user_id) });
});

module.exports = { unreadCount, shape };
