-- =============================================================================
-- 0900 · Reporting & analytics. Every aggregate is computed in PostgreSQL;
-- the UI only renders results. Dates are interpreted in the store timezone.
-- =============================================================================

create or replace function public._ts_from(p_date date)
returns timestamptz
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (p_date::timestamp at time zone public.store_timezone())
$$;

create or replace function public._local_date(p_ts timestamptz)
returns date
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (p_ts at time zone public.store_timezone())::date
$$;

create or replace function public._report_access(p_permission text default 'reports.view')
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not (public.is_system_context() or public.has_permission(p_permission) or public.has_permission('reports.view')) then
    raise exception 'PERMISSION_DENIED: % is required', p_permission using errcode = '42501';
  end if;
end;
$$;

-- Orders matching common report filters, placed within [from, to].
-- p_filters: { category_id, product_id, courier_id, district, source, payment_method, payment_status, status, created_by }
create or replace function public._report_orders(p_from date, p_to date, p_filters jsonb default '{}'::jsonb)
returns setof public.orders
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select o.* from public.orders o
  where o.created_at >= public._ts_from(p_from) and o.created_at < public._ts_from(p_to + 1)
    and (nullif(p_filters ->> 'district', '') is null or lower(o.shipping_district) = lower(p_filters ->> 'district'))
    and (nullif(p_filters ->> 'source', '') is null or o.source::text = p_filters ->> 'source')
    and (nullif(p_filters ->> 'payment_method', '') is null or o.payment_method::text = p_filters ->> 'payment_method')
    and (nullif(p_filters ->> 'payment_status', '') is null or o.payment_status::text = p_filters ->> 'payment_status')
    and (nullif(p_filters ->> 'status', '') is null or o.status::text = p_filters ->> 'status')
    and (nullif(p_filters ->> 'customer_id', '') is null or o.customer_id = (p_filters ->> 'customer_id')::uuid)
    and (nullif(p_filters ->> 'created_by', '') is null or o.created_by = (p_filters ->> 'created_by')::uuid)
    and (nullif(p_filters ->> 'courier_id', '') is null or exists (select 1 from public.shipments s
          where s.order_id = o.id and s.is_active and s.courier_id = (p_filters ->> 'courier_id')::uuid))
    and (nullif(p_filters ->> 'product_id', '') is null or exists (select 1 from public.order_items oi
          where oi.order_id = o.id and oi.product_id = (p_filters ->> 'product_id')::uuid))
    and (nullif(p_filters ->> 'category_id', '') is null or exists (select 1 from public.order_items oi
          join public.products p on p.id = oi.product_id
          where oi.order_id = o.id and p.category_id = (p_filters ->> 'category_id')::uuid))
$$;

