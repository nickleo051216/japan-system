'use strict';
/**
 * 寄送方式（出貨申請 v1.7）。
 *
 * 前台送 `pickup: { type: "cvs" | "home", … }`：
 *   超商 cvs  ：{ type:"cvs", brand?, store_id?, store_name?, addr? }
 *              沒帶門市（store_name 和 store_id 都沒有）→ 用會員資料裡的預設門市。
 *   宅配 home ：{ type:"home", addr? }
 *              沒帶 addr → 用會員資料裡的宅配地址。
 *   兩種都找不到可寄的地方 → 400 PICKUP_INCOMPLETE（請客人先補資料）。
 *
 * 存進資料庫的是「解析後」的完整寄送資訊（含 from_default：有沒有沿用會員預設），
 * 這樣會員之後改了預設門市，這筆申請要寄去哪裡也不會跟著變。
 *
 * 寫回訂單／出貨單的 pickup 欄位沿用結帳的規則：超商寫「品牌 門市」，宅配一律寫 shipfee.HOME_PICKUP，
 * 重算運費時 pickupTypeOf() 才分得出來。
 */
const { HOME_PICKUP } = require('./shipfee');

const clip = (v, max) => (v === undefined || v === null ? null : String(v).trim().slice(0, max) || null);

const bad = (code, message) => Object.assign(new Error(message), { code, status: 400 });

/**
 * 把前台送的 pickup 解析成完整的寄送資訊。input 沒帶（undefined／null）回 null = 沿用訂單原本的寄送方式。
 * member 是 members 那一列（要有 cvs_* 和 home_addr）。
 */
function resolve(member, input) {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw bad('BAD_PICKUP', 'pickup 要是 { type: "cvs" | "home", … }');
  const type = String(input.type || '');
  if (!['cvs', 'home'].includes(type)) throw bad('BAD_PICKUP', '寄送方式只能是超商（cvs）或宅配（home）');
  const m = member || {};

  if (type === 'home') {
    const given = clip(input.addr, 200);
    const addr = given || clip(m.home_addr, 200);
    if (!addr) throw bad('PICKUP_INCOMPLETE', '宅配要填地址（會員資料裡也還沒有宅配地址）');
    return { type: 'home', addr, from_default: !given };
  }

  const givenStore = clip(input.store_name, 60) || clip(input.store_id, 30);
  const src = givenStore ? input : m;
  const pick = (k, max) => clip(givenStore ? src[k] : src[`cvs_${k}`], max);
  const out = {
    type: 'cvs',
    brand: pick('brand', 20),
    store_id: pick('store_id', 30),
    store_name: pick('store_name', 60),
    addr: pick('addr', 200),
    from_default: !givenStore,
  };
  if (!out.store_name && !out.store_id) throw bad('PICKUP_INCOMPLETE', '超商取貨要選門市（會員資料裡也還沒有預設門市）');
  return out;
}

/** 寫回 orders／ship_groups 的 pickup、pickup_addr 兩欄。 */
function columns(p) {
  if (p.type === 'home') return { pickup: HOME_PICKUP, pickup_addr: p.addr || '' };
  const label = [p.brand, p.store_name].filter(Boolean).join(' ') || (p.store_id ? `門市 ${p.store_id}` : '超商取貨');
  return { pickup: label, pickup_addr: p.addr || '' };
}

/** 給人看的一行字：「超商 7-11 板橋文化門市」「宅配 新北市…」。 */
function describe(p) {
  if (!p) return null;
  const c = columns(p);
  return p.type === 'home' ? `宅配到府 ${c.pickup_addr}`.trim() : `超商取貨 ${c.pickup}`;
}

/** 資料庫讀出來的 jsonb（PGlite／pg 會給物件，保險起見也接字串）。 */
function parse(v) {
  if (!v) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
  return v;
}

module.exports = { resolve, columns, describe, parse };
