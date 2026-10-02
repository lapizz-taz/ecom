-- =============================================================================
-- 1200 · API surface. Deny by default, then allow exactly what each role may
-- call. Business functions check permissions internally as well.
-- =============================================================================

-- Staff wrapper around the pricing engine (the raw function exposes costs).
create or replace function public.admin_quote_order(
  p_items jsonb, p_district text, p_area text default null, p_delivery_method text default 'standard',
  p_coupon_code text default null, p_phone text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('orders.create');
  return public.calculate_order_quote(p_items, p_district, p_area, p_delivery_method, p_coupon_code, p_phone, true,
    public.has_permission('orders.price_override'));
end;
$$;

-- Functions ------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- Used by RLS policies and security-invoker views (evaluated as the caller).
grant execute on function public.has_permission(text) to anon, authenticated;
grant execute on function public.is_staff() to anon, authenticated;
grant execute on function public.current_role_code() to anon, authenticated;
grant execute on function public.setting_numeric(text, text[], numeric) to authenticated;
grant execute on function public._local_date(timestamptz) to authenticated;

-- Storefront (anonymous visitors and signed-in customers).
grant execute on function public.storefront_config() to anon, authenticated;
grant execute on function public.storefront_categories() to anon, authenticated;
grant execute on function public.storefront_list_products(text, text, text, numeric, numeric, boolean, text, boolean, int, int) to anon, authenticated;
grant execute on function public.storefront_get_product(text) to anon, authenticated;
grant execute on function public.storefront_quote(jsonb, text, text, text, text, text) to anon, authenticated;
grant execute on function public.track_order(text, text) to anon, authenticated;
grant execute on function public.track_storefront_event(text, text, uuid, text, text) to anon, authenticated;
grant execute on function public.submit_contact_message(text, text, text, text, text) to anon, authenticated;
grant execute on function public.customer_my_orders(int, int) to authenticated;
grant execute on function public.customer_get_order(uuid) to authenticated;

-- Staff (each function enforces its own permission).
grant execute on function public.get_my_access() to authenticated;
grant execute on function public.update_my_profile(text, text) to authenticated;
grant execute on function public.admin_set_user_role(uuid, text, boolean) to authenticated;
grant execute on function public.admin_update_setting(text, jsonb) to authenticated;
grant execute on function public.adjust_stock(uuid, public.inventory_movement_type, int, text, text, numeric) to authenticated;
grant execute on function public.admin_save_product(jsonb) to authenticated;
grant execute on function public.admin_reorder_product_images(uuid, uuid[], uuid) to authenticated;
grant execute on function public.admin_quote_order(jsonb, text, text, text, text, text) to authenticated;
grant execute on function public.transition_order_status(uuid, public.order_status, text) to authenticated;
grant execute on function public.bulk_transition_orders(uuid[], public.order_status, text) to authenticated;
grant execute on function public.process_order_return(uuid, jsonb, text) to authenticated;
grant execute on function public.admin_create_order(jsonb, boolean) to authenticated;
grant execute on function public.admin_update_order(uuid, jsonb) to authenticated;
grant execute on function public.admin_set_order_items(uuid, jsonb) to authenticated;
grant execute on function public.admin_duplicate_order(uuid) to authenticated;
grant execute on function public.add_order_note(uuid, text, public.note_visibility, public.note_kind) to authenticated;
grant execute on function public.verify_manual_payment(uuid, boolean, text) to authenticated;
grant execute on function public.record_order_payment(uuid, public.order_payment_kind, public.payment_channel, numeric, text, text, text) to authenticated;
grant execute on function public.refund_order(uuid, numeric, public.payment_channel, text, text) to authenticated;
grant execute on function public.retain_order_advance(uuid, text) to authenticated;
grant execute on function public.expire_unpaid_advance_orders() to authenticated;
grant execute on function public.admin_search_orders(jsonb, text, text, int, int) to authenticated;
grant execute on function public.admin_order_status_counts() to authenticated;
grant execute on function public.fraud_customer_metrics(text, uuid) to authenticated;
grant execute on function public.record_fraud_check(jsonb) to authenticated;
grant execute on function public.apply_fraud_decision(uuid, uuid) to authenticated;
grant execute on function public.fraud_review_decide(uuid, text, numeric, text, boolean) to authenticated;
grant execute on function public.admin_fraud_queue(public.order_status[], public.risk_level, int, int) to authenticated;
grant execute on function public.admin_save_fraud_rule(jsonb) to authenticated;
grant execute on function public.production_action(uuid, text, text) to authenticated;
grant execute on function public.production_update(uuid, uuid, public.production_priority, date, text) to authenticated;
grant execute on function public.admin_create_production_order(uuid) to authenticated;
grant execute on function public.assign_courier(uuid, uuid, text, numeric, text, text, jsonb) to authenticated;
grant execute on function public.update_shipment(uuid, jsonb) to authenticated;
grant execute on function public.apply_shipment_status(uuid, public.shipment_status, text, text, timestamptz, public.data_source, jsonb, text) to authenticated;
grant execute on function public.record_cod_settlement(uuid[], text, text) to authenticated;
grant execute on function public.create_finance_transaction(jsonb) to authenticated;
grant execute on function public.reverse_finance_transaction(uuid, text) to authenticated;
grant execute on function public.admin_save_purchase_order(jsonb) to authenticated;
grant execute on function public.purchase_order_set_status(uuid, public.purchase_status) to authenticated;
grant execute on function public.receive_purchase_order(uuid, jsonb, text) to authenticated;
grant execute on function public.record_purchase_payment(uuid, numeric, public.payment_channel, date, text, text) to authenticated;
grant execute on function public.report_profit_loss(date, date) to authenticated;
grant execute on function public.report_cash_flow(date, date, text) to authenticated;
grant execute on function public.finance_overview(date, date) to authenticated;
grant execute on function public.retry_notification(uuid) to authenticated;
grant execute on function public.admin_update_customer(uuid, jsonb) to authenticated;
grant execute on function public.admin_create_customer(jsonb) to authenticated;
grant execute on function public.admin_customer_summary(uuid) to authenticated;
grant execute on function public.dashboard_overview(date, date) to authenticated;
grant execute on function public.report_timeseries(date, date, text, jsonb) to authenticated;
grant execute on function public.report_expenses_by_category(date, date) to authenticated;
grant execute on function public.report_product_performance(date, date, jsonb, int) to authenticated;
grant execute on function public.report_customers(date, date, int) to authenticated;
grant execute on function public.report_couriers(date, date) to authenticated;
grant execute on function public.report_cancellations_returns(date, date) to authenticated;
grant execute on function public.report_fraud(date, date) to authenticated;
grant execute on function public.report_advance_payments(date, date) to authenticated;
grant execute on function public.report_inventory_valuation() to authenticated;
grant execute on function public.report_production(date, date) to authenticated;

-- Tables ---------------------------------------------------------------------
-- Visitors never write tables directly.
revoke insert, update, delete, truncate on all tables in schema public from anon;
revoke truncate on all tables in schema public from authenticated;

-- Ledgers and workflow tables change only through the functions above.
revoke insert, update, delete on
  public.orders, public.order_items, public.order_status_history, public.order_notes, public.stock_reservations,
  public.payments, public.payment_events, public.order_payments, public.inventory, public.inventory_movements,
  public.finance_transactions, public.fraud_checks, public.fraud_reviews, public.fraud_rule_actions,
  public.notification_logs, public.customers, public.shipments, public.shipment_events, public.production_orders,
  public.production_items, public.production_status_history, public.purchase_orders, public.purchase_order_items,
  public.coupon_usage, public.storefront_events, public.order_status_transitions, public.product_variants
from authenticated;
revoke insert on public.products, public.fraud_rules, public.notifications, public.contact_messages from authenticated;
revoke delete on public.notifications, public.contact_messages, public.finance_categories from authenticated;

grant usage, select on all sequences in schema public to authenticated, service_role;
