'use strict';
/**
 * 許願預算自動決定（v1.8，022）。
 *
 * 客人許願或按 +1 時可以設兩個數字（都選填，至少一個）：
 *   auto_buy_max  報價 ≤ 這個數 → 自動幫我買（放進購物車、已確認、數量 1）
 *   reject_above  報價 > 這個數 → 自動略過（不買，也不再問）
 *   中間的       → 待回覆（照舊問客人）
 *
 * 店家報價時，對「許願的人」和「每一位按 +1 的人」各自判斷，結果記在 wish_decisions：
 *   - 報價當下的預算存成快照，之後客人改預算不影響這一次的結果。
 *   - 同一個人對同一則許願只會「自動成立」一次（部分唯一索引 wish_decisions_auto_buy_uq），
 *     店家重新報價也不會自動成立第二筆。
 *   - 每一個自動決定都發一則通知（種類 wish_auto），客人付款前都可以取消。
 *
 * 隱私：預算只有本人看得到。店家看得到的是 summary()：幾個人設了預算、數字的分布，沒有是誰。
 *
 * 正式庫還沒跑 022 時（表不存在）：讀的地方當作沒有人設預算，報價照舊，不讓報價失敗。
 */
const db = require('./db');
const notify = require('./notify');
const { link } = require('./customer-notify');
const { now, uid } = require('./ids');

const ntd = (v) => 'NT$' + Math.round(Number(v) || 0).toLocaleString('en-US');
const n2 = (v) => (v === null || v === undefined ? null : Number(v));
const missing = (e) => e && (e.code === '42P01' || e.code === '42703');   // 022 還沒跑
const bad = (code, message, status = 400) => Object.assign(new Error(message), { code, status });

/**
 * 從請求讀預算。兩個欄位都沒帶 → undefined（不動）；兩個都是 null／空字串 → null（清掉）。
 * 驗證：都要 > 0、auto_buy_max ≤ reject_above、可以只填一個。
 */
function parse(body) {
  const has = (k) => body && Object.prototype.hasOwnProperty.call(body, k);
  if (!has('auto_buy_max') && !has('reject_above')) return undefined;
  const read = (k) => {
    const v = body[k];
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw bad('BAD_BUDGET', k === 'auto_buy_max' ? '「自動幫我買」的金額要大於 0' : '「自動不要」的金額要大於 0');
    if (n > 1_000_000) throw bad('BAD_BUDGET', '預算金額太大了');
    return Math.round(n);
  };
  const auto = read('auto_buy_max');
  const reject = read('reject_above');
  if (auto === null && reject === null) return null;
  if (auto !== null && reject !== null && auto > reject) {
    throw bad('BAD_BUDGET', '「自動幫我買」的金額不能比「自動不要」的金額高');
  }
  return { auto_buy_max: auto, reject_above: reject };
}

/** 前台顯示的一句話規則，例如「報價 ≤ NT$800 自動幫你買；超過 NT$1,000 自動略過；中間的會問你」。 */
function ruleText(b) {
  if (!b) return null;
  const a = n2(b.auto_buy_max);
  const r = n2(b.reject_above);
  const parts = [];
  if (a !== null) parts.push(`報價 ≤ ${ntd(a)} 自動幫你買`);
  if (r !== null) parts.push(`超過 ${ntd(r)} 自動略過`);
  parts.push(a !== null && r !== null ? '中間的會問你' : a !== null ? '超過的會問你' : '沒超過的會問你');
  return parts.join('；');
}

const shape = (b) => (b ? {
  auto_buy_max: n2(b.auto_buy_max), reject_above: n2(b.reject_above),
  rule_text: ruleText(b), updated_at: b.updated_at,
} : null);

const DECISION_ZH = { auto_buy: '預算內自動確認', auto_reject: '超過預算自動略過', pending: '報價在預算中間，等你決定' };
const STATUS_ZH = { open: '等你決定', accepted: '已放進購物車', declined: '不要', cancelled: '已取消' };

