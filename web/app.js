/**
 * SPA shell: session, hash router, shared UI helpers.
 * The frontend holds no business rules — it renders what the API returns and
 * every guard it shows is also enforced server-side (README F-21 強制規則).
 */
const TOKEN_KEY = 'hb.token';

export const session = {
  token: localStorage.getItem(TOKEN_KEY) || null,
  member: null,
  caps: [],
  can(cap) { return this.caps.includes(cap); },
};

export async function api(method, path, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (session.token) headers.Authorization = `Bearer ${session.token}`;
  if (method === 'POST') headers['Idempotency-Key'] = opts.idempotencyKey || crypto.randomUUID();
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json;
  try { json = await res.json(); } catch { json = { ok: false, error: { code: 'BAD_RESPONSE', message: '系統忙碌中，稍後再試' } }; }
  if (!json.ok) {
    const err = new Error(json.error?.message || '操作失敗');
    err.code = json.error?.code;
    err.status = res.status;
    throw err;
  }
  return json.data;
}
export const GET = (p) => api('GET', p);
export const POST = (p, b, o) => api('POST', p, b, o);

// ---- tiny DOM helpers ----------------------------------------------------
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const nt = (n) => n == null ? '—' : 'NT$' + Number(n).toLocaleString('zh-TW', { maximumFractionDigits: 0 });
export const jpy = (n) => n == null ? '—' : '¥' + Number(n).toLocaleString('ja-JP', { maximumFractionDigits: 0 });
export const pct = (n) => n == null ? '—' : `${Number(n).toFixed(1)}%`;
export const dt = (s) => s ? new Date(s).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

let toastTimer;
export function toast(msg, kind = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast ' + kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3600);
}
export const fail = (e) => toast(e.message || '操作失敗', 'err');

export function modal(title, bodyNode, actions = []) {
  const host = document.getElementById('modal');
  const close = () => { host.hidden = true; host.innerHTML = ''; };
  const sheet = h('div', { class: 'sheet' },
    h('div', { class: 'card-head' }, h('h2', {}, title), h('div', { class: 'spacer' }),
      h('button', { class: 'btn ghost sm', onClick: close }, '✕')),
    h('div', { class: 'card-body' }, bodyNode),
    actions.length ? h('div', { class: 'card-head', style: 'border-top:1px solid var(--line);border-bottom:0;justify-content:flex-end' },
      ...actions.map((a) => h('button', {
        class: 'btn ' + (a.primary ? 'primary' : ''),
        onClick: async () => { try { await a.onClick(close); } catch (e) { fail(e); } },
      }, a.label))) : null);
  host.innerHTML = '';
  host.append(sheet);
  host.hidden = false;
  host.onclick = (e) => { if (e.target === host) close(); };
  return close;
}

export const STATUS_TONE = {
  '願望清單': '', '待付款': 'amber', '待採購': 'blue', '部分到貨': 'amber',
  '待出貨': 'blue', '已出貨': 'green', '已完成': 'green',
  '待退款': 'red', '已退款': '', '已取消': '',
};
export const statusTag = (s) => h('span', { class: 'tag ' + (STATUS_TONE[s] || '') }, s);

// ---- routes --------------------------------------------------------------
const ROUTES = [
  { path: 'dashboard', title: '營運儀表板', icon: '◎', cap: 'order.read', mod: () => import('/views/dashboard.js') },
  { path: 'orders', title: '訂單管理', icon: '▤', cap: 'order.read', mod: () => import('/views/orders.js') },
  { path: 'board', title: '現場採購看板', icon: '◍', cap: 'procurement.read', mod: () => import('/views/board.js'), group: '採購' },
  { path: 'expense', title: '拍照請款', icon: '¥', cap: 'procurement.write', mod: () => import('/views/expense.js') },
  { path: 'packing', title: '看圖理貨', icon: '❏', cap: 'shipment.write', mod: () => import('/views/packing.js'), group: '出貨' },
  { path: 'labels', title: 'QR 標籤列印', icon: '▩', cap: 'shipment.write', mod: () => import('/views/labels.js') },
  { path: 'scan', title: '掃碼核對工作站', icon: '⌁', cap: 'shipment.write', mod: () => import('/views/scan.js') },
  { path: 'logistics', title: '進貨物流綁定', icon: '⇄', cap: 'shipment.write', mod: () => import('/views/logistics.js') },
  { path: 'audit', title: '稽核軌跡', icon: '☰', cap: 'audit.read', mod: () => import('/views/audit.js'), group: '設定' },
  { path: 'settings', title: '匯率與團別', icon: '⚙', cap: 'order.read', mod: () => import('/views/settings.js') },
];

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [path, qs] = raw.split('?');
  return { path, query: Object.fromEntries(new URLSearchParams(qs || '')) };
}

