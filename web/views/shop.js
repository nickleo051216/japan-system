import { GET, POST, h, nt, jpy, dt, toast, fail, session } from '../app.js';

/**
 * 開團與喊單。客人首頁顯示的團別與喊單就是從這裡來的 ——
 * 這一頁沒東西，前台首頁就是空的。
 */
export async function render(root, ctx) {
  const canBatch = session.can('settings.write');

  // ---- 開團 ----（畫在「開喊單」下面：周小姐最常用的是開喊單，要一打開就看到）
  let batchCard = null;
  if (canBatch) {
    const f = {
      batch: h('input', { type: 'text', placeholder: '例：T-261015' }),
      name: h('input', { type: 'text', placeholder: '例：10/15 大阪採買' }),
      region: h('input', { type: 'text', placeholder: '例：大阪' }),
      close: h('input', { type: 'datetime-local' }),
    };
    const batches = await GET('/api/v1/settings/batches');
    batchCard = h('div', { class: 'card' },
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
        }, '開團')));
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
    // 「拍商品照」直接開相機（capture）；「從相簿選」給已經拍好的。兩個都藏在按鈕裡面。
    photo: h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true }),
    album: h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true }),
    sizes: h('input', { type: 'text', placeholder: '例：90,100,110（不用選尺寸就留空）' }),
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

  // 照片：最多 4 張（客人「每日連線」看到的是 2×2）。拍一張加一張，相簿可以一次選好幾張。
  // 選了就先在手機上壓縮（長邊 1200px、JPEG），再顯示預覽；第 1 張是封面。
  const MAX_PHOTOS = 4;
  const photos = [];
  const previews = h('div', { class: 'row', style: 'gap:6px' });
  const paint = () => {
    previews.replaceChildren(...photos.map((src, i) => h('div', { style: 'position:relative' },
      h('img', { class: 'thumb lg', src, alt: `第 ${i + 1} 張` }),
      i === 0 ? h('span', { class: 'tag', style: 'position:absolute;left:4px;bottom:4px;font-size:10px;padding:0 6px' }, '封面') : null,
      h('button', { class: 'btn sm', type: 'button', 'aria-label': '移除這張',
        style: 'position:absolute;top:-6px;right:-6px;min-height:24px;padding:0 7px;border-radius:99px',
        onClick: () => { photos.splice(i, 1); paint(); } }, '✕'))));
  };
  const onPick = (input) => async () => {
    const files = [...(input.files || [])];
    input.value = '';
    for (const file of files) {
      if (photos.length >= MAX_PHOTOS) { showError(`一件商品最多 ${MAX_PHOTOS} 張照片`); break; }
      try { photos.push(await compressImage(file)); } catch (e) { showError(e.message); }
    }
    paint();
    if (photos.length) b.name.focus();
  };
  b.photo.addEventListener('change', onPick(b.photo));
  b.album.addEventListener('change', onPick(b.album));

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
          sizes: b.sizes.value.trim() || null,
          batch_name: info.batch ? undefined : b.batchName.value.trim() });
      } catch (e) {
        showError(e.message || '開喊單失敗，請再試一次');
        submit.disabled = false; submit.textContent = '開喊單';
        return;
      }
      if (photos.length) {
        try {
          // 一張一張傳：一次全部塞進同一個請求會超過伺服器 4.5 MB 的上限。
          for (const [i, data] of photos.entries()) {
            submit.textContent = `上傳照片 ${i + 1}/${photos.length}…`;
            await POST('/api/v1/broadcast/image', { send_id: created.send_id, data, mode: 'append' });
          }
        } catch (e) {
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

  root.append(h('div', { class: 'card', id: 'new-broadcast' },
    h('div', { class: 'card-head' }, h('h2', {}, '開喊單')),
    h('div', { class: 'card-body' },
      batchBanner,
      h('div', { class: 'row', style: 'gap:10px;margin-bottom:12px;align-items:center' },
        h('label', { class: 'btn primary', style: 'min-height:52px;font-size:16px;padding:10px 20px' }, '📷 拍商品照', b.photo),
        h('label', { class: 'btn' }, '從相簿選（可多張）', b.album),
        previews),
      h('div', { class: 'tiny muted', style: 'margin:-6px 0 10px' }, `最多 ${MAX_PHOTOS} 張，第 1 張是封面；客人「每日連線」會拼成 2×2。`),
      h('div', { class: 'row', style: 'flex-wrap:wrap;gap:10px' },
        batchField,
        h('label', { class: 'field', style: 'min-width:240px' }, h('span', {}, '品名'), b.name),
        h('label', { class: 'field' }, h('span', {}, '日幣'), b.jpy, jpyWarn),
        h('label', { class: 'field' }, h('span', {}, '台幣（選填）'), b.twd),
        h('label', { class: 'field' }, h('span', {}, '數量'), b.qty),
        h('label', { class: 'field' }, h('span', {}, '截止時間'), b.deadline),
        h('label', { class: 'field', style: 'min-width:200px' }, h('span', {}, '備註'), b.note),
        h('label', { class: 'field', style: 'min-width:240px' }, h('span', {}, '尺寸選項（選填）'), b.sizes)),
      priceHint,
      formError,
      h('div', { class: 'row', style: 'margin-top:12px' }, submit))));

  // ---- 多張照片上架（2026-11-25 照周小姐影片 1；017）----
  root.append(await listingCard(ctx, info, b.batchName));

  if (batchCard) root.append(batchCard);

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
    const count = (x.images || []).length;
    const full = count >= 4;
    const picker = h('input', { type: 'file', accept: 'image/*', multiple: !full, hidden: true });
    picker.addEventListener('change', async () => {
      const files = [...(picker.files || [])];
      if (!files.length) return;
      try {
        // 還沒滿 4 張就一張一張加上去；滿了就是整組換掉（只留新選的第一張）。
        let n = 0;
        for (const file of files) {
          if (!full && count + n >= 4) break;
          const data = await compressImage(file);
          await POST('/api/v1/broadcast/image', { send_id: x.send_id, data, mode: full ? 'replace' : 'append' });
          n += 1;
          if (full) break;
        }
        toast(full ? `${x.send_id} 的照片已換成新的一張` : `${x.send_id} 加了 ${n} 張照片`);
        ctx.reload();
      } catch (e) { fail(e); }
    });
    tbody.append(h('tr', {},
      h('td', {}, x.image_url ? h('div', { style: 'position:relative;display:inline-block' },
        h('img', { class: 'thumb', src: x.image_url, alt: x.name }),
        count > 1 ? h('span', { class: 'tag', style: 'position:absolute;right:-6px;bottom:-6px;font-size:10px;padding:0 6px' }, `${count} 張`) : null)
        : h('span', { class: 'tiny muted' }, '—')),
      h('td', { class: 'mono tiny' }, x.send_id),
      h('td', {}, x.name, x.jpy_taxed ? h('div', { class: 'tiny muted' }, jpy(x.jpy_taxed)) : null,
        x.sizes ? h('div', { class: 'tiny muted' }, `尺寸：${x.sizes.join('／')}`) : null),
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
        h('button', { class: 'btn sm', onClick: () => picker.click() }, full ? '換照片' : `加照片（${count}/4）`),
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
export function compressImage(file, maxSide = 1200, quality = 0.85) {
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

/**
 * ▼ 多張照片上架：一次選好幾張，每張是一件商品。
 * 每張上傳後交給 AI（n8n 拍照辨識）讀品名和照片上的台幣售價；讀不到就請店主填。
 * 改過的欄位離開時就存回後端（之後才到的 AI 結果不會蓋掉）。最下面「一起刊登 N 件商品」一次開 N 張喊單。
 */
async function listingCard(ctx, info, batchNameInput) {
  let drafts = [];
  try { drafts = await GET('/api/v1/listings/drafts'); } catch { /* 017 還沒跑 */ return h('span'); }
  const box = h('details', { class: 'card listing', open: drafts.length > 0 || ctx.query.multi === '1' });
  const list = h('div', { class: 'ld-list' });
  const errBox = h('div', { class: 'small', role: 'alert', style: 'color:var(--red)' });
  const status = h('span', { class: 'tiny muted' });
  const qty = h('input', { type: 'number', min: '1', value: '1', inputmode: 'numeric', style: 'width:90px' });
  const publishBtn = h('button', { class: 'btn primary', type: 'button' }, '一起刊登 0 件商品');
  const rows = new Map();   // draft_id → { d, name, price, size, hint, el }
  let tick = 0;

  const save = async (r, field) => {
    const body = { draft_id: r.d.draft_id };
    if (field === 'name') body.name = r.name.value;
    if (field === 'price') body.price_twd = r.price.value === '' ? null : Number(r.price.value);
    if (field === 'size') body.size_note = r.size.value;
    try { r.d = await POST('/api/v1/listings/update', body); paintHint(r); } catch (e) { errBox.textContent = e.message; }
  };
  const paintHint = (r) => {
    const reading = r.d.ocr === 'reading';
    r.hint.textContent = reading ? (tick % 2 ? '正在讀取台幣售價…' : '正在辨識照片…')
      : !r.price.value ? '未辨識到單一台幣售價，請填寫' : '請確認商品名稱，可直接修改';
    r.hint.className = 'tiny ' + (reading ? 'muted' : !r.price.value ? 'warn-ink' : 'muted');
  };
  const refreshBtn = () => {
    const n = rows.size;
    publishBtn.textContent = `一起刊登 ${n} 件商品`;
    publishBtn.disabled = !n;
  };
  const addRow = (d) => {
    const r = {
      d,
      price: h('input', { type: 'number', min: '1', inputmode: 'numeric', placeholder: '台幣售價', value: d.price_twd ?? '' }),
      name: h('input', { type: 'text', maxlength: '60', placeholder: '商品名稱', value: d.name || '' }),
      size: h('input', { type: 'text', maxlength: '40', placeholder: '例如 90 / 100 / 110', value: d.size_note || '' }),
      hint: h('div', { class: 'tiny muted' }),
    };
    r.price.addEventListener('change', () => save(r, 'price'));
    r.name.addEventListener('change', () => save(r, 'name'));
    r.size.addEventListener('change', () => save(r, 'size'));
    r.el = h('div', { class: 'ld-row' },
      h('img', { src: d.image_url, alt: '商品照', loading: 'lazy' }),
      h('div', { class: 'ld-fields' },
        h('label', { class: 'field' }, h('span', {}, '台幣售價'), r.price),
        h('label', { class: 'field' }, h('span', {}, '商品名稱'), r.name, r.hint),
        h('label', { class: 'field' }, h('span', {}, '尺寸備註（選填）'), r.size),
        h('button', { class: 'btn ghost sm', type: 'button', onClick: async () => {
          try { await POST('/api/v1/listings/remove', { draft_id: d.draft_id }); r.el.remove(); rows.delete(d.draft_id); refreshBtn(); }
          catch (e) { errBox.textContent = e.message; }
        } }, '移除')));
    rows.set(d.draft_id, r);
    paintHint(r);
    list.append(r.el);
    refreshBtn();
  };
  drafts.forEach(addRow);
  refreshBtn();

  // 辨識還沒好就每 4 秒問一次；人正在打字的欄位不動，空的欄位才填 AI 的結果。
  let timer = null;
  const poll = async () => {
    timer = null;
    if (!box.isConnected) return;
    tick += 1;
    const reading = [...rows.values()].some((r) => r.d.ocr === 'reading');
    if (!reading) return;
    try {
      const fresh = await GET('/api/v1/listings/drafts');
      for (const d of fresh) {
        const r = rows.get(d.draft_id);
        if (!r) continue;
        r.d = d;
        if (!r.name.value && d.name && document.activeElement !== r.name) r.name.value = d.name;
        if (!r.price.value && d.price_twd && document.activeElement !== r.price) r.price.value = d.price_twd;
      }
    } catch { /* 下一輪再試 */ }
    rows.forEach(paintHint);
    timer = setTimeout(poll, 4000);
  };
  const kick = () => { if (!timer) timer = setTimeout(poll, 2500); };
  kick();

  const pick = async (input) => {
    errBox.textContent = '';
    const files = [...(input.files || [])];
    input.value = '';
    for (const [i, file] of files.entries()) {
      status.textContent = `上傳中 ${i + 1}/${files.length}…`;
      try {
        // 一張一張傳：一次全部塞進同一個請求會超過伺服器 4.5 MB 的上限。
        const data = await compressImage(file);
        addRow(await POST('/api/v1/listings/upload', { data }));
      } catch (e) { errBox.textContent = e.message; }
    }
    status.textContent = '';
    kick();
  };
  const album = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  const camera = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
  album.addEventListener('change', () => pick(album));
  camera.addEventListener('change', () => pick(camera));

  publishBtn.addEventListener('click', async () => {
    errBox.textContent = '';
    const items = [...rows.values()].map((r) => ({ draft_id: r.d.draft_id, name: r.name.value.trim(),
      price_twd: r.price.value === '' ? null : Number(r.price.value), size_note: r.size.value.trim() }));
    const bad = items.findIndex((x) => !x.name || !(x.price_twd > 0));
    if (bad >= 0) { errBox.textContent = `第 ${bad + 1} 件還沒填${!items[bad].name ? '商品名稱' : '台幣售價'}`; return; }
    if (!info.batch && !batchNameInput.value.trim()) { errBox.textContent = '還沒開團：請在上面「開喊單」填「這一趟叫什麼」'; return; }
    publishBtn.disabled = true; publishBtn.textContent = '刊登中…';
    try {
      const res = await POST('/api/v1/listings/publish', { items, quantity: Number(qty.value) || 1,
        batch_name: info.batch ? undefined : batchNameInput.value.trim() });
      toast(`已刊登 ${res.count} 件商品`);
      ctx.reload();
    } catch (e) { errBox.textContent = e.message; refreshBtn(); }
  });

  box.append(
    h('summary', { class: 'card-head' }, h('h2', {}, '多張照片上架'), h('span', { class: 'tiny muted' }, '一張照片＝一件商品，AI 讀品名和台幣售價')),
    h('div', { class: 'card-body' },
      h('div', { class: 'row', style: 'gap:8px' },
        h('label', { class: 'btn primary' }, '選擇商品照片（可多選）', album),
        h('label', { class: 'btn' }, '📷 拍照', camera), status),
      h('div', { class: 'tiny muted', style: 'margin:8px 0' }, '照片上貼台幣價格標（例如 $390）最準。讀不到價錢的，請自己填。'),
      list, errBox,
      h('div', { class: 'ld-foot' },
        h('label', { class: 'row tiny', style: 'gap:6px' }, '每件數量', qty),
        h('span', { class: 'spacer', style: 'flex:1' }), publishBtn)));
  return box;
}
