-- =============================================================
-- 017：多張照片一次上架（每一張照片 = 一件商品）
--
-- 店主在後台一次選好幾張商品照，每張先存成一筆「上架草稿」（listing_drafts），
-- n8n 的拍照辨識同一條流程逐張讀出商品名稱和台幣售價（照片上貼的 $390 這種價格標）。
-- 店主確認或改好後按「一起刊登 N 件商品」，每張草稿變成一張喊單（broadcast），send_id 記回草稿。
-- 辨識失敗也能手填刊登。這跟 012 的 broadcast.images[]（一件商品多張照片）是兩個不同流程。
--
--   ai_*      AI 讀到的原始結果（留著對照）
--   edited    店主改過品名或價錢就是 true：晚到的辨識結果不會蓋掉人打的字
--   ocr_*     辨識佇列（跟購物車拍照同一套：租約 10 分鐘、最多試 5 次）
--
-- 可以重跑：create … if not exists。
-- =============================================================

create table if not exists listing_drafts (
  draft_id       text primary key,
  created_by     text references members(line_user_id),
  image_path     text not null,
  name           text,
  price_twd      numeric(12,2),
  jpy_taxed      numeric(12,2),
  size_note      text,
  ai_name        text,
  ai_price_twd   numeric(12,2),
  ai_confidence  text,
  edited         boolean not null default false,
  ocr_attempts   int not null default 0,
  ocr_claimed_at timestamptz,
  ocr_done_at    timestamptz,
  status         text not null default 'draft' check (status in ('draft','posted','removed')),
  send_id        text references broadcast(send_id),
  created_at     timestamptz not null default now()
);
create index if not exists listing_drafts_queue_idx on listing_drafts (created_at) where status = 'draft' and ocr_done_at is null;

alter table listing_drafts enable row level security;
