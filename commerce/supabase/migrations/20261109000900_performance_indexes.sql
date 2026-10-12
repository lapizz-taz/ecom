-- =============================================================================
-- Performance: from the database advisor.
--
-- 1. Indexes on links to orders and order lines that are read by order, and
--    that a store reset (which deletes a merchant's orders) would otherwise
--    scan once per deleted order.
-- 2. Four read rules looked up the signed-in user once per row; they now do
--    it once per query. Who can read what is unchanged.
-- =============================================================================

-- 1. Indexes --------------------------------------------------------------------
create index if not exists channel_order_imports_order_idx on public.channel_order_imports (order_id) where order_id is not null;
create index if not exists stock_reservations_order_item_idx on public.stock_reservations (order_item_id) where order_item_id is not null;
create index if not exists coupon_usage_order_idx on public.coupon_usage (order_id) where order_id is not null;
create index if not exists checkout_leads_order_idx on public.checkout_leads (order_id) where order_id is not null;
create index if not exists store_carts_order_idx on public.store_carts (order_id) where order_id is not null;
create index if not exists orders_merged_into_idx on public.orders (merged_into) where merged_into is not null;
create index if not exists orders_duplicate_of_idx on public.orders (duplicate_of) where duplicate_of is not null;
create index if not exists shipment_charges_order_idx on public.shipment_charges (order_id) where order_id is not null;
create index if not exists courier_webhook_events_order_idx on public.courier_webhook_events (order_id) where order_id is not null;
create index if not exists courier_invoice_lines_order_idx on public.courier_invoice_lines (order_id) where order_id is not null;
create index if not exists pbx_calls_order_idx on public.pbx_calls (order_id) where order_id is not null;
create index if not exists production_items_order_item_idx on public.production_items (order_item_id) where order_item_id is not null;
create index if not exists order_blocks_source_order_idx on public.order_blocks (source_order_id) where source_order_id is not null;
create index if not exists customers_auth_user_idx on public.customers (auth_user_id) where auth_user_id is not null;
create index if not exists api_request_logs_key_idx on public.api_request_logs (key_id) where key_id is not null;

-- 2. Read rules: the signed-in user is looked up once per query -----------------
alter policy hr_employees_read on public.hr_employees
  using (profile_id = (select auth.uid()) or (select public.has_permission('hr.view')));
alter policy hr_attendance_read on public.hr_attendance
  using (profile_id = (select auth.uid()) or (select public.has_permission('hr.view')));
alter policy support_tickets_read on public.support_tickets
  using (created_by = (select auth.uid()) or (select public.has_permission('support.manage')));
alter policy support_ticket_messages_read on public.support_ticket_messages
  using (exists (select 1 from public.support_tickets t
                 where t.id = support_ticket_messages.ticket_id
                   and (t.created_by = (select auth.uid()) or (select public.has_permission('support.manage')))));
