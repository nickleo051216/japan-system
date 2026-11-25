'use strict';
/**
 * 商品資料庫（2026-11-25 照周小姐影片 2；019）。
 *
 * 不另外建商品表：把商品型錄（products，現場採購用的 SKU）和喊單（broadcast，每日連線的商品）
 * 合在一張表裡看。每一列有 key（"sku:P01" 或 "bc:BC-1125-001"）分辨是哪一邊的。
 *
 *   GET  /catalog/list?q=&line=&status=&source=   表格資料（搜尋、篩選）
 *   POST /catalog/create                          ＋新增商品（寫進型錄 products）
 *   POST /catalog/update                          改採購線、款式、尺寸、售價、品名
 *
 * 採購線（line）空的就是「待分類」。連線採買清單的篩選也看這一欄。
 */
const db = require('../lib/db');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const storage = require('../lib/storage');
const { currentBatch } = require('../lib/batch');
const { get, post, ok } = require('../lib/http');
const { err, num } = require('./buyer');

const LINE_MAX = 12;
const text = (v, max) => (v === undefined || v === null ? null : String(v).trim().slice(0, max) || null);

function sizesOf(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const arr = (Array.isArray(v) ? v : String(v).split(/[/,、，]/)).map((s) => String(s).trim()).filter(Boolean);
  if (arr.length > 20 || arr.some((s) => s.length > 12)) throw err('BAD_SIZES', '尺寸最多 20 個，每個 12 個字以內');
  return [...new Set(arr)];
}

async function rows() {
  const [products, broadcasts] = await Promise.all([
    db.all(`SELECT p.*, b.region FROM products p LEFT JOIN batches b ON b.batch = p.batch`),
    db.all(`SELECT bc.*, b.region FROM broadcast bc LEFT JOIN batches b ON b.batch = bc.batch`),
  ]);
  const t = Date.now();
  const out = [];
  for (const p of products) {
    const soldOut = p.stock_limit !== null && p.stock_limit !== undefined && Number(p.reserved) >= Number(p.stock_limit);
    out.push({
      key: `sku:${p.sku}`, source: 'catalog', source_zh: '型錄', id: p.sku, name: p.name_zh, name_local: p.name_local || null,
      brand: p.brand || null, line: p.line || null, variant: p.variant || null, sizes: p.sizes || null,
      price_twd: num(p.price_twd), batch: p.batch || null, region: p.region || null,
      status: soldOut ? 'sold_out' : 'active', status_zh: soldOut ? '已售完' : '上架中',
      image_url: p.image_url || null, created_at: null,
    });
  }
  for (const b of broadcasts) {
    const open = b.remaining > 0 && (!b.deadline_at || new Date(b.deadline_at).getTime() > t);
    const st = open ? 'active' : b.remaining > 0 ? 'closed' : 'sold_out';
    out.push({
      key: `bc:${b.send_id}`, source: 'broadcast', source_zh: '喊單', id: b.send_id, name: b.name, name_local: null,
      brand: null, line: b.line || null, variant: b.variant || null, sizes: b.sizes || null,
      price_twd: num(b.price_twd), batch: b.batch || null, region: b.region || null,
      status: st, status_zh: { active: '上架中', closed: '已截止', sold_out: '已售完' }[st],
      image_url: b.image_url || null, created_at: b.created_at, sold: b.quantity - b.remaining, quantity: b.quantity,
    });
  }
  return out;
}

get('/api/v1/catalog/list', async ({ actor, query }) => {
  auth.requireCap(actor, 'order.read');
  let list = await rows();
  const kw = String(query.q || '').trim().toLowerCase();
  if (kw) list = list.filter((r) => [r.name, r.name_local, r.brand, r.id, r.variant, r.line].some((v) => String(v || '').toLowerCase().includes(kw)));
  if (query.line === '__none') list = list.filter((r) => !r.line);
  else if (query.line) list = list.filter((r) => r.line === query.line);
  if (['active', 'closed', 'sold_out'].includes(query.status)) list = list.filter((r) => r.status === query.status);
  if (['catalog', 'broadcast'].includes(query.source)) list = list.filter((r) => r.source === query.source);
  // 新的喊單在前，型錄照編號排在後面
  list.sort((a, b) => (b.created_at ? new Date(b.created_at).getTime() : 0) - (a.created_at ? new Date(a.created_at).getTime() : 0)
    || String(a.id).localeCompare(String(b.id)));
  const all = await rows();
  const lines = [...new Set(all.map((r) => r.line).filter(Boolean))].sort();
  const signed = await storage.resolve(list.slice(0, 500), 'image_url');
  return ok(auth.redact(actor, { total: list.length, lines, untagged: all.filter((r) => !r.line).length, rows: signed }));
});

