-- =============================================================================
-- Two orders for a new phone number at the same moment are both placed.
--
-- Found by the round-4 audit: every order (checkout, staff, Shopify and WooCommerce imports, the
-- external API) goes through _create_order, which looks the customer up by phone and creates the
-- record when there is none. Two orders for a phone the store has never seen, at the same moment
-- (two tabs, or two orders of a store's webhook burst), both found no customer and both created
-- one; the second failed on the unique phone ("duplicate key value violates unique constraint
-- customers_phone_key") and its order was not placed.
--
-- Now an order for an unknown phone takes a lock on (store, phone) and looks again: the second
-- order waits for the first one to finish and then carries on with the customer it created.
-- Orders for a known customer were already serialized by the customer row lock.
--
-- _create_order is patched in place (CREATE OR REPLACE keeps owner and grants). Safe to re-run.
-- =============================================================================

do $$
declare
  v_old text := replace(pg_get_functiondef('public._create_order(jsonb, public.order_source)'::regprocedure), E'\r', '');
  v_from text := E'  select * into v_customer from public.customers where phone = v_phone for update;\n  if not found then\n    insert into public.customers';
  v_hits int;
begin
  if position('customer-phone:' in v_old) > 0 then
    return; -- already patched
  end if;
  v_hits := (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from);
  if v_hits <> 1 then
    raise exception 'new customer orders: _create_order has changed (% matches)', v_hits;
  end if;
  execute replace(v_old, v_from,
    E'  select * into v_customer from public.customers where phone = v_phone for update;\n'
    || E'  if not found then\n'
    || E'    -- A phone this store has not seen: another order for it may be creating the customer right\n'
    || E'    -- now (two tabs, a webhook burst). Wait for that order, then look again.\n'
    || E'    perform pg_advisory_xact_lock(hashtextextended(''customer-phone:'' || coalesce(public.current_merchant_id()::text, '''') || '':'' || v_phone, 0));\n'
    || E'    select * into v_customer from public.customers where phone = v_phone for update;\n'
    || E'  end if;\n'
    || E'  if not found then\n'
    || E'    insert into public.customers');
end $$;

select public._tenancy_own_functions();
