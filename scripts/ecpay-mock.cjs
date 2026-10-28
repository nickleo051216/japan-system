'use strict';
/**
 * 測試專用：把綠界的 QueryTradeInfo（金鑰驗證用）換成本機假資料。
 * 只由 scripts/smoke.js 透過 NODE_OPTIONS=--require 載入，正式環境的程式碼
 * 沒有任何「跳過驗證」的開關。
 *
 * 行為照綠界：
 *   - 特店編號認得、檢查碼對 → 查無此訂單 TradeStatus=10200047（附簽好的 CheckMacValue）
 *   - 檢查碼不對            → TradeStatus=10200073&RtnMsg=CheckMacValue verify fail
 *   - 特店編號 9999999       → 連線失敗（測「連不上綠界」）
 * 下面的金鑰是測試用的假值，跟綠界無關。
 */
const ecpay = require('../server/lib/ecpay');

const SHOPS = {
  '3002607': { hashKey: 'smokeStageKey0001', hashIv: 'smokeStageIv00001' },
  '3383324': { hashKey: 'smokeLiveKey00001', hashIv: 'smokeLiveIv000001' },
};
const QUERY_URLS = Object.values(ecpay.BASE).map((b) => b + ecpay.QUERY_PATH);
const realFetch = globalThis.fetch;

globalThis.fetch = async (url, opts = {}) => {
  if (!QUERY_URLS.includes(String(url))) return realFetch(url, opts);
  const p = Object.fromEntries(new URLSearchParams(String(opts.body || '')));
  if (p.MerchantID === '9999999') throw new TypeError('fetch failed');
  const shop = SHOPS[p.MerchantID];
  const text = (s) => new Response(s, { status: 200, headers: { 'Content-Type': 'text/html' } });
  if (!shop || !ecpay.verifyMac(p, shop.hashKey, shop.hashIv)) {
    return text('TradeStatus=10200073&RtnMsg=CheckMacValue verify fail');
  }
  const reply = { MerchantID: p.MerchantID, MerchantTradeNo: p.MerchantTradeNo, TradeStatus: '10200047', TradeAmt: '0' };
  reply.CheckMacValue = ecpay.checkMac(reply, shop.hashKey, shop.hashIv);
  return text(new URLSearchParams(reply).toString());
};
