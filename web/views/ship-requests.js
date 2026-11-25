import { GET, POST, h, nt, dt, statusTag, toast, fail, modal, session } from '../app.js';

/**
 * 出貨申請（v1.6 ④）：客人在前台申請「併單」或「拆單」，店主在這裡審核。
 *
 *   待審核 —— 一張卡片一筆申請：哪幾張單、每張的運費、品項照片（拆單會標出先寄的品項）。
 *             核准 → 系統自動產生出貨單；不核准要寫原因（客人會在 LINE 收到）。
 *   出貨單 —— 核准後產生的「這一箱」：底下的單全部到貨了就能按「整箱出貨」。
 *   已處理 —— 核准、不核准、客人自己取消的紀錄。
 * 審核只有店主能按（會動到運費），小幫手和理貨的人看得到但沒有按鈕。
 */
const TABS = ['待審核', '出貨單', '已處理'];
const KIND_TONE = { merge: 'blue', split: 'peach' };
const STATE_TONE = { pending: 'amber', approved: 'green', rejected: 'red', cancelled: '' };

export async function render(root, ctx) {
  const tab = TABS.includes(ctx.query.tab) ? ctx.query.tab : '待審核';
  const isOwner = session.member && session.member.role === 'owner';

  root.append(h('div', { class: 'row', style: 'gap:6px;margin-bottom:12px' }, ...TABS.map((t) =>
    h('a', { class: 'btn sm' + (t === tab ? ' primary' : ''), href: '#/ship-requests?tab=' + encodeURIComponent(t) }, t))));

  if (tab === '出貨單') return renderGroups(root, ctx);

  const rows = await GET('/api/v1/ship-requests/admin-list' + (tab === '待審核' ? '?status=pending' : ''));
  const list = tab === '待審核' ? rows : rows.filter((r) => r.status !== 'pending');
  if (tab === '待審核') {
    root.append(h('div', { class: 'banner info' },
      '併單：幾張單裝一箱寄，只收第一張的運費（其他張還沒付款、還沒出對帳單的運費會自動拿掉）。'
      + '拆單：已到貨的品項先寄，系統拆出一張新訂單，先寄的那箱另收一次運費。'));
  }
  if (!list.length) { root.append(h('div', { class: 'card' }, h('div', { class: 'empty' }, tab === '待審核' ? '目前沒有要審核的申請 🎉' : '還沒有處理過的申請'))); return; }

  const grid = h('div', { style: 'display:grid;gap:12px' });
  for (const r of list) grid.append(requestCard(r, ctx, isOwner && r.status === 'pending'));
  root.append(grid);
}

function requestCard(r, ctx, canDecide) {
  const orders = r.orders.map((o, idx) => h('div', { class: 'sr-order' },
    h('div', { class: 'row', style: 'gap:6px' },
      h('strong', { class: 'mono' }, o.order_id), statusTag(o.status),
      r.kind === 'merge' && idx === 0 ? h('span', { class: 'tag green' }, '寄這張的地址') : null,
      h('span', { class: 'spacer', style: 'flex:1' }),
      'total_twd' in o ? h('span', { class: 'small' }, nt(o.total_twd), h('span', { class: 'tiny muted' }, `（運費 ${nt(o.ship_fee_twd)}）`)) : null),
    h('div', { class: 'tiny muted' }, `${o.pickup || '—'}　${o.payment_status}${o.statement_id ? '・已出對帳單' : ''}`),
    h('div', { class: 'sr-items' }, ...o.items.map((i) => h('div', { class: 'sr-item' + (i.picked ? ' picked' : '') },
      i.source_image_url ? h('img', { class: 'thumb', src: i.source_image_url, alt: '' }) : h('div', { class: 'thumb ph' }, '📦'),
      h('div', { class: 'tiny' }, i.name, i.size ? `（${i.size}）` : '', ` ×${i.qty}`),
      h('div', { class: 'tiny ' + (i.item_status === '已到貨' ? 'ok' : 'muted') }, i.picked ? '✓ 先寄' : i.item_status))))));

  const decided = r.status !== 'pending'
    ? h('div', { class: 'tiny muted', style: 'margin-top:8px' },
      `${r.status_zh}・${dt(r.decided_at)}`, r.decision_note ? `・店家留言：${r.decision_note}` : '',
      r.ship_group ? `・出貨單 ${r.ship_group.ship_group_id}（${r.ship_group.status}）` : '')
    : null;

  return h('div', { class: 'card', style: 'padding:14px' },
    h('div', { class: 'row', style: 'gap:6px' },
      h('span', { class: 'tag ' + KIND_TONE[r.kind] }, r.kind_zh),
      h('strong', {}, r.nickname), r.member_no ? h('span', { class: 'tiny muted mono' }, r.member_no) : null,
      h('span', { class: 'spacer', style: 'flex:1' }),
      h('span', { class: 'tag ' + STATE_TONE[r.status] }, r.status_zh)),
    h('div', { class: 'tiny muted', style: 'margin:4px 0 8px' }, `申請時間 ${dt(r.created_at)}`, r.note ? `　客人備註：${r.note}` : ''),
    ...orders,
    decided,
    canDecide ? h('div', { class: 'row', style: 'gap:8px;margin-top:12px;justify-content:flex-end' },
      h('button', { class: 'btn', onClick: () => rejectDialog(r, ctx) }, '不核准'),
      h('button', { class: 'btn primary', onClick: () => approveDialog(r, ctx) }, '核准')) : null);
}

