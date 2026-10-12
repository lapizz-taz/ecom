-- Super Edit: an order that has not shipped yet reaches delivery, return or loss through SHIPPED.
--
-- _order_status_path picked among equally short routes by the order rows happened to be read in, so
-- READY_TO_SHIP → DELIVERED could go through PENDING_CANCEL instead of SHIPPED and skip taking the stock out
-- (SHIPPED is where it is committed). Now, from a status before shipping to one after it, a route through
-- SHIPPED always wins, even a longer one; then the shortest; then the one with fewest detours (pending cancel,
-- lost, failed delivery) on the way; then a fixed order.
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
    cardinality(path) - cardinality(array_remove(array_remove(array_remove(path, 'PENDING_CANCEL'), 'LOST'), 'FAILED_DELIVERY')),
    array_to_string(path, ',')
  limit 1
$$;
