'use strict';
/**
 * 小幫手工作台 —— v1.6 第 ⑤ 項（015）。
 *
 *   邀請碼（店主開，對方輸入就變成員工）：
 *     店主  /staff-invites/create、/list、/revoke
 *     對方  /staff/join（用買家 LIFF 登入後輸入）或後台 LINE 登入時帶 invite_code（/auth/line）
 *   我的採買清單：/helper/my-list —— 只列我認領的，標出哪些還沒拍收據
 *   批次拍收據請款：
 *     /helper/receipts/upload —— 一次一張（Vercel 一次請求上限 4.5 MB），先存起來還不算請款
 *     /helper/claims/create   —— 把好幾張收據一起送成一張請款單，每張填日幣；可以順便記成本
 *     /helper/claims          —— 我的請款單
 *     店主 /helper-claims/admin-list、/helper-claims/decide（核准／退回／已付款）
 *
 * 邀請碼只存雜湊。原文只在開碼那一刻回給店主一次 —— 這支回應刻意不進冪等快取，
 * 跟登入回 token 同一個理由：存一份等於多一條不用店主就拿得到邀請碼的路。
 */
const crypto = require('node:crypto');
const db = require('../lib/db');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const money = require('../lib/money');
const storage = require('../lib/storage');
const { get, post, ok } = require('../lib/http');
const { now, uid } = require('../lib/ids');
const { bpost, err, num } = require('./buyer');
const { boardRows, recordExpense } = require('./procurement');

const ROLE_ZH = { helper: '日本小幫手', packer: '包貨人員' };
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // 沒有 0/O、1/I/L，念給對方聽不會搞混
const MAX_FAILS_PER_HOUR = 10;
const MAX_RECEIPTS = 20;
const IMG = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;
const IMG_MAX = 3 * 1024 * 1024;
const CLAIM_ZH = { pending: '待審核', approved: '已核准', paid: '已付款', rejected: '退回' };

const normalise = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashCode = (code) => crypto.createHash('sha256').update(normalise(code)).digest('hex');
function newCode() {
  const bytes = crypto.randomBytes(8);
  const raw = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}
const text = (v, max) => (v === undefined || v === null ? null : String(v).trim().slice(0, max) || null);

// ---- 邀請碼 ---------------------------------------------------------------

async function inviteShape(i) {
  const uses = await db.all(
    `SELECT m.nickname, m.member_no, u.used_at FROM staff_invite_uses u JOIN members m ON m.line_user_id = u.line_user_id
      WHERE u.invite_id = ? ORDER BY u.used_at`, i.invite_id);
  const state = i.revoked_at ? 'revoked' : i.used_count >= i.max_uses ? 'used_up'
    : new Date(i.expires_at) <= new Date() ? 'expired' : 'active';
  return {
    invite_id: i.invite_id, code_hint: i.code_hint, role: i.role, role_zh: ROLE_ZH[i.role],
    max_uses: i.max_uses, used_count: i.used_count, expires_at: i.expires_at, revoked_at: i.revoked_at || null,
    note: i.note || '', created_at: i.created_at,
    state, state_zh: { active: '可以用', used_up: '用完了', expired: '過期了', revoked: '已作廢' }[state],
    used_by: uses.map((u) => ({ nickname: u.nickname, member_no: u.member_no, used_at: u.used_at })),
  };
}

