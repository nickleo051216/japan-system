import { GET, POST, h, dt, toast, fail } from '/app.js';

/** F-20 進貨物流綁定 — 物流商條碼內容不可控，必須建立對照表。 */
export async function render(root) {
  const tracking = h('input', { type: 'text', placeholder: '掃描或輸入物流單號' });
  const carrier = h('input', { type: 'text', placeholder: '物流商（選填）' });
  const orderSel = h('select', {});
  const tbody = h('tbody', {});

  root.append(h('div', { class: 'banner info' },
    '出貨端的 QR 由本系統列印，訂單資料寫在碼內，不需對照表；進貨端條碼由物流商產生，內容不可控，因此必須綁定。'));

  root.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, '新增綁定')),
    h('div', { class: 'card-body' },
      h('div', { class: 'grid cols-3' },
        h('label', { class: 'field' }, h('span', {}, '物流單號'), tracking),
        h('label', { class: 'field' }, h('span', {}, '對應訂單'), orderSel),
        h('label', { class: 'field' }, h('span', {}, '物流商'), carrier)),
      h('button', {
        class: 'btn primary',
        onClick: async () => {
          try {
            await POST('/api/v1/logistics/bind', { tracking_no: tracking.value.trim(), order_id: orderSel.value, carrier: carrier.value || null });
            toast('已綁定');
            tracking.value = '';
            load();
          } catch (e) { fail(e); }
        },
      }, '綁定'))));

  root.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, '既有綁定'), h('div', { class: 'spacer' }), h('span', { class: 'muted tiny' }, '一張訂單可綁多個包裹')),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, '單號'), h('th', {}, '訂單'), h('th', {}, '物流商'), h('th', {}, '綁定時間'))),
      tbody))));

  async function load() {
    const [orders, list] = await Promise.all([GET('/api/v1/orders/list?limit=200'), GET('/api/v1/logistics/list')]);
    orderSel.innerHTML = '';
    for (const o of orders) orderSel.append(h('option', { value: o.order_id }, `${o.order_id}｜${o.nickname}｜${o.status}`));
    tbody.innerHTML = '';
    if (!list.length) tbody.append(h('tr', {}, h('td', { colspan: '4', class: 'empty' }, '尚無綁定紀錄')));
    for (const b of list) {
      tbody.append(h('tr', {}, h('td', { class: 'mono' }, b.tracking_no), h('td', { class: 'mono' }, b.order_id),
        h('td', {}, b.carrier || '—'), h('td', { class: 'tiny muted' }, dt(b.bound_at))));
    }
  }
  await load();
}
