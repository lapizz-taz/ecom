-- No separate "Pending cancel" tab: an approved order whose cancel is waiting on the
-- courier (status PENDING_CANCEL) is listed under Cancelled, where the row still shows
-- "Cancelling" until the courier confirms. The status itself and its rules are unchanged.
create or replace function public.order_stage(p_status public.order_status, p_confirmed_at timestamptz)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_confirmed_at is null then 'WEB'
    when p_status in ('CONFIRMED', 'PROCESSING', 'PRODUCTION', 'QUALITY_CHECK', 'PACKING') then 'PENDING'
    when p_status = 'PRE_ORDER' then 'PRE_ORDER'
    when p_status = 'READY_TO_SHIP' then 'RTS'
    when p_status = 'SHIPPED' then 'SHIPPED'
    when p_status = 'DELIVERED' then 'DELIVERED'
    when p_status = 'PARTIALLY_DELIVERED' then 'PARTIAL'
    when p_status in ('FAILED_DELIVERY', 'RETURN_REQUESTED', 'RETURNING') then 'RETURN_PENDING'
    when p_status = 'RETURNED' then 'RETURNED'
    when p_status = 'PENDING_CANCEL' then 'CANCELLED'
    when p_status = 'LOST' then 'LOST'
    else 'CANCELLED'
  end
$$;

-- Dashboard: "pending cancel" per courier now counts the status directly (the stage is gone).
create or replace function public.orders_dashboard(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz text := public.store_timezone();
  v_start timestamptz := public._ts_from(p_from);
  v_end timestamptz := public._ts_from(p_to + 1);
begin
  perform public.require_permission('orders.view');
  return jsonb_build_object(
    'daily', coalesce((select jsonb_agg(d order by d.day) from (
      select g::date as day,
        (select count(*) from public.orders where (confirmed_at at time zone v_tz)::date = g::date) as approved,
        (select count(*) from public.orders where (shipped_at at time zone v_tz)::date = g::date) as shipped,
        (select count(*) from public.orders where (delivered_at at time zone v_tz)::date = g::date) as delivered,
        (select count(*) from public.orders where (returned_at at time zone v_tz)::date = g::date) as returned,
        (select count(*) from public.orders where (cancelled_at at time zone v_tz)::date = g::date and confirmed_at is not null) as cancelled
      from generate_series(p_from, p_to, interval '1 day') g) d), '[]'::jsonb),
    'totals', (select jsonb_build_object(
        'approved', count(*) filter (where confirmed_at >= v_start and confirmed_at < v_end),
        'shipped', count(*) filter (where shipped_at >= v_start and shipped_at < v_end),
        'delivered', count(*) filter (where delivered_at >= v_start and delivered_at < v_end),
        'returned', count(*) filter (where returned_at >= v_start and returned_at < v_end),
        'cancelled', count(*) filter (where cancelled_at >= v_start and cancelled_at < v_end and confirmed_at is not null),
        'approved_value', coalesce(sum(total_amount) filter (where confirmed_at >= v_start and confirmed_at < v_end), 0),
        'delivered_value', coalesce(sum(total_amount) filter (where delivered_at >= v_start and delivered_at < v_end), 0))
      from public.orders),
    -- Open approved orders by courier and stage, right now.
    'by_courier', coalesce((select jsonb_agg(c order by c.total desc) from (
      select coalesce(cr.name, 'Not booked') as courier, cr.id as courier_id, count(*) as total,
        count(*) filter (where public.order_stage(o.status, o.confirmed_at) = 'PENDING') as pending,
        count(*) filter (where public.order_stage(o.status, o.confirmed_at) = 'RTS') as rts,
        count(*) filter (where public.order_stage(o.status, o.confirmed_at) = 'SHIPPED') as shipped,
        count(*) filter (where public.order_stage(o.status, o.confirmed_at) in ('PENDING_RETURN', 'RETURN_PENDING')) as pending_return,
        count(*) filter (where o.status = 'PENDING_CANCEL') as pending_cancel,
        coalesce(sum(o.total_amount - o.amount_paid), 0) as cod_open
      from public.orders o
      left join public.shipments s on s.order_id = o.id and s.is_active
      left join public.couriers cr on cr.id = s.courier_id
      where o.confirmed_at is not null
        and (public.order_stage(o.status, o.confirmed_at) in ('PENDING', 'RTS', 'SHIPPED', 'RETURN_PENDING') or o.status = 'PENDING_CANCEL')
      group by cr.id, cr.name) c), '[]'::jsonb),
    -- Orders that have waited too long at a stage.
    'aging', jsonb_build_object(
      'pending_over_2d', (select count(*) from public.orders o where public.order_stage(o.status, o.confirmed_at) = 'PENDING' and o.confirmed_at < now() - interval '2 days'),
      'rts_over_1d', (select count(*) from public.orders o where o.status = 'READY_TO_SHIP' and o.updated_at < now() - interval '1 day'),
      'shipped_over_7d', (select count(*) from public.orders o where o.status = 'SHIPPED' and o.shipped_at < now() - interval '7 days'),
      'return_over_7d', (select count(*) from public.orders o where o.status in ('FAILED_DELIVERY', 'RETURN_REQUESTED', 'RETURNING') and o.updated_at < now() - interval '7 days'),
      'unbooked', (select count(*) from public.orders o where o.confirmed_at is not null and o.status in ('CONFIRMED', 'PROCESSING', 'PACKING', 'READY_TO_SHIP')
                   and not exists (select 1 from public.shipments s where s.order_id = o.id and s.is_active))),
    'by_agent', coalesce((select jsonb_agg(a order by a.approved desc) from (
      select coalesce(nullif(p.full_name, ''), p.email) as name, count(*) as approved, coalesce(sum(o.total_amount), 0) as value
      from public.orders o join public.profiles p on p.id = o.approved_by
      where o.confirmed_at >= v_start and o.confirmed_at < v_end
      group by p.id, p.full_name, p.email limit 20) a), '[]'::jsonb)
  );
end;
$$;