post('/api/v1/staff-invites/create', async ({ actor, body }) => {
  auth.requireCap(actor, 'settings.write');
  const role = String(body.role || 'helper');
  if (!ROLE_ZH[role]) throw err('BAD_ROLE', '邀請碼只能邀請日本小幫手或包貨人員');
  const maxUses = body.max_uses === undefined ? 1 : parseInt(body.max_uses, 10);
  if (!(maxUses >= 1 && maxUses <= 20)) throw err('BAD_MAX_USES', '可以用的次數要是 1～20');
  const hours = body.hours === undefined ? 72 : parseInt(body.hours, 10);
  if (!(hours >= 1 && hours <= 720)) throw err('BAD_HOURS', '有效時間要是 1～720 小時（30 天）');
  const code = newCode();
  const id = uid('INV');
  await db.run(
    `INSERT INTO staff_invites (invite_id, code_hash, code_hint, role, max_uses, expires_at, note, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id, hashCode(code), code.slice(-2), role, maxUses, new Date(Date.now() + hours * 3600e3).toISOString(),
    text(body.note, 60), actor.line_user_id, now());
  await audit.record({ actor: actor.line_user_id, action: 'staff.invite_create', target: id, detail: { role, max_uses: maxUses, hours }, result: 'ok' });
  // code 只有這裡會出現一次。
  return ok({ ...(await inviteShape(await db.one('SELECT * FROM staff_invites WHERE invite_id = ?', id))), code });
}, { idempotent: false });

get('/api/v1/staff-invites/list', async ({ actor }) => {
  auth.requireCap(actor, 'settings.write');
  const rows = await db.all('SELECT * FROM staff_invites ORDER BY created_at DESC LIMIT 50');
  const out = [];
  for (const r of rows) out.push(await inviteShape(r));
  return ok(out);
});

post('/api/v1/staff-invites/revoke', async ({ actor, body }) => {
  auth.requireCap(actor, 'settings.write');
  const res = await db.run('UPDATE staff_invites SET revoked_at = ? WHERE invite_id = ? AND revoked_at IS NULL', now(), String(body.invite_id || ''));
  if (!res.changes) throw err('INVITE_NOT_FOUND', '找不到這組邀請碼（或已經作廢了）', 404);
  await audit.record({ actor: actor.line_user_id, action: 'staff.invite_revoke', target: String(body.invite_id), result: 'ok' });
  return ok(await inviteShape(await db.one('SELECT * FROM staff_invites WHERE invite_id = ?', String(body.invite_id))));
});

/**
 * 用邀請碼把一位會員變成員工。給 /staff/join 和後台 LINE 登入（/auth/line 帶 invite_code）共用。
 * 失敗太多次（一小時 10 次）就先擋，避免有人一直猜。
 */
async function redeemInvite(member, code) {
  if (member.role === 'owner') throw err('ALREADY_STAFF', '你是店主，不用邀請碼', 409);
  if (member.role !== 'buyer') throw err('ALREADY_STAFF', `你已經是${ROLE_ZH[member.role] || '員工'}了，直接登入後台就好`, 409);
  if (member.status === '停用') throw err('FORBIDDEN', '帳號已停用，請聯絡店主', 403);
  const fails = await db.one(
    `SELECT count(*) AS n FROM audit_log WHERE actor = ? AND action = 'staff.invite_join' AND result = 'blocked'
        AND ts > now() - interval '1 hour'`, member.line_user_id);
  if (Number(fails.n) >= MAX_FAILS_PER_HOUR) throw err('TOO_MANY_ATTEMPTS', '輸入錯太多次了，請一小時後再試，或請店家重新給你一組', 429);

  const blocked = async (code_, message, status = 409) => {
    await audit.record({ actor: member.line_user_id, action: 'staff.invite_join', detail: { reason: code_ }, result: 'blocked' });
    return err(code_, message, status);
  };
  if (normalise(code).length !== 8) throw await blocked('INVITE_INVALID', '邀請碼是 8 個英數字（例如 ABCD-2345），請再確認一下', 400);
  const invite = await db.one('SELECT * FROM staff_invites WHERE code_hash = ?', hashCode(code));
  if (!invite) throw await blocked('INVITE_INVALID', '這組邀請碼不對，請再確認一下', 404);
  if (invite.revoked_at) throw await blocked('INVITE_REVOKED', '這組邀請碼已經作廢了，請跟店家拿新的');
  if (new Date(invite.expires_at) <= new Date()) throw await blocked('INVITE_EXPIRED', '這組邀請碼過期了，請跟店家拿新的');

  const role = await db.tx(async () => {
    // 條件更新：同時好幾個人用最後一個名額，只有一個人會成功。
    const res = await db.run(
      `UPDATE staff_invites SET used_count = used_count + 1
        WHERE invite_id = ? AND used_count < max_uses AND revoked_at IS NULL AND expires_at > now() RETURNING role`,
      invite.invite_id);
    if (!res.changes) return null;
    await db.run('INSERT INTO staff_invite_uses (invite_id, line_user_id, used_at) VALUES (?,?,?)', invite.invite_id, member.line_user_id, now());
    await db.run("UPDATE members SET role = ? WHERE line_user_id = ? AND role = 'buyer'", res.rows[0].role, member.line_user_id);
    return res.rows[0].role;
  });
  if (!role) throw await blocked('INVITE_USED_UP', '這組邀請碼已經用完了，請跟店家拿新的');
  await audit.record({ actor: member.line_user_id, action: 'staff.invite_join', target: invite.invite_id,
    detail: { role, line_user_id: member.line_user_id }, result: 'ok' });
  return db.one('SELECT * FROM members WHERE line_user_id = ?', member.line_user_id);
}

// 對方用買家 LIFF 登入（就是一般會員），在前台輸入邀請碼。
bpost('/api/v1/staff/join', async ({ me, body }) => {
  const fresh = await redeemInvite(me, body.code);
  return ok({ role: fresh.role, role_zh: ROLE_ZH[fresh.role], nickname: fresh.nickname, member_no: fresh.member_no,
    next: '用同一個 LINE 帳號打開後台登入就可以開始了' });
}, { idempotent: false });

// ---- 我的採買清單 ---------------------------------------------------------

get('/api/v1/helper/my-list', async ({ actor, query }) => {
  auth.requireCap(actor, 'procurement.write');
  const batch = query.batch || await db.setting('current_batch');
  const rows = batch ? await boardRows(batch, actor) : [];
  const mine = rows.filter((r) => r.claimed_by === actor.line_user_id).map((r) => ({
    ...r, need_receipt: ['got', 'partial'].includes(r.state) && !r.receipts,
  }));
  const count = (st) => mine.filter((r) => r.state === st).length;
  let claims = { pending: 0, pending_twd: 0 };
  try {
    const c = await db.one(
      `SELECT count(*) AS n, COALESCE(sum(total_twd), 0) AS twd FROM helper_claims
        WHERE line_user_id = ? AND status IN ('pending','approved')`, actor.line_user_id);
    claims = { pending: Number(c.n), pending_twd: Number(c.twd) };
  } catch { /* 015 還沒跑 */ }
  return ok(auth.redact(actor, {
    batch,
    summary: {
      mine: mine.length, buying: count('claimed'), got: count('got'), partial: count('partial'), out_of_stock: count('out_of_stock'),
      need_receipt: mine.filter((r) => r.need_receipt).length,
      open_to_claim: rows.filter((r) => !r.claimed_by && r.state === 'open').length,
      unpaid_claims: claims.pending, unpaid_claims_twd: claims.pending_twd,
    },
    rows: mine,
  }));
});

// ---- 批次拍收據請款 ------------------------------------------------------

post('/api/v1/helper/receipts/upload', async ({ actor, body }) => {
  auth.requireCap(actor, 'procurement.write');
  const m = IMG.exec(String(body.data ?? ''));
  if (!m) throw err('BAD_IMAGE', '照片格式不對，請選 JPG、PNG 或 WebP');
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > IMG_MAX) throw err('BAD_IMAGE', '照片太大（上限 3 MB），請重新拍一張');
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[m[1].toLowerCase()];
  const id = uid('RCP');
  let ref;
  try {
    // 路徑只用收據編號，不放 LINE ID。
    ref = await storage.put(`receipt/${id}.${ext}`, buf, m[1]);
  } catch (e) {
    console.error('[helper] 收據上傳失敗：', e.message);
    throw Object.assign(new Error('收據上傳失敗，請再試一次'), { code: 'UPLOAD_FAILED', status: 503 });
  }
  await db.run('INSERT INTO helper_receipts (receipt_id, line_user_id, image_path, created_at) VALUES (?,?,?,?)', id, actor.line_user_id, ref, now());
  const [row] = await storage.resolve([{ receipt_id: id, image_url: ref }], 'image_url');
  return ok({ receipt_id: id, image_url: row.image_url });
});

async function claimShape(c, { withOwner = false } = {}) {
  const receipts = await storage.resolve(
    (await db.all('SELECT * FROM helper_receipts WHERE claim_id = ? ORDER BY seq', c.claim_id)).map((r) => ({ ...r, image_url: r.image_path })),
    'image_url');
  const procIds = [...new Set(receipts.flatMap((r) => r.proc_ids || []))];
  const names = procIds.length ? await db.all(
    'SELECT pr.proc_id, p.name_zh FROM procurements pr JOIN products p ON p.sku = pr.sku WHERE pr.proc_id = ANY(?::text[])', procIds) : [];
  const nameOf = new Map(names.map((n) => [n.proc_id, n.name_zh]));
  return {
    claim_id: c.claim_id, batch: c.batch, status: c.status, status_zh: CLAIM_ZH[c.status],
    total_jpy: num(c.total_jpy), fx_rate: num(c.fx_rate), total_twd: num(c.total_twd),
    note: c.note || '', decision_note: c.decision_note || '', created_at: c.created_at,
    decided_at: c.decided_at || null, paid_at: c.paid_at || null,
    ...(withOwner ? { nickname: c.nickname, member_no: c.member_no } : {}),
    receipts: receipts.map((r) => ({
      receipt_id: r.receipt_id, seq: r.seq, amount_jpy: num(r.amount_jpy), note: r.note || '', image_url: r.image_url,
      items: (r.proc_ids || []).map((id) => {
        const it = (Array.isArray(r.items) ? r.items : []).find((x) => x.proc_id === id);
        return { proc_id: id, name_zh: nameOf.get(id) || id, unit_cost_jpy: it ? num(it.unit_cost_jpy) : null, qty: it ? it.qty : null };
      }),
    })),
  };
}

post('/api/v1/helper/claims/create', async ({ actor, body }) => {
  auth.requireCap(actor, 'procurement.write');
  const list = Array.isArray(body.receipts) ? body.receipts : [];
  if (!list.length) throw err('NO_RECEIPTS', '請至少放一張收據');
  if (list.length > MAX_RECEIPTS) throw err('TOO_MANY_RECEIPTS', `一張請款單最多 ${MAX_RECEIPTS} 張收據`);
  const ids = list.map((r) => String(r.receipt_id || ''));
  if (new Set(ids).size !== ids.length) throw err('DUPLICATE_RECEIPT', '同一張收據放了兩次');
  const rows = await db.all('SELECT * FROM helper_receipts WHERE receipt_id = ANY(?::text[]) AND line_user_id = ?', ids, actor.line_user_id);
  const byId = new Map(rows.map((r) => [r.receipt_id, r]));
  for (const [i, r] of list.entries()) {
    const row = byId.get(String(r.receipt_id || ''));
    if (!row) throw err('RECEIPT_NOT_FOUND', `第 ${i + 1} 張收據找不到（要先上傳）`, 404);
    if (row.claim_id) throw err('RECEIPT_USED', `第 ${i + 1} 張收據已經請過款了（${row.claim_id}）`, 409);
    const amt = Number(r.amount_jpy);
    if (!(Number.isFinite(amt) && amt > 0 && amt <= 10000000)) throw err('BAD_AMOUNT', `第 ${i + 1} 張收據的日幣金額要大於 0`);
    for (const it of Array.isArray(r.items) ? r.items : []) {
      if (!it || !it.proc_id) throw err('BAD_ITEM', `第 ${i + 1} 張收據的品項缺少 proc_id`);
      if (it.unit_cost_jpy !== undefined && it.unit_cost_jpy !== null && it.unit_cost_jpy !== ''
        && !(Number(it.unit_cost_jpy) > 0)) throw err('BAD_AMOUNT', `第 ${i + 1} 張收據的品項單價要大於 0`);
    }
  }
  // 記成本的品項：只能是自己認領的（店主不限）。
  const procIds = [...new Set(list.flatMap((r) => (Array.isArray(r.items) ? r.items : []).map((it) => String(it.proc_id))))];
  if (procIds.length) {
    const procs = await db.all('SELECT proc_id, claimed_by FROM procurements WHERE proc_id = ANY(?::text[])', procIds);
    const found = new Map(procs.map((p) => [p.proc_id, p]));
    for (const id of procIds) {
      const p = found.get(id);
      if (!p) throw err('PROC_NOT_FOUND', `採購項目 ${id} 不存在`, 404);
      if (actor.role !== 'owner' && p.claimed_by !== actor.line_user_id) throw err('NOT_CLAIMER', '只能把收據記到自己認領的品項', 409);
    }
  }

  const totalJpy = money.round2(list.reduce((s, r) => s + Number(r.amount_jpy), 0));
  const fx = await money.currentFxRate();
  const totalTwd = Math.round(totalJpy * fx);
  const batch = await db.setting('current_batch');
  const claimId = uid('CLM');
  await db.tx(async () => {
    await db.run(
      `INSERT INTO helper_claims (claim_id, line_user_id, batch, total_jpy, fx_rate, total_twd, note, status, created_at)
       VALUES (?,?,?,?,?,?,?,'pending',?)`, claimId, actor.line_user_id, batch || null, totalJpy, fx, totalTwd, text(body.note, 200), now());
    for (const [i, r] of list.entries()) {
      const items = Array.isArray(r.items) ? r.items : [];
      const res = await db.run(
        `UPDATE helper_receipts SET claim_id = ?, seq = ?, amount_jpy = ?, proc_ids = ?, items = ?::jsonb, note = ?
          WHERE receipt_id = ? AND line_user_id = ? AND claim_id IS NULL`,
        claimId, i + 1, Number(r.amount_jpy), items.map((it) => String(it.proc_id)),
        // 有填單價的品項，店主核准時才記成本（跟「拍收據記帳」同一套）；沒填的只當作這張收據包含哪些東西。
        JSON.stringify(items.filter((it) => it.unit_cost_jpy !== undefined && it.unit_cost_jpy !== null && it.unit_cost_jpy !== '')
          .map((it) => ({ proc_id: String(it.proc_id), unit_cost_jpy: Number(it.unit_cost_jpy), qty: it.qty ? Number(it.qty) : null }))),
        text(r.note, 100), String(r.receipt_id), actor.line_user_id);
      if (!res.changes) throw err('RECEIPT_USED', `第 ${i + 1} 張收據剛剛被別的請款單用掉了`, 409);
    }
  });
  await audit.record({ actor: actor.line_user_id, action: 'helper.claim_create', target: claimId,
    detail: { receipts: list.length, total_jpy: totalJpy, total_twd: totalTwd, fx }, result: 'ok' });
  return ok(await claimShape(await db.one('SELECT * FROM helper_claims WHERE claim_id = ?', claimId)));
});

get('/api/v1/helper/claims', async ({ actor }) => {
  auth.requireCap(actor, 'procurement.write');
  const rows = await db.all('SELECT * FROM helper_claims WHERE line_user_id = ? ORDER BY created_at DESC LIMIT 50', actor.line_user_id);
  const out = [];
  for (const c of rows) out.push(await claimShape(c));
  return ok(out);
});

// ---- 店主審核請款 ---------------------------------------------------------

get('/api/v1/helper-claims/admin-list', async ({ actor, query }) => {
  auth.requireCap(actor, 'payment.reconcile');
  const st = CLAIM_ZH[query.status] ? query.status : null;
  const rows = await db.all(
    `SELECT c.*, m.nickname, m.member_no FROM helper_claims c JOIN members m ON m.line_user_id = c.line_user_id
      ${st ? 'WHERE c.status = ?' : ''} ORDER BY (c.status = 'pending') DESC, c.created_at DESC LIMIT 200`, ...(st ? [st] : []));
  const out = [];
  for (const c of rows) out.push(await claimShape(c, { withOwner: true }));
  return ok(out);
});

const NEXT = { approve: ['pending', 'approved'], reject: ['pending', 'rejected'], paid: [null, 'paid'] };

post('/api/v1/helper-claims/decide', async ({ actor, body }) => {
  auth.requireCap(actor, 'payment.reconcile');
  const action = String(body.action || '');
  if (!NEXT[action]) throw err('BAD_ACTION', 'action 要是 approve（核准）、reject（退回）或 paid（已付款）');
  const c = await db.one('SELECT * FROM helper_claims WHERE claim_id = ?', String(body.claim_id || ''));
  if (!c) throw err('CLAIM_NOT_FOUND', '找不到這張請款單', 404);
  const note = text(body.note, 200);
  if (action === 'reject' && !note) throw err('REASON_REQUIRED', '退回請寫一下原因，小幫手才知道要改什麼');
  const [from, to] = NEXT[action];
  // 已付款可以從待審核或已核准直接按（當場付現金的情況）。
  const allowed = action === 'paid' ? ['pending', 'approved'] : [from];
  if (!allowed.includes(c.status)) throw err('ILLEGAL_STATE', `這張請款單是「${CLAIM_ZH[c.status]}」，不能${{ approve: '核准', reject: '退回', paid: '標成已付款' }[action]}`, 409);
  let costs = 0;
  await db.tx(async () => {
    const res = await db.run(
      `UPDATE helper_claims SET status = ?, decided_by = COALESCE(decided_by, ?), decided_at = COALESCE(decided_at, ?),
              decision_note = COALESCE(?, decision_note), paid_at = ${to === 'paid' ? '?' : 'paid_at'}
        WHERE claim_id = ? AND status = ANY(?::text[])`,
      to, actor.line_user_id, now(), note, ...(to === 'paid' ? [now()] : []), c.claim_id, allowed);
    if (!res.changes) throw err('ILLEGAL_STATE', '這張請款單剛剛被處理過了，請重新整理', 409);
    if (to === 'rejected') {
      // 退回的收據放回去，小幫手改好金額可以重新送。
      await db.run('UPDATE helper_receipts SET claim_id = NULL, seq = NULL WHERE claim_id = ?', c.claim_id);
    } else if (c.status === 'pending') {
      // 第一次核准（或直接按已付款）才把收據上的品項單價記成成本，經手人是小幫手本人。
      const helper = await db.one('SELECT * FROM members WHERE line_user_id = ?', c.line_user_id);
      for (const r of await db.all('SELECT * FROM helper_receipts WHERE claim_id = ? ORDER BY seq', c.claim_id)) {
        for (const it of (Array.isArray(r.items) ? r.items : [])) {
          await recordExpense(helper, { proc_id: it.proc_id, unit_cost_jpy: it.unit_cost_jpy, qty: it.qty,
            receipt_url: r.image_path, claim_id: c.claim_id });
          costs++;
        }
      }
    }
  });
  await audit.record({ actor: actor.line_user_id, action: 'helper.claim_decide', target: c.claim_id,
    detail: { action, from: c.status, to, total_twd: num(c.total_twd), helper: c.line_user_id, note, costs }, result: 'ok' });
  return ok(await claimShape(await db.one(
    `SELECT c.*, m.nickname, m.member_no FROM helper_claims c JOIN members m ON m.line_user_id = c.line_user_id WHERE c.claim_id = ?`, c.claim_id), { withOwner: true }));
});

module.exports = { redeemInvite, ROLE_ZH };
