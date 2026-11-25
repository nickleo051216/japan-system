import { GET, POST, h, dt, toast, fail, roleLabel, modal } from '../app.js';

/**
 * 成員與權限。店主在這裡把客人升為小幫手／理貨，或調回客人。
 * 員工的建檔流程：先用自己的 LINE 打開一次買家頁面（自動建檔、配會員編號），
 * 店家再用稱呼或會員編號找到人、改角色。畫面上一律用會員編號，不顯示 LINE userId。
 * 店主這個角色本身不能在這裡給或拿 —— 那只能由系統管理者改資料庫
 * （見 server/routes/admin-config.js）。
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

  root.append(await inviteCard(ctx));

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

  // 喊單資格：有棄單紀錄才顯示。對帳單付清會自動恢復；這顆按鈕給店主通融用。
  const dropsCell = (m) => {
    if (!(m.shout_drops > 0)) return h('span', { class: 'tiny muted' }, '正常');
    const btn = h('button', { class: 'btn sm', onClick: async () => {
      if (!confirm(`恢復 ${m.nickname} 的喊單資格？棄單 ${m.shout_drops} 次會歸零，這個動作會記在稽核軌跡。`)) return;
      btn.disabled = true;
      try {
        await POST('/api/v1/members/reset-drops', { line_user_id: m.line_user_id });
        toast(`${m.nickname} 的喊單資格已恢復`);
        ctx.reload();
      } catch (e) { fail(e); btn.disabled = false; }
    } }, '恢復資格');
    return h('div', {}, h('span', { class: 'tag amber' }, `棄單 ${m.shout_drops} 次`), ' ', btn);
  };

  const table = (rows, empty) => h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, '稱呼'), h('th', {}, 'LINE 名稱'), h('th', {}, '會員編號'),
      h('th', {}, '加入時間'), h('th', {}, '喊單'), h('th', {}, '角色'))),
    h('tbody', {}, ...(rows.length ? rows.map((m) => h('tr', {},
      h('td', {}, m.nickname, m.line_user_id === data.me ? h('span', { class: 'tiny muted' }, '（你）') : null),
      h('td', { class: 'small muted' }, m.display_name || '—'),
      h('td', { class: 'mono small' }, m.member_no || '—'),
      h('td', { class: 'tiny muted' }, dt(m.created_at)),
      h('td', {}, dropsCell(m)),
      h('td', {}, roleSelect(m))))
      : [h('tr', {}, h('td', { colspan: '6', class: 'empty' }, empty))]))));

  // ---- 搜尋：員工與客人一起找（用會員編號找自己也要找得到）----
  const search = h('input', { id: 'member-search', type: 'search', value: q, placeholder: '稱呼、LINE 名稱或會員編號（例：HB-00001）', style: 'width:320px' });
  const go = () => { location.hash = '#/members' + (search.value.trim() ? '?q=' + encodeURIComponent(search.value.trim()) : ''); };
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  root.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, '找人'), h('div', { class: 'spacer' }),
      search, h('button', { class: 'btn sm primary', onClick: go }, '搜尋'),
      q ? h('button', { class: 'btn sm', onClick: () => { location.hash = '#/members'; } }, '清除') : null)));

  root.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, q ? `員工：「${q}」的搜尋結果（${data.staff.length}）` : `員工（${data.staff.length}）`)),
    table(data.staff, q ? '沒有符合的員工' : '還沒有員工')));

  root.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, q ? `客人：「${q}」的搜尋結果（${data.buyers.length}）` : '最近加入的客人')),
    h('div', { class: 'card-body' }, h('div', { class: 'banner info' },
      '新員工：請他先用自己的 LINE 打開一次買家頁面，系統就會自動建檔、給他一個會員編號（例如 HB-00012）。'
      + '請他把會員編號告訴你，在這裡搜尋後把角色改成小幫手或理貨即可。')),
    table(data.buyers, q ? '找不到符合的客人' : '還沒有客人')));
}

/**
 * 邀請碼（v1.6 ⑤）：店主開一組碼給新的小幫手或包貨人員，對方用自己的 LINE 登入後台時輸入就加入，
 * 不用再互傳會員編號。碼只在開的那一刻顯示一次（系統只存雜湊），忘了就作廢再開一組。
 */
