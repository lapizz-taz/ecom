-- =============================================================================
-- A store order is never held back for its address.
--
-- Orders from Shopify / WooCommerce used to fail to import when the district
-- could not be read, the address was very short, or the district had no
-- delivery zone here. The store has already taken the order (and its delivery
-- charge), so it now always comes in: without a district when none can be
-- read, with the address as the customer typed it. The order carries a note
-- saying what to check, and staff choose the district before booking a courier
-- that needs one (Pathao, RedX). Checkout and staff-created orders keep their
-- checks. A valid phone number is still required: without it the order cannot
-- be confirmed or delivered.
-- =============================================================================

create or replace function pg_temp.lf(p text) returns text
language sql immutable as $$ select replace(p, E'\r', '') $$;

-- 1. Creating the order: no district / short address allowed for store imports only
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public._create_order(jsonb,public.order_source)'::regprocedure));
  v_new text := v_old;
  r record;
begin
  if position('v_store_import' in v_old) > 0 then
    return;
  end if;
  for r in select * from (values
    ($a$  v_payment_method public.payment_method := coalesce(nullif(p_payload ->> 'payment_method', ''), 'COD')::public.payment_method;
$a$, $b$  v_payment_method public.payment_method := coalesce(nullif(p_payload ->> 'payment_method', ''), 'COD')::public.payment_method;
  -- An order imported from the merchant's own store (channel_ingest_order) is taken as the store sent it.
  v_store_import boolean := p_source = 'API' and coalesce(current_setting('app.store_order_import', true), '') = 'on'
    and public.is_system_context();
$b$),
    ($a$  if length(v_address) < 5 then
$a$, $b$  if length(v_address) < 5 and not v_store_import then
$b$),
    ($a$  if v_district = '' then
$a$, $b$  if v_district = '' and not v_store_import then
$b$),
    ($a$    values (v_name, v_phone, v_email, v_address, v_area, v_city, v_district,
$a$, $b$    values (v_name, v_phone, v_email, nullif(v_address, ''), v_area, v_city, nullif(v_district, ''),
$b$),
    ($a$      address = v_address, area = v_area, city = v_city, district = v_district
$a$, $b$      address = coalesce(nullif(v_address, ''), address), area = v_area, city = v_city, district = coalesce(nullif(v_district, ''), district)
$b$),
    ($a$  if not exists (select 1 from public.customer_addresses
$a$, $b$  if v_district <> '' and length(v_address) >= 5 and not exists (select 1 from public.customer_addresses
$b$)) as t(old_text, new_text)
  loop
    if position(r.old_text in v_new) = 0 then
      raise exception 'store import without district: _create_order has changed near %', left(r.old_text, 60);
    end if;
    v_new := replace(v_new, r.old_text, r.new_text);
  end loop;
  execute v_new;
end $$;

-- 2. Pricing: a store order to a district without a delivery zone keeps the store's delivery charge
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.calculate_order_quote(jsonb,text,text,text,text,text,boolean,boolean)'::regprocedure));
  v_from text := $a$  elsif coalesce(trim(p_district), '') <> '' then
    raise exception 'VALIDATION: we do not deliver to % yet', p_district using errcode = '22023';$a$;
  v_to text := $b$  elsif coalesce(trim(p_district), '') <> '' and coalesce(current_setting('app.store_order_import', true), '') <> 'on' then
    raise exception 'VALIDATION: we do not deliver to % yet', p_district using errcode = '22023';$b$;
begin
  if position('app.store_order_import' in v_old) > 0 then
    return;
  end if;
  if position(v_from in v_old) = 0 then
    raise exception 'store import without district: calculate_order_quote has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

-- 3. Importing: an unreadable district or a short address is a note, not a failure
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.channel_ingest_order(uuid,jsonb,text)'::regprocedure));
  v_from text := $a$    if v_district is null then
      raise exception 'DISTRICT_UNKNOWN: could not tell the district from "%". Choose it and import again',
        concat_ws(', ', nullif(v_o #>> '{shipping,city}', ''), nullif(v_o #>> '{shipping,state}', '')) using errcode = '22023';
    end if;
$a$;
  v_to text := $b$    -- Never held back for the address: it comes in as the store sent it and staff check it.
    if v_district is null then
      v_district := '';
      v_warnings := v_warnings || format('District not recognised from "%s": choose it on the order before booking Pathao or RedX',
        coalesce(nullif(concat_ws(', ', nullif(v_o #>> '{shipping,city}', ''), nullif(v_o #>> '{shipping,state}', '')), ''), 'the address'));
    end if;
    if length(trim(coalesce(nullif(trim(v_fix ->> 'address'), ''), v_o #>> '{shipping,address}', ''))) < 5 then
      v_warnings := v_warnings || format('The delivery address is very short ("%s"): check it with the customer',
        trim(coalesce(nullif(trim(v_fix ->> 'address'), ''), v_o #>> '{shipping,address}', '')));
    end if;
$b$;
begin
  if position('District not recognised' in v_old) > 0 then
    return;
  end if;
  if position(v_from in v_old) = 0 then
    raise exception 'store import without district: channel_ingest_order has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

select public._tenancy_own_functions();