const decisionShape = (d) => (d ? {
  decision_id: d.decision_id, decision: d.decision, decision_zh: DECISION_ZH[d.decision],
  status: d.status, status_zh: STATUS_ZH[d.status],
  quote_twd: n2(d.quote_twd), authorization_max: n2(d.auto_buy_max), reject_above: n2(d.reject_above),
  cart_id: d.cart_id || null, created_at: d.created_at, decided_at: d.decided_at || null,
  can_cancel: d.decision === 'auto_buy' && d.status === 'accepted',
  can_decide: d.status === 'open',
} : null);

async function mine(wishId, user) {
  try {
    return await db.one('SELECT * FROM wish_budgets WHERE wish_id = ? AND line_user_id = ?', wishId, user);
  } catch (e) { if (missing(e)) return null; throw e; }
}

/** 一次讀很多則許願的「我的預算」與「我最新的決定」。 */
async function mineMany(wishIds, user) {
  const budgets = new Map();
  const decisions = new Map();
  if (!wishIds.length) return { budgets, decisions };
  try {
    for (const b of await db.all('SELECT * FROM wish_budgets WHERE line_user_id = ? AND wish_id = ANY(?::text[])', user, wishIds)) budgets.set(b.wish_id, b);
    for (const d of await db.all(
      `SELECT DISTINCT ON (wish_id) * FROM wish_decisions
        WHERE line_user_id = ? AND wish_id = ANY(?::text[]) ORDER BY wish_id, created_at DESC, decision_id DESC`, user, wishIds)) {
      decisions.set(d.wish_id, d);
    }
  } catch (e) { if (!missing(e)) throw e; }
  return { budgets, decisions };
}

/** 存（或清掉）我的預算。b 是 parse() 的結果。 */
async function save(wishId, user, b) {
  if (b === undefined) return;
  try {
    if (b === null) {
      await db.run('DELETE FROM wish_budgets WHERE wish_id = ? AND line_user_id = ?', wishId, user);
      return;
    }
    await db.run(
      `INSERT INTO wish_budgets (wish_id, line_user_id, auto_buy_max, reject_above, updated_at) VALUES (?,?,?,?,?)
       ON CONFLICT (wish_id, line_user_id) DO UPDATE
         SET auto_buy_max = excluded.auto_buy_max, reject_above = excluded.reject_above, updated_at = excluded.updated_at`,
      wishId, user, b.auto_buy_max, b.reject_above, now());
  } catch (e) {
    if (missing(e)) throw bad('NOT_READY', '預算功能還沒開通（資料庫還沒更新），請先不要設預算', 503);
    throw e;
  }
}

/** 取消 +1：預算刪掉，還在等決定的也取消（從名單移除）。 */
async function dropVoter(wishId, user) {
  try {
    await db.run('DELETE FROM wish_budgets WHERE wish_id = ? AND line_user_id = ?', wishId, user);
    await db.run(
      `UPDATE wish_decisions SET status = 'cancelled', decided_at = ? WHERE wish_id = ? AND line_user_id = ? AND status = 'open'`,
      now(), wishId, user);
  } catch (e) { if (!missing(e)) throw e; }
}

/**
 * 店家看的預算分布：幾個人設了、數字的分布。只有數字，不給是誰（也不給 line_user_id、暱稱）。
 * 數字排序過，看不出誰先設誰後設。
 */
async function summary(wishId) {
  let rows = [];
  try {
    rows = await db.all('SELECT auto_buy_max, reject_above FROM wish_budgets WHERE wish_id = ?', wishId);
  } catch (e) { if (missing(e)) return { count: 0, auto_buy_max: [], reject_above: [] }; throw e; }
  const nums = (k) => rows.map((r) => n2(r[k])).filter((v) => v !== null).sort((a, b) => a - b);
  return { count: rows.length, auto_buy_max: nums('auto_buy_max'), reject_above: nums('reject_above') };
}

