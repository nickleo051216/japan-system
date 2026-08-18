import { GET, POST, h, nt, statusTag, toast, fail, modal, session } from '/app.js';

/** F-09 看圖理貨 — 對照客人原始圖片撿貨。 */
export async function render(root) {
  const wrap = h('div', {});
  root.append(h('div', { class: 'banner info' },
    '每張卡片顯示客人當初傳來的原始圖片，包貨人員照圖撿貨。此頁出貨不經掃碼核對，稽核紀錄會標記為「未經核對」；'
    + '建議改走「掃碼核對工作站」。'));
  root.append(wrap);

  async function load() {
    const orders = await GET('/api/v1/packing/list');
    wrap.innerHTML = '';
    if (!orders.length) { wrap.append(h('div', { class: 'card' }, h('div', { class: 'empty' }, '目前沒有待出貨訂單'))); return; }
    const grid = h('div', { class: 'grid cols-2' });
    for (const o of orders) {
      const items = h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:10px;margin-top:10px' });
      for (const i of o.items) {
        items.append(h('div', { style: 'text-align:center' },
          h('img', { class: 'thumb lg', src: i.source_image_url || i.image_url, alt: i.name_zh, style: 'width:100%;height:96px' }),
          h('div', { class: 'tiny', style: 'margin-top:4px' }, i.name_zh),
          h('div', { class: 'tiny muted' }, `×${i.qty}`)));
      }
      grid.append(h('div', { class: 'card', style: 'padding:14px' },
        h('div', { class: 'row' },
          h('strong', { class: 'mono' }, o.order_id), statusTag(o.status),
          o.paid ? h('span', { class: 'tag green' }, '已付') : h('span', { class: 'tag amber' }, '未付'),
          h('span', { class: 'spacer', style: 'flex:1' }),
          h('span', { class: 'muted small' }, o.nickname)),
        'total_twd' in o ? h('div', { class: 'tiny muted', style: 'margin-top:4px' }, nt(o.total_twd)) : null,
        !o.coverage.complete ? h('div', { class: 'banner warn', style: 'margin-top:10px' }, `尚缺：${o.coverage.missing.join('、')}`) : null,
        items,
        h('div', { class: 'row', style: 'margin-top:12px' },
          h('a', { class: 'btn sm', href: `#/labels?order_ids=${o.order_id}` }, '列印標籤'),
          h('button', { class: 'btn sm', onClick: () => shipDialog(o) }, '直接出貨'))));
    }
    wrap.append(grid);
  }

  function shipDialog(o) {
    const reason = h('input', { type: 'text', placeholder: o.paid ? '選填' : '未付款必填，需店主權限' });
    modal(`出貨 ${o.order_id}`, h('div', {},
      h('div', { class: 'banner warn' }, '未經掃碼核對的出貨會在稽核軌跡標記為 verified_by_scan = false。'),
      h('label', { class: 'field' }, h('span', {}, '覆寫原因'), reason)), [{
      label: '確認出貨', primary: true,
      onClick: async (close) => {
        const r = await POST('/api/v1/orders/ship', { order_id: o.order_id, override_reason: reason.value || null, verified_by_scan: false });
        close();
        toast('已出貨');
        if (r.notification) modal('出貨通知（雛型不發送 LINE 推播）', h('pre', { style: 'white-space:pre-wrap;margin:0;font:inherit' }, r.notification));
        load();
      },
    }]);
  }

  await load();
}