function approveDialog(r, ctx) {
  const note = h('input', { type: 'text', placeholder: '選填，例如：週五一起寄', maxlength: '200' });
  const fee = h('input', { type: 'number', min: '0', placeholder: '留空 = 照運費設定算', inputmode: 'numeric' });
  const o = r.orders[0];
  const canCharge = r.kind === 'split' && o && o.payment_status === '待付款' && !o.statement_id;
  const explain = r.kind === 'merge'
    ? `${r.order_ids.length} 張單會產生一張出貨單，寄到 ${o ? o.order_id : ''} 的地址；其他張的運費自動拿掉（已付款或已出對帳單的不動，核准後會列出來給你決定要不要退）。`
    : '已到貨的品項會拆成一張新訂單（狀態直接是「已到貨」），掛一張出貨單，可以馬上出貨。';
  modal(`核准${r.kind_zh}`, h('div', {},
    h('div', { class: 'banner info' }, explain),
    canCharge ? h('label', { class: 'field' }, h('span', {}, '先寄這箱的運費（NT$，0 = 不收）'), fee) : null,
    r.kind === 'split' && !canCharge ? h('div', { class: 'tiny muted' }, '這張單已付款或已出對帳單，先寄的那箱不另收運費。') : null,
    h('label', { class: 'field' }, h('span', {}, '給客人的話'), note)), [{
    label: '核准並通知客人', primary: true,
    onClick: async (close) => {
      const body = { request_id: r.request_id, decision_note: note.value || null };
      if (canCharge && fee.value !== '') body.extra_fee_twd = Number(fee.value);
      const res = await POST('/api/v1/ship-requests/approve', body);
      close();
      const x = res.result || {};
      if (r.kind === 'merge') {
        const saved = (x.fee_waived || []).reduce((s, w) => s + w.fee_twd, 0);
        toast(`已核准，出貨單 ${x.ship_group_id}${saved ? `，幫客人省下運費 ${nt(saved)}` : ''}`);
        if (x.fee_not_waived && x.fee_not_waived.length) {
          modal('有運費沒有自動拿掉', h('div', {},
            h('div', { class: 'banner warn' }, '下面這幾張單已經付款或出了對帳單，運費沒有動。要退給客人的話請另外處理。'),
            ...x.fee_not_waived.map((n) => h('div', { class: 'small' }, `${n.order_id}　運費 ${nt(n.fee_twd)}（${n.reason}）`))));
        }
      } else {
        toast(`已核准，拆出 ${x.child_order_id}${x.extra_fee_twd ? `，先寄運費 ${nt(x.extra_fee_twd)}` : ''}`);
      }
      ctx.reload();
    },
  }]);
}

