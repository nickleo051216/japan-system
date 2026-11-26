import { GET, POST, h, nt, dt, toast, fail, modal, session } from '../app.js';

/**
 * 客人購物車（2026-11-26，周小姐：「客人測試時後台好像沒有同步」）。
 *
 * 客人拍照下單、按 +1、文字下單之後，東西先放在客人的購物車，要客人按「確認」「結帳」才會變成訂單。
 * 以前後台要等結帳才看得到；這一頁讓店家先看到客人放了什麼。
 *   - 依客人分組，每一件附照片、來源（拍照下單／喊單 +1…）、AI 辨識狀態、價格、上傳時間
 *   - 「等你報價」排最上面：拍照下單 AI 沒認出價格、或沒辨識出來的
 *   - 「報價」：填品名＋日幣（照價目表換算）或台幣 → LINE 通知客人到購物車確認
 */
const OCR_TAG = { pending: ['AI 辨識中', 'amber'], done: ['AI 已辨識', 'green'], failed: ['AI 沒認出來', 'red'], none: null };

export async function render(root, ctx) {
  const only = ctx.query.only === 'photo' ? 'photo' : 'all';
  const canQuote = session.can('order.write');
  const showPrice = session.can('order.read.price');
  const search = h('input', { type: 'search', placeholder: '搜尋客人、會員編號、品名…', value: ctx.query.q || '' });
  const body = h('div', {});
  root.append(
    h('div', { class: 'lc-tools' },
      h('a', { class: 'btn sm' + (only === 'all' ? ' primary' : ''), href: '#/carts' }, '全部'),
      h('a', { class: 'btn sm' + (only === 'photo' ? ' primary' : ''), href: '#/carts?only=photo' }, '只看拍照下單'),
      search),
    h('div', { class: 'banner info' }, '這裡是客人還沒結帳的東西。拍照下單 AI 沒認出價格的，按「報價」填好，客人會收到 LINE 通知，到購物車確認後就能結帳。'),
    body);

  let timer = null;
  const load = async () => {
    const qs = new URLSearchParams({ ...(only === 'photo' ? { only } : {}), ...(search.value.trim() ? { q: search.value.trim() } : {}) });
    const d = await GET('/api/v1/carts/admin-list' + (qs.toString() ? '?' + qs : ''));
    body.innerHTML = '';
    body.append(h('div', { class: 'row', style: 'gap:8px;margin:0 0 10px' },
      d.needs_quote ? h('span', { class: 'tag amber' }, `等你報價 ${d.needs_quote} 件`) : h('span', { class: 'tag green' }, '沒有等報價的拍照下單'),
      h('span', { class: 'tiny muted' }, `${d.customers} 位客人、${d.items.length} 件`)));
    if (!d.items.length) { body.append(h('div', { class: 'card' }, h('div', { class: 'empty' }, '客人的購物車目前是空的'))); return; }
    const groups = new Map();
    for (const it of d.items) {
      const k = it.member_no || it.nickname;
      if (!groups.has(k)) groups.set(k, { nickname: it.nickname, member_no: it.member_no, items: [] });
      groups.get(k).items.push(it);
    }
    for (const g of groups.values()) {
      body.append(h('div', { class: 'card', style: 'padding:14px;margin-bottom:12px' },
        h('div', { class: 'row', style: 'gap:6px;margin-bottom:8px' }, h('strong', {}, g.nickname),
          g.member_no ? h('span', { class: 'tiny muted mono' }, g.member_no) : null,
          h('span', { class: 'spacer', style: 'flex:1' }), h('span', { class: 'tiny muted' }, `${g.items.length} 件`)),
        ...g.items.map((it) => itemRow(it))));
    }
  };

  const itemRow = (it) => {
    const tag = OCR_TAG[it.ocr_status];
    return h('div', { class: 'sr-order' + (it.needs_quote ? ' picked' : '') },
      h('div', { class: 'row', style: 'gap:10px;flex-wrap:nowrap;align-items:flex-start' },
        it.image_url ? h('a', { href: it.image_url, target: '_blank', rel: 'noopener' }, h('img', { class: 'thumb', src: it.image_url, alt: '' }))
          : h('div', { class: 'thumb ph' }, it.source === 'image' ? '📷' : '🛍️'),
        h('div', { style: 'flex:1;min-width:0' },
          h('div', { class: 'row', style: 'gap:6px' }, h('span', { class: 'tag' }, it.source_zh),
            tag ? h('span', { class: 'tag ' + tag[1] }, tag[0]) : null,
            h('span', { class: 'tag ' + (it.status === 'confirmed' ? 'green' : '') }, it.status === 'confirmed' ? '客人已確認' : '待客人確認')),
          h('div', { style: 'margin-top:4px' }, it.name, it.size ? `（${it.size}）` : '', ` ×${it.qty}`),
          h('div', { class: 'tiny muted' }, [showPrice ? (it.price_twd !== null ? nt(it.price_twd) : '還沒有價格') : null, it.ocr_message || it.note || null, dt(it.created_at)].filter(Boolean).join('・'))),
        canQuote && it.source === 'image'
          ? h('button', { class: 'btn sm' + (it.needs_quote ? ' primary' : ''), type: 'button', onClick: () => quoteDialog(it) }, it.price_twd === null ? '報價' : '改價')
          : null));
  };

  const quoteDialog = (it) => {
    const name = h('input', { type: 'text', maxlength: '80', value: it.name === '拍照下單' ? '' : it.name, placeholder: '例：Pigeon 母乳實感奶瓶 240ml' });
    const jpyIn = h('input', { type: 'number', min: '1', inputmode: 'numeric', placeholder: '日幣含稅價（照價目表換算）', value: it.jpy_taxed || '' });
    const twdIn = h('input', { type: 'number', min: '1', inputmode: 'numeric', placeholder: '或直接填台幣售價' });
    const errBox = h('div', { class: 'tiny', role: 'alert', style: 'color:var(--red)' });
    modal(`替 ${it.nickname} 報價`, h('div', {},
      it.image_url ? h('img', { src: it.image_url, alt: '', style: 'max-width:100%;max-height:260px;border-radius:12px;margin-bottom:8px' }) : null,
      h('label', { class: 'field' }, h('span', {}, '品名'), name),
      h('div', { class: 'row', style: 'gap:8px' },
        h('label', { class: 'field', style: 'flex:1' }, h('span', {}, '日幣含稅價'), jpyIn),
        h('label', { class: 'field', style: 'flex:1' }, h('span', {}, '台幣售價'), twdIn)),
      h('div', { class: 'tiny muted' }, `數量 ${it.qty}。報好價客人會收到 LINE 通知，到購物車確認後才能結帳。`),
      errBox), [{
      label: '報價並通知客人', primary: true,
      onClick: async (close) => {
        errBox.textContent = '';
        try {
          const r = await POST('/api/v1/carts/quote', { cart_id: it.cart_id, name: name.value.trim(),
            jpy_taxed: jpyIn.value ? Number(jpyIn.value) : null, price_twd: twdIn.value ? Number(twdIn.value) : null });
          close(); toast(`已報價 ${nt(r.price_twd)}${r.notified ? '，並通知客人' : ''}`); load().catch(fail);
        } catch (e) { errBox.textContent = e.message; }
      },
    }]);
  };

  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => load().catch(fail), 300); });
  await load();
}
