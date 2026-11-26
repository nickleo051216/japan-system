'use strict';
/**
 * 多張照片一次上架（2026-11-25 照周小姐影片 1；017）。一張照片 = 一件商品。
 *
 *   POST /listings/upload   一次一張（Vercel 一次請求上限 4.5 MB），存成草稿並排進辨識佇列
 *   GET  /listings/drafts   還沒刊登的草稿，附辨識狀態（reading / done / failed）
 *   POST /listings/update   改品名、台幣售價、尺寸備註
 *   POST /listings/remove   移除一張
 *   POST /listings/publish  「一起刊登 N 件商品」：每張草稿開一張喊單（同一個交易，一張失敗全部不刊登）
 *
 * 辨識走 n8n 的拍照辨識流程（/ocr/pending 帶 include_listings，/ocr/result 帶 listing_id），
 * 讀的是照片上的「台幣售價」（$390、NT$390 這種價格標）。照片上只有日幣價的，後端用價目表換。
 * 讀不到單一台幣售價就留空，畫面請店主自己填 —— AI 不猜價錢。
 */
const db = require('../lib/db');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const price = require('../lib/price');
const storage = require('../lib/storage');
const { get, post, ok } = require('../lib/http');
const { now, uid } = require('../lib/ids');
const { err, num } = require('./buyer');
const { createBroadcast, signedShape } = require('./admin-shop');

const OCR_MAX_ATTEMPTS = 5;
const OCR_LEASE_MINUTES = 10;
const MAX_PUBLISH = 30;
const IMG = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;
const IMG_MAX = 3 * 1024 * 1024;

const text = (v, max) => (v === undefined || v === null ? null : String(v).trim().slice(0, max) || null);

function ocrState(d) {
  if (d.ocr_done_at) return 'done';
  if (d.ocr_attempts >= OCR_MAX_ATTEMPTS) return 'failed';
  return 'reading';
}

async function shape(rows) {
  const signed = await storage.resolve(rows.map((d) => ({ ...d, image_url: d.image_path })), 'image_url');
  return signed.map((d) => {
    const state = ocrState(d);
    const priceTwd = num(d.price_twd);
    return {
      draft_id: d.draft_id, image_url: d.image_url, name: d.name || '', price_twd: priceTwd,
      jpy_taxed: num(d.jpy_taxed), size_note: d.size_note || '', edited: !!d.edited,
      ocr: state, ai_confidence: d.ai_confidence || null, status: d.status, send_id: d.send_id || null,
      // 畫面上的提示字，跟影片一樣
      hint: state === 'reading' ? '正在辨識照片…'
        : priceTwd === null ? '未辨識到單一台幣售價，請填寫'
          : '請確認商品名稱，可直接修改',
      created_at: d.created_at,
    };
  });
}

const one = async (id) => (await shape([await db.one('SELECT * FROM listing_drafts WHERE draft_id = ?', id)]))[0];

post('/api/v1/listings/upload', async ({ actor, body }) => {
  auth.requireCap(actor, 'broadcast');
  const m = IMG.exec(String(body.data ?? ''));
  if (!m) throw err('BAD_IMAGE', '照片格式不對，請選 JPG、PNG 或 WebP');
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > IMG_MAX) throw err('BAD_IMAGE', '照片太大（上限 3 MB），請換一張');
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[m[1].toLowerCase()];
  const id = uid('LD');
  let ref;
  try {
    // 放在喊單資料夾底下：刊登後直接當喊單照片用，不用再搬一次。
    ref = await storage.put(`broadcast/draft-${id}.${ext}`, buf, m[1]);
  } catch (e) {
    console.error('[listings] 照片上傳失敗：', e.message);
    throw Object.assign(new Error('照片上傳失敗，請再試一次'), { code: 'UPLOAD_FAILED', status: 503 });
  }
  await db.run('INSERT INTO listing_drafts (draft_id, created_by, image_path, size_note, created_at) VALUES (?,?,?,?,?)',
    id, actor.line_user_id, ref, text(body.size_note, 40), now());
  return ok(await one(id));
});

