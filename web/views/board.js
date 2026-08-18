import { GET, POST, h, nt, jpy, pct, toast, fail, modal, session } from '/app.js';

const STATE_TAG = {
  open: ['', '未認領'], claimed: ['blue', '已認領'], got: ['green', '買足'],
  partial: ['amber', '部分'], out_of_stock: ['red', '缺貨'],
};

export async function render(root, ctx) {
  const showCost = session.can('order.read.cost');
  const wrap = h('div', {});
  root.append(h('div', { class: 'banner info' },
    '認領以資料庫條件更新實作（僅在尚未被認領時才寫入成功），兩人同時點「我來買」只有一人會成功。'
    + 'Google Sheets 為 last-write-wins，無法可靠支援此機制 —— 正式上線前需先完成 Supabase 遷移（I-01）。'));
  root.append(wrap);

  async function load() {
    const d = await GET('/api/v1/procurement/board' + (ctx.query.batch ? `?batch=${ctx.query.batch}` : ''));
    wrap.innerHTML = '';
    const list = h('div', { class: 'grid cols-3' });
    for (const r of d.rows) {
      const [tone, label] = STATE_TAG[r.state] || ['', r.state];
      const mine = r.claimed_by_me;
      const actions = h('div', { class: 'row', style: 'margin-top:10px' });

      if (r.state === 'open') {
        actions.append(h('button', {
          class: 'btn primary sm',
          onClick: async () => { try { await POST('/api/v1/procurement/claim', { proc_id: r.proc_id }); toast('已認領'); load(); } catch (e) { fail(e); load(); } },
        }, '我來買'));
      } else if (r.state === 'claimed' && mine) {
        actions.append(h('button', { class: 'btn primary sm', onClick: () => resultDialog(r) }, '回報結果'));
        actions.append(h('button', {
          class: 'btn sm',
          onClick: async () => { try { await POST('/api/v1/procurement/release', { proc_id: r.proc_id }); toast('已放掉'); load(); } catch (e) { fail(e); } },
        }, '放掉'));
      } else if (r.state === 'claimed') {
        // Locked for everyone else — the button is simply not rendered (F-08 認領機制 3)
        actions.append(h('span', { class: 'tag' }, `🔒 ${r.claimed_by_nickname || '他人'} 認領中`));
      } else if (['got', 'partial'].includes(r.state)) {
        actions.append(h('a', { class: 'btn sm', href: `#/expense?proc=${r.proc_id}` }, '去請款'));
        if (mine || session.member.role === 'owner') actions.append(h('button', { class: 'btn ghost sm', onClick: () => resultDialog(r) }, '修改結果'));
      } else if (r.state === 'out_of_stock' && (mine || session.member.role === 'owner')) {
        actions.append(h('button', { class: 'btn ghost sm', onClick: () => resultDialog(r) }, '修改結果'));
      }

      list.append(h('div', { class: 'card', style: 'padding:14px' },
        h('div', { class: 'row', style: 'align-items:flex-start' },
          h('img', { class: 'thumb lg', src: r.image_url, alt: r.name_zh }),
          h('div', { style: 'flex:1;min-width:120px' },
            h('div', { class: 'row', style: 'gap:6px' }, h('strong', {}, r.name_zh), h('span', { class: 'tag ' + tone }, label)),
            h('div', { class: 'tiny muted' }, `${r.sku}　${r.name_local || ''}`),
            h('div', { style: 'margin-top:6px' },
              h('span', { class: 'tag' }, `需求 ${r.need_qty} 件`),
              r.got_qty != null ? h('span', { class: 'tag', style: 'margin-left:6px' }, `買到 ${r.got_qty}`) : null),
            'price_twd' in r
              ? h('div', { class: 'tiny muted', style: 'margin-top:5px' },
                `售價 ${nt(r.price_twd)}` + ('est_cost_jpy' in r ? `　預估進價 ${jpy(r.est_cost_jpy)}` : ''))
              : null,
            showCost && r.unit_cost_twd != null
              ? h('div', { class: 'tiny', style: 'margin-top:4px' },
                `實付 ${jpy(r.unit_cost_jpy)} → 成本 ${nt(r.unit_cost_twd)}　`,
                h('span', { class: 'tag ' + (r.margin_pct >= 20 ? 'green' : 'red') }, `毛利 ${pct(r.margin_pct)}`))
              : null)),
        h('div', { class: 'tiny muted', style: 'margin-top:9px' },
          '下單：' + (r.buyers.length ? r.buyers.map((b) => `${b.nickname}×${b.qty}`).join('、') : '—')),
        actions));
    }
    wrap.append(list.children.length ? list : h('div', { class: 'card' }, h('div', { class: 'empty' }, '本團目前沒有待採購項目')));
  }

  function resultDialog(r) {
    const qty = h('input', { type: 'number', min: '0', value: String(r.got_qty ?? r.need_qty) });
    const body = h('div', {},
      h('p', { class: 'small muted', style: 'margin-top:0' }, `${r.name_zh}　需求 ${r.need_qty} 件。填 0 為買不到；填滿或超過需求記為買足；其餘為部分買到，會立即通知店主決策。`),
      h('label', { class: 'field' }, h('span', {}, '實際買到件數'), qty));
    modal('回報採購結果', body, [{
      label: '送出', primary: true,
      onClick: async (close) => {
        const res = await POST('/api/v1/procurement/result', { proc_id: r.proc_id, got_qty: Number(qty.value) });
        close();
        toast({ got: '已記為買足', partial: '已記為部分買到，已通知店主', out_of_stock: '已記為缺貨，已通知店主' }[res.state]);
        load();
      },
    }]);
  }

  await load();
}
