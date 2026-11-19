import { GET, POST, h, nt, dt, pct, toast, fail, session } from '../app.js';

/**
 * 首頁（大按鈕版，2026-11-19 周小姐的回饋）。
 *
 * 由上到下：本團摘要卡 → 6 個快捷操作 → 訂單狀態數字格 → 今天要處理。
 * 驗收：手機打開 3 秒內找到「開喊單」，按 2 下就能拍商品照
 * （首頁「開喊單」→ 喊單頁最上面的「📷 拍商品照」）。
 * 金流設定、成員與權限這類店主才用的頁面不放首頁，在底部「更多」裡。
 * 營收、毛利這些數字留在最下面「營運數字」，給店主看。
 */
export async function render(root, ctx) {
  const d = await GET('/api/v1/dashboard/summary' + (ctx.query.batch ? `?batch=${encodeURIComponent(ctx.query.batch)}` : ''));
  const home = h('div', { class: 'home' });
  root.append(home);

  // ---- 本團摘要卡 ----
  const b = d.batch_info;
  const fact = (k, v) => h('span', {}, k, ' ', h('b', {}, v));
  home.append(h('div', { class: 'trip' },
    h('div', { class: 'trip-label' }, b ? `本團　${b.batch}` : '本團'),
    h('div', { class: 'name' }, b ? (b.name || b.batch) : '還沒開團'),
    b
      ? h('div', { class: 'facts' },
        b.close_at ? fact('截單', dt(b.close_at)) : null,
        fact('開放中喊單', `${d.open_broadcasts} 張`),
        fact('有效訂單', `${d.order_count} 張`),
        session.can('order.read.price') ? fact('未收款', nt(d.unpaid_twd)) : null)
      : h('div', { class: 'facts' }, '直接按「開喊單」，系統會順便開一團。')));

  // ---- 快捷操作 ----
  const QUICK = [
    { href: '#/shop?new=1', cap: 'broadcast', ico: '📷', name: '開喊單', sub: '可直接拍商品照', main: true },
    { href: '#/wishes', cap: 'order.read', ico: '♡', tone: 'q-peach', name: '許願報價',
      sub: d.wishes_to_quote ? `${d.wishes_to_quote} 則等報價` : '客人想要的東西' },
    { href: '#/statements', cap: 'payment.reconcile', ico: '💰', tone: 'q-green', name: '對帳單', sub: '核對收款' },
    { href: '#/packing', cap: 'shipment.write', ico: '📦', tone: 'q-lilac', name: '看圖理貨', sub: '對照片裝箱' },
    { href: '#/expense', cap: 'procurement.write', ico: '🧾', tone: 'q-yellow', name: '拍收據記帳', sub: '記下買了多少錢' },
    { href: '#/settings', cap: 'order.read', ico: '⚙', tone: 'q-soft', name: '開團・價目表', sub: '匯率、價目表、團別' },
  ].filter((q) => session.can(q.cap));
  if (QUICK.length) {
    home.append(h('div', { class: 'section-title' }, '快捷操作'));
    home.append(h('div', { class: 'quick' }, ...QUICK.map((q) =>
      h('a', { href: q.href, class: q.main ? 'main' : '' },
        h('span', { class: 'q-ico ' + (q.tone || ''), 'aria-hidden': 'true' }, q.ico),
        h('span', {}, h('span', { class: 'q-name' }, q.name), h('span', { class: 'q-sub' }, q.sub))))));
  }

  // ---- 訂單狀態 ----
  // 點了跳到「訂單管理」的同一個篩選，數字跟清單一樣只算這一團。
  const c = d.status_counts || {};
  const inBatch = d.batch ? `&batch=${encodeURIComponent(d.batch)}` : '';
  const STATUS = [
    { k: '待收款', n: c.unpaid, q: 'unpaid=1', hot: true },
    { k: '待採購', n: c.to_buy, q: 'status=' + encodeURIComponent('待確認,已報價') },
    { k: '已到貨待出貨', n: c.to_ship, q: 'status=' + encodeURIComponent('已到貨'), hot: true },
    { k: '運送中', n: c.shipping, q: 'status=' + encodeURIComponent('已出貨') },
    { k: '已完成', n: c.done, q: 'status=' + encodeURIComponent('已送達') },
    { k: '缺貨・取消', n: c.failed, q: 'status=' + encodeURIComponent('缺貨,已取消') },
  ];
  home.append(h('div', { class: 'section-title' }, '訂單狀態'));
  home.append(h('div', { class: 'statuses' }, ...STATUS.map((x) =>
    h('a', { href: `#/orders?${x.q}${inBatch}`, class: (x.n ? (x.hot ? 'hot' : '') : 'zero') },
      h('div', { class: 'n' }, String(x.n || 0)), h('div', { class: 'k' }, x.k)))));

  // ---- 今天要處理 ----
  home.append(h('div', { class: 'section-title' }, '今天要處理'));
  const list = h('div', { style: 'display:grid;gap:8px' });
  if (!d.todo.length) list.append(h('div', { class: 'card card-body muted small' }, '目前沒有要處理的事 🎉'));
  const KIND = {
    out_of_stock: ['缺貨', 'red'], partial: ['部分', 'amber'], unpaid: ['待收款', 'amber'], to_ship: ['待出貨', 'blue'],
    uncosted: ['成本', ''], wall: ['許願牆', 'peach'], wish: ['許願', 'peach'], notify_failed: ['通知', 'red'],
  };
  for (const t of d.todo) {
    const [label, tone] = KIND[t.kind] || ['待辦', ''];
    list.append(h('div', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' },
      h('a', { class: 'todo-item', href: t.link, style: 'flex:1' },
        h('span', { class: 'tag ' + tone }, label),
        h('div', { class: 't' }, h('div', {}, t.title), t.body ? h('div', { class: 'tiny muted' }, t.body) : null),
        h('span', { class: 'arrow', 'aria-hidden': 'true' }, '›')),
      t.notif_id ? h('button', {
        class: 'btn ghost sm', title: '標示已讀',
        onClick: async () => { try { await POST('/api/v1/notifications/read', { notif_id: t.notif_id }); toast('已標示處理過'); ctx.reload(); } catch (e) { fail(e); } },
      }, '已讀') : null));
  }
  home.append(list);

  // ---- 營運數字（店主）----
  const showCost = session.can('order.read.cost');
  if (!session.can('order.read.price') && !showCost) return;
  const stat = (k, v, sub) => h('div', { class: 'card stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), sub ? h('div', { class: 'sub' }, sub) : null);
  const stats = h('div', { class: 'grid cols-4' });
  if (session.can('order.read.price')) stats.append(stat('本團營收', nt(d.revenue_twd), `未收款 ${nt(d.unpaid_twd)}`));
  if (showCost) {
    stats.append(stat('已登錄成本', nt(d.cost_registered_twd), `對應營收 ${nt(d.margin_basis_revenue_twd)}`));
    stats.append(stat('已知毛利', nt(d.gross_profit_twd), `毛利率 ${pct(d.margin_pct)}`));
  }
  stats.append(stat('待採購件數', d.pending_procurement_pieces, `匯率 1 JPY = ${d.fx_rate} TWD`));
  home.append(h('div', { class: 'section-title' }, '營運數字'));
  home.append(stats);
  // F-22 毛利呈現規則：未登錄成本的營收必須明確標示，不得用預估成本充數。
  if (showCost && d.uncosted_revenue_twd > 0) {
    home.append(h('div', { class: 'banner warn', style: 'margin:0' },
      `尚未登錄成本 ${nt(d.uncosted_revenue_twd)}　—　這部分營收未計入上方毛利，毛利率僅代表已登錄成本的品項。`));
  }
  if (showCost && d.ranking.length) {
    const table = h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, '商品'), h('th', {}, '件數'), h('th', {}, '營收'), h('th', {}, '成本'), h('th', {}, '毛利'), h('th', {}, '毛利率'))),
      h('tbody', {}, ...d.ranking.map((r) => h('tr', {},
        h('td', {}, r.name_zh, h('div', { class: 'tiny muted mono' }, r.sku)),
        h('td', {}, r.qty),
        h('td', {}, nt(r.revenue_twd)),
        h('td', {}, nt(r.cost_twd)),
        h('td', {}, nt(r.gross_profit_twd)),
        h('td', {}, h('span', { class: 'tag ' + (r.margin_pct >= 30 ? 'green' : r.margin_pct >= 20 ? '' : 'red') }, pct(r.margin_pct)))))));
    home.append(h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, '毛利排行'), h('div', { class: 'spacer' }), h('span', { class: 'muted tiny' }, '僅列入已登錄實際成本者')),
      h('div', { class: 'table-wrap' }, table)));
  }
}