get('/api/v1/listings/drafts', async ({ actor }) => {
  auth.requireCap(actor, 'broadcast');
  const rows = await db.all("SELECT * FROM listing_drafts WHERE status = 'draft' ORDER BY created_at, draft_id LIMIT 100");
  return ok(await shape(rows));
});

async function draftOf(id) {
  const d = await db.one('SELECT * FROM listing_drafts WHERE draft_id = ?', String(id || ''));
  if (!d) throw err('DRAFT_NOT_FOUND', '找不到這張照片（可能已經刊登或移除了）', 404);
  if (d.status !== 'draft') throw err('ALREADY_POSTED', d.status === 'posted' ? '這張已經刊登了' : '這張已經移除了', 409);
  return d;
}

function parsePrice(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 999999) throw err('BAD_PRICE', '台幣售價要大於 0');
  return Math.round(n);
}

post('/api/v1/listings/update', async ({ actor, body }) => {
  auth.requireCap(actor, 'broadcast');
  const d = await draftOf(body.draft_id);
  const sets = []; const vals = [];
  if (body.name !== undefined) { sets.push('name = ?'); vals.push(text(body.name, 60)); }
  const p = parsePrice(body.price_twd);
  if (p !== undefined) { sets.push('price_twd = ?'); vals.push(p); }
  if (body.size_note !== undefined) { sets.push('size_note = ?'); vals.push(text(body.size_note, 40)); }
  if (!sets.length) return ok(await one(d.draft_id));
  // 品名或價錢是人改的 → 之後才到的辨識結果不能蓋掉。
  if (body.name !== undefined || p !== undefined) sets.push('edited = true');
  await db.run(`UPDATE listing_drafts SET ${sets.join(', ')} WHERE draft_id = ?`, ...vals, d.draft_id);
  return ok(await one(d.draft_id));
});

post('/api/v1/listings/remove', async ({ actor, body }) => {
  auth.requireCap(actor, 'broadcast');
  const d = await draftOf(body.draft_id);
  await db.run("UPDATE listing_drafts SET status = 'removed' WHERE draft_id = ?", d.draft_id);
  return ok({ draft_id: d.draft_id, removed: true });
});

post('/api/v1/listings/publish', async ({ actor, body }) => {
  auth.requireCap(actor, 'broadcast');
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw err('NOTHING_TO_PUBLISH', '請先選照片');
  if (items.length > MAX_PUBLISH) throw err('TOO_MANY', `一次最多刊登 ${MAX_PUBLISH} 件`);
  const rows = [];
  for (const [i, it] of items.entries()) {
    const d = await draftOf(it.draft_id);
    const name = text(it.name !== undefined ? it.name : d.name, 60);
    const p = parsePrice(it.price_twd);
    const priceTwd = p === undefined ? num(d.price_twd) : p;
    if (!name) throw err('BAD_NAME', `第 ${i + 1} 件還沒有商品名稱`);
    if (!(priceTwd > 0)) throw err('BAD_PRICE', `第 ${i + 1} 件「${name}」還沒有台幣售價`);
    const qty = it.quantity === undefined || it.quantity === null || it.quantity === '' ? Number(body.quantity || 1) : Number(it.quantity);
    rows.push({ d, name, priceTwd, qty, sizeNote: it.size_note !== undefined ? text(it.size_note, 40) : d.size_note });
  }
  const created = await db.tx(async () => {
    const out = [];
    for (const r of rows) {
      // 尺寸備註（例如 90 / 100 / 110）用斜線或逗號隔開的話，直接變成喊單的尺寸選項。
      const sizes = r.sizeNote && /[/,、，]/.test(r.sizeNote) ? r.sizeNote.split(/[/,、，]/).map((x) => x.trim()).filter(Boolean) : null;
      const bc = await createBroadcast(actor, {
        name: r.name, price_twd: r.priceTwd, quantity: r.qty, deadline_at: body.deadline_at || null,
        note: sizes ? null : r.sizeNote, sizes, batch_name: body.batch_name,
      }, r.d.image_path);
      const res = await db.run("UPDATE listing_drafts SET status = 'posted', send_id = ?, name = ?, price_twd = ? WHERE draft_id = ? AND status = 'draft'",
        bc.send_id, r.name, r.priceTwd, r.d.draft_id);
      if (!res.changes) throw err('ALREADY_POSTED', `「${r.name}」剛剛已經刊登過了`, 409);
      out.push(bc);
    }
    return out;
  });
  await audit.record({ actor: actor.line_user_id, action: 'listings.publish', target: created.map((b) => b.send_id).join(','),
    detail: { count: created.length }, result: 'ok' });
  return ok({ count: created.length, broadcasts: await signedShape(created) });
});

