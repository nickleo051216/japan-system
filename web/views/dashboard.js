import { GET, POST, h, nt, pct, toast, fail, session } from '/app.js';

export async function render(root, ctx) {
  const d = await GET('/api/v1/dashboard/summary' + (ctx.query.batch ? `?batch=${ctx.query.batch}` : ''));
  const showCost = session.can('order.read.cost');

  const stat = (k, v, sub) => h('div', { class: 'card stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), sub ? h('div', { class: 'sub' }, sub) : null);

  root.append(h('div', { class: 'row', style: 'margin-bottom:14px' },
    h('span', { class: 'tag blue' }, `本團 ${d.batch}`),
    h('span', { class: 'tag' }, `匯率 1 JPY = ${d.fx_rate} TWD`),
    h('span', { class: 'muted small' }, `${d.order_count} 張有效訂單`)));

  const stats = h('div', { class: 'grid cols-4' });
  if (session.can('order.read.price')) {
    stats.append(stat('本團營收', nt(d.revenue_twd), `未收款 ${nt(d.unpaid_twd)}`));
  }
  if (showCost) {
    stats.append(stat('已登錄成本', nt(d.cost_registered_twd), `對應營收 ${nt(d.margin_basis_revenue_twd)}`));
    stats.append(stat('已知毛利', nt(d.gross_profit_twd), `毛利率 ${pct(d.margin_pct)}`));
  }
  stats.append(stat('待採購件數', d.pending_procurement_pieces, '尚未買齊的件數'));
  stats.append(stat('待出貨筆數', d.pending_shipment_count, '可列印標籤後掃碼'));
  root.append(stats);

  // F-22 毛利呈現規則：未登錄成本的營收必須明確標示，不得用預估成本充數。
  if (showCost && d.uncosted_revenue_twd > 0) {
    root.append(h('div', { class: 'banner warn', style: 'margin-top:16px' },
      `尚未登錄成本 ${nt(d.uncosted_revenue_twd)}　—　這部分營收未計入上方毛利，毛利率僅代表已登錄成本的品項。`));
  }

  const todoCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, '今日待辦'), h('div', { class: 'spacer' }),
      h('span', { class: 'muted tiny' }, '依急迫度排序')));
  const body = h('div', { class: 'card-body', style: 'display:grid;gap:9px' });
  if (!d.todo.length) body.append(h('div', { class: 'muted small' }, '目前沒有待辦事項。'));
  for (const t of d.todo) {
    const tone = t.kind === 'out_of_stock' ? 'red' : t.kind === 'partial' ? 'amber' : t.kind === 'unpaid' ? 'amber' : 'blue';
    body.append(h('div', { class: 'row', style: 'border:1px solid var(--line);border-radius:10px;padding:10px 12px' },
      h('span', { class: 'tag ' + tone }, { out_of_stock: '缺貨', partial: '部分', unpaid: '待收款', to_ship: '待出貨', uncosted: '成本' }[t.kind] || '待辦'),
      h('div', { style: 'flex:1;min-width:180px' }, h('div', {}, t.title), t.body ? h('div', { class: 'tiny muted' }, t.body) : null),
      h('a', { class: 'btn sm', href: t.link }, '前往處理'),
      t.notif_id ? h('button', {
        class: 'btn ghost sm',
        onClick: async () => { try { await POST('/api/v1/notifications/read', { notif_id: t.notif_id }); toast('已標示處理過'); ctx.reload(); } catch (e) { fail(e); } },
      }, '標示已讀') : null));
  }
  todoCard.append(body);
  root.append(todoCard);

  if (showCost) {
    const table = h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, '商品'), h('th', {}, '件數'), h('th', {}, '營收'), h('th', {}, '成本'), h('th', {}, '毛利'), h('th', {}, '毛利率'))),
      h('tbody', {}, ...(d.ranking.length ? d.ranking.map((r) => h('tr', {},
        h('td', {}, r.name_zh, h('div', { class: 'tiny muted mono' }, r.sku)),
        h('td', {}, r.qty),
        h('td', {}, nt(r.revenue_twd)),
        h('td', {}, nt(r.cost_twd)),
        h('td', {}, nt(r.gross_profit_twd)),
        h('td', {}, h('span', { class: 'tag ' + (r.margin_pct >= 30 ? 'green' : r.margin_pct >= 20 ? '' : 'red') }, pct(r.margin_pct))))) 
        : [h('tr', {}, h('td', { colspan: '6', class: 'muted small' }, '尚無已登錄成本的品項。'))])));
    root.append(h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, '毛利排行'), h('div', { class: 'spacer' }), h('span', { class: 'muted tiny' }, '僅列入已登錄實際成本者')),
      h('div', { class: 'table-wrap' }, table)));
  }
}