function requireEditor(actor) {
  auth.requireCap(actor, 'broadcast');   // 店主：跟開喊單同一個權限
}

post('/api/v1/catalog/create', async ({ actor, body }) => {
  requireEditor(actor);
  const name = text(body.name, 60);
  if (!name) throw err('BAD_NAME', '請填商品名稱');
  const priceTwd = body.price_twd === undefined || body.price_twd === null || body.price_twd === '' ? null : Number(body.price_twd);
  if (priceTwd !== null && !(priceTwd > 0 && priceTwd < 1000000)) throw err('BAD_PRICE', '售價要大於 0');
  const sizes = sizesOf(body.sizes) ?? null;
  const batch = await currentBatch();
  let sku = text(body.sku, 20);
  if (sku && !/^[A-Za-z0-9_-]+$/.test(sku)) throw err('BAD_SKU', '商品編號只能用英文、數字、- 和 _');
  if (!sku) {
    const last = await db.one("SELECT sku FROM products WHERE sku ~ '^P[0-9]+$' ORDER BY length(sku) DESC, sku DESC LIMIT 1");
    sku = 'P' + String((last ? parseInt(last.sku.slice(1), 10) : 0) + 1).padStart(2, '0');
  }
  if (await db.one('SELECT 1 AS x FROM products WHERE sku = ?', sku)) throw err('SKU_TAKEN', `商品編號 ${sku} 已經有了`, 409);
  await db.run(
    `INSERT INTO products (sku, name_zh, name_local, brand, price_twd, batch, line, variant, sizes)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    sku, name, text(body.name_local, 60), text(body.brand, 40), priceTwd, batch || null,
    text(body.line, LINE_MAX), text(body.variant, 30), sizes);
  await audit.record({ actor: actor.line_user_id, action: 'catalog.create', target: sku, detail: { name }, result: 'ok' });
  return ok((await rows()).find((r) => r.key === `sku:${sku}`));
});

post('/api/v1/catalog/update', async ({ actor, body }) => {
  requireEditor(actor);
  const m = /^(sku|bc):(.+)$/.exec(String(body.key || ''));
  if (!m) throw err('BAD_KEY', 'key 要是 sku:編號 或 bc:喊單編號');
  const isBc = m[1] === 'bc';
  const table = isBc ? 'broadcast' : 'products';
  const idCol = isBc ? 'send_id' : 'sku';
  const nameCol = isBc ? 'name' : 'name_zh';
  if (!await db.one(`SELECT 1 AS x FROM ${table} WHERE ${idCol} = ?`, m[2])) throw err('NOT_FOUND', '找不到這個商品', 404);
  const sets = []; const vals = []; const changed = [];
  const put = (col, v) => { sets.push(`${col} = ?`); vals.push(v); changed.push(col); };
  if (body.line !== undefined) put('line', text(body.line, LINE_MAX));
  if (body.variant !== undefined) put('variant', text(body.variant, 30));
  const sizes = sizesOf(body.sizes);
  if (sizes !== undefined) put('sizes', sizes);
  if (body.name !== undefined) { const n = text(body.name, 60); if (!n) throw err('BAD_NAME', '品名不能是空的'); put(nameCol, n); }
  if (body.price_twd !== undefined) {
    const p = Number(body.price_twd);
    if (!(p > 0 && p < 1000000)) throw err('BAD_PRICE', '售價要大於 0');
    // 喊單的售價有人搶了就不能改：客人是照當時的價錢喊的。
    if (isBc && await db.one('SELECT 1 AS x FROM broadcast WHERE send_id = ? AND remaining < quantity', m[2])) {
      throw err('PRICE_LOCKED', '這張喊單已經有人搶了，售價不能改', 409);
    }
    put('price_twd', p);
  }
  if (!sets.length) throw err('BAD_REQUEST', '沒有要改的欄位');
  await db.run(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${idCol} = ?`, ...vals, m[2]);
  await audit.record({ actor: actor.line_user_id, action: 'catalog.update', target: m[2], detail: { fields: changed }, result: 'ok' });
  const [row] = await storage.resolve([(await rows()).find((r) => r.key === body.key)], 'image_url');
  return ok(auth.redact(actor, row));
});
