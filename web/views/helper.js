import { GET, POST, h, nt, dt, toast, fail, modal, session } from '../app.js';
import { compressImage } from './shop.js';

/**
 * 小幫手工作台（v1.6 ⑤）。
 *
 *   我的採買 —— 只列我認領的品項，標出「買到了還沒拍收據」的；認領、回報結果還是在「現場採購看板」。
 *   請款     —— 一次選好幾張收據照片（或一張一張拍），每張填日幣金額，可以勾這張收據買了哪些東西、
 *               填單價（店主核准時才記成本）。送出後是一張請款單，等店主核准、付錢。
 *   請款審核 —— 店主才有：核准、退回（要寫原因）、已付款。
 */
const STATE = { claimed: ['採買中', 'blue'], got: ['買到了', 'green'], partial: ['買到一部分', 'amber'], out_of_stock: ['買不到', 'red'], open: ['還沒人認領', ''] };
const CLAIM_TONE = { pending: 'amber', approved: 'blue', paid: 'green', rejected: 'red' };

export async function render(root, ctx) {
  const tabs = ['我的採買', '請款', ...(session.can('payment.reconcile') ? ['請款審核'] : [])];
  const tab = tabs.includes(ctx.query.tab) ? ctx.query.tab : '我的採買';
  root.append(h('div', { class: 'row', style: 'gap:6px;margin-bottom:12px' }, ...tabs.map((t) =>
    h('a', { class: 'btn sm' + (t === tab ? ' primary' : ''), href: '#/helper?tab=' + encodeURIComponent(t) }, t))));
  if (tab === '請款') return renderClaims(root, ctx);
  if (tab === '請款審核') return renderReview(root, ctx);
  return renderMine(root);
}

async function renderMine(root) {
  const d = await GET('/api/v1/helper/my-list');
  const s = d.summary;
  const chip = (k, v, tone = '') => h('span', { class: 'tag ' + tone }, `${k} ${v}`);
  root.append(h('div', { class: 'card', style: 'padding:14px' },
    h('div', { class: 'small muted', style: 'margin-bottom:6px' }, d.batch ? `團別 ${d.batch}` : '還沒開團'),
    h('div', { class: 'chips' },
      chip('我認領', s.mine), chip('採買中', s.buying, 'blue'), chip('買到', s.got, 'green'),
      s.partial ? chip('一部分', s.partial, 'amber') : null, s.out_of_stock ? chip('買不到', s.out_of_stock, 'red') : null,
      s.need_receipt ? chip('要拍收據', s.need_receipt, 'peach') : null),
    h('div', { class: 'row', style: 'gap:8px;margin-top:10px;flex-wrap:wrap' },
      h('a', { class: 'btn sm', href: '#/board' }, `去看板認領（還有 ${s.open_to_claim} 項沒人認領）`),
      h('a', { class: 'btn sm primary', href: '#/helper?tab=' + encodeURIComponent('請款') }, '📷 批次拍收據請款')),
    s.unpaid_claims ? h('div', { class: 'banner info', style: 'margin:10px 0 0' }, `還有 ${s.unpaid_claims} 張請款單等店主付款，合計 ${nt(s.unpaid_claims_twd)}`) : null));

  const list = h('div', { class: 'card', style: 'padding:4px 14px' });
  if (!d.rows.length) list.append(h('div', { class: 'empty' }, '你還沒有認領任何品項，到「現場採購看板」按「我來買」。'));
  for (const r of d.rows) {
    const [label, tone] = STATE[r.state] || [r.state, ''];
    list.append(h('div', { class: 'hw-row' },
      r.image_url ? h('img', { class: 'thumb', src: r.image_url, alt: '' }) : h('div', { class: 'thumb' }),
      h('div', { class: 't' },
        h('div', {}, r.name_zh, r.brand ? h('span', { class: 'tiny muted' }, `　${r.brand}`) : null),
        h('div', { class: 'tiny muted' }, `要買 ${r.need_qty}${r.got_qty ? `・買到 ${r.got_qty}` : ''}${r.est_cost_jpy ? `・參考 ¥${Number(r.est_cost_jpy).toLocaleString('ja-JP')}` : ''}`)),
      h('div', { style: 'display:grid;gap:4px;justify-items:end' },
        h('span', { class: 'tag ' + tone }, label),
        r.need_receipt ? h('span', { class: 'tag peach' }, '要拍收據') : r.receipts ? h('span', { class: 'tiny muted' }, `收據 ${r.receipts} 張`) : null)));
  }
  root.append(list);
}

