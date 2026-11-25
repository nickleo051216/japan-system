'use strict';
/**
 * 客人看得到的 LINE 通知文案（v1.6：quoted、transfer_verified、out_of_stock；v1.7 加對帳單）。
 *
 * 每一則都在文案最後附「點了要去哪一頁」的 LIFF 連結（?path=…），payload 也帶一份 path，
 * 站內通知中心（/inbox/list）照同一個 path 跳頁：
 *   orders 我的訂單｜wish 我的許願｜stmt 對帳單｜live 喊單頁｜cart 購物車
 *
 * 一律排進 notification_outbox（notify.queue），n8n 照 payload.text 發 —— n8n 不用改。
 * 這些通知是「附帶」的：排不進佇列（例如正式庫還沒跑 013、種類不被接受）只記 log，
 * 不讓報價、核帳、標缺貨本身失敗。店家按下去的事一定要成功，通知晚一點補也比卡住好。
 */
const config = require('./config');
const notify = require('./notify');
const statementDays = require('./statement-days');

const ntd = (v) => 'NT$' + Math.round(Number(v) || 0).toLocaleString('en-US');
const link = (path) => `${config.buyerLiffUrl}?path=${path}`;
const md = (ymd) => (ymd ? `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}` : null);
const mdIso = (iso) => {
  const d = new Date(new Date(iso).getTime() + 8 * 3600e3);   // 台灣日期
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
};

/**
 * 對帳單通知的文案。以前是 n8n「組訊息」節點自己組（payload 沒有 text），
 * v1.7 起後端組好放進 payload.text（附 ?path=stmt），n8n 有 text 就直接用。
 * 站內通知中心讀舊的對帳單通知（沒有 text）時也用這個範本補。
 */
function statementText(p) {
  const count = (p.order_ids || []).length;
  return `🧾 對帳單通知\n\n您的本期對帳單 ${p.statement_id} 已產生\n`
    + `共 ${count} 筆訂單，合計 ${ntd(p.total_amount)}\n`
    + (p.pay_by ? `請於 ${mdIso(p.pay_by)} 前完成付款\n` : '')
    + `\n查看明細與付款 👉 ${link('stmt')}\n`
    + '\n有任何問題歡迎直接回覆這則訊息 🙌';
}

async function soft(item) {
  try {
    const queued = await notify.queue(item);
    if (queued) notify.poke();
    return queued;
  } catch (e) {
    console.warn('[notify] 通知沒排進佇列（不影響原本的操作）：', item.kind, e.code || '', e.message);
    return false;
  }
}

/** 訂單報價好了（待確認 → 已報價）。 */
async function orderQuoted(order, { itemCount, statementDaysRaw } = {}) {
  const next = md(statementDays.nextDue(statementDaysRaw));
  const goods = Number(order.total_twd) - Number(order.ship_fee_twd || 0);
  const text = `💰 報價好了\n\n訂單 ${order.order_id}${itemCount ? `（${itemCount} 件）` : ''}\n`
    + `商品 ${ntd(goods)}＋運費 ${ntd(order.ship_fee_twd)}＝${ntd(order.total_twd)}\n\n`
    + (next ? `${next} 結算時會一起出對帳單，到時候再付款就好 🙏\n` : '')
    + `查看訂單 👉\n${link('orders')}`;
  return soft({ kind: 'quoted', lineUserId: order.line_user_id, orderId: order.order_id,
    payload: { order_id: order.order_id, total_twd: Number(order.total_twd), path: 'orders', text } });
}

/** 許願報價好了。 */
async function wishQuoted(w) {
  const text = `💰 你許的願有報價了\n\n「${w.item_name}」${ntd(w.quote_twd)}\n\n`
    + `想要的話，到「我的許願」按「加入購物車」👉\n${link('wish')}`;
  return soft({ kind: 'quoted', lineUserId: w.line_user_id,
    payload: { wish_id: w.wish_id, quote_twd: Number(w.quote_twd), path: 'wish', text } });
}

/** 店家確認收到款項（手動核帳：對帳單或單張訂單）。綠界刷卡另有 payment_received。 */
async function transferVerified({ lineUserId, statementId = null, orderId = null, amount }) {
  const what = statementId ? `對帳單 ${statementId}` : `訂單 ${orderId}`;
  const path = statementId ? 'stmt' : 'orders';
  const text = `✅ 已確認收到您的付款\n\n${what}：${ntd(amount)}\n謝謝您 🙏\n\n`
    + `${statementId ? '查看對帳單' : '查看訂單'} 👉\n${link(path)}`;
  return soft({ kind: 'transfer_verified', lineUserId, statementId, orderId,
    payload: { statement_id: statementId, order_id: orderId, amount: Number(amount), path, text } });
}

/** 訂單缺貨（狀態變成「缺貨」）。 */
async function orderOutOfStock(order) {
  const text = `😢 缺貨通知\n\n訂單 ${order.order_id} 這次沒買到，`
    + `店家會再跟您聯絡後續（補買、換貨或退款）。\n有問題直接回覆這則訊息 🙌\n\n查看訂單 👉\n${link('orders')}`;
  return soft({ kind: 'out_of_stock', lineUserId: order.line_user_id, orderId: order.order_id,
    payload: { order_id: order.order_id, path: 'orders', text } });
}

/** 許願現場缺貨。 */
async function wishOutOfStock(w) {
  const text = `😢 你許的願「${w.item_name}」這次現場缺貨\n\n店家會留意下次採買，有消息再通知你 🙏\n\n`
    + `查看我的許願 👉\n${link('wish')}`;
  return soft({ kind: 'out_of_stock', lineUserId: w.line_user_id,
    payload: { wish_id: w.wish_id, path: 'wish', text } });
}

module.exports = { orderQuoted, wishQuoted, transferVerified, orderOutOfStock, wishOutOfStock, statementText, link };
