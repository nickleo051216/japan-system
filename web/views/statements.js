import { GET, POST, h, nt, dt, toast, fail, downloadCsv, modal } from '../app.js';

/**
 * 對帳單。「結算」把已報價以上、還沒付清的訂單依客人歸成對帳單，並排入 LINE 通知。
 * 也可以交給 n8n 在每月結算日自動呼叫 —— 這個按鈕是手動補結算用的。
 */
export async function render(root, ctx) {
  const status = ctx.query.status || '';
  const rows = await GET('/api/v1/statements/admin-list' + (status ? '?status=' + encodeURIComponent(status) : ''));
  let auto = null;
  try { auto = await GET('/api/v1/statements/auto-status'); } catch { /* 舊版後端 */ }
  if (auto) root.append(autoCard(auto));

  root.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, '結算'), h('div', { class: 'spacer' }),
      h('button', { class: 'btn primary', onClick: async () => {
        try {
          const r = await POST('/api/v1/statements/generate', {});
          toast(r.created.length ? `已開出 ${r.created.length} 張對帳單，並排入 LINE 通知` : '沒有需要結算的訂單');
          ctx.reload();
        } catch (e) { fail(e); }
      } }, '立即結算'),
      h('button', { class: 'btn', onClick: async () => {
        try {
          const r = await POST('/api/v1/statements/remind-overdue', {});
          toast(r.reminded ? `已發 ${r.reminded} 則逾期付款提醒` : '沒有需要提醒的帳單（每張只提醒一次）');
        } catch (e) { fail(e); }
      } }, '發逾期提醒')),
    h('div', { class: 'card-body' }, h('div', { class: 'banner info' },
      '重按不會重複開單 —— 已經歸進對帳單的訂單不會再被挑出來。超過付款期限還沒付的，每天排程會自動提醒一次（每張帳單只提醒一次）。'))));

  try { root.append(await bankCard(ctx)); } catch { /* 022 還沒跑：先不顯示銀行入帳 */ }

  const tbody = h('tbody', {});
  const tabs = h('div', { class: 'row', style: 'gap:6px' }, ...['', '待付款', '待官方確認', '已核對'].map((t) =>
    h('a', { class: 'btn sm' + (t === status ? ' primary' : ''), href: '#/statements' + (t ? '?status=' + encodeURIComponent(t) : '') }, t || '全部')));
  root.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, '對帳單'), h('div', { class: 'spacer' }), tabs),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, '對帳單'), h('th', {}, '客人'), h('th', {}, '訂單數'), h('th', {}, '金額'),
        h('th', {}, '狀態'), h('th', {}, '回報末五碼'), h('th', {}, '開單'), h('th', {}))),
      tbody))));

  if (!rows.length) tbody.append(h('tr', {}, h('td', { colspan: '8', class: 'empty' }, '沒有對帳單')));
  for (const s of rows) {
    const amount = h('input', { type: 'number', value: String(s.total_amount), style: 'width:100px' });
    tbody.append(h('tr', {},
      h('td', { class: 'mono tiny' }, s.statement_id),
      h('td', {}, s.nickname),
      h('td', {}, s.order_count),
      h('td', {}, nt(s.total_amount)),
      h('td', {}, h('span', { class: 'tag ' + (s.payment_status === '已核對' ? 'green' : s.payment_status === '待官方確認' ? 'blue' : 'amber') }, s.payment_status)),
      h('td', { class: 'mono tiny' }, s.last_five_matched || '—',
        s.transfer_proof ? h('div', {}, h('a', { href: s.transfer_proof, target: '_blank', rel: 'noopener', class: 'tiny' }, '📎 匯款截圖')) : null),
      h('td', { class: 'tiny muted' }, dt(s.created_at)),
      h('td', {}, s.payment_status === '已核對' ? h('span', { class: 'tiny muted' }, dt(s.paid_at)) : h('div', { class: 'row', style: 'gap:6px' },
        amount,
        h('button', { class: 'btn sm primary', onClick: async () => {
          try {
            const r = await POST('/api/v1/statements/reconcile', { statement_id: s.statement_id, amount_twd: Number(amount.value) });
            toast(`${r.statement_id} 已核對，底下訂單一併標為已付款${r.shout_restored ? '；客人的喊單資格已恢復' : ''}`); ctx.reload();
          } catch (e) {
            // 金額對不上時不自動認列；店主確認差額後再送一次。
            if (e.code === 'AMOUNT_MISMATCH' && window.confirm(`${e.message}\n\n確定照這個金額認列？`)) {
              try {
                const r2 = await POST('/api/v1/statements/reconcile', { statement_id: s.statement_id, amount_twd: Number(amount.value), accept_difference: true });
                toast(`已認列（含差額）${r2.shout_restored ? '；客人的喊單資格已恢復' : ''}`); ctx.reload();
              } catch (e2) { fail(e2); }
            } else fail(e);
          }
        } }, '核帳')))));
  }
}

