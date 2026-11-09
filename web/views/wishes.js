import { GET, POST, h, nt, dt, toast, fail, session, modal } from '../app.js';

// 許願狀態的分頁，加上許願牆的兩個分頁（待審核、牆上）。
const TABS = [
  { key: '待處理', q: 'status=待處理' },
  { key: '待上牆', q: 'wall=pending' },
  { key: '牆上', q: 'wall=public' },
  { key: '已報價', q: 'status=已報價' },
  { key: '現場缺貨', q: 'status=現場缺貨' },
  { key: '保留下團', q: 'status=保留下團' },
  { key: '全部', q: 'status=全部' },
];
const WALL = {
  private: null,
  pending: ['等你審核', 'amber'],
  public: ['在許願牆上', 'green'],
  hidden: ['已收下來', ''],
};

/**
 * 許願報價＋許願牆。
 *
 * 許願建立後停在「待處理」，要在這裡報了價，客人才加得進購物車。
 * 客人勾了「公開到許願牆」的會出現在「待上牆」，店主按「放上牆」大家才看得到；
 * 其他客人可以按「我也想要 +1」。列表依想要的人數排，越多人想要越上面。
 * 「轉成喊單」一鍵開喊單，並 LINE 通知所有想要的人。
 */
export async function render(root, ctx) {
  const canWrite = session.can('order.write');
  const canWall = session.can('broadcast');
  const tab = TABS.find((t) => t.key === (ctx.query.tab || ctx.query.status)) || TABS[0];
  const rows = await GET('/api/v1/wishes/admin-list?' + tab.q.replace(/=(.*)$/, (_, v) => '=' + encodeURIComponent(v)));

  const tabs = h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' }, ...TABS.map((t) =>
    h('a', { class: 'btn sm' + (t === tab ? ' primary' : ''), href: `#/wishes?tab=${encodeURIComponent(t.key)}` }, t.key)));

  const tbody = h('tbody', {});
  root.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, '許願'), h('div', { class: 'spacer' }), tabs),
    h('div', { class: 'card-body' }, h('div', { class: 'banner info' },
      tab.key === '待上牆'
        ? '這些是客人勾了「公開到許願牆」的許願。看過沒問題按「放上牆」，其他客人才看得到、才能按 +1。不適合的按「收下來」。'
        : '依「想要的人數」排，越多人想要越上面。報價填日幣就好，售價照價目表換算；超出級距才直接填台幣。想要的人多，可以直接「轉成喊單」。')),
    h('div', { class: 'table-wrap' }, h('table', { class: 'stack' },
      h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, '客人'), h('th', {}, '想要'), h('th', {}, '想要的人'),
        h('th', {}, '許願時間'), h('th', {}, '狀態'), h('th', {}, '報價'), h('th', {}))),
      tbody))));

  if (!rows.length) tbody.append(h('tr', {}, h('td', { colspan: '8', class: 'empty' }, `沒有「${tab.key}」的許願`)));
  for (const w of rows) {
    const jpyIn = h('input', { type: 'number', min: '1', placeholder: '日幣', style: 'width:90px' });
    const twdIn = h('input', { type: 'number', min: '1', placeholder: '或台幣', style: 'width:90px' });
    const editable = w.wish_status !== '已下單';
    const wall = WALL[w.wall_status];

    const quoteActions = canWrite && editable ? [
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
        catch (e) { fail(e); } } }, '保留下團'),
    ] : [];

    const setWall = (status, msg) => h('button', { class: 'btn sm', onClick: async () => {
      try { await POST('/api/v1/wishes/wall', { wish_id: w.wish_id, status }); toast(msg); ctx.reload(); }
      catch (e) { fail(e); } } }, status === 'public' ? '放上牆' : '收下來');
    const wallActions = canWall ? [
      ['pending', 'hidden'].includes(w.wall_status) ? setWall('public', '已放上許願牆，客人看得到了') : null,
      ['pending', 'public'].includes(w.wall_status) ? setWall('hidden', '已從許願牆收下來') : null,
      w.broadcast_send_id ? null
        : h('button', { class: 'btn sm primary', onClick: () => toBroadcast(w, ctx) }, '轉成喊單'),
    ].filter(Boolean) : [];

    const actions = [...quoteActions, ...wallActions];
    tbody.append(h('tr', {},
      h('td', {}, w.picture ? h('img', { class: 'thumb', src: w.picture, alt: w.item_name }) : h('span', { class: 'tiny muted' }, '—')),
      h('td', {}, w.nickname),
      h('td', {}, w.item_name, ` ×${w.quantity}`,
        w.ref_url ? h('div', {}, h('a', { href: w.ref_url, target: '_blank', rel: 'noopener', class: 'tiny' }, '商品連結 ↗')) : null,
        w.note ? h('div', { class: 'tiny muted' }, w.note) : null),
      h('td', {}, h('span', { class: 'tag' + (w.votes > 0 ? ' blue' : '') }, `🙋 ${w.votes + 1} 人`),
        w.votes > 0 ? h('div', { class: 'tiny muted' }, `許願的人＋${w.votes} 人按 +1`) : null),
      h('td', { class: 'tiny muted' }, dt(w.wished_at)),
      h('td', {},
        h('span', { class: 'tag' + (w.wish_status === '已報價' ? ' blue' : w.wish_status === '待處理' ? ' amber' : '') }, w.wish_status),
        wall ? h('div', { style: 'margin-top:4px' }, h('span', { class: 'tag ' + wall[1] }, wall[0])) : null,
        w.broadcast_send_id ? h('div', { style: 'margin-top:4px' }, h('span', { class: 'tag green' }, `已開喊單 ${w.broadcast_send_id}`)) : null),
      h('td', {}, w.quote_twd ? nt(w.quote_twd) : '—'),
      h('td', {}, actions.length ? h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' }, ...actions) : null)));
  }
}

/**
 * 轉成喊單的小表單。規則跟「開喊單」一樣：填日幣照價目表、超過上限填台幣、
 * 還沒開團就要填這一趟叫什麼。錯誤留在表單上，不只閃一下。
 */
async function toBroadcast(w, ctx) {
  let info;
  try { info = await GET('/api/v1/broadcast/form-info'); } catch (e) { fail(e); return; }
  const f = {
    name: h('input', { type: 'text', value: w.item_name }),
    jpy: h('input', { type: 'number', min: '1', inputmode: 'numeric', placeholder: '日幣税込' }),
    twd: h('input', { type: 'number', min: '1', inputmode: 'numeric', placeholder: '留空＝照價目表',
      value: w.quote_twd ? String(Math.round(w.quote_twd)) : '' }),
    qty: h('input', { type: 'number', min: '1', inputmode: 'numeric', value: String(Math.max(w.votes + 1, 1)) }),
    deadline: h('input', { type: 'datetime-local' }),
    batchName: h('input', { type: 'text', maxlength: '40', placeholder: '例：11/20 大阪採買' }),
  };
  const errBox = h('div', { class: 'banner', role: 'alert', hidden: true, style: 'background:var(--red-bg);color:var(--red)' });
  for (const el of Object.values(f)) el.addEventListener('input', () => { errBox.hidden = true; });
  const field = (label, el) => h('label', { class: 'field' }, h('span', {}, label), el);
  const body = h('div', {},
    h('div', { class: 'small', style: 'margin-bottom:10px' },
      `想要的有 ${w.votes + 1} 個人（許願的人＋${w.votes} 人按 +1）。開好之後會自動 LINE 通知他們。`),
    h('div', { class: 'grid cols-2' },
      field('品名', f.name),
      field('日幣（税込）', f.jpy),
      field('台幣售價', f.twd),
      field('數量', f.qty),
      field('截止時間（選填）', f.deadline),
      info.batch ? null : field('還沒開團：這一趟叫什麼？', f.batchName)),
    h('div', { class: 'tiny muted', style: 'margin-top:6px' },
      info.batch ? `會開在目前的團：${info.batch.name}（${info.batch.batch}）` : '還沒開團，會一起開一團。',
      info.price_max_jpy ? `　價目表到 ¥${info.price_max_jpy.toLocaleString('ja-JP')}，超過請直接填台幣。` : ''),
    w.picture ? h('div', { class: 'tiny muted', style: 'margin-top:6px' }, '會沿用客人許願的照片。') : null,
    errBox);
  modal(`把「${w.item_name}」轉成喊單`, body, [
    { label: '取消', onClick: (close) => close() },
    { label: '開喊單並通知', primary: true, onClick: async (close) => {
      try {
        const r = await POST('/api/v1/wishes/to-broadcast', {
          wish_id: w.wish_id, name: f.name.value.trim(),
          jpy_taxed: f.jpy.value ? Number(f.jpy.value) : null,
          price_twd: f.twd.value ? Number(f.twd.value) : null,
          quantity: Number(f.qty.value),
          deadline_at: f.deadline.value ? new Date(f.deadline.value).toISOString() : null,
          batch_name: info.batch ? undefined : f.batchName.value.trim(),
        });
        close();
        toast(`已開喊單 ${r.broadcast.send_id}，LINE 通知 ${r.notified} 個人`);
        ctx.reload();
      } catch (e) {
        errBox.textContent = e.message || '開喊單失敗';
        errBox.hidden = false;
      }
    } },
  ]);
}
