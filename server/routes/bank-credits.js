'use strict';
/**
 * 匯款自動對帳 —— 銀行入帳（v1.8，022）。
 *
 *   POST /bank-credits/create   店主輸入一筆銀行入帳（參考號、金額、末五碼、入帳時間）→ 自動配對
 *   GET  /bank-credits/list     入帳紀錄（?status=needs_review 只看待人工確認）
 *   POST /bank-credits/confirm  待人工確認的那筆，店主挑一張帳單按確認
 *   POST /bank-credits/ignore   不是貨款（例如退款、轉錯）：標成不處理
 *
 * 配對規則：「待付款／待官方確認」的帳單裡，總額＝入帳金額 而且 客人回報的末五碼＝入帳末五碼。
 *   剛好一張 → 直接核帳（帳單和底下訂單標成已付、發「收到款項」通知）。店主輸入入帳就是他確認了這筆錢。
 *   零張或好幾張 → 「待人工確認」，列出可能的帳單（同金額、或同末五碼）給店主挑，最後一步一定是店主按。
 * 同一筆入帳（ref_no）不能輸入兩次；同一張帳單也不能被兩筆入帳配到（022 的唯一索引）。
 * 只有店主（payment.reconcile）能用。
 */
const db = require('../lib/db');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const { get, post, ok } = require('../lib/http');
const { now, uid } = require('../lib/ids');
const { err, num } = require('./buyer');
const { reconcileStatement } = require('./admin-shop');

const STATUS_ZH = { matched: '已自動配對', needs_review: '待人工確認', confirmed: '店主確認', ignored: '不處理' };
const UNPAID = ['待付款', '待官方確認'];

async function shape(c) {
  const ids = [c.statement_id, ...(c.candidates || [])].filter(Boolean);
  const stmts = ids.length ? await db.all(
    `SELECT s.statement_id, s.total_amount, s.payment_status, s.last_five_matched, s.created_at, m.nickname, m.member_no
       FROM statements s JOIN members m ON m.line_user_id = s.line_user_id WHERE s.statement_id = ANY(?::text[])`, ids) : [];
  const byId = new Map(stmts.map((s) => [s.statement_id, { ...s, total_amount: num(s.total_amount) }]));
  return {
    credit_id: c.credit_id, ref_no: c.ref_no, amount_twd: num(c.amount_twd), last5: c.last5 || null,
    credited_at: c.credited_at, status: c.status, status_zh: STATUS_ZH[c.status], reason: c.reason || null, note: c.note || '',
    statement: c.statement_id ? byId.get(c.statement_id) || { statement_id: c.statement_id } : null,
    candidates: (c.candidates || []).map((id) => byId.get(id)).filter(Boolean),
    created_at: c.created_at, decided_at: c.decided_at || null,
  };
}

const one = (id) => db.one('SELECT * FROM bank_credits WHERE credit_id = ?', id);

post('/api/v1/bank-credits/create', async ({ actor, body }) => {
  auth.requireCap(actor, 'payment.reconcile');
  const ref = String(body.ref_no ?? '').trim().slice(0, 60);
  if (!ref) throw err('BAD_REF', '請填銀行的交易參考號（每筆入帳都不一樣，用來避免同一筆記兩次）');
  const amount = Number(body.amount_twd);
  if (!(amount > 0) || amount > 10_000_000) throw err('BAD_AMOUNT', '入帳金額要大於 0');
  const last5 = body.last5 === undefined || body.last5 === null || body.last5 === '' ? null : String(body.last5);
  if (last5 !== null && !/^\d{5}$/.test(last5)) throw err('BAD_LAST5', '末五碼要是 5 碼數字');
  const at = body.credited_at ? new Date(String(body.credited_at)) : new Date();
  if (Number.isNaN(at.getTime())) throw err('BAD_TIME', '入帳時間格式不對');
  const note = body.note ? String(body.note).trim().slice(0, 200) : null;
  if (await db.one('SELECT credit_id FROM bank_credits WHERE ref_no = ?', ref)) {
    throw err('DUPLICATE_REF', `參考號 ${ref} 已經輸入過了，同一筆入帳不能用兩次`, 409);
  }

  // 配對：末五碼＋金額都對得上、還沒付清、還沒被別筆入帳配走的帳單。
  const exact = last5 === null ? [] : await db.all(
    `SELECT s.* FROM statements s
      WHERE s.payment_status = ANY(?::text[]) AND s.total_amount = ? AND s.last_five_matched = ?
        AND NOT EXISTS (SELECT 1 FROM bank_credits b WHERE b.statement_id = s.statement_id AND b.status IN ('matched','confirmed'))
      ORDER BY s.created_at`, UNPAID, amount, last5);
  const id = uid('BC');
  let status = 'needs_review';
  let reason;
  let candidates = [];
  if (exact.length === 1) {
    status = 'matched';
    candidates = [exact[0].statement_id];   // 萬一核帳沒成功，店主還是看得到是哪一張
  } else if (exact.length > 1) {
    reason = `有 ${exact.length} 張帳單的金額和末五碼都一樣，請店主挑一張`;
    candidates = exact.map((s) => s.statement_id);
  } else {
    // 配不到：給店主幾張可能的（同金額、或同末五碼），最多 10 張。
    const near = await db.all(
      `SELECT s.statement_id FROM statements s
        WHERE s.payment_status = ANY(?::text[]) AND (s.total_amount = ? OR (?::text IS NOT NULL AND s.last_five_matched = ?))
          AND NOT EXISTS (SELECT 1 FROM bank_credits b WHERE b.statement_id = s.statement_id AND b.status IN ('matched','confirmed'))
        ORDER BY (s.total_amount = ?) DESC, s.created_at LIMIT 10`, UNPAID, amount, last5, last5, amount);
    candidates = near.map((s) => s.statement_id);
    reason = last5 === null ? '沒有末五碼，沒辦法自動配對' : '找不到金額和末五碼都對得上的帳單（客人可能還沒回報，或金額不同）';
  }

  await db.run(
    `INSERT INTO bank_credits (credit_id, ref_no, amount_twd, last5, credited_at, status, candidates, reason, note, created_by, created_at)
     VALUES (?,?,?,?,?,'needs_review',?,?,?,?,?)`,
    id, ref, amount, last5, at.toISOString(), candidates, reason || null, note, actor.line_user_id, now());
  if (status === 'matched') {
    const s = exact[0];
    try {
      await reconcileStatement(s, {
        amount, by: actor.line_user_id, method: 'transfer', last5,
        auditExtra: { bank_credit: id, ref_no: ref, auto_matched: true },
        extra: async () => {
          await db.run(`UPDATE bank_credits SET status = 'matched', statement_id = ?, decided_by = ?, decided_at = ? WHERE credit_id = ?`,
            s.statement_id, actor.line_user_id, now(), id);
        },
      });
    } catch (e) {
      // 例如同一時間另一個人剛好核掉了：入帳留著，改成待人工確認。
      status = 'needs_review';
      await db.run('UPDATE bank_credits SET reason = ? WHERE credit_id = ?', `自動核帳沒有成功：${e.message}`, id);
    }
  }
  await audit.record({ actor: actor.line_user_id, action: 'bank_credit.create', target: id,
    detail: { ref_no: ref, amount, last5, status, statement_id: status === 'matched' ? exact[0].statement_id : null, candidates: candidates.length },
    result: status === 'matched' ? 'ok' : 'warn' });
  return ok(await shape(await one(id)));
});

