-- =============================================================================
-- Approved Orders: each item says what happened to it on a partly delivered (or returned) order.
--
-- Asked for on 10 Nov 2026 ("show which one the customer received and which one came back").
-- admin_search_orders' item lines now also carry, per item:
--   * returned: received back into stock (Scan parcels → Returned, Receive return);
--   * damaged: received back damaged;
--   * expected_back: what "Partial delivery…" recorded the customer sent back (partly delivered
--     orders only), so an item shows "Coming back" before the parcel is received.
-- The list then shows Delivered / Coming back / Returned / Damaged next to each item.
--
-- admin_search_orders is patched in place (CREATE OR REPLACE keeps its owner and grants). Safe to re-run.
-- =============================================================================

create or replace function pg_temp.patch_fn(p_fn text, p_from text, p_to text)
returns void
language plpgsql as $$
declare
  v_old text := replace(pg_get_functiondef(p_fn::regprocedure), E'\r', '');
  v_hits int;
begin
  if position(p_to in v_old) > 0 then
    return; -- already patched
  end if;
  v_hits := (length(v_old) - length(replace(v_old, p_from, ''))) / length(p_from);
  if v_hits <> 1 then
    raise exception 'order list: % has changed (% matches for "%")', p_fn, v_hits, left(p_from, 60);
  end if;
  execute replace(v_old, p_from, p_to);
end $$;

-- Single-line texts only: an SQL editor may send its own line breaks, which would never match.
select pg_temp.patch_fn('public.admin_search_orders(jsonb,text,text,integer,integer)',
  $a$'quantity', l.quantity, 'image_url', l.image_url) order by l.created_at)$a$,
  $b$'quantity', l.quantity, 'image_url', l.image_url, 'returned', l.returned_quantity, 'damaged', l.damaged_quantity, 'expected_back', case when p.status = 'PARTIALLY_DELIVERED' then (select coalesce(sum(greatest(coalesce((x ->> 'quantity')::int, 0), 0)), 0) from (select h.metadata -> 'items' as items from public.order_status_history h where h.order_id = p.id and h.metadata ? 'returned_value' and jsonb_typeof(h.metadata -> 'items') = 'array' order by h.created_at desc limit 1) r, jsonb_array_elements(r.items) x where x ->> 'order_item_id' = l.id::text) else 0 end) order by l.created_at)$b$);

select public._tenancy_own_functions();