function renderNav(active) {
  const nav = document.getElementById('sidebar');
  nav.innerHTML = '';
  nav.append(h('div', { class: 'brand' }, 'HEEEHABABY', h('small', {}, '代購營運後台 · 雛型')));
  let group = null;
  for (const r of ROUTES) {
    if (!session.can(r.cap)) continue;
    if (r.group && r.group !== group) { group = r.group; nav.append(h('div', { class: 'nav-group' }, group)); }
    nav.append(h('a', { class: 'navlink' + (r.path === active ? ' active' : ''), href: `#/${r.path}` },
      h('span', { class: 'ico' }, r.icon), r.title));
  }
  nav.append(h('div', { class: 'sidebar-foot' },
    h('div', {}, session.member ? `${session.member.nickname}（${roleLabel(session.member.role)}）` : ''),
    h('button', { class: 'btn ghost sm', style: 'padding-left:0', onClick: logout }, '切換身分 / 登出')));
}

export const roleLabel = (r) => ({ owner: '店主', helper: '小幫手', packer: '理貨', buyer: '買家' }[r] || r);

function renderTop(title, extra) {
  const bar = document.getElementById('topbar');
  bar.innerHTML = '';
  bar.append(h('h1', {}, title), h('div', { class: 'spacer' }));
  if (extra) bar.append(extra);
  if (session.member) {
    bar.append(h('div', { class: 'who' },
      h('div', { class: 'avatar' }, session.member.nickname.slice(0, 1)),
      h('div', {}, session.member.nickname, h('div', { class: 'tiny muted' }, roleLabel(session.member.role)))));
  }
}

export function logout() {
  localStorage.removeItem(TOKEN_KEY);
  session.token = null; session.member = null; session.caps = [];
  location.hash = '';
  boot();
}

async function renderLogin() {
  document.getElementById('app').style.display = 'none';
  const personas = await (await fetch('/api/v1/auth/personas')).json();
  const box = h('div', { class: 'login' },
    h('div', { class: 'box' },
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, 'HEEEHABABY 代購營運後台')),
        h('div', { class: 'card-body' },
          h('p', { class: 'muted small', style: 'margin-top:0' },
            '雛型以身分切換代替 LINE 登入。正式版此處為 LIFF ID Token 驗證（I-02），角色一律由伺服器判定。'),
          h('div', { class: 'grid', style: 'gap:8px' },
            ...personas.data.map((p) => h('button', {
              class: 'persona',
              onClick: async () => {
                try {
                  const data = await POST('/api/v1/auth/login', { line_user_id: p.line_user_id });
                  localStorage.setItem(TOKEN_KEY, data.token);
                  session.token = data.token;
                  location.hash = '#/dashboard';
                  boot();
                } catch (e) { fail(e); }
              },
            },
              h('div', { class: 'avatar' }, p.nickname.slice(0, 1)),
              h('div', {}, h('div', {}, p.nickname), h('div', { class: 'tiny muted' }, `${roleLabel(p.role)} · ${p.line_user_id}`)),
              h('div', { class: 'spacer', style: 'flex:1' }),
              h('span', { class: 'tag' }, roleLabel(p.role)))))))));
  document.body.append(box);
}

let currentLogin = null;

export async function boot() {
  document.querySelectorAll('.login').forEach((n) => n.remove());
  if (!session.token) return renderLogin();
  try {
    const me = await GET('/api/v1/auth/me');
    session.member = me.member;
    session.caps = me.capabilities;
  } catch {
    localStorage.removeItem(TOKEN_KEY);
    session.token = null;
    return renderLogin();
  }
  document.getElementById('app').style.display = '';
  route();
}

async function route() {
  if (!session.member) return;
  const { path, query } = parseHash();
  const r = ROUTES.find((x) => x.path === path) || ROUTES[0];
  if (!session.can(r.cap)) {
    const first = ROUTES.find((x) => session.can(x.cap));
    if (first && first.path !== path) { location.hash = `#/${first.path}`; return; }
  }
  renderNav(r.path);
  renderTop(r.title);
  const view = document.getElementById('view');
  view.innerHTML = '<div class="empty">載入中…</div>';
  try {
    const mod = await r.mod();
    view.innerHTML = '';
    await mod.render(view, { query, setTopbar: (node) => renderTop(r.title, node), reload: route });
  } catch (e) {
    view.innerHTML = '';
    view.append(h('div', { class: 'card' }, h('div', { class: 'empty' }, e.message || '載入失敗')));
  }
}

window.addEventListener('hashchange', route);
boot();
