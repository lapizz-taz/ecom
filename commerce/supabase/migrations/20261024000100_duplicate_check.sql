-- "Check duplicates" on Approved Orders: customers (same phone) with more than
-- one approved order in the chosen stages, newest group first. A group where
-- the same product appears in two or more orders is marked same_items (the
-- likely double order). Read-only; staff then decide what to cancel.
create or replace function public.admin_duplicate_orders(p_stages text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  perform public.require_permission('orders.view');
  if coalesce(array_length(p_stages, 1), 0) = 0 then
    raise exception 'VALIDATION: choose at least one stage' using errcode = '22023';
  end if;
  with o as (
    select o.id, o.order_number, o.customer_phone, o.customer_name, o.shipping_district, o.total_amount, o.created_at, o.status,
      public.order_stage(o.status, o.confirmed_at) as stage
    from public.orders o
    where o.confirmed_at is not null and o.merged_into is null and o.customer_phone is not null
      and public.order_stage(o.status, o.confirmed_at) = any(p_stages)
  ), dup as (
    select customer_phone from o group by customer_phone having count(*) > 1
  ), rows as (
    select o.*,
      (select string_agg(i.product_name || coalesce(' · ' || nullif(i.variant_title, ''), '') || ' ×' || i.quantity, ', ' order by i.product_name)
       from public.order_items i where i.order_id = o.id) as items
    from o join dup using (customer_phone)
  ), g as (
    select r.customer_phone, count(*) as n, max(r.created_at) as last_at, min(r.created_at) as first_at,
      (array_agg(r.customer_name order by r.created_at desc))[1] as name,
      exists (select 1 from public.order_items i join rows r2 on r2.id = i.order_id
              where r2.customer_phone = r.customer_phone and i.variant_id is not null
              group by i.variant_id having count(distinct i.order_id) > 1) as same_items,
      jsonb_agg(jsonb_build_object('id', r.id, 'order_number', r.order_number, 'stage', r.stage, 'status', r.status,
        'total', r.total_amount, 'created_at', r.created_at, 'district', r.shipping_district, 'items', r.items) order by r.created_at) as orders
    from rows r group by r.customer_phone
  )
  select jsonb_build_object(
    'groups', coalesce(jsonb_agg(jsonb_build_object('phone', customer_phone, 'name', name, 'count', n, 'same_items', same_items,
      'first_at', first_at, 'last_at', last_at, 'orders', orders) order by same_items desc, last_at desc), '[]'::jsonb),
    'orders', coalesce(sum(n), 0))
  into v_result
  from (select * from g order by same_items desc, last_at desc limit 300) g;
  return v_result;
end;
$$;
revoke all on function public.admin_duplicate_orders(text[]) from public, anon;
grant execute on function public.admin_duplicate_orders(text[]) to authenticated;
