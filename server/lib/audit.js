'use strict';
const db = require('./db');
const { uid, now } = require('./ids');

/**
 * Every write that changes business state lands here (README §6 安全, F-19).
 * result: 'ok' | 'warn' (overridden interception) | 'blocked' (refused)
 */
function record({ actor, action, target = null, detail = null, result = 'ok' }) {
  db.run(
    'INSERT INTO audit_log (log_id, ts, actor, action, target, detail, result) VALUES (?,?,?,?,?,?,?)',
    uid('log'), now(), actor || null, action, target, detail ? JSON.stringify(detail) : null, result
  );
}

function list({ from, to, actor, result, limit = 200 }) {
  const where = [];
  const params = [];
  if (from) { where.push('ts >= ?'); params.push(from); }
  if (to) { where.push('ts <= ?'); params.push(to); }
  if (actor) { where.push('actor = ?'); params.push(actor); }
  if (result) { where.push('result = ?'); params.push(result); }
  const sql = `SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC LIMIT ?`;
  return db.all(sql, ...params, limit).map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
}

module.exports = { record, list };
