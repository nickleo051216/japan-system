'use strict';
/**
 * End-to-end smoke test. Boots the server on a throwaway database and walks
 * the acceptance conditions that matter most in README §4.
 *   node scripts/smoke.js
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-smoke-'));
const env = {
  ...process.env,
  PORT: String(PORT),
  DB_PATH: path.join(tmpDir, 'smoke.db'),
  QR_SIGNING_KEY: 'smoke-test-signing-key',
  SESSION_SIGNING_KEY: 'smoke-test-session-key',
  FX_JPY_TWD: '0.215',
};

let passed = 0, failed = 0;
const check = (name, cond, extra) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? ' — ' + JSON.stringify(extra) : ''}`); }
};
const section = (t) => console.log(`\n${t}`);

async function api(method, url, { token, body, idem } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (idem) headers['Idempotency-Key'] = idem;
  const res = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json() };
}
const login = async (id) => (await api('POST', '/api/v1/auth/login', { body: { line_user_id: id } })).json.data.token;

(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (d) => { const s = d.toString(); if (!/Warning/.test(s)) process.stderr.write(s); });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/api/v1/auth/personas'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  try {
    const owner = await login('U_owner');
    const helper = await login('U_helper1');
    const helper2 = await login('U_helper2');
    const packer = await login('U_packer');
    const buyer = await login('U_buyer1');

    section('F-21 權限（伺服器端強制）');
    check('店主可讀成本清單', (await api('GET', '/api/v1/procurement/expenses', { token: owner })).status === 200);
    check('助手直接呼叫成本 API 回 403', (await api('GET', '/api/v1/procurement/expenses', { token: helper })).status === 403);
    check('理貨直接呼叫成本 API 回 403', (await api('GET', '/api/v1/procurement/expenses', { token: packer })).status === 403);
    check('無 token 被擋下', (await api('GET', '/api/v1/orders/list')).status === 401);

    const boardOwner = (await api('GET', '/api/v1/procurement/board', { token: owner })).json.data;
    const boardHelper = (await api('GET', '/api/v1/procurement/board', { token: helper })).json.data;
    check('店主看得到毛利欄位', 'margin_pct' in boardOwner.rows[0]);
    check('助手看板不含成本/毛利欄位', !('margin_pct' in boardHelper.rows[0]) && !('unit_cost_twd' in boardHelper.rows[0]));
    check('助手看板仍可見售價', 'price_twd' in boardHelper.rows[0]);
    const packing = (await api('GET', '/api/v1/packing/list', { token: packer })).json.data;
    check('理貨看不到售價欄位', packing.length > 0 && !('total_twd' in packing[0]));

    section('F-03 訂單查詢隔離');
    const mine = (await api('GET', '/api/v1/orders/list', { token: buyer })).json.data;
    check('買家只查得到自己的訂單', mine.length > 0 && mine.every((o) => o.line_user_id === 'U_buyer1'));
    check('買家查他人訂單回 403', (await api('GET', '/api/v1/orders/detail?order_id=HB2608-005', { token: buyer })).status === 403);

    section('F-08 認領併發（條件更新）');
    const open = boardOwner.rows.find((r) => r.state === 'open');
    const [a, b] = await Promise.all([
      api('POST', '/api/v1/procurement/claim', { token: helper, body: { proc_id: open.proc_id } }),
      api('POST', '/api/v1/procurement/claim', { token: helper2, body: { proc_id: open.proc_id } }),
    ]);
    const wins = [a, b].filter((r) => r.json.ok).length;
    check('同時認領只有一個成功', wins === 1, { a: a.json, b: b.json });
    check('落敗者收到「已被認領」', [a, b].some((r) => r.json.error && r.json.error.code === 'ALREADY_CLAIMED'));
    check('非認領者不可放掉', (await api('POST', '/api/v1/procurement/release', { token: packer, body: { proc_id: open.proc_id } })).status !== 200);

    section('F-08 回報結果');
    const r1 = await api('POST', '/api/v1/procurement/result', { token: helper, body: { proc_id: open.proc_id, got_qty: open.need_qty + 5 } });
    check('回報數量 ≥ 需求記為買足', r1.json.data.state === 'got' && r1.json.data.got_qty === open.need_qty);
    const oos = boardOwner.rows.find((r) => r.state === 'claimed');
    if (oos) {
      await api('POST', '/api/v1/procurement/result', { token: owner, body: { proc_id: oos.proc_id, got_qty: 0 } });
      const dash = (await api('GET', '/api/v1/dashboard/summary', { token: owner })).json.data;
      check('缺貨立即產生店主待辦', dash.todo.some((t) => t.kind === 'out_of_stock'));
    }

    section('F-07 請款：匯率快照與毛利');
    const target = (await api('GET', '/api/v1/procurement/board', { token: owner })).json.data.rows.find((r) => r.state === 'got' && r.receipts === 0)
      || (await api('GET', '/api/v1/procurement/board', { token: owner })).json.data.rows.find((r) => r.state === 'got');
    const ocr = (await api('POST', '/api/v1/procurement/ocr', { token: helper, body: { proc_id: target.proc_id } })).json.data;
    check('OCR 結果標記必須人工確認', ocr.requires_confirmation === true);
    const exp = (await api('POST', '/api/v1/procurement/expense', { token: helper, body: { proc_id: target.proc_id, unit_cost_jpy: 1000, qty: 1 } })).json;
    check('助手可寫入成本', exp.ok);
    check('助手拿不到毛利回傳值', !('margin_pct' in exp.data));
    const ownerExp = (await api('POST', '/api/v1/procurement/expense', { token: owner, body: { proc_id: target.proc_id, unit_cost_jpy: 1000, qty: 1 } })).json.data;
    check('店主看得到毛利率', typeof ownerExp.margin_pct === 'number');
    check('金額 ≤ 0 被拒絕', (await api('POST', '/api/v1/procurement/expense', { token: helper, body: { proc_id: target.proc_id, unit_cost_jpy: 0 } })).status === 400);
    const costBefore = ownerExp.unit_cost_twd;
    await api('POST', '/api/v1/settings/fx', { token: owner, body: { fx_jpy_twd: 0.3 } });
    const after = (await api('GET', '/api/v1/procurement/board', { token: owner })).json.data.rows.find((r) => r.proc_id === target.proc_id);
    check('改匯率後既有紀錄台幣成本不變', Math.abs(after.unit_cost_twd - costBefore) < 0.01, { costBefore, after: after.unit_cost_twd });
    check('助手改匯率回 403', (await api('POST', '/api/v1/settings/fx', { token: helper, body: { fx_jpy_twd: 0.2 } })).status === 403);
    await api('POST', '/api/v1/settings/fx', { token: owner, body: { fx_jpy_twd: 0.215 } });

    section('F-18 掃碼六段攔截');
    const label = (await api('GET', '/api/v1/labels/data?order_ids=HB2608-004', { token: packer })).json.data.labels[0];
    check('標籤內容為純 ASCII', /^[\x20-\x7E]+$/.test(label.payload));
    const v = async (code) => (await api('POST', '/api/v1/scan/verify', { token: packer, body: { code } })).json.data;
    check('1 格式錯誤 → 紅', (await v('隨便一串')).code === 'BAD_FORMAT');
    check('2 查無訂單 → 紅', (await v('HB|HB2608-999|ABCD')).code === 'ORDER_NOT_FOUND');
    check('3 竄改簽章 → 紅', (await v(label.payload.slice(0, -1) + (label.payload.slice(-1) === 'Z' ? 'Y' : 'Z'))).code === 'BAD_SIGNATURE');
    const shipped = (await api('GET', '/api/v1/labels/data?order_ids=HB2608-006', { token: packer })).json.data.labels[0];
    check('4 已出貨 → 黃', (await v(shipped.payload)).code === 'ALREADY_SHIPPED');
    const unpaid = (await api('GET', '/api/v1/labels/data?order_ids=HB2608-007', { token: packer })).json.data.labels[0];
    check('5 未付款 → 黃', (await v(unpaid.payload)).code === 'UNPAID');
    const partial = (await api('GET', '/api/v1/labels/data?order_ids=HB2608-005', { token: packer })).json.data.labels[0];
    check('6 品項未買齊 → 黃', (await v(partial.payload)).code === 'INCOMPLETE_PROCUREMENT');
    const green = await v(label.payload);
    check('全部通過 → 綠', green.level === 'green' && green.code === 'PASS');

    section('F-18 覆寫規則');
    check('理貨覆寫黃燈被擋', (await api('POST', '/api/v1/scan/commit', { token: packer, body: { code: unpaid.payload, override_reason: '客人說會補' } })).status === 403);
    check('店主覆寫黃燈需填原因', (await api('POST', '/api/v1/scan/commit', { token: owner, body: { code: unpaid.payload } })).status === 400);
    const ov = await api('POST', '/api/v1/scan/commit', { token: owner, body: { code: unpaid.payload, override_reason: '客人現場付現，已收款' } });
    check('店主填原因後可覆寫', ov.json.ok, ov.json);
    check('紅燈永遠不可覆寫', (await api('POST', '/api/v1/scan/commit', { token: owner, body: { code: 'HB|HB2608-999|ABCD', override_reason: '硬出' } })).status === 409);

    section('F-17/F-10 掃碼出貨與通知');
    const commit = (await api('POST', '/api/v1/scan/commit', { token: packer, body: { code: label.payload } })).json.data;
    check('綠燈掃碼即出貨', commit.status === '已出貨' && commit.verified_by_scan === true);
    check('產生出貨通知文案', typeof commit.notification === 'string' && commit.notification.includes('出貨通知'));
    check('重複掃同一張 → 已出貨黃燈', (await v(label.payload)).code === 'ALREADY_SHIPPED');

    section('F-19 稽核軌跡');
    const logs = (await api('GET', '/api/v1/audit/list?limit=300', { token: owner })).json.data;
    check('覆寫留下 warn 紀錄', logs.some((l) => l.action === 'scan.commit' && l.result === 'warn' && l.detail && l.detail.override_reason));
    check('被擋下的操作留下 blocked 紀錄', logs.some((l) => l.result === 'blocked'));
    const ships = (await api('GET', '/api/v1/shipments/list', { token: owner })).json.data;
    check('出貨紀錄標記是否經掃碼', ships.every((s) => typeof s.verified_by_scan === 'boolean'));

    section('F-04 拆單');
    const detail = (await api('GET', '/api/v1/orders/detail?order_id=HB2608-003', { token: owner })).json.data;
    const totalBefore = detail.total_twd;
    const split = (await api('POST', '/api/v1/orders/split', { token: owner, body: { order_id: 'HB2608-003', items: [{ item_id: detail.items[0].item_id, qty: 1 }] } })).json;
    check('拆單成功', split.ok, split);
    check('拆分前後總額一致', Math.abs(split.data.parent_total_twd + split.data.child_total_twd - totalBefore) < 0.01);
    check('助手不可拆單', (await api('POST', '/api/v1/orders/split', { token: helper, body: { order_id: 'HB2608-002', items: [{ item_id: 'x', qty: 1 }] } })).status === 403);
    check('已出貨訂單不可拆', (await api('POST', '/api/v1/orders/split', { token: owner, body: { order_id: 'HB2608-006', items: [{ item_id: 'x', qty: 1 }] } })).status === 409);

    section('§2.3 狀態機');
    check('不可跳躍狀態', (await api('POST', '/api/v1/orders/transition', { token: owner, body: { order_id: 'HB2608-002', to: '已完成' } })).status === 409);
    check('強制修正需填原因', (await api('POST', '/api/v1/orders/transition', { token: owner, body: { order_id: 'HB2608-002', to: '已完成', force: true } })).status === 400);

    section('F-06 對帳 / I-02 冪等');
    const key = 'smoke-idem-1';
    const p1 = await api('POST', '/api/v1/payments/reconcile', { token: owner, idem: key, body: { order_id: 'HB2608-001', amount_twd: 1300 } });
    const p2 = await api('POST', '/api/v1/payments/reconcile', { token: owner, idem: key, body: { order_id: 'HB2608-001', amount_twd: 1300 } });
    check('相同 Idempotency-Key 不重複認列', JSON.stringify(p1.json) === JSON.stringify(p2.json));
    check('金額不符不自動認列', (await api('POST', '/api/v1/payments/reconcile', { token: owner, body: { order_id: 'HB2608-002', amount_twd: 1 } })).status === 409);

    section('F-22 儀表板毛利規則');
    const dash = (await api('GET', '/api/v1/dashboard/summary', { token: owner })).json.data;
    check('未登錄成本的營收另行揭露', typeof dash.uncosted_revenue_twd === 'number');
    check('毛利分母不含未登錄成本品項', dash.margin_basis_revenue_twd + dash.uncosted_revenue_twd <= dash.revenue_twd + 0.01);
    const dashHelper = (await api('GET', '/api/v1/dashboard/summary', { token: helper })).json.data;
    check('助手看不到毛利數字', !('gross_profit_twd' in dashHelper) && !('margin_pct' in dashHelper));

    section('F-20 物流綁定');
    check('綁定成功', (await api('POST', '/api/v1/logistics/bind', { token: owner, body: { tracking_no: 'BX123', order_id: 'HB2608-002', carrier: '黑貓' } })).json.ok);
    check('重複單號被擋下', (await api('POST', '/api/v1/logistics/bind', { token: owner, body: { tracking_no: 'BX123', order_id: 'HB2608-004' } })).status === 409);
    check('一單多包裹可綁', (await api('POST', '/api/v1/logistics/bind', { token: owner, body: { tracking_no: 'BX124', order_id: 'HB2608-002' } })).json.ok);
  } catch (e) {
    failed++;
    console.error('\n測試中止：', e);
  } finally {
    child.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n通過 ${passed} 項，失敗 ${failed} 項`);
  process.exit(failed ? 1 : 0);
})();
