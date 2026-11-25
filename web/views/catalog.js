import { GET, POST, h, nt, toast, fail, modal, session, downloadCsv } from '../app.js';

/**
 * 商品資料庫（2026-11-25 照周小姐影片 2）。
 * 商品型錄（現場採購用的 SKU）和喊單（每日連線的商品）合在一張表看：
 * 商品、採購線、款式、尺寸、售價、狀態。可以搜尋、篩選、切換表格／卡片、匯出 CSV、＋新增商品。
 * 採購線空的是「待分類」—— 補上之後，連線採買清單就能照日本線／韓國線篩。
 */
const STATUS = [['', '全部狀態'], ['active', '上架中'], ['closed', '已截止'], ['sold_out', '已售完']];
const SOURCE = [['', '型錄＋喊單'], ['catalog', '只看型錄'], ['broadcast', '只看喊單']];
const TONE = { active: 'green', closed: '', sold_out: 'amber' };
const VIEW_KEY = 'hb.admin.catalog.view';

export async function render(root) {
  const canEdit = session.can('broadcast');
  const showPrice = session.can('order.read.price');
  let view = 'table';
  try { view = localStorage.getItem(VIEW_KEY) || 'table'; } catch { /* 無痕模式 */ }
  const state = { q: '', line: '', status: '', source: '' };
  const search = h('input', { type: 'search', placeholder: '搜尋商品、編號、款式…' });
  const status = h('select', { style: 'width:auto' }, ...STATUS.map(([k, v]) => h('option', { value: k }, v)));
  const source = h('select', { style: 'width:auto' }, ...SOURCE.map(([k, v]) => h('option', { value: k }, v)));
  const chips = h('div', { class: 'chips' });
  const viewBtn = h('button', { class: 'btn sm', type: 'button' });
  const countBox = h('span', { class: 'tiny muted' });
  const body = h('div', {});
  root.append(
    h('div', { class: 'lc-tools' }, search, status, source, viewBtn,
      canEdit ? h('button', { class: 'btn primary sm', type: 'button', onClick: () => editDialog(null) }, '＋ 新增商品') : null),
    h('div', { class: 'row', style: 'gap:8px;margin-bottom:12px' }, chips, h('span', { class: 'spacer', style: 'flex:1' }), countBox),
    body);

  let data = { rows: [], lines: [], untagged: 0, total: 0 };
  let t = null;
  const qs = () => new URLSearchParams(Object.entries(state).filter(([, v]) => v)).toString();
  const load = async () => {
    data = await GET('/api/v1/catalog/list' + (qs() ? '?' + qs() : ''));
    draw();
  };
  search.addEventListener('input', () => { state.q = search.value.trim(); clearTimeout(t); t = setTimeout(() => load().catch(fail), 250); });
  status.addEventListener('change', () => { state.status = status.value; load().catch(fail); });
  source.addEventListener('change', () => { state.source = source.value; load().catch(fail); });
  viewBtn.addEventListener('click', () => {
    view = view === 'table' ? 'cards' : 'table';
    try { localStorage.setItem(VIEW_KEY, view); } catch { /* 無痕模式 */ }
    draw();
  });

  function draw() {
    viewBtn.textContent = view === 'table' ? '▦ 卡片檢視' : '☰ 表格檢視';
    countBox.textContent = `共 ${data.total} 件`;
    chips.replaceChildren(...[['', '全部'], ['__none', `待分類 ${data.untagged}`], ...data.lines.map((l) => [l, l])].map(([k, label]) =>
      h('button', { type: 'button', class: 'chip' + (state.line === k ? ' on' : ''), onClick: () => { state.line = k; load().catch(fail); } }, label)));
    body.innerHTML = '';
    if (!data.rows.length) { body.append(h('div', { class: 'card' }, h('div', { class: 'empty' }, '沒有符合的商品'))); return; }
    if (view === 'cards') {
      body.append(h('div', { class: 'wr-grid' }, ...data.rows.map((r) => h('div', { class: 'wr-card' },
        h('div', { class: 'wr-photo' }, r.image_url ? h('img', { src: r.image_url, alt: r.name, loading: 'lazy' }) : h('span', { class: 'muted' }, '沒有照片'),
          h('span', { class: 'wr-rank mono' }, r.id)),
        h('div', { class: 'wr-body' },
          h('div', { class: 'row', style: 'gap:6px' }, h('span', { class: 'tag ' + TONE[r.status] }, r.status_zh), h('span', { class: 'tag' }, r.source_zh),
            h('span', { class: 'spacer', style: 'flex:1' }), showPrice && r.price_twd ? h('b', {}, nt(r.price_twd)) : null),
          h('div', { class: 'wr-name' }, r.name),
          h('div', { class: 'tiny muted' }, [r.line || '待分類', r.variant, r.sizes && r.sizes.join('／')].filter(Boolean).join('・')),
          canEdit ? h('button', { class: 'btn sm', type: 'button', onClick: () => editDialog(r) }, '編輯') : null)))));
      return;
    }
    body.append(h('div', { class: 'card' }, h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, '商品'), h('th', {}, '採購線'), h('th', {}, '款式'), h('th', {}, '尺寸'),
        showPrice ? h('th', {}, '售價') : null, h('th', {}, '狀態'), canEdit ? h('th', {}) : null)),
      h('tbody', {}, ...data.rows.map((r) => h('tr', {},
        h('td', {}, h('div', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' },
          r.image_url ? h('img', { class: 'thumb', src: r.image_url, alt: '' }) : h('span', { class: 'thumb' }),
          h('div', {}, h('div', {}, r.name), h('div', { class: 'tiny muted mono' }, `${r.source_zh} ${r.id}`)))),
        h('td', {}, r.line ? r.line : h('span', { class: 'tag amber' }, '待分類')),
        h('td', { class: 'small' }, r.variant || '—'),
        h('td', { class: 'small' }, r.sizes ? r.sizes.join('／') : '—'),
        showPrice ? h('td', {}, r.price_twd ? nt(r.price_twd) : '—') : null,
        h('td', {}, h('span', { class: 'tag ' + TONE[r.status] }, r.status_zh),
          r.source === 'broadcast' ? h('div', { class: 'tiny muted' }, `${r.sold}/${r.quantity}`) : null),
        canEdit ? h('td', {}, h('button', { class: 'btn sm', type: 'button', onClick: () => editDialog(r) }, '編輯')) : null)))))));
  }

  function editDialog(r) {
    const f = {
      name: h('input', { type: 'text', maxlength: '60', value: r ? r.name : '', placeholder: '例：小花刺繡圍兜' }),
      line: h('input', { type: 'text', maxlength: '12', value: r ? r.line || '' : '', placeholder: '例：日本線、韓國線', list: 'cat-lines' }),
      variant: h('input', { type: 'text', maxlength: '30', value: r ? r.variant || '' : '', placeholder: '例：粉紅、小花' }),
      sizes: h('input', { type: 'text', value: r && r.sizes ? r.sizes.join(' / ') : '', placeholder: '例：90 / 100 / 110' }),
      price: h('input', { type: 'number', min: '1', inputmode: 'numeric', value: r && r.price_twd ? r.price_twd : '' }),
    };
    const lines = h('datalist', { id: 'cat-lines' }, ...['日本線', '韓國線', ...data.lines].filter((v, i, a) => a.indexOf(v) === i).map((l) => h('option', { value: l })));
    const errBox = h('div', { class: 'tiny', role: 'alert', style: 'color:var(--red)' });
    modal(r ? `編輯 ${r.id}` : '新增商品（寫進型錄）', h('div', {}, lines,
      h('label', { class: 'field' }, h('span', {}, '商品名稱'), f.name),
      h('label', { class: 'field' }, h('span', {}, '採購線'), f.line),
      h('label', { class: 'field' }, h('span', {}, '款式'), f.variant),
      h('label', { class: 'field' }, h('span', {}, '尺寸（用斜線或逗號隔開）'), f.sizes),
      showPrice ? h('label', { class: 'field' }, h('span', {}, '台幣售價'), f.price) : null,
      r && r.source === 'broadcast' ? h('div', { class: 'tiny muted' }, '喊單已經有人搶的話，售價不能改。') : null,
      errBox), [{
      label: r ? '儲存' : '新增', primary: true,
      onClick: async (close) => {
        errBox.textContent = '';
        try {
          const payload = { name: f.name.value, line: f.line.value, variant: f.variant.value, sizes: f.sizes.value };
          if (showPrice && f.price.value !== '' && (!r || Number(f.price.value) !== r.price_twd)) payload.price_twd = Number(f.price.value);
          if (r) await POST('/api/v1/catalog/update', { key: r.key, ...payload });
          else await POST('/api/v1/catalog/create', payload);
          close(); toast(r ? '已儲存' : '已新增到型錄'); load().catch(fail);
        } catch (e) { errBox.textContent = e.message; }
      },
    }]);
  }

  await load();
}

/** 頁首「↗ 匯出備份」：全部商品（型錄＋喊單）存成 CSV。 */
export async function exportBackup() {
  const d = await GET('/api/v1/catalog/list');
  downloadCsv(`heeehababy-products-${new Date().toISOString().slice(0, 10)}.csv`, [
    { label: '來源', key: 'source_zh' }, { label: '編號', key: 'id' }, { label: '商品', key: 'name' },
    { label: '採購線', get: (r) => r.line || '待分類' }, { label: '款式', key: 'variant' },
    { label: '尺寸', get: (r) => (r.sizes || []).join('/') }, { label: '售價', key: 'price_twd' },
    { label: '狀態', key: 'status_zh' }, { label: '團別', key: 'batch' },
  ], d.rows);
  toast(`已匯出 ${d.rows.length} 件商品`);
}
