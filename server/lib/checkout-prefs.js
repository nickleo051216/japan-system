'use strict';
/**
 * 結帳偏好（v1.8，022：members.checkout_prefs）。
 *
 * 客人存一份預設，結帳時不用每次重填：
 *   payway   付款方式  bank（匯款）｜atm｜credit
 *   pickup   取貨方式  { type:"cvs"|"home", … }  —— 跟出貨申請（021，lib/pickup.js）同一套格式。
 *            門市、地址存在 members 原本的 cvs_*／home_addr（結帳、出貨申請本來就讀這裡），
 *            checkout_prefs 只記「預設哪一種」。一份地址，不會兩邊各存一份對不起來。
 *   invoice  發票      { type:"carrier", carrier:"/ABC1234" }｜{ type:"donate", donate_code:"168001" }｜
 *                      { type:"tax", tax_id:"12345678", company:"好好股份有限公司" }
 *            切換類型時沒用到的欄位一律清掉。載具同時寫回 members.carrier（「我的」頁讀那裡）。
 *   note     特殊備註  例如「送禮請勿附價錢」，結帳沒填備註時帶這個。
 *
 * 只有本人看得到、改得到；店主在訂單和出貨單上看得到這位客人的偏好（forOwner）。
 * 電子發票目前沒有串接：回傳 integration_status: "not_connected"，前台照實顯示。
 */
const db = require('./db');
const pk = require('./pickup');

const PAYWAYS = { bank: '匯款', atm: 'ATM 轉帳', credit: '信用卡' };
const INTEGRATION_STATUS = 'not_connected';
const bad = (code, message) => Object.assign(new Error(message), { code, status: 400 });
const clip = (v, max) => (v === undefined || v === null ? null : String(v).trim().slice(0, max) || null);
const missing = (e) => e && (e.code === '42P01' || e.code === '42703');

function parseRaw(v) {
  if (!v) return {};
  if (typeof v === 'string') { try { return JSON.parse(v) || {}; } catch { return {}; } }
  return v;
}