function rejectDialog(r, ctx) {
  const note = h('input', { type: 'text', placeholder: '必填，客人會在 LINE 收到這段話', maxlength: '200' });
  const errBox = h('div', { class: 'tiny', role: 'alert', style: 'color:var(--red)' });
  modal(`不核准${r.kind_zh}`, h('div', {}, h('label', { class: 'field' }, h('span', {}, '原因'), note), errBox), [{
    label: '送出', primary: true,
    onClick: async (close) => {
      if (!note.value.trim()) { errBox.textContent = '請寫一下為什麼不行'; return; }
      await POST('/api/v1/ship-requests/reject', { request_id: r.request_id, decision_note: note.value.trim() });
      close(); toast('已回覆客人'); ctx.reload();
    },
  }]);
}

async function renderGroups(root, ctx) {
  const groups = await GET('/api/v1/ship-groups/list');
  root.append(h('div', { class: 'banner info' }, '出貨單 = 同一箱要裝的訂單。底下的單全部「已到貨」才能整箱出貨；物流單號填一次，每張單都會記上。'));
  if (!groups.length) { root.append(h('div', { class: 'card' }, h('div', { class: 'empty' }, '還沒有出貨單（核准出貨申請後會出現在這裡）'))); return; }
  const grid = h('div', { class: 'grid cols-2' });
  for (const g of groups) {
    const ready = g.status === '待出貨' && g.orders.every((o) => ['已到貨', '已出貨', '已送達', '已取消', '缺貨'].includes(o.status));
    grid.append(h('div', { class: 'card', style: 'padding:14px' },
      h('div', { class: 'row', style: 'gap:6px' },
        h('strong', { class: 'mono' }, g.ship_group_id), h('span', { class: 'tag ' + (g.status === '已出貨' ? 'green' : 'amber') }, g.status),
        h('span', { class: 'spacer', style: 'flex:1' }), h('span', { class: 'small' }, g.nickname)),
      h('div', { class: 'tiny muted', style: 'margin:4px 0 8px' }, `${g.pickup || '—'}　${g.pickup_addr || ''}`),
      ...g.orders.map((o) => h('div', { class: 'row', style: 'gap:6px;padding:4px 0' },
        h('span', { class: 'mono small' }, o.order_id), statusTag(o.status),
        h('span', { class: 'spacer', style: 'flex:1' }), 'total_twd' in o ? h('span', { class: 'tiny muted' }, nt(o.total_twd)) : null)),
      g.status === '待出貨' && session.can('shipment.write') ? h('div', { class: 'row', style: 'margin-top:10px;justify-content:flex-end' },
        ready ? h('button', { class: 'btn primary sm', onClick: () => shipDialog(g, ctx) }, '整箱出貨')
          : h('span', { class: 'tiny muted' }, '還有單沒到貨，到齊了才能寄')) : null));
  }
  root.append(grid);
}

function shipDialog(g, ctx) {
  const carrier = h('input', { type: 'text', placeholder: '例如：7-11 交貨便、黑貓' });
  const tracking = h('input', { type: 'text', placeholder: '選填' });
  const reason = h('input', { type: 'text', placeholder: '有單還沒付款時必填（店主才能覆寫）' });
  modal(`整箱出貨 ${g.ship_group_id}`, h('div', {},
    h('div', { class: 'small', style: 'margin-bottom:8px' }, `這一箱裝：${g.order_ids.join('、')}`),
    h('label', { class: 'field' }, h('span', {}, '物流'), carrier),
    h('label', { class: 'field' }, h('span', {}, '物流單號'), tracking),
    h('label', { class: 'field' }, h('span', {}, '覆寫原因'), reason)), [{
    label: '確認出貨', primary: true,
    onClick: async (close) => {
      const r = await POST('/api/v1/ship-groups/ship', { ship_group_id: g.ship_group_id,
        carrier: carrier.value || null, tracking_no: tracking.value || null, override_reason: reason.value || null });
      close(); toast(`已出貨 ${r.shipped.length} 張單，出貨通知已排入 LINE`); ctx.reload();
    },
  }]);
}
