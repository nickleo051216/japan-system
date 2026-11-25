import { GET, POST, h, nt, dt, toast, fail, modal, session, flower, downloadCsv } from '../app.js';

/**
 * 許願與＋1 排行（2026-11-25 照周小姐影片 2）。
 * 依「想要的人數」排（許願的人＋按 +1 的人），可以搜尋、照尋找進度篩。
 * 每一則有照片、人數，「更新尋找進度」寫一句話給客人看（前台我的許願、許願牆都看得到）。
 */
const FILTERS = [
  ['all', '全部（不含已下單）'], ['finding', '尋找中'], ['quoted', '已報價'], ['broadcast', '已開喊單'],
  ['out', '現場缺貨'], ['later', '保留下團'], ['ordered', '已下單'],
];
const TONE = { 尋找中: 'amber', 已報價: 'blue', 已開喊單: 'green', 現場缺貨: 'red', 保留下團: '', 已下單: '' };

export async function render(root, ctx) {
  const state = { q: ctx.query.q || '', progress: FILTERS.some((f) => f[0] === ctx.query.progress) ? ctx.query.progress : 'all' };
  const search = h('input', { type: 'search', placeholder: '搜尋商品、品牌、客人…', value: state.q });
  const sel = h('select', { style: 'width:auto' }, ...FILTERS.map(([k, v]) => h('option', { value: k, selected: k === state.progress }, v)));
  const grid = h('div', { class: 'wr-grid' });
  root.append(
    h('div', { class: 'lc-tools' }, search, sel),
    h('div', { class: 'tiny muted', style: 'margin:-4px 0 12px' }, '＋1 代表想要的意願，官方 LINE 確認後才成立訂單。'),
    grid);

  let timer = null;
  const load = async () => {
    const rows = await GET(`/api/v1/wishes/ranking?progress=${state.progress}${state.q ? '&q=' + encodeURIComponent(state.q) : ''}`);
    grid.innerHTML = '';
    if (!rows.length) grid.append(h('div', { class: 'card', style: 'grid-column:1/-1' }, h('div', { class: 'empty' }, '沒有符合的許願')));
    for (const w of rows) grid.append(card(w));
  };
  search.addEventListener('input', () => { state.q = search.value.trim(); clearTimeout(timer); timer = setTimeout(() => load().catch(fail), 250); });
  sel.addEventListener('change', () => { state.progress = sel.value; load().catch(fail); });

  const card = (w) => h('div', { class: 'wr-card' },
    h('div', { class: 'wr-photo' },
      w.picture ? h('img', { src: w.picture, alt: w.item_name, loading: 'lazy' }) : flower(44),
      h('span', { class: 'wr-rank' }, `#${w.rank}`)),
    h('div', { class: 'wr-body' },
      h('div', { class: 'row', style: 'gap:6px' },
        h('span', { class: 'tag ' + (TONE[w.progress] ?? '') }, w.progress),
        h('span', { class: 'spacer', style: 'flex:1' }),
        h('b', { class: 'wr-wants' }, `♡ ${w.wants} 人想要`)),
      h('div', { class: 'wr-name' }, w.item_name, w.brand ? h('span', { class: 'tiny muted' }, `　${w.brand}`) : null),
      h('div', { class: 'tiny muted' }, `${w.nickname} 許願・${dt(w.wished_at)}${w.quote_twd ? `・報價 ${nt(w.quote_twd)}` : ''}`),
      w.progress_note ? h('div', { class: 'wr-note' }, w.progress_note, h('span', { class: 'tiny muted' }, `　${dt(w.progress_at)}`)) : null,
      session.can('order.write') && w.wish_status !== '已下單'
        ? h('button', { class: 'btn sm', type: 'button', onClick: () => progressDialog(w) }, '更新尋找進度') : null));

  const progressDialog = (w) => {
    const note = h('input', { type: 'text', maxlength: '120', placeholder: '例：大阪店問過了，下週補貨', value: w.progress_note || '' });
    const st = h('select', {},
      h('option', { value: '' }, '狀態不變'),
      h('option', { value: '待處理' }, '尋找中'),
      h('option', { value: '現場缺貨' }, '現場缺貨（會 LINE 通知許願的人）'),
      h('option', { value: '保留下團' }, '保留下團'));
    modal(`更新尋找進度：${w.item_name}`, h('div', {},
      h('label', { class: 'field' }, h('span', {}, '一句話給客人看（我的許願、許願牆都看得到）'), note),
      h('label', { class: 'field' }, h('span', {}, '狀態'), st),
      h('div', { class: 'tiny muted' }, '找到了要報價，請到「許願報價與回覆」填價錢。')), [{
      label: '更新', primary: true,
      onClick: async (close) => {
        await POST('/api/v1/wishes/progress', { wish_id: w.wish_id, note: note.value, status: st.value || null });
        close(); toast('已更新尋找進度'); load().catch(fail);
      },
    }]);
  };

  await load();
}

/** 頁首「↗ 匯出備份」：目前的排行存成 CSV。 */
export async function exportBackup() {
  const rows = await GET('/api/v1/wishes/ranking?progress=all');
  downloadCsv(`heeehababy-wish-ranking-${new Date().toISOString().slice(0, 10)}.csv`, [
    { label: '排名', key: 'rank' }, { label: '品名', key: 'item_name' }, { label: '品牌', key: 'brand' },
    { label: '想要人數', key: 'wants' }, { label: '進度', key: 'progress' }, { label: '尋找進度', key: 'progress_note' },
    { label: '許願的人', key: 'nickname' }, { label: '許願時間', key: 'wished_at' },
  ], rows);
  toast(`已匯出 ${rows.length} 則許願`);
}