// ---- 給 n8n 的辨識佇列（buyer-cart.js 的 /ocr/pending、/ocr/result 會呼叫）----

/** 領取待辨識的上架照片。正式庫還沒跑 017 時這張表不存在：當作沒有工作。 */
async function claimListingJobs(n) {
  if (n <= 0) return [];
  let res;
  try {
    res = await db.run(
      `UPDATE listing_drafts SET ocr_claimed_at = now(), ocr_attempts = ocr_attempts + 1
        WHERE draft_id IN (
          SELECT draft_id FROM listing_drafts
           WHERE status = 'draft' AND ocr_done_at IS NULL AND ocr_attempts < ?
             AND (ocr_claimed_at IS NULL OR ocr_claimed_at < now() - (? || ' minutes')::interval)
           ORDER BY created_at LIMIT ? FOR UPDATE SKIP LOCKED)
        RETURNING draft_id, image_path, created_at, ocr_attempts`,
      OCR_MAX_ATTEMPTS, String(OCR_LEASE_MINUTES), n);
  } catch (e) {
    if (e.code === '42P01') return [];
    throw e;
  }
  // UPDATE … RETURNING 不保證順序：照上傳先後排，n8n 才會照店主選的順序辨識。
  const rows = [...res.rows].sort((a, b) => new Date(a.created_at) - new Date(b.created_at) || String(a.draft_id).localeCompare(String(b.draft_id)));
  return storage.resolve(rows.map((r) => ({
    kind: 'listing', listing_id: r.draft_id, image_url: r.image_path, created_at: r.created_at, ocr_attempts: r.ocr_attempts,
  })), 'image_url');
}

/**
 * 寫回辨識結果。店主改過（edited）就只記 AI 的原始結果，不動品名和價錢。
 * 台幣售價優先用照片上讀到的；只讀到日幣就用價目表換；兩個都沒有就留空讓店主填。
 */
async function listingResult(body) {
  const id = String(body.listing_id);
  const d = await db.one('SELECT * FROM listing_drafts WHERE draft_id = ?', id);
  if (!d) throw err('NOT_FOUND', '找不到這張上架照片', 404);
  const confidence = ['high', 'medium', 'low'].includes(body.ai_confidence) ? body.ai_confidence : 'low';
  // 2026-11-26：信心低也先把 AI 的猜測填進去（店主發布前一定會看過、可以改），總比空白好。
  const name = String(body.name ?? '').trim().slice(0, 60);
  let twd = Number.isFinite(Number(body.price_twd)) && Number(body.price_twd) > 0 ? Math.round(Number(body.price_twd)) : null;
  const jpy = Number.isFinite(Number(body.jpy_taxed)) && Number(body.jpy_taxed) > 0 ? Number(body.jpy_taxed) : null;
  if (twd === null && jpy !== null) twd = await price.twdOf(jpy);
  const apply = !d.edited && d.status === 'draft';
  await db.run(
    `UPDATE listing_drafts SET ai_name = ?, ai_price_twd = ?, ai_confidence = ?, ocr_done_at = now(),
            jpy_taxed = coalesce(jpy_taxed, ?)
            ${apply ? ', name = coalesce(nullif(?, \'\'), name), price_twd = coalesce(?, price_twd)' : ''}
      WHERE draft_id = ?`,
    name || null, twd, confidence, jpy, ...(apply ? [name, twd] : []), id);
  return { listing_id: id, applied: apply, reason: apply ? null : '店主已經改過，不覆蓋', draft: await one(id) };
}

module.exports = { claimListingJobs, listingResult };
