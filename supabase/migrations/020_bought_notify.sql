-- =============================================================
-- 020：採買端「掃標籤・補登漏喊商品」的通知
--
-- 小幫手在日本現場掃了商品條碼（或手打貨號），選客人、選要加進哪張訂單（或新增到購物車），
-- 按「確認已採買 1 件」後，客人會收到一則 LINE：「小幫手幫你買到了 ○○」。
-- 種類 bought；同一筆補登只通知一次（payload.ref 不重複）。
--
-- 可以重跑：drop constraint if exists、create unique index if not exists。
-- =============================================================

alter table notification_outbox drop constraint if exists notification_outbox_kind_check;
alter table notification_outbox add constraint notification_outbox_kind_check
  check (kind in ('shipped','arrived','statement','payment_reminder','payment_received','wish_broadcast',
                  'quoted','transfer_verified','out_of_stock','ship_request','bought'));
create unique index if not exists notif_outbox_bought_uq
  on notification_outbox (kind, (payload->>'ref')) where kind = 'bought';
