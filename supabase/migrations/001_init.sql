-- =============================================================
-- HEEEHABABY 代購系統｜Supabase schema v1
-- 來源：README §3.1（主模型）＋ 現行 Google Sheets 專有表 ＋ 實際營運狀態
-- 規則：金額 numeric(12,2)、時間 timestamptz、欄名沿用 README
-- =============================================================

-- ---------- 會員（README members ＋ 收件資訊、喊單信用）----------
create table members (
  line_user_id   text primary key,
  nickname       text not null,
  display_name   text,
  phone          text,
  role           text not null default 'buyer'
                 check (role in ('buyer','helper','packer','owner')),
  status         text not null default '已綁定'
                 check (status in ('已綁定','未綁定','停用')),
  cvs_brand      text,             -- 7-11 / 全家
  cvs_store_id   text,
  cvs_store_name text,
  cvs_addr       text,
  home_addr      text,
  carrier        text check (carrier is null or carrier ~ '^/[0-9A-Z.+-]{7}$'),
  shout_drops    int  not null default 0,   -- 喊單棄單次數
  bound_at       timestamptz,
  created_at     timestamptz not null default now()
);
create unique index members_nickname_uq on members (lower(trim(nickname)));

-- ---------- 團 ----------
create table batches (
  batch      text primary key,          -- 例 T-260913
  name       text not null,             -- 例 9/13 大阪採買
  region     text,
  close_at   timestamptz,
  buy_at     text, back_at text, ship_at text,
  stage      int not null default 0 check (stage between 0 and 4),
  created_at timestamptz not null default now()
);

-- ---------- 價目表（Sheets 專有：日幣税込級距 → 台幣）----------
create table price_table (
  jpy_taxed_max int primary key,
  twd           numeric(12,2) not null
);

-- ---------- 商品 ----------
create table products (
  sku             text primary key,
  name_zh         text not null,
  name_local      text,
  brand           text,
  price_twd       numeric(12,2),
  est_cost_jpy    numeric(12,2),
  actual_cost_jpy numeric(12,2),
  image_url       text,
  batch           text references batches(batch),
  stock_limit     int,
  reserved        int not null default 0,
  check (stock_limit is null or reserved <= stock_limit)
);

-- ---------- 訂單（狀態沿用實際營運）----------
create table orders (
  order_id        text primary key,
  line_user_id    text not null references members(line_user_id),
  batch           text references batches(batch),
  status          text not null default '待確認'
                  check (status in ('待確認','已報價','已到貨','已出貨','已送達','缺貨','已取消')),
  payment_status  text not null default '待付款'
                  check (payment_status in ('待付款','待官方確認','已核對')),
  total_twd       numeric(12,2) not null default 0,
  ship_fee_twd    numeric(12,2) not null default 0,
  split_shipped   boolean not null default false,
  parent_order_id text references orders(order_id),
  statement_id    text,
  pickup          text, pickup_addr text, invoice text,
  note            text,
  created_at      timestamptz not null default now()
);
create index orders_user_idx on orders (line_user_id, created_at desc);

create table order_items (
  item_id          text primary key,
  order_id         text not null references orders(order_id) on delete cascade,
  sku              text references products(sku),
  name             text not null,             -- 無 SKU 的代購品項（拍照/文字）仍可成立
  qty              int  not null check (qty > 0),
  jpy_taxed        numeric(12,2),
  unit_price_twd   numeric(12,2) not null default 0,   -- 下單當下快照
  item_status      text not null default '待採買'
                   check (item_status in ('待採買','採買中','已到貨','缺貨')),
  source           text check (source in ('broadcast','image','text','wish','reorder')),
  source_image_url text
);

-- ---------- 狀態轉換規則與紀錄 ----------
create table order_status_rules (
  from_status text not null,
  to_status   text not null,
  primary key (from_status, to_status)
);
insert into order_status_rules values
  ('待確認','已報價'),('待確認','已取消'),
  ('已報價','已到貨'),('已報價','缺貨'),('已報價','已取消'),
  ('已到貨','已出貨'),
  ('已出貨','已送達');