/**
 * 銀行入帳自動對帳（v1.8）：店主照網銀的入帳明細輸入一筆（參考號、金額、末五碼、入帳時間），
 * 系統用「末五碼＋金額」找客人回報過的帳單：剛好一張就直接核帳（標成已付、通知客人）；
 * 找不到或好幾張都對得上，就列在「待人工確認」，店主挑一張按「就是這張」。同一個參考號不能輸入兩次。
 */
async function bankCard(ctx) {
  const list = await GET('/api/v1/bank-credits/list');
  const ref = h('input', { type: 'text', placeholder: '網銀的交易參考號', maxlength: '60' });
  const amount = h('input', { type: 'number', min: '1', placeholder: '入帳金額', inputmode: 'numeric' });
  const last5 = h('input', { type: 'text', placeholder: '末五碼', maxlength: '5', inputmode: 'numeric' });
  const at = h('input', { type: 'datetime-local' });
  const errBox = h('div', { class: 'tiny', role: 'alert', style: 'color:var(--red)' });
  const submit = h('button', { class: 'btn primary', onClick: async () => {
    errBox.textContent = '';
    try {
      const r = await POST('/api/v1/bank-credits/create', { ref_no: ref.value, amount_twd: Number(amount.value), last5: last5.value || null,
        credited_at: at.value ? new Date(at.value).toISOString() : null });
      toast(r.status === 'matched' ? `配對成功：${r.statement.statement_id}（${r.statement.nickname}）已標成已付款，並通知客人` : `沒有自動配對：${r.reason}，請在下面挑一張帳單`);
      ctx.reload();
    } catch (e) { errBox.textContent = e.message; }
  } }, '輸入並配對');

  const rows = list.items.slice(0, 30).map((c) => h('div', { class: 'sr-order' },
    h('div', { class: 'row', style: 'gap:6px' },
      h('span', { class: 'tag ' + ({ matched: 'green', confirmed: 'green', needs_review: 'amber', ignored: '' }[c.status]) }, c.status_zh),
      h('strong', {}, nt(c.amount_twd)), h('span', { class: 'mono tiny' }, `末五碼 ${c.last5 || '—'}`),
      h('span', { class: 'spacer', style: 'flex:1' }), h('span', { class: 'tiny muted mono' }, `${c.ref_no}・${dt(c.credited_at)}`)),
    c.statement ? h('div', { class: 'tiny' }, `→ ${c.statement.statement_id}（${c.statement.nickname || ''}）`) : null,
    c.status === 'needs_review' ? h('div', {},
      h('div', { class: 'tiny muted', style: 'margin:4px 0' }, c.reason || ''),
      ...c.candidates.map((st) => h('div', { class: 'row', style: 'gap:6px;padding:2px 0' },
        h('span', { class: 'mono tiny' }, st.statement_id), h('span', { class: 'small' }, st.nickname),
        h('span', { class: 'small' }, nt(st.total_amount)), h('span', { class: 'tiny muted' }, `回報末五碼 ${st.last_five_matched || '—'}`),
        h('span', { class: 'spacer', style: 'flex:1' }),
        h('button', { class: 'btn sm primary', onClick: () => confirmMatch(c, st, ctx) }, '就是這張'))),
      h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:4px' },
        h('button', { class: 'btn sm ghost', onClick: async () => {
          try { await POST('/api/v1/bank-credits/ignore', { credit_id: c.credit_id }); toast('已標成不處理'); ctx.reload(); } catch (e) { fail(e); }
        } }, '不是貨款，不處理'))) : null));

  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, '銀行入帳自動對帳'), h('div', { class: 'spacer' }),
      list.needs_review ? h('span', { class: 'tag amber' }, `待人工確認 ${list.needs_review} 筆`) : null),
    h('div', { class: 'card-body' },
      h('div', { class: 'banner info' }, '照網銀的入帳明細輸入。末五碼＋金額剛好對到一張客人回報過的帳單，就直接核帳並通知客人；對不到或對到好幾張，會列在下面等你挑。'),
      h('div', { class: 'lc-tools' }, ref, amount, last5, at, submit), errBox,
      rows.length ? h('div', { style: 'margin-top:10px' }, ...rows) : h('div', { class: 'tiny muted', style: 'margin-top:8px' }, '還沒有輸入過入帳')));
}