get('/api/v1/bank-credits/list', async ({ actor, query }) => {
  auth.requireCap(actor, 'payment.reconcile');
  const st = STATUS_ZH[query.status] ? query.status : null;
  const rows = await db.all(
    `SELECT * FROM bank_credits ${st ? 'WHERE status = ?' : ''}
      ORDER BY (status = 'needs_review') DESC, created_at DESC LIMIT 200`, ...(st ? [st] : []));
  const out = [];
  for (const r of rows) out.push(await shape(r));
  return ok({ items: out, needs_review: Number((await db.one("SELECT count(*) AS n FROM bank_credits WHERE status = 'needs_review'")).n) });
});

/** 待人工確認的那筆：店主挑一張帳單按確認。金額不一樣要另外勾 accept_difference（跟手動核帳同一套）。 */
post('/api/v1/bank-credits/confirm', async ({ actor, body }) => {
  auth.requireCap(actor, 'payment.reconcile');
  const c = await one(String(body.credit_id ?? ''));
  if (!c) throw err('CREDIT_NOT_FOUND', '找不到這筆入帳', 404);
  if (c.status !== 'needs_review') throw err('ALREADY_DECIDED', `這筆入帳已經是「${STATUS_ZH[c.status]}」了`, 409);
  const s = await db.one('SELECT * FROM statements WHERE statement_id = ?', String(body.statement_id ?? ''));
  if (!s) throw err('STATEMENT_NOT_FOUND', '找不到這張帳單', 404);
  const used = await db.one("SELECT credit_id FROM bank_credits WHERE statement_id = ? AND status IN ('matched','confirmed')", s.statement_id);
  if (used) throw err('STATEMENT_TAKEN', `這張帳單已經被入帳 ${used.credit_id} 配走了`, 409);
  const result = await reconcileStatement(s, {
    amount: num(c.amount_twd), by: actor.line_user_id, method: 'transfer', last5: c.last5,
    acceptDifference: !!body.accept_difference, auditExtra: { bank_credit: c.credit_id, ref_no: c.ref_no, manual: true },
    extra: async () => {
      const res = await db.run(`UPDATE bank_credits SET status = 'confirmed', statement_id = ?, decided_by = ?, decided_at = ?
                                 WHERE credit_id = ? AND status = 'needs_review'`, s.statement_id, actor.line_user_id, now(), c.credit_id);
      if (!res.changes) throw err('ALREADY_DECIDED', '這筆入帳剛剛已經處理過了', 409);
    },
  });
  return ok({ ...(await shape(await one(c.credit_id))), result });
});

post('/api/v1/bank-credits/ignore', async ({ actor, body }) => {
  auth.requireCap(actor, 'payment.reconcile');
  const c = await one(String(body.credit_id ?? ''));
  if (!c) throw err('CREDIT_NOT_FOUND', '找不到這筆入帳', 404);
  if (c.status !== 'needs_review') throw err('ALREADY_DECIDED', `這筆入帳已經是「${STATUS_ZH[c.status]}」了`, 409);
  const note = body.note ? String(body.note).trim().slice(0, 200) : null;
  await db.run(`UPDATE bank_credits SET status = 'ignored', note = coalesce(?, note), decided_by = ?, decided_at = ? WHERE credit_id = ?`,
    note, actor.line_user_id, now(), c.credit_id);
  await audit.record({ actor: actor.line_user_id, action: 'bank_credit.ignore', target: c.credit_id, detail: { note }, result: 'ok' });
  return ok(await shape(await one(c.credit_id)));
});

module.exports = {};