/** 很多則一起算（後台列表用）：Map(wish_id → summary)。 */
async function summaryMany(wishIds) {
  const out = new Map();
  if (!wishIds.length) return out;
  try {
    const rows = await db.all(
      `SELECT wish_id, count(*) AS n,
              array_remove(array_agg(auto_buy_max ORDER BY auto_buy_max), NULL) AS a,
              array_remove(array_agg(reject_above ORDER BY reject_above), NULL) AS r
         FROM wish_budgets WHERE wish_id = ANY(?::text[]) GROUP BY wish_id`, wishIds);
    for (const r of rows) out.set(r.wish_id, { count: Number(r.n), auto_buy_max: (r.a || []).map(Number), reject_above: (r.r || []).map(Number) });
  } catch (e) { if (!missing(e)) throw e; }
  return out;
}

/** 判斷一個人：報價 quote 時，他的預算 b 會落在哪裡。 */
function judge(quote, b) {
  if (!b) return null;
  const a = n2(b.auto_buy_max);
  const r = n2(b.reject_above);
  if (a !== null && quote <= a) return 'auto_buy';
  if (r !== null && quote > r) return 'auto_reject';
  return 'pending';
}

/**
 * 報價前試算：如果報這個價，會自動成立幾筆、略過幾筆、要問幾個人。給店家報價視窗用。
 * 已經自動成立過的人不再算進「自動成立」（重新報價也不會再成立第二筆）。
 */
async function preview(wishId, quote) {
  const out = { auto_buy: 0, auto_reject: 0, pending: 0, already_bought: 0, no_budget: 0 };
  try {
    const people = await people_(wishId);
    const budgets = new Map((await db.all('SELECT * FROM wish_budgets WHERE wish_id = ?', wishId)).map((b) => [b.line_user_id, b]));
    const bought = new Set((await db.all("SELECT line_user_id FROM wish_decisions WHERE wish_id = ? AND decision = 'auto_buy'", wishId)).map((r) => r.line_user_id));
    for (const p of people) {
      const j = judge(quote, budgets.get(p.line_user_id));
      if (!j) out.no_budget++;
      else if (j === 'auto_buy' && bought.has(p.line_user_id)) out.already_bought++;
      else out[j]++;
    }
  } catch (e) { if (!missing(e)) throw e; }
  return out;
}

/** 許願的人＋按 +1 的人。 */
async function people_(wishId) {
  const w = await db.one('SELECT line_user_id FROM wishlist WHERE wish_id = ?', wishId);
  const voters = await db.all('SELECT line_user_id FROM wish_votes WHERE wish_id = ? ORDER BY created_at', wishId);
  return [{ line_user_id: w.line_user_id, role: 'owner' }, ...voters.map((v) => ({ line_user_id: v.line_user_id, role: 'voter' }))];
}

/** 放進購物車（已確認、數量 1）。 */
async function addToCart(w, user, quote, note) {
  const cartId = uid('C');
  await db.run(
    `INSERT INTO cart_items (cart_id, line_user_id, source, ref, name, jpy_taxed, price_twd, qty,
                             ai_confidence, status, note, image_url, created_at)
     VALUES (?,?,'wish',?,?,NULL,?,1,'high','confirmed',?,?,?)`,
    cartId, user, w.wish_id, w.item_name, quote, note, w.picture || null, now());
  return cartId;
}

/**
 * 店家報價之後跑：對每個人各自判斷、記快照、自動成立／略過，排通知。
 * 回 { owner_auto: bool（許願的人有沒有被自動處理，有的話不用再發一般的「報價好了」）, results:[…] }。
 * 通知在交易外面排（排不進去不能讓報價失敗）。
 */
