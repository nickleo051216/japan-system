import { GET, POST, h, toast, fail, modal, downloadCsv } from '../app.js';

/**
 * 營運成本表（v1.8，022）—— 只有店主看得到。
 *
 * 小幫手請款單「核准」就自動記一筆未付成本，「已付款」改成已付，「退回」就拿掉。
 * 其他花費（包材、國際運費、韓國線的費用…）可以按「＋ 記一筆」手動加。
 * 上方三張卡片是日幣、韓幣、台幣各自的合計 —— 不換匯、不混在一起算。
 * 「↗ 匯出備份」存成 CSV（UTF-8 BOM＋CRLF，Excel 直接打開不會亂碼）。
 */
const CUR = [['JPY', '日幣', '¥'], ['KRW', '韓幣', '₩'], ['TWD', '台幣', 'NT$']];
const SYM = Object.fromEntries(CUR.map(([k, , s]) => [k, s]));
const money = (cur, v) => `${SYM[cur]}${Math.round(Number(v) || 0).toLocaleString('en-US')}`;

const thisMonth = () => {
  const d = new Date(Date.now() + 8 * 3600e3);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const monthRange = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` };
};

export async function render(root, ctx) {
  const month = /^\d{4}-\d{2}$/.test(ctx.query.month || '') ? ctx.query.month : thisMonth();
  const all = ctx.query.month === 'all';
  const qs = new URLSearchParams(all ? {} : monthRange(month));
  const data = await GET('/api/v1/costs/list' + (qs.toString() ? '?' + qs : ''));

  const monthIn = h('input', { type: 'month', value: all ? thisMonth() : month, style: 'width:auto' });
  monthIn.addEventListener('change', () => { location.hash = '#/costs?month=' + monthIn.value; });
  root.append(h('div', { class: 'lc-tools' }, monthIn,
    h('a', { class: 'btn sm' + (all ? ' primary' : ''), href: '#/costs?month=all' }, '全部月份'),
    h('span', { class: 'spacer', style: 'flex:1' }),
    h('button', { class: 'btn primary sm', type: 'button', onClick: () => editDialog(null, ctx) }, '＋ 記一筆')));

  root.append(h('div', { class: 'grid cols-3', style: 'margin-bottom:12px' }, ...CUR.map(([k, zh]) => {
    const t = data.totals[k];
    return h('div', { class: 'card stat' }, h('div', { class: 'k' }, `${zh}（${k}）`),
      h('div', { class: 'v' }, money(k, t.total)),
      h('div', { class: 'sub' }, `已付 ${money(k, t.paid)}・未付 ${money(k, t.unpaid)}・${t.count} 筆`));
  })));

  const tbody = h('tbody', {});
  root.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, all ? '全部成本' : `${month} 的成本`)),
    h('div', { class: 'table-wrap' }, h('table', { class: 'stack' },
      h('thead', {}, h('tr', {}, h('th', {}, '日期'), h('th', {}, '類別'), h('th', {}, '金額'), h('th', {}, '狀態'),
        h('th', {}, '付給'), h('th', {}, '來源'), h('th', {}))),
      tbody))));
  if (!data.items.length) tbody.append(h('tr', {}, h('td', { colspan: '7', class: 'empty' }, '這段期間沒有成本紀錄')));
  for (const r of data.items) {
    tbody.append(h('tr', {},
      h('td', { class: 'small' }, r.spent_on),
      h('td', {}, r.category, r.note ? h('div', { class: 'tiny muted' }, r.note) : null),
      h('td', {}, h('b', {}, money(r.currency, r.amount)), h('span', { class: 'tiny muted' }, ` ${r.currency_zh}`)),
      h('td', {}, h('span', { class: 'tag ' + (r.status === 'paid' ? 'green' : 'amber') }, r.status_zh)),
      h('td', { class: 'small' }, r.payee || '—'),
      h('td', { class: 'tiny muted' }, r.source === 'helper_claim'
        ? h('a', { href: '#/helper?tab=' + encodeURIComponent('請款審核') }, `小幫手請款 ${r.source_id}`) : '手動記帳'),
      h('td', {}, r.editable ? h('div', { class: 'row', style: 'gap:6px' },
        h('button', { class: 'btn sm', type: 'button', onClick: () => editDialog(r, ctx) }, '編輯'),
        h('button', { class: 'btn sm ghost', type: 'button', onClick: async () => {
          if (!window.confirm(`刪掉「${r.category} ${money(r.currency, r.amount)}」？`)) return;
          try { await POST('/api/v1/costs/remove', { cost_id: r.cost_id }); toast('已刪除'); ctx.reload(); } catch (e) { fail(e); }
        } }, '刪除')) : h('span', { class: 'tiny muted' }, '到請款審核改'))));
  }
}

function editDialog(r, ctx) {
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const f = {
    spent_on: h('input', { type: 'date', value: r ? r.spent_on : today }),
    category: h('input', { type: 'text', maxlength: '30', value: r ? r.category : '', placeholder: '例：包材、國際運費、韓國線交通費', list: 'cost-cats' }),
    currency: h('select', {}, ...CUR.map(([k, zh]) => h('option', { value: k, selected: r ? r.currency === k : k === 'TWD' }, `${zh}（${k}）`))),
    amount: h('input', { type: 'number', min: '1', inputmode: 'numeric', value: r ? r.amount : '' }),
    payee: h('input', { type: 'text', maxlength: '40', value: r ? r.payee || '' : '', placeholder: '選填' }),
    note: h('input', { type: 'text', maxlength: '200', value: r ? r.note || '' : '', placeholder: '選填' }),
    paid: h('input', { type: 'checkbox', checked: r ? r.status === 'paid' : true }),
  };
  const cats = h('datalist', { id: 'cost-cats' }, ...['包材', '國際運費', '國內運費', '交通費', '韓國線費用', '平台手續費'].map((c) => h('option', { value: c })));
  const errBox = h('div', { class: 'tiny', role: 'alert', style: 'color:var(--red)' });
  modal(r ? '編輯成本' : '記一筆成本', h('div', {}, cats,
    h('label', { class: 'field' }, h('span', {}, '日期'), f.spent_on),
    h('label', { class: 'field' }, h('span', {}, '類別'), f.category),
    h('div', { class: 'row', style: 'gap:8px' },
      h('label', { class: 'field', style: 'flex:1' }, h('span', {}, '幣別'), f.currency),
      h('label', { class: 'field', style: 'flex:1' }, h('span', {}, '金額'), f.amount)),
    h('label', { class: 'field' }, h('span', {}, '付給誰'), f.payee),
    h('label', { class: 'field' }, h('span', {}, '備註'), f.note),
    h('label', { class: 'row', style: 'gap:6px' }, f.paid, h('span', { class: 'small' }, '已經付了')),
    errBox), [{
    label: r ? '儲存' : '記下來', primary: true,
    onClick: async (close) => {
      errBox.textContent = '';
      try {
        const body = { spent_on: f.spent_on.value, category: f.category.value, currency: f.currency.value,
          amount: Number(f.amount.value), payee: f.payee.value || null, note: f.note.value || null, paid: f.paid.checked };
        if (r) await POST('/api/v1/costs/update', { cost_id: r.cost_id, ...body });
        else await POST('/api/v1/costs/create', body);
        close(); toast(r ? '已儲存' : '已記一筆'); ctx.reload();
      } catch (e) { errBox.textContent = e.message; }
    },
  }]);
}

/** 頁首「↗ 匯出備份」：全部成本存成 CSV（downloadCsv 會加 UTF-8 BOM、用 CRLF 換行）。 */
export async function exportBackup() {
  const d = await GET('/api/v1/costs/list');
  downloadCsv(`heeehababy-costs-${new Date().toISOString().slice(0, 10)}.csv`, [
    { label: '日期', key: 'spent_on' }, { label: '類別', key: 'category' }, { label: '幣別', key: 'currency' },
    { label: '金額', key: 'amount' }, { label: '狀態', key: 'status_zh' }, { label: '付給', key: 'payee' },
    { label: '來源', get: (r) => (r.source === 'helper_claim' ? `小幫手請款 ${r.source_id}` : '手動記帳') },
    { label: '備註', key: 'note' }, { label: '付款時間', key: 'paid_at' },
  ], d.items);
  toast(`已匯出 ${d.items.length} 筆成本`);
}
