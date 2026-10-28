'use strict';
/**
 * 綠界（ECPay）：付款結果回調、後台「金流設定」。
 *
 * 付款全程由後端處理，不經過 n8n：
 *   客人按「信用卡付款」→ /statements/pay-init 開一筆 ecpay_trades、簽好表單
 *   → 客人在綠界頁面刷卡 → 綠界 Server 直接 POST 到 /ecpay/return（本檔）
 *   → 驗簽、入帳、對帳單標「已核對」、恢復喊單資格、排通知。
 *
 * 回調的規矩（綠界官方）：
 *   - 必須驗 CheckMacValue（timing-safe），而且 MerchantID 要是自己的。
 *   - 10 秒內回純文字 1|OK；沒回 1|OK 綠界會每 5–15 分鐘重送，一天最多 4 次。
 *   - 同一筆可能收到好幾次：用 MerchantTradeNo 當冪等鍵，只入帳一次。
 *   - RtnCode 是字串 '1' 才是成功；SimulatePaid=1 是綠界後台的模擬付款，正式環境不入帳。
 */
const db = require('../lib/db');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const config = require('../lib/config');
const ecpay = require('../lib/ecpay');
const drops = require('../lib/drops');
const notify = require('../lib/notify');
const { get, post, raw, ok, readForm, sendText } = require('../lib/http');
const { uid } = require('../lib/ids');

const err = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const ntd = (v) => 'NT$' + Math.round(Number(v) || 0).toLocaleString('en-US');

// ---- 付款結果回調（ReturnURL）---------------------------------------------

/** 擋下來的回調一律寫稽核，事後查得到有人亂打這支。 */
const blocked = (reason, detail = {}) =>
  audit.record({ actor: 'ecpay', action: 'ecpay.return', detail: { reason, ...detail }, result: 'blocked' });