-- -----------------------------------------------------------------------------
-- Dashboard
-- -----------------------------------------------------------------------------
create or replace function public.dashboard_overview(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := public._local_date(now());
  v_finance boolean := public.is_system_context() or public.has_permission('finance.view');
  v_orders jsonb;
  v_sessions int;
  v_result jsonb;
begin
  if not (public.is_system_context() or public.has_permission('dashboard.view')) then
    raise exception 'PERMISSION_DENIED: dashboard.view is required' using errcode = '42501';
  end if;

  with o as (select * from public._report_orders(p_from, p_to, '{}'::jsonb))
  select jsonb_build_object(
    'orders', count(*),
    'gross_sales', coalesce(sum(total_amount) filter (where status not in ('CANCELLED', 'REJECTED_FRAUD')), 0),
    'average_order_value', coalesce(round(avg(total_amount) filter (where status not in ('CANCELLED', 'REJECTED_FRAUD')), 2), 0),
    'cancelled', count(*) filter (where status = 'CANCELLED'),
    'rejected_fraud', count(*) filter (where status = 'REJECTED_FRAUD'),
    'delivered', count(*) filter (where delivered_at is not null),
    'returned', count(*) filter (where status = 'RETURNED' and delivered_at is not null),
    'failed', count(*) filter (where status = 'FAILED_DELIVERY' or (status = 'RETURNED' and delivered_at is null)),
    'shipped', count(*) filter (where shipped_at is not null),
    'cod_orders', count(*) filter (where payment_method = 'COD' and advance_required = 0),
    'advance_orders', count(*) filter (where advance_required > 0),
    'storefront_orders', count(*) filter (where source = 'STOREFRONT'),
    'status_distribution', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from o group by status) s), '{}'::jsonb),
    'payment_method_distribution', coalesce((select jsonb_object_agg(payment_method, n) from (
        select payment_method, count(*) n from o group by payment_method) s), '{}'::jsonb)
  ) into v_orders from o;

  select count(distinct session_id) into v_sessions from public.storefront_events
  where created_at >= public._ts_from(p_from) and created_at < public._ts_from(p_to + 1);

  v_result := v_orders || jsonb_build_object(
    'from', p_from, 'to', p_to,
    'orders_today', (select count(*) from public.orders where created_at >= public._ts_from(v_today)),
    'orders_this_week', (select count(*) from public.orders where created_at >= public._ts_from(date_trunc('week', v_today::timestamp)::date)),
    'orders_this_month', (select count(*) from public.orders where created_at >= public._ts_from(date_trunc('month', v_today::timestamp)::date)),
    'cancellation_rate', case when (v_orders ->> 'orders')::int > 0
      then round(100.0 * (v_orders ->> 'cancelled')::int / (v_orders ->> 'orders')::int, 2) else 0 end,
    'return_rate', case when (v_orders ->> 'delivered')::int > 0
      then round(100.0 * (v_orders ->> 'returned')::int / (v_orders ->> 'delivered')::int, 2) else 0 end,
    'failed_delivery_rate', case when (v_orders ->> 'shipped')::int > 0
      then round(100.0 * (v_orders ->> 'failed')::int / (v_orders ->> 'shipped')::int, 2) else 0 end,
    'cod_percentage', case when (v_orders ->> 'orders')::int > 0
      then round(100.0 * (v_orders ->> 'cod_orders')::int / (v_orders ->> 'orders')::int, 2) else 0 end,
    'advance_percentage', case when (v_orders ->> 'orders')::int > 0
      then round(100.0 * (v_orders ->> 'advance_orders')::int / (v_orders ->> 'orders')::int, 2) else 0 end,
    'fraud_rejection_rate', case when (v_orders ->> 'orders')::int > 0
      then round(100.0 * (v_orders ->> 'rejected_fraud')::int / (v_orders ->> 'orders')::int, 2) else 0 end,
    'sessions', v_sessions,
    'conversion_rate', case when v_sessions > 0
      then round(100.0 * (v_orders ->> 'storefront_orders')::int / v_sessions, 2) end,
    'top_products', coalesce((select jsonb_agg(t) from (
        select oi.product_id, oi.product_name, sum(oi.quantity) as quantity, sum(oi.line_total) as revenue
        from public._report_orders(p_from, p_to, '{}'::jsonb) o2
        join public.order_items oi on oi.order_id = o2.id
        where o2.status not in ('CANCELLED', 'REJECTED_FRAUD')
        group by oi.product_id, oi.product_name order by quantity desc, revenue desc limit 5) t), '[]'::jsonb),
    'top_customers', coalesce((select jsonb_agg(t) from (
        select o2.customer_id, max(o2.customer_name) as customer_name, max(o2.customer_phone) as customer_phone,
               count(*) as orders, sum(o2.total_amount) as total
        from public._report_orders(p_from, p_to, '{}'::jsonb) o2
        where o2.status not in ('CANCELLED', 'REJECTED_FRAUD')
        group by o2.customer_id order by total desc limit 5) t), '[]'::jsonb),
    'low_stock', coalesce((select jsonb_agg(t) from (
        select variant_id, product_id, product_name, variant_title, sku, available, low_stock_threshold, stock_status
        from public.inventory_overview
        where stock_status in ('LOW_STOCK', 'OUT_OF_STOCK') and product_status = 'ACTIVE' and variant_active
        order by available asc limit 8) t), '[]'::jsonb),
    'action_items', jsonb_build_object(
      'fraud_review', (select count(*) from public.orders where status = 'FRAUD_REVIEW'),
      'advance_pending', (select count(*) from public.orders where status = 'ADVANCE_REQUIRED'),
      'payments_to_verify', (select count(*) from public.payments where status = 'REQUIRES_VERIFICATION'),
      'confirmation_required', (select count(*) from public.orders where status = 'CONFIRMATION_REQUIRED'),
      'ready_to_ship', (select count(*) from public.orders where status = 'READY_TO_SHIP'),
      'low_stock', (select count(*) from public.inventory_overview
                    where stock_status in ('LOW_STOCK', 'OUT_OF_STOCK') and product_status = 'ACTIVE' and variant_active),
      'production_overdue', (select count(*) from public.production_orders
                             where status not in ('READY', 'CANCELLED') and deadline < v_today)
    )
  );

  if v_finance then
    v_result := v_result || jsonb_build_object('finance', public.report_profit_loss(p_from, p_to));
  end if;
  return v_result;
