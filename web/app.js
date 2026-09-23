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

function closeModal() {
  const host = document.getElementById('modal');
  if (host) { host.hidden = true; host.innerHTML = ''; }
}
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

export function modal(title, bodyNode, actions = []) {
  const host = document.getElementById('modal');
  const close = closeModal;
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
  '待確認': 'amber', '已報價': 'blue', '已到貨': 'blue',
  '已出貨': 'green', '已送達': 'green',
  '缺貨': 'red', '已取消': '',
};
export const statusTag = (s) => h('span', { class: 'tag ' + (STATUS_TONE[s] || '') }, s);

// ---- routes --------------------------------------------------------------
const ROUTES = [
  { path: 'dashboard', title: '營運儀表板', icon: '◎', cap: 'order.read', mod: () => import('/views/dashboard.js') },
  { path: 'orders', title: '訂單管理', icon: '▤', cap: 'order.read', mod: () => import('/views/orders.js') },
  { path: 'statements', title: '對帳單', icon: '$', cap: 'payment.reconcile', mod: () => import('/views/statements.js') },
  { path: 'shop', title: '開團與喊單', icon: '✦', cap: 'broadcast', mod: () => import('/views/shop.js'), group: '上架' },
  { path: 'wishes', title: '許願報價', icon: '♡', cap: 'order.read', mod: () => import('/views/wishes.js') },
  { path: 'board', title: '現場採購看板', icon: '◍', cap: 'procurement.read', mod: () => import('/views/board.js'), group: '採購' },
  { path: 'expense', title: '拍照請款', icon: '¥', cap: 'procurement.write', mod: () => import('/views/expense.js') },
  { path: 'packing', title: '看圖理貨', icon: '❏', cap: 'shipment.write', mod: () => import('/views/packing.js'), group: '出貨' },
  { path: 'labels', title: 'QR 標籤列印', icon: '▩', cap: 'shipment.write', mod: () => import('/views/labels.js') },
  { path: 'scan', title: '掃碼核對工作站', icon: '⌁', cap: 'shipment.write', mod: () => import('/views/scan.js') },
  { path: 'logistics', title: '進貨物流綁定', icon: '⇄', cap: 'shipment.write', mod: () => import('/views/logistics.js') },
  { path: 'audit', title: '稽核軌跡', icon: '☰', cap: 'audit.read', mod: () => import('/views/audit.js'), group: '設定' },
  { path: 'settings', title: '匯率、價目表與團別', icon: '⚙', cap: 'order.read', mod: () => import('/views/settings.js') },
  { path: 'members', title: '成員與權限', icon: '☺', cap: 'settings.write', mod: () => import('/views/members.js') },
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
  // LINE 那邊也要登出，否則回到登入頁會被自動登回同一個帳號，永遠換不了人。
  try { if (window.liff && window.liff.isLoggedIn && window.liff.isLoggedIn()) window.liff.logout(); } catch { /* 還沒初始化就不必登出 */ }
  location.hash = '';
  boot();
}

// ---- 登入 ------------------------------------------------------------------
//
// 正門是 LINE 登入：後台頁面本身就是一個 LIFF app（ADMIN_LIFF_ID），登入後把
// ID Token 交給後端換 session token。白名單是 members，只有員工進得來。
// 共用密碼是過渡期的側門，給系統管理者用；ADMIN_PASSWORD_LOGIN=off 之後就不再顯示。

const LIFF_SDK = 'https://static.line-scdn.net/liff/edge/2/sdk.js';

function loadLiff() {
  if (window.liff) return Promise.resolve(window.liff);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = LIFF_SDK;
    s.onload = () => resolve(window.liff);
    s.onerror = () => reject(new Error('LINE 登入元件載入失敗，請檢查網路後重新整理'));
    document.head.append(s);
  });
}

function signedIn(data) {
  localStorage.setItem(TOKEN_KEY, data.token);
  session.token = data.token;
  // LINE 登入回來時網址會帶一串 code/state，換到 token 之後就沒用了，清掉。
  if (location.search) history.replaceState(null, '', location.pathname + '#/dashboard');
  else location.hash = '#/dashboard';
  boot();
}

/**
 * 走一次 LINE 登入。interactive=false 用在剛從 LINE 導回來、或本來就登入著 LINE 的時候：
 * 能直接換到 token 就換，不行就回 null，讓登入頁顯示按鈕。
 */
async function lineLogin(liffId, interactive) {
  const liff = await loadLiff();
  await liff.init({ liffId });
  if (!liff.isLoggedIn()) {
    if (interactive) liff.login({ redirectUri: location.origin + '/' });
    return null;
  }
  const idToken = liff.getIDToken();
  if (!idToken) throw new Error('拿不到 LINE 身分。LIFF app 需要勾選 openid 權限，請聯絡系統管理者');
  try {
    signedIn(await POST('/api/v1/auth/line', { id_token: idToken }));
    return true;
  } catch (e) {
    // 驗不過（多半是 ID Token 過期）或不是員工：都先登出 LINE，下一次才能換帳號或重新取得。
    try { liff.logout(); } catch { /* ignore */ }
    if (e.code === 'UNAUTHENTICATED') throw new Error('LINE 登入已過期，請再按一次「用 LINE 登入」');
    throw e;
  }
}

