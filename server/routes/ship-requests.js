'use strict';
/**
 * 出貨申請（併單／拆單）與出貨單 —— v1.6 第 ④ 項（014）。
 *
 *   客人（前台）：/ship-requests/create、/list、/cancel
 *   店主（後台）：/ship-requests/admin-list、/approve、/reject
 *   出貨單      ：/ship-groups/list、/ship-groups/ship（整箱一起寄）
 *
 * 規則（申請時檢查一次，核准時再檢查一次 —— 中間可能已經被出貨、取消或付款）：
 *   併單 merge：2～10 張自己的訂單，都是「已報價」或「已到貨」（價錢定了才知道運費要退多少），
 *              都還沒掛在出貨單上。寄到第一張單的地址（前台可以用 ship_to_order_id 指定）。
 *              核准後：第一張單保留運費，其他單「還沒付款、還沒進對帳單」的運費拿掉；
 *              已經付過或已出對帳單的運費不動，回傳 fee_not_waived 讓店主自己決定退不退。
 *   拆單 split：一張「已報價」的訂單，已到貨的品項先寄（預設全部已到貨的），至少要留一項之後寄。
 *              核准後：已到貨的品項搬到子訂單（訂單號 -A、-B…），子訂單直接是「已到貨」可以出貨。
 *              先寄的那箱要另收一次運費：只有母單還沒付款、還沒進對帳單才收（預設照運費設定算，
 *              店主可以用 extra_fee_twd 改，0 = 不收）；付過了就不另收，免得付款狀態對不起來。
 * 核准、拒絕都會用 LINE 通知客人（notification_outbox 種類 ship_request）。
 * 只有店主能審核：會動到運費和訂單金額。
 */
const db = require('../lib/db');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const notify = require('../lib/notify');
const config = require('../lib/config');
const { STATUS, transition } = require('../lib/state');
const { feeFor, pickupTypeOf } = require('../lib/shipfee');
const { round2 } = require('../lib/money');
const { get, post, ok } = require('../lib/http');
const { now, uid } = require('../lib/ids');
const { bget, bpost, err, num } = require('./buyer');
const { shipOrder } = require('./orders');

const MERGEABLE = [STATUS.QUOTED, STATUS.ARRIVED];
const MAX_MERGE = 10;
const KIND_ZH = { merge: '併單', split: '拆單' };
const STATUS_ZH = { pending: '審核中', approved: '已核准', rejected: '未核准', cancelled: '已取消' };

const ntd = (v) => 'NT$' + Math.round(Number(v) || 0).toLocaleString('en-US');
const text = (v, max) => (v === undefined || v === null ? null : String(v).trim().slice(0, max) || null);

// ---- 形狀 -----------------------------------------------------------------

async function groupShape(g) {
  if (!g) return null;
  const orders = await db.all(
    'SELECT order_id, status, total_twd, ship_fee_twd FROM orders WHERE order_id = ANY(?::text[]) ORDER BY order_id',
    g.order_ids);
  // 出貨單的狀態看底下的訂單算，不另外維護：全部出貨了就是「已出貨」。
  const live = orders.filter((o) => ![STATUS.CANCELLED, STATUS.OUT_OF_STOCK].includes(o.status));
  const shipped = live.length > 0 && live.every((o) => [STATUS.SHIPPED, STATUS.DELIVERED].includes(o.status));
  return {
    ship_group_id: g.ship_group_id, request_id: g.request_id || null,
    status: g.status === '已取消' ? '已取消' : shipped ? '已出貨' : '待出貨',
    order_ids: g.order_ids, pickup: g.pickup || '', pickup_addr: g.pickup_addr || '',
    created_at: g.created_at,
    orders: orders.map((o) => ({ order_id: o.order_id, status: o.status, total_twd: num(o.total_twd), ship_fee_twd: num(o.ship_fee_twd) })),
  };
}

async function requestShape(r) {
  const g = r.ship_group_id ? await db.one('SELECT * FROM ship_groups WHERE ship_group_id = ?', r.ship_group_id) : null;
  return {
    request_id: r.request_id, kind: r.kind, kind_zh: KIND_ZH[r.kind],
    status: r.status, status_zh: STATUS_ZH[r.status],
    order_ids: r.order_ids, item_ids: r.item_ids || [],
    note: r.note || '', decision_note: r.decision_note || '',
    created_at: r.created_at, decided_at: r.decided_at || null,
    ship_group: await groupShape(g),
  };
}

