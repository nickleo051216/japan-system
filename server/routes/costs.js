'use strict';
/**
 * 營運成本表（v1.8，022）—— 只有店主看得到。
 *
 *   GET  /costs/list?from=YYYY-MM-DD&to=YYYY-MM-DD&currency=&status=   列表＋分幣別加總
 *   POST /costs/create   手動記一筆 { spent_on, category, currency:JPY|KRW|TWD, amount, payee?, note?, paid? }
 *   POST /costs/update   改手動記的那筆（狀態已付／未付、金額、備註…）；請款單來的不能改，要到請款審核改
 *   POST /costs/remove   刪手動記的那筆
 *
 * 加總分 JPY／KRW／TWD 三種，不換匯、不混算。CSV 匯出在後台用同一份資料（UTF-8 BOM＋CRLF）。
 */
const db = require('../lib/db');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const costs = require('../lib/costs');
const { get, post, ok } = require('../lib/http');
const { now, uid } = require('../lib/ids');
const { err, num } = require('./buyer');

const CURRENCIES = ['JPY', 'KRW', 'TWD'];
const CURRENCY_ZH = { JPY: '日幣', KRW: '韓幣', TWD: '台幣' };
const STATUS_ZH = { unpaid: '未付', paid: '已付' };
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function requireOwner(actor) {
  auth.requireCap(actor, 'order.read.cost');
  if (actor.role !== 'owner') throw err('FORBIDDEN', '營運成本表只有店主看得到', 403);
}

const shape = (r) => ({
  cost_id: r.cost_id, source: r.source, source_id: r.source_id || null,
  source_zh: r.source === 'helper_claim' ? '小幫手請款' : '手動記帳',
  spent_on: typeof r.spent_on === 'string' ? r.spent_on.slice(0, 10) : new Date(r.spent_on).toISOString().slice(0, 10),
  category: r.category, currency: r.currency, currency_zh: CURRENCY_ZH[r.currency], amount: num(r.amount),
  status: r.status, status_zh: STATUS_ZH[r.status], payee: r.payee || null, note: r.note || '',
  created_at: r.created_at, paid_at: r.paid_at || null, editable: r.source === 'manual',
});

function readFields(body, partial) {
  const out = {};
  if (!partial || body.spent_on !== undefined) {
    const d = String(body.spent_on || '');
    if (!YMD.test(d) || Number.isNaN(new Date(d).getTime())) throw err('BAD_DATE', '日期要是 YYYY-MM-DD');
    out.spent_on = d;
  }
  if (!partial || body.category !== undefined) {
    const c = String(body.category || '').trim().slice(0, 30);
    if (!c) throw err('BAD_CATEGORY', '請填類別（例如：包材、國際運費、小幫手交通費）');
    out.category = c;
  }
  if (!partial || body.currency !== undefined) {
    const cur = String(body.currency || '').toUpperCase();
    if (!CURRENCIES.includes(cur)) throw err('BAD_CURRENCY', '幣別只能是 JPY（日幣）、KRW（韓幣）、TWD（台幣）');
    out.currency = cur;
  }
  if (!partial || body.amount !== undefined) {
    const a = Number(body.amount);
    if (!(a > 0) || a > 1e11) throw err('BAD_AMOUNT', '金額要大於 0');
    out.amount = Math.round(a * 100) / 100;
  }
  for (const k of ['payee', 'note']) if (body[k] !== undefined) out[k] = body[k] === null ? null : String(body[k]).trim().slice(0, k === 'note' ? 200 : 40) || null;
  if (body.paid !== undefined) { out.status = body.paid ? 'paid' : 'unpaid'; out.paid_at = body.paid ? now() : null; }
  return out;
}

