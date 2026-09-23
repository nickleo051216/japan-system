'use strict';
/**
 * 台灣端運費。店主在後台「店家與收款設定」填；沒填才用合約暫定的數字。
 *
 * 結帳（buyer-orders）與首頁（home/summary）都從這裡讀 —— 前台畫面顯示的
 * 運費和實際收的運費必須是同一個來源，否則客人看到 70、結帳收 90。
 */
const db = require('./db');

// 合約 [待確認] #2：業主尚未決定金額，先沿用合約寫的暫定值。
const SHIP_FEE_DEFAULT = { cvs: 70, home: 120 };

const parse = (v, kind) => {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n >= 0 ? n : SHIP_FEE_DEFAULT[kind];
};

async function shipFee(kind) {
  return parse(await db.setting(kind === 'home' ? 'ship_fee_home' : 'ship_fee_cvs', ''), kind);
}

/** 從已讀出的 settings 物件取兩種運費，省一趟查詢。 */
const fromSettings = (s) => ({ cvs: parse(s.ship_fee_cvs, 'cvs'), home: parse(s.ship_fee_home, 'home') });

module.exports = { shipFee, fromSettings, SHIP_FEE_DEFAULT };