// ---- 共用檢查 --------------------------------------------------------------

/** 這些訂單裡，哪些已經在等審核的申請裡。 */
async function pendingFor(orderIds, exceptId = null) {
  return db.all(
    `SELECT request_id, order_ids FROM ship_requests
      WHERE status = 'pending' AND order_ids && ?::text[] ${exceptId ? 'AND request_id <> ?' : ''}`,
    orderIds, ...(exceptId ? [exceptId] : []));
}

/** 併單：訂單都屬於這位客人、價錢定了、還沒出貨、還沒掛在別的出貨單上。回傳依 ids 順序的訂單。 */
async function checkMerge(user, ids) {
  const rows = await db.all('SELECT * FROM orders WHERE order_id = ANY(?::text[]) AND line_user_id = ?', ids, user);
  const byId = new Map(rows.map((o) => [o.order_id, o]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) throw err('ORDER_NOT_FOUND', `找不到訂單 ${missing.join('、')}`, 404);
  for (const o of rows) {
    if (o.status === STATUS.PENDING) throw err('NOT_QUOTED', `${o.order_id} 還沒報價，報價好了才能併單`, 409);
    if (!MERGEABLE.includes(o.status)) throw err('NOT_MERGEABLE', `${o.order_id} 是「${o.status}」，不能併單`, 409);
    if (o.ship_group_id) throw err('ALREADY_GROUPED', `${o.order_id} 已經在出貨單 ${o.ship_group_id} 裡了`, 409);
  }
  return ids.map((id) => byId.get(id));
}

/** 拆單：一張「已報價」的單，挑的品項都已到貨，而且至少留一項還沒到的之後寄。 */
async function checkSplit(user, orderId, itemIds) {
  const o = await db.one('SELECT * FROM orders WHERE order_id = ? AND line_user_id = ?', orderId, user);
  if (!o) throw err('ORDER_NOT_FOUND', '找不到這張訂單', 404);
  if (o.ship_group_id) throw err('ALREADY_GROUPED', `${o.order_id} 已經在出貨單 ${o.ship_group_id} 裡了`, 409);
  if (o.status !== STATUS.QUOTED) {
    throw err('NOT_SPLITTABLE', o.status === STATUS.ARRIVED
      ? '這張訂單已經全部到貨，不用拆，直接等出貨就好' : `這張訂單是「${o.status}」，不能拆單`, 409);
  }
  const items = await db.all('SELECT * FROM order_items WHERE order_id = ? ORDER BY item_id', o.order_id);
  const arrived = items.filter((i) => i.item_status === '已到貨');
  if (!arrived.length) throw err('NOT_SPLITTABLE', '還沒有品項到貨，暫時不能拆單', 409);
  const picks = itemIds && itemIds.length ? itemIds : arrived.map((i) => i.item_id);
  const byId = new Map(items.map((i) => [i.item_id, i]));
  for (const id of picks) {
    const it = byId.get(id);
    if (!it) throw err('ITEM_NOT_FOUND', `品項 ${id} 不在這張訂單裡`, 404);
    if (it.item_status !== '已到貨') throw err('ITEM_NOT_ARRIVED', `「${it.name}」還沒到貨，不能先寄`, 409);
  }
  if (picks.length >= items.length) throw err('NOTHING_LEFT', '全部品項都要先寄的話不用拆單', 409);
  return { order: o, items, picks: [...new Set(picks)] };
}

async function tellCustomer(r, msg) {
  try {
    const queued = await notify.queue({ kind: 'ship_request', lineUserId: r.line_user_id,
      payload: { request_id: r.request_id, kind: r.kind, status: r.status, text: `${msg}\n\n查看訂單 👉\n${config.buyerLiffUrl}?path=orders` } });
    if (queued) notify.poke();
  } catch (e) {
    console.warn('[notify] 出貨申請通知沒排進佇列（不影響審核）：', e.code || '', e.message);
  }
}

// ---- 客人 -----------------------------------------------------------------

bpost('/api/v1/ship-requests/create', async ({ me, body }) => {
  const kind = String(body.kind || '');
  if (!['merge', 'split'].includes(kind)) throw err('BAD_KIND', 'kind 要是 merge（併單）或 split（拆單）');
  const note = text(body.note, 200);
  let orderIds;
  let itemIds = null;
  if (kind === 'merge') {
    const ids = [...new Set((Array.isArray(body.order_ids) ? body.order_ids : []).map(String))];
    if (ids.length < 2) throw err('TOO_FEW_ORDERS', '併單要選 2 張以上的訂單');
    if (ids.length > MAX_MERGE) throw err('TOO_MANY_ORDERS', `一次最多併 ${MAX_MERGE} 張`);
    const shipTo = body.ship_to_order_id ? String(body.ship_to_order_id) : ids[0];
    if (!ids.includes(shipTo)) throw err('BAD_SHIP_TO', 'ship_to_order_id 要是勾選的其中一張');
    orderIds = [shipTo, ...ids.filter((id) => id !== shipTo)];   // 第一張 = 寄送地址、保留運費
    await checkMerge(me.line_user_id, orderIds);
  } else {
    const orderId = String(body.order_id || (Array.isArray(body.order_ids) && body.order_ids[0]) || '');
    const picks = Array.isArray(body.item_ids) ? body.item_ids.map(String) : null;
    const s = await checkSplit(me.line_user_id, orderId, picks);
    orderIds = [s.order.order_id];
    itemIds = s.picks;
  }
  const dup = await pendingFor(orderIds);
  if (dup.length) throw err('ALREADY_REQUESTED', `已經有一筆審核中的申請（${dup[0].request_id}），可以先取消再重新申請`, 409);

  const id = uid('SR');
  await db.run(
    `INSERT INTO ship_requests (request_id, line_user_id, kind, order_ids, item_ids, note, status, created_at)
     VALUES (?,?,?,?,?,?,'pending',?)`, id, me.line_user_id, kind, orderIds, itemIds, note, now());
  await audit.record({ actor: me.line_user_id, action: 'ship_request.create', target: id, detail: { kind, order_ids: orderIds, item_ids: itemIds }, result: 'ok' });
  return ok(await requestShape(await db.one('SELECT * FROM ship_requests WHERE request_id = ?', id)));
});

bget('/api/v1/ship-requests/list', async ({ me }) => {
  const rows = await db.all('SELECT * FROM ship_requests WHERE line_user_id = ? ORDER BY created_at DESC LIMIT 50', me.line_user_id);
  const out = [];
  for (const r of rows) out.push(await requestShape(r));
  return ok(out);
});

bpost('/api/v1/ship-requests/cancel', async ({ me, body }) => {
  const r = await db.one('SELECT * FROM ship_requests WHERE request_id = ? AND line_user_id = ?', String(body.request_id || ''), me.line_user_id);
  if (!r) throw err('REQUEST_NOT_FOUND', '找不到這筆申請', 404);
  if (r.status !== 'pending') throw err('ALREADY_DECIDED', `這筆申請已經${STATUS_ZH[r.status]}，不能取消`, 409);
  await db.run("UPDATE ship_requests SET status = 'cancelled', decided_at = ? WHERE request_id = ? AND status = 'pending'", now(), r.request_id);
  await audit.record({ actor: me.line_user_id, action: 'ship_request.cancel', target: r.request_id, result: 'ok' });
  return ok(await requestShape(await db.one('SELECT * FROM ship_requests WHERE request_id = ?', r.request_id)));
});

// ---- 店主 -----------------------------------------------------------------

function requireOwner(actor) {
  auth.requireCap(actor, 'order.write');
  if (actor.role !== 'owner') throw err('FORBIDDEN', '出貨申請要店主審核（會動到運費和訂單金額）', 403);
}

get('/api/v1/ship-requests/admin-list', async ({ actor, query }) => {
  auth.requireCap(actor, 'order.read');
  const st = ['pending', 'approved', 'rejected', 'cancelled'].includes(query.status) ? query.status : null;
  const rows = await db.all(
    `SELECT r.*, m.nickname, m.member_no FROM ship_requests r JOIN members m ON m.line_user_id = r.line_user_id
      ${st ? 'WHERE r.status = ?' : ''} ORDER BY (r.status = 'pending') DESC, r.created_at DESC LIMIT 200`,
    ...(st ? [st] : []));
  const out = [];
  for (const r of rows) {
    const orders = await db.all(
      `SELECT order_id, status, total_twd, ship_fee_twd, payment_status, statement_id, pickup, pickup_addr
         FROM orders WHERE order_id = ANY(?::text[])`, r.order_ids);
    const items = await db.all(
      `SELECT item_id, order_id, name, qty, item_status, unit_price_twd, source_image_url, size
         FROM order_items WHERE order_id = ANY(?::text[]) ORDER BY item_id`, r.order_ids);
    const byOrder = new Map(orders.map((o) => [o.order_id, o]));
    out.push({
      ...(await requestShape(r)), nickname: r.nickname, member_no: r.member_no || null,
      orders: r.order_ids.map((id) => byOrder.get(id)).filter(Boolean).map((o) => ({
        ...o, total_twd: num(o.total_twd), ship_fee_twd: num(o.ship_fee_twd),
        items: items.filter((i) => i.order_id === o.order_id).map((i) => ({
          ...i, unit_price_twd: num(i.unit_price_twd), picked: (r.item_ids || []).includes(i.item_id),
        })),
      })),
    });
  }
  return ok(auth.redact(actor, out));
});

async function decide(r, actor, status, note) {
  const res = await db.run(
    `UPDATE ship_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?
      WHERE request_id = ? AND status = 'pending'`, status, actor.line_user_id, now(), note, r.request_id);
  if (!res.changes) throw err('ALREADY_DECIDED', '這筆申請已經處理過了（或客人取消了）', 409);
}

async function approveMerge(r, actor) {
  const orders = await checkMerge(r.line_user_id, r.order_ids);
  const [head, ...rest] = orders;
  const groupId = uid('SG');
  const waived = [];
  const notWaived = [];
  await db.run(
    `INSERT INTO ship_groups (ship_group_id, line_user_id, request_id, order_ids, pickup, pickup_addr, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?)`, groupId, r.line_user_id, r.request_id, r.order_ids, head.pickup, head.pickup_addr, actor.line_user_id, now());
  for (const o of orders) {
    await db.run('UPDATE orders SET ship_group_id = ? WHERE order_id = ?', groupId, o.order_id);
  }
  for (const o of rest) {
    const fee = Number(o.ship_fee_twd) || 0;
    if (!fee) continue;
    if (o.payment_status === '待付款' && !o.statement_id) {
      await db.run('UPDATE orders SET ship_fee_twd = 0, total_twd = total_twd - ? WHERE order_id = ?', fee, o.order_id);
      waived.push({ order_id: o.order_id, fee_twd: fee });
    } else {
      notWaived.push({ order_id: o.order_id, fee_twd: fee, reason: o.statement_id ? '已出對帳單' : '已付款' });
    }
  }
  return { ship_group_id: groupId, fee_waived: waived, fee_not_waived: notWaived };
}

async function approveSplit(r, actor, extraFee) {
  const { order: parent, items, picks } = await checkSplit(r.line_user_id, r.order_ids[0], r.item_ids);
  const moved = items.filter((i) => picks.includes(i.item_id));
  const childGoods = round2(moved.reduce((s, i) => s + i.qty * Number(i.unit_price_twd), 0));
  const canCharge = parent.payment_status === '待付款' && !parent.statement_id;
  let fee = 0;
  if (canCharge) {
    fee = extraFee === undefined || extraFee === null || extraFee === ''
      ? await feeFor(pickupTypeOf(parent), childGoods) : Number(extraFee);
    if (!Number.isFinite(fee) || fee < 0 || fee > 10000) throw err('BAD_FEE', '先寄運費要是 0～10000 的數字');
  }
  const n = (await db.one('SELECT count(*) AS n FROM orders WHERE parent_order_id = ?', parent.order_id)).n;
  const childId = `${parent.order_id}-${String.fromCharCode(65 + Number(n))}`;
  const groupId = uid('SG');

  await db.setLocal('app.actor', actor.line_user_id);
  await db.setLocal('app.reason', `客人申請拆單 ${r.request_id}`);
  await db.run(
    `INSERT INTO orders (order_id, line_user_id, batch, status, payment_status, total_twd, ship_fee_twd, paid_at,
                         parent_order_id, statement_id, pickup, pickup_addr, invoice, note, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    childId, parent.line_user_id, parent.batch, STATUS.QUOTED, parent.payment_status, childGoods + fee, fee, parent.paid_at || null,
    parent.order_id, parent.statement_id || null, parent.pickup, parent.pickup_addr, parent.invoice,
    `由 ${parent.order_id} 拆出先寄（申請 ${r.request_id}）`, now());
  await db.run('UPDATE order_items SET order_id = ? WHERE item_id = ANY(?::text[]) AND order_id = ?', childId, picks, parent.order_id);
  await db.run('UPDATE orders SET total_twd = total_twd - ? WHERE order_id = ?', childGoods, parent.order_id);
  // 母單在對帳單裡的話，子單也要掛在同一張對帳單，核帳時才會一起變成已付款。
  if (parent.statement_id) {
    await db.run('UPDATE statements SET order_ids = array_append(order_ids, ?) WHERE statement_id = ? AND NOT (? = ANY(order_ids))',
      childId, parent.statement_id, childId);
  }
  await db.run(
    `INSERT INTO ship_groups (ship_group_id, line_user_id, request_id, order_ids, pickup, pickup_addr, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?)`, groupId, r.line_user_id, r.request_id, [childId], parent.pickup, parent.pickup_addr, actor.line_user_id, now());
  await db.run('UPDATE orders SET ship_group_id = ? WHERE order_id = ?', groupId, childId);
  // 搬過去的品項都到貨了 —— 子單直接是「已到貨」，可以出貨。
  await transition(childId, STATUS.ARRIVED, { actor: actor.line_user_id, reason: '拆單先寄：品項已到貨' });
  return { ship_group_id: groupId, child_order_id: childId, child_goods_twd: childGoods, extra_fee_twd: fee,
    fee_note: canCharge ? null : '母單已付款或已出對帳單，先寄這箱不另收運費' };
}

post('/api/v1/ship-requests/approve', async ({ actor, body }) => {
  requireOwner(actor);
  const r = await db.one('SELECT * FROM ship_requests WHERE request_id = ?', String(body.request_id || ''));
  if (!r) throw err('REQUEST_NOT_FOUND', '找不到這筆申請', 404);
  if (r.status !== 'pending') throw err('ALREADY_DECIDED', `這筆申請已經${STATUS_ZH[r.status]}了`, 409);
  const note = text(body.decision_note, 200);
  let result;
  try {
    result = await db.tx(async () => {
      await decide(r, actor, 'approved', note);
      const out = r.kind === 'merge' ? await approveMerge(r, actor) : await approveSplit(r, actor, body.extra_fee_twd);
      await db.run('UPDATE ship_requests SET ship_group_id = ? WHERE request_id = ?', out.ship_group_id, r.request_id);
      return out;
    });
  } catch (e) {
    await audit.record({ actor: actor.line_user_id, action: 'ship_request.approve', target: r.request_id, detail: { kind: r.kind, code: e.code || null }, result: 'blocked' });
    throw e;
  }
  await audit.record({ actor: actor.line_user_id, action: 'ship_request.approve', target: r.request_id,
    detail: { kind: r.kind, order_ids: r.order_ids, ...result }, result: result.fee_not_waived && result.fee_not_waived.length ? 'warn' : 'ok' });

  const fresh = await db.one('SELECT * FROM ship_requests WHERE request_id = ?', r.request_id);
  let msg;
  if (r.kind === 'merge') {
    const saved = result.fee_waived.reduce((s, w) => s + w.fee_twd, 0);
    msg = `📦 併單申請通過了\n\n${r.order_ids.join('、')} 會裝成一箱一起寄`
      + (saved ? `，幫你省下運費 ${ntd(saved)}` : '') + '。';
  } else {
    msg = `📦 拆單申請通過了\n\n已到貨的品項會先寄（新訂單 ${result.child_order_id}）`
      + (result.extra_fee_twd ? `，這一箱運費 ${ntd(result.extra_fee_twd)}` : '')
      + `；其他品項到貨後再寄。`;
  }
  if (note) msg += `\n\n店家留言：${note}`;
  await tellCustomer(fresh, msg);
  return ok({ ...(await requestShape(fresh)), result });
});

post('/api/v1/ship-requests/reject', async ({ actor, body }) => {
  requireOwner(actor);
  const r = await db.one('SELECT * FROM ship_requests WHERE request_id = ?', String(body.request_id || ''));
  if (!r) throw err('REQUEST_NOT_FOUND', '找不到這筆申請', 404);
  const note = text(body.decision_note, 200);
  if (!note) throw err('REASON_REQUIRED', '請寫一下為什麼不行，客人會收到這段話');
  await decide(r, actor, 'rejected', note);
  await audit.record({ actor: actor.line_user_id, action: 'ship_request.reject', target: r.request_id, detail: { kind: r.kind, note }, result: 'ok' });
  const fresh = await db.one('SELECT * FROM ship_requests WHERE request_id = ?', r.request_id);
  await tellCustomer(fresh, `📦 ${KIND_ZH[r.kind]}申請這次沒辦法通過\n\n${r.order_ids.join('、')}\n店家留言：${note}`);
  return ok(await requestShape(fresh));
});

// ---- 出貨單 ---------------------------------------------------------------

get('/api/v1/ship-groups/list', async ({ actor, query }) => {
  auth.requireCap(actor, 'order.read');
  const rows = await db.all(
    `SELECT g.*, m.nickname, m.member_no FROM ship_groups g JOIN members m ON m.line_user_id = g.line_user_id
      WHERE g.status <> '已取消' ORDER BY g.created_at DESC LIMIT 200`);
  const out = [];
  for (const g of rows) {
    const shaped = await groupShape(g);
    if (query.status && shaped.status !== query.status) continue;
    out.push({ ...shaped, nickname: g.nickname, member_no: g.member_no || null });
  }
  return ok(auth.redact(actor, out));
});

/** 整張出貨單一起寄：底下每張「已到貨」的單都出貨，物流單號共用。還有單沒到貨就整張不寄。 */
post('/api/v1/ship-groups/ship', async ({ actor, body }) => {
  auth.requireCap(actor, 'shipment.write');
  const g = await db.one('SELECT * FROM ship_groups WHERE ship_group_id = ?', String(body.ship_group_id || ''));
  if (!g) throw err('GROUP_NOT_FOUND', '找不到這張出貨單', 404);
  const orders = await db.all('SELECT * FROM orders WHERE order_id = ANY(?::text[]) ORDER BY order_id', g.order_ids);
  const todo = orders.filter((o) => ![STATUS.SHIPPED, STATUS.DELIVERED, STATUS.CANCELLED, STATUS.OUT_OF_STOCK].includes(o.status));
  if (!todo.length) throw err('ALREADY_SHIPPED', '這張出貨單已經寄出了', 409);
  const waiting = todo.filter((o) => o.status !== STATUS.ARRIVED);
  if (waiting.length) {
    throw err('NOT_READY', `還有訂單沒到貨：${waiting.map((o) => `${o.order_id}（${o.status}）`).join('、')}，同一箱要等全部到齊`, 409);
  }
  const opts = {
    overrideReason: body.override_reason ? String(body.override_reason).trim() : null,
    carrier: text(body.carrier, 40), trackingNo: text(body.tracking_no, 60),
  };
  // 先全部檢查付款，避免寄一半才被擋。
  const unpaid = todo.filter((o) => !o.paid);
  if (unpaid.length && (!opts.overrideReason || !auth.can(actor, 'override.blocked'))) {
    throw err('UNPAID', `${unpaid.map((o) => o.order_id).join('、')} 還沒付款，需店主填寫原因後覆寫`, 409);
  }
  const shipped = [];
  for (const o of todo) shipped.push(await shipOrder(actor, o, opts));
  await db.run("UPDATE ship_groups SET status = '已出貨', shipped_at = ? WHERE ship_group_id = ?", now(), g.ship_group_id);
  await audit.record({ actor: actor.line_user_id, action: 'ship_group.ship', target: g.ship_group_id,
    detail: { order_ids: shipped.map((s) => s.order_id), tracking_no: opts.trackingNo }, result: opts.overrideReason ? 'warn' : 'ok' });
  return ok({ ...(await groupShape(await db.one('SELECT * FROM ship_groups WHERE ship_group_id = ?', g.ship_group_id))), shipped });
});

module.exports = { groupShape };