end;
$$;

-- Time series for charts: orders, sales, revenue, expenses, profit, outcomes.
create or replace function public.report_timeseries(p_from date, p_to date, p_granularity text default 'day',
                                                    p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_unit text := case when p_granularity in ('day', 'week', 'month', 'year') then p_granularity else 'day' end;
  v_finance boolean := public.is_system_context() or public.has_permission('finance.view');
  v_result jsonb;
begin
  perform public._report_access('reports.view');
  with buckets as (
    select generate_series(date_trunc(v_unit, p_from::timestamp), date_trunc(v_unit, p_to::timestamp),
                           ('1 ' || v_unit)::interval)::date as bucket
  ), o as (
    select date_trunc(v_unit, public._local_date(created_at)::timestamp)::date as bucket,
           count(*) as orders,
           sum(total_amount) filter (where status not in ('CANCELLED', 'REJECTED_FRAUD')) as gross_sales,
           count(*) filter (where status = 'CANCELLED') as cancelled,
           count(*) filter (where status = 'RETURNED') as returned,
           count(*) filter (where status = 'FAILED_DELIVERY' or (status = 'RETURNED' and delivered_at is null)) as failed
    from public._report_orders(p_from, p_to, p_filters) group by 1
  ), f as (
    select date_trunc(v_unit, ft.txn_date::timestamp)::date as bucket,
           sum(ft.amount) filter (where c.pnl_group in ('REVENUE', 'DELIVERY_INCOME')) as revenue,
           sum(ft.amount) filter (where c.pnl_group = 'CONTRA_REVENUE') as refunds,
           sum(ft.amount) filter (where c.pnl_group = 'COGS') as cogs,
           sum(ft.amount) filter (where c.pnl_group = 'OPERATING_EXPENSE') as opex,
           sum(ft.amount) filter (where c.pnl_group = 'OTHER_INCOME') as other_income
    from public.finance_transactions ft join public.finance_categories c on c.id = ft.category_id
    where v_finance and ft.txn_date between p_from and p_to group by 1
  ), nc as (
    select date_trunc(v_unit, public._local_date(created_at)::timestamp)::date as bucket, count(*) as new_customers
    from public.customers where created_at >= public._ts_from(p_from) and created_at < public._ts_from(p_to + 1)
    group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'bucket', b.bucket,
    'orders', coalesce(o.orders, 0),
    'gross_sales', coalesce(o.gross_sales, 0),
    'cancelled', coalesce(o.cancelled, 0),
    'returned', coalesce(o.returned, 0),
    'failed', coalesce(o.failed, 0),
    'new_customers', coalesce(nc.new_customers, 0),
    'revenue', case when v_finance then coalesce(f.revenue, 0) - coalesce(f.refunds, 0) end,
    'expenses', case when v_finance then coalesce(f.cogs, 0) + coalesce(f.opex, 0) end,
    'profit', case when v_finance then coalesce(f.revenue, 0) - coalesce(f.refunds, 0) - coalesce(f.cogs, 0)
                                        - coalesce(f.opex, 0) + coalesce(f.other_income, 0) end
  ) order by b.bucket), '[]'::jsonb)
  into v_result
  from buckets b
  left join o on o.bucket = b.bucket
  left join f on f.bucket = b.bucket
  left join nc on nc.bucket = b.bucket;
  return v_result;
