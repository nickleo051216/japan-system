import { GET, POST, h, nt, jpy, dt, toast, fail, session } from '/app.js';

/**
 * 開團與喊單。客人首頁顯示的團別與喊單就是從這裡來的 ——
 * 這一頁沒東西，前台首頁就是空的。
 */
export async function render(root, ctx) {
  const canBatch = session.can('settings.write');

  // ---- 開團 ----
  if (canBatch) {
    const f = {
      batch: h('input', { type: 'text', placeholder: '例：T-261015' }),
      name: h('input', { type: 'text', placeholder: '例：10/15 大阪採買' }),
      region: h('input', { type: 'text', placeholder: '例：大阪' }),
      close: h('input', { type: 'datetime-local' }),
    };
    const batches = await GET('/api/v1/settings/batches');
    root.append(h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, '開團'), h('div', { class: 'spacer' }),
        h('span', { class: 'muted tiny' }, `目前團別：${batches.current_batch || '尚未設定'}`)),
      h('div', { class: 'card-body' },
        h('div', { class: 'banner info' }, '新開的團會自動設為「目前團別」—— 客人首頁、結帳歸團、新開的喊單都跟著它走。'),
        h('div', { class: 'row', style: 'flex-wrap:wrap;gap:10px' },
          h('label', { class: 'field' }, h('span', {}, '團號'), f.batch),
          h('label', { class: 'field' }, h('span', {}, '團名'), f.name),
          h('label', { class: 'field' }, h('span', {}, '地區'), f.region),
          h('label', { class: 'field' }, h('span', {}, '截單時間'), f.close)),
        h('button', {
          class: 'btn primary', onClick: async () => {
            try {
              const r = await POST('/api/v1/settings/batch/create', {
                batch: f.batch.value.trim(), name: f.name.value.trim(), region: f.region.value.trim() || null,
                close_at: f.close.value ? new Date(f.close.value).toISOString() : null });
              toast(`已開團 ${r.batch}，並設為目前團別`);
              ctx.reload();
            } catch (e) { fail(e); }
          },
        }, '開團'))));
  }

  // ---- 開喊單 ----
  const b = {
    name: h('input', { type: 'text', placeholder: '品名，例：西松屋 紗布巾' }),
    jpy: h('input', { type: 'number', min: '1', placeholder: '日幣税込' }),
    twd: h('input', { type: 'number', min: '1', placeholder: '留空＝照價目表' }),
    qty: h('input', { type: 'number', min: '1', value: '1' }),
    deadline: h('input', { type: 'datetime-local' }),
    note: h('input', { type: 'text', placeholder: '備註（選填）' }),
  };
  root.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, '開喊單')),
    h('div', { class: 'card-body' },
      h('div', { class: 'banner info' }, '數量由資料庫原子扣減，二十個人同時搶也不會超賣。填日幣就好，售價照價目表換算。'),
      h('div', { class: 'row', style: 'flex-wrap:wrap;gap:10px' },
        h('label', { class: 'field', style: 'min-width:240px' }, h('span', {}, '品名'), b.name),
        h('label', { class: 'field' }, h('span', {}, '日幣'), b.jpy),
        h('label', { class: 'field' }, h('span', {}, '台幣（選填）'), b.twd),
        h('label', { class: 'field' }, h('span', {}, '數量'), b.qty),
        h('label', { class: 'field' }, h('span', {}, '截止時間'), b.deadline),
        h('label', { class: 'field', style: 'min-width:200px' }, h('span', {}, '備註'), b.note)),
      h('button', {
        class: 'btn primary', onClick: async () => {
          try {
            const r = await POST('/api/v1/broadcast/create', {
              name: b.name.value.trim(), jpy_taxed: b.jpy.value ? Number(b.jpy.value) : null,
              price_twd: b.twd.value ? Number(b.twd.value) : null, quantity: Number(b.qty.value),
              deadline_at: b.deadline.value ? new Date(b.deadline.value).toISOString() : null,
              note: b.note.value.trim() || null });
            toast(`已開喊單 ${r.send_id}：${nt(r.price_twd)} × ${r.quantity}`);
            ctx.reload();
          } catch (e) { fail(e); }
        },
      }, '開喊單'))));

  // ---- 喊單列表 ----
  const list = await GET('/api/v1/broadcast/admin-list');
  const tbody = h('tbody', {});
  root.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, `本團喊單（${list.batch || '未設定團別'}）`)),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, '編號'), h('th', {}, '品名'), h('th', {}, '售價'),
        h('th', {}, '已搶／總數'), h('th', {}, '候補'), h('th', {}, '截止'), h('th', {}, '狀態'), h('th', {}))),
      tbody))));
  if (!list.broadcasts.length) tbody.append(h('tr', {}, h('td', { colspan: '8', class: 'empty' }, '這一團還沒有喊單')));
  for (const x of list.broadcasts) {
    const delta = h('input', { type: 'number', value: '1', style: 'width:64px' });
    tbody.append(h('tr', {},
      h('td', { class: 'mono tiny' }, x.send_id),
      h('td', {}, x.name, x.jpy_taxed ? h('div', { class: 'tiny muted' }, jpy(x.jpy_taxed)) : null),
      h('td', {}, nt(x.price_twd)),
      h('td', {}, `${x.sold} / ${x.quantity}`),
      h('td', { class: 'tiny' }, x.waitlist ? `${x.waitlist} 人` : '—'),
      h('td', { class: 'tiny muted' }, dt(x.deadline_at)),
      h('td', {}, x.open ? h('span', { class: 'tag green' }, '可搶') : h('span', { class: 'tag' }, x.remaining ? '已截止' : '搶完')),
      h('td', {}, h('div', { class: 'row', style: 'gap:6px' },
        delta,
        h('button', { class: 'btn sm', onClick: async () => {
          try { const r = await POST('/api/v1/broadcast/adjust', { send_id: x.send_id, delta: Number(delta.value) });
            toast(`${x.send_id} 剩餘 ${r.remaining}`); ctx.reload(); } catch (e) { fail(e); } } }, '加減量'),
        x.open ? h('button', { class: 'btn sm', onClick: async () => {
          try { await POST('/api/v1/broadcast/close', { send_id: x.send_id }); toast(`${x.send_id} 已截止`); ctx.reload(); }
          catch (e) { fail(e); } } }, '提前截止') : null))));
  }
}
