import { POST, h, dt, toast, fail, session } from '/app.js';

/**
 * F-17 掃碼核對工作站.
 * Assumes a keyboard-wedge scanner: the scan arrives as keystrokes ending in
 * Enter. The input keeps focus at all times so 20 packages in a row need no
 * mouse; the verdict is a large colour block readable across a warehouse.
 */
export async function render(root) {
  const canOverride = session.can('override.blocked');
  const input = h('input', { type: 'text', class: 'scan-input', placeholder: '請掃描包裹上的 QR（或手動輸入後按 Enter）', autocomplete: 'off', spellcheck: 'false' });
  const light = h('div', { class: 'scan-light idle' },
    h('div', { class: 'big' }, '等待掃描'), h('div', { class: 'sub' }, '掃描器請設定為鍵盤模擬模式，掃描後自動送出'));
  const detail = h('div', { class: 'card-body', style: 'display:none' });
  const historyBody = h('tbody', {});
  let last = null;

  const keepFocus = () => input.focus();
  document.addEventListener('click', keepFocus);
  input.addEventListener('blur', () => setTimeout(keepFocus, 0));

  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const code = input.value.trim();
    input.value = '';               // ready for the next scan immediately
    if (!code) return;
    await verify(code);
  });

  async function verify(code) {
    try {
      const r = await POST('/api/v1/scan/verify', { code });
      last = { ...r, code };
      paint(r);
      addHistory(r);
    } catch (e) { fail(e); }
  }

  function paint(r) {
    light.className = 'scan-light ' + r.level;
    light.innerHTML = '';
    const headline = { green: '核對通過', amber: '請確認', yellow: '請確認', red: '不可出貨' }[r.level] || '';
    light.append(
      h('div', { class: 'big' }, r.level === 'green' ? '✓ 核對通過' : r.level === 'yellow' ? '⚠ ' + r.message : '✕ ' + r.message),
      h('div', { class: 'sub' }, r.level === 'green' ? '可以出貨' : `檢查第 ${r.step} 項　${r.order_id || ''}`));
    if (r.level === 'yellow') light.className = 'scan-light amber';

    detail.style.display = '';
    detail.innerHTML = '';
    if (r.order_id) {
      detail.append(h('div', { class: 'row' },
        h('strong', { class: 'mono' }, r.order_id),
        r.nickname ? h('span', { class: 'tag' }, r.nickname) : null,
        r.status ? h('span', { class: 'tag' }, r.status) : null));
      if (r.items) detail.append(h('div', { class: 'small muted', style: 'margin-top:8px' }, r.items.map((i) => `${i.name_zh}×${i.qty}`).join('、')));
      if (r.missing) detail.append(h('div', { class: 'banner warn', style: 'margin-top:10px' }, `缺少：${r.missing.join('、')}`));
    }

    const actions = h('div', { class: 'row', style: 'margin-top:14px' });
    if (r.level === 'green') {
      actions.append(h('button', { class: 'btn primary', onClick: () => commit() }, '確認出貨並通知客人'));
    } else if (r.level === 'yellow') {
      if (canOverride && r.code !== 'ALREADY_SHIPPED') {
        const reason = h('input', { type: 'text', placeholder: '覆寫原因（必填，寫入稽核）', style: 'max-width:340px' });
        actions.append(reason, h('button', { class: 'btn', onClick: () => commit(reason.value) }, '店主覆寫並出貨'));
      } else {
        actions.append(h('span', { class: 'muted small' },
          r.code === 'ALREADY_SHIPPED' ? '已出貨的訂單不可重複出貨。' : '黃燈需店主權限覆寫，請找店主處理。'));
      }
    } else {
      actions.append(h('span', { class: 'muted small' }, '紅燈不可覆寫。'));
    }
    detail.append(actions);
    keepFocus();
  }

  async function commit(reason) {
    try {
      const r = await POST('/api/v1/scan/commit', { code: last.code, override_reason: reason || null });
      toast(`${r.order_id} 已出貨` + (r.override_reason ? '（覆寫）' : ''));
      light.className = 'scan-light green';
      light.innerHTML = '';
      light.append(h('div', { class: 'big' }, '✓ 已出貨'), h('div', { class: 'sub' }, `${r.order_id}　已推播出貨通知`));
      detail.innerHTML = '';
      detail.append(h('pre', { style: 'white-space:pre-wrap;margin:0;font:inherit;background:#fafaf8;border:1px solid var(--line);border-radius:9px;padding:12px' }, r.notification));
      addHistory({ level: 'green', code: 'SHIPPED', message: '已出貨' + (reason ? '（覆寫）' : ''), order_id: r.order_id });
      keepFocus();
    } catch (e) { fail(e); }
  }

  function addHistory(r) {
    historyBody.prepend(h('tr', {},
      h('td', { class: 'tiny muted' }, dt(new Date().toISOString())),
      h('td', {}, h('span', { class: 'tag ' + (r.level === 'green' ? 'green' : r.level === 'yellow' ? 'amber' : 'red') },
        r.level === 'green' ? '綠' : r.level === 'yellow' ? '黃' : '紅')),
      h('td', { class: 'mono tiny' }, r.order_id || '—'),
      h('td', {}, r.message)));
    while (historyBody.children.length > 20) historyBody.lastChild.remove();
  }

  root.append(
    h('div', { class: 'card' },
      h('div', { class: 'card-body' }, input,
        h('div', { class: 'tiny muted', style: 'margin-top:8px;text-align:center' },
          '輸入框永遠保持焦點；掃描後自動清空，可連續掃描不需滑鼠。')),
      h('div', { class: 'card-body', style: 'padding-top:0' }, light),
      detail),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, '本次掃描紀錄')),
      h('div', { class: 'table-wrap' }, h('table', { class: 'scan-history' },
        h('thead', {}, h('tr', {}, h('th', {}, '時間'), h('th', {}, '燈號'), h('th', {}, '訂單'), h('th', {}, '結果'))),
        historyBody))));

  keepFocus();
}
