'use strict';
/**
 * npm run test:n8n —— 把 n8n/ 底下的兩條流程，照節點順序在本機真的跑一遍。
 *
 * 不是檢查 JSON 長得像不像，而是：
 *   - Code 節點的 JavaScript 真的執行（跟 n8n 一樣拿到 $json、$('節點名')）
 *   - 打後端的節點真的打到本機的後端程式＋ PGlite（跟 Supabase 同一套 migration）
 *   - LINE 與 OpenRouter 換成假的伺服器，記下收到什麼、照劇本回應
 *
 * 所以流程裡任何一個欄位名對不上後端（data.notifications、cart_id、ok…），
 * 這裡就會失敗，而不是等到 Nick 匯入 n8n 才發現。
 *
 * 只模擬這兩條流程用到的節點種類；新增其他種類的節點要在 run() 裡補上。
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const PORT = 3996;
const ADMIN_PW = 'n8n-test-admin-password-012345';
const MACHINE = 'n8n-test-notify-secret';

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); } else {
    failed++; console.log(`  ✗ ${name}`);
    if (detail !== undefined) console.log('    ', JSON.stringify(detail).slice(0, 600));
  }
}
const section = (t) => console.log(`\n${t}`);

// ---- 假的外部服務：Supabase Storage、LINE、OpenRouter ------------------------------

const mock = { objects: new Map(), line: [], lineScript: [], claude: [], claudeScript: [] };
function startMock() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        const send = (code, obj, headers = {}) => {
          res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
          res.end(JSON.stringify(obj));
        };
        const up = /^\/storage\/v1\/object\/cart-images\/(.+)$/.exec(req.url);
        if (req.method === 'POST' && req.url === '/storage/v1/object/sign/cart-images') {
          const { expiresIn, paths } = JSON.parse(raw.toString() || '{}');
          return send(200, paths.map((p) => ({ path: p, signedURL: `/object/sign/cart-images/${p}?token=t${expiresIn}`, error: null })));
        }
        if (req.method === 'POST' && up) {
          mock.objects.set(decodeURIComponent(up[1]), raw);
          return send(200, { Key: `cart-images/${up[1]}` });
        }
        if (req.url === '/v2/bot/message/push') {
          mock.line.push({ headers: req.headers, body: JSON.parse(raw.toString()) });
          const next = mock.lineScript.shift() || { status: 200, body: { sentMessages: [{ id: '1' }] } };
          return send(next.status, next.body, next.headers);
        }
        if (req.url === '/api/v1/chat/completions') {
          mock.claude.push({ headers: req.headers, body: JSON.parse(raw.toString()) });
          const next = mock.claudeScript.shift();
          return send(next.status, next.body);
        }
        send(404, { error: 'not found' });
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// OpenRouter 的回應是 OpenAI 相容格式（choices[0].message.content）。
const claudeSays = (obj) => ({ status: 200, body: {
  id: 'gen-test', object: 'chat.completion', model: 'anthropic/claude-sonnet-5',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(obj) } }],
} });

// ---- 迷你 n8n：只做這兩條流程用得到的節點 ------------------------------------

/** 每個節點選哪一把憑證 —— 跟 n8n/README.md 教 Nick 選的一致。 */
function credentialHeaders(node) {
  if (node.name === 'LINE 推播') return { Authorization: 'Bearer test-line-token' };
  if (node.name === 'Claude 辨識') return { Authorization: 'Bearer test-openrouter-key' };
  return { 'X-Notify-Token': MACHINE };
}

function evaluate(value, item) {
  if (typeof value !== 'string' || !value.startsWith('=')) return value;
  const tpl = value.slice(1);
  const run = (expr) => new Function('$json', '$', `return (${expr});`)(item.json, lookup(item));
  const whole = /^\{\{([\s\S]*)\}\}$/.exec(tpl.trim());
  if (whole && !whole[1].includes('}}')) return run(whole[1]);
  return tpl.replace(/\{\{([\s\S]*?)\}\}/g, (_, e) => String(run(e)));
}

