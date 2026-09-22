-- =============================================================
-- 004：japan-system 相容層
-- 補上 repo 程式會用到、001 沒有的表與欄位；不刪任何既有資料
-- =============================================================

-- 團：repo 使用 opened_at / closed_at
alter table batches add column if not exists opened_at timestamptz;
alter table batches add column if not exists closed_at timestamptz;

-- 訂單：repo 讀取 paid / paid_at
--   paid 由 payment_status 自動推導（唯讀），避免兩個欄位不一致
alter table orders add column if not exists paid_at timestamptz;
alter table orders add column if not exists paid boolean
  generated always as (payment_status = '已核對') stored;

-- 狀態紀錄：欄名對齊 repo（log_id / ts），主鍵改為文字以相容程式產生的 ID
alter table order_status_log rename column id to log_id;
alter table order_status_log rename column at to ts;
alter table order_status_log alter column log_id drop default;
alter table order_status_log alter column log_id type text using log_id::text;
alter table order_status_log alter column log_id set default gen_random_uuid()::text;
drop sequence if exists order_status_log_id_seq;

-- 稽核：主鍵改為文字（repo 自行產生 ID）
alter table audit_log alter column log_id drop default;
alter table audit_log alter column log_id type text using log_id::text;
alter table audit_log alter column log_id set default gen_random_uuid()::text;
drop sequence if exists audit_log_log_id_seq;

-- 請款明細
create table if not exists expenses (
  expense_id    text primary key,
  proc_id       text not null references procurements(proc_id),
  qty           int  not null,
  unit_cost_jpy numeric(12,2) not null,
  fx_rate       numeric(10,5) not null,
  receipt_url   text,
  amount_edited boolean not null default false,
  created_by    text,
  created_at    timestamptz not null default now()
);

-- 匯率異動紀錄
create table if not exists fx_history (
  fx_id      text primary key,
  rate       numeric(10,5) not null,
  changed_by text,
  changed_at timestamptz not null default now()
);

-- 站內通知
create table if not exists notifications (
  notif_id   text primary key,
  audience   text not null,            -- 'owner' 或 line_user_id
  kind       text not null,
  title      text not null,
  body       text,
  target     text,
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
create index if not exists notifications_audience_idx on notifications (audience, created_at desc);

-- 冪等鍵（寫入請求重送只執行一次）
create table if not exists idempotency (
  key        text primary key,
  response   text not null,
  created_at timestamptz not null default now()
);

-- 新表一律開啟 RLS
alter table expenses      enable row level security;
alter table fx_history    enable row level security;
alter table notifications enable row level security;
alter table idempotency   enable row level security;
