-- =============================================================================
-- Courier statements: paid returns, parcels our records have not caught up with, deleting a wrong upload.
--
-- Found on 30 Oct 2026 while checking that a Pathao statement proves Pathao paid the right amount:
--   * A returned parcel where the customer paid the delivery charge at the door was flagged
--     ("Collected 80, expected 0") and pushed the verdict over by that amount. Now the cash the courier
--     reported on its update is expected, else the statement's own figure up to the order's delivery charge.
--   * Once paid, that cash sat on the returned order as money to refund ("Refund it or keep it"), and
--     Profit & loss left it out. Now it is kept as income when the courier pays it out, as long as the
--     order held no other money (an advance stays the staff's call).
--   * A parcel Pathao delivered while our records still show it on the way was expected to bring ৳0, so
--     the verdict said Pathao paid more. Now the whole COD is expected when the courier collected more
--     than the delivery charge (a smaller amount is a paid return); the "still on the way" flag stays.
--   * A statement uploaded by mistake (wrong courier or columns) could not be removed: its number was
--     refused again and its parcels showed as already billed. Now it can be deleted until it is verified.
--
-- Functions that change in a line are patched in place (CREATE OR REPLACE keeps each one's owner and
-- grants). Safe to re-run.
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
    raise exception 'courier statement checks: % has changed (% matches for "%")', p_fn, v_hits, left(p_from, 60);
  end if;
  execute replace(v_old, p_from, p_to);
end $$;

-- 1. What each parcel should have brought in ---------------------------------------------------------------
-- Single-line texts only: an SQL editor may send its own line breaks, which would never match.
select pg_temp.patch_fn('public.import_courier_invoice(jsonb)',
  $a$      v_exp_cod := case when v_ship.status in ('DELIVERED', 'PARTIALLY_DELIVERED') then v_order.cod_amount else 0 end;$a$,
  $b$      v_exp_cod := case when v_ship.status in ('DELIVERED', 'PARTIALLY_DELIVERED') then v_order.cod_amount when v_ship.status in ('FAILED', 'RETURNING', 'RETURNED') or v_order.status in ('FAILED_DELIVERY', 'RETURNING', 'RETURNED') then coalesce(case when v_ship.collected_amount > 0 and v_ship.collected_amount < v_order.total_amount then v_ship.collected_amount end, case when v_cod > 0 and v_cod <= v_order.delivery_charge then v_cod end, 0) when v_ship.status = 'CANCELLED' or v_order.status in ('CANCELLED', 'REJECTED_FRAUD', 'LOST') then 0 when v_cod > v_order.delivery_charge then v_order.cod_amount when v_cod > 0 then v_cod else 0 end;$b$);

-- 2. Cash paid at the door on a returned parcel is kept as income when the courier pays it out -------------
select pg_temp.patch_fn('public._settle_invoice_cod(uuid)',
  $a$      update public.shipments set cod_collected = cod_collected + v_amount, cod_collected_at = now() where id = l.shipment_id;$a$,
  $b$      update public.shipments set cod_collected = cod_collected + v_amount, cod_collected_at = now() where id = l.shipment_id; if v_order.status in ('FAILED_DELIVERY', 'RETURNING', 'RETURNED') and v_order.delivered_at is null and v_order.advance_resolution is null and v_order.amount_paid <= 0 then perform public._post_finance('INCOME', 'RETAINED_ADVANCES', v_amount, (now() at time zone public.store_timezone())::date, false, l.order_id, v_order.customer_id, null, v_order.order_number, format('Paid at the door on a returned parcel (%s), kept', v_courier), 'order:' || l.order_id || ':retained_advance', null); update public.orders set advance_resolution = 'RETAINED' where id = l.order_id; perform public._order_log(l.order_id, 'ADVANCE_RETAINED', format('%s paid at the door on the returned parcel, kept as income', v_amount)); end if;$b$);

-- 3. Deleting a statement uploaded by mistake ---------------------------------------------------------------
-- Until it is verified nothing else depends on it: its lines go with it, and its parcels can be billed again.
create or replace function public.delete_courier_invoice(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inv public.courier_invoices;
begin
  perform public.require_permission('couriers.manage');
  select * into v_inv from public.courier_invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'NOT_FOUND: statement not found' using errcode = 'P0002';
  end if;
  if v_inv.status in ('VERIFIED', 'PAID') or v_inv.charges_applied_at is not null then
    raise exception 'VALIDATION: a verified or paid statement cannot be deleted' using errcode = '22023';
  end if;
  delete from public.courier_invoices where id = p_invoice_id;
  perform public.log_audit('courier_invoice.deleted', 'courier_invoice', p_invoice_id::text,
    jsonb_build_object('invoice_number', v_inv.invoice_number, 'status', v_inv.status, 'lines', v_inv.line_count,
      'payout_reported', v_inv.payout_reported, 'file_name', v_inv.file_name), null, null);
end;
$$;
revoke all on function public.delete_courier_invoice(uuid) from public, anon;
grant execute on function public.delete_courier_invoice(uuid) to authenticated, service_role;

select public._tenancy_own_functions();