/** $('節點名') —— 沿著這個項目的來源鏈找到那個節點當時的輸出。 */
const lookup = (item) => (name) => {
  if (!(name in item.lineage)) throw new Error(`$('${name}') 在這個項目的來源裡找不到`);
  const json = item.lineage[name];
  return { item: { json }, first: () => ({ json }) };
};

async function runCode(node, item) {
  const ctx = vm.createContext({ $json: item.json, $: lookup(item), console, JSON, Math, Date, Number, String, parseInt });
  const fn = vm.runInContext(`(async () => {\n${node.parameters.jsCode}\n})`, ctx);
  const out = await fn();
  return out && out.json ? out.json : out;
}

function rewrite(url) {
  return url.replace('https://api.line.me', mock.base).replace('https://openrouter.ai', mock.base);
}

async function runHttp(node, item) {
  const p = node.parameters;
  const headers = { 'Content-Type': 'application/json', ...credentialHeaders(node) };
  for (const h of (p.headerParameters && p.headerParameters.parameters) || []) headers[h.name] = evaluate(h.value, item);
  const url = rewrite(evaluate(p.url, item));
  const body = evaluate(p.jsonBody, item);
  const full = !!(p.options.response && p.options.response.response.fullResponse);
  try {
    const res = await fetch(url, { method: p.method, headers, body });
    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
    if (full) {
      return { statusCode: res.status, headers: Object.fromEntries(res.headers.entries()), body: parsed };
    }
    if (res.status >= 400) throw new Error(`${node.name} 回 ${res.status}：${text.slice(0, 200)}`);
    return parsed;
  } catch (e) {
    if (node.onError === 'continueRegularOutput') return { error: { message: e.message } };
    throw e;
  }
}

function ifPasses(node, item) {
  const c = node.parameters.conditions.conditions[0];
  const left = evaluate(c.leftValue, item);
  const { type, operation } = c.operator;
  if (type === 'number' && operation === 'gt') return Number(left) > Number(c.rightValue);
  if (type === 'boolean' && operation === 'true') return left === true;
  throw new Error(`IF 條件 ${type}.${operation} 還沒模擬`);
}

/** 從觸發節點開始跑整條流程，回傳每個節點的輸出（name → json[]）。 */
async function run(wf, triggerName) {
  const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
  const outputs = {};
  const queue = [{ name: triggerName, items: [{ json: {}, lineage: {} }] }];
  while (queue.length) {
    const { name, items } = queue.shift();
    const node = byName[name];
    const branches = [[]];
    for (const item of items) {
      const emit = (json, branch = 0) => {
        while (branches.length <= branch) branches.push([]);
        branches[branch].push({ json, lineage: { ...item.lineage, [name]: json } });
      };
      switch (node.type) {
        case 'n8n-nodes-base.scheduleTrigger':
        case 'n8n-nodes-base.webhook':
          emit({}); break;
        case 'n8n-nodes-base.set':
          emit(Object.fromEntries(node.parameters.assignments.assignments.map((a) => [a.name, a.value]))); break;
        case 'n8n-nodes-base.httpRequest':
          emit(await runHttp(node, item)); break;
        case 'n8n-nodes-base.splitOut': {
          const list = node.parameters.fieldToSplitOut.split('.').reduce((o, k) => (o == null ? o : o[k]), item.json);
          if (!Array.isArray(list)) throw new Error(`${name}：${node.parameters.fieldToSplitOut} 不是陣列`);
          for (const el of list) emit(el);
          break;
        }
        case 'n8n-nodes-base.code':
          emit(await runCode(node, item)); break;
        case 'n8n-nodes-base.if':
          emit(item.json, ifPasses(node, item) ? 0 : 1); break;
        default:
          throw new Error(`節點種類 ${node.type} 還沒模擬`);
      }
    }
    outputs[name] = (outputs[name] || []).concat(branches.flat().map((i) => i.json));
    const conns = (wf.connections[name] && wf.connections[name].main) || [];
    conns.forEach((targets, b) => {
      const out = branches[b] || [];
      if (!out.length) return;
      for (const t of targets || []) queue.push({ name: t.node, items: out });
    });
  }
  return outputs;
}

// ---- 後端 ----------------------------------------------------------------------