async function handleReturn(p) {
  const tradeNo = String(p.MerchantTradeNo || '');
  if (!/^[A-Za-z0-9]{1,20}$/.test(tradeNo) || !p.CheckMacValue) {
    await blocked('bad_request');
    return '0|Bad Request';
  }
  const trade = await db.one('SELECT * FROM ecpay_trades WHERE merchant_trade_no = ?', tradeNo);
  if (!trade) {
    await blocked('unknown_trade', { merchant_trade_no: tradeNo });
    return '0|Unknown MerchantTradeNo';
  }
  // 用「開單當時」的環境驗簽：中途從測試切到正式，舊單的回調一樣驗得過。
  const creds = await ecpay.credentials(trade.env);
  if (!creds) {
    console.error('[ecpay] 收到回調但找不到金鑰，環境：', trade.env);
    return '0|Not Configured';                   // 讓綠界之後重送
  }
  if (!ecpay.verifyMac(p, creds.hashKey, creds.hashIv)) {
    await blocked('bad_mac', { merchant_trade_no: tradeNo });
    return '0|CheckMacValue Error';
  }
  if (String(p.MerchantID || '') !== creds.merchantId) {
    await blocked('merchant_mismatch', { merchant_trade_no: tradeNo });
    return '0|MerchantID Error';
  }

  const s = await db.one('SELECT * FROM statements WHERE statement_id = ?', trade.statement_id);
  const base = { line_user_id: s.line_user_id, merchant_trade_no: tradeNo, env: trade.env, amount: trade.amount_twd };
  const rtn = String(p.RtnCode ?? '');
  const result = [p.TradeNo || null, rtn, String(p.RtnMsg || '').slice(0, 200), p.PaymentType || null,
    p.PaymentDate || null, String(p.SimulatePaid || '') === '1'];

  if (rtn !== '1') {
    await db.run(
      `UPDATE ecpay_trades SET status = 'failed', ecpay_trade_no = ?, rtn_code = ?, rtn_msg = ?, payment_type = ?,
         payment_date = ?, simulate_paid = ? WHERE merchant_trade_no = ? AND status = 'pending'`, ...result, tradeNo);
    await audit.record({ actor: 'ecpay', action: 'ecpay.failed', target: s.statement_id,
      detail: { ...base, rtn_code: rtn, rtn_msg: result[2] }, result: 'warn' });
    return '1|OK';
  }
  if (result[5] && trade.env === 'live') {
    await audit.record({ actor: 'ecpay', action: 'ecpay.ignored', target: s.statement_id,
      detail: { ...base, reason: 'simulate_in_live' }, result: 'warn' });
    return '1|OK';
  }
  if (Number(p.TradeAmt) !== Number(trade.amount_twd)) {
    // 金額對不上不自動入帳，留給店主人工確認（跟手動核帳的 F-06 規則一樣）。
    await audit.record({ actor: 'ecpay', action: 'ecpay.ignored', target: s.statement_id,
      detail: { ...base, reason: 'amount_mismatch', got: Number(p.TradeAmt) }, result: 'warn' });
    return '1|OK';
  }

  // 入帳：整段一筆交易。條件式 UPDATE 就是冪等鎖 —— 同一筆回調同時到兩次，
  // 第二次會等第一次提交，然後改不到任何列，直接當作「已處理過」。
  let outcome = 'duplicate';
  await db.tx(async () => {
    const r = await db.run(
      `UPDATE ecpay_trades SET status = 'paid', ecpay_trade_no = ?, rtn_code = ?, rtn_msg = ?, payment_type = ?,
         payment_date = ?, simulate_paid = ?, paid_at = now() WHERE merchant_trade_no = ? AND status <> 'paid'`,
      ...result, tradeNo);
    if (r.changes === 0) return;
    await db.run(
      `INSERT INTO payments (payment_id, statement_id, amount_twd, method, trade_no, rtn_code, received_at, reconciled_by)
       VALUES (?,?,?,'credit',?,'1',now(),'ecpay') ON CONFLICT (trade_no) DO NOTHING`,
      uid('pay'), s.statement_id, trade.amount_twd, tradeNo);
    const paid = await db.run(
      `UPDATE statements SET payment_status = '已核對', payway = 'credit', paid_at = now()
        WHERE statement_id = ? AND payment_status <> '已核對'`, s.statement_id);
    if (paid.changes === 0) { outcome = 'already_paid'; return; }
    await db.run("UPDATE orders SET payment_status = '已核對', paid_at = now() WHERE statement_id = ?", s.statement_id);
    outcome = 'credited';
  });
  if (outcome === 'duplicate') return '1|OK';

  // 對帳單之前已經用別的方式付清了（例如轉帳）又刷了卡：錢收了兩次，要店主退款。
  await audit.record({ actor: 'ecpay', action: 'ecpay.paid', target: s.statement_id,
    detail: { ...base, payment_type: result[3], double_paid: outcome === 'already_paid' },
    result: outcome === 'already_paid' ? 'warn' : 'ok' });
  if (outcome === 'credited') {
    await drops.restoreIfPaidUp(s.line_user_id, 'ecpay');
    await notify.queue({ kind: 'payment_received', lineUserId: s.line_user_id, statementId: s.statement_id,
      payload: { statement_id: s.statement_id, amount: trade.amount_twd,
        text: `✅ 付款成功\n\n對帳單 ${s.statement_id} 已收到 ${ntd(trade.amount_twd)}（信用卡）\n謝謝您 🙏` } });
    notify.poke();
  }
  return '1|OK';
}

raw('POST', '/api/v1/ecpay/return', async ({ req, res }) => {
  let reply;
  try {
    reply = await handleReturn(await readForm(req));
  } catch (e) {
    // 資料庫斷線之類的：回 0| 讓綠界之後重送，比回 1|OK 卻沒入帳好。
    console.error('[ecpay] 回調處理失敗：', e.code || '', e.message);
    reply = '0|Error';
  }
  sendText(res, 200, reply);
});

// ---- 後台：金流設定 --------------------------------------------------------
//
// 只有店主（settings.write）。完整的 HashKey／HashIV 寫進 Vault 之後就不再回到畫面上，
// 畫面、回應、稽核都只看得到末四碼。

