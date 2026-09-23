import { GET, POST, h, nt, toast, modal } from '/app.js';

/**
 * 代客下單：客人在 LINE 私訊或電話裡說要買什麼，店家直接在後台替他建單。
 *
 * 三步：找客人（會員編號或名字）→ 填品項（日幣含稅價會照價目表即時換算台幣，
 * 也可以直接填已經談好的台幣價）→ 選取貨方式。送出後訂單是「待確認」，
 * 跟客人自己下的單走同一套流程。
 */
export async function openCreateOrder(onDone) {
  const table = (await GET('/api/v1/settings/price-table')).rows;
  const twdOf = (jpy) => {
    const n = Number(jpy);
    if (!Number.isFinite(n) || n <= 0) return null;
    const row = table.find((r) => r.jpy_taxed_max >= n);
    return row ? row.twd : null;
  };

  let picked = null;
  const who = h('div', { class: 'small muted' }, '還沒選客人');
  const results = h('div', { class: 'grid', style: 'gap:6px;margin-top:8px' });
  const search = h('input', { id: 'oc-member', type: 'search', placeholder: '會員編號（HB-00012）或稱呼', autocomplete: 'off' });
  const pick = (m) => {
    picked = m;
    results.replaceChildren();
    search.value = '';
    who.replaceChildren(h('b', {}, `${m.nickname}（${m.member_no}）`),
      h('div', { class: 'tiny muted' }, `超商：${m.cvs || '未設定'}　宅配：${m.home_addr || '未設定'}`));
  };
  let t;
  search.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const q = search.value.trim();
      if (!q) { results.replaceChildren(); return; }
      const list = await GET('/api/v1/members/lookup?q=' + encodeURIComponent(q));
      results.replaceChildren(...(list.length ? list.map((m) => h('button', {
        type: 'button', class: 'persona', onClick: () => pick(m),
      }, h('div', { class: 'avatar' }, m.nickname.slice(0, 1)),
      h('div', {}, h('div', {}, m.nickname), h('div', { class: 'tiny muted' }, m.member_no)))) : [h('div', { class: 'tiny muted' }, '找不到符合的會員')]));
    }, 250);
  });

  const rows = h('div', { class: 'grid', style: 'gap:10px' });
  const total = h('div', { class: 'small', style: 'text-align:right' });
  const lines = [];
  const recalc = () => {
    let sum = 0; let unpriced = 0;
    for (const l of lines) {
      const manual = l.twd.value.trim();
      const auto = twdOf(l.jpy.value);
      const unit = manual !== '' ? Number(manual) : auto;
      l.hint.textContent = manual !== '' ? '用你填的台幣價'
        : auto != null ? `照價目表：${nt(auto)}` : (l.jpy.value ? '超出價目表，請直接填台幣' : '沒填價錢：之後在報價補上');
      if (unit == null) unpriced += 1; else sum += unit * (Number(l.qty.value) || 1);
    }
    total.textContent = `品項小計 ${nt(sum)}${unpriced ? `（另有 ${unpriced} 項待報價）` : ''}，運費依取貨方式另計`;
  };
  const addLine = () => {
    const i = lines.length + 1;
    const l = {
      name: h('input', { id: `oc-name-${i}`, type: 'text', placeholder: '品名（例：Pigeon 奶瓶 240ml）', maxlength: '80' }),
      jpy: h('input', { id: `oc-jpy-${i}`, type: 'number', min: '1', placeholder: '日幣含稅價', inputmode: 'numeric' }),
      qty: h('input', { id: `oc-qty-${i}`, type: 'number', min: '1', max: '99', value: '1', inputmode: 'numeric' }),
      twd: h('input', { id: `oc-twd-${i}`, type: 'number', min: '0', placeholder: '台幣（可不填）', inputmode: 'numeric' }),
      hint: h('div', { class: 'tiny muted' }),
    };
    for (const k of ['jpy', 'qty', 'twd']) l[k].addEventListener('input', recalc);
    lines.push(l);
    rows.append(h('div', { class: 'card', style: 'padding:10px;box-shadow:none' },
      l.name,
      h('div', { class: 'row', style: 'margin-top:8px;align-items:flex-end' },
        h('label', { style: 'flex:2 1 120px' }, h('span', { class: 'tiny muted' }, '日幣含稅價'), l.jpy),
        h('label', { style: 'flex:1 1 70px' }, h('span', { class: 'tiny muted' }, '數量'), l.qty),
        h('label', { style: 'flex:2 1 120px' }, h('span', { class: 'tiny muted' }, '台幣售價（談好的價錢才填）'), l.twd)),
      l.hint));
    recalc();
  };
  addLine();

  const pickup = h('select', { id: 'oc-pickup' }, h('option', { value: 'cvs' }, '超商取貨'), h('option', { value: 'home' }, '宅配到府'));
  const note = h('input', { id: 'oc-note', type: 'text', maxlength: '300', placeholder: '備註（例：客人 LINE 私訊下單）' });

  modal('代客下單', h('div', {},
    h('label', { class: 'field' }, h('span', {}, '1. 找客人'), search, results),
    who,
    h('div', { class: 'field', style: 'margin-top:14px' }, h('span', { class: 'small muted' }, '2. 品項'), rows,
      h('button', { type: 'button', class: 'btn sm', style: 'margin-top:8px', onClick: addLine }, '＋ 再加一項')),
    h('label', { class: 'field' }, h('span', {}, '3. 取貨方式'), pickup),
    h('label', { class: 'field' }, h('span', {}, '備註'), note),
    total), [
    { label: '取消', onClick: (close) => close() },
    {
      label: '建立訂單', primary: true,
      onClick: async (close) => {
        if (!picked) throw new Error('請先選擇客人');
        const items = lines.filter((l) => l.name.value.trim()).map((l) => ({
          name: l.name.value.trim(),
          qty: Number(l.qty.value) || 1,
          jpy_taxed: l.jpy.value ? Number(l.jpy.value) : null,
          price_twd: l.twd.value.trim() !== '' ? Number(l.twd.value) : null,
        }));
        if (!items.length) throw new Error('至少要填一個品名');
        const r = await POST('/api/v1/orders/create', {
          member_no: picked.member_no, items, pickup_type: pickup.value, note: note.value.trim(),
        });
        close();
        toast(`已替 ${r.nickname} 建立訂單 ${r.order_id}（${nt(r.total_twd)}）。${r.next}`);
        if (onDone) onDone(r);
      },
    },
  ]);
  search.focus();
}
