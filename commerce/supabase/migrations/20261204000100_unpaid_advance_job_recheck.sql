-- =============================================================================
-- The job that cancels orders whose advance never came does not cancel one that was just paid.
--
-- Found by the round-4 audit (payment-races.test.ts). expire_unpaid_advance_orders (every 15 minutes)
-- read its list of overdue, unpaid ADVANCE_REQUIRED orders, then cancelled each one without looking at
-- it again. A ৳55 payment confirmed between the two (the gateway's notice while the job runs) had
-- already moved the order to CONFIRMED with the advance paid; the job then cancelled it anyway
-- (CONFIRMED -> CANCELLED is an allowed move), after the shopper was told the advance was received.
--
-- Each order is now locked and checked again (still waiting, overdue and unpaid) before it is
-- cancelled; an order paid in the meantime is left alone. Patched in place (CREATE OR REPLACE keeps
-- owner and grants), every line of code written as a one-line E'' string so the script still matches
-- when it is pasted into the SQL Editor by hand. Safe to re-run.
-- =============================================================================

do $$
declare
  v_old text := replace(pg_get_functiondef('public.expire_unpaid_advance_orders()'::regprocedure), E'\r', '');
  v_from text := E'  loop\n    perform public._transition_order(v_id, ''CANCELLED'', ''Advance payment not received in time'');';
  v_hits int;
begin
  if position('look again' in v_old) > 0 then
    return; -- already patched
  end if;
  v_hits := (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from);
  if v_hits <> 1 then
    raise exception 'unpaid advance job: expire_unpaid_advance_orders has changed (% matches)', v_hits;
  end if;
  execute replace(v_old, v_from,
    E'  loop\n'
    || E'    -- The list was read before any lock: look again with the order locked, since a payment may have\n'
    || E'    -- just been confirmed (the order is then confirmed and paid, and must not be cancelled).\n'
    || E'    perform 1 from public.orders\n'
    || E'    where id = v_id and status = ''ADVANCE_REQUIRED'' and advance_due_at < now() and amount_paid < advance_required\n'
    || E'      and not exists (select 1 from public.payments p where p.order_id = v_id and p.status = ''REQUIRES_VERIFICATION'')\n'
    || E'    for update;\n'
    || E'    continue when not found;\n'
    || E'    perform public._transition_order(v_id, ''CANCELLED'', ''Advance payment not received in time'');');
end $$;

select public._tenancy_own_functions();