async function inviteCard(ctx) {
  let invites = [];
  try { invites = await GET('/api/v1/staff-invites/list'); } catch { /* 015 還沒跑 */ }
  const role = h('select', {}, h('option', { value: 'helper' }, '日本小幫手'), h('option', { value: 'packer' }, '包貨人員'));
  const uses = h('select', {}, ...[1, 2, 3, 5].map((n) => h('option', { value: String(n) }, `${n} 個人`)));
  const hours = h('select', {}, h('option', { value: '24' }, '1 天內'), h('option', { value: '72', selected: true }, '3 天內'), h('option', { value: '168' }, '7 天內'));
  const note = h('input', { type: 'text', placeholder: '備註（例如：大阪小美）', maxlength: '60' });
  const create = async () => {
    try {
      const r = await POST('/api/v1/staff-invites/create', { role: role.value, max_uses: Number(uses.value), hours: Number(hours.value), note: note.value || null });
      const adminUrl = location.origin + location.pathname;
      const msg = `邀請你加入 HEEEHABABY 後台（${r.role_zh}）\n1. 用 LINE 打開 ${adminUrl}\n2. 在「邀請碼」輸入：${r.code}\n3. 按「用 LINE 登入」\n（${dt(r.expires_at)} 前有效）`;
      modal('邀請碼開好了', h('div', {},
        h('div', { class: 'invite-code mono' }, r.code),
        h('div', { class: 'banner warn' }, '這組碼只會顯示這一次，請現在傳給對方。忘了就作廢再開一組。'),
        h('pre', { class: 'small', style: 'white-space:pre-wrap;margin:8px 0 0;font:inherit' }, msg)), [{
        label: '複製整段訊息', primary: true,
        onClick: async (close) => { try { await navigator.clipboard.writeText(msg); toast('已複製，貼到 LINE 傳給對方'); } catch { toast('複製失敗，請長按文字自己複製', 'err'); } close(); ctx.reload(); },
      }]);
    } catch (e) { fail(e); }
  };
  const TONE = { active: 'green', used_up: '', expired: 'amber', revoked: 'red' };
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, '邀請碼（加入新的小幫手）')),
    h('div', { class: 'card-body' },
      h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' }, role, uses, hours, note,
        h('button', { class: 'btn primary', onClick: create }, '開一組邀請碼')),
      invites.length ? h('div', { style: 'display:grid;gap:6px;margin-top:12px' }, ...invites.slice(0, 10).map((i) => h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' },
        h('span', { class: 'mono small' }, `••••-••${i.code_hint}`),
        h('span', { class: 'tag' }, i.role_zh), h('span', { class: 'tag ' + TONE[i.state] }, i.state_zh),
        h('span', { class: 'tiny muted' }, `${i.used_count}/${i.max_uses} 人・${dt(i.expires_at)} 到期${i.note ? '・' + i.note : ''}`),
        i.used_by.length ? h('span', { class: 'tiny' }, '已加入：' + i.used_by.map((u) => u.nickname).join('、')) : null,
        h('span', { class: 'spacer', style: 'flex:1' }),
        i.state === 'active' ? h('button', { class: 'btn ghost sm', onClick: async () => {
          if (!confirm('作廢這組邀請碼？還沒用的人就不能用了。')) return;
          try { await POST('/api/v1/staff-invites/revoke', { invite_id: i.invite_id }); toast('已作廢'); ctx.reload(); } catch (e) { fail(e); }
        } }, '作廢') : null)))
        : h('div', { class: 'tiny muted', style: 'margin-top:8px' }, '對方要先用自己的 LINE 打開一次買家頁面（建檔），再到後台登入頁輸入邀請碼。')));
}