create table order_status_log (
  id          bigserial primary key,
  order_id    text not null references orders(order_id),
  from_status text,
  to_status   text not null,
  actor       text,
  reason      text,
  at          timestamptz not null default now()
);

-- 狀態只能依規則前進；店主可帶原因往回修正（app.override = 'on'）
-- 驗證在「更新前」，紀錄在「寫入後」（寫入前訂單尚不存在，會違反外鍵）
create or replace function check_order_status() returns trigger
language plpgsql as $$
begin
  if new.status is distinct from old.status
     and not exists (select 1 from order_status_rules
                     where from_status = old.status and to_status = new.status)
     and coalesce(current_setting('app.override', true), 'off') <> 'on' then
    raise exception 'ILLEGAL_TRANSITION % -> %', old.status, new.status
      using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger trg_order_status_check
  before update of status on orders
  for each row execute function check_order_status();

create or replace function log_order_status() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into order_status_log(order_id, from_status, to_status, actor, reason)
    values (new.order_id,
            case when tg_op = 'UPDATE' then old.status end,
            new.status,
            nullif(current_setting('app.actor', true), ''),
            nullif(current_setting('app.reason', true), ''));
  end if;
  return null;
end $$;
create trigger trg_order_status_log
  after insert or update of status on orders
  for each row execute function log_order_status();

-- ---------- 喊單（Sheets 專有 broadcast）----------
create table broadcast (
  send_id     text primary key,
  batch       text references batches(batch),
  name        text not null,
  jpy_taxed   numeric(12,2),
  price_twd   numeric(12,2) not null,
  quantity    int not null check (quantity >= 0),
  remaining   int not null check (remaining >= 0),
  deadline_at timestamptz,
  note        text,
  image_url   text,
  created_at  timestamptz not null default now(),
  check (remaining <= quantity)
);

-- ---------- 購物車（Sheets ocr_cart）----------
create table cart_items (
  cart_id       text primary key,
  line_user_id  text not null references members(line_user_id),
  source        text not null check (source in ('broadcast','image','text','wish','reorder')),
  ref           text,                 -- broadcast.send_id / 檔名 / wish_id
  name          text not null,
  name_ja       text,
  jpy_taxed     numeric(12,2),
  price_twd     numeric(12,2),
  qty           int not null check (qty > 0),
  ai_confidence text check (ai_confidence in ('high','medium','low')),
  status        text not null default 'pending'
                check (status in ('pending','confirmed','removed','ordered')),
  file_name     text, image_url text, note text,
  created_at    timestamptz not null default now()
);
create index cart_user_idx on cart_items (line_user_id, status);

-- 喊單原子扣量：列鎖住 → 算實得數量 → 扣餘量 → 寫購物車，一次完成
create or replace function shout(p_send_id text, p_user text, p_qty int)
returns table (granted int, remaining int)
language plpgsql as $$
declare v_left int; v_deadline timestamptz; v_g int; b broadcast%rowtype;
begin
  if p_qty is null or p_qty <= 0 then raise exception 'BAD_QTY'; end if;
  select * into b from broadcast where send_id = p_send_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if (select shout_drops from members where line_user_id = p_user) >= 3 then
    raise exception 'SUSPENDED' using errcode = 'P0002';
  end if;
  if b.deadline_at is not null and b.deadline_at < now() then
    granted := 0; remaining := b.remaining; return next; return;
  end if;
  v_g := least(p_qty, b.remaining);
  if v_g <= 0 then granted := 0; remaining := 0; return next; return; end if;

  update broadcast set remaining = broadcast.remaining - v_g where send_id = p_send_id;

  insert into cart_items(cart_id, line_user_id, source, ref, name, jpy_taxed,
                         price_twd, qty, ai_confidence, status)
  values ('C-' || p_send_id || '-' || p_user || '-' || extract(epoch from clock_timestamp())::bigint
            || '-' || floor(random()*1e6)::int,
          p_user, 'broadcast', p_send_id, b.name, b.jpy_taxed, b.price_twd, v_g, 'high', 'confirmed');

  granted := v_g; remaining := b.remaining - v_g; return next;
