-- =============================================================================
-- Orders Dashboard, "waiting too long" tiles: count from when the order got there.
--
-- "RTS over 1 day" and "Return open over 7 days" measured the time since the order's last change
-- (orders.updated_at). Any later change restarted that clock: a note, a tag, a courier status
-- update, or a fresh courier check on the customer (it touches all their open orders). A parcel
-- stuck at RTS for days could therefore show 0.
--
-- Now both count from the order's status history, which every status change writes:
--   * RTS over 1 day: since the order last became Ready to ship.
--   * Return open over 7 days: since the return started, its last move into Failed delivery,
--     Return requested or Returning from any other status. Moving between those three does not
--     restart it (Failed delivery 9 days ago, Returning since yesterday: open 9 days).
-- An order with no such history entry keeps the old measure, its last change.
--
-- orders_dashboard is patched in place (CREATE OR REPLACE keeps its owner and grants). Safe to re-run.
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
    raise exception 'orders dashboard waiting tiles: % has changed (% matches for "%")', p_fn, v_hits, left(p_from, 60);
  end if;
  execute replace(v_old, p_from, p_to);
end $$;

-- Single-line texts only: an SQL editor may send its own line breaks, which would never match.
select pg_temp.patch_fn('public.orders_dashboard(date,date)',
  $a$'rts_over_1d', (select count(*) from public.orders o where o.status = 'READY_TO_SHIP' and o.updated_at < now() - interval '1 day'),$a$,
  $b$'rts_over_1d', (select count(*) from public.orders o where o.status = 'READY_TO_SHIP' and coalesce((select max(h.created_at) from public.order_status_history h where h.order_id = o.id and h.to_status = 'READY_TO_SHIP'), o.updated_at) < now() - interval '1 day'),$b$);

select pg_temp.patch_fn('public.orders_dashboard(date,date)',
  $a$'return_over_7d', (select count(*) from public.orders o where o.status in ('FAILED_DELIVERY', 'RETURN_REQUESTED', 'RETURNING') and o.updated_at < now() - interval '7 days'),$a$,
  $b$'return_over_7d', (select count(*) from public.orders o where o.status in ('FAILED_DELIVERY', 'RETURN_REQUESTED', 'RETURNING') and coalesce((select max(h.created_at) from public.order_status_history h where h.order_id = o.id and h.to_status in ('FAILED_DELIVERY', 'RETURN_REQUESTED', 'RETURNING') and (h.from_status is null or h.from_status not in ('FAILED_DELIVERY', 'RETURN_REQUESTED', 'RETURNING'))), o.updated_at) < now() - interval '7 days'),$b$);

select public._tenancy_own_functions();
