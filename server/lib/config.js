'use strict';
/**
 * Config. Every secret comes from the environment (README §0.2 rule 3, §10).
 * Nothing here is ever written to disk or returned by an API.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Minimal .env loader so the prototype starts without extra dependencies.
const envFile = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// Prototype convenience: an unset signing key gets an ephemeral random one so
// nobody is tempted to commit a default. Labels printed before a restart stop
// verifying after it — which is the correct behaviour for a rotated key.
function keyOrEphemeral(name) {
  const v = process.env[name];
  if (v && v.trim()) return v.trim();
  const generated = crypto.randomBytes(32).toString('hex');
  console.warn(`[config] ${name} 未設定，本次啟動使用臨時隨機金鑰（重啟後失效）。正式環境必須設定。`);
  return generated;
}

module.exports = {
  port: Number(process.env.PORT || 3000),
  dbPath: path.resolve(process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'prototype.db')),
  qrSigningKey: keyOrEphemeral('QR_SIGNING_KEY'),
  sessionSigningKey: keyOrEphemeral('SESSION_SIGNING_KEY'),
  defaultFxRate: Number(process.env.FX_JPY_TWD || 0.215),
};
