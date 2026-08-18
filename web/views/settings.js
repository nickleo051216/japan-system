import { GET, POST, h, dt, toast, fail, session } from '/app.js';

/** F-23 匯率管理 + 團別切換。 */
export async function render(root) {
  const canWrite = session.can('settings.write');
  const [fx, batches] = await Promise.all([GET('/api/v1/settings/fx'), GET('/api/v1/settings/batches')]);

  const rate = h('input', { type: 'number', step: '0.001', value: String(fx.fx_jpy_twd), disabled: !canWrite });
  const history = h('tbody', {}, ...fx.history.map((r) => h('tr', {},
    h('td', { class: 'tiny muted' }, dt(r.changed_at)), h('td', {}, r.rate), h('td', { class: 'tiny muted' }, r.changed_by || '—'))));

  root.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, '匯率（JPY → TWD）'), h('div', { class: 'spacer' }),
      h('span', { class: 'muted tiny' }, canWrite ? '僅店主可改' : '僅店主可改，唯讀')),
    h('div', { class: 'card-body' },
      h('div', { class: 'banner info' },
        '每筆採購寫入時會快照當下匯率，之後調整匯率不會改動既有紀錄的台幣成本 —— 否則回頭重算毛利會與當初對不上帳。'),
      h('div', { class: 'row' },
        h('div', { style: 'width:200px' }, rate),
        canWrite ? h('button', {
          class: 'btn primary',
          onClick: async () => {
            try {
              const r = await POST('/api/v1/settings/fx', { fx_jpy_twd: Number(rate.value) });
              toast(`匯率已由 ${r.previous} 改為 ${r.fx_jpy_twd}，既有紀錄不受影響`);
              history.prepend(h('tr', {}, h('td', { class: 'tiny muted' }, dt(new Date().toISOString())), h('td', {}, r.fx_jpy_twd), h('td', { class: 'tiny muted' }, session.member.line_user_id)));
            } catch (e) { fail(e); }
          },
        }, '更新匯率') : null),
      h('div', { class: 'small muted', style: 'margin-top:16px' }, '變更紀錄'),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, '時間'), h('th', {}, '匯率'), h('th', {}, '變更者'))), history)))));

  const batchSel = h('select', { style: 'width:220px', disabled: !canWrite },
    ...batches.batches.map((b) => h('option', { value: b.batch, selected: b.batch === batches.current_batch }, `${b.batch}　${b.name}`)));

  root.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, '目前團別')),
    h('div', { class: 'card-body' }, h('div', { class: 'row' }, batchSel,
      canWrite ? h('button', {
        class: 'btn',
        onClick: async () => {
          try { const r = await POST('/api/v1/settings/batch', { batch: batchSel.value }); toast(`已切換至 ${r.current_batch}`); }
          catch (e) { fail(e); }
        },
      }, '切換') : null))));

  const products = await GET('/api/v1/products/list');
  root.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, '商品型錄')),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'SKU'), h('th', {}, '品名'), h('th', {}, '當地品名'), h('th', {}, '品牌'),
        'price_twd' in (products[0] || {}) ? h('th', {}, '售價') : null,
        session.can('order.read.cost') ? h('th', {}, '預估進價') : null,
        session.can('order.read.cost') ? h('th', {}, '實際進價') : null)),
      h('tbody', {}, ...products.map((p) => h('tr', {},
        h('td', {}, h('img', { class: 'thumb', src: p.image_url, alt: p.name_zh })),
        h('td', { class: 'mono tiny' }, p.sku),
        h('td', {}, p.name_zh),
        h('td', { class: 'tiny muted' }, p.name_local || '—'),
        h('td', { class: 'tiny muted' }, p.brand || '—'),
        'price_twd' in p ? h('td', {}, 'NT$' + p.price_twd) : null,
        'est_cost_jpy' in p ? h('td', { class: 'tiny muted' }, p.est_cost_jpy ? '¥' + p.est_cost_jpy : '—') : null,
        'actual_cost_jpy' in p ? h('td', {}, p.actual_cost_jpy ? '¥' + p.actual_cost_jpy : h('span', { class: 'tag amber' }, '未登錄')) : null)))))));
}
