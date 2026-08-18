import { GET, POST, h, nt, dt, statusTag, toast, fail, modal, session } from '/app.js';

const STATUSES = ['待付款', '待採購', '部分到貨', '待出貨', '已出貨', '已完成', '待退款', '已退款', '已取消'];

export async function render(root, ctx) {
  const state = { status: ctx.query.status || '', q: '' };

  const filters = h('div', { class: 'card-head' },
    h('h2', {}, '訂單'),
    h('div', { class: 'spacer' }),
    h('select', { style: 'width:150px', onChange: (e) => { state.status = e.target.value; load(); } },
      h('option', { value: '' }, '全部狀態'),
      ...STATUSES.map((s) => h('option', { value: s, selected: s === state.status }, s))),
    h('input', { type: 'search', placeholder: '訂單編號 / 暱稱', style: 'width:200px', onInput: (e) => { state.q = e.target.value; clearTimeout(state.t); state.t = setTimeout(load, 250); } }),
    session.can('payment.reconcile') ? h('button', { class: 'btn', onClick: reconcileDialog }, '付款對帳') : null);

  const tbody = h('tbody', {});
  const card = h('div', { class: 'card' }, filters,
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, '訂單'), h('th', {}, '客人'), h('th', {}, '狀態'),
        session.can('order.read.price') ? h('th', {}, '金額') : null,
        h('th', {}, '付款'), h('th', {}, '品項'), h('th', {}, '建立'), h('th', {}))),
      tbody)));
  root.append(card);

  async function load() {
    const qs = new URLSearchParams();
    if (state.status) qs.set('status', state.status);
    if (state.q) qs.set('q', state.q);
    const orders = await GET('/api/v1/orders/list?' + qs);
    tbody.innerHTML = '';
    if (!orders.length) { tbody.append(h('tr', {}, h('td', { colspan: '8', class: 'empty' }, '沒有符合的訂單'))); return; }
    for (const o of orders) {
      tbody.append(h('tr', {},
        h('td', {}, h('span', { class: 'mono' }, o.order_id), o.parent_order_id ? h('div', { class: 'tiny muted' }, `拆自 ${o.parent_order_id}`) : null),
        h('td', {}, o.nickname),
        h('td', {}, statusTag(o.status)),
        session.can('order.read.price') ? h('td', {}, nt(o.total_twd)) : null,
        h('td', {}, o.paid ? h('span', { class: 'tag green' }, '已付') : h('span', { class: 'tag amber' }, '未付')),
        h('td', { class: 'small' }, o.items.map((i) => `${i.name_zh}×${i.qty}`).join('、') || '—'),
        h('td', { class: 'tiny muted' }, dt(o.created_at)),
        h('td', {}, h('button', { class: 'btn sm', onClick: () => detail(o.order_id) }, '明細'))));
    }
  }

  async function detail(orderId) {
    const o = await GET('/api/v1/orders/detail?order_id=' + encodeURIComponent(orderId));
    const body = h('div', {});
    body.append(h('div', { class: 'row', style: 'margin-bottom:12px' },
      statusTag(o.status),
      o.paid ? h('span', { class: 'tag green' }, '已付款') : h('span', { class: 'tag amber' }, '未付款'),
      session.can('order.read.price') ? h('span', { class: 'tag' }, nt(o.total_twd)) : null,
      h('span', { class: 'muted small' }, `${o.nickname}　${dt(o.created_at)}`)));

    body.append(h('table', {}, h('tbody', {}, ...o.items.map((i) => h('tr', {},
      h('td', { style: 'width:60px' }, h('img', { class: 'thumb', src: i.source_image_url || i.image_url, alt: i.name_zh })),
      h('td', {}, i.name_zh, h('div', { class: 'tiny muted' }, `${i.sku}　${i.name_local || ''}`)),
      h('td', {}, `×${i.qty}`),
      session.can('order.read.price') ? h('td', {}, nt(i.unit_price_twd * i.qty)) : null)))));

    if (!o.coverage.complete && o.coverage.total) {
      body.append(h('div', { class: 'banner warn', style: 'margin-top:12px' }, `尚有品項未採購完成：${o.coverage.missing.join('、')}`));
    }
    if (o.children.length) {
      body.append(h('div', { class: 'small', style: 'margin-top:12px' }, '子單：',
        ...o.children.map((c) => h('span', { class: 'tag', style: 'margin-right:6px' }, `${c.order_id}｜${c.status}`))));
    }
    body.append(h('div', { class: 'small muted', style: 'margin-top:14px' }, '狀態紀錄'));
    body.append(h('table', {}, h('tbody', {}, ...o.status_log.map((l) => h('tr', {},
      h('td', { class: 'tiny muted' }, dt(l.ts)),
      h('td', { class: 'tiny' }, `${l.from_status || '—'} → ${l.to_status}`),
      h('td', { class: 'tiny muted' }, l.reason || ''))))));

    const actions = [];
    if (session.can('order.write') && session.member.role === 'owner' && ['待採購', '部分到貨'].includes(o.status)) {
      actions.push({ label: '拆單', onClick: (close) => { close(); splitDialog(o); } });
    }
    if (session.can('shipment.write') && o.status === '待出貨') {
      actions.push({ label: '手動出貨（未經掃碼）', onClick: (close) => { close(); shipDialog(o); } });
    }
    modal(`訂單 ${o.order_id}`, body, actions);
  }

  function splitDialog(o) {
    const picks = new Map();
    const body = h('div', {},
      h('p', { class: 'small muted', style: 'margin-top:0' }, '選擇要拆到子單的品項與數量。拆分後兩單金額合計必須等於原金額，否則整筆回滾。'),
      h('table', {}, h('tbody', {}, ...o.items.map((i) => h('tr', {},
        h('td', {}, i.name_zh, h('div', { class: 'tiny muted mono' }, i.sku)),
        h('td', { class: 'tiny muted' }, `原 ${i.qty} 件`),
        h('td', { style: 'width:110px' }, h('input', {
          type: 'number', min: '0', max: String(i.qty), value: '0',
          onInput: (e) => picks.set(i.item_id, Number(e.target.value)),
        })))))));
    modal(`拆單 ${o.order_id}`, body, [{
      label: '確認拆單', primary: true,
      onClick: async (close) => {
        const items = [...picks.entries()].filter(([, q]) => q > 0).map(([item_id, qty]) => ({ item_id, qty }));
        if (!items.length) return toast('請至少選擇一項', 'err');
        const r = await POST('/api/v1/orders/split', { order_id: o.order_id, items });
        close();
        toast(`已拆出 ${r.child_order_id}（母單 ${nt(r.parent_total_twd)}／子單 ${nt(r.child_total_twd)}）`);
        load();
      },
    }]);
  }

  function shipDialog(o) {
    const reason = h('input', { type: 'text', placeholder: '未付款時必填，會寫入稽核紀錄' });
    const body = h('div', {},
      h('div', { class: 'banner info' }, '此路徑不經掃碼核對，出貨紀錄會標記為「未經核對」（F-19）。'),
      o.paid ? null : h('div', { class: 'banner warn' }, '這張單尚未付款，需店主權限並填寫覆寫原因。'),
      h('label', { class: 'field' }, h('span', {}, '覆寫原因'), reason));
    modal(`出貨 ${o.order_id}`, body, [{
      label: '確認出貨', primary: true,
      onClick: async (close) => {
        const r = await POST('/api/v1/orders/ship', { order_id: o.order_id, override_reason: reason.value || null, verified_by_scan: false });
        close();
        toast('已出貨，並產生客人通知');
        if (r.notification) modal('出貨通知（雛型不發送 LINE 推播）', h('pre', { style: 'white-space:pre-wrap;margin:0;font:inherit' }, r.notification));
        load();
      },
    }]);
  }

  function reconcileDialog() {
    const amount = h('input', { type: 'number', placeholder: '入帳金額' });
    const last5 = h('input', { type: 'text', placeholder: '帳號後五碼（選填）' });
    const result = h('div', { style: 'margin-top:10px' });
    const body = h('div', {},
      h('p', { class: 'small muted', style: 'margin-top:0' }, '以金額比對未付款訂單。多筆符合時必須人工指定，金額不符不會自動認列（F-06）。'),
      h('label', { class: 'field' }, h('span', {}, '入帳金額 (TWD)'), amount),
      h('label', { class: 'field' }, h('span', {}, '匯款後五碼'), last5),
      h('button', {
        class: 'btn', onClick: async () => {
          try {
            const r = await GET('/api/v1/payments/candidates?amount=' + Number(amount.value));
            result.innerHTML = '';
            if (!r.exact_matches.length) { result.append(h('div', { class: 'banner warn' }, '沒有金額相符的未付款訂單，已標記為待處理，不自動配對。')); return; }
            result.append(h('div', { class: 'small muted', style: 'margin-bottom:6px' }, r.unique ? '唯一符合，可直接認列：' : '多筆符合，請指定：'));
            for (const c of r.exact_matches) {
              result.append(h('div', { class: 'row', style: 'border:1px solid var(--line);border-radius:9px;padding:8px 10px;margin-bottom:6px' },
                h('span', { class: 'mono' }, c.order_id), h('span', {}, c.nickname), h('span', { class: 'spacer', style: 'flex:1' }),
                h('span', {}, nt(c.total_twd)),
                h('button', {
                  class: 'btn sm primary', onClick: async () => {
                    try {
                      await POST('/api/v1/payments/reconcile', { order_id: c.order_id, amount_twd: Number(amount.value), last5: last5.value || null, method: 'transfer' });
                      toast(`${c.order_id} 已認列，狀態轉為待採購`);
                      load();
                    } catch (e) { fail(e); }
                  },
                }, '認列')));
            }
          } catch (e) { fail(e); }
        },
      }, '比對'),
      result);
    modal('付款對帳', body);
  }

  await load();
}
