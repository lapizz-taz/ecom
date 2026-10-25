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
-- Both now lock their stock rows by variant id before changing any. Patched in place (CREATE OR
-- REPLACE keeps owner and grants), one self-contained block per function, every line of code written
-- as a one-line E'' string: the script is pasted into the SQL Editor by hand, and a pasted multi-line
-- string can lose its exact spaces and line breaks. Safe to re-run.
-- =============================================================================

-- 1. Bulk stock edit: every listed product's stock row, by variant, before the first change.
do $$
declare
  v_old text := replace(pg_get_functiondef('public.inventory_bulk_adjust(jsonb,text)'::regprocedure), E'\r', '');
  v_from text := E'  for v_item in select * from jsonb_array_elements(p_items) loop\n'
              || E'    v_mode := upper(coalesce(v_item ->> ''mode'', ''ADD''));';
  v_hits int;
begin
  if position('fixed lock order' in v_old) > 0 then
    return; -- already patched
  end if;
  v_hits := (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from);
  if v_hits <> 1 then
    raise exception 'staff stock lock order: inventory_bulk_adjust has changed (% matches)', v_hits;
  end if;
  execute replace(v_old, v_from,
    E'  -- Same fixed lock order as web orders (by variant), so a save and an order never wait in a circle.\n'
    || E'  perform 1 from public.inventory\n'
    || E'  where variant_id in (select (e ->> ''variant_id'')::uuid from jsonb_array_elements(p_items) e)\n'
    || E'  order by variant_id\n'
    || E'  for update;\n\n'
    || v_from);
end $$;

-- 2. Receiving a purchase order: its products' stock rows, by variant, before the first line.
do $$
declare
  v_old text := replace(pg_get_functiondef('public.receive_purchase_order(uuid,jsonb,text)'::regprocedure), E'\r', '');
  v_from text := E'  for v_item in select * from public.purchase_order_items where purchase_order_id = p_id for update loop';
  v_hits int;
begin
  if position('fixed lock order' in v_old) > 0 then
    return; -- already patched
  end if;
  v_hits := (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from);
  if v_hits <> 1 then
    raise exception 'staff stock lock order: receive_purchase_order has changed (% matches)', v_hits;
  end if;
  execute replace(v_old, v_from,
    E'  -- Same fixed lock order as web orders (by variant), so receiving and an order never wait in a circle.\n'
    || E'  perform 1 from public.inventory\n'
    || E'  where variant_id in (select variant_id from public.purchase_order_items where purchase_order_id = p_id)\n'
    || E'  order by variant_id\n'
    || E'  for update;\n\n'
    || v_from);
end $$;

select public._tenancy_own_functions();