async function onQuote(wishId, actor) {
  let results = [];
  try {
    results = await db.tx(async () => {
      const w = await db.one('SELECT * FROM wishlist WHERE wish_id = ? FOR UPDATE', wishId);
      const quote = n2(w.quote_twd);
      const people = await people_(wishId);
      const budgets = new Map((await db.all('SELECT * FROM wish_budgets WHERE wish_id = ?', wishId)).map((b) => [b.line_user_id, b]));
      if (!budgets.size) return [];
      // 上一次報價還在等決定的，被這次報價取代。
      await db.run("UPDATE wish_decisions SET status = 'cancelled', decided_at = ? WHERE wish_id = ? AND status = 'open'", now(), wishId);
      const out = [];
      for (const p of people) {
        const b = budgets.get(p.line_user_id);
        const j = judge(quote, b);
        if (!j) continue;
        if (j === 'auto_buy') {
          const had = await db.one("SELECT decision_id FROM wish_decisions WHERE wish_id = ? AND line_user_id = ? AND decision = 'auto_buy'", wishId, p.line_user_id);
          if (had) continue;   // 已經自動成立過，不成立第二筆
        }
        const id = uid('WD');
        let cartId = null;
        if (j === 'auto_buy') {
          cartId = await addToCart(w, p.line_user_id, quote, `預算內自動確認（≤ ${ntd(b.auto_buy_max)}）`);
          if (p.role === 'owner') await db.run("UPDATE wishlist SET wish_status = '已下單' WHERE wish_id = ?", wishId);
        }
        await db.run(
          `INSERT INTO wish_decisions (decision_id, wish_id, line_user_id, role, quote_twd, auto_buy_max, reject_above,
                                       decision, status, cart_id, created_at, decided_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          id, wishId, p.line_user_id, p.role, quote, b.auto_buy_max, b.reject_above, j,
          j === 'auto_buy' ? 'accepted' : j === 'auto_reject' ? 'declined' : 'open', cartId, now(), j === 'pending' ? null : now());
        out.push({ decision_id: id, wish_id: wishId, line_user_id: p.line_user_id, role: p.role, decision: j, cart_id: cartId,
          auto_buy_max: n2(b.auto_buy_max), reject_above: n2(b.reject_above), quote, name: w.item_name });
      }
      return out;
    });
  } catch (e) {
    if (missing(e)) return { owner_auto: false, results: [] };
    throw e;
  }
  for (const r of results) {
    // 許願的人「待回覆」已經會收到一般的「報價好了」，不另外再發一則。
    if (r.decision === 'pending' && r.role === 'owner') continue;
    await tell(r);
  }
  const counts = results.reduce((a, r) => ({ ...a, [r.decision]: (a[r.decision] || 0) + 1 }), {});
  return { owner_auto: results.some((r) => r.role === 'owner' && r.decision !== 'pending'), results, counts, actor: actor && actor.line_user_id };
}

function messageFor(r) {
  const name = `「${r.name}」`;
  if (r.decision === 'auto_buy') {
    return { path: 'cart', text: `🛍️ 預算內，已幫你保留\n\n${name}報價 ${ntd(r.quote)}，在你設的 ${ntd(r.auto_buy_max)} 以內，`
      + `已放進購物車（1 件）。\n付款前都可以取消：到「我的許願」按「取消自動保留」，或從購物車移除。\n\n查看購物車 👉\n${link('cart')}` };
  }
  if (r.decision === 'auto_reject') {
    return { path: 'wish', text: `🙅 超過預算，先幫你略過\n\n${name}報價 ${ntd(r.quote)}，超過你設的 ${ntd(r.reject_above)}，這次先不買。\n`
      + `還是想要的話，到「我的許願」看看 👉\n${link('wish')}` };
  }
  const range = [r.auto_buy_max !== null ? `≤ ${ntd(r.auto_buy_max)} 自動買` : null, r.reject_above !== null ? `超過 ${ntd(r.reject_above)} 略過` : null].filter(Boolean).join('、');
  return { path: 'wish', text: `💰 你按 +1 的許願有報價了\n\n${name}${ntd(r.quote)}\n（你設的是 ${range}，這次在中間）\n要的話到「我的許願」決定 👉\n${link('wish')}` };
}

async function tell(r) {
  const { path, text } = messageFor(r);
  try {
    const queued = await notify.queue({ kind: 'wish_auto', lineUserId: r.line_user_id,
      payload: { decision_id: r.decision_id, wish_id: r.wish_id, decision: r.decision, quote_twd: r.quote, cart_id: r.cart_id, path, text } });
    if (queued) notify.poke();
  } catch (e) {
    console.warn('[wish-budget] 通知沒排進佇列（不影響報價）：', e.code || '', e.message);
  }
}

module.exports = { parse, save, mine, mineMany, shape, decisionShape, summary, summaryMany, preview, onQuote, dropVoter, ruleText, judge, addToCart, missing };
