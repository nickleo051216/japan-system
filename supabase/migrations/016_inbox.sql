-- =============================================================
-- 016：站內通知中心（客人在前台看自己的通知紀錄）
--
-- 跟 LINE 通知是同一份資料：notification_outbox 一列 = LINE 發一則 = 通知中心一則。
-- 這裡只加「客人在前台看過了沒」：read_at。LINE 那邊有沒有送到（status）不影響通知中心 ——
-- LINE 額度用完或客人封鎖官方帳號，還是看得到。
--
-- 第一次跑的時候，以前的通知一律當作「看過了」（客人在 LINE 上早就看過），
-- 免得通知中心一上線，每位客人都冒出幾十個未讀紅點。之後新的通知才是未讀。
--
-- 可以重跑：欄位只在第一次加、回填只在第一次做。
-- =============================================================

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_name = 'notification_outbox' and column_name = 'read_at') then
    alter table notification_outbox add column read_at timestamptz;
    update notification_outbox set read_at = coalesce(sent_at, created_at);
  end if;
end $$;

create index if not exists notif_outbox_inbox_idx on notification_outbox (line_user_id, created_at desc);
