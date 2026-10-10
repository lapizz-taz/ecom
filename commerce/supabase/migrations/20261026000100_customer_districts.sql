-- Customers by district (the district map) and fixing orders whose district
-- is not one of the 64 delivery districts ("unassigned").

create or replace function public._canonical_district(p_text text)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select d from jsonb_array_elements_text(coalesce(public.get_setting('delivery') -> 'districts', '[]'::jsonb)) d
  where lower(d) = lower(trim(coalesce(p_text, ''))) limit 1
$$;

-- Per district: orders, customers, delivered, returned, delivered value and order value.
create or replace function public.customer_district_stats(p_days int default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb;
begin
  perform public.require_permission('customers.view');
  with o as (
    select o.*, public._canonical_district(o.shipping_district) as district,
      coalesce(o.customer_id::text, o.customer_phone) as who
    from public.orders o
    where o.merged_into is null and o.status <> 'REJECTED_FRAUD'
      and (p_days is null or o.created_at >= now() - make_interval(days => greatest(p_days, 1)))
  ), d as (
    select district, count(*) as orders, count(distinct who) as customers,
      count(*) filter (where status in ('DELIVERED', 'PARTIALLY_DELIVERED')) as delivered,
      count(*) filter (where status = 'RETURNED') as returned,
      coalesce(sum(total_amount) filter (where status in ('DELIVERED', 'PARTIALLY_DELIVERED')), 0) as revenue,
      coalesce(sum(total_amount) filter (where status not in ('CANCELLED', 'PENDING_CANCEL')), 0) as order_value
    from o where district is not null group by district
  )
  select jsonb_build_object(
    'districts', coalesce((select jsonb_agg(jsonb_build_object('district', district, 'orders', orders, 'customers', customers,
        'delivered', delivered, 'returned', returned, 'revenue', revenue, 'order_value', order_value,
        'success_rate', case when delivered + returned > 0 then round(100.0 * delivered / (delivered + returned), 1) end)
      order by customers desc, orders desc) from d), '[]'::jsonb),
    'totals', (select jsonb_build_object('orders', count(*), 'customers', count(distinct who),
        'revenue', coalesce(sum(total_amount) filter (where status in ('DELIVERED', 'PARTIALLY_DELIVERED')), 0),
        'order_value', coalesce(sum(total_amount) filter (where status not in ('CANCELLED', 'PENDING_CANCEL')), 0),
        'unassigned_customers', count(distinct who) filter (where district is null),
        'unassigned_orders', count(*) filter (where district is null)) from o))
  into v;
  return v;
end;
$$;

-- Customers whose orders carry a district we do not recognise, newest first,
-- with the district we can read from their address (if any).
create or replace function public.customers_needing_district(p_limit int default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('customers.view');
  return coalesce((
    select jsonb_agg(x order by x ->> 'last_order_at' desc)
    from (
      select jsonb_build_object('phone', o.customer_phone, 'name', (array_agg(o.customer_name order by o.created_at desc))[1],
        'address', (array_agg(concat_ws(', ', o.shipping_address, o.shipping_area, o.shipping_city) order by o.created_at desc))[1],
        'district_text', (array_agg(o.shipping_district order by o.created_at desc))[1],
        'orders', count(*), 'last_order_at', max(o.created_at),
        'suggestion', public._bd_district(array[(array_agg(o.shipping_district order by o.created_at desc))[1],
          (array_agg(o.shipping_city order by o.created_at desc))[1], (array_agg(o.shipping_area order by o.created_at desc))[1],
          (array_agg(o.shipping_address order by o.created_at desc))[1]])) as x
      from public.orders o
      where o.merged_into is null and o.customer_phone is not null and public._canonical_district(o.shipping_district) is null
      group by o.customer_phone
      order by max(o.created_at) desc
      limit least(greatest(coalesce(p_limit, 100), 1), 500)
    ) t), '[]'::jsonb);
end;
$$;

-- Set the district for a customer's orders that have an unrecognised one (and the customer record).
create or replace function public.assign_customer_district(p_phone text, p_district text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_district text := public._canonical_district(p_district);
  v_n int;
begin
  perform public.require_permission('orders.update');
  if v_district is null then
    raise exception 'VALIDATION: choose one of the 64 districts' using errcode = '22023';
  end if;
  update public.orders set shipping_district = v_district
  where customer_phone = p_phone and public._canonical_district(shipping_district) is null;
  get diagnostics v_n = row_count;
  update public.customers set district = v_district
  where phone = p_phone and public._canonical_district(district) is null;
  perform public.log_audit('customers.district_assigned', 'customer', null, null,
    jsonb_build_object('phone', p_phone, 'district', v_district, 'orders', v_n));
  return jsonb_build_object('orders', v_n, 'district', v_district);
end;
$$;

-- Assign every unassigned customer whose address names a district.
create or replace function public.auto_assign_districts()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  v_done int := 0;
  v_orders int := 0;
  v_left int := 0;
  v_res jsonb;
begin
  perform public.require_permission('orders.update');
  for r in select x ->> 'phone' as phone, x ->> 'suggestion' as suggestion
           from jsonb_array_elements(public.customers_needing_district(500)) x loop
    if r.suggestion is not null and public._canonical_district(r.suggestion) is not null then
      v_res := public.assign_customer_district(r.phone, r.suggestion);
      v_done := v_done + 1;
      v_orders := v_orders + (v_res ->> 'orders')::int;
    else
      v_left := v_left + 1;
    end if;
  end loop;
  return jsonb_build_object('customers', v_done, 'orders', v_orders, 'left', v_left);
end;
$$;

revoke all on function public._canonical_district(text) from public, anon;
grant execute on function public._canonical_district(text) to authenticated;
revoke all on function public.customer_district_stats(int), public.customers_needing_district(int),
  public.assign_customer_district(text, text), public.auto_assign_districts() from public, anon;
grant execute on function public.customer_district_stats(int), public.customers_needing_district(int),
  public.assign_customer_district(text, text), public.auto_assign_districts() to authenticated;
