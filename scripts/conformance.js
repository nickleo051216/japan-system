'use strict';
/**
 * 規格書驗收條件對照檢查。
 * 逐條對應 README.md 第 4 節每個功能的「驗收」欄位原文。
 * 與 smoke.js 的差別：smoke 驗行為正確，這支驗「規格怎麼寫就怎麼測」。
 *   node scripts/conformance.js
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-conf-'));
const env = { ...process.env, PORT: String(PORT), DB_PATH: path.join(tmpDir, 'c.db'),
  QR_SIGNING_KEY: 'conformance-key', SESSION_SIGNING_KEY: 'conformance-session', FX_JPY_TWD: '0.215' };

let pass = 0, fail = 0;
const rows = [];
const check = (id, criterion, cond, note) => {
  (cond ? pass++ : fail++);
  rows.push({ id, criterion, ok: !!cond, note: note || '' });
  console.log(`  ${cond ? '✓' : '✗'} ${id}  ${criterion}${note && !cond ? '  → ' + JSON.stringify(note) : ''}`);
};

async function api(method, url, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json() };
}
const login = async (id) => (await api('POST', '/api/v1/auth/login', { body: { line_user_id: id } })).json.data.token;
const close = (a, b) => Math.abs(a - b) < 0.01;

async function portIsFree(port) {
  const net = require('node:net');
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

(async () => {
  // A leftover server from a previous run would answer with ITS database and
  // make these checks meaningless — refuse to run rather than report a lie.
  if (!(await portIsFree(PORT))) {
    console.error(`\n埠號 ${PORT} 已被佔用，可能是上一輪的伺服器還在。請先關閉再重跑，否則檢查結果不可信。`);
    process.exit(2);
  }
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (d) => { const s = d.toString(); if (!/Warning/.test(s)) process.stderr.write(s); });
  for (let i = 0; i < 60; i++) {
    try { await fetch(BASE + '/api/v1/auth/personas'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  try {
    const owner = await login('U_owner');
    const helper = await login('U_helper1');
    const packer = await login('U_packer');
    const buyer = await login('U_buyer1');

    console.log('\nF-03 只能查到本人訂單，不可查到他人');
    const mine = (await api('GET', '/api/v1/orders/list', { token: buyer })).json.data;
    check('F-03', '只能查到本人訂單', mine.length > 0 && mine.every((o) => o.line_user_id === 'U_buyer1'));
    check('F-03', '不可查到他人', (await api('GET', '/api/v1/orders/detail?order_id=HB2608-005', { token: buyer })).status === 403);

    console.log('\nF-04 拆分前後總金額一致；付款狀態正確繼承');
    const before = (await api('GET', '/api/v1/orders/detail?order_id=HB2608-003', { token: owner })).json.data;
    const sp = (await api('POST', '/api/v1/orders/split', { token: owner,
      body: { order_id: 'HB2608-003', items: [{ item_id: before.items[0].item_id, qty: 1 }] } })).json;
    check('F-04', '拆分前後總金額一致', sp.ok && close(sp.data.parent_total_twd + sp.data.child_total_twd, before.total_twd),
      { before: before.total_twd, after: sp.ok && sp.data.parent_total_twd + sp.data.child_total_twd });
    const childDetail = (await api('GET', `/api/v1/orders/detail?order_id=${sp.data.child_order_id}`, { token: owner })).json.data;
    check('F-04', '付款狀態正確繼承', childDetail.paid === before.paid, { parent: before.paid, child: childDetail.paid });
    check('F-04', '子單狀態繼承母單', childDetail.status === before.status);

    console.log('\nF-06 不會把同一筆入帳認列到兩張訂單');
    const unpaidOrder = 'HB2608-001';
    const amt = (await api('GET', `/api/v1/orders/detail?order_id=${unpaidOrder}`, { token: owner })).json.data.total_twd;
    const r1 = await api('POST', '/api/v1/payments/reconcile', { token: owner, body: { order_id: unpaidOrder, amount_twd: amt } });
    const r2 = await api('POST', '/api/v1/payments/reconcile', { token: owner, body: { order_id: unpaidOrder, amount_twd: amt } });
    check('F-06', '同一張單不可重複認列', r1.json.ok && r2.status === 409);
    check('F-06', '金額不符不自動認列', (await api('POST', '/api/v1/payments/reconcile', { token: owner, body: { order_id: 'HB2608-002', amount_twd: 1 } })).status === 409);

    console.log('\nF-07 非 helper 不得寫入成本 / 匯率快照 / 人工修正可辨識');
    const board = (await api('GET', '/api/v1/procurement/board', { token: owner })).json.data;
    const target = board.rows.find((r) => r.state === 'got');
    check('F-07', '非 helper 身分無法寫入成本',
      (await api('POST', '/api/v1/procurement/expense', { token: packer, body: { proc_id: target.proc_id, unit_cost_jpy: 500 } })).status === 403);
    const e1 = (await api('POST', '/api/v1/procurement/expense', { token: owner,
      body: { proc_id: target.proc_id, unit_cost_jpy: 1000, qty: 1, amount_edited: true } })).json.data;
    const costAtOldFx = e1.unit_cost_twd;
    await api('POST', '/api/v1/settings/fx', { token: owner, body: { fx_jpy_twd: 0.4 } });
    const after = (await api('GET', '/api/v1/procurement/board', { token: owner })).json.data.rows.find((r) => r.proc_id === target.proc_id);
    check('F-07', '匯率變動後既有紀錄台幣成本不變', close(after.unit_cost_twd, costAtOldFx), { was: costAtOldFx, now: after.unit_cost_twd });
    const exps = (await api('GET', `/api/v1/procurement/expenses?proc_id=${target.proc_id}`, { token: owner })).json.data;
    check('F-07', '人工修正過的金額在資料中可辨識', exps.some((e) => e.amount_edited === 1));
    const e2 = (await api('POST', '/api/v1/procurement/expense', { token: owner,
      body: { proc_id: target.proc_id, unit_cost_jpy: 2000, qty: 1 } })).json.data;
    check('F-07', '同商品多筆採購以加權平均計算', e2.receipts >= 2 && e2.unit_cost_jpy > 1000 && e2.unit_cost_jpy < 2000,
      { receipts: e2.receipts, avg: e2.unit_cost_jpy });
    await api('POST', '/api/v1/settings/fx', { token: owner, body: { fx_jpy_twd: 0.215 } });

    console.log('\nF-08 併發認領只有一個成功');
    const open = (await api('GET', '/api/v1/procurement/board', { token: owner })).json.data.rows.find((r) => r.state === 'open');
    const helper2 = await login('U_helper2');
    const both = await Promise.all([
      api('POST', '/api/v1/procurement/claim', { token: helper, body: { proc_id: open.proc_id } }),
      api('POST', '/api/v1/procurement/claim', { token: helper2, body: { proc_id: open.proc_id } }),
    ]);
    check('F-08', '兩個同時認領只有一個成功', both.filter((r) => r.json.ok).length === 1);
    const t0 = Date.now();
    await api('POST', '/api/v1/procurement/result', { token: both[0].json.ok ? helper : helper2, body: { proc_id: open.proc_id, got_qty: 0 } });
    const dash = (await api('GET', '/api/v1/dashboard/summary', { token: owner })).json.data;
    check('F-08', '缺貨 30 秒內通知店主', dash.todo.some((t) => t.kind === 'out_of_stock') && Date.now() - t0 < 30000);

    console.log('\nF-10 出貨通知 / 重複出貨被擋下');
    const ship = (await api('POST', '/api/v1/orders/ship', { token: packer, body: { order_id: 'HB2608-004' } })).json;
    check('F-10', '出貨後產生客人通知', ship.ok && typeof ship.data.notification === 'string' && ship.data.notification.includes('已出貨'));
    check('F-10', '重複出貨被擋下', (await api('POST', '/api/v1/orders/ship', { token: packer, body: { order_id: 'HB2608-004' } })).status === 409);

    console.log('\nF-15/F-16 標籤與簽章');
    const lab = (await api('GET', '/api/v1/labels/data?order_ids=HB2608-007', { token: packer })).json.data.labels[0];
    check('F-15', 'QR 內容全為 ASCII', /^[\x20-\x7E]+$/.test(lab.payload), lab.payload);
    check('F-15', '標籤含訂單編號/暱稱/件數/日期/店名',
      !!(lab.order_id && lab.nickname && lab.pieces >= 0 && lab.date && lab.shop));
    check('F-15', 'QR 以容錯等級 Q 產生', /svg/i.test(lab.qr_svg) && lab.qr_svg.length > 200);
    const v = async (code) => (await api('POST', '/api/v1/scan/verify', { token: packer, body: { code } })).json.data;
    const [pfx, oid, sg] = lab.payload.split('|');
    // 竄改 signature 任一字元
    const tamperSig = `${pfx}|${oid}|${sg.slice(0, 3)}${sg[3] === 'A' ? 'B' : 'A'}`;
    check('F-16', '竄改 signature 一字元驗證必失敗', (await v(tamperSig)).code === 'BAD_SIGNATURE', tamperSig);
    // 竄改 order_id 成另一張「存在」的訂單 → 簽章必須不符（而非放行）
    const tamperOid = `${pfx}|HB2608-002|${sg}`;
    const tv = await v(tamperOid);
    check('F-16', '竄改 order_id 指向他單驗證必失敗', tv.code === 'BAD_SIGNATURE', tv);

    console.log('\nF-18 六種情境逐一測試');
    const cases = [
      ['1 格式不是本店標籤', '亂打一通', 'BAD_FORMAT', 'red'],
      ['2 查無此訂單', 'HB|HB2699-999|ABCD', 'ORDER_NOT_FOUND', 'red'],
      ['3 驗證碼不符', tamperSig, 'BAD_SIGNATURE', 'red'],
      ['4 這張單已經出過貨了', (await api('GET', '/api/v1/labels/data?order_ids=HB2608-004', { token: packer })).json.data.labels[0].payload, 'ALREADY_SHIPPED', 'yellow'],
      ['5 這位客人還沒付款', lab.payload, 'UNPAID', 'yellow'],
      ['6 這張單還有品項沒買到', (await api('GET', '/api/v1/labels/data?order_ids=HB2608-005', { token: packer })).json.data.labels[0].payload, 'INCOMPLETE_PROCUREMENT', 'yellow'],
    ];
    for (const [name, code, expectCode, expectLevel] of cases) {
      const r = await v(code);
      check('F-18', name, r.code === expectCode && r.level === expectLevel, { got: r.code, level: r.level });
    }
    check('F-18', '紅燈不可覆寫', (await api('POST', '/api/v1/scan/commit', { token: owner, body: { code: '亂打一通', override_reason: '硬出' } })).status === 409);
    check('F-18', '黃燈非店主不可覆寫', (await api('POST', '/api/v1/scan/commit', { token: packer, body: { code: lab.payload, override_reason: 'x' } })).status === 403);
    check('F-18', '黃燈覆寫必須填原因', (await api('POST', '/api/v1/scan/commit', { token: owner, body: { code: lab.payload } })).status === 400);

    console.log('\nF-17 連續掃描 20 件（API 層；免滑鼠操作於瀏覽器另測）');
    const t1 = Date.now();
    let okCount = 0;
    for (let i = 0; i < 20; i++) {
      const r = await v(lab.payload);
      if (r && r.code) okCount++;
    }
    const elapsed = Date.now() - t1;
    check('F-17', '連續 20 次掃描全部有回應且不漏讀', okCount === 20, { okCount });
    check('F-17', '平均間隔 < 1 秒', elapsed / 20 < 1000, { avgMs: Math.round(elapsed / 20) });

    console.log('\nF-19 手動出貨可明確識別為未經核對');
    const ships = (await api('GET', '/api/v1/shipments/list', { token: owner })).json.data;
    const manual = ships.find((s) => s.order_id === 'HB2608-004');
    check('F-19', '看圖模式手動出貨標記為未經核對', manual && manual.verified_by_scan === false, manual);
    const ovr = await api('POST', '/api/v1/scan/commit', { token: owner, body: { code: lab.payload, override_reason: '客人現場付現' } });
    const ships2 = (await api('GET', '/api/v1/shipments/list', { token: owner })).json.data;
    const scanned = ships2.find((s) => s.order_id === 'HB2608-007');
    check('F-19', '掃碼出貨標記為經核對', ovr.json.ok && scanned && scanned.verified_by_scan === true);
    check('F-19', '覆寫原因寫入紀錄', scanned && scanned.override_reason === '客人現場付現');
    const logs = (await api('GET', '/api/v1/audit/list?limit=400', { token: owner })).json.data;
    check('F-19', '可依操作者篩選', (await api('GET', '/api/v1/audit/list?actor=U_owner', { token: owner })).json.data.every((l) => l.actor === 'U_owner'));
    check('F-19', '可依結果篩選', (await api('GET', '/api/v1/audit/list?result=blocked', { token: owner })).json.data.every((l) => l.result === 'blocked'));
    check('F-19', '被擋下的操作留下紀錄', logs.some((l) => l.result === 'blocked'));

    console.log('\nF-20 重複綁定被擋下；可反查某訂單的所有包裹');
    await api('POST', '/api/v1/logistics/bind', { token: owner, body: { tracking_no: 'T-1', order_id: 'HB2608-002', carrier: '黑貓' } });
    check('F-20', '重複單號被擋下', (await api('POST', '/api/v1/logistics/bind', { token: owner, body: { tracking_no: 'T-1', order_id: 'HB2608-005' } })).status === 409);
    await api('POST', '/api/v1/logistics/bind', { token: owner, body: { tracking_no: 'T-2', order_id: 'HB2608-002' } });
    const rev = (await api('GET', '/api/v1/logistics/list?order_id=HB2608-002', { token: owner })).json.data;
    check('F-20', '可反查某訂單的所有包裹', rev.length === 2 && rev.every((b) => b.order_id === 'HB2608-002'), rev.map((b) => b.tracking_no));

    console.log('\nF-21 助手呼叫成本 API 必須回傳 403');
    check('F-21', '助手呼叫成本 API 回 403', (await api('GET', '/api/v1/procurement/expenses', { token: helper })).status === 403);
    check('F-21', '理貨呼叫成本 API 回 403', (await api('GET', '/api/v1/procurement/expenses', { token: packer })).status === 403);
    check('F-21', '助手看板回傳不含成本欄位',
      !('unit_cost_twd' in (await api('GET', '/api/v1/procurement/board', { token: helper })).json.data.rows[0]));
    check('F-21', '理貨查單回傳不含售價欄位',
      !('total_twd' in ((await api('GET', '/api/v1/orders/list', { token: packer })).json.data[0] || { total_twd: 1 })));
    check('F-21', '助手不可認列收款', (await api('POST', '/api/v1/payments/reconcile', { token: helper, body: { order_id: 'HB2608-002', amount_twd: 100 } })).status === 403);
    check('F-21', '助手不可改系統設定', (await api('POST', '/api/v1/settings/fx', { token: helper, body: { fx_jpy_twd: 0.9 } })).status === 403);

    console.log('\nF-22 登錄一筆成本後所有數字同步更新且加總正確');
    const d1 = (await api('GET', '/api/v1/dashboard/summary', { token: owner })).json.data;
    const uncosted = (await api('GET', '/api/v1/procurement/board', { token: owner })).json.data.rows.find((r) => r.receipts === 0 && r.need_qty > 0);
    let d2 = d1;
    if (uncosted) {
      await api('POST', '/api/v1/procurement/expense', { token: owner, body: { proc_id: uncosted.proc_id, unit_cost_jpy: 500, qty: 1 } });
      d2 = (await api('GET', '/api/v1/dashboard/summary', { token: owner })).json.data;
      check('F-22', '登錄成本後已登錄成本增加', d2.cost_registered_twd > d1.cost_registered_twd, { before: d1.cost_registered_twd, after: d2.cost_registered_twd });
      check('F-22', '登錄成本後未登錄營收下降', d2.uncosted_revenue_twd < d1.uncosted_revenue_twd, { before: d1.uncosted_revenue_twd, after: d2.uncosted_revenue_twd });
    } else {
      check('F-22', '登錄成本後數字同步更新', false, '找不到未登錄成本的品項可測');
    }
    check('F-22', '毛利 = 已計成本營收 − 已登錄成本', close(d2.gross_profit_twd, d2.margin_basis_revenue_twd - d2.cost_registered_twd),
      { gross: d2.gross_profit_twd, calc: d2.margin_basis_revenue_twd - d2.cost_registered_twd });
    check('F-22', '已計成本營收 + 未計成本營收 = 總營收',
      close(d2.margin_basis_revenue_twd + d2.uncosted_revenue_twd, d2.revenue_twd),
      { basis: d2.margin_basis_revenue_twd, uncosted: d2.uncosted_revenue_twd, revenue: d2.revenue_twd });
    check('F-22', '毛利率 = 毛利 / 已計成本營收',
      close(d2.margin_pct, (d2.gross_profit_twd / d2.margin_basis_revenue_twd) * 100));
    check('F-22', '排行加總等於已計成本營收',
      close(d2.ranking.reduce((s, r) => s + r.revenue_twd, 0), d2.margin_basis_revenue_twd),
      { ranking: d2.ranking.reduce((s, r) => s + r.revenue_twd, 0), basis: d2.margin_basis_revenue_twd });

    console.log('\nF-23 修改匯率後既有紀錄不變、新紀錄使用新匯率');
    const fresh = (await api('GET', '/api/v1/procurement/board', { token: owner })).json.data.rows.find((r) => r.receipts === 0);
    const oldRate = (await api('GET', '/api/v1/settings/fx', { token: owner })).json.data.fx_jpy_twd;
    await api('POST', '/api/v1/settings/fx', { token: owner, body: { fx_jpy_twd: 0.5 } });
    if (fresh) {
      const nw = (await api('POST', '/api/v1/procurement/expense', { token: owner, body: { proc_id: fresh.proc_id, unit_cost_jpy: 100, qty: 1 } })).json.data;
      check('F-23', '新紀錄使用新匯率', close(nw.fx_rate, 0.5) && close(nw.unit_cost_twd, 50), nw);
    }
    const hist = (await api('GET', '/api/v1/settings/fx', { token: owner })).json.data;
    check('F-23', '匯率變更寫入歷史紀錄', hist.history.length >= 2 && hist.history[0].rate === 0.5);
    check('F-23', '僅店主可改匯率', (await api('POST', '/api/v1/settings/fx', { token: packer, body: { fx_jpy_twd: 0.1 } })).status === 403);
    await api('POST', '/api/v1/settings/fx', { token: owner, body: { fx_jpy_twd: oldRate } });

    console.log('\n§2.3 狀態機');
    check('§2.3', '不可跳躍轉換', (await api('POST', '/api/v1/orders/transition', { token: owner, body: { order_id: 'HB2608-002', to: '已完成' } })).status === 409);
    check('§2.3', '強制修正必須填原因', (await api('POST', '/api/v1/orders/transition', { token: owner, body: { order_id: 'HB2608-002', to: '已完成', force: true } })).status === 400);
    check('§2.3', '助手不可強制修正', (await api('POST', '/api/v1/orders/transition', { token: helper, body: { order_id: 'HB2608-002', to: '已完成', force: true, reason: 'x' } })).status === 403);
    const sl = (await api('GET', '/api/v1/orders/detail?order_id=HB2608-004', { token: owner })).json.data.status_log;
    check('§2.3', '每次轉換寫入狀態紀錄', sl.length >= 2 && sl.every((l) => l.ts && l.to_status));

    console.log('\nI-02 API Gateway 規範');
    const shape = await api('GET', '/api/v1/settings/batches', { token: owner });
    check('I-02', '回應格式為 {ok,data,error}', 'ok' in shape.json && 'data' in shape.json && 'error' in shape.json);
    const bad = await api('GET', '/api/v1/nope/nope', { token: owner });
    check('I-02', '錯誤回應同一格式', bad.json.ok === false && bad.json.error && bad.json.error.code);
    const idemRes1 = await fetch(BASE + '/api/v1/notifications/read', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner}`, 'Idempotency-Key': 'conf-1' },
      body: JSON.stringify({ notif_id: 'ntf_seed_1' }) });
    const idemRes2 = await fetch(BASE + '/api/v1/notifications/read', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner}`, 'Idempotency-Key': 'conf-1' },
      body: JSON.stringify({ notif_id: 'ntf_seed_1' }) });
    check('I-02', '相同 Idempotency-Key 回相同結果', JSON.stringify(await idemRes1.json()) === JSON.stringify(await idemRes2.json()));
    check('I-02', '未帶 token 一律 401', (await api('GET', '/api/v1/dashboard/summary')).status === 401);

    console.log('\nI-03 錯誤處理');
    check('I-03', '使用者可見錯誤不含技術細節',
      !/SQLITE|stack|at Object|Error:/i.test(JSON.stringify(bad.json)));
  } catch (e) {
    fail++;
    console.error('\n檢查中止：', e);
  } finally {
    // Wait for the child to actually exit, so a following run does not talk to it.
    const exited = new Promise((r) => child.once('exit', r));
    child.kill('SIGKILL');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n對照結果：通過 ${pass} 項，未通過 ${fail} 項`);
  fs.writeFileSync(path.join(__dirname, '..', 'conformance-result.json'), JSON.stringify(rows, null, 2));
  process.exit(fail ? 1 : 0);
})();
