-- =============================================================
-- 013：三種客人通知 —— 報價好了（quoted）、收到款項（transfer_verified）、缺貨（out_of_stock）
--
-- 跟其他通知一樣排進 notification_outbox，由 n8n 送 LINE（文案後端寫好放在 payload.text）。
-- 不重複：
--   - 訂單層級（quoted／out_of_stock／transfer_verified 帶 order_id）沿用 005 的 (kind, order_id) 唯一索引。
--   - 對帳單收款（transfer_verified 帶 statement_id）：同一張對帳單只通知一次。
--   - 許願層級（quoted／out_of_stock 沒有 order_id）：同一則許願、同一種只通知一次。
-- 可以重跑：drop constraint if exists、create … if not exists。
-- =============================================================

alter table notification_outbox drop constraint if exists notification_outbox_kind_check;
alter table notification_outbox add constraint notification_outbox_kind_check
  check (kind in ('shipped','arrived','statement','payment_reminder','payment_received','wish_broadcast',
                  'quoted','transfer_verified','out_of_stock'));

create unique index if not exists notif_outbox_stmt_verified_uq
  on notification_outbox (kind, statement_id) where kind = 'transfer_verified' and statement_id is not null;

create unique index if not exists notif_outbox_wish_kind_uq
  on notification_outbox (kind, line_user_id, (payload->>'wish_id'))
  where kind in ('quoted','out_of_stock') and order_id is null;
