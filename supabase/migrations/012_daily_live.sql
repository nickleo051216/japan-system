-- =============================================================
-- 012：每日連線＋1 —— 喊單多張照片、尺寸選項、購物車與訂單記住尺寸
--
-- 前台「每日連線＋1」照周小姐的影片：依上架日期分組、每件商品 2×2 照片、可以選尺寸。
--   - broadcast.images：這件商品的照片（自家 bucket 的 storage: 參照），最多 4 張。
--     第 1 張就是封面，跟舊的 broadcast.image_url 保持一致（舊前台照樣讀 image_url）。
--   - broadcast.sizes：尺寸選項（例：{90,100,110}）；null＝這件商品不用選尺寸。
--     尺寸共用同一個數量（remaining），不分尺寸各自限量。
--   - cart_items.size／order_items.size：客人選的尺寸，一路帶到訂單、理貨。
--   上架日期用 broadcast.created_at，不另開欄位。
--
-- 舊資料：有封面的喊單把封面放進 images 第 1 張。
-- 可以重跑：add column if not exists；回填只補 images 還是空的。
-- =============================================================

alter table broadcast add column if not exists images text[] not null default '{}';
alter table broadcast add column if not exists sizes  text[];
alter table cart_items  add column if not exists size text;
alter table order_items add column if not exists size text;

update broadcast set images = array[image_url]
 where image_url is not null and cardinality(images) = 0;