function startHarness() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'pg-harness.mjs')],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const timer = setTimeout(() => reject(new Error('harness 啟動逾時')), 120000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const m = /DATABASE_URL=(\S+)/.exec(buf);
      if (m) { clearTimeout(timer); resolve({ child, url: m[1] }); }
    });
    child.stderr.on('data', (d) => process.stderr.write(d));
  });
}

(async () => {
  if (process.env.DATABASE_URL) {
    console.error('請不要帶 DATABASE_URL 執行 —— 這支測試會寫入假資料，只能對本機 harness 跑。');
    process.exit(2);
  }
  const notifyWf = JSON.parse(fs.readFileSync(path.join(ROOT, 'n8n', 'notify-collector.json'), 'utf8'));
  const ocrWf = JSON.parse(fs.readFileSync(path.join(ROOT, 'n8n', 'ocr-worker.json'), 'utf8'));

  const mockSrv = await startMock();
  mock.base = `http://127.0.0.1:${mockSrv.address().port}`;
  const harness = await startHarness();
  let server = null;
  try {
    process.env.DATABASE_URL = harness.url;
    process.env.DB_POOL_MAX = '1';
    const db = require('../server/lib/db');
    await require('../server/lib/seed').reset();
    await db.close();

    server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
      cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env, PORT: String(PORT), DATABASE_URL: harness.url, DB_POOL_MAX: '1',
        QR_SIGNING_KEY: 'n8n-qr', SESSION_SIGNING_KEY: 'n8n-session', ADMIN_LOGIN_PASSWORD: ADMIN_PW,
        NOTIFY_SHARED_SECRET: MACHINE, SUPABASE_URL: mock.base, SUPABASE_SERVICE_KEY: 'n8n-test-supabase',
      },
    });
    server.stderr.on('data', (d) => { const s = d.toString(); if (/Error/.test(s)) process.stderr.write(s); });
    const base = `http://127.0.0.1:${PORT}`;
    for (let i = 0; i < 300; i++) {
      try { await fetch(base + '/api/v1/health'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    // 流程裡寫死的是正式站網址；測試時換成本機後端。
    for (const wf of [notifyWf, ocrWf]) {
      const s = wf.nodes.find((n) => n.name === '設定');
      s.parameters.assignments.assignments.find((a) => a.name === 'api_base').value = base;
    }
    const api = async (method, p, { token, body } = {}) => {
      const res = await fetch(base + p, { method, headers: {
        'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined });
      return res.json();
    };
    const login = async (id) => (await api('POST', '/api/v1/auth/login',
      { body: { line_user_id: id, password: ADMIN_PW } })).data.token;
    const owner = await login('U_owner');
    const buyer = await login('U_buyer1');

    section('通知收集器：出貨＋對帳單 → LINE 推播 → 回報');
    const shipped = await api('POST', '/api/v1/orders/ship', { token: owner, body: { order_id: 'HB2608-004' } });
    check('後端出貨成功（排進通知佇列）', shipped.ok, shipped);
    const gen = await fetch(base + '/api/v1/statements/generate', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Notify-Token': MACHINE }, body: '{}' }).then((r) => r.json());
    check('產生對帳單（也排進通知佇列）', gen.ok && gen.data.created.length > 0, gen);

    let out = await run(notifyWf, '每分鐘');
    const pushes = mock.line.splice(0);
    const shipPush = pushes.find((p) => /出貨通知/.test(p.body.messages[0].text));
    const stmtPush = pushes.find((p) => /對帳單通知/.test(p.body.messages[0].text));
    check('出貨通知推給下單的客人，用後端寫好的文案',
      shipPush && shipPush.body.to === 'U_buyer1' && /HB2608-004/.test(shipPush.body.messages[0].text), pushes.map((p) => p.body));
    check('對帳單通知有單號、金額、付款期限',
      stmtPush && /STMT-\d{8}-\d{4}/.test(stmtPush.body.messages[0].text)
      && /NT\$[\d,]+/.test(stmtPush.body.messages[0].text) && /前完成付款/.test(stmtPush.body.messages[0].text),
      stmtPush && stmtPush.body);
    check('LINE 收到的是 Bearer 憑證', pushes.every((p) => p.headers.authorization === 'Bearer test-line-token'));
    check('每則推播都帶 UUID 格式的 X-Line-Retry-Key',
      pushes.every((p) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(p.headers['x-line-retry-key'])),
      pushes.map((p) => p.headers['x-line-retry-key']));
    check('不同通知的 retry key 不同', new Set(pushes.map((p) => p.headers['x-line-retry-key'])).size === pushes.length);
    check('每一則都回報給後端，後端記為已送出',
      out['回報結果'].length === pushes.length && out['回報結果'].every((r) => r.ok && r.data.status === 'sent'), out['回報結果']);

    out = await run(notifyWf, '後端叫醒');
    check('已送出的不會再送一次（Webhook 叫醒也一樣）', mock.line.length === 0 && !out['組訊息'], mock.line);

    section('通知收集器：LINE 失敗與重複');
    await api('POST', '/api/v1/orders/ship', { token: owner,
      body: { order_id: 'HB2608-007', override_reason: '熟客，到貨付現' } });
    mock.lineScript.push({ status: 429, body: { message: 'You have reached your monthly limit.' } });
    out = await run(notifyWf, '每分鐘');
    const failedReport = out['回報結果'] && out['回報結果'][0];
    check('LINE 額度用完 → 回報失敗，後端排入退避重試',
      failedReport && failedReport.ok && failedReport.data.status === 'failed' && failedReport.data.gave_up === false, out['回報結果']);
    check('失敗原因帶著 LINE 的原話', /429/.test(out['整理結果'][0].error)
      && /monthly limit/.test(JSON.stringify(out['整理結果'][0].line_response)), out['整理結果']);

    const build = notifyWf.nodes.find((n) => n.name === '組訊息');
    const sample = { notif_id: 'ntfq_same', kind: 'shipped', line_user_id: 'U_x', payload: { text: 'hi' } };
    const lineage = { 設定: { liff_url: '' } };
    const k1 = (await runCode(build, { json: sample, lineage })).retry_key;
    const k2 = (await runCode(build, { json: sample, lineage })).retry_key;
    check('同一則通知每次重試都用同一把 retry key（LINE 據此擋重複）', k1 === k2);

    const tidy = notifyWf.nodes.find((n) => n.name === '整理結果');
    const dup = await runCode(tidy, { json: { statusCode: 409, headers: { 'x-line-accepted-request-id': 'abc' }, body: {} },
      lineage: { 組訊息: { notif_id: 'ntfq_same' } } });
    check('LINE 回 409＋已受理編號 = 之前送成功過，算成功', dup.ok === true && dup.error === null, dup);
    const down = await runCode(tidy, { json: { error: { message: 'ETIMEDOUT' } }, lineage: { 組訊息: { notif_id: 'ntfq_same' } } });
    check('連不上 LINE → 回報失敗並寫明原因', down.ok === false && /ETIMEDOUT/.test(down.error), down);
    const odd = await runCode(build, { json: { notif_id: 'n1', kind: 'arrived', line_user_id: 'U_x', payload: {} }, lineage });
    check('沒有文案的通知種類不會推空訊息', odd.messages.length === 0, odd);

    section('拍照辨識：照片 → OpenRouter（Claude）→ 回寫 → 後端查表定價');
    const jpg = 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg').toString('base64');
    const add = async (name) => (await api('POST', '/api/v1/cart/add-image',
      { token: buyer, body: { file_name: name, data: jpg } })).data;
    const cartItem = async (id) => (await api('GET', '/api/v1/cart/list', { token: buyer })).data.find((c) => c.cart_id === id);

    const a = await add('ocr_temp_n8ntest1_202609240900001.jpg');
    mock.claudeScript.push(claudeSays({ name: 'Pigeon 母乳實感奶瓶 240ml', name_ja: '母乳実感 哺乳びん 240ml', jpy_taxed: 1089, confidence: 'high' }));
    out = await run(ocrWf, '每分鐘');
    const call = mock.claude.shift();
    check('OpenRouter 收到 Bearer 憑證', call && call.headers.authorization === 'Bearer test-openrouter-key', call && call.headers);
    const user = call.body.messages.find((m) => m.role === 'user');
    const img = user && user.content.find((c) => c.type === 'image_url');
    check('圖片用後端給的短效簽名網址，不是永久連結',
      img && img.image_url.url.startsWith(mock.base + '/storage/v1/object/sign/'), img);
    check('模型取自「設定」節點、結構化輸出、只派給支援參數的供應商',
      call.body.model === 'anthropic/claude-sonnet-5' && call.body.response_format.type === 'json_schema'
      && call.body.provider.require_parameters === true, call.body);
    // 正式環境踩過的雷：Claude Sonnet 5 不接受自訂取樣參數，配上 require_parameters
    // 會讓 OpenRouter 找不到任何供應商，整條辨識靜靜地全數失敗。
    check('請求不帶 temperature／top_p／top_k',
      !['temperature', 'top_p', 'top_k'].some((k) => k in call.body), Object.keys(call.body));
    const got = await cartItem(a.cart_id);
    check('回寫成功：品名、日文名、¥1089 → 後端查表 NT$400、辨識完成',
      got.name === 'Pigeon 母乳實感奶瓶 240ml' && got.name_ja === '母乳実感 哺乳びん 240ml'
      && got.price_twd === 400 && got.ocr_done === true, got);

    const b = await add('ocr_temp_n8ntest2_202609240900002.jpg');
    mock.claudeScript.push({ status: 404, body: { error: { code: 404, message: 'No endpoints found that can handle the requested parameters.' } } });
    out = await run(ocrWf, '每分鐘');
    check('OpenRouter 回錯誤 → 不回寫，照片留在佇列等下一輪',
      out['解析結果'][0].write === false && !out['回寫辨識結果'] && (await cartItem(b.cart_id)).ocr_done === false, out['解析結果']);

    const c = await add('ocr_temp_n8ntest3_202609240900003.jpg');
    mock.claudeScript.push(claudeSays({ name: '', name_ja: null, jpy_taxed: null, confidence: 'low' }));
    await run(ocrWf, '每分鐘');
    const blurry = await cartItem(c.cart_id);
    check('AI 認不出來 → 仍算辨識結束，請客人自己填，不會卡在「辨識中」',
      blurry.ocr_done === true && blurry.price_twd === null && /自行填寫/.test(blurry.note), blurry);

    mock.claude.length = 0;
    mock.claudeScript.length = 0;
    out = await run(ocrWf, '每分鐘');
    check('沒有待辨識的照片就不呼叫模型（不花錢）', mock.claude.length === 0 && !out['組請求'], mock.claude.length);

    const parse = ocrWf.nodes.find((n) => n.name === '解析結果');
    const refused = await runCode(parse, { json: { statusCode: 200,
      body: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: null, refusal: '不處理' } }] } },
    lineage: { 組請求: { cart_id: 'x' } } });
    check('模型拒絕 → 不回寫', refused.write === false, refused);
    const fenced = await runCode(parse, { json: { statusCode: 200, body: { choices: [{ finish_reason: 'stop',
      message: { content: '```json\n{"name":"X","name_ja":null,"jpy_taxed":500,"confidence":"high"}\n```' } }] } },
    lineage: { 組請求: { cart_id: 'x' } } });
    check('回應包在 ```json 區塊裡也解析得出來', fenced.write === true && fenced.result.jpy_taxed === 500, fenced);
    const odd2 = claudeSays({ name: 'X', name_ja: null, jpy_taxed: -5, confidence: 'sure' });
    const weird = await runCode(parse, { json: { statusCode: 200, body: odd2.body }, lineage: { 組請求: { cart_id: 'x' } } });
    check('怪異的價格與信心度被收斂成 null / low', weird.result.jpy_taxed === null && weird.result.ai_confidence === 'low', weird);
  } catch (e) {
    failed++;
    console.error('\n測試中斷：', e);
  } finally {
    if (server) server.kill();
    harness.child.kill('SIGINT');
    mockSrv.close();
  }
  console.log(`\nn8n 流程測試：${passed} 通過 / ${failed} 失敗`);
  process.exit(failed ? 1 : 0);
})();