get('/api/v1/costs/list', async ({ actor, query }) => {
  requireOwner(actor);
  try { await costs.backfill(); } catch (e) { if (costs.missing(e)) throw err('NOT_READY', '成本表還沒開通（資料庫還沒跑 022）', 503); throw e; }
  const where = [];
  const args = [];
  if (query.from) { if (!YMD.test(query.from)) throw err('BAD_DATE', 'from 要是 YYYY-MM-DD'); where.push('spent_on >= ?'); args.push(query.from); }
  if (query.to) { if (!YMD.test(query.to)) throw err('BAD_DATE', 'to 要是 YYYY-MM-DD'); where.push('spent_on <= ?'); args.push(query.to); }
  if (CURRENCIES.includes(query.currency)) { where.push('currency = ?'); args.push(query.currency); }
  if (STATUS_ZH[query.status]) { where.push('status = ?'); args.push(query.status); }
  const rows = await db.all(
    `SELECT * FROM operating_costs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY spent_on DESC, created_at DESC LIMIT 1000`, ...args);
  const items = rows.map(shape);
  // 分幣別加總：每一種幣別各自算合計、已付、未付。不換匯。
  const totals = {};
  for (const cur of CURRENCIES) {
    const list = items.filter((i) => i.currency === cur);
    const sum = (f) => Math.round(list.filter(f).reduce((s, i) => s + i.amount, 0) * 100) / 100;
    totals[cur] = { currency_zh: CURRENCY_ZH[cur], count: list.length, total: sum(() => true), paid: sum((i) => i.status === 'paid'), unpaid: sum((i) => i.status === 'unpaid') };
  }
  return ok({ items, totals });
});

post('/api/v1/costs/create', async ({ actor, body }) => {
  requireOwner(actor);
  const f = readFields(body, false);
  const id = uid('COST');
  await db.run(
    `INSERT INTO operating_costs (cost_id, source, spent_on, category, currency, amount, status, payee, note, created_by, created_at, paid_at)
     VALUES (?,'manual',?,?,?,?,?,?,?,?,?,?)`,
    id, f.spent_on, f.category, f.currency, f.amount, f.status || 'unpaid', f.payee ?? null, f.note ?? null, actor.line_user_id, now(), f.paid_at ?? null);
  await audit.record({ actor: actor.line_user_id, action: 'cost.create', target: id, detail: { category: f.category, currency: f.currency, amount: f.amount }, result: 'ok' });
  return ok(shape(await db.one('SELECT * FROM operating_costs WHERE cost_id = ?', id)));
});

async function manual(id) {
  const r = await db.one('SELECT * FROM operating_costs WHERE cost_id = ?', String(id ?? ''));
  if (!r) throw err('COST_NOT_FOUND', '找不到這筆成本', 404);
  if (r.source !== 'manual') throw err('FROM_CLAIM', '這筆是小幫手請款單來的，要改請到「小幫手批次請款」審核', 409);
  return r;
}

post('/api/v1/costs/update', async ({ actor, body }) => {
  requireOwner(actor);
  const r = await manual(body.cost_id);
  const f = readFields(body, true);
  const keys = Object.keys(f);
  if (!keys.length) throw err('BAD_REQUEST', '沒有要改的欄位');
  await db.run(`UPDATE operating_costs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE cost_id = ?`,   // 欄名來自 readFields 的白名單
    ...keys.map((k) => f[k]), r.cost_id);
  await audit.record({ actor: actor.line_user_id, action: 'cost.update', target: r.cost_id, detail: f, result: 'ok' });
  return ok(shape(await db.one('SELECT * FROM operating_costs WHERE cost_id = ?', r.cost_id)));
});

post('/api/v1/costs/remove', async ({ actor, body }) => {
  requireOwner(actor);
  const r = await manual(body.cost_id);
  await db.run('DELETE FROM operating_costs WHERE cost_id = ?', r.cost_id);
  await audit.record({ actor: actor.line_user_id, action: 'cost.remove', target: r.cost_id,
    detail: { category: r.category, currency: r.currency, amount: num(r.amount) }, result: 'ok' });
  return ok({ cost_id: r.cost_id, removed: true });
});

module.exports = {};
