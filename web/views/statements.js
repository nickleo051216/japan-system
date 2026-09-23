import { GET, POST, h, nt, dt, toast, fail } from '/app.js';

/**
 * 對帳單。「結算」把已報價以上、還沒付清的訂單依客人歸成對帳單，並排入 LINE 通知。
 * 也可以交給 n8n 在每月結算日自動呼叫 —— 這個按鈕是手動補結算用的。
 */
export async function render(root, ctx) {
  const status = ctx.query.status || '';
  const rows = await GET('/api/v1/statements/admin-list' + (status ? '?status=' + encodeURIComponent(status) : ''));

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
            toast(`${r.statement_id} 已核對，底下訂單一併標為已付款`); ctx.reload();
          } catch (e) {
            // 金額對不上時不自動認列；店主確認差額後再送一次。
            if (e.code === 'AMOUNT_MISMATCH' && window.confirm(`${e.message}\n\n確定照這個金額認列？`)) {
              try {
                await POST('/api/v1/statements/reconcile', { statement_id: s.statement_id, amount_twd: Number(amount.value), accept_difference: true });
                toast('已認列（含差額）'); ctx.reload();
              } catch (e2) { fail(e2); }
            } else fail(e);
          }
        } }, '核帳')))));
  }
}
