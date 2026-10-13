-- =============================================================================
-- Concurrent web orders could deadlock.
--
-- Order creation reserved stock line by line in cart order, so two carts holding
-- the same products in opposite order locked the same stock rows in opposite
-- order, and Postgres aborted one of them ("deadlock detected"): a customer's
-- order failed. Found by the load test (scripts/load-test.mjs): 20 of 139 orders
-- failed in 10 seconds when every cart held the same two products.
--
-- Every function that moves stock for several lines of one order now locks the
-- stock rows it needs in one fixed order (by variant id) before touching them.
-- The functions are patched in place (their current definitions carry earlier
-- patches, e.g. store imports without a district), so nothing else changes;
-- CREATE OR REPLACE keeps each function's owner and grants. Safe to re-run.
-- =============================================================================

create or replace function pg_temp.patch_fn(p_fn text, p_marker text, p_from text, p_to text)
returns void
language plpgsql as $$
declare
  v_old text := replace(pg_get_functiondef(p_fn::regprocedure), E'\r', '');
  v_hits int;
begin
  if position(p_marker in v_old) > 0 then
    return; -- already patched
  end if;
  v_hits := (length(v_old) - length(replace(v_old, p_from, ''))) / length(p_from);
  if v_hits <> 1 then
    raise exception 'stock lock order: % has changed (% matches for "%")', p_fn, v_hits, left(p_from, 60);
  end if;
  execute replace(v_old, p_from, p_to);
end $$;

-- 1. Creating an order (storefront, staff, store imports): lock its stock rows by variant first.
select pg_temp.patch_fn('public._create_order(jsonb,public.order_source)', 'fixed lock order',
$a$  for v_line in select * from jsonb_array_elements(v_quote -> 'lines') loop
    insert into public.order_items($a$,
$b$  -- Lock every stock row this order needs in a fixed lock order (by variant) before reserving,
  -- so two orders for the same products never wait on each other in a circle.
  perform 1 from public.inventory
  where variant_id in (select (l ->> 'variant_id')::uuid from jsonb_array_elements(v_quote -> 'lines') l
                       where (l ->> 'track_inventory')::boolean)
  order by variant_id
  for update;

  for v_line in select * from jsonb_array_elements(v_quote -> 'lines') loop
    insert into public.order_items($b$);

-- 2. Editing an order's items: the old and the new lines' stock rows, same order.
select pg_temp.patch_fn('public.admin_set_order_items(uuid,jsonb)', 'fixed lock order',
$a$  perform public._release_order_stock(p_order_id, 'Released: order items edited');$a$,
$b$  -- Same fixed lock order as order creation: old and new lines' stock rows, by variant.
  perform 1 from public.inventory
  where variant_id in (select (l ->> 'variant_id')::uuid from jsonb_array_elements(v_quote -> 'lines') l
                       where (l ->> 'track_inventory')::boolean
                       union
                       select variant_id from public.order_items where order_id = p_order_id and track_inventory)
  order by variant_id
  for update;

  perform public._release_order_stock(p_order_id, 'Released: order items edited');$b$);

-- 3. Shipping (stock leaves) and releasing reservations: walk the lines by variant.
select pg_temp.patch_fn('public._commit_order_stock(uuid)', 'order by variant_id',
$a$  for v_res in select * from public.stock_reservations where order_id = p_order_id and status = 'ACTIVE' for update loop$a$,
$b$  for v_res in select * from public.stock_reservations where order_id = p_order_id and status = 'ACTIVE'
                 order by variant_id, id for update loop$b$);

select pg_temp.patch_fn('public._release_order_stock(uuid,text)', 'order by variant_id',
$a$  for v_res in select * from public.stock_reservations where order_id = p_order_id and status = 'ACTIVE' for update loop$a$,
$b$  for v_res in select * from public.stock_reservations where order_id = p_order_id and status = 'ACTIVE'
                 order by variant_id, id for update loop$b$);

-- 4. Returns coming back to stock: lock the order's stock rows by variant first.
select pg_temp.patch_fn('public._return_order_stock(uuid,jsonb,text)', 'fixed lock order',
$a$    return 0; -- nothing left the warehouse; reservations are released instead
  end if;
$a$,
$b$    return 0; -- nothing left the warehouse; reservations are released instead
  end if;

  -- Same fixed lock order (by variant) as order creation.
  perform 1 from public.inventory
  where variant_id in (select variant_id from public.order_items where order_id = p_order_id and track_inventory)
  order by variant_id
  for update;
$b$);
