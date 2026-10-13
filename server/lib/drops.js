'use strict';
/**
 * 喊單棄單：上限與恢復資格（業主確認單 2026-10-12）。
 *
 *   上限 —— settings.shout_drop_limit，沒設定就是 1：棄單 1 次就暫停喊單。
 *           真正擋人的是資料庫的 shout()（008 的 shout_drop_limit()），這裡的
 *           解析規則必須跟它一模一樣，前台看到的上限才會等於實際擋人的門檻。
 *   恢復 —— 對帳單付款完成、而且這位客人已經沒有沒付清的對帳單，棄單次數歸零。
 *           店主也可以在後台手動歸零（例如客人沒有對帳單可付、或有特殊狀況）。
 */
const db = require('./db');
const audit = require('./audit');

const DEFAULT_LIMIT = 1;

/** 跟 008 的 shout_drop_limit() 同一套規則：1–6 位正整數才算，其他一律用預設值。 */
const parseLimit = (v) => {
  const s = String(v ?? '').trim();
  const n = /^[0-9]{1,6}$/.test(s) ? Number(s) : 0;
  return n > 0 ? n : DEFAULT_LIMIT;
};

async function limit() {
  return parseLimit(await db.setting('shout_drop_limit', ''));
}

/**
 * 核對對帳單之後呼叫：這位客人如果有棄單紀錄、而且所有對帳單都付清了，就歸零。
 * 回傳 true 表示這次有恢復資格。
 */
async function restoreIfPaidUp(lineUserId, actor) {
  const m = await db.one('SELECT shout_drops FROM members WHERE line_user_id = ?', lineUserId);
  if (!m || !(m.shout_drops > 0)) return false;
  const unpaid = await db.one(
    "SELECT count(*) AS n FROM statements WHERE line_user_id = ? AND payment_status <> '已核對'", lineUserId);
  if (Number(unpaid.n) > 0) return false;
  await db.run('UPDATE members SET shout_drops = 0 WHERE line_user_id = ?', lineUserId);
  await audit.record({ actor, action: 'members.drops_reset',
    detail: { line_user_id: lineUserId, from: m.shout_drops, reason: 'paid' }, result: 'ok' });
  return true;
}

module.exports = { limit, parseLimit, restoreIfPaidUp, DEFAULT_LIMIT };
