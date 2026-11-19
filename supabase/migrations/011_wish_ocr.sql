-- =============================================================
-- 011：照片許願自動取名 —— 跟拍照下單共用同一條 n8n 辨識流程
--
-- 客人用照片許願、沒填品名時，品名會先寫「照片許願」。這張表記錄
-- 「這則許願送去 AI 辨識」的進度，辨識出品名就寫回 wishlist.item_name。
--   - 只處理品名還是「照片許願」、而且有照片的許願；客人或店家改過名就不動。
--   - 租約 10 分鐘：n8n 領走後 10 分鐘沒回寫，就回到佇列重領；最多試 5 次。
--   - done_at 有值＝辨識結束（不論有沒有認出來），不會再送去花錢。
--
-- 為什麼另開一張表、不在 wishlist 加欄位：現有的許願 API 完全不讀這張表，
-- 所以程式先上線、這支 SQL 晚一點才跑，許願功能也不會壞；只有 AI 取名會等這支跑完才開始。
--
-- 可以重跑：create … if not exists。
-- =============================================================

create table if not exists wish_ocr (
  wish_id    text primary key references wishlist(wish_id) on delete cascade,
  claimed_at timestamptz,
  attempts   int not null default 0,
  done_at    timestamptz,
  result     text            -- AI 給的品名（認不出來就是 null），留著查問題用
);

-- 跟其他表一樣：只有後端（service role）讀寫。
alter table wish_ocr enable row level security;
