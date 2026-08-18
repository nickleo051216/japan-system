'use strict';
/**
 * Prototype authentication.
 *
 * In production this slot is a LIFF ID Token / backend JWT verified inside n8n
 * (README I-02). Here it is an HMAC-signed opaque token so the shape is the
 * same: the client sends a token, the SERVER resolves role and enforces it.
 * Hiding a menu in the frontend is not a permission (F-21 強制規則).
 */
const crypto = require('node:crypto');
const db = require('./db');
const config = require('./config');

const TTL_MS = 12 * 60 * 60 * 1000;

function issue(lineUserId) {
  const body = Buffer.from(JSON.stringify({ sub: lineUserId, exp: Date.now() + TTL_MS })).toString('base64url');
  const mac = crypto.createHmac('sha256', config.sessionSigningKey).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function resolve(token) {
  if (!token) return null;
  const [body, mac] = String(token).split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', config.sessionSigningKey).update(body).digest('base64url');
  if (expected.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return null;
  let claims;
  try { claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!claims.exp || claims.exp < Date.now()) return null;
  return db.one('SELECT line_user_id, nickname, display_name, role FROM members WHERE line_user_id = ?', claims.sub);
}

/** Capability matrix — README F-21. Server-side source of truth. */
const CAPABILITIES = {
  'order.read':        ['owner', 'helper', 'packer'],
  'order.read.price':  ['owner', 'helper'],
  'order.read.cost':   ['owner'],            // 成本與毛利：只有店主
  'order.write':       ['owner', 'helper'],
  'payment.reconcile': ['owner'],
  'shipment.write':    ['owner', 'helper', 'packer'],
  'override.blocked':  ['owner'],            // 覆寫黃燈攔截
  'broadcast':         ['owner'],
  'settings.write':    ['owner'],
  'procurement.read':  ['owner', 'helper'],
  'procurement.write': ['owner', 'helper'],  // 成本寫入必須是 helper/owner (F-07 前置)
  'audit.read':        ['owner'],
};

const can = (actor, capability) => !!actor && (CAPABILITIES[capability] || []).includes(actor.role);

function requireCap(actor, capability) {
  if (!actor) throw Object.assign(new Error('尚未登入'), { code: 'UNAUTHENTICATED', status: 401 });
  if (!can(actor, capability)) {
    throw Object.assign(new Error('權限不足'), { code: 'FORBIDDEN', status: 403 });
  }
}

/**
 * Field-level redaction. A helper may see 售價 but never 成本/毛利; a packer
 * sees neither (F-21 table, §6 隱私).
 */
function redact(actor, obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map((o) => redact(actor, o));
  const out = { ...obj };
  const COST_FIELDS = ['unit_cost_jpy', 'unit_cost_twd', 'actual_cost_jpy', 'est_cost_jpy', 'margin_pct', 'cost_twd', 'gross_profit_twd', 'cost_registered_twd'];
  const PRICE_FIELDS = ['price_twd', 'unit_price_twd', 'total_twd', 'revenue_twd', 'unpaid_twd', 'amount_twd'];
  if (!can(actor, 'order.read.cost')) for (const f of COST_FIELDS) if (f in out) delete out[f];
  if (!can(actor, 'order.read.price')) for (const f of PRICE_FIELDS) if (f in out) delete out[f];
  for (const [k, v] of Object.entries(out)) if (v && typeof v === 'object') out[k] = redact(actor, v);
  return out;
}

module.exports = { issue, resolve, can, requireCap, redact, CAPABILITIES };
