import { GET, h, dt, roleLabel } from '/app.js';

/** F-19 出貨稽核軌跡 — 可依日期、操作者、結果篩選。 */
export async function render(root) {
  const members = await GET('/api/v1/members/list');
  const state = { actor: '', result: '', from: '', to: '' };
  const tbody = h('tbody', {});
  const shipBody = h('tbody', {});

  const filters = h('div', { class: 'card-head' },
    h('h2', {}, '稽核軌跡'), h('div', { class: 'spacer' }),
    h('select', { style: 'width:150px', onChange: (e) => { state.actor = e.target.value; load(); } },
      h('option', { value: '' }, '所有操作者'),
      ...members.map((m) => h('option', { value: m.line_user_id }, `${m.nickname}（${roleLabel(m.role)}）`))),
    h('select', { style: 'width:130px', onChange: (e) => { state.result = e.target.value; load(); } },
      h('option', { value: '' }, '所有結果'),
      h('option', { value: 'ok' }, 'ok 正常'),
      h('option', { value: 'warn' }, 'warn 覆寫/例外'),
      h('option', { value: 'blocked' }, 'blocked 被擋下')),
    h('input', { type: 'date', style: 'width:150px', onChange: (e) => { state.from = e.target.value ? e.target.value + 'T00:00:00.000Z' : ''; load(); } }),
    h('input', { type: 'date', style: 'width:150px', onChange: (e) => { state.to = e.target.value ? e.target.value + 'T23:59:59.999Z' : ''; load(); } }));

  root.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, '出貨紀錄')),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, '訂單'), h('th', {}, '客人'), h('th', {}, '出貨時間'), h('th', {}, '是否經掃碼'), h('th', {}, '操作人'), h('th', {}, '覆寫原因'))),
      shipBody))));

  root.append(h('div', { class: 'card' }, filters,
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, '時間'), h('th', {}, '操作者'), h('th', {}, '動作'), h('th', {}, '對象'), h('th', {}, '結果'), h('th', {}, '細節'))),
      tbody))));

  const nick = (id) => { const m = members.find((x) => x.line_user_id === id); return m ? m.nickname : (id || '—'); };

  async function load() {
    const qs = new URLSearchParams({ limit: '300' });
    for (const k of ['actor', 'result', 'from', 'to']) if (state[k]) qs.set(k, state[k]);
    const [logs, ships] = await Promise.all([GET('/api/v1/audit/list?' + qs), GET('/api/v1/shipments/list')]);

    shipBody.innerHTML = '';
    if (!ships.length) shipBody.append(h('tr', {}, h('td', { colspan: '6', class: 'empty' }, '尚無出貨紀錄')));
    for (const s of ships) {
      shipBody.append(h('tr', {},
        h('td', { class: 'mono' }, s.order_id), h('td', {}, s.nickname), h('td', { class: 'tiny muted' }, dt(s.shipped_at)),
        h('td', {}, s.verified_by_scan
          ? h('span', { class: 'tag green' }, '✓ 經掃碼核對')
          : h('span', { class: 'tag amber' }, '未經核對（手動出貨）')),
        h('td', {}, nick(s.operator)),
        h('td', { class: 'small' }, s.override_reason || '—')));
    }

    tbody.innerHTML = '';
    if (!logs.length) tbody.append(h('tr', {}, h('td', { colspan: '6', class: 'empty' }, '沒有符合的紀錄')));
    for (const l of logs) {
      tbody.append(h('tr', {},
        h('td', { class: 'tiny muted' }, dt(l.ts)),
        h('td', {}, nick(l.actor)),
        h('td', { class: 'mono tiny' }, l.action),
        h('td', { class: 'mono tiny' }, l.target || '—'),
        h('td', {}, h('span', { class: 'tag ' + (l.result === 'ok' ? 'green' : l.result === 'warn' ? 'amber' : 'red') }, l.result)),
        h('td', { class: 'tiny muted' }, l.detail ? JSON.stringify(l.detail) : '')));
    }
  }
  await load();
}
