-- =============================================================
-- 自我檢測：在 Supabase SQL Editor 執行，會回傳一張 通過/失敗 表
-- 所有測試資料以 ZZTEST 開頭，結束時自動清除，不會留下任何資料
-- =============================================================
create or replace function run_schema_selftest()
returns table (項目 text, 結果 text, 說明 text)
language plpgsql as $$
declare n int; r record; won int := 0; ok boolean;
begin
  -- 清掉上次殘留
  delete from cart_items where line_user_id like 'ZZTEST%';
  delete from order_status_log where order_id like 'ZZTEST%';
  delete from orders where order_id like 'ZZTEST%';
  delete from broadcast where send_id like 'ZZTEST%';
  delete from members where line_user_id like 'ZZTEST%';

  select count(*) into n from pg_tables where schemaname='public';
  項目:='資料表數量'; 結果:=case when n>=19 then '✅' else '❌' end; 說明:=n||' 張'; return next;

  select count(*) into n from pg_tables where schemaname='public' and not rowsecurity;
  項目:='RLS 全數開啟'; 結果:=case when n=0 then '✅' else '❌' end; 說明:='未開啟 '||n||' 張'; return next;

  insert into members(line_user_id,nickname) values ('ZZTEST-U1','ZZTEST 周周');
  begin
    insert into members(line_user_id,nickname) values ('ZZTEST-U2',' zztest 周周 ');
    項目:='暱稱重複擋下'; 結果:='❌'; 說明:='沒有擋下'; return next;
  exception when unique_violation then
    項目:='暱稱重複擋下'; 結果:='✅'; 說明:='不分大小寫與空白'; return next;
  end;

  insert into orders(order_id,line_user_id) values ('ZZTEST-O1','ZZTEST-U1');
  update orders set status='已報價' where order_id='ZZTEST-O1';
  begin
    update orders set status='已送達' where order_id='ZZTEST-O1';
    項目:='狀態跳級擋下'; 結果:='❌'; 說明:='沒有擋下'; return next;
  exception when others then
    項目:='狀態跳級擋下'; 結果:=case when sqlerrm like 'ILLEGAL_TRANSITION%' then '✅' else '❌' end;
    說明:=sqlerrm; return next;
  end;
  select count(*) into n from order_status_log where order_id='ZZTEST-O1';
  項目:='狀態紀錄寫入'; 結果:=case when n=2 then '✅' else '❌' end; 說明:=n||' 筆（建立＋報價）'; return next;

  select twd into r from price_table where jpy_taxed_max >= 540 order by jpy_taxed_max limit 1;
  項目:='價目表級距'; 結果:=case when r.twd=250 then '✅' when r is null then '⚠️' else '❌' end;
  說明:=coalesce('¥540 → NT$'||r.twd,'price_table 尚未匯入資料'); return next;

  insert into broadcast(send_id,name,price_twd,quantity,remaining)
    values ('ZZTEST-B1','測試商品',500,5,5);
  for i in 1..20 loop
    insert into members(line_user_id,nickname) values ('ZZTEST-R'||i,'ZZTEST 搶購'||i);
    select granted into n from shout('ZZTEST-B1','ZZTEST-R'||i,1);
    if n>0 then won:=won+1; end if;
  end loop;
  select remaining into n from broadcast where send_id='ZZTEST-B1';
  項目:='20 人搶 5 個名額'; 結果:=case when won=5 and n=0 then '✅' else '❌' end;
  說明:=won||' 人搶到，餘量 '||n; return next;

  select coalesce(sum(qty),0) into n from cart_items where ref='ZZTEST-B1';
  項目:='購物車總量等於上架量'; 結果:=case when n=5 then '✅' else '❌' end; 說明:=n||' / 5'; return next;

  select not has_function_privilege('anon','shout(text,text,int)','execute') into ok;
  項目:='前端無法直接呼叫喊單'; 結果:=case when ok then '✅' else '❌' end; 說明:='anon 無執行權限'; return next;

  -- 清除
  delete from cart_items where line_user_id like 'ZZTEST%';
  delete from order_status_log where order_id like 'ZZTEST%';
  delete from orders where order_id like 'ZZTEST%';
  delete from broadcast where send_id like 'ZZTEST%';
  delete from members where line_user_id like 'ZZTEST%';
  項目:='測試資料清除'; 結果:='✅'; 說明:='ZZTEST 開頭資料已刪除'; return next;
end $$;

select * from run_schema_selftest();
