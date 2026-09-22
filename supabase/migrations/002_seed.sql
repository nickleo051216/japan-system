-- 種子資料：沿用現行 Google Sheets（price_table、settings）
insert into price_table (jpy_taxed_max, twd) values
  (429,180),(539,220),(649,250),(869,330),(979,350),(1089,400),
  (1309,490),(1419,530),(1639,600),(1969,700),(2519,890)
on conflict (jpy_taxed_max) do update set twd = excluded.twd;

-- 收款銀行資訊（bank_name / bank_code / bank_account）刻意不放在這裡：
-- 這個 repo 是公開的。請由業主在後台「設定 → 店家與收款設定」填寫。
-- 也不要在這裡放佔位值 —— 本檔是 upsert，重跑會把正式帳號覆蓋掉。
insert into settings (key, value) values
  ('shop_name','HEEEHABABY'),
  ('payment_deadline_days','2'),
  ('bulky_add_min','30'),
  ('bulky_add_max','50'),
  ('statement_days','1,16')
on conflict (key) do update set value = excluded.value;
