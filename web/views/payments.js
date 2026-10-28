import { GET, POST, h, nt, dt, toast, fail } from '../app.js';

/**
 * 金流設定（綠界）。只有店主看得到。
 *
 * 店主在這裡填綠界的特店編號、HashKey、HashIV。按下儲存時，後端會先拿這組金鑰
 * 去問綠界（QueryTradeInfo）對不對，對了才存進 Supabase Vault。存好之後畫面上
 * 只看得到末四碼 —— 完整的金鑰不會再回到瀏覽器。
 *
 * 測試（stage）與正式（live）各一組，分開存；「目前使用」決定客人刷卡走哪一組。
 * 測試環境不會真的扣款，所以測試時只有店家自己的帳號能刷卡。
 */

const ENV_LABEL = { stage: '測試環境', live: '正式收款' };
// 綠界公開在開發者文件上的測試特店，給「先試試看」用。不是機密。
const ECPAY_TEST_SHOP = { merchant_id: '3002607', hash_key: 'pwFHCqoQZGmho4w6', hash_iv: 'EkRm7iFT261dpevs' };
const STATUS = { pending: ['等待付款', 'amber'], paid: ['已付款', 'green'], failed: ['付款失敗', 'red'] };

export async function render(root, ctx) {
  const data = await GET('/api/v1/settings/ecpay');
  const reload = () => ctx.reload();

  // ---- 目前使用哪一組 ----
  const switchBtn = (env) => {
    const cur = data.env === env;
    const ready = data.envs[env].configured && data.envs[env].verify_ok;
    return h('button', {
      class: 'btn' + (cur ? ' primary' : ''), disabled: cur || !ready,
      onClick: async () => {
        if (env === 'live' && !confirm('切到正式收款後，客人刷卡會真的扣款。確定要切換嗎？')) return;
        try { await POST('/api/v1/settings/ecpay/env', { env }); toast(`已切換為${ENV_LABEL[env]}`); reload(); }
        catch (e) { fail(e); }
      },
    }, cur ? `目前：${ENV_LABEL[env]}` : `切到${ENV_LABEL[env]}`);
  };
  root.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, '目前使用'), h('div', { class: 'spacer' }),
      h('span', { class: 'tag ' + (data.env === 'live' ? 'green' : 'amber') }, ENV_LABEL[data.env])),
    h('div', { class: 'card-body' },
      h('div', { class: 'banner ' + (data.env === 'live' ? 'info' : 'warn') }, data.env === 'live'
        ? '正式收款中：客人在對帳單按「信用卡付款」會真的扣款，付款成功後對帳單自動變成「已核對」，並通知客人。'
        : '測試中：綠界測試環境不會真的扣款。這段期間只有店家自己的帳號能刷卡，客人會看到「線上刷卡測試中，請改用銀行轉帳」。'),
      h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' }, switchBtn('stage'), switchBtn('live')),
      h('div', { class: 'tiny muted', style: 'margin-top:10px' },
        '綠界付款結果的回傳網址（不用改，給綠界客服看用）：',
        h('span', { class: 'mono' }, data.return_url || '尚未設定 —— 請聯絡系統管理者')))));

  // ---- 兩組金鑰 ----
  for (const env of ['stage', 'live']) root.append(credCard(env, data.envs[env], reload));

  // ---- 最近的刷卡紀錄 ----
  const rows = data.recent_trades;
  root.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, '最近的刷卡紀錄')),
    h('div', { class: 'table-wrap' }, h('table', { class: 'stack' },
      h('thead', {}, h('tr', {}, h('th', {}, '時間'), h('th', {}, '客人'), h('th', {}, '對帳單'),
        h('th', {}, '金額'), h('th', {}, '環境'), h('th', {}, '狀態'), h('th', {}, '綠界訊息'))),
      h('tbody', {}, ...(rows.length ? rows.map((t) => {
        const [label, tone] = STATUS[t.status] || [t.status, ''];
        return h('tr', {},
          h('td', { class: 'tiny muted' }, dt(t.paid_at || t.created_at)),
          h('td', {}, `${t.nickname}（${t.member_no}）`),
          h('td', { class: 'mono small' }, t.statement_id),
          h('td', {}, nt(t.amount_twd)),
          h('td', { class: 'small' }, ENV_LABEL[t.env]),
          h('td', {}, h('span', { class: 'tag ' + tone }, label)),
          h('td', { class: 'small muted' }, t.rtn_msg || ''));
      }) : [h('tr', {}, h('td', { colspan: '7', class: 'empty' }, '還沒有人用信用卡付款'))]))))));
}