async function settingsShape() {
  const [env, stage, live, trades] = await Promise.all([
    ecpay.currentEnv(), ecpay.credentialRow('stage'), ecpay.credentialRow('live'),
    db.all(`SELECT t.merchant_trade_no, t.statement_id, t.env, t.amount_twd, t.status, t.rtn_code, t.rtn_msg,
              t.payment_type, t.created_at, t.paid_at, m.nickname, m.member_no
              FROM ecpay_trades t JOIN statements s ON s.statement_id = t.statement_id
              JOIN members m ON m.line_user_id = s.line_user_id
             ORDER BY t.created_at DESC LIMIT 20`),
  ]);
  return {
    env,
    envs: { stage: ecpay.publicShape(stage), live: ecpay.publicShape(live) },
    return_url: config.ecpayReturnUrl || null,
    recent_trades: trades,
  };
}

get('/api/v1/settings/ecpay', async ({ actor }) => {
  auth.requireCap(actor, 'settings.write');
  return ok(await settingsShape());
});

const envOf = (v) => {
  const env = String(v || '');
  if (!ecpay.ENVS.includes(env)) throw err('BAD_ENV', '環境只能是測試（stage）或正式（live）');
  return env;
};

post('/api/v1/settings/ecpay/credentials', async ({ actor, body }) => {
  auth.requireCap(actor, 'settings.write');
  const env = envOf(body.env);
  const merchantId = String(body.merchant_id || '').trim();
  const hashKey = String(body.hash_key || '').trim();
  const hashIv = String(body.hash_iv || '').trim();
  if (!/^\d{4,10}$/.test(merchantId)) throw err('BAD_MERCHANT_ID', '特店編號是 4–10 位數字');
  if (!/^[A-Za-z0-9]{8,64}$/.test(hashKey)) throw err('BAD_HASH_KEY', 'HashKey 格式不對：只會有英文和數字');
  if (!/^[A-Za-z0-9]{8,64}$/.test(hashIv)) throw err('BAD_HASH_IV', 'HashIV 格式不對：只會有英文和數字');

  // 先問綠界這組對不對，對了才存。存錯的金鑰只會讓客人刷卡時才發現。
  const check = await ecpay.verifyCredentials({ env, merchantId, hashKey, hashIv });
  const detail = { env, merchant_id: merchantId, key_last4: ecpay.last4(hashKey), iv_last4: ecpay.last4(hashIv) };
  if (!check.ok) {
    await audit.record({ actor: actor.line_user_id, action: 'settings.ecpay', detail: { ...detail, verify: check.message }, result: 'blocked' });
    throw err('ECPAY_VERIFY_FAILED', check.message, 422);
  }
  await ecpay.saveCredentials(env, { merchantId, hashKey, hashIv, verifyMsg: check.message }, actor.line_user_id);
  await audit.record({ actor: actor.line_user_id, action: 'settings.ecpay', detail, result: 'ok' });
  return ok(await settingsShape());
});

/** 重新向綠界驗證已存的金鑰（例如綠界那邊換過金鑰，想確認還能不能用）。 */
post('/api/v1/settings/ecpay/verify', async ({ actor, body }) => {
  auth.requireCap(actor, 'settings.write');
  const env = envOf(body.env);
  const creds = await ecpay.credentials(env);
  if (!creds) throw err('NOT_CONFIGURED', '這個環境還沒有填金鑰', 409);
  const check = await ecpay.verifyCredentials(creds);
  await db.run('UPDATE payment_credentials SET verified_at = now(), verify_ok = ?, verify_msg = ? WHERE env = ?',
    check.ok, check.message, env);
  return ok(await settingsShape());
});

post('/api/v1/settings/ecpay/env', async ({ actor, body }) => {
  auth.requireCap(actor, 'settings.write');
  const env = envOf(body.env);
  const before = await ecpay.currentEnv();
  const creds = await ecpay.credentials(env);
  if (!creds || !creds.verified) {
    throw err('NOT_CONFIGURED', `${env === 'live' ? '正式' : '測試'}環境的金鑰還沒填好或沒通過驗證`, 409);
  }
  await db.putSetting('ecpay_env', env);
  await audit.record({ actor: actor.line_user_id, action: 'settings.ecpay_env', detail: { from: before, to: env }, result: 'ok' });
  return ok(await settingsShape());
});

module.exports = { handleReturn };
