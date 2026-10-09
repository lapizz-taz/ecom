-- Dashboard command centre: courier overview, business overview (today and the
-- period), recent orders and customers, returning customers, top sources.
-- Finance and marketing figures are only included for staff who may see them.

create or replace function public.dashboard_command_center(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_sys boolean := public.is_system_context();
  v_finance boolean := v_sys or public.has_permission('finance.view');
  v_marketing boolean := v_sys or public.has_permission('marketing.view');
  v_customers boolean := v_sys or public.has_permission('customers.view');
  v_today date := public._local_date(now());
  v_start timestamptz := public._ts_from(p_from);
  v_end timestamptz := public._ts_from(p_to + 1);
  v_sessions int;
  v_buyers int;
  v_out jsonb;
  v_fin jsonb;
  v_fin_today jsonb;
begin
  if not (v_sys or public.has_permission('dashboard.view')) then
    raise exception 'PERMISSION_DENIED: dashboard.view is required' using errcode = '42501';
  end if;

  -- Conversion: storefront sessions that bought ÷ sessions (never above 100%).
  select count(distinct session_id), count(distinct session_id) filter (where event_type = 'PURCHASE')
  into v_sessions, v_buyers
  from public.storefront_events where created_at >= v_start and created_at < v_end;

  with po as (
    select * from public.orders where created_at >= v_start and created_at < v_end
  ), today as (
    select * from public.orders where created_at >= public._ts_from(v_today)
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to,
    'today', jsonb_build_object(
      'orders', (select count(*) from today),
      'sales', (select coalesce(sum(total_amount), 0) from today where status not in ('CANCELLED', 'REJECTED_FRAUD')),
      'approved', (select count(*) from public.orders where confirmed_at >= public._ts_from(v_today)),
      'delivered', (select count(*) from public.orders where delivered_at >= public._ts_from(v_today))),
    'period', jsonb_build_object(
      'orders', (select count(*) from po),
      'sales', (select coalesce(sum(total_amount), 0) from po where status not in ('CANCELLED', 'REJECTED_FRAUD')),
      'average_order_value', (select coalesce(round(avg(total_amount), 2), 0) from po where status not in ('CANCELLED', 'REJECTED_FRAUD')),
      'cod_orders_value', (select coalesce(sum(total_amount - amount_paid), 0) from po
                           where payment_method = 'COD' and status not in ('CANCELLED', 'REJECTED_FRAUD')),
      -- Orders from customers who had ordered before the period started.
      'returning_orders', (select count(*) from po where po.customer_id is not null and exists (
          select 1 from public.orders p where p.customer_id = po.customer_id and p.created_at < po.created_at
            and p.status not in ('CANCELLED', 'REJECTED_FRAUD'))),
      'sessions', v_sessions,
      'conversion_rate', case when v_sessions > 0 then round(100.0 * v_buyers / v_sessions, 2) end),
    -- Cash on delivery still with couriers (shipped, not yet delivered or settled).
    'cod_in_transit', (select coalesce(sum(s.cod_amount), 0) from public.shipments s
      where s.is_active and s.status in ('BOOKED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'ON_HOLD')),
    'couriers', coalesce((select jsonb_agg(c order by c.total desc, c.name) from (
      select cr.id, cr.name, cr.provider,
        count(s.id) as total,
        count(s.id) filter (where s.status in ('BOOKED', 'PICKED_UP')) as booked,
        count(s.id) filter (where s.status in ('IN_TRANSIT', 'OUT_FOR_DELIVERY', 'ON_HOLD')) as in_transit,
        count(s.id) filter (where s.status in ('DELIVERED', 'PARTIALLY_DELIVERED')) as delivered,
        count(s.id) filter (where s.status in ('RETURNING', 'RETURNED')) as returned,
        count(s.id) filter (where s.status = 'FAILED') as failed,
        -- Still on the way but no courier update for a day: needs a status check.
        count(s.id) filter (where s.status in ('BOOKED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'ON_HOLD')
                              and s.updated_at < now() - interval '24 hours') as stale,
        case when count(s.id) filter (where s.status in ('DELIVERED', 'PARTIALLY_DELIVERED', 'RETURNING', 'RETURNED', 'FAILED')) > 0
          then round(100.0 * count(s.id) filter (where s.status in ('DELIVERED', 'PARTIALLY_DELIVERED'))
                     / count(s.id) filter (where s.status in ('DELIVERED', 'PARTIALLY_DELIVERED', 'RETURNING', 'RETURNED', 'FAILED')), 1) end as success_rate
      from public.couriers cr
      join public.shipments s on s.courier_id = cr.id and s.is_active and s.created_at >= v_start and s.created_at < v_end
      group by cr.id, cr.name, cr.provider) c), '[]'::jsonb),
    'unshipped_approved', (select count(*) from public.orders o where o.confirmed_at is not null
      and o.status in ('CONFIRMED', 'PROCESSING', 'PACKING', 'READY_TO_SHIP')
      and not exists (select 1 from public.shipments s where s.order_id = o.id and s.is_active)),
    'recent_orders', coalesce((select jsonb_agg(r) from (
      select o.id, o.order_number, o.customer_name, o.customer_phone, o.total_amount, o.status, o.source, o.created_at,
             (o.confirmed_at is not null) as approved
      from public.orders o order by o.created_at desc limit 8) r), '[]'::jsonb),
    'recent_customers', case when v_customers then coalesce((select jsonb_agg(r) from (
      select c.id, c.full_name, c.phone, c.district, c.total_orders, c.total_spent, c.created_at, c.risk_level
      from public.customers c order by c.created_at desc limit 6) r), '[]'::jsonb) end,
    'sources', case when v_marketing then coalesce((select jsonb_agg(r) from (
      select f.source, count(*) as orders,
             count(*) filter (where f.status in ('DELIVERED', 'PARTIALLY_DELIVERED')) as delivered,
             coalesce(sum(f.total_amount) filter (where f.status in ('DELIVERED', 'PARTIALLY_DELIVERED')), 0) as revenue
      from public.order_attribution_facts f
      where f.created_at >= v_start and f.created_at < v_end
      group by f.source order by count(*) desc limit 6) r), '[]'::jsonb) end,
    'ad_spend', case when v_marketing then (select coalesce(sum(a.cost), 0) from public.ad_spend_facts a where a.date between p_from and p_to) end
  ) into v_out;

  if v_finance then
    v_fin := public.finance_overview(p_from, p_to);
    v_fin_today := public.report_profit_loss(v_today, v_today);
    v_out := v_out || jsonb_build_object('finance', jsonb_build_object(
      'net_profit', v_fin -> 'net_profit',
      'gross_profit', v_fin -> 'gross_profit',
      'courier_fees', coalesce((v_fin ->> 'courier_charges')::numeric, 0) + coalesce((v_fin ->> 'courier_cod_fees')::numeric, 0)
                      + coalesce((v_fin ->> 'return_charges')::numeric, 0),
      'marketing_costs', v_fin -> 'marketing_costs',
      'cod_collected', v_fin -> 'cod_collected',
      'cod_receivable', v_fin -> 'cod_receivable',
      'today_profit', v_fin_today -> 'net_profit'));
  end if;
  return v_out;
end;
$$;

revoke all on function public.dashboard_command_center(date, date) from public, anon;
grant execute on function public.dashboard_command_center(date, date) to authenticated;
