import { GET, POST, h, nt, jpy, pct, toast, fail, modal, session } from '../app.js';

/**
 * 連線採買清單（2026-11-25 照周小姐影片 3；原「現場採購看板」）。
 *
 * 上面 3 個數字（還要買幾件、已經買到幾件、缺貨／部分），篩選 chips、搜尋，
 * 底下一張商品一張大照片卡：黃色「✓ 已購買」一按就記成買足；「缺貨」記成 0 件並通知店主。
 * 認領規則不變：別人認領中的品項，只會看到「🔒 誰認領中」，不能替他按。
 */
const STATE = {
  open: ['', '待採買'], claimed: ['blue', '採買中'], got: ['green', '已購買'],
  partial: ['amber', '買到一部分'], out_of_stock: ['red', '缺貨'],
};
const FILTERS = [
  { key: 'all', label: '全部', test: () => true },
  { key: 'todo', label: '待採買', test: (r) => r.state === 'open' || r.state === 'claimed' },
  { key: 'mine', label: '我認領的', test: (r) => r.claimed_by_me },
  { key: 'got', label: '已購買', test: (r) => r.state === 'got' },
  { key: 'issue', label: '缺貨・部分', test: (r) => r.state === 'out_of_stock' || r.state === 'partial' },
];

export async function render(root, ctx) {
  const showCost = session.can('order.read.cost');
  const isOwner = session.member.role === 'owner';
  let filter = FILTERS.some((f) => f.key === ctx.query.f) ? ctx.query.f : 'all';
  let line = '';   // 採購線（商品資料庫填的）：'' = 全部、'__none' = 待分類
  let q = '';
  const wrap = h('div', {});
  root.append(wrap);
  let rows = [];
  let batch = '';

  async function load() {
    const d = await GET('/api/v1/procurement/board' + (ctx.query.batch ? `?batch=${encodeURIComponent(ctx.query.batch)}` : ''));
    rows = d.rows; batch = d.batch;
    draw();
  }

  function draw() {
    wrap.innerHTML = '';
    const left = rows.filter((r) => ['open', 'claimed'].includes(r.state)).reduce((s, r) => s + (r.need_qty - (r.got_qty || 0)), 0);
    const got = rows.reduce((s, r) => s + (['got', 'partial'].includes(r.state) ? (r.got_qty || 0) : 0), 0);
    const issues = rows.filter((r) => ['partial', 'out_of_stock'].includes(r.state)).length;
    wrap.append(h('div', { class: 'lc-stats' },
      h('div', {}, h('b', {}, String(left)), h('span', {}, '還要買的件數')),
      h('div', {}, h('b', {}, String(got)), h('span', {}, '已經買到')),
      h('div', {}, h('b', {}, String(issues)), h('span', {}, '缺貨・部分'))));

    const search = h('input', { type: 'search', placeholder: '搜尋商品、品牌、下單的客人…', value: q });
    search.addEventListener('input', () => { q = search.value.trim(); drawList(); });
    wrap.append(h('div', { class: 'lc-tools' },
      h('div', { class: 'chips' }, ...FILTERS.map((f) => h('button', {
        type: 'button', class: 'chip' + (f.key === filter ? ' on' : ''), onClick: () => { filter = f.key; draw(); },
      }, f.label, ' ', h('b', {}, String(rows.filter(f.test).length))))),
      search,
      h('button', { class: 'btn sm', type: 'button', onClick: () => load().catch(fail) }, '↻ 更新清單')));
    // 採購線（日本線／韓國線…）：商品資料庫有填才會出現；沒填的算「待分類」。
    const lines = [...new Set(rows.map((r) => r.line).filter(Boolean))].sort();
    if (lines.length) {
      wrap.append(h('div', { class: 'chips', style: 'margin:-4px 0 12px' }, ...[['', '全部採購線'], ['__none', '待分類'], ...lines.map((l) => [l, l])].map(([k, label]) =>
        h('button', { type: 'button', class: 'chip' + (line === k ? ' on' : ''), onClick: () => { line = k; draw(); } }, label))));
    }
    const list = h('div', { class: 'lc-grid' });
    wrap.append(list);
    const drawList = () => {
      list.innerHTML = '';
      const f = FILTERS.find((x) => x.key === filter);
      const kw = q.toLowerCase();
      const shown = rows.filter(f.test).filter((r) => !line || (line === '__none' ? !r.line : r.line === line)).filter((r) => !kw || [r.name_zh, r.name_local, r.brand, r.sku, ...r.buyers.map((b) => b.nickname)]
        .some((v) => String(v || '').toLowerCase().includes(kw)));
      if (!shown.length) list.append(h('div', { class: 'card', style: 'grid-column:1/-1' }, h('div', { class: 'empty' },
        rows.length ? '沒有符合的商品' : `${batch ? `團別 ${batch}` : '本團'}目前沒有要採買的商品`)));
      for (const r of shown) list.append(card(r));
    };
    drawList();
  }

  function card(r) {
    const [tone, label] = STATE[r.state] || ['', r.state];
    const mine = r.claimed_by_me;
    const lockedByOther = r.state === 'claimed' && !mine && !isOwner;
    const acts = h('div', { class: 'lc-acts' });
    if (['open', 'claimed'].includes(r.state) && !lockedByOther) {
      acts.append(
        h('button', { class: 'btn primary', type: 'button', onClick: () => report(r, r.need_qty) }, '✓ 已購買'),
        h('button', { class: 'btn', type: 'button', onClick: () => {
          if (confirm(`「${r.name_zh}」記成缺貨？會通知店主決定補買、改品或退款。`)) report(r, 0);
        } }, '缺貨'));
    } else if (lockedByOther) {
      acts.append(h('span', { class: 'tag' }, `🔒 ${r.claimed_by_nickname || '他人'} 認領中`));
    } else {
      if (['got', 'partial'].includes(r.state)) acts.append(h('a', { class: 'btn sm', href: '#/helper?tab=' + encodeURIComponent('請款') }, '拍收據請款'));
      if (mine || isOwner) acts.append(h('button', { class: 'btn ghost sm', type: 'button', onClick: () => resultDialog(r) }, '修改'));
    }
    const more = h('div', { class: 'row tiny', style: 'gap:10px' });
    if (r.state === 'open') more.append(h('button', { class: 'btn ghost sm', type: 'button', onClick: async () => {
      try { await POST('/api/v1/procurement/claim', { proc_id: r.proc_id }); toast('已認領，其他小幫手不會重複買'); load(); } catch (e) { fail(e); load(); }
    } }, '先認領'));
    if (['open', 'claimed'].includes(r.state) && !lockedByOther) more.append(h('button', { class: 'btn ghost sm', type: 'button', onClick: () => resultDialog(r) }, '只買到一部分'));
    if (r.state === 'claimed' && mine) more.append(h('button', { class: 'btn ghost sm', type: 'button', onClick: async () => {
      try { await POST('/api/v1/procurement/release', { proc_id: r.proc_id }); toast('已放掉'); load(); } catch (e) { fail(e); }
    } }, '放掉'));

    return h('div', { class: 'lc-card' },
      h('div', { class: 'lc-photo' },
        r.image_url ? h('img', { src: r.image_url, alt: r.name_zh, loading: 'lazy' }) : null,
        h('span', { class: 'lc-no mono' }, r.sku),
        h('span', { class: 'tag ' + tone }, label)),
      h('div', { class: 'lc-body' },
        h('div', { class: 'lc-name' }, r.name_zh, r.brand ? h('span', { class: 'tiny muted' }, `　${r.brand}`) : null),
        h('div', { class: 'tiny muted' }, `要買 ${r.need_qty} 件${r.got_qty ? `・買到 ${r.got_qty}` : ''}`,
          'price_twd' in r ? `・售價 ${nt(r.price_twd)}` : '', 'est_cost_jpy' in r && r.est_cost_jpy ? `・參考 ${jpy(r.est_cost_jpy)}` : ''),
        h('div', { class: 'tiny' }, '下單：' + (r.buyers.length ? r.buyers.map((b) => `${b.nickname}×${b.qty}`).join('、') : '—')),
        showCost && r.unit_cost_twd != null ? h('div', { class: 'tiny' }, `實付 ${jpy(r.unit_cost_jpy)} → 成本 ${nt(r.unit_cost_twd)}　`,
          h('span', { class: 'tag ' + (r.margin_pct >= 20 ? 'green' : 'red') }, `毛利 ${pct(r.margin_pct)}`)) : null,
        acts, more.children.length ? more : null));
  }

  async function report(r, qty) {
    try {
      const res = await POST('/api/v1/procurement/result', { proc_id: r.proc_id, got_qty: qty });
      toast({ got: `已購買：${r.name_zh}`, partial: '已記為部分買到，已通知店主', out_of_stock: '已記為缺貨，已通知店主' }[res.state]);
      load();
    } catch (e) { fail(e); load(); }
  }

  function resultDialog(r) {
    const qty = h('input', { type: 'number', min: '0', inputmode: 'numeric', value: String(r.got_qty ?? r.need_qty) });
    modal('實際買到幾件？', h('div', {},
      h('p', { class: 'small muted', style: 'margin-top:0' }, `${r.name_zh}　要買 ${r.need_qty} 件。填 0 是缺貨；少於需求會通知店主決定補買、改品或退款。`),
      h('label', { class: 'field' }, h('span', {}, '實際買到件數'), qty)), [{
      label: '送出', primary: true,
      onClick: async (close) => { close(); await report(r, Number(qty.value)); },
    }]);
  }

  await load();
}