async function renderClaims(root, ctx) {
  const [mine, claims] = await Promise.all([GET('/api/v1/helper/my-list'), GET('/api/v1/helper/claims')]);
  const receipts = [];   // { receipt_id, image_url, amount, items: Map(proc_id → unit cost) , node }
  const listBox = h('div', { style: 'display:grid;gap:10px' });
  const errBox = h('div', { class: 'small', role: 'alert', style: 'color:var(--red)' });
  const totalBox = h('strong', {}, '¥0');
  const note = h('input', { type: 'text', placeholder: '備註（選填，例如：11/25 大阪藥妝）', maxlength: '200' });
  const refreshTotal = () => {
    const t = receipts.reduce((s, r) => s + (Number(r.amount.value) || 0), 0);
    totalBox.textContent = '¥' + t.toLocaleString('ja-JP');
  };

  const addReceipt = (up) => {
    const amount = h('input', { type: 'number', min: '1', inputmode: 'numeric', placeholder: '收據上的日幣總額', style: 'width:100%' });
    amount.addEventListener('input', refreshTotal);
    const items = new Map();
    const itemBox = h('div', { style: 'display:grid;gap:4px;margin-top:6px' }, ...mine.rows.map((r) => {
      const cost = h('input', { type: 'number', min: '1', inputmode: 'numeric', placeholder: '單價 ¥（選填）', style: 'width:110px', hidden: true });
      const cb = h('input', { type: 'checkbox' });
      cb.addEventListener('change', () => { cost.hidden = !cb.checked; if (cb.checked) items.set(r.proc_id, cost); else items.delete(r.proc_id); });
      return h('label', { class: 'row tiny', style: 'gap:6px;flex-wrap:nowrap' }, cb, h('span', { style: 'flex:1;min-width:0' }, r.name_zh), cost);
    }));
    const rec = { receipt_id: up.receipt_id, amount, items };
    const card = h('div', { class: 'rcp-card' },
      h('img', { src: up.image_url, alt: '收據' }),
      h('div', {},
        h('div', { class: 'row', style: 'gap:6px' }, h('strong', { class: 'small' }, `第 ${receipts.length + 1} 張`), h('span', { class: 'spacer', style: 'flex:1' }),
          h('button', { class: 'btn ghost sm', onClick: () => { receipts.splice(receipts.indexOf(rec), 1); card.remove(); refreshTotal(); } }, '✕')),
        amount,
        mine.rows.length ? h('details', {}, h('summary', { class: 'tiny muted' }, '這張收據買了哪些東西？（選填，填單價會記成本）'), itemBox) : null));
    receipts.push(rec);
    listBox.append(card);
  };

  const status = h('span', { class: 'tiny muted' });
  const pickPhotos = async (files) => {
    errBox.textContent = '';
    const arr = [...files];
    for (const [i, f] of arr.entries()) {
      if (receipts.length >= 20) { errBox.textContent = '一張請款單最多 20 張收據'; break; }
      status.textContent = `上傳中 ${i + 1}/${arr.length}…`;
      try {
        const data = await compressImage(f, 1600, 0.85);   // 收據字小，留大一點
        addReceipt(await POST('/api/v1/helper/receipts/upload', { data }));
      } catch (e) { errBox.textContent = e.message; }
    }
    status.textContent = '';
  };
  const album = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  const camera = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
  album.addEventListener('change', () => { pickPhotos(album.files); album.value = ''; });
  camera.addEventListener('change', () => { pickPhotos(camera.files); camera.value = ''; });

  const submit = async () => {
    errBox.textContent = '';
    if (!receipts.length) { errBox.textContent = '請先拍或選收據'; return; }
    const bad = receipts.findIndex((r) => !(Number(r.amount.value) > 0));
    if (bad >= 0) { errBox.textContent = `第 ${bad + 1} 張收據還沒填金額`; return; }
    try {
      const c = await POST('/api/v1/helper/claims/create', {
        note: note.value || null,
        receipts: receipts.map((r) => ({ receipt_id: r.receipt_id, amount_jpy: Number(r.amount.value),
          items: [...r.items.entries()].map(([proc_id, cost]) => ({ proc_id, unit_cost_jpy: cost.value ? Number(cost.value) : null })) })),
      });
      toast(`已送出請款單：${c.receipts.length} 張、${'¥' + c.total_jpy.toLocaleString('ja-JP')}（約 ${nt(c.total_twd)}）`);
      ctx.reload();
    } catch (e) { errBox.textContent = e.message; }
  };

  root.append(h('div', { class: 'card', style: 'padding:14px' },
    h('h2', { style: 'margin:0 0 6px' }, '批次拍收據請款'),
    h('div', { class: 'tiny muted', style: 'margin-bottom:10px' }, '可以一次選好幾張照片，或一張一張拍。每張填收據上的日幣總額，最後一起送出。'),
    h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' },
      h('label', { class: 'btn primary' }, '📷 拍收據', camera),
      h('label', { class: 'btn' }, '🖼 從相簿選（可多張）', album), status),
    h('div', { style: 'margin-top:12px' }, listBox),
    h('div', { style: 'margin-top:10px' }, note),
    h('div', { class: 'row', style: 'gap:8px;margin-top:10px' }, h('span', { class: 'small' }, '合計 '), totalBox,
      h('span', { class: 'spacer', style: 'flex:1' }), h('button', { class: 'btn primary', onClick: submit }, '送出請款')),
    errBox));

  root.append(h('div', { class: 'section-title' }, '我的請款單'));
  if (!claims.length) root.append(h('div', { class: 'card' }, h('div', { class: 'empty' }, '還沒有請款單')));
  root.append(h('div', { style: 'display:grid;gap:10px' }, ...claims.map((c) => claimCard(c))));
}

