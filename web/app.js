/**
 * SPA shell: session, hash router, shared UI helpers.
 * The frontend holds no business rules — it renders what the API returns and
 * every guard it shows is also enforced server-side (README F-21 強制規則).
 */
// 後台可能掛在前台網域的 /admin 底下（跟買家前台同一個網域），
// localStorage 會跟前台共用，所以 key 要有自己的名字，不要跟前台撞在一起。
const TOKEN_KEY = 'hb.admin.token';

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
//
// 2026-11-25 照周小姐影片 2：上方一排頁籤（可以左右滑），順序就是她示範站的順序。
// 頁籤依權限顯示：小幫手只看得到自己用得到的那幾個。
// more: true 的是設定類，排在最後、用一條細線隔開。
// sub 是每頁大標底下的灰色副標。
const ROUTES = [
  { path: 'dashboard', title: '營運總覽', eyebrow: 'OVERVIEW', cap: 'order.read', mod: () => import('./views/dashboard.js'),
    sub: '先看照片需求，再確認許願與付款，最後安排出貨。' },
  { path: 'shop', title: '照片喊單採買', cap: 'broadcast', mod: () => import('./views/shop.js'),
    sub: '拍照開喊單、調整數量，客人在 LINE 上＋1。' },
  { path: 'helper', title: '小幫手批次請款', cap: 'procurement.write', mod: () => import('./views/helper.js'),
    sub: '採買完一批一起拍收據請款，送給代購主核對。' },
  { path: 'board', title: '連線採買清單', cap: 'procurement.read', mod: () => import('./views/board.js'),
    sub: '看照片、對款式、確認數量，一單一單帶回家。' },
  { path: 'wishes', title: '許願報價與回覆', cap: 'order.read', mod: () => import('./views/wishes.js'),
    sub: '找到可採購商品、先報價，再確認客人的購買意願。' },
  { path: 'wish-rank', title: '許願與＋1 排行', cap: 'order.read', mod: () => import('./views/wish-rank.js'),
    sub: '大家最想要的，排在最前面。' },
  { path: 'ship-requests', title: '拆併單出貨', cap: 'order.read', mod: () => import('./views/ship-requests.js'),
    sub: '客人申請併單或先寄，確認運費後產生出貨單。' },
  { path: 'statements', title: '付款與發票備註', cap: 'payment.reconcile', mod: () => import('./views/statements.js'),
    sub: '每月結算對帳單、核對客人匯款。' },
  { path: 'orders', title: '訂單管理', cap: 'order.read', mod: () => import('./views/orders.js'),
    sub: '商品、客人與每一步進度，都有對照紀錄。' },
  { path: 'packing', title: '看圖理貨與出貨', cap: 'shipment.write', mod: () => import('./views/packing.js'),
    sub: '對照客人當初的照片撿貨裝箱。' },
  { path: 'labels', title: 'QR 標籤列印', cap: 'shipment.write', mod: () => import('./views/labels.js'),
    sub: '把商品與包裹，一張張對好。' },
  { path: 'scan', title: '掃碼核對工作站', cap: 'shipment.write', mod: () => import('./views/scan.js'),
    sub: '先掃包裹，再逐件掃商品，掃到別的包裹會跳出警示。' },
  { path: 'logistics', title: '進貨物流綁定', cap: 'shipment.write', mod: () => import('./views/logistics.js'),
    sub: '把日本寄回來的物流單號綁到訂單。' },
  { path: 'expense', title: '拍收據記帳', cap: 'procurement.write', more: true, mod: () => import('./views/expense.js'),
    sub: '一張收據記一項商品的實際進價。' },
  { path: 'members', title: '成員與邀請碼', cap: 'settings.write', more: true, mod: () => import('./views/members.js'),
    sub: '員工角色、小幫手邀請碼、客人名冊。' },
  { path: 'settings', title: '匯率・價目表・團別', cap: 'order.read', more: true, mod: () => import('./views/settings.js'),
    sub: '匯率、日幣對台幣價目表、開團與店家設定。' },
  { path: 'payments', title: '金流設定', cap: 'settings.write', more: true, mod: () => import('./views/payments.js'),
    sub: '綠界刷卡與 ATM 的串接設定。' },
  { path: 'audit', title: '稽核軌跡', cap: 'audit.read', more: true, mod: () => import('./views/audit.js'),
    sub: '誰在什麼時候做了什麼，一筆一筆都留著。' },
];

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [path, qs] = raw.split('?');
  return { path, query: Object.fromEntries(new URLSearchParams(qs || '')) };
}

