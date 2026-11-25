-- =============================================================
-- 018：許願的「尋找進度」（許願與＋1 排行頁的「更新尋找進度」）
--
-- 店家找貨的進度用一句話寫給客人看，例如「大阪店問過了，下週補貨」。
-- 許願的人和按過 ＋1 的人在前台「我的許願」「許願牆」都看得到。
-- 狀態（尋找中／現場缺貨／保留下團）沿用 wish_status，這裡只加一句話和時間。
--
-- 可以重跑：add column if not exists。
-- =============================================================

alter table wishlist add column if not exists progress_note text;
alter table wishlist add column if not exists progress_at timestamptz;
