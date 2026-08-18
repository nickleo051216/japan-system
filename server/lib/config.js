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

const ON_VERCEL = !!process.env.VERCEL;

// Prototype convenience: an unset signing key gets an ephemeral random one so
// nobody is tempted to commit a default. Labels printed before a restart stop
// verifying after it — which is the correct behaviour for a rotated key.
//
// On Vercel one deployment answers from several instances, and a per-instance
// random key would make a token issued by one instance fail on the next. So the
// demo derives a key from the deployment's own public URL — stable across the
// instances of one deployment, different for every deployment, and not a secret
// committed to the repository. Setting the real env var overrides it, and any
// deployment handling real orders MUST set it.
function keyOrEphemeral(name) {
  const v = process.env[name];
  if (v && v.trim()) return v.trim();
  if (ON_VERCEL) {
    const anchor = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || 'hb-demo';
    console.warn(`[config] ${name} 未設定，示範站以部署網址推導金鑰。正式環境必須設定真正的金鑰。`);
    return crypto.createHash('sha256').update(`hb-demo:${name}:${anchor}`).digest('hex');
  }
  const generated = crypto.randomBytes(32).toString('hex');
  console.warn(`[config] ${name} 未設定，本次啟動使用臨時隨機金鑰（重啟後失效）。正式環境必須設定。`);
  return generated;
}

// Serverless filesystems are read-only apart from /tmp, and /tmp does not
// survive a cold start — so the demo site reseeds itself from scratch whenever
// Vercel spins up a new instance. Documented in docs/PROTOTYPE.md.
const defaultDbPath = ON_VERCEL
  ? '/tmp/hb-prototype/prototype.db'
  : path.join(__dirname, '..', '..', 'data', 'prototype.db');

module.exports = {
  onVercel: ON_VERCEL,
  port: Number(process.env.PORT || 3000),
  dbPath: path.resolve(process.env.DB_PATH || defaultDbPath),
  qrSigningKey: keyOrEphemeral('QR_SIGNING_KEY'),
  sessionSigningKey: keyOrEphemeral('SESSION_SIGNING_KEY'),
  defaultFxRate: Number(process.env.FX_JPY_TWD || 0.215),
};
