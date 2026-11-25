import { GET, POST, h, nt, dt, toast, fail } from '../app.js';

/**
 * 對帳單。「結算」把已報價以上、還沒付清的訂單依客人歸成對帳單，並排入 LINE 通知。
 * 也可以交給 n8n 在每月結算日自動呼叫 —— 這個按鈕是手動補結算用的。
 */
export async function render(root, ctx) {
  const status = ctx.query.status || '';
  const rows = await GET('/api/v1/statements/admin-list' + (status ? '?status=' + encodeURIComponent(status) : ''));
  let auto = null;
  try { auto = await GET('/api/v1/statements/auto-status'); } catch { /* 舊版後端 */ }
  if (auto) root.append(autoCard(auto));

  root.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, '結算'), h('div', { class: 'spacer' }),
      h('button', { class: 'btn primary', onClick: async () => {
        try {
          const r = await POST('/api/v1/statements/generate', {});
          toast(r.created.length ? `已開出 ${r.created.length} 張對帳單，並排入 LINE 通知` : '沒有需要結算的訂單');
          ctx.reload();
        } catch (e) { fail(e); }
      } }, '立即結算')),
    h('div', { class: 'card-body' }, h('div', { class: 'banner info' },
      '重按不會重複開單 —— 已經歸進對帳單的訂單不會再被挑出來。'))));

  const tbody = h('tbody', {});
  const tabs = h('div', { class: 'row', style: 'gap:6px' }, ...['', '待付款', '待官方確認', '已核對'].map((t) =>
    h('a', { class: 'btn sm' + (t === status ? ' primary' : ''), href: '#/statements' + (t ? '?status=' + encodeURIComponent(t) : '') }, t || '全部')));
  root.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, '對帳單'), h('div', { class: 'spacer' }), tabs),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, '對帳單'), h('th', {}, '客人'), h('th', {}, '訂單數'), h('th', {}, '金額'),
        h('th', {}, '狀態'), h('th', {}, '回報末五碼'), h('th', {}, '開單'), h('th', {}))),
      tbody))));

  if (!rows.length) tbody.append(h('tr', {}, h('td', { colspan: '8', class: 'empty' }, '沒有對帳單')));
  for (const s of rows) {
    const amount = h('input', { type: 'number', value: String(s.total_amount), style: 'width:100px' });
    tbody.append(h('tr', {},
      h('td', { class: 'mono tiny' }, s.statement_id),
      h('td', {}, s.nickname),
      h('td', {}, s.order_count),
      h('td', {}, nt(s.total_amount)),
      h('td', {}, h('span', { class: 'tag ' + (s.payment_status === '已核對' ? 'green' : s.payment_status === '待官方確認' ? 'blue' : 'amber') }, s.payment_status)),
      h('td', { class: 'mono tiny' }, s.last_five_matched || '—'),
      h('td', { class: 'tiny muted' }, dt(s.created_at)),
      h('td', {}, s.payment_status === '已核對' ? h('span', { class: 'tiny muted' }, dt(s.paid_at)) : h('div', { class: 'row', style: 'gap:6px' },
        amount,
        h('button', { class: 'btn sm primary', onClick: async () => {
          try {
            const r = await POST('/api/v1/statements/reconcile', { statement_id: s.statement_id, amount_twd: Number(amount.value) });
            toast(`${r.statement_id} 已核對，底下訂單一併標為已付款${r.shout_restored ? '；客人的喊單資格已恢復' : ''}`); ctx.reload();
          } catch (e) {
            // 金額對不上時不自動認列；店主確認差額後再送一次。
            if (e.code === 'AMOUNT_MISMATCH' && window.confirm(`${e.message}\n\n確定照這個金額認列？`)) {
              try {
                const r2 = await POST('/api/v1/statements/reconcile', { statement_id: s.statement_id, amount_twd: Number(amount.value), accept_difference: true });
                toast(`已認列（含差額）${r2.shout_restored ? '；客人的喊單資格已恢復' : ''}`); ctx.reload();
              } catch (e2) { fail(e2); }
            } else fail(e);
          }
        } }, '核帳')))));
  }
}

/**
 * 自動結算的燈號（每月結算日由 Vercel 排程自動結算）。
 * 綠燈＝上次檢查正常；紅燈＝被擋下來、出錯或太久沒檢查；灰燈＝還沒檢查過或關掉了。
 * 測試方法：Vercel → Settings → Cron Jobs → Run，回來重新整理這一頁看「上次檢查」的時間有沒有變。
 */
function autoCard(a) {
  const md = (ymd) => (ymd ? `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}` : '—');
  const dot = { green: '🟢', red: '🔴', grey: '⚪' }[a.light];
  const c = a.last_check;
  return h('div', { class: 'card', style: 'padding:14px' + (a.light === 'red' ? ';border-color:var(--red)' : '') },
    h('div', { class: 'row', style: 'gap:8px' },
      h('strong', {}, `${dot} 自動結算`), h('span', { class: 'tag ' + (a.on ? 'green' : '') }, a.on ? '開著' : '關掉了'),
      h('span', { class: 'spacer', style: 'flex:1' }),
      a.next_date ? h('span', { class: 'small' }, '下次結算 ', h('b', {}, md(a.next_date))) : null),
    h('div', { class: 'small', style: 'margin-top:6px' + (a.light === 'red' ? ';color:var(--red)' : '') }, a.say),
    h('div', { class: 'tiny muted', style: 'margin-top:4px' },
      c ? `上次檢查 ${dt(c.at)}` : '還沒有檢查紀錄',
      a.last_ran_date ? `・上次真的結算 ${md(a.last_ran_date)}` : '', `・結算日 ${a.statement_days}`));
}
