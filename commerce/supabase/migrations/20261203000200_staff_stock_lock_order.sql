-- =============================================================================
-- Staff stock saves lock stock rows in the same fixed order as web orders.
--
-- Found by the round-4 audit (staff-stock-lock-order.test.ts). Migration 20261109002400 made every
-- order path lock the stock rows it needs by variant id first. Two staff saves that touch many
-- products still locked them one by one in the order they were listed: a bulk stock edit (up to
-- 1,000 products, e.g. after a stock count) and receiving a purchase order. A save listing product B
-- before product A, at the same moment as a web order for A and B, could hold B while the order held
-- A, each waiting for the other; Postgres then aborts one of them ("deadlock detected"), either the
-- shopper's order or the whole stock save.
--
-- Both now lock their stock rows by variant id before changing any. Patched in place, like
-- 20261109002400 (CREATE OR REPLACE keeps owner and grants). Safe to re-run.
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
    raise exception 'staff stock lock order: % has changed (% matches for "%")', p_fn, v_hits, left(p_from, 60);
  end if;
  execute replace(v_old, p_from, p_to);
end $$;

-- 1. Bulk stock edit: every listed product's stock row, by variant, before the first change.
select pg_temp.patch_fn('public.inventory_bulk_adjust(jsonb,text)', 'fixed lock order',
$a$  for v_item in select * from jsonb_array_elements(p_items) loop
    v_mode := upper(coalesce(v_item ->> 'mode', 'ADD'));$a$,
$b$  -- Same fixed lock order as web orders (by variant), so a save and an order never wait in a circle.
  perform 1 from public.inventory
  where variant_id in (select (e ->> 'variant_id')::uuid from jsonb_array_elements(p_items) e)
  order by variant_id
  for update;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_mode := upper(coalesce(v_item ->> 'mode', 'ADD'));$b$);

-- 2. Receiving a purchase order: its products' stock rows, by variant, before the first line.
select pg_temp.patch_fn('public.receive_purchase_order(uuid,jsonb,text)', 'fixed lock order',
$a$  for v_item in select * from public.purchase_order_items where purchase_order_id = p_id for update loop$a$,
$b$  -- Same fixed lock order as web orders (by variant), so receiving and an order never wait in a circle.
  perform 1 from public.inventory
  where variant_id in (select variant_id from public.purchase_order_items where purchase_order_id = p_id)
  order by variant_id
  for update;

  for v_item in select * from public.purchase_order_items where purchase_order_id = p_id for update loop$b$);

select public._tenancy_own_functions();
