'use strict';
const db = require('./db');
const { uid, now } = require('./ids');

/** audit_log.detail is jsonb, so node-postgres hands it back already parsed. */
const parseDetail = (d) => (typeof d === 'string' ? JSON.parse(d) : (d ?? null));

/**
 * Every write that changes business state lands here (README §6 安全, F-19).
 * result: 'ok' | 'warn' (overridden interception) | 'blocked' (refused)
 */
async function record({ actor, action, target = null, detail = null, result = 'ok' }) {
  await db.run(
    'INSERT INTO audit_log (log_id, ts, actor, action, target, detail, result) VALUES (?,?,?,?,?,?,?)',
    uid('log'), now(), actor || null, action, target, detail ? JSON.stringify(detail) : null, result
  );
}

async function list({ from, to, actor, result, limit = 200 }) {
  const where = [];
  const params = [];
  if (from) { where.push('ts >= ?'); params.push(from); }
  if (to) { where.push('ts <= ?'); params.push(to); }
  if (actor) { where.push('actor = ?'); params.push(actor); }
  if (result) { where.push('result = ?'); params.push(result); }
  const sql = `SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC LIMIT ?`;
  const rows = await db.all(sql, ...params, limit);
  return rows.map((r) => ({ ...r, detail: parseDetail(r.detail) }));
}

module.exports = { record, list };