end;
$$;

create or replace function public.report_expenses_by_category(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb;
begin
  perform public.require_permission('finance.view');
  select coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'pnl_group', pnl_group, 'amount', amount)
                  order by amount desc), '[]'::jsonb) into v
  from (
    select c.code, c.name, c.pnl_group, sum(ft.amount) as amount
    from public.finance_transactions ft join public.finance_categories c on c.id = ft.category_id
    where ft.type = 'EXPENSE' and ft.txn_date between p_from and p_to
    group by c.code, c.name, c.pnl_group
    having sum(ft.amount) <> 0
  ) t;
  return v;
end;
$$;

-- Product profitability on delivered orders (revenue net of allocated discount).
create or replace function public.report_product_performance(p_from date, p_to date, p_filters jsonb default '{}'::jsonb,
                                                             p_limit int default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb;
  v_finance boolean := public.is_system_context() or public.has_permission('finance.view');
begin
  perform public._report_access('reports.view');
  select coalesce(jsonb_agg(t order by t.revenue desc), '[]'::jsonb) into v
  from (
    select oi.product_id, max(oi.product_name) as product_name, max(c.name) as category_name,
           sum(oi.quantity) filter (where o.status not in ('CANCELLED', 'REJECTED_FRAUD')) as ordered_qty,
           coalesce(sum(oi.quantity - oi.returned_quantity - oi.damaged_quantity) filter (where o.delivered_at is not null), 0) as sold_qty,
           coalesce(sum(oi.returned_quantity + oi.damaged_quantity), 0) as returned_qty,
           coalesce(sum(oi.line_total) filter (where o.delivered_at is not null), 0) as revenue,
           case when v_finance then coalesce(sum(oi.unit_cost * (oi.quantity - oi.returned_quantity)) filter (where o.delivered_at is not null), 0) end as cogs,
           case when v_finance then coalesce(sum(oi.line_total - oi.unit_cost * (oi.quantity - oi.returned_quantity)) filter (where o.delivered_at is not null), 0) end as gross_profit,
           case when v_finance and coalesce(sum(oi.line_total) filter (where o.delivered_at is not null), 0) > 0
             then round(100 * sum(oi.line_total - oi.unit_cost * (oi.quantity - oi.returned_quantity)) filter (where o.delivered_at is not null)
                        / sum(oi.line_total) filter (where o.delivered_at is not null), 2) end as margin_pct
    from public._report_orders(p_from, p_to, p_filters) o
    join public.order_items oi on oi.order_id = o.id
    left join public.products p on p.id = oi.product_id
    left join public.categories c on c.id = p.category_id
    group by oi.product_id
    order by revenue desc
    limit least(greatest(p_limit, 1), 1000)
  ) t;
  return v;
end;
$$;

create or replace function public.report_customers(p_from date, p_to date, p_limit int default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._report_access('customers.view');
  return jsonb_build_object(
    'segments', coalesce((select jsonb_object_agg(segment, n) from (
        select segment, count(*) n from public.customers group by segment) s), '{}'::jsonb),
    'new_customers', (select count(*) from public.customers
                      where created_at >= public._ts_from(p_from) and created_at < public._ts_from(p_to + 1)),
    'repeat_customers', (select count(*) from (select customer_id from public._report_orders(p_from, p_to, '{}'::jsonb)
                         group by customer_id having count(*) > 1) r),
    'top_customers', coalesce((select jsonb_agg(t) from (
        select c.id, c.full_name, c.phone, c.segment, c.district, count(o.id) as orders,
               coalesce(sum(o.total_amount) filter (where o.delivered_at is not null), 0) as delivered_value,
               count(o.id) filter (where o.status = 'CANCELLED') as cancelled,
               count(o.id) filter (where o.status in ('RETURNED', 'FAILED_DELIVERY')) as returned_or_failed
        from public._report_orders(p_from, p_to, '{}'::jsonb) o join public.customers c on c.id = o.customer_id
        group by c.id order by delivered_value desc, orders desc limit least(greatest(p_limit, 1), 500)) t), '[]'::jsonb),
    'by_district', coalesce((select jsonb_agg(t) from (
        select initcap(shipping_district) as district, count(*) as orders, count(distinct customer_id) as customers,
               coalesce(sum(total_amount) filter (where delivered_at is not null), 0) as delivered_value
        from public._report_orders(p_from, p_to, '{}'::jsonb) group by initcap(shipping_district)
        order by orders desc limit 30) t), '[]'::jsonb)
  );
end;
$$;

create or replace function public.report_couriers(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb;
begin
  perform public._report_access('couriers.view');
  select coalesce(jsonb_agg(t order by t.shipments desc), '[]'::jsonb) into v from (
    select c.id as courier_id, c.name as courier_name, c.provider,
           count(s.id) as shipments,
           count(s.id) filter (where s.status in ('DELIVERED', 'PARTIALLY_DELIVERED')) as delivered,
           count(s.id) filter (where s.status in ('FAILED', 'RETURNING', 'RETURNED')) as failed_or_returned,
           count(s.id) filter (where s.status in ('BOOKED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY')) as in_transit,
           case when count(s.id) filter (where s.status in ('DELIVERED', 'PARTIALLY_DELIVERED', 'FAILED', 'RETURNING', 'RETURNED')) > 0
             then round(100.0 * count(s.id) filter (where s.status in ('DELIVERED', 'PARTIALLY_DELIVERED'))
                  / count(s.id) filter (where s.status in ('DELIVERED', 'PARTIALLY_DELIVERED', 'FAILED', 'RETURNING', 'RETURNED')), 2) end as success_rate,
           coalesce(round(avg(s.shipping_cost), 2), 0) as avg_shipping_cost,
           coalesce(sum(s.shipping_cost), 0) as total_shipping_cost,
           coalesce(sum(s.return_charge) filter (where s.status = 'RETURNED'), 0) as total_return_charges,
           coalesce(sum(s.cod_collected), 0) as cod_collected,
           coalesce(sum(o.total_amount - o.amount_paid) filter (where s.status = 'DELIVERED' and o.total_amount > o.amount_paid), 0) as cod_pending,
           round(avg(extract(epoch from (s.delivered_at - o.shipped_at)) / 3600) filter (where s.delivered_at is not null and o.shipped_at is not null), 1) as avg_delivery_hours
    from public.couriers c
    left join public.shipments s on s.courier_id = c.id and s.created_at >= public._ts_from(p_from)
      and s.created_at < public._ts_from(p_to + 1) and s.status <> 'CANCELLED'
    left join public.orders o on o.id = s.order_id
    group by c.id
  ) t;
  return v;
end;
$$;

create or replace function public.report_cancellations_returns(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._report_access('reports.view');
  return jsonb_build_object(
    'cancel_reasons', coalesce((select jsonb_agg(t) from (
        select coalesce(nullif(trim(cancel_reason), ''), 'No reason given') as reason, count(*) as orders, sum(total_amount) as value
        from public._report_orders(p_from, p_to, '{}'::jsonb) where status in ('CANCELLED', 'REJECTED_FRAUD')
        group by 1 order by orders desc limit 20) t), '[]'::jsonb),
    'returned_products', coalesce((select jsonb_agg(t) from (
        select oi.product_name, sum(oi.returned_quantity) as restocked, sum(oi.damaged_quantity) as damaged
        from public._report_orders(p_from, p_to, '{}'::jsonb) o join public.order_items oi on oi.order_id = o.id
        where oi.returned_quantity + oi.damaged_quantity > 0
        group by oi.product_name order by sum(oi.returned_quantity + oi.damaged_quantity) desc limit 20) t), '[]'::jsonb),
    'by_district', coalesce((select jsonb_agg(t) from (
        select initcap(shipping_district) as district,
               count(*) filter (where status = 'CANCELLED') as cancelled,
               count(*) filter (where status = 'RETURNED' or status = 'FAILED_DELIVERY') as returned_or_failed,
               count(*) as orders
        from public._report_orders(p_from, p_to, '{}'::jsonb) group by 1
        having count(*) filter (where status in ('CANCELLED', 'RETURNED', 'FAILED_DELIVERY')) > 0
        order by 3 desc, 2 desc limit 20) t), '[]'::jsonb)
  );
end;
$$;

create or replace function public.report_fraud(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._report_access('fraud.view');
  return jsonb_build_object(
    'checks', (select count(*) from public.fraud_checks where created_at >= public._ts_from(p_from) and created_at < public._ts_from(p_to + 1)),
    'provider_errors', (select count(*) from public.fraud_checks where status = 'ERROR'
                        and created_at >= public._ts_from(p_from) and created_at < public._ts_from(p_to + 1)),
    'decisions', coalesce((select jsonb_object_agg(coalesce(fraud_decision::text, 'NOT_CHECKED'), n) from (
        select fraud_decision, count(*) n from public._report_orders(p_from, p_to, '{}'::jsonb) group by fraud_decision) s), '{}'::jsonb),
    'risk_levels', coalesce((select jsonb_object_agg(coalesce(risk_level::text, 'UNKNOWN'), n) from (
        select risk_level, count(*) n from public._report_orders(p_from, p_to, '{}'::jsonb) group by risk_level) s), '{}'::jsonb),
    'outcomes_by_risk', coalesce((select jsonb_agg(t) from (
        select coalesce(risk_level::text, 'UNKNOWN') as risk_level, count(*) as orders,
               count(*) filter (where delivered_at is not null) as delivered,
               count(*) filter (where status in ('CANCELLED', 'REJECTED_FRAUD')) as cancelled_or_rejected,
               count(*) filter (where status = 'FAILED_DELIVERY' or (status = 'RETURNED' and delivered_at is null)) as failed
        from public._report_orders(p_from, p_to, '{}'::jsonb) group by 1 order by 1) t), '[]'::jsonb),
    'reviews', coalesce((select jsonb_object_agg(action, n) from (
        select action, count(*) n from public.fraud_reviews
        where created_at >= public._ts_from(p_from) and created_at < public._ts_from(p_to + 1) group by action) s), '{}'::jsonb),
    'rejected_value', coalesce((select sum(total_amount) from public._report_orders(p_from, p_to, '{}'::jsonb)
                                where status = 'REJECTED_FRAUD'), 0)
  );
end;
$$;

create or replace function public.report_advance_payments(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._report_access('finance.view');
  return (
    select jsonb_build_object(
      'orders_requiring_advance', count(*) filter (where advance_required > 0),
      'advance_required_total', coalesce(sum(advance_required) filter (where advance_required > 0), 0),
      'orders_paid', count(*) filter (where advance_required > 0 and amount_paid >= advance_required),
      'advance_collected', coalesce((select sum(op.amount) from public.order_payments op
          join public._report_orders(p_from, p_to, '{}'::jsonb) o2 on o2.id = op.order_id
          where op.kind in ('ADVANCE', 'FULL')), 0),
      'expired_unpaid', count(*) filter (where advance_required > 0 and status = 'CANCELLED' and amount_paid < advance_required),
      'awaiting_payment', count(*) filter (where status = 'ADVANCE_REQUIRED'),
      'payment_rate', case when count(*) filter (where advance_required > 0) > 0
        then round(100.0 * count(*) filter (where advance_required > 0 and amount_paid >= advance_required)
                   / count(*) filter (where advance_required > 0), 2) end,
      'delivered_after_advance', count(*) filter (where advance_required > 0 and delivered_at is not null),
      'by_channel', coalesce((select jsonb_object_agg(channel, amount) from (
          select op.channel, sum(op.amount) as amount from public.order_payments op
          join public._report_orders(p_from, p_to, '{}'::jsonb) o3 on o3.id = op.order_id
          where op.kind in ('ADVANCE', 'FULL') group by op.channel) s), '{}'::jsonb)
    )
    from public._report_orders(p_from, p_to, '{}'::jsonb)
  );
end;
$$;

create or replace function public.report_inventory_valuation()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._report_access('inventory.view');
  return jsonb_build_object(
    'totals', (select jsonb_build_object(
        'units_on_hand', coalesce(sum(on_hand) filter (where on_hand > 0), 0),
        'units_reserved', coalesce(sum(reserved), 0),
        'units_damaged', coalesce(sum(damaged), 0),
        'value_at_cost', coalesce(sum(greatest(on_hand, 0) * unit_cost), 0),
        'value_at_retail', coalesce(sum(greatest(on_hand, 0) * unit_price), 0),
        'damaged_value', coalesce(sum(damaged * unit_cost), 0),
        'low_stock_variants', count(*) filter (where stock_status = 'LOW_STOCK'),
        'out_of_stock_variants', count(*) filter (where stock_status = 'OUT_OF_STOCK'))
      from public.inventory_overview where track_inventory),
    'by_category', coalesce((select jsonb_agg(t order by t.value_at_cost desc) from (
        select coalesce(category_name, 'Uncategorised') as category, sum(greatest(on_hand, 0)) as units,
               sum(greatest(on_hand, 0) * unit_cost) as value_at_cost, sum(greatest(on_hand, 0) * unit_price) as value_at_retail
        from public.inventory_overview where track_inventory group by 1) t), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(t order by t.value_at_cost desc) from (
        select product_name, variant_title, sku, on_hand, reserved, available, damaged, unit_cost, unit_price,
               greatest(on_hand, 0) * unit_cost as value_at_cost, stock_status
        from public.inventory_overview where track_inventory) t), '[]'::jsonb)
  );
end;
$$;

create or replace function public.report_production(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._report_access('production.view');
  return (
    select jsonb_build_object(
      'created', count(*),
      'completed', count(*) filter (where status = 'READY'),
      'in_progress', count(*) filter (where status in ('WAITING', 'IN_PRODUCTION', 'PAUSED', 'QUALITY_CHECK', 'PACKING')),
      'cancelled', count(*) filter (where status = 'CANCELLED'),
      'qc_rejections', coalesce(sum(rejection_count), 0),
      'overdue', count(*) filter (where status not in ('READY', 'CANCELLED') and deadline < public._local_date(now())),
      'avg_cycle_hours', round(avg(extract(epoch from (completed_at - created_at)) / 3600) filter (where completed_at is not null), 1),
      'by_status', coalesce((select jsonb_object_agg(status, n) from (
          select status, count(*) n from public.production_orders
          where created_at >= public._ts_from(p_from) and created_at < public._ts_from(p_to + 1) group by status) s), '{}'::jsonb),
      'by_assignee', coalesce((select jsonb_agg(t) from (
          select coalesce(pr.full_name, 'Unassigned') as assignee, count(*) as orders,
                 count(*) filter (where po2.status = 'READY') as completed
          from public.production_orders po2 left join public.profiles pr on pr.id = po2.assigned_to
          where po2.created_at >= public._ts_from(p_from) and po2.created_at < public._ts_from(p_to + 1)
          group by 1 order by 2 desc) t), '[]'::jsonb)
    )
    from public.production_orders
    where created_at >= public._ts_from(p_from) and created_at < public._ts_from(p_to + 1)
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Reporting views (security_invoker: callers need read access to the base
-- tables through RLS)
-- -----------------------------------------------------------------------------
create or replace view public.v_daily_sales with (security_invoker = true) as
select public._local_date(created_at) as day,
       count(*) as orders,
       count(*) filter (where status not in ('CANCELLED', 'REJECTED_FRAUD')) as valid_orders,
       coalesce(sum(total_amount) filter (where status not in ('CANCELLED', 'REJECTED_FRAUD')), 0) as gross_sales,
       count(*) filter (where status = 'CANCELLED') as cancelled,
       count(*) filter (where delivered_at is not null) as delivered
from public.orders group by 1;

create or replace view public.v_monthly_sales with (security_invoker = true) as
select date_trunc('month', public._local_date(created_at)::timestamp)::date as month,
       count(*) as orders,
       coalesce(sum(total_amount) filter (where status not in ('CANCELLED', 'REJECTED_FRAUD')), 0) as gross_sales,
       coalesce(avg(total_amount) filter (where status not in ('CANCELLED', 'REJECTED_FRAUD')), 0)::numeric(12,2) as average_order_value
from public.orders group by 1;

create or replace view public.v_profit_summary with (security_invoker = true) as
select date_trunc('month', ft.txn_date::timestamp)::date as month,
       coalesce(sum(ft.amount) filter (where c.pnl_group in ('REVENUE', 'DELIVERY_INCOME')), 0) as revenue,
       coalesce(sum(ft.amount) filter (where c.pnl_group = 'CONTRA_REVENUE'), 0) as refunds,
       coalesce(sum(ft.amount) filter (where c.pnl_group = 'COGS'), 0) as cogs,
       coalesce(sum(ft.amount) filter (where c.pnl_group = 'OPERATING_EXPENSE'), 0) as operating_expenses,
       coalesce(sum(ft.amount) filter (where c.pnl_group = 'OTHER_INCOME'), 0) as other_income,
       coalesce(sum(ft.amount) filter (where c.pnl_group in ('REVENUE', 'DELIVERY_INCOME', 'OTHER_INCOME')), 0)
         - coalesce(sum(ft.amount) filter (where c.pnl_group in ('CONTRA_REVENUE', 'COGS', 'OPERATING_EXPENSE')), 0) as net_profit
from public.finance_transactions ft join public.finance_categories c on c.id = ft.category_id
group by 1;

create or replace view public.v_inventory_valuation with (security_invoker = true) as
select product_id, product_name, sum(greatest(on_hand, 0)) as units, sum(reserved) as reserved, sum(damaged) as damaged,
       sum(greatest(on_hand, 0) * unit_cost) as value_at_cost, sum(greatest(on_hand, 0) * unit_price) as value_at_retail
from public.inventory_overview where track_inventory group by product_id, product_name;

create or replace view public.v_customer_statistics with (security_invoker = true) as
select segment, count(*) as customers, sum(total_orders) as orders, sum(total_spent) as total_spent,
       round(avg(nullif(average_order_value, 0)), 2) as average_order_value
from public.customers group by segment;

create or replace view public.v_courier_performance with (security_invoker = true) as
select c.id as courier_id, c.name, count(s.id) as shipments,
       count(s.id) filter (where s.status = 'DELIVERED') as delivered,
       count(s.id) filter (where s.status in ('FAILED', 'RETURNED', 'RETURNING')) as failed_or_returned,
       coalesce(sum(s.shipping_cost), 0) as shipping_cost
from public.couriers c left join public.shipments s on s.courier_id = c.id and s.status <> 'CANCELLED'
group by c.id, c.name;

create or replace view public.v_fraud_performance with (security_invoker = true) as
select date_trunc('month', created_at)::date as month, decision, risk_level, count(*) as checks,
       round(avg(risk_score), 2) as avg_score
from public.fraud_checks group by 1, 2, 3;

create or replace view public.v_order_statistics with (security_invoker = true) as
select status, count(*) as orders, coalesce(sum(total_amount), 0) as value
from public.orders group by status;
