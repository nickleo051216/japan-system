import { GET, h, toast, fail } from '/app.js';

/**
 * F-15 QR 出貨標籤產生器.
 * 50×30mm thermal label, QR ≥18mm, EC level Q, 4-module quiet zone.
 * @page in style.css sets the print size; 列印時只有標籤會進紙。
 */
export async function render(root, ctx) {
  const input = h('input', { type: 'text', placeholder: '訂單編號，逗號分隔；留空＝所有待出貨', value: ctx.query.order_ids || '', style: 'width:340px' });
  const sheet = h('div', { class: 'label-sheet' });
  const card = h('div', { class: 'card' },
    h('div', { class: 'card-head no-print' },
      h('h2', {}, 'QR 出貨標籤'),
      h('div', { class: 'spacer' }),
      input,
      h('button', { class: 'btn', onClick: load }, '產生'),
      h('button', { class: 'btn primary', onClick: () => window.print() }, '列印')),
    h('div', { class: 'card-body' }, sheet));
  root.append(h('div', { class: 'banner info no-print' },
    'QR 內容為 HB|訂單編號|4 碼簽章，全部為 ASCII。簽章由伺服器以 HMAC-SHA256 產生，前端不持有金鑰、也不驗證 —— '
    + '掃到的字串一律送後端驗（F-16）。'), card);

  async function load() {
    try {
      const ids = input.value.split(',').map((s) => s.trim()).filter(Boolean).join(',');
      const d = await GET('/api/v1/labels/data' + (ids ? `?order_ids=${encodeURIComponent(ids)}` : ''));
      sheet.innerHTML = '';
      if (!d.labels.length) { sheet.append(h('div', { class: 'empty' }, '沒有可列印的標籤')); return; }
      for (const l of d.labels) {
        sheet.append(h('div', { class: 'label' },
          h('div', { class: 'qr', html: l.qr_svg }),
          h('div', { class: 'meta' },
            h('div', { class: 'oid' }, l.order_id),
            h('div', {}, l.nickname),
            h('div', {}, `${l.pieces} 件　${l.date}`),
            h('div', {}, l.shop))));
      }
      toast(`已產生 ${d.labels.length} 張標籤`);
    } catch (e) { fail(e); }
  }

  await load();
}