/** 發票：驗證並只留這種類型用得到的欄位。 */
function invoice(input) {
  if (input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw bad('BAD_INVOICE', 'invoice 要是 { type: "carrier" | "donate" | "tax", … }');
  const type = String(input.type || '');
  if (type === 'carrier') {
    const carrier = String(input.carrier || '').trim().toUpperCase();
    if (!/^\/[0-9A-Z.+-]{7}$/.test(carrier)) throw bad('BAD_CARRIER', '手機載具是「/」開頭再加 7 碼（英文大寫、數字或 . + -）');
    return { type, carrier };
  }
  if (type === 'donate') {
    const code = String(input.donate_code || '').trim();
    if (!/^\d{3,7}$/.test(code)) throw bad('BAD_DONATE_CODE', '捐贈碼是 3～7 位數字');
    return { type, donate_code: code };
  }
  if (type === 'tax') {
    const id = String(input.tax_id || '').trim();
    if (!/^\d{8}$/.test(id)) throw bad('BAD_TAX_ID', '統一編號必須是 8 碼數字');
    const company = clip(input.company, 60);
    if (!company) throw bad('BAD_COMPANY', '開統編要填公司名稱（發票抬頭）');
    return { type, tax_id: id, company };
  }
  throw bad('BAD_INVOICE', '發票類型只能是手機載具（carrier）、捐贈（donate）或統編（tax）');
}

/** 給畫面的形狀：pickup 照會員資料補齊（跟出貨申請 pk.resolve 同一套）。 */
function shape(member) {
  const p = parseRaw(member.checkout_prefs);
  let pickup = null;
  if (p.pickup_type) {
    try { pickup = pk.resolve(member, { type: p.pickup_type }); }
    catch { pickup = { type: p.pickup_type, incomplete: true }; }   // 會員資料裡的門市／地址被清掉了
    if (pickup) pickup.text = pickup.incomplete ? null : pk.describe(pickup);
  }
  return {
    payway: p.payway || null, payway_zh: p.payway ? PAYWAYS[p.payway] : null,
    pickup, invoice: p.invoice || null, note: p.note || null,
    integration_status: INTEGRATION_STATUS,
    integration_note: '電子發票還沒有串接，店家會照你的設定另外開立',
    updated_at: p.updated_at || null,
  };
}

/**
 * 存偏好：只改有帶的欄位；帶 null 是清掉那一項。
 * pickup 帶了門市或地址，會寫回會員資料（同一份地址）；只帶 type 就沿用會員資料現有的。
 */
async function save(member, body) {
  const cur = parseRaw(member.checkout_prefs);
  const next = { ...cur };
  const memberSets = {};
  if (body.payway !== undefined) {
    if (body.payway === null) delete next.payway;
    else if (!PAYWAYS[body.payway]) throw bad('BAD_PAYWAY', '付款方式只能是匯款（bank）、ATM（atm）或信用卡（credit）');
    else next.payway = body.payway;
  }
  if (body.invoice !== undefined) {
    const inv = invoice(body.invoice);
    if (inv) next.invoice = inv; else delete next.invoice;
    if (inv && inv.type === 'carrier') memberSets.carrier = inv.carrier;
  }
  if (body.note !== undefined) {
    const note = clip(body.note, 100);
    if (note) next.note = note; else delete next.note;
  }
  if (body.pickup !== undefined) {
    if (body.pickup === null) {
      delete next.pickup_type;
    } else {
      const r = pk.resolve(member, body.pickup);   // BAD_PICKUP／PICKUP_INCOMPLETE
      next.pickup_type = r.type;
      if (!r.from_default) {
        if (r.type === 'home') memberSets.home_addr = r.addr;
        else Object.assign(memberSets, { cvs_brand: r.brand, cvs_store_id: r.store_id, cvs_store_name: r.store_name, cvs_addr: r.addr });
      }
    }
  }
  next.updated_at = new Date().toISOString();
  const keys = Object.keys(memberSets);   // 欄名都是上面寫死的
  try {
    await db.run(`UPDATE members SET checkout_prefs = ?::jsonb${keys.map((k) => `, ${k} = ?`).join('')} WHERE line_user_id = ?`,
      JSON.stringify(next), ...keys.map((k) => memberSets[k]), member.line_user_id);
  } catch (e) {
    if (missing(e)) throw Object.assign(new Error('結帳偏好還沒開通（資料庫還沒更新）'), { code: 'NOT_READY', status: 503 });
    throw e;
  }
  return db.one('SELECT * FROM members WHERE line_user_id = ?', member.line_user_id);
}

/** 給店家看的（訂單、出貨單）：一樣的形狀，另外加一行字摘要。 */
function forOwner(member) {
  if (!member) return null;
  const s = shape(member);
  if (!s.payway && !s.pickup && !s.invoice && !s.note) return null;
  const inv = s.invoice;
  const invText = !inv ? null : inv.type === 'carrier' ? `手機載具 ${inv.carrier}` : inv.type === 'donate' ? `捐贈 ${inv.donate_code}` : `統編 ${inv.tax_id} ${inv.company}`;
  return { ...s, summary: [s.payway_zh, s.pickup && s.pickup.text, invText, s.note ? `備註：${s.note}` : null].filter(Boolean).join('｜') };
}

/** 結帳用：body 沒帶的就用偏好補。 */
function fill(member, body) {
  const p = parseRaw(member.checkout_prefs);
  return {
    pickup: body.pickup || (p.pickup_type ? { type: p.pickup_type } : undefined),
    invoice: body.invoice || p.invoice || undefined,
    note: body.note !== undefined && body.note !== null && body.note !== '' ? body.note : (p.note || null),
  };
}

module.exports = { shape, save, forOwner, fill, invoice, PAYWAYS, INTEGRATION_STATUS };
