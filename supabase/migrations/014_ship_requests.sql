-- =============================================================
-- 014：出貨申請（併單／拆單）與出貨單
--
-- 客人在前台申請：
--   merge 併單：好幾張還沒出貨的訂單，一起裝一箱寄（只收一次運費）。
--   split 拆單：一張訂單裡已經到貨的品項先寄，其他的之後再寄（先寄的那箱另收一次運費）。
-- 店主在後台審核（ship_requests.status：pending → approved／rejected；客人可以取消 pending 的）。
-- 核准後自動產生出貨單（ship_groups）：這一箱要裝哪幾張訂單、寄到哪裡，理貨照這張裝。
--   併單：把訂單掛到同一張出貨單（orders.ship_group_id），多收的運費自動拿掉（還沒結算、還沒付款的才拿）。
--   拆單：沿用原本的拆單邏輯拆出子訂單（加一次運費），子訂單掛一張自己的出貨單。
-- 出貨單底下的訂單都出貨了，出貨單自動變「已出貨」。
-- 審核結果用 LINE 通知客人（notification_outbox，種類 ship_request）。
--
-- 可以重跑：create … if not exists、add column if not exists、drop constraint if exists。
-- =============================================================

create table if not exists ship_requests (
  request_id    text primary key,
  line_user_id  text not null references members(line_user_id),
  kind          text not null check (kind in ('merge','split')),
  order_ids     text[] not null,
  item_ids      text[],                     -- 拆單：要先寄的品項
  note          text,                       -- 客人的備註
  status        text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  decided_by    text,
  decided_at    timestamptz,
  decision_note text,                       -- 店主寫給客人的話（拒絕原因等）
  ship_group_id text,
  created_at    timestamptz not null default now()
);
create index if not exists ship_requests_user_idx on ship_requests (line_user_id, created_at desc);
create index if not exists ship_requests_pending_idx on ship_requests (created_at) where status = 'pending';

create table if not exists ship_groups (
  ship_group_id text primary key,
  line_user_id  text not null references members(line_user_id),
  request_id    text references ship_requests(request_id),
  order_ids     text[] not null,
  pickup        text,
  pickup_addr   text,
  status        text not null default '待出貨' check (status in ('待出貨','已出貨','已取消')),
  created_by    text,
  created_at    timestamptz not null default now(),
  shipped_at    timestamptz
);

alter table orders add column if not exists ship_group_id text references ship_groups(ship_group_id);

alter table notification_outbox drop constraint if exists notification_outbox_kind_check;
alter table notification_outbox add constraint notification_outbox_kind_check
  check (kind in ('shipped','arrived','statement','payment_reminder','payment_received','wish_broadcast',
                  'quoted','transfer_verified','out_of_stock','ship_request'));
create unique index if not exists notif_outbox_ship_request_uq
  on notification_outbox (kind, (payload->>'request_id')) where kind = 'ship_request';

alter table ship_requests enable row level security;
alter table ship_groups enable row level security;
