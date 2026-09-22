import { GET, POST, h, dt, toast, fail, session } from '/app.js';

/** F-23 匯率管理 + 團別切換 + 店家收款設定。 */
export async function render(root) {
  const canWrite = session.can('settings.write');
  const [fx, batches] = await Promise.all([GET('/api/v1/settings/fx'), GET('/api/v1/settings/batches')]);

  // 收款資訊只有店主讀得到，所以整張卡片對其他角色不呈現。
  if (canWrite) await shopCard(root);

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

/**
 * 店家與收款設定。這幾筆刻意不放在種子資料裡 —— repo 是公開的，真實收款帳號
 * 不該進版本控制，所以由店主在這裡填。沒填齊時前台拿不到匯款帳號，因此缺項
 * 會直接標在最上面。
 */
async function shopCard(root) {
  let data;
  try { data = await GET('/api/v1/settings/shop'); }
  catch (e) { fail(e); return; }

  const inputs = new Map();
  const warn = h('div', { class: 'banner warn' }, '');
  const paint = (missing) => {
    warn.textContent = missing.length
      ? `還有 ${missing.length} 項沒填：${missing.join('、')}。沒填齊之前，客人在前台看不到匯款帳號。`
      : '';
    warn.style.display = missing.length ? '' : 'none';
  };

  const fieldNode = (f) => {
    const input = h('input', {
      type: 'text',
      value: data.values[f.key] || '',
      placeholder: f.required ? '必填' : '選填',
      inputmode: (f.type === 'digits' || f.type === 'int') ? 'numeric' : undefined,
    });
    inputs.set(f.key, input);
    return h('label', { class: 'field' },
      h('span', {}, f.label, f.required ? h('span', { class: 'tiny muted' }, '　必填') : null),
      input,
      f.hint ? h('span', { class: 'tiny muted' }, f.hint) : null);
  };

  const save = h('button', {
    class: 'btn primary',
    onClick: async () => {
      const payload = {};
      for (const [key, input] of inputs) payload[key] = input.value;
      save.disabled = true;
      try {
        const r = await POST('/api/v1/settings/shop', payload);
        for (const [key, input] of inputs) input.value = r.values[key] || '';
        paint(r.missing);
        toast(r.missing.length ? '已儲存，但還有必填欄位沒填' : '店家設定已儲存');
      } catch (e) { fail(e); }
      finally { save.disabled = false; }
    },
  }, '儲存設定');

  paint(data.missing);
  root.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, '店家與收款設定'), h('div', { class: 'spacer' }),
      h('span', { class: 'muted tiny' }, '僅店主可見可改')),
    h('div', { class: 'card-body' },
      warn,
      h('div', { class: 'banner info' },
        '這幾筆不隨程式碼發布，換環境要重新填一次。收款帳號只有店主看得到，也不會寫進稽核紀錄 —— 紀錄裡只留「哪些欄位被改過」。'),
      h('div', { class: 'grid cols-2' }, ...data.fields.map(fieldNode)),
      h('div', { class: 'row', style: 'margin-top:14px' }, save))));
}
