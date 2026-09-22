'use strict';
/**
 * Outbound notification queue.
 *
 * japan-system never talks to LINE. It queues; n8n collects and sends. That
 * split buys three things:
 *   - the shipping response never waits on LINE (a Vercel request caps at 15s)
 *   - push credentials, the monthly quota and the Flex templates stay in one
 *     place instead of two
 *   - a notification survives n8n being down. A direct call would be lost
 *     silently, and a customer never told their parcel shipped turns into a
 *     support message.
 *
 * Delivery is "poke plus poll": queue() is followed by a fire-and-forget nudge
 * to n8n for latency, while n8n's own polling is what guarantees nothing is
 * dropped. The queue, not the nudge, is the source of truth.
 */
const crypto = require('node:crypto');
const db = require('./db');
const config = require('./config');
const { uid, now } = require('./ids');

/** Minutes to wait before retry N. A 6th failure stops retrying. */
const BACKOFF_MINUTES = [1, 5, 15, 60, 360];
const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1;
/** How long a claimed row stays leased before another worker may take it. */
const LEASE_MINUTES = 10;

/**
 * Queue one notification. Safe to call twice for the same order and kind — the
 * unique index makes the second call a no-op rather than a duplicate message.
 * Call it inside the same transaction as the state change it announces, so a
 * shipment can never be recorded without its notification being queued.
 */
async function queue({ kind, lineUserId, orderId = null, statementId = null, payload }) {
  const res = await db.run(
    `INSERT INTO notification_outbox (notif_id, kind, line_user_id, order_id, statement_id, payload, created_at, next_retry_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT DO NOTHING`,
    uid('ntfq'), kind, lineUserId, orderId, statementId, JSON.stringify(payload), now(), now());
  return res.changes > 0;
}

/**
 * Hand the next due notifications to a worker.
 *
 * The claim is one statement: the rows are locked, marked sending, and their
 * retry time pushed out as a lease, all at once. Two n8n executions arriving
 * together therefore cannot pick up the same row — SKIP LOCKED gives the second
 * one the next rows instead of making it wait.
 */
async function claim(limit = 20) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const res = await db.run(
    `UPDATE notification_outbox
        SET status = 'sending',
            attempts = attempts + 1,
            next_retry_at = now() + (? || ' minutes')::interval
      WHERE notif_id IN (
        SELECT notif_id FROM notification_outbox
         WHERE status IN ('pending','sending','failed')
           AND next_retry_at <= now()
           AND attempts < ?
         ORDER BY created_at
         LIMIT ?
         FOR UPDATE SKIP LOCKED)
      RETURNING notif_id, kind, line_user_id, order_id, statement_id, payload, attempts`,
    String(LEASE_MINUTES), MAX_ATTEMPTS, n);
  return res.rows;
}

/**
 * Record what happened to one notification.
 *
 * A failure is never silent: it is retried on a widening backoff, and once the
 * attempts run out it becomes an owner todo on the dashboard. Nobody has to
 * remember to go looking in a table.
 */
async function report({ notifId, ok: sent, error = null, lineResponse = null }) {
  const row = await db.one('SELECT * FROM notification_outbox WHERE notif_id = ?', notifId);
  if (!row) return null;

  if (sent) {
    await db.run("UPDATE notification_outbox SET status = 'sent', sent_at = ?, last_error = NULL WHERE notif_id = ?", now(), notifId);
    return { notif_id: notifId, status: 'sent' };
  }

  // Keep LINE's own words: a quota that has run out still answers 200, so the
  // raw response is the only way to see it coming.
  const detail = [error, lineResponse ? JSON.stringify(lineResponse) : null].filter(Boolean).join(' | ').slice(0, 2000) || '未提供原因';
  const giveUp = row.attempts >= MAX_ATTEMPTS;
  const wait = BACKOFF_MINUTES[Math.min(row.attempts, BACKOFF_MINUTES.length) - 1] || BACKOFF_MINUTES[0];

  await db.run(
    `UPDATE notification_outbox
        SET status = 'failed', last_error = ?,
            next_retry_at = now() + (? || ' minutes')::interval
      WHERE notif_id = ?`,
    detail, String(giveUp ? 0 : wait), notifId);

  if (giveUp) {
    await db.run(
      'INSERT INTO notifications (notif_id, audience, kind, title, body, target, created_at) VALUES (?,?,?,?,?,?,?)',
      uid('ntf'), 'owner', 'notify_failed',
      `通知發不出去：${row.order_id || row.statement_id || row.notif_id}`,
      `已重試 ${row.attempts} 次仍失敗，最後錯誤：${detail.slice(0, 200)}`,
      row.order_id || null, now());
  }
  return { notif_id: notifId, status: 'failed', gave_up: giveUp, attempts: row.attempts };
}

/**
 * Tell n8n there is something to collect. Fire and forget on purpose: if this
 * fails the notification is still queued and n8n's next poll picks it up, so a
 * broken nudge costs latency, never a message. Never awaited by a route.
 */
function poke() {
  const url = config.notifyHookUrl;
  if (!url) return;
  const body = JSON.stringify({ event: 'notification.queued', at: now() });
  const headers = { 'Content-Type': 'application/json' };
  if (config.notifyToken) {
    headers['X-Signature'] = 'sha256=' + crypto.createHmac('sha256', config.notifyToken).update(body).digest('hex');
  }
  fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(3000) })
    .catch((e) => console.warn('[notify] 通知 n8n 失敗，改等輪詢：', e.message));
}

/** Constant-time check of the shared secret n8n presents. */
function requireMachine(req) {
  const secret = config.notifyToken;
  if (!secret) {
    throw Object.assign(new Error('通知佇列尚未設定金鑰'), { code: 'NOT_CONFIGURED', status: 503 });
  }
  const given = String(req.headers['x-notify-token'] || '');
  const a = Buffer.from(secret);
  const b = Buffer.from(given);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw Object.assign(new Error('金鑰不正確'), { code: 'UNAUTHENTICATED', status: 401 });
  }
}

module.exports = { queue, claim, report, poke, requireMachine, BACKOFF_MINUTES, MAX_ATTEMPTS, LEASE_MINUTES };