function confirmMatch(c, st, ctx) {
  const diff = Math.round((c.amount_twd - st.total_amount) * 100) / 100;
  modal('確認這筆入帳', h('div', {},
    h('div', { class: 'small' }, `入帳 ${nt(c.amount_twd)}（末五碼 ${c.last5 || '—'}）→ ${st.statement_id}（${st.nickname}，${nt(st.total_amount)}）`),
    diff ? h('div', { class: 'banner warn' }, `金額相差 NT$${diff}，確定的話會照入帳金額認列。`) : null,
    h('div', { class: 'tiny muted' }, '確認後帳單和底下的訂單會標成已付款，並 LINE 通知客人。')), [{
    label: '確認入帳', primary: true,
    onClick: async (close) => {
      try {
        await POST('/api/v1/bank-credits/confirm', { credit_id: c.credit_id, statement_id: st.statement_id, accept_difference: !!diff });
        close(); toast(`${st.statement_id} 已標成已付款，並通知客人`); ctx.reload();
      } catch (e) { fail(e); }
    },
  }]);
}

/**
 * 自動結算的燈號（每月結算日由 Vercel 排程自動結算）。
 * 綠燈＝上次檢查正常；紅燈＝被擋下來、出錯或太久沒檢查；灰燈＝還沒檢查過或關掉了。
 * 測試方法：Vercel → Settings → Cron Jobs → Run，回來重新整理這一頁看「上次檢查」的時間有沒有變。
 */
function autoCard(a) {
  const md = (ymd) => (ymd ? `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}` : '—');
  const dot = { green: '🟢', red: '🔴', grey: '⚪' }[a.light];
  const c = a.last_check;
  return h('div', { class: 'card', style: 'padding:14px' + (a.light === 'red' ? ';border-color:var(--red)' : '') },
    h('div', { class: 'row', style: 'gap:8px' },
      h('strong', {}, `${dot} 自動結算`), h('span', { class: 'tag ' + (a.on ? 'green' : '') }, a.on ? '開著' : '關掉了'),
      h('span', { class: 'spacer', style: 'flex:1' }),
      a.next_date ? h('span', { class: 'small' }, '下次結算 ', h('b', {}, md(a.next_date))) : null),
    h('div', { class: 'small', style: 'margin-top:6px' + (a.light === 'red' ? ';color:var(--red)' : '') }, a.say),
    h('div', { class: 'tiny muted', style: 'margin-top:4px' },
      c ? `上次檢查 ${dt(c.at)}` : '還沒有檢查紀錄',
      a.last_ran_date ? `・上次真的結算 ${md(a.last_ran_date)}` : '', `・結算日 ${a.statement_days}`));
}

/** 頁首「↗ 匯出備份」：全部對帳單存成 CSV。 */
export async function exportBackup() {
  const rows = await GET('/api/v1/statements/admin-list');
  downloadCsv(`heeehababy-statements-${new Date().toISOString().slice(0, 10)}.csv`, [
    { label: '對帳單', key: 'statement_id' }, { label: '客人', key: 'nickname' }, { label: '訂單數', key: 'order_count' },
    { label: '金額', key: 'total_amount' }, { label: '狀態', key: 'payment_status' }, { label: '回報末五碼', key: 'last_five_matched' },
    { label: '開單', key: 'created_at' }, { label: '付清', key: 'paid_at' },
  ], rows);
  toast(`已匯出 ${rows.length} 張對帳單`);
}