/** 小花圖示（品牌列、歡迎卡、空白狀態共用）。 */
export function flower(size = 22) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 32 32'); svg.setAttribute('width', size); svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true'); svg.classList.add('flower');
  svg.innerHTML = [0, 60, 120, 180, 240, 300].map((r) =>
    `<ellipse cx="16" cy="8.6" rx="4.6" ry="7" transform="rotate(${r} 16 16)" fill="#f5d075"/>`).join('')
    + '<circle cx="16" cy="16" r="4.3" fill="#88362a"/>';
  return svg;
}

function renderMasthead() {
  const bar = document.getElementById('masthead');
  if (!bar) return;
  bar.innerHTML = '';
  bar.append(
    h('a', { class: 'brand', href: '#/dashboard' }, flower(24),
      h('span', {}, h('span', { class: 'word' }, 'heeehababy'), h('small', {}, 'LAUGH LIKE A BABY. LIVE LIKE A QUEEN.'))),
    h('div', { class: 'spacer' }),
    session.member ? h('button', { class: 'who', type: 'button', title: '帳號', onClick: accountSheet },
      h('span', { class: 'who-name' }, session.member.nickname, h('span', { class: 'tiny muted' }, roleLabel(session.member.role))),
      h('span', { class: 'avatar' }, session.member.nickname.slice(0, 1))) : null);
}

function accountSheet() {
  modal('帳號', h('div', {},
    h('div', { class: 'row' }, h('span', { class: 'avatar', style: 'width:40px;height:40px' }, session.member.nickname.slice(0, 1)),
      h('div', {}, h('strong', {}, session.member.nickname), h('div', { class: 'tiny muted' },
        `${roleLabel(session.member.role)}${session.member.member_no ? '・' + session.member.member_no : ''}`)))), [
    { label: '切換身分／登出', onClick: (close) => { close(); logout(); } },
  ]);
}

/** 頁籤：可以左右滑，選中的那一個會自動捲進畫面。 */
function renderPills(active) {
  const nav = document.getElementById('pills');
  if (!nav) return;
  nav.innerHTML = '';
  const track = h('div', { class: 'pill-track' });
  let shownMore = false;
  for (const r of ROUTES) {
    if (!session.can(r.cap)) continue;
    if (r.more && !shownMore) { shownMore = true; track.append(h('span', { class: 'pill-sep', 'aria-hidden': 'true' })); }
    track.append(h('a', { class: 'pill' + (r.path === active ? ' on' : '') + (r.more ? ' more' : ''), href: `#/${r.path}`,
      'aria-current': r.path === active ? 'page' : null }, r.title));
  }
  nav.append(track);
  const on = track.querySelector('.pill.on');
  if (on) requestAnimationFrame(() => on.scrollIntoView({ block: 'nearest', inline: 'center' }));
}

export const roleLabel = (r) => ({ owner: '店主', helper: '小幫手', packer: '理貨', buyer: '買家' }[r] || r);

// 舊的抽屜選單已經拿掉；保留這個名字給還在呼叫它的頁面，不做事。
export const closeNav = () => {};

/**
 * 每頁的頁首：麵包屑「工作空間 / 頁名」、eyebrow、大標、灰色副標、右上動作（例如匯出備份）。
 * 頁面要放「↗ 匯出備份」就 export 一個 exportBackup()，這裡會自動加按鈕。
 */
function pageHead(r, mod, ctx) {
  const actions = h('div', { class: 'ph-actions' });
  if (mod && typeof mod.exportBackup === 'function') {
    actions.append(h('button', { class: 'btn sm', type: 'button', onClick: async () => {
      try { await mod.exportBackup(ctx); } catch (e) { fail(e); }
    } }, '↗ 匯出備份'));
  }
  return h('div', { class: 'page-head' },
    h('div', { class: 'crumbs' }, h('a', { href: '#/dashboard' }, '工作空間'), ' / ', h('span', {}, r.title)),
    h('div', { class: 'ph-row' },
      h('div', { class: 'ph-text' },
        h('div', { class: 'eyebrow' }, `HEEEHABABY / ${r.eyebrow || 'WORKSPACE'}`),
        h('h1', {}, r.title),
        r.sub ? h('p', { class: 'ph-sub' }, r.sub) : null),
      actions));
}