function credCard(env, c, reload) {
  const f = {
    merchant_id: h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: c.configured ? c.merchant_id : '例：3002607' }),
    hash_key: h('input', { type: 'password', autocomplete: 'new-password', placeholder: c.configured ? `目前 ••••${c.key_last4}` : '16 碼英數' }),
    hash_iv: h('input', { type: 'password', autocomplete: 'new-password', placeholder: c.configured ? `目前 ••••${c.iv_last4}` : '16 碼英數' }),
  };
  const save = h('button', { class: 'btn primary', onClick: async () => {
    const body = { env, merchant_id: f.merchant_id.value.trim() || (c.configured ? c.merchant_id : ''),
      hash_key: f.hash_key.value.trim(), hash_iv: f.hash_iv.value.trim() };
    if (!body.hash_key || !body.hash_iv) { toast('HashKey 和 HashIV 都要填', 'err'); return; }
    save.disabled = true; save.textContent = '向綠界確認中…';
    try {
      await POST('/api/v1/settings/ecpay/credentials', body);
      f.hash_key.value = ''; f.hash_iv.value = '';
      toast(`${ENV_LABEL[env]}的金鑰已通過綠界驗證並儲存`);
      reload();
    } catch (e) { fail(e); }
    finally { save.disabled = false; save.textContent = '向綠界驗證並儲存'; }
  } }, '向綠界驗證並儲存');

  const status = c.configured
    ? h('div', { class: 'small' },
      h('span', { class: 'tag ' + (c.verify_ok ? 'green' : 'red') }, c.verify_ok ? '驗證通過' : '驗證失敗'), ' ',
      `特店編號 ${c.merchant_id}｜HashKey ••••${c.key_last4}｜HashIV ••••${c.iv_last4}｜最後驗證 ${dt(c.verified_at)}`,
      c.verify_msg && !c.verify_ok ? h('div', { class: 'tiny muted' }, c.verify_msg) : null)
    : h('div', { class: 'small muted' }, '還沒有設定');

  const actions = [save];
  if (c.configured) {
    actions.push(h('button', { class: 'btn', onClick: async () => {
      try { await POST('/api/v1/settings/ecpay/verify', { env }); toast('已重新向綠界確認'); reload(); }
      catch (e) { fail(e); }
    } }, '重新驗證'));
  }
  if (env === 'stage') {
    actions.push(h('button', { class: 'btn', onClick: () => {
      f.merchant_id.value = ECPAY_TEST_SHOP.merchant_id;
      f.hash_key.value = ECPAY_TEST_SHOP.hash_key;
      f.hash_iv.value = ECPAY_TEST_SHOP.hash_iv;
      toast('已填入綠界公開的測試特店，按「向綠界驗證並儲存」');
    } }, '填入綠界測試特店'));
  }

  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, `${ENV_LABEL[env]}的金鑰`), h('div', { class: 'spacer' }),
      h('span', { class: 'muted tiny' }, env === 'live' ? '綠界正式特店後台 → 系統開發管理 → 系統介接設定' : '綠界測試特店（不會真的扣款）')),
    h('div', { class: 'card-body' },
      status,
      h('div', { class: 'grid cols-2', style: 'margin-top:12px' },
        h('label', { class: 'field' }, h('span', {}, '特店編號（MerchantID）'), f.merchant_id),
        h('label', { class: 'field' }, h('span', {}, 'HashKey'), f.hash_key),
        h('label', { class: 'field' }, h('span', {}, 'HashIV'), f.hash_iv)),
      h('div', { class: 'tiny muted', style: 'margin-top:6px' },
        '按下儲存會先向綠界確認這組金鑰，對了才存。金鑰存進 Supabase Vault（加密），之後畫面上只會顯示末四碼。'),
      h('div', { class: 'row', style: 'margin-top:12px;gap:8px;flex-wrap:wrap' }, ...actions)));
}
