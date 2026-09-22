-- 回滾：刪除 001～004 建立的所有物件（僅在需要重來時執行）
drop function if exists run_schema_selftest() cascade;
drop table if exists expenses, fx_history, notifications, idempotency cascade;
drop function if exists shout(text,text,int) cascade;
drop table if exists
  restock_watch, logistics_bindings, shipments, procurements, payments,
  cart_items, wishlist, broadcast, order_items, order_status_log,
  order_status_rules, audit_log, settings, price_table, products
  cascade;
alter table if exists orders drop constraint if exists orders_statement_fk;
drop table if exists statements, orders, batches, members cascade;
drop function if exists check_order_status() cascade;
drop function if exists log_order_status() cascade;
