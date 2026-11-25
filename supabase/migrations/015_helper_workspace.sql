-- =============================================================
-- 015：小幫手工作台（邀請碼加入、批次拍收據請款）
--
-- 邀請碼 staff_invites：
--   店主在後台開一組邀請碼（指定角色：日本小幫手或包貨人員、可以用幾次、幾小時內有效）。
--   對方用自己的 LINE 登入後輸入邀請碼，就從客人變成員工 —— 店家不用再去找人改角色。
--   資料庫只存邀請碼的雜湊（code_hash），原文只在開碼那一刻給店主看一次；code_hint 是末兩碼方便辨認。
--   店主（owner）不能用邀請碼產生；邀請碼可以隨時作廢（revoked_at）。
-- 請款單 helper_claims ＋ 收據 helper_receipts：
--   小幫手先一張一張上傳收據照片（helper_receipts 還沒掛請款單，claim_id 是空的），
--   再把好幾張一起送出成一張請款單，每張收據填日幣金額，可以順便記到哪幾項採購的成本。
--   （分開上傳是因為 Vercel 一次請求最多 4.5 MB，好幾張照片一起送會被擋。）
--   店主審核：pending（待審核）→ approved（核准）→ paid（已付給小幫手）；或 rejected（退回，要寫原因）。
--   收據上填的品項單價，店主「核准」時才記成本（退回的不會留下成本紀錄）。
--   金額以送出當下的匯率換成台幣（fx_rate 快照），之後改匯率不影響已送出的請款單。
--
-- 可以重跑：create … if not exists。
-- =============================================================

create table if not exists staff_invites (
  invite_id   text primary key,
  code_hash   text not null unique,
  code_hint   text not null,
  role        text not null check (role in ('helper','packer')),
  max_uses    int  not null default 1 check (max_uses between 1 and 20),
  used_count  int  not null default 0,
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  note        text,
  created_by  text references members(line_user_id),
  created_at  timestamptz not null default now()
);

create table if not exists staff_invite_uses (
  invite_id    text not null references staff_invites(invite_id),
  line_user_id text not null references members(line_user_id),
  used_at      timestamptz not null default now(),
  primary key (invite_id, line_user_id)
);

create table if not exists helper_claims (
  claim_id      text primary key,
  line_user_id  text not null references members(line_user_id),
  batch         text references batches(batch),
  total_jpy     numeric(12,2) not null,
  fx_rate       numeric(10,5) not null,
  total_twd     numeric(12,2) not null,
  note          text,
  status        text not null default 'pending' check (status in ('pending','approved','paid','rejected')),
  decided_by    text,
  decided_at    timestamptz,
  decision_note text,
  paid_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists helper_claims_user_idx on helper_claims (line_user_id, created_at desc);

create table if not exists helper_receipts (
  receipt_id   text primary key,
  line_user_id text not null references members(line_user_id),
  claim_id     text references helper_claims(claim_id) on delete set null,
  seq          int,
  image_path   text not null,
  amount_jpy   numeric(12,2) check (amount_jpy > 0),
  proc_ids     text[] not null default '{}',
  items        jsonb  not null default '[]',      -- 要記成本的品項 [{proc_id, unit_cost_jpy, qty}]，店主核准時才寫進 expenses
  note         text,
  created_at   timestamptz not null default now()
);
create index if not exists helper_receipts_claim_idx on helper_receipts (claim_id);

alter table staff_invites enable row level security;
alter table staff_invite_uses enable row level security;
alter table helper_claims enable row level security;
alter table helper_receipts enable row level security;
