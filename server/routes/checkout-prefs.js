'use strict';
/**
 * 結帳偏好（v1.8，022）。規則見 lib/checkout-prefs.js。
 *
 *   GET  /me/checkout-prefs   我的預設（付款方式、取貨方式、發票、特殊備註）
 *   POST /me/checkout-prefs   改（只改有帶的欄位，null 是清掉那一項）
 */
const prefs = require('../lib/checkout-prefs');
const { ok } = require('../lib/http');
const { bget, bpost } = require('./buyer');

bget('/api/v1/me/checkout-prefs', async ({ me }) => ok(prefs.shape(me)));

bpost('/api/v1/me/checkout-prefs', async ({ me, body }) => ok(prefs.shape(await prefs.save(me, body || {}))));

module.exports = {};
