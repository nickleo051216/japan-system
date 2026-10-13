-- =============================================================
-- 008：喊單棄單上限改成可以設定
--
-- 業主確認單（2026-10-12）：喊單棄單 1 次就暫停喊單資格，對帳單付款完成才恢復。
-- 原本「3 次」寫死在 001 的 shout() 裡，這裡改成讀 settings 的 shout_drop_limit：
--   - 沒設定、或設定值不是正整數 → 用 1（業主確認的規則）。
--   - 店主可以在後台「店家與收款設定」改。
--
-- 「付款完成就恢復」是程式端的事（核對對帳單時把 shout_drops 歸零並寫稽核），
-- 這裡只改判斷門檻。函式簽名不變，001 設的執行權限照舊有效。
--
-- 可以重跑：只有 create or replace。
-- =============================================================

create or replace function shout_drop_limit() returns int
  language sql stable
as $$
  select coalesce(
    (select case when value ~ '^[0-9]{1,6}$' and value::int > 0 then value::int end
       from settings where key = 'shout_drop_limit'),
    1)
$$;

-- 喊單原子扣量：列鎖住 → 算實得數量 → 扣餘量 → 寫購物車，一次完成
create or replace function shout(p_send_id text, p_user text, p_qty int)
returns table (granted int, remaining int)
language plpgsql as $$
declare v_left int; v_deadline timestamptz; v_g int; b broadcast%rowtype;
begin
  if p_qty is null or p_qty <= 0 then raise exception 'BAD_QTY'; end if;
  select * into b from broadcast where send_id = p_send_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if (select shout_drops from members where line_user_id = p_user) >= shout_drop_limit() then
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

-- 跟 001 的 shout() 一樣：只有 japan-system（service role）能呼叫。
do $$ begin
  revoke execute on function shout_drop_limit() from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function shout_drop_limit() from anon, authenticated';
  end if;
end $$;
