-- =============================================================
-- 009：綠界線上刷卡 —— 金鑰存 Supabase Vault、交易紀錄、付款成功通知
--
-- 金鑰（HashKey／HashIV）：
--   - 本體存在 Supabase Vault（vault.secrets，Supabase 內建、加密保存），
--     名稱是 ecpay_<stage|live>_hash_key / ecpay_<stage|live>_hash_iv。
--     由店主在後台「金流設定」填寫，後端呼叫 vault.create_secret / update_secret 寫入。
--   - 這裡的 payment_credentials 只放「不是祕密」的部分：特店編號、末四碼、
--     最後一次向綠界驗證的結果。API 回應、log、稽核一律只出末四碼。
--   - 金鑰只存這一份：不放 Vercel 環境變數，也不放 n8n。
--
-- 交易（ecpay_trades）：
--   - 綠界的 MerchantTradeNo 永久唯一，客人每按一次「信用卡付款」就開一筆新的；
--     回調時用它找回是哪一張對帳單、走哪一個環境（stage／live）的金鑰驗簽。
--   - status 只會從 pending 變成 paid／failed 一次：重複回調靠
--     「UPDATE … WHERE status <> 'paid'」擋掉，不會重複入帳。
--
-- 可以重跑：create … if not exists、drop constraint if exists。
-- =============================================================

create table if not exists payment_credentials (
  env          text primary key check (env in ('stage','live')),
  merchant_id  text not null,
  key_last4    text not null,
  iv_last4     text not null,
  verified_at  timestamptz,
  verify_ok    boolean not null default false,
  verify_msg   text,
  updated_by   text,
  updated_at   timestamptz not null default now()
);

create table if not exists ecpay_trades (
  merchant_trade_no text primary key,
  statement_id      text not null references statements(statement_id),
  env               text not null check (env in ('stage','live')),
  amount_twd        int  not null check (amount_twd > 0),
  status            text not null default 'pending' check (status in ('pending','paid','failed')),
  created_by        text,
  created_at        timestamptz not null default now(),
  -- 以下由綠界回調填入
  ecpay_trade_no    text,
  rtn_code          text,
  rtn_msg           text,
  payment_type      text,
  payment_date      text,
  simulate_paid     boolean,
  paid_at           timestamptz
);
create index if not exists ecpay_trades_statement_idx on ecpay_trades (statement_id, created_at desc);

-- 付款成功要通知客人：通知佇列多一種 payment_received。
alter table notification_outbox drop constraint if exists notification_outbox_kind_check;
alter table notification_outbox add constraint notification_outbox_kind_check
  check (kind in ('shipped','arrived','statement','payment_reminder','payment_received'));
-- 同一張對帳單的「付款成功」只通知一次（綠界可能重送回調）。
create unique index if not exists notif_outbox_paid_uq
  on notification_outbox (kind, statement_id) where kind = 'payment_received';

alter table payment_credentials enable row level security;
alter table ecpay_trades enable row level security;
