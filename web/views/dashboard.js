import { GET, POST, h, nt, dt, pct, toast, fail, session, flower } from '../app.js';

/**
 * 營運總覽（2026-11-25 照周小姐影片 2）。
 *
 * 由上到下：歡迎卡（快捷按鈕）→ 小幫手批次請款卡（店主）→ 自動結算燈號（店主）→
 * 彩色數字格 → 優先確認 / ACTION REQUIRED → 今天要處理 → 營運數字（店主）。
 * 每一格、每一個 chip 都可以點，跳到已經篩選好的清單。
 * 驗收（11/19 沿用）：手機打開 3 秒內找到「開喊單」—— 歡迎卡第一顆黃色按鈕就是。
 */
export async function render(root, ctx) {
  const d = await GET('/api/v1/dashboard/summary' + (ctx.query.batch ? `?batch=${encodeURIComponent(ctx.query.batch)}` : ''));
  const ov = d.overview || { tiles: {}, action: {} };
  const home = h('div', { class: 'home' });
  root.append(home);

  // ---- 歡迎卡 ----
  const b = d.batch_info;
  const quick = [
    session.can('broadcast') ? h('a', { class: 'btn primary', href: '#/shop?new=1' }, '📷 開喊單（拍商品照）') : null,
    session.can('settings.write') ? h('a', { class: 'btn sm', href: '#/members' }, '產生小幫手邀請碼') : null,
    session.can('procurement.read') ? h('a', { class: 'btn sm', href: '#/board' }, '小幫手連線模式 ↗') : null,
    d.buyer_url ? h('a', { class: 'btn sm', href: d.buyer_url, target: '_blank', rel: 'noopener' }, '開啟客人頁 ↗') : null,
  ].filter(Boolean);
  home.append(h('div', { class: 'welcome' },
    h('div', { class: 'w-text' },
      h('div', { class: 'eyebrow' }, 'HEEEHABABY / BACK OFFICE'),
      h('div', { class: 'w-title' }, '今天，也把可愛好好送到。'),
      h('div', { class: 'small muted' }, b
        ? `本團 ${b.name || b.batch}${b.close_at ? `・${dt(b.close_at)} 截單` : ''}・開放中喊單 ${d.open_broadcasts} 張`
        : '還沒開團：直接按「開喊單」，系統會順便開一團。'),
      quick.length ? h('div', { class: 'row', style: 'margin-top:12px;gap:8px' }, ...quick) : null),
    h('div', { class: 'w-art', 'aria-hidden': 'true' }, flower(54))));

  // ---- 小幫手批次請款（店主）----
  if (ov.helper_claims) {
    const c = ov.helper_claims;
    home.append(h('a', { class: 'claim-card', href: '#/helper?tab=' + encodeURIComponent('請款審核') },
      h('div', {}, h('div', { class: 'cc-title' }, '小幫手批次請款'),
        h('div', { class: 'tiny muted' }, `待核對 ${c.pending} 批・待付款 ${c.to_pay} 批`)),
      h('span', { class: 'btn primary sm' }, '核對請款 →')));
  }

  // ---- 自動結算燈號（店主）----
  const a = d.auto_statement;
  if (a) {
    const dot = { green: '🟢', red: '🔴', grey: '⚪' }[a.light];
    const md = (ymd) => (ymd ? `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}` : '—');
    home.append(h('a', { class: 'auto-light ' + a.light, href: '#/statements' },
      h('span', {}, `${dot} 自動結算`), h('span', { class: 'tiny' }, a.light === 'red' ? a.say : (a.next_date ? `下次結算 ${md(a.next_date)}` : a.say)),
      h('span', { class: 'arrow', 'aria-hidden': 'true' }, '›')));
  }

  // ---- 彩色數字格 ----
  const t = ov.tiles || {};
  const TILES = [
    { k: '待採買喊單', x: t.to_buy, tone: 'yellow', sub: '照片、備註與採購線', cap: 'order.read' },
    { k: '許願池人氣', x: t.wish_votes, tone: 'blue', sub: '查看大家的 ＋1', cap: 'order.read' },
    { k: '待核對出貨', x: t.to_ship, tone: 'green', sub: '照片、拆單與出貨', cap: 'order.read' },
    { k: '付款與發票資料', x: t.payment_info, tone: 'purple', sub: '客人回報匯款，等你核對', cap: 'payment.reconcile' },
    { k: '進行中訂單', x: t.active_orders, sub: '這一團還沒送達的單', cap: 'order.read' },
    { k: '待收款金額', x: { n: nt(d.unpaid_twd), link: '#/orders?unpaid=1' + (d.batch ? `&batch=${encodeURIComponent(d.batch)}` : '') }, sub: '這一團還沒付款', cap: 'order.read.price', money: true },
    { k: '七日內預計到貨', x: t.arriving_7d, sub: '運送中＋即將回台', cap: 'order.read' },
    { k: '待處理問題', x: t.open_issues, sub: '缺貨、部分買到、通知失敗', cap: 'order.read' },
  ].filter((x) => x.x && session.can(x.cap));
  home.append(h('div', { class: 'tiles' }, ...TILES.map((x) =>
    h('a', { href: x.x.link, class: 'tile ' + (x.tone || 'plain') + (!x.money && !Number(x.x.n) ? ' zero' : '') },
      h('div', { class: 'tk' }, x.k),
      h('div', { class: 'tn' + (x.money ? ' money' : '') }, String(x.x.n ?? 0)),
      h('div', { class: 'ts' }, x.sub, ' →')))));

  // ---- 優先確認 / ACTION REQUIRED ----
  const ac = ov.action || {};
  const CHIPS = [
    { k: '待確認', x: ac.pending }, { k: '逾期付款', x: ac.overdue, cap: 'payment.reconcile' },
    { k: '即將到貨', x: ac.arriving }, { k: '缺貨與延遲', x: ac.delayed },
  ].filter((c) => c.x && (!c.cap || session.can(c.cap)));
  const anyAction = CHIPS.some((c) => Number(c.x.n));
  home.append(h('div', { class: 'card action' },
    h('div', { class: 'card-head' }, h('h2', {}, '優先確認 ', h('span', { class: 'eyebrow' }, '/ ACTION REQUIRED')),
      h('div', { class: 'spacer' }), h('a', { class: 'tiny', href: '#/orders' }, '所有訂單 →')),
    h('div', { class: 'card-body' },
      h('div', { class: 'chips' }, ...CHIPS.map((c) =>
        h('a', { class: 'chip' + (Number(c.x.n) ? ' hot' : ''), href: c.x.link }, `${c.k} `, h('b', {}, String(c.x.n))))),
      anyAction ? null : h('div', { class: 'empty-soft' }, flower(28),
        h('div', {}, h('b', {}, '目前沒有需要優先確認的訂單'),
          h('div', { class: 'tiny muted' }, '新訂單進來、付款逾期或貨快到了，會出現在這裡。'))))));

  // ---- 今天要處理 ----
  home.append(h('div', { class: 'section-title' }, '今天要處理'));
  const list = h('div', { style: 'display:grid;gap:8px' });
  if (!d.todo.length) list.append(h('div', { class: 'card card-body muted small' }, '目前沒有要處理的事 🎉'));
  const KIND = {
    out_of_stock: ['缺貨', 'red'], partial: ['部分', 'amber'], unpaid: ['待收款', 'amber'], to_ship: ['待出貨', 'blue'],
    uncosted: ['成本', ''], wall: ['許願牆', 'peach'], wish: ['許願', 'peach'], notify_failed: ['通知', 'red'],
    ship_request: ['出貨申請', 'blue'], helper_claim: ['請款', 'amber'], auto_statement: ['結算', 'red'],
  };
  for (const item of d.todo) {
    const [label, tone] = KIND[item.kind] || ['待辦', ''];
    list.append(h('div', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' },
      h('a', { class: 'todo-item', href: item.link, style: 'flex:1' },
        h('span', { class: 'tag ' + tone }, label),
        h('div', { class: 't' }, h('div', {}, item.title), item.body ? h('div', { class: 'tiny muted' }, item.body) : null),
        h('span', { class: 'arrow', 'aria-hidden': 'true' }, '›')),
      item.notif_id ? h('button', {
        class: 'btn ghost sm', title: '標示已讀',
        onClick: async () => { try { await POST('/api/v1/notifications/read', { notif_id: item.notif_id }); toast('已標示處理過'); ctx.reload(); } catch (e) { fail(e); } },
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
