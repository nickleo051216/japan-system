-- =============================================================
-- 019：商品資料庫的欄位（採購線、款式）
--
-- 「商品資料庫」頁不另外建一張商品表：把現有的商品型錄（products）和喊單（broadcast）
-- 合在一起看。這裡只補兩個兩邊都缺的欄位：
--   line     採購線，例如「日本線」「韓國線」；空的就是「待分類」（連線採買清單也用它篩）
--   variant  款式，例如「粉紅」「小花」
-- 尺寸：喊單已經有 sizes（012），型錄這裡補一個 sizes。
--
-- 可以重跑：add column if not exists。
-- =============================================================

alter table products  add column if not exists line    text;
alter table products  add column if not exists variant text;
alter table products  add column if not exists sizes   text[];
alter table broadcast add column if not exists line    text;
alter table broadcast add column if not exists variant text;
