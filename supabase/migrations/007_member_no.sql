-- =============================================================
-- 007：會員編號 HB-00001
--
-- LINE userId（U 開頭 33 碼）仍是系統內部的身分識別，登入靠它；
-- 但任何人看得到的畫面都改用會員編號 —— 一串亂碼出現在畫面上很不專業，
-- 也不該讓員工或客人抄來抄去。
--
-- 規則：
--   - 格式 HB- 加 5 位數字，照加入順序編。超過 99999 照樣往上長（HB-100000），不截斷。
--   - 新會員由資料庫自動配號（預設值 = 下一個號碼），程式碼不用管。
--   - 既有會員依 created_at 補號，時間相同再依 line_user_id，每次補出來都一樣。
--
-- 可以重跑：已經有號碼的不會被改號，sequence 只會往前、不會倒退。
-- =============================================================

create sequence if not exists member_no_seq;

-- lpad 會把超過 5 位的數字截斷，所以超過 99999 就直接用原數字。
create or replace function member_no_format(n bigint) returns text
  language sql immutable
as $$
  select 'HB-' || case when n < 100000 then lpad(n::text, 5, '0') else n::text end
$$;

alter table members add column if not exists member_no text;

-- 既有會員補號：接在目前最大號碼之後，依加入順序排。
do $$
declare
  base bigint;
  top  bigint;
begin
  select coalesce(max(substring(member_no from 4)::bigint), 0) into base
    from members where member_no ~ '^HB-[0-9]+$';

  with ordered as (
    select line_user_id,
           row_number() over (order by created_at, line_user_id) as rn
      from members
     where member_no is null
  )
  update members m
     set member_no = member_no_format(base + o.rn)
    from ordered o
   where m.line_user_id = o.line_user_id;

  -- 讓下一個新會員接在最後一號之後。
  select coalesce(max(substring(member_no from 4)::bigint), 0) into top
    from members where member_no ~ '^HB-[0-9]+$';
  if top > 0 then
    perform setval('member_no_seq', greatest(top, (select last_value from member_no_seq)), true);
  end if;
end $$;

alter table members alter column member_no set default member_no_format(nextval('member_no_seq'));
alter table members alter column member_no set not null;
create unique index if not exists members_member_no_uq on members (member_no);
alter sequence member_no_seq owned by members.member_no;
