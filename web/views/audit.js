import { GET, h, dt, roleLabel } from '/app.js';
import { describe } from '/views/audit-text.js';

/**
 * 稽核軌跡：誰、在什麼時候、做了什麼。可依日期、人、結果篩選。
 * 每一筆都翻成一句白話（見 audit-text.js），畫面上不出現程式代碼或內部編號。
 */
export async function render(root) {
  const members = await GET('/api/v1/members/list');
  const state = { actor: '', result: '', from: '', to: '' };
  const tbody = h('tbody', {});
  const shipBody = h('tbody', {});

  // 人一律顯示成「稱呼（會員編號）」。
  const label = (m) => `${m.nickname}（${m.member_no || roleLabel(m.role)}）`;
  const byId = new Map(members.map((m) => [m.line_user_id, m]));
  const person = (id) => (byId.has(id) ? label(byId.get(id)) : '—');

  const filters = h('div', { class: 'card-head' },
    h('h2', {}, '操作紀錄'), h('div', { class: 'spacer' }),
    h('select', { id: 'audit-actor', style: 'width:170px', onChange: (e) => { state.actor = e.target.value; load(); } },
      h('option', { value: '' }, '所有人'),
      ...members.filter((m) => m.role !== 'buyer').map((m) => h('option', { value: m.line_user_id }, label(m)))),
    h('select', { id: 'audit-result', style: 'width:130px', onChange: (e) => { state.result = e.target.value; load(); } },
      h('option', { value: '' }, '所有結果'),
      h('option', { value: 'ok' }, '正常'),
      h('option', { value: 'warn' }, '例外放行'),
      h('option', { value: 'blocked' }, '被擋下')),
    h('label', { class: 'tiny muted', for: 'audit-from' }, '從'),
    h('input', { id: 'audit-from', type: 'date', style: 'width:150px', onChange: (e) => { state.from = e.target.value ? e.target.value + 'T00:00:00+08:00' : ''; load(); } }),
    h('label', { class: 'tiny muted', for: 'audit-to' }, '到'),
    h('input', { id: 'audit-to', type: 'date', style: 'width:150px', onChange: (e) => { state.to = e.target.value ? e.target.value + 'T23:59:59.999+08:00' : ''; load(); } }));

  root.append(h('div', { class: 'card' },
    h('div', { class: 'card-body' }, h('div', { class: 'banner info', style: 'margin:0' },
      '這裡記下後台每一個會影響訂單、金額、權限的操作。「例外放行」是有人填了原因、跳過系統的檢查；「被擋下」是系統拒絕了這次操作。'))));

  root.append(h('div', { class: 'card' }, filters,
    h('div', { class: 'table-wrap' }, h('table', { class: 'stack' },
      h('thead', {}, h('tr', {}, h('th', {}, '時間'), h('th', {}, '誰'), h('th', {}, '做了什麼'), h('th', {}, '結果'), h('th', {}, '說明'))),
      tbody))));

  root.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, '出貨紀錄')),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, '訂單'), h('th', {}, '客人'), h('th', {}, '出貨時間'), h('th', {}, '有沒有掃碼核對'), h('th', {}, '經手人'), h('th', {}, '例外原因'))),
      shipBody))));

  async function load() {
    const qs = new URLSearchParams({ limit: '300' });
    for (const k of ['actor', 'result', 'from', 'to']) if (state[k]) qs.set(k, state[k]);
    const [logs, ships] = await Promise.all([GET('/api/v1/audit/list?' + qs), GET('/api/v1/shipments/list')]);

    tbody.innerHTML = '';
    if (!logs.length) tbody.append(h('tr', {}, h('td', { colspan: '5', class: 'empty' }, '沒有符合的紀錄')));
    for (const l of logs) {
      const x = describe(l);
      tbody.append(h('tr', {},
        h('td', { class: 'tiny muted', style: 'white-space:nowrap' }, dt(l.ts)),
        h('td', { class: 'small', style: 'white-space:nowrap' }, x.who),
        h('td', {}, x.what),
        h('td', {}, h('span', { class: 'tag ' + x.result.tone }, x.result.text)),
        h('td', { class: 'small muted' }, x.note || '')));
    }

    shipBody.innerHTML = '';
    if (!ships.length) shipBody.append(h('tr', {}, h('td', { colspan: '6', class: 'empty' }, '還沒有出貨紀錄')));
    for (const s of ships) {
      shipBody.append(h('tr', {},
        h('td', { class: 'mono' }, s.order_id), h('td', {}, s.nickname), h('td', { class: 'tiny muted' }, dt(s.shipped_at)),
        h('td', {}, s.verified_by_scan
          ? h('span', { class: 'tag green' }, '有，掃碼核對過')
          : h('span', { class: 'tag amber' }, '沒有，手動出貨')),
        h('td', {}, person(s.operator)),
        h('td', { class: 'small' }, s.override_reason || '—')));
    }
  }
  await load();
}
