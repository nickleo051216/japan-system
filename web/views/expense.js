import { GET, POST, h, nt, jpy, pct, toast, fail, session } from '/app.js';

/**
 * F-07 拍照請款.
 * The order of the steps is the point: pick the product FIRST, then shoot the
 * receipt, so OCR only ever has to read one number — and that number always
 * needs human confirmation before it is written.
 */
export async function render(root, ctx) {
  const showCost = session.can('order.read.cost');
  const board = await GET('/api/v1/procurement/board');
  const candidates = board.rows.filter((r) => r.state !== 'open');

  const state = { proc: candidates.find((r) => r.proc_id === ctx.query.proc) || null, receiptUrl: null, ocr: null };

  root.append(h('div', { class: 'banner info' },
    '步驟固定為「先選商品 → 再拍收據 → 確認金額」。日文收據品名無法可靠對應中文品名，'
    + '因此不讓 AI 判斷收據屬於哪個商品，OCR 只負責讀金額，且必須人工確認才寫入。'));

  const step1 = h('div', { class: 'card' });
  const step2 = h('div', { class: 'card' });
  const step3 = h('div', { class: 'card' });
  root.append(step1, step2, step3);

  function renderStep1() {
    step1.innerHTML = '';
    step1.append(h('div', { class: 'card-head' }, h('h2', {}, '① 選擇商品'), h('div', { class: 'spacer' }),
      h('span', { class: 'muted tiny' }, '本團尚未完成請款的品項')));
    const body = h('div', { class: 'card-body', style: 'display:grid;gap:8px' });
    if (!candidates.length) body.append(h('div', { class: 'muted small' }, '目前沒有可請款的品項。'));
    for (const r of candidates) {
      const selected = state.proc && state.proc.proc_id === r.proc_id;
      body.append(h('button', {
        class: 'persona', style: selected ? 'border-color:var(--accent);background:var(--accent-soft)' : '',
        onClick: () => { state.proc = r; state.ocr = null; state.receiptUrl = null; renderAll(); },
      },
        h('img', { class: 'thumb', src: r.image_url, alt: r.name_zh }),
        h('div', { style: 'flex:1' },
          h('div', {}, r.name_zh),
          h('div', { class: 'tiny muted' }, `${r.sku}　買到 ${r.got_qty ?? 0}/${r.need_qty} 件　已登錄 ${r.receipts || 0} 張收據`)),
        showCost && r.unit_cost_twd != null ? h('span', { class: 'tag' }, `成本 ${nt(r.unit_cost_twd)}`) : null,
        selected ? h('span', { class: 'tag blue' }, '已選') : null));
    }
    step1.append(body);
  }

  function renderStep2() {
    step2.innerHTML = '';
    step2.append(h('div', { class: 'card-head' }, h('h2', {}, '② 上傳收據')));
    const body = h('div', { class: 'card-body' });
    if (!state.proc) {
      body.append(h('div', { class: 'muted small' }, '請先選擇商品。'));
    } else {
      const preview = h('div', { style: 'margin-top:10px' });
      const file = h('input', {
        type: 'file', accept: 'image/*', capture: 'environment',
        onChange: async (e) => {
          const f = e.target.files[0];
          if (!f) return;
          const dataUrl = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(f); });
          preview.innerHTML = '';
          preview.append(h('img', { src: dataUrl, style: 'max-width:220px;border-radius:10px;border:1px solid var(--line)' }));
          try {
            const r = await POST('/api/v1/procurement/ocr', { proc_id: state.proc.proc_id, image_data_url: dataUrl });
            state.ocr = r; state.receiptUrl = r.receipt_url;
            toast('已讀取金額，請確認後再送出');
            renderStep3();
          } catch (err) { fail(err); }
        },
      });
      body.append(h('div', { class: 'muted small', style: 'margin-bottom:8px' }, `商品：${state.proc.name_zh}（${state.proc.sku}）`), file, preview);
      body.append(h('div', { class: 'tiny muted', style: 'margin-top:10px' },
        '雛型未接 OCR 服務，讀出的金額為模擬值；正式版為 GPT-4o Vision，prompt 限縮為「只回傳金額數字」。'));
    }
    step2.append(body);
  }

  function renderStep3() {
    step3.innerHTML = '';
    step3.append(h('div', { class: 'card-head' }, h('h2', {}, '③ 確認金額並寫入')));
    const body = h('div', { class: 'card-body' });
    if (!state.proc) { body.append(h('div', { class: 'muted small' }, '請先選擇商品。')); step3.append(body); return; }

    const amount = h('input', { type: 'number', min: '1', value: state.ocr ? String(state.ocr.amount_jpy) : '' });
    const qty = h('input', { type: 'number', min: '1', value: String(state.proc.got_qty || state.proc.need_qty || 1) });
    const originalOcr = state.ocr ? state.ocr.amount_jpy : null;
    const out = h('div', { style: 'margin-top:12px' });

    if (state.ocr) {
      body.append(h('div', { class: 'banner warn' },
        `OCR 讀到 ${jpy(state.ocr.amount_jpy)}（信心 ${(state.ocr.confidence * 100).toFixed(0)}%）—— 請與收據核對，可直接修改。修改過的金額會標記為人工修正。`));
    }
    body.append(
      h('label', { class: 'field' }, h('span', {}, '單件實付日幣'), amount),
      h('label', { class: 'field' }, h('span', {}, '件數'), qty),
      h('button', {
        class: 'btn primary',
        onClick: async () => {
          try {
            const edited = originalOcr != null && Number(amount.value) !== originalOcr;
            const r = await POST('/api/v1/procurement/expense', {
              proc_id: state.proc.proc_id,
              unit_cost_jpy: Number(amount.value),
              qty: Number(qty.value),
              receipt_url: state.receiptUrl,
              amount_edited: edited,
            });
            out.innerHTML = '';
            out.append(h('div', { class: 'card', style: 'padding:14px' },
              h('div', {}, `${r.name_zh}　${r.qty} 件`),
              h('div', { class: 'small muted', style: 'margin-top:6px' }, `實付 ${jpy(r.unit_cost_jpy)}　×　匯率 ${r.fx_rate}（寫入當下快照）`),
              showCost ? h('div', { style: 'margin-top:8px' },
                h('span', { class: 'tag' }, `台幣成本 ${nt(r.unit_cost_twd)}`),
                h('span', { class: 'tag', style: 'margin-left:6px' }, `售價 ${nt(r.price_twd)}`),
                h('span', { class: 'tag ' + (r.low_margin ? 'red' : 'green'), style: 'margin-left:6px' }, `毛利率 ${pct(r.margin_pct)}`))
                : h('div', { class: 'tiny muted', style: 'margin-top:8px' }, '成本與毛利僅店主可見。'),
              r.low_margin ? h('div', { class: 'banner warn', style: 'margin-top:10px' }, '⚠ 毛利率低於 20%，建議回報店主確認售價。') : null,
              r.receipts > 1 ? h('div', { class: 'tiny muted', style: 'margin-top:8px' }, `此商品已有 ${r.receipts} 張收據，成本以加權平均計算。`) : null));
            toast('已寫入成本');
            state.ocr = null;
          } catch (e) { fail(e); }
        },
      }, '確認並寫入成本'),
      out);
    step3.append(body);
  }

  const renderAll = () => { renderStep1(); renderStep2(); renderStep3(); };
  renderAll();
}
