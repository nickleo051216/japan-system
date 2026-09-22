-- =============================================================
-- 005：出貨等通知的待發佇列
--
-- japan-system 只負責「排隊」，實際發送 LINE 由 n8n 取件後執行。
-- 分成兩段而不是直接呼叫 LINE 的理由：
--   1. 出貨的 API 回應不能等 LINE（Vercel 一個請求上限 15 秒）
--   2. 推播憑證、月額度、Flex 模板都在 n8n，不該再複製一份到後端
--   3. n8n 重啟或網路中斷時，直接呼叫會「安靜地」遺失通知；排隊才補得回來
-- =============================================================
create table if not exists notification_outbox (
  notif_id      text primary key,
  kind          text not null
                check (kind in ('shipped','arrived','statement','payment_reminder')),
  line_user_id  text not null references members(line_user_id),
  order_id      text references orders(order_id),
  statement_id  text references statements(statement_id),
  payload       jsonb not null,            -- 文案與卡片需要的欄位
  status        text not null default 'pending'
                check (status in ('pending','sending','sent','failed','skipped')),
  attempts      int  not null default 0,
  last_error    text,                      -- 含 LINE 原始回應，額度用盡時看得出來
  -- 兼作「租約」：取件時推到 10 分鐘後，n8n 中途掛掉就會被重新取件
  next_retry_at timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  sent_at       timestamptz
);

-- 同一張訂單的同一種通知只會有一筆。
-- 重複發「您的訂單已出貨」比漏發更糟：客人會以為又寄了一箱。
create unique index if not exists notif_outbox_order_kind_uq
  on notification_outbox (kind, order_id) where order_id is not null;

-- 取件用：時間到了、還沒送成功的
create index if not exists notif_outbox_due_idx
  on notification_outbox (next_retry_at)
  where status in ('pending','sending','failed');

alter table notification_outbox enable row level security;
