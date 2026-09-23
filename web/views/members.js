import { GET, POST, h, dt, toast, fail, roleLabel } from '/app.js';

/**
 * 成員與權限。店主在這裡把客人升為小幫手／理貨，或調回客人；也能用 LINE userId
 * 直接加一位還沒開過前台的員工。店主這個角色本身不能在這裡給或拿 —— 那只能由
 * 系統管理者改資料庫（見 server/routes/admin-config.js）。
 */
const ROLES = ['helper', 'packer', 'buyer'];
const ROLE_NOTE = {
  owner: '全部功能，含成本、毛利、收款',
  helper: '訂單、報價、採購、出貨；看不到成本與毛利',
  packer: '理貨、標籤、掃碼出貨；看不到價格',
  buyer: '不能進後台',
};

export async function render(root, ctx) {
  const q = ctx.query.q || '';
  const data = await GET('/api/v1/members/admin-list' + (q ? '?q=' + encodeURIComponent(q) : ''));

  root.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, '角色說明')),
    h('div', { class: 'card-body' },
      h('div', { class: 'grid cols-2' }, ...['owner', 'helper', 'packer', 'buyer'].map((r) =>
        h('div', {}, h('span', { class: 'tag' + (r === 'owner' ? ' blue' : '') }, roleLabel(r)), ' ',
          h('span', { class: 'small muted' }, ROLE_NOTE[r])))),
      h('div', { class: 'banner info', style: 'margin-top:12px' },
        '店主權限不能在這裡給或取消，要調整請聯絡系統管理者。每一次調整都會記在稽核軌跡。'))));

  const roleSelect = (m) => {
    if (m.role === 'owner' || m.line_user_id === data.me) return h('span', { class: 'tag' + (m.role === 'owner' ? ' blue' : '') }, roleLabel(m.role));
    const sel = h('select', { style: 'width:120px' },
      ...ROLES.map((r) => h('option', { value: r, selected: r === m.role }, roleLabel(r))));
    sel.addEventListener('change', async () => {
      const before = m.role;
      sel.disabled = true;
      try {
        const r = await POST('/api/v1/members/set-role', { line_user_id: m.line_user_id, role: sel.value });
        m.role = r.member.role;
        toast(`${m.nickname} 已改為${roleLabel(m.role)}`);
        ctx.reload();
      } catch (e) { sel.value = before; fail(e); }
      finally { sel.disabled = false; }
    });
    return sel;
  };

  const table = (rows, empty) => h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, '稱呼'), h('th', {}, 'LINE 名稱'), h('th', {}, 'LINE userId'),
      h('th', {}, '加入時間'), h('th', {}, '角色'))),
    h('tbody', {}, ...(rows.length ? rows.map((m) => h('tr', {},
      h('td', {}, m.nickname, m.line_user_id === data.me ? h('span', { class: 'tiny muted' }, '（你）') : null),
      h('td', { class: 'small muted' }, m.display_name || '—'),
      h('td', { class: 'mono tiny' }, m.line_user_id),
      h('td', { class: 'tiny muted' }, dt(m.created_at)),
      h('td', {}, roleSelect(m))))
      : [h('tr', {}, h('td', { colspan: '5', class: 'empty' }, empty))]))));

  root.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, `員工（${data.staff.length}）`)),
    table(data.staff, '還沒有員工')));

  // ---- 從客人名單升級 ----
  const search = h('input', { type: 'text', value: q, placeholder: '搜尋稱呼、LINE 名稱或 userId', style: 'width:260px' });
  const go = () => { location.hash = '#/members' + (search.value.trim() ? '?q=' + encodeURIComponent(search.value.trim()) : ''); };
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  root.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, q ? `客人：「${q}」的搜尋結果` : '最近加入的客人'), h('div', { class: 'spacer' }),
      search, h('button', { class: 'btn sm', onClick: go }, '搜尋')),
    h('div', { class: 'card-body' }, h('div', { class: 'banner info' },
      '員工請先用自己的 LINE 打開一次買家頁面，就會出現在這裡，再把角色改成小幫手或理貨即可。')),
    table(data.buyers, q ? '找不到符合的客人' : '還沒有客人')));

  // ---- 用 LINE userId 直接新增 ----
  const f = {
    id: h('input', { type: 'text', placeholder: 'U 開頭，共 33 碼', style: 'width:320px' }),
    nick: h('input', { type: 'text', placeholder: '後台顯示的稱呼', maxlength: '20' }),
    role: h('select', {}, ...['helper', 'packer'].map((r) => h('option', { value: r }, roleLabel(r)))),
  };
  root.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, '用 LINE userId 新增員工')),
    h('div', { class: 'card-body' },
      h('p', { class: 'small muted', style: 'margin-top:0' }, '員工沒辦法先開買家頁面時才用這個方法；LINE userId 不是 LINE ID，請向系統管理者索取。'),
      h('div', { class: 'row', style: 'flex-wrap:wrap;gap:10px' },
        h('label', { class: 'field' }, h('span', {}, 'LINE userId'), f.id),
        h('label', { class: 'field' }, h('span', {}, '稱呼'), f.nick),
        h('label', { class: 'field' }, h('span', {}, '角色'), f.role)),
      h('button', { class: 'btn primary', onClick: async () => {
        try {
          const r = await POST('/api/v1/members/add', { line_user_id: f.id.value.trim(), nickname: f.nick.value.trim(), role: f.role.value });
          toast(`已新增 ${r.member.nickname}（${roleLabel(r.member.role)}）`);
          ctx.reload();
        } catch (e) { fail(e); }
      } }, '新增員工'))));
}