function claimCard(c, actions = null) {
  return h('div', { class: 'card', style: 'padding:14px' },
    h('div', { class: 'row', style: 'gap:6px' },
      h('strong', { class: 'mono small' }, c.claim_id), h('span', { class: 'tag ' + CLAIM_TONE[c.status] }, c.status_zh),
      c.nickname ? h('span', { class: 'small' }, c.nickname) : null,
      h('span', { class: 'spacer', style: 'flex:1' }),
      h('span', { class: 'small' }, '¥' + c.total_jpy.toLocaleString('ja-JP'), h('span', { class: 'tiny muted' }, ` ≈ ${nt(c.total_twd)}`))),
    h('div', { class: 'tiny muted', style: 'margin-top:4px' }, `${dt(c.created_at)}・${c.receipts.length} 張收據・匯率 ${c.fx_rate}`,
      c.note ? `・${c.note}` : '', c.decision_note ? `・店主：${c.decision_note}` : '', c.paid_at ? `・${dt(c.paid_at)} 付清` : ''),
    h('div', { class: 'rcp-thumbs' }, ...c.receipts.map((r) => h('img', {
      src: r.image_url, alt: `收據 ${r.seq}`, title: `¥${r.amount_jpy}`,
      onClick: () => modal(`收據 ${r.seq}：¥${Number(r.amount_jpy).toLocaleString('ja-JP')}`, h('div', {},
        h('img', { src: r.image_url, alt: '', style: 'width:100%;border-radius:12px' }),
        r.items.length ? h('div', { class: 'small', style: 'margin-top:8px' }, '買了：' + r.items.map((i) => i.name_zh + (i.unit_cost_jpy ? ` ¥${i.unit_cost_jpy}` : '')).join('、')) : null,
        r.note ? h('div', { class: 'tiny muted' }, r.note) : null)),
    }))),
    actions);
}

async function renderReview(root, ctx) {
  const rows = await GET('/api/v1/helper-claims/admin-list');
  if (!rows.length) { root.append(h('div', { class: 'card' }, h('div', { class: 'empty' }, '還沒有小幫手送請款單'))); return; }
  const decide = async (c, action, note = null) => {
    try {
      await POST('/api/v1/helper-claims/decide', { claim_id: c.claim_id, action, note });
      toast({ approve: '已核准（收據上的單價已記成本）', reject: '已退回，小幫手可以改好再送', paid: '已標成付清' }[action]);
      ctx.reload();
    } catch (e) { fail(e); }
  };
  const rejectDialog = (c) => {
    const note = h('input', { type: 'text', placeholder: '必填，例如：第 2 張金額看不清楚', maxlength: '200' });
    const errBox = h('div', { class: 'tiny', role: 'alert', style: 'color:var(--red)' });
    modal('退回請款單', h('div', {}, h('label', { class: 'field' }, h('span', {}, '原因'), note), errBox), [{
      label: '退回', primary: true,
      onClick: async (close) => { if (!note.value.trim()) { errBox.textContent = '請寫原因'; return; } close(); await decide(c, 'reject', note.value.trim()); },
    }]);
  };
  root.append(h('div', { style: 'display:grid;gap:10px' }, ...rows.map((c) => claimCard(c,
    ['pending', 'approved'].includes(c.status) ? h('div', { class: 'row', style: 'gap:8px;margin-top:10px;justify-content:flex-end' },
      c.status === 'pending' ? h('button', { class: 'btn', onClick: () => rejectDialog(c) }, '退回') : null,
      c.status === 'pending' ? h('button', { class: 'btn', onClick: () => decide(c, 'approve') }, '核准') : null,
      h('button', { class: 'btn primary', onClick: () => { if (confirm(`已經把 ${nt(c.total_twd)} 付給 ${c.nickname}？`)) decide(c, 'paid'); } }, '已付款')) : null))));
}
