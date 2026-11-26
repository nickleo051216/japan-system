'use strict';
/**
 * AI 辨識的健康狀態（2026-11-26）。
 *
 * 以前 n8n 呼叫 OpenRouter 失敗（額度、模型名稱、供應商）時是「默默跳過」：n8n 沒有錯誤紀錄、
 * 後端也不知道，照片就一直停在「辨識中」。現在 n8n 失敗也會回寫（/ocr/result 帶 failed:true、reason），
 * 這裡把每一次成功／失敗記在 settings.ocr_health，後台首頁顯示燈號：
 *   green  今天有成功、失敗沒有比成功多
 *   red    今天失敗 ≥ 3 次而且比成功多，或有照片卡超過 15 分鐘
 *   grey   今天還沒有辨識過
 * 一天一份計數（台灣日期），最後一次失敗的原因原樣保留，店主看得到「為什麼」。
 */
const db = require('./db');
const { taipeiToday } = require('./statement-days');

const KEY = 'ocr_health';
const TIMEOUT_MIN = 15;

async function read() {
  try { return JSON.parse(await db.setting(KEY, '') || '{}'); } catch { return {}; }
}

/** 記一次結果。ok=true 成功；false 失敗（reason 是 n8n 帶來的原因）。記錄失敗不影響回寫本身。 */
async function record(ok, { reason = null, model = null, kind = null } = {}) {
  try {
    const day = taipeiToday().ymd;
    const h = await read();
    const today = h.day === day ? h : { day, ok: 0, fail: 0 };
    const next = { ...h, ...today, day };
    if (ok) { next.ok = (today.ok || 0) + 1; next.last_ok_at = new Date().toISOString(); next.last_model = model || next.last_model || null; }
    else {
      next.fail = (today.fail || 0) + 1; next.last_fail_at = new Date().toISOString();
      next.last_reason = reason ? String(reason).slice(0, 300) : '（沒有帶原因）'; next.last_fail_kind = kind;
    }
    await db.putSetting(KEY, JSON.stringify(next));
  } catch (e) { console.warn('[ocr-health] 記不進去：', e.message); }
}

/** 後台燈號。stuck = 拍照下單上傳超過 15 分鐘還沒辨識完的件數（客人那邊會顯示「沒辨識出來」）。 */
async function status() {
  const h = await read();
  const day = taipeiToday().ymd;
  const today = h.day === day ? h : { ok: 0, fail: 0 };
  let pending = 0;
  let stuck = 0;
  try {
    const r = await db.one(
      `SELECT count(*) FILTER (WHERE created_at >= now() - (? || ' minutes')::interval) AS pending,
              count(*) FILTER (WHERE created_at <  now() - (? || ' minutes')::interval AND created_at > now() - interval '7 days') AS stuck
         FROM cart_items
        WHERE source = 'image' AND status = 'pending' AND ai_confidence = 'low' AND price_twd IS NULL AND ocr_attempts < 5`,
      String(TIMEOUT_MIN), String(TIMEOUT_MIN));
    pending = Number(r.pending); stuck = Number(r.stuck);
  } catch { /* 舊版資料庫 */ }
  const ok = Number(today.ok || 0);
  const fail = Number(today.fail || 0);
  let light = ok || fail ? 'green' : 'grey';
  let say = ok || fail ? `今天辨識成功 ${ok} 張、失敗 ${fail} 張` : '今天還沒有照片要辨識';
  if ((fail >= 3 && fail > ok) || stuck > 0) {
    light = 'red';
    say = stuck > 0
      ? `有 ${stuck} 張拍照下單超過 ${TIMEOUT_MIN} 分鐘沒辨識出來` + (h.last_reason ? `；最近一次失敗：${h.last_reason}` : '（n8n 的「拍照辨識」可能沒在跑）')
      : `今天辨識失敗 ${fail} 次：${h.last_reason || ''}`;
  }
  return { light, say, ok_today: ok, fail_today: fail, pending, stuck,
    last_ok_at: h.last_ok_at || null, last_fail_at: h.last_fail_at || null, last_reason: h.last_reason || null, last_model: h.last_model || null };
}

module.exports = { record, status, TIMEOUT_MIN };
