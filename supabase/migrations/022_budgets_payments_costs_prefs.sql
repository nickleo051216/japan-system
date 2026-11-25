-- =============================================================
-- 022：許願預算、匯款自動對帳、營運成本表、結帳偏好（v1.8，周小姐示範站的 4 個功能）
--
-- 1. 許願預算（wish_budgets、wish_decisions）
--    客人許願或按 +1 時可以設「報價 ≤ auto_buy_max 自動幫我買」「報價 > reject_above 自動不要」。
--    預算是私人的：只有本人看得到；店家只看得到人數和分布（不知道是誰）。
--    店家報價時對每個人各自判斷，結果（含當下預算的快照）記在 wish_decisions。
--    同一個人對同一則許願只會「自動成立」一次（部分唯一索引），重新報價也不會成立第二筆。
--
-- 2. 匯款自動對帳（statements.transfer_proof、bank_credits）
--    客人回報匯款可以附截圖（私有 Storage 路徑）。店主輸入銀行入帳，系統用「末五碼＋金額」配對帳單。
--    同一筆入帳（ref_no）只能用一次。逾期提醒（payment_reminder）每張帳單只發一次。
--
-- 3. 營運成本表（operating_costs）
--    小幫手請款單核准就自動變成一筆成本（source=helper_claim，同一張請款單只有一筆），
--    標成已付款更新狀態，退回就刪掉。店主也可以手動記一筆（日幣／韓幣／台幣）。
--
-- 4. 結帳偏好（members.checkout_prefs）
--    付款方式、預設寄送方式、發票、特殊備註。寄送地點沿用 members 原本的 cvs_*／home_addr，
--    跟結帳、出貨申請（021）是同一套，不另外存一份。
--
-- 全部是「新增」：不改舊資料。可以重跑（if not exists、drop constraint if exists）。
-- =============================================================

-- ---------- 1. 許願預算 ----------
create table if not exists wish_budgets (
  wish_id       text not null references wishlist(wish_id) on delete cascade,
  line_user_id  text not null references members(line_user_id),
  auto_buy_max  numeric(12,2) check (auto_buy_max is null or auto_buy_max > 0),
  reject_above  numeric(12,2) check (reject_above is null or reject_above > 0),
  updated_at    timestamptz not null default now(),
  primary key (wish_id, line_user_id),
  check (auto_buy_max is not null or reject_above is not null),
  check (auto_buy_max is null or reject_above is null or auto_buy_max <= reject_above)
);

create table if not exists wish_decisions (
  decision_id   text primary key,
  wish_id       text not null references wishlist(wish_id) on delete cascade,
  line_user_id  text not null references members(line_user_id),
  role          text not null check (role in ('owner','voter')),     -- 許願的人／按 +1 的人
  quote_twd     numeric(12,2) not null,
  auto_buy_max  numeric(12,2),                                       -- 報價當下的預算快照
  reject_above  numeric(12,2),
  decision      text not null check (decision in ('auto_buy','auto_reject','pending')),
  status        text not null default 'open' check (status in ('open','accepted','declined','cancelled')),
  cart_id       text references cart_items(cart_id) on delete set null,
  created_at    timestamptz not null default now(),
  decided_at    timestamptz
);
create index if not exists wish_decisions_user_idx on wish_decisions (line_user_id, created_at desc);
create index if not exists wish_decisions_wish_idx on wish_decisions (wish_id, created_at desc);
create unique index if not exists wish_decisions_auto_buy_uq
  on wish_decisions (wish_id, line_user_id) where decision = 'auto_buy';

-- ---------- 2. 匯款自動對帳 ----------
alter table statements add column if not exists transfer_proof text;          -- 匯款截圖（Storage 路徑）
alter table statements add column if not exists transfer_reported_at timestamptz;

create table if not exists bank_credits (
  credit_id     text primary key,
  ref_no        text not null unique,                                -- 銀行的交易參考號：同一筆不能用兩次
  amount_twd    numeric(12,2) not null check (amount_twd > 0),
  last5         text check (last5 is null or last5 ~ '^\d{5}$'),
  credited_at   timestamptz not null,
  status        text not null default 'needs_review'
                check (status in ('matched','needs_review','confirmed','ignored')),
  statement_id  text references statements(statement_id),
  candidates    text[] not null default '{}',                        -- 配不到時可能的帳單（給店主挑）
  reason        text,
  note          text,
  created_by    text,
  created_at    timestamptz not null default now(),
  decided_by    text,
  decided_at    timestamptz
);
create index if not exists bank_credits_status_idx on bank_credits (status, created_at desc);
create unique index if not exists bank_credits_statement_uq
  on bank_credits (statement_id) where statement_id is not null and status in ('matched','confirmed');

-- ---------- 3. 營運成本表 ----------
create table if not exists operating_costs (
  cost_id       text primary key,
  source        text not null check (source in ('helper_claim','manual')),
  source_id     text,                                                -- helper_claims.claim_id
  spent_on      date not null,
  category      text not null,
  currency      text not null check (currency in ('JPY','KRW','TWD')),
  amount        numeric(14,2) not null check (amount > 0),
  status        text not null default 'unpaid' check (status in ('unpaid','paid')),
  payee         text,
  note          text,
  created_by    text,
  created_at    timestamptz not null default now(),
  paid_at       timestamptz
);
create unique index if not exists operating_costs_source_uq
  on operating_costs (source, source_id) where source_id is not null;
create index if not exists operating_costs_date_idx on operating_costs (spent_on desc);

-- ---------- 4. 結帳偏好 ----------
alter table members add column if not exists checkout_prefs jsonb;

-- ---------- 通知種類 ----------
-- wish_auto：許願預算自動處理（自動保留／自動略過／報價在中間要你決定）。
alter table notification_outbox drop constraint if exists notification_outbox_kind_check;
alter table notification_outbox add constraint notification_outbox_kind_check
  check (kind in ('shipped','arrived','statement','payment_reminder','payment_received','wish_broadcast',
                  'quoted','transfer_verified','out_of_stock','ship_request','bought','wish_auto'));
create unique index if not exists notif_outbox_wish_auto_uq
  on notification_outbox (kind, (payload->>'decision_id')) where kind = 'wish_auto';
create unique index if not exists notif_outbox_reminder_uq
  on notification_outbox (kind, statement_id) where kind = 'payment_reminder' and statement_id is not null;
-- 銀行入帳配對成功的「收到款項」：同一張帳單只通知一次（013 已經有 transfer_verified 的唯一索引）。

alter table wish_budgets enable row level security;
alter table wish_decisions enable row level security;
alter table bank_credits enable row level security;
alter table operating_costs enable row level security;
