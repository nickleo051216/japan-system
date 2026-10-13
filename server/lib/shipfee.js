'use strict';
/**
 * 台灣端運費與滿額免運。店主在後台「店家與收款設定」填；運費沒填才用合約暫定的數字。
 *
 * 結帳（buyer-orders）、代客下單與報價（admin-shop）、首頁（home/summary）都從這裡讀 ——
 * 前台畫面顯示的運費和實際收的運費必須是同一個來源，否則客人看到 70、結帳收 90。
 *
 * 滿額免運（業主確認單 2026-10-12）：**看單張訂單的商品小計**（不含運費），
 * 小計 ≥ 門檻就免運。門檻留空或 0 = 沒有免運。預設不開：免運是店家讓利，
 * 要店主在後台填了才生效，不由程式替店家決定。
 */
const db = require('./db');

// 合約 [待確認] #2：業主尚未決定金額，先沿用合約寫的暫定值。
const SHIP_FEE_DEFAULT = { cvs: 70, home: 120 };

// 宅配訂單的 orders.pickup 一律寫這個字串，超商則寫門市名稱。
// 訂單沒有另外存取貨方式，重算運費時靠它分辨 —— 寫入端請用這個常數，不要另打一份。
const HOME_PICKUP = '宅配到府';

const parse = (v, kind) => {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n >= 0 ? n : SHIP_FEE_DEFAULT[kind];
};
/** 免運門檻：正整數才算，其他（空白、0、亂填）一律當作沒有免運。 */
const parseFree = (v) => {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const feeKey = (kind) => (kind === 'home' ? 'ship_fee_home' : 'ship_fee_cvs');
const freeKey = (kind) => (kind === 'home' ? 'ship_free_home' : 'ship_free_cvs');

/** 從已讀出的 settings 物件取兩種運費，省一趟查詢。 */
const fromSettings = (s) => ({ cvs: parse(s.ship_fee_cvs, 'cvs'), home: parse(s.ship_fee_home, 'home') });
/** 兩種取貨方式的免運門檻；null = 沒有免運。 */
const freeFromSettings = (s) => ({ cvs: parseFree(s.ship_free_cvs), home: parseFree(s.ship_free_home) });

async function shipFee(kind) {
  return parse(await db.setting(feeKey(kind), ''), kind);
}

/**
 * 這張訂單實際要收的運費。subtotal 是商品小計（不含運費）；還沒定價的品項以 0 計，
 * 所以結帳時沒到門檻的單，報價補上價錢後會重算一次。
 */
async function feeFor(kind, subtotal) {
  const [base, free] = await Promise.all([shipFee(kind), db.setting(freeKey(kind), '')]);
  const threshold = parseFree(free);
  return threshold !== null && Number(subtotal) >= threshold ? 0 : base;
}

const pickupTypeOf = (order) => (order.pickup === HOME_PICKUP ? 'home' : 'cvs');

module.exports = { shipFee, feeFor, fromSettings, freeFromSettings, pickupTypeOf, HOME_PICKUP, SHIP_FEE_DEFAULT };