async function renderLogin(err = null) {
  document.getElementById('app').style.display = 'none';
  document.querySelectorAll('.login').forEach((n) => n.remove());

  let cfg = { line: { ready: false }, password: true };
  try { cfg = await GET('/api/v1/auth/config'); } catch { /* 舊版後端沒有這支：只顯示密碼入口 */ }

  // 剛從 LINE 導回來（或本來就登入著 LINE）就直接完成登入，不必再按一次。
  if (cfg.line.ready && !err) {
    try { if (await lineLogin(cfg.line.liff_id, false)) return; } catch (e) { err = e.message; }
  }

  const errLine = err ? h('p', { class: 'small', style: 'color:var(--bad,#a8241c); margin:0 0 8px; word-break:break-all' }, err) : null;
  const lineButton = cfg.line.ready
    ? h('button', {
      class: 'btn primary', style: 'background:#06c755;border-color:#06c755',
      onClick: async () => {
        try { await lineLogin(cfg.line.liff_id, true); } catch (e) { renderLogin(e.message); }
      },
    }, '用 LINE 登入')
    : null;

  const passwordArea = h('div', { class: 'grid', style: 'gap:8px' });
  const showPassword = () => {
    passwordArea.innerHTML = '';
    // 後台共用密碼。人員名單本身就是個資，所以要先過密碼才拿得到。
    // 只放在記憶體，不寫 localStorage —— 重新整理就要再輸入一次。
    const input = h('input', {
      id: 'admin-password', type: 'password', class: 'input',
      placeholder: '後台密碼', autocomplete: 'current-password',
    });
    const enter = async () => {
      const pw = input.value;
      if (!pw) return renderLogin('請輸入後台密碼');
      let list;
      try {
        const res = await fetch('/api/v1/auth/personas', { headers: { 'X-Admin-Password': pw } });
        const json = await res.json();
        if (!json.ok) return renderLogin(json.error.message);
        list = json.data;
      } catch { return renderLogin('連不上伺服器，請稍後再試'); }
      if (!list.length) return renderLogin('系統還沒有任何員工，請先建立第一位店主');
      renderPersonas(pw, list);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') enter(); });
    passwordArea.append(input, h('button', { class: 'btn', onClick: enter }, '用密碼進入'));
    input.focus();
  };

  let body;
  if (lineButton) {
    body = [
      h('p', { class: 'muted small', style: 'margin-top:0' },
        '用你的 LINE 帳號登入。只有店主在「成員與權限」加入的員工進得來。'),
      errLine, lineButton,
      cfg.password ? h('button', { class: 'btn ghost sm', style: 'margin-top:12px', onClick: showPassword }, '系統管理者：用共用密碼登入') : null,
      passwordArea,
    ];
  } else if (cfg.password) {
    body = [
      h('p', { class: 'muted small', style: 'margin-top:0' },
        '後台以共用密碼保護，再選擇身分進入。LINE 登入設定完成（ADMIN_LIFF_ID）後，這裡會改成「用 LINE 登入」。'),
      errLine, passwordArea,
    ];
  } else {
    body = [errLine, h('p', { class: 'small', style: 'margin:0' },
      '後台目前沒有可用的登入方式：LINE 登入尚未設定，共用密碼入口也已關閉。請系統管理者檢查 ADMIN_LIFF_ID。')];
  }

  const box = h('div', { class: 'login' },
    h('div', { class: 'box' },
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, 'HEEEHABABY 代購營運後台')),
        h('div', { class: 'card-body' }, h('div', { class: 'grid', style: 'gap:8px' }, ...body)))));
  document.body.append(box);
  if (!lineButton && cfg.password) showPassword();
}

/** 密碼過關之後才列出人員，並把密碼一併帶去換 token。 */
function renderPersonas(pw, personas) {
  document.querySelectorAll('.login').forEach((n) => n.remove());
  const box = h('div', { class: 'login' },
    h('div', { class: 'box' },
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, '選擇身分')),
        h('div', { class: 'card-body' },
          h('div', { class: 'grid', style: 'gap:8px' },
            ...personas.map((p) => h('button', {
              class: 'persona',
              onClick: async () => {
                try {
                  signedIn(await POST('/api/v1/auth/login', { line_user_id: p.line_user_id, password: pw }));
                } catch (e) { fail(e); }
              },
            },
              h('div', { class: 'avatar' }, p.nickname.slice(0, 1)),
              h('div', {}, h('div', {}, p.nickname), h('div', { class: 'tiny muted' }, `${roleLabel(p.role)}${p.member_no ? ' · ' + p.member_no : ''}`)),
              h('div', { class: 'spacer', style: 'flex:1' }),
              h('span', { class: 'tag' }, roleLabel(p.role)))),
            h('button', { class: 'btn', onClick: () => renderLogin() }, '返回'))))));
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
  // 換頁時把上一頁開著的視窗收掉 —— 不然它會蓋在新頁面上，按什麼都沒反應。
  closeModal();
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
