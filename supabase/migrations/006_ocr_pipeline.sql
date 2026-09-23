-- 006：拍照下單的辨識工作佇列 ＋ 私有圖片空間
--
-- 為什麼需要：拍照下單原本只完成「回寫結果」那一段。圖存在 Vercel 的 /tmp
-- （冷啟動就消失、n8n 也拿不到），而 n8n 也沒有任何方式知道「有新圖要辨識」。
--
-- 可以重跑：每一句都是 if not exists / on conflict do nothing。

-- 辨識工作的租約：n8n 領走一張圖時蓋上時間，10 分鐘內別人不會再領到同一張；
-- 逾時沒回寫就自動回到佇列。嘗試次數有上限，避免一張壞圖被無限重試。
alter table cart_items add column if not exists ocr_claimed_at timestamptz;
alter table cart_items add column if not exists ocr_attempts  int not null default 0;

-- 只索引「還在等辨識」的那一小撮，佇列查詢不必掃整張購物車表。
create index if not exists cart_items_ocr_due_idx
  on cart_items (created_at)
  where source = 'image' and ai_confidence = 'low' and price_twd is null and status = 'pending';

-- 私有 bucket：客人上傳的照片可能含個資（收件資訊、臉），一律不公開，
-- 只發短效簽名網址。storage schema 只存在於 Supabase；本機測試資料庫沒有它，
-- 所以包在條件裡 —— 在 Supabase 上照常建立，在本機直接略過。
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public)
    values ('cart-images', 'cart-images', false)
    on conflict (id) do nothing;
  end if;
end $$;
