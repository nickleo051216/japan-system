-- =============================================================
-- 010：許願牆 —— 客人看得到彼此的許願、按「我也想要 +1」，店主一鍵轉成喊單
--
-- 公開狀態（wishlist.wall_status）：
--   private  只有許願的人自己看得到（預設；舊資料全部是這個）
--   pending  客人勾了「公開到許願牆」，等店主審核
--   public   店主審核通過，大家看得到
--   hidden   店主收下來了（客人不能自己再放上去）
--   客人沒勾公開，店主也不能把它放上牆 —— 由後端擋，不靠畫面。
--
-- +1（wish_votes）：
--   一人對一則最多一票（主鍵擋重複）。牆上只顯示人數，不顯示是誰。
--   許願被刪掉，票跟著刪（on delete cascade）。
--
-- 轉成喊單（wishlist.broadcast_send_id）：
--   店主按「轉成喊單」後記下是哪一張喊單，同一則許願只能轉一次。
--   同時排 LINE 通知給按過 +1 的人和許願的人（notification_outbox，種類 wish_broadcast）。
--   同一個人、同一張喊單只會收到一則（唯一索引擋重複）。
--
-- 可以重跑：add column if not exists、create … if not exists、drop constraint if exists。
-- =============================================================

alter table wishlist add column if not exists wall_status text not null default 'private';
alter table wishlist drop constraint if exists wishlist_wall_status_check;
alter table wishlist add constraint wishlist_wall_status_check
  check (wall_status in ('private','pending','public','hidden'));
alter table wishlist add column if not exists wall_at timestamptz;          -- 上牆時間
alter table wishlist add column if not exists broadcast_send_id text references broadcast(send_id);

create index if not exists wishlist_wall_idx on wishlist (wall_status) where wall_status <> 'private';

create table if not exists wish_votes (
  wish_id      text not null references wishlist(wish_id) on delete cascade,
  line_user_id text not null references members(line_user_id),
  created_at   timestamptz not null default now(),
  primary key (wish_id, line_user_id)
);
create index if not exists wish_votes_user_idx on wish_votes (line_user_id);

alter table notification_outbox drop constraint if exists notification_outbox_kind_check;
alter table notification_outbox add constraint notification_outbox_kind_check
  check (kind in ('shipped','arrived','statement','payment_reminder','payment_received','wish_broadcast'));

create unique index if not exists notif_outbox_wish_uq
  on notification_outbox (kind, line_user_id, (payload->>'send_id')) where kind = 'wish_broadcast';

-- 跟其他表一樣：只有後端（service role）讀寫，匿名與登入角色一律擋。
alter table wish_votes enable row level security;