/** 把資料存成 CSV 下載（Excel 打得開：加 BOM，避免中文亂碼）。檔名用英文：中文檔名在部分瀏覽器會變成「download」。 */
export function downloadCsv(filename, cols, rows) {
  const cell = (v) => {
    const t = v == null ? '' : String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const text = [cols.map((c) => cell(c.label)).join(','), ...rows.map((r) => cols.map((c) => cell(typeof c.get === 'function' ? c.get(r) : r[c.key])).join(','))].join('\r\n');
  const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
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
const INVITE_KEY = 'hb.admin.invite';

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
    if (interactive) liff.login({ redirectUri: location.origin + location.pathname });
    return null;
  }
  const idToken = liff.getIDToken();
  if (!idToken) throw new Error('拿不到 LINE 身分。LIFF app 需要勾選 openid 權限，請聯絡系統管理者');
  // 登入頁填了邀請碼的話一起帶上（LINE 登入會跳轉，所以先放 sessionStorage）。
  let invite = null;
  try { invite = sessionStorage.getItem(INVITE_KEY); sessionStorage.removeItem(INVITE_KEY); } catch { /* 無痕模式 */ }
  try {
    signedIn(await POST('/api/v1/auth/line', invite ? { id_token: idToken, invite_code: invite } : { id_token: idToken }));
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
  document.getElementById('masthead')?.replaceChildren();
  document.getElementById('pills')?.replaceChildren();
  document.querySelectorAll('.login').forEach((n) => n.remove());

  let cfg = { line: { ready: false }, password: true };
  try { cfg = await GET('/api/v1/auth/config'); } catch { /* 舊版後端沒有這支：只顯示密碼入口 */ }

  // 剛從 LINE 導回來（或本來就登入著 LINE）就直接完成登入，不必再按一次。
  if (cfg.line.ready && !err) {
    try { if (await lineLogin(cfg.line.liff_id, false)) return; } catch (e) { err = e.message; }
  }

  const errLine = err ? h('p', { class: 'small', style: 'color:var(--bad,#a8241c); margin:0 0 8px; word-break:break-all' }, err) : null;
  // 新的小幫手：店主給的邀請碼填在這裡，再按「用 LINE 登入」就會自動加入。
  const inviteInput = h('input', { class: 'input', type: 'text', placeholder: '邀請碼（新加入的小幫手才要填）', autocomplete: 'off',
    style: 'text-transform:uppercase', 'aria-label': '邀請碼' });
  const lineButton = cfg.line.ready
    ? h('button', {
      class: 'btn primary', style: 'background:#06c755;border-color:#06c755',
      onClick: async () => {
        const code = inviteInput.value.trim();
        try { if (code) sessionStorage.setItem(INVITE_KEY, code); else sessionStorage.removeItem(INVITE_KEY); } catch { /* 無痕模式 */ }
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
        '用你的 LINE 帳號登入。只有店家的員工進得來；新加入的小幫手請先填店主給的邀請碼。'),
      errLine, inviteInput, lineButton,
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
  renderMasthead();
  renderPills(r.path);
  const view = document.getElementById('view');
  // 轉圈圈一直顯示到這一頁的資料都拿到為止。頁面先畫在隱藏的容器裡，畫完才換上 ——
  // 不然會先清空、再等 API，中間是一段白畫面，看起來像當掉。
  const seq = ++routeSeq;
  const spinner = h('div', { class: 'loading', role: 'status' }, h('span', { class: 'spinner' }), '載入中…');
  const holder = h('div', { hidden: true });
  view.replaceChildren(spinner, holder);
  try {
    const mod = await r.mod();
    const ctx = { query, setTopbar: () => {}, reload: route };
    holder.append(pageHead(r, mod, ctx));
    const body = h('div', { class: 'page-body' });
    holder.append(body);
    await mod.render(body, ctx);
    if (seq !== routeSeq) return; // 載入途中又換了頁：這一頁作廢，不要蓋掉新的
    spinner.remove();
    holder.hidden = false;
  } catch (e) {
    if (seq !== routeSeq) return;
    view.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'empty' }, e.message || '載入失敗')));
  }
}
let routeSeq = 0;

window.addEventListener('hashchange', route);
boot();
