'use strict';
/**
 * 營運成本表（v1.8，022）。
 *
 * 小幫手請款單跟成本表連動（source = helper_claim，同一張請款單只有一筆）：
 *   核准（待付款）→ 新增一筆「未付」成本（日幣，金額＝請款單的日幣合計）
 *   標成已付款     → 同一筆改成「已付」，記付款時間（不會多一筆）
 *   退回           → 從成本表移除
 * 店主也可以手動記一筆（例如韓國線的費用、包材、運費），幣別日幣／韓幣／台幣。
 * 加總時三種幣別分開算，不換匯、不混在一起。
 *
 * 正式庫還沒跑 022（表不存在）時，同步只記 log、不讓請款審核失敗。
 */
const db = require('./db');
const { now, uid } = require('./ids');
const { taipeiToday } = require('./statement-days');

const missing = (e) => e && (e.code === '42P01' || e.code === '42703');
const twYmd = (iso) => taipeiToday(new Date(iso)).ymd;

async function upsertFromClaim(c, status) {
  const helper = await db.one('SELECT nickname FROM members WHERE line_user_id = ?', c.line_user_id);
  const payee = helper ? helper.nickname : null;
  const note = `請款單 ${c.claim_id}（約 NT$${Math.round(Number(c.total_twd) || 0).toLocaleString('en-US')}，匯率 ${Number(c.fx_rate)}）`;
  await db.run(
    `INSERT INTO operating_costs (cost_id, source, source_id, spent_on, category, currency, amount, status, payee, note, created_by, created_at, paid_at)
     VALUES (?,'helper_claim',?,?,'小幫手請款','JPY',?,?,?,?,?,?,?)
     ON CONFLICT (source, source_id) WHERE source_id IS NOT NULL
     DO UPDATE SET status = excluded.status, amount = excluded.amount, paid_at = coalesce(excluded.paid_at, operating_costs.paid_at)`,
    uid('COST'), c.claim_id, twYmd(c.created_at), Number(c.total_jpy), status, payee, note, c.decided_by || null, now(),
    status === 'paid' ? (c.paid_at || now()) : null);
}

/** 請款單狀態變了就呼叫（helper-claims/decide 之後）。 */
async function syncClaim(claimId) {
  try {
    const c = await db.one('SELECT * FROM helper_claims WHERE claim_id = ?', claimId);
    if (!c) return;
    if (c.status === 'approved') await upsertFromClaim(c, 'unpaid');
    else if (c.status === 'paid') await upsertFromClaim(c, 'paid');
    else await db.run("DELETE FROM operating_costs WHERE source = 'helper_claim' AND source_id = ?", claimId);
  } catch (e) {
    if (missing(e)) { console.warn('[costs] 022 還沒跑，請款單沒有同步到成本表：', claimId); return; }
    throw e;
  }
}

/** 補齊：022 跑之前就核准／付款的請款單，第一次打開成本表時補進來（已經有的不動）。 */
async function backfill() {
  const rows = await db.all(
    `SELECT c.* FROM helper_claims c
      WHERE c.status IN ('approved','paid')
        AND NOT EXISTS (SELECT 1 FROM operating_costs o WHERE o.source = 'helper_claim' AND o.source_id = c.claim_id)`);
  for (const c of rows) await upsertFromClaim(c, c.status === 'paid' ? 'paid' : 'unpaid');
  return rows.length;
}

module.exports = { syncClaim, backfill, missing };
