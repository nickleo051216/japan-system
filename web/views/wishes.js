import { GET, POST, h, nt, dt, toast, fail, session } from '/app.js';

const TABS = ['待處理', '已報價', '現場缺貨', '保留下團', '全部'];

/**
 * 許願報價。許願建立後停在「待處理」，要在這裡報了價，客人才加得進購物車。
 */
export async function render(root, ctx) {
  const canWrite = session.can('order.write');
  const status = TABS.includes(ctx.query.status) ? ctx.query.status : '待處理';
  const rows = await GET('/api/v1/wishes/admin-list?status=' + encodeURIComponent(status));

  const tabs = h('div', { class: 'row', style: 'gap:6px' }, ...TABS.map((t) =>
    h('a', { class: 'btn sm' + (t === status ? ' primary' : ''), href: `#/wishes?status=${encodeURIComponent(t)}` }, t)));

  const tbody = h('tbody', {});
  root.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, '許願'), h('div', { class: 'spacer' }), tabs),
    h('div', { class: 'card-body' }, h('div', { class: 'banner info' },
      '填日幣就好，售價照價目表換算；超出級距才直接填台幣。報價後客人就能一鍵加入購物車。')),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, '客人'), h('th', {}, '想要'), h('th', {}, '數量'),
        h('th', {}, '許願時間'), h('th', {}, '狀態'), h('th', {}, '報價'), canWrite ? h('th', {}) : null)),
      tbody))));

  if (!rows.length) tbody.append(h('tr', {}, h('td', { colspan: '7', class: 'empty' }, `沒有「${status}」的許願`)));
  for (const w of rows) {
    const jpyIn = h('input', { type: 'number', min: '1', placeholder: '日幣', style: 'width:90px' });
    const twdIn = h('input', { type: 'number', min: '1', placeholder: '或台幣', style: 'width:90px' });
    const editable = w.wish_status !== '已下單';
    tbody.append(h('tr', {},
      h('td', {}, w.nickname),
      h('td', {}, w.item_name,
        w.ref_url ? h('div', {}, h('a', { href: w.ref_url, target: '_blank', rel: 'noopener', class: 'tiny' }, '商品連結 ↗')) : null,
        w.note ? h('div', { class: 'tiny muted' }, w.note) : null),
      h('td', {}, `×${w.quantity}`),
      h('td', { class: 'tiny muted' }, dt(w.wished_at)),
      h('td', {}, h('span', { class: 'tag' + (w.wish_status === '已報價' ? ' blue' : w.wish_status === '待處理' ? ' amber' : '') }, w.wish_status)),
      h('td', {}, w.quote_twd ? nt(w.quote_twd) : '—'),
      canWrite && editable ? h('td', {}, h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' },
        jpyIn, twdIn,
        h('button', { class: 'btn sm primary', onClick: async () => {
          try {
            const r = await POST('/api/v1/wishes/quote', { wish_id: w.wish_id,
              jpy_taxed: jpyIn.value ? Number(jpyIn.value) : null, quote_twd: twdIn.value ? Number(twdIn.value) : null });
            toast(`已報價 ${nt(r.quote_twd)}`); ctx.reload();
          } catch (e) { fail(e); } } }, '報價'),
        h('button', { class: 'btn sm', onClick: async () => {
          try { await POST('/api/v1/wishes/mark', { wish_id: w.wish_id, status: '現場缺貨' }); toast('已標記現場缺貨'); ctx.reload(); }
          catch (e) { fail(e); } } }, '缺貨'),
        h('button', { class: 'btn sm', onClick: async () => {
          try { await POST('/api/v1/wishes/mark', { wish_id: w.wish_id, status: '保留下團' }); toast('已保留到下一團'); ctx.reload(); }
          catch (e) { fail(e); } } }, '保留下團'))) : (canWrite ? h('td', {}) : null)));
  }
}
