-- Super Edit walks an order along the shortest allowed route. When two routes tie, the
-- route finder picked the alphabetically first one, which from CONFIRMED meant going
-- through PRE_ORDER instead of PROCESSING: PRE_ORDER means "waiting for stock" and has
-- no side effects, while PROCESSING is the step that queues production for made-to-order
-- goods. A plain order must never be walked through PRE_ORDER on its way to the courier,
-- so PRE_ORDER now counts as a detour, like PENDING_CANCEL, LOST and FAILED_DELIVERY.

create or replace function public._order_status_path(p_from public.order_status, p_to public.order_status)
returns public.order_status[]
language sql
stable
set search_path = public, pg_temp
as $$
  with recursive walk(status, path) as (
    select p_from, array[]::public.order_status[]
    union all
    select t.to_status, w.path || t.to_status
    from walk w
    join public.order_status_transitions t on t.from_status = w.status
    where cardinality(w.path) < 8 and not (t.to_status = any(w.path)) and t.to_status <> p_from
  )
  select path from walk where status = p_to and cardinality(path) > 0
  order by
    case when p_from not in ('SHIPPED', 'PENDING_CANCEL', 'DELIVERED', 'PARTIALLY_DELIVERED', 'FAILED_DELIVERY',
                             'RETURN_REQUESTED', 'RETURNING', 'RETURNED', 'LOST')
          and p_to in ('DELIVERED', 'PARTIALLY_DELIVERED', 'FAILED_DELIVERY', 'RETURN_REQUESTED', 'RETURNING', 'RETURNED', 'LOST')
          and not ('SHIPPED' = any(path)) then 1 else 0 end,
    cardinality(path),
    cardinality(path) - cardinality(array_remove(array_remove(array_remove(array_remove(path, 'PENDING_CANCEL'), 'LOST'), 'FAILED_DELIVERY'), 'PRE_ORDER')),
    array_to_string(path, ',')
  limit 1
$$;

select public._tenancy_own_functions();
