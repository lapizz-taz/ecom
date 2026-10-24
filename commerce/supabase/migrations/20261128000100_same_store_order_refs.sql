-- =============================================================================
-- Rows that point at an order must point at an order of the same store.
--
-- Found by the cross-store sweep (supabase/tests/db/cross-store-sweep.test.ts): four functions
-- looked the order up, but row security hides another store's order, and the check that
-- followed passed on the empty result (a status that is null is not "not in (...)"; a missing
-- order was never looked up). Store B could then save its own note, status-history entry,
-- production order or fraud check against store A's order id. Store A's rows never changed,
-- but a fraud check left that way (no on-delete rule) would make store A's store reset fail.
-- Each function now answers "order not found" for an order its caller cannot see.
-- Found by the role sweep in the same file: duplicating an order needed only orders.create, so a
-- Moderator could copy any order of the store and read its customer from the copy.
--
-- Functions are patched in place (CREATE OR REPLACE keeps owner and grants; retain_order_advance
-- is the cost-clearing wrapper from audit run 3, so its body is _raw_retain_order_advance).
-- Safe to re-run.
-- =============================================================================

create or replace function pg_temp.patch_fn(p_fn text, p_marker text, p_pairs text[])
returns void
language plpgsql as $$
declare
  v_old text := replace(pg_get_functiondef(p_fn::regprocedure), E'\r', '');
  v_new text;
  v_from text;
  v_to text;
  v_hits int;
  i int;
begin
  if position(p_marker in v_old) > 0 then
    return; -- already patched
  end if;
  v_new := v_old;
  for i in 1 .. array_length(p_pairs, 1) by 2 loop
    -- Line endings as Postgres stores them (an editor on Windows may send CRLF).
    v_from := replace(p_pairs[i], E'\r', '');
    v_to := replace(p_pairs[i + 1], E'\r', '');
    v_hits := (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from);
    if v_hits <> 1 then
      raise exception 'same-store order refs: % has changed (% matches for "%")', p_fn, v_hits, left(v_from, 60);
    end if;
    v_new := replace(v_new, v_from, v_to);
  end loop;
  execute v_new;
end $$;

select pg_temp.patch_fn('public.add_order_note(uuid, text, public.note_visibility, public.note_kind)', '-- only an order of this store', array[
$a$  perform public.require_permission('orders.update');
$a$,
$b$  perform public.require_permission('orders.update');
  -- only an order of this store (row security hides the others)
  if not exists (select 1 from public.orders where id = p_order_id) then
    raise exception 'NOT_FOUND: order not found' using errcode = 'P0002';
  end if;
$b$]);

select pg_temp.patch_fn('public._raw_retain_order_advance(uuid, text)', '-- only an order of this store', array[
$a$  select * into v_order from public.orders where id = p_order_id for update;
$a$,
$b$  select * into v_order from public.orders where id = p_order_id for update;
  if not found then -- only an order of this store (row security hides the others)
    raise exception 'NOT_FOUND: order not found' using errcode = 'P0002';
  end if;
$b$]);

select pg_temp.patch_fn('public.admin_create_production_order(uuid)', '-- only an order of this store', array[
$a$  select status into v_status from public.orders where id = p_order_id;
$a$,
$b$  select status into v_status from public.orders where id = p_order_id;
  if not found then -- only an order of this store (row security hides the others)
    raise exception 'NOT_FOUND: order not found' using errcode = 'P0002';
  end if;
$b$]);

select pg_temp.patch_fn('public.record_fraud_check(jsonb)', '-- only an order of this store', array[
$a$    raise exception 'VALIDATION: phone is required for a fraud check' using errcode = '22023';
  end if;
$a$,
$b$    raise exception 'VALIDATION: phone is required for a fraud check' using errcode = '22023';
  end if;
  -- only an order of this store (row security hides the others)
  if v_order_id is not null and not exists (select 1 from public.orders where id = v_order_id) then
    raise exception 'NOT_FOUND: order not found' using errcode = 'P0002';
  end if;
$b$]);

-- Duplicating an order copies its customer, address and lines into a new order, and answers with
-- them: it needs the right to see orders, not only to create them (a Moderator may create orders
-- from chats but sees no order or customer).
select pg_temp.patch_fn('public._raw_admin_duplicate_order(uuid)', '-- copying an order shows it', array[
$a$  perform public.require_permission('orders.create');
$a$,
$b$  perform public.require_permission('orders.create');
  perform public.require_permission('orders.view'); -- copying an order shows it
$b$]);

select public._tenancy_own_functions();
