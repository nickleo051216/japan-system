'use strict';
/**
 * F-16 HMAC anti-forgery signature.
 *
 *   signature = UPPER( BASE36( HMAC-SHA256(QR_SIGNING_KEY, order_id)[0..3] ) )[0..3]
 *
 * The key never leaves the server; sign() and verify() are only ever called
 * here (README F-16 rule 1 & 2). ~1.68M combinations — enough against manual
 * forgery, not against automated brute force. Widen SIG_LEN to 6 if needed.
 */
const crypto = require('node:crypto');
const config = require('./config');

const SIG_LEN = 4;
const PREFIX = 'HB';
const SEP = '|';

function sign(orderId) {
  const mac = crypto.createHmac('sha256', config.qrSigningKey).update(String(orderId)).digest();
  const int32 = mac.readUInt32BE(0);                       // bytes [0..3]
  return int32.toString(36).toUpperCase().padStart(SIG_LEN, '0').slice(0, SIG_LEN);
}

/** QR payload — pure ASCII so cheap scanners don't emit garbage (F-15). */
const payload = (orderId) => `${PREFIX}${SEP}${orderId}${SEP}${sign(orderId)}`;

function parse(raw) {
  const text = String(raw || '').trim();
  const parts = text.split(SEP);
  if (parts.length !== 3 || parts[0] !== PREFIX || !parts[1] || !parts[2]) return null;
  if (!/^[\x20-\x7E]*$/.test(text)) return null;           // non-ASCII => not our label
  return { orderId: parts[1], signature: parts[2] };
}

function verify(orderId, signature) {
  const expected = Buffer.from(sign(orderId));
  const given = Buffer.from(String(signature || '').toUpperCase());
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

module.exports = { sign, verify, payload, parse, SIG_LEN, PREFIX, SEP };