end $$;

-- ---------- 許願 ----------
create table wishlist (
  wish_id      text primary key,
  line_user_id text not null references members(line_user_id),
  item_name    text not null,
  item_name_ja text, brand text, ref_url text,
  quantity     int not null default 1 check (quantity > 0),
  note         text,
  wish_status  text not null default '待處理'
               check (wish_status in ('待處理','已報價','現場缺貨','保留下團','已下單')),
  quote_twd    numeric(12,2),
  picture      text, file_name text,
  wished_at    timestamptz not null default now()
);

-- ---------- 對帳單（Sheets 專有：半月結）----------
create table statements (
  statement_id      text primary key,
  line_user_id      text not null references members(line_user_id),
  total_amount      numeric(12,2) not null,
  payment_status    text not null default '待付款'
                    check (payment_status in ('待付款','待官方確認','已核對')),
  payway            text check (payway in ('credit','atm','linepay','bank')),
  last_five_matched text,
  trade_no          text unique,
  v_account         text, v_bank text, v_expire_at timestamptz,
  invoice_no        text, invoice_at timestamptz,
  created_at        timestamptz not null default now(),
  paid_at           timestamptz
);
alter table orders add constraint orders_statement_fk
  foreign key (statement_id) references statements(statement_id);

-- 付款通知（綠界回調）冪等紀錄：同一 trade_no 只認列一次
create table payments (
  payment_id    text primary key,
  statement_id  text references statements(statement_id),
  order_id      text references orders(order_id),
  amount_twd    numeric(12,2) not null,
  method        text not null check (method in ('transfer','credit','atm','linepay','cash')),
  last5         text,
  trade_no      text unique,
  rtn_code      text,
  received_at   timestamptz not null default now(),
  reconciled_by text
);

-- ---------- 採購、出貨、物流、稽核（README 原樣）----------
create table procurements (
  proc_id         text primary key,
  batch           text references batches(batch),
  sku             text references products(sku),
  need_qty        int not null default 0,
  claimed_by      text references members(line_user_id),
  claimed_at      timestamptz,
  got_qty         int not null default 0,
  state           text not null default 'open'
                  check (state in ('open','claimed','got','partial','out_of_stock')),
  unit_cost_jpy   numeric(12,2),
  fx_rate         numeric(10,5),
  receipt_url     text,
  amount_edited   boolean not null default false,
  updated_at      timestamptz not null default now()
);
create table shipments (
  shipment_id      text primary key,
  order_id         text not null references orders(order_id),
  shipped_at       timestamptz not null default now(),
  verified_by_scan boolean not null default false,
  operator         text,
  carrier          text, tracking_no text, eta text,
  override_reason  text
);
create table logistics_bindings (
  tracking_no text primary key,
  order_id    text not null references orders(order_id),
  carrier     text,
  bound_at    timestamptz not null default now(),
  bound_by    text
);
create table restock_watch (       -- 補貨通知＋喊單候補
  line_user_id text references members(line_user_id),
  item_ref     text,
  kind         text not null check (kind in ('restock','waitlist')),
  created_at   timestamptz not null default now(),
  notified_at  timestamptz,
  primary key (line_user_id, item_ref, kind)
);
create table audit_log (
  log_id  bigserial primary key,
  ts      timestamptz not null default now(),
  actor   text, action text not null, target text,
  detail  jsonb,
  result  text check (result in ('ok','warn','blocked'))
);
create table settings (
  key   text primary key,
  value text
);

-- ---------- 函式權限：只有 japan-system（service role）能呼叫 ----------
do $$ begin
  revoke execute on function shout(text,text,int) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function shout(text,text,int) from anon, authenticated';
  end if;
end $$;

-- ---------- RLS：一律開啟，前端只能透過 japan-system（service key）存取 ----------
do $$ declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;
