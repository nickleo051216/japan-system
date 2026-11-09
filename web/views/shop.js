import { GET, POST, h, nt, jpy, dt, toast, fail, session } from '../app.js';

/**
 * 開團與喊單。客人首頁顯示的團別與喊單就是從這裡來的 ——
 * 這一頁沒東西，前台首頁就是空的。
 */
export async function render(root, ctx) {
  const canBatch = session.can('settings.write');

  // ---- 開團 ----
  if (canBatch) {
    const f = {
      batch: h('input', { type: 'text', placeholder: '例：T-261015' }),
      name: h('input', { type: 'text', placeholder: '例：10/15 大阪採買' }),
      region: h('input', { type: 'text', placeholder: '例：大阪' }),
      close: h('input', { type: 'datetime-local' }),
    };
    const batches = await GET('/api/v1/settings/batches');
    root.append(h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, '開團'), h('div', { class: 'spacer' }),
        h('span', { class: 'muted tiny' }, `目前團別：${batches.current_batch || '尚未設定'}`)),
      h('div', { class: 'card-body' },
        h('div', { class: 'banner info' }, '新開的團會自動設為「目前團別」—— 客人首頁、結帳歸團、新開的喊單都跟著它走。'),
        h('div', { class: 'row', style: 'flex-wrap:wrap;gap:10px' },
          h('label', { class: 'field' }, h('span', {}, '團號'), f.batch),
          h('label', { class: 'field' }, h('span', {}, '團名'), f.name),
          h('label', { class: 'field' }, h('span', {}, '地區'), f.region),
          h('label', { class: 'field' }, h('span', {}, '截單時間'), f.close)),
        h('button', {
          class: 'btn primary', onClick: async () => {
            try {
              const r = await POST('/api/v1/settings/batch/create', {
                batch: f.batch.value.trim(), name: f.name.value.trim(), region: f.region.value.trim() || null,
                close_at: f.close.value ? new Date(f.close.value).toISOString() : null });
              toast(`已開團 ${r.batch}，並設為目前團別`);
              ctx.reload();
            } catch (e) { fail(e); }
          },
        }, '開團'))));
  }

  // ---- 開喊單 ----
  // 表單需要先知道：有沒有開團、價目表到多少錢。周小姐第一次開喊單就是卡在
  // 「日幣超過價目表上限」，而錯誤只用 toast 閃一下，手機上根本沒看到。
  const info = await GET('/api/v1/broadcast/form-info');
  const b = {
    name: h('input', { type: 'text', placeholder: '品名，例：西松屋 紗布巾' }),
    jpy: h('input', { type: 'number', min: '1', placeholder: '日幣税込', inputmode: 'numeric' }),
    twd: h('input', { type: 'number', min: '1', placeholder: '留空＝照價目表', inputmode: 'numeric' }),
    qty: h('input', { type: 'number', min: '1', value: '1', inputmode: 'numeric' }),
    deadline: h('input', { type: 'datetime-local' }),
    note: h('input', { type: 'text', placeholder: '備註（選填）' }),
    batchName: h('input', { type: 'text', maxlength: '40', placeholder: '例：11/20 大阪採買' }),
    photo: h('input', { type: 'file', accept: 'image/*' }),
  };
  const maxJpy = info.price_max_jpy;
  const priceHint = h('div', { class: 'tiny muted' }, maxJpy
    ? `價目表目前到 ¥${maxJpy.toLocaleString('ja-JP')}。日幣超過這個金額，請直接填台幣售價。`
    : '價目表還是空的，請直接填台幣售價。');
  // 填日幣的當下就提醒，不用等送出才被擋。
  const jpyWarn = h('div', { class: 'tiny', style: 'color:var(--red)', hidden: true });
  b.jpy.addEventListener('input', () => {
    const v = Number(b.jpy.value);
    const over = maxJpy && v > maxJpy && !b.twd.value;
    jpyWarn.hidden = !over;
    jpyWarn.textContent = over ? `¥${v.toLocaleString('ja-JP')} 超過價目表上限，請在「台幣」填售價` : '';
  });
  b.twd.addEventListener('input', () => { if (b.twd.value) jpyWarn.hidden = true; });

  // 錯誤留在表單上，直到下一次送出或改了欄位才消失。
  const formError = h('div', { class: 'banner', role: 'alert', hidden: true,
    style: 'background:var(--red-bg);border:1px solid #f0c8c4;color:var(--red);margin:12px 0 0' });
  const showError = (msg) => { formError.textContent = msg; formError.hidden = false; };
  for (const el of Object.values(b)) el.addEventListener('input', () => { formError.hidden = true; });

  // 照片：選了就先在手機上壓縮（長邊 1200px、JPEG），再顯示預覽。
  const preview = h('img', { class: 'thumb lg', alt: '', hidden: true });
  let photoData = null;
  b.photo.addEventListener('change', async () => {
    photoData = null; preview.hidden = true;
    const file = b.photo.files && b.photo.files[0];
    if (!file) return;
    try {
      photoData = await compressImage(file);
      preview.src = photoData; preview.hidden = false;
    } catch (e) { showError(e.message); b.photo.value = ''; }
  });

  const batchField = info.batch ? null : h('label', { class: 'field', style: 'min-width:240px' },
    h('span', {}, '這一趟叫什麼？（還沒開團，會一起開）'), b.batchName);
  const batchBanner = info.batch
    ? h('div', { class: 'small muted', style: 'margin-bottom:10px' }, `會開在目前這一團：${info.batch.name || info.batch.batch}（${info.batch.batch}）`)
    : h('div', { class: 'banner warn' }, '還沒開團。喊單要放在某一趟採買底下，請在下面填「這一趟叫什麼」，按「開喊單」時系統會一起開團。'
        + (canBatch ? '也可以先到上面「開團」自己填團號。' : ''));

  const submit = h('button', {
    class: 'btn primary', onClick: async () => {
      formError.hidden = true;
      submit.disabled = true; submit.textContent = '開喊單中…';
      let created = null;
      try {
        created = await POST('/api/v1/broadcast/create', {
          name: b.name.value.trim(), jpy_taxed: b.jpy.value ? Number(b.jpy.value) : null,
          price_twd: b.twd.value ? Number(b.twd.value) : null, quantity: Number(b.qty.value),
          deadline_at: b.deadline.value ? new Date(b.deadline.value).toISOString() : null,
          note: b.note.value.trim() || null,
          batch_name: info.batch ? undefined : b.batchName.value.trim() });
      } catch (e) {
        showError(e.message || '開喊單失敗，請再試一次');
        submit.disabled = false; submit.textContent = '開喊單';
        return;
      }
      if (photoData) {
        submit.textContent = '上傳照片中…';
        try { await POST('/api/v1/broadcast/image', { send_id: created.send_id, data: photoData }); }
        catch (e) {
          // 喊單已經開出去了，照片之後在列表補上就好 —— 不要讓人以為整筆失敗而重開一張。
          toast(`已開喊單 ${created.send_id}，但照片沒上傳成功，可以在下面列表補上`, 'err');
          ctx.reload();
          return;
        }
      }
      toast(`已開喊單 ${created.send_id}：${nt(created.price_twd)} × ${created.quantity}`);
      ctx.reload();
    },
  }, '開喊單');

  root.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, '開喊單')),
    h('div', { class: 'card-body' },
      batchBanner,
      h('div', { class: 'row', style: 'flex-wrap:wrap;gap:10px' },
        batchField,
        h('label', { class: 'field', style: 'min-width:240px' }, h('span', {}, '品名'), b.name),
        h('label', { class: 'field' }, h('span', {}, '日幣'), b.jpy, jpyWarn),
        h('label', { class: 'field' }, h('span', {}, '台幣（選填）'), b.twd),
        h('label', { class: 'field' }, h('span', {}, '數量'), b.qty),
        h('label', { class: 'field' }, h('span', {}, '截止時間'), b.deadline),
        h('label', { class: 'field', style: 'min-width:200px' }, h('span', {}, '備註'), b.note),
        h('label', { class: 'field', style: 'min-width:220px' }, h('span', {}, '商品照片（選填）'), b.photo, preview)),
      priceHint,
      formError,
      h('div', { class: 'row', style: 'margin-top:12px' }, submit))));

  // ---- 喊單列表 ----
  const list = await GET('/api/v1/broadcast/admin-list');
  const tbody = h('tbody', {});
  root.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, `本團喊單（${list.batch || '未設定團別'}）`)),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, '照片'), h('th', {}, '編號'), h('th', {}, '品名'), h('th', {}, '售價'),
        h('th', {}, '已搶／總數'), h('th', {}, '候補'), h('th', {}, '截止'), h('th', {}, '狀態'), h('th', {}))),
      tbody))));
  if (!list.broadcasts.length) tbody.append(h('tr', {}, h('td', { colspan: '9', class: 'empty' }, '這一團還沒有喊單')));
  for (const x of list.broadcasts) {
    const delta = h('input', { type: 'number', value: '1', style: 'width:64px' });
    // 補上或更換照片：選了就壓縮、上傳。
    const picker = h('input', { type: 'file', accept: 'image/*', hidden: true });
    picker.addEventListener('change', async () => {
      const file = picker.files && picker.files[0];
      if (!file) return;
      try {
        const data = await compressImage(file);
        await POST('/api/v1/broadcast/image', { send_id: x.send_id, data });
        toast(`${x.send_id} 的照片已${x.image_url ? '更換' : '加上'}`);
        ctx.reload();
      } catch (e) { fail(e); }
    });
    tbody.append(h('tr', {},
      h('td', {}, x.image_url ? h('img', { class: 'thumb', src: x.image_url, alt: x.name }) : h('span', { class: 'tiny muted' }, '—')),
      h('td', { class: 'mono tiny' }, x.send_id),
      h('td', {}, x.name, x.jpy_taxed ? h('div', { class: 'tiny muted' }, jpy(x.jpy_taxed)) : null),
      h('td', {}, nt(x.price_twd)),
      h('td', {}, `${x.sold} / ${x.quantity}`),
      h('td', { class: 'tiny' }, x.waitlist ? `${x.waitlist} 人` : '—'),
      h('td', { class: 'tiny muted' }, dt(x.deadline_at)),
      h('td', {}, x.open ? h('span', { class: 'tag green' }, '可搶') : h('span', { class: 'tag' }, x.remaining ? '已截止' : '搶完')),
      h('td', {}, h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' },
        delta,
        h('button', { class: 'btn sm', onClick: async () => {
          try { const r = await POST('/api/v1/broadcast/adjust', { send_id: x.send_id, delta: Number(delta.value) });
            toast(`${x.send_id} 剩餘 ${r.remaining}`); ctx.reload(); } catch (e) { fail(e); } } }, '加減量'),
        h('button', { class: 'btn sm', onClick: () => picker.click() }, x.image_url ? '換照片' : '加照片'),
        picker,
        x.open ? h('button', { class: 'btn sm', onClick: async () => {
          try { await POST('/api/v1/broadcast/close', { send_id: x.send_id }); toast(`${x.send_id} 已截止`); ctx.reload(); }
          catch (e) { fail(e); } } }, '提前截止') : null))));
  }
}

/**
 * 把手機拍的照片縮成長邊 1200px 的 JPEG（data URL）。原圖動輒 3–5 MB，
 * 直接上傳會撞到伺服器一次 4.5 MB 的上限，客人那邊也載得慢。
 */
function compressImage(file, maxSide = 1200, quality = 0.85) {
  return new Promise((resolve, reject) => {
    if (!/^image\//.test(file.type || 'image/')) { reject(new Error('請選照片檔')); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * scale));
      c.height = Math.max(1, Math.round(img.naturalHeight * scale));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('讀不到這張照片，請換一張（JPG 或 PNG）')); };
    img.src = url;
  });
}
