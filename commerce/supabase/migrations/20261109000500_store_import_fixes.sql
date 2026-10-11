-- =============================================================================
-- Store order import fixes (found on a live Shopify store).
--
-- 1. Only orders still to be shipped are imported. An order the store has
--    already fulfilled (or partly fulfilled, or restocked) is recorded as
--    skipped, like a cancelled one: its goods have left, so importing it
--    would reserve stock for nothing and a cancel here would "return" goods
--    that are gone. A person can still import one by hand (import again).
--
-- 2. An order placed before the first sync was counted twice. The first sync
--    copies the store's stock, which had already subtracted that order; the
--    import adds the quantity back before reserving it (right), but the link
--    trigger then also lowered the "last sent to the store" marker as if the
--    store had just subtracted it now (wrong). The store looked one higher
--    than expected, and two-way stock "took over" that +1. With a cancel here
--    on top, 5 in stock became 7 here and was then sent to the store. The
--    marker is now left alone for such orders.
--
-- 3. Taxes and fees charged by the store are part of the order total (and of
--    the cash to collect). They were dropped, so a Shopify order of 2,203.85
--    came in as 2,099.00. Orders now carry the tax amount and include it.
-- =============================================================================

create or replace function pg_temp.lf(p text) returns text
language sql immutable as $$ select replace(p, E'\r', '') $$;
create or replace function pg_temp.lf_replace(p text, p_from text, p_to text) returns text
language sql immutable as $$ select replace(pg_temp.lf(p), pg_temp.lf(p_from), pg_temp.lf(p_to)) $$;

-- -----------------------------------------------------------------------------
-- 3a. Tax on orders, included in the total
-- -----------------------------------------------------------------------------
alter table public.orders add column if not exists tax_amount numeric(12,2) not null default 0;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'orders_tax_amount_check') then
    alter table public.orders add constraint orders_tax_amount_check check (tax_amount >= 0);
  end if;
end $$;

do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.recalculate_order_totals(uuid)'::regprocedure));
  v_new text;
begin
  if position('tax_amount' in v_old) > 0 then
    return;
  end if;
  v_new := pg_temp.lf_replace(v_old,
    'v_total := public.money(v_subtotal - v_coupon_discount - v_order.manual_discount + v_order.delivery_charge - v_delivery_discount);',
    'v_total := public.money(v_subtotal - v_coupon_discount - v_order.manual_discount + v_order.delivery_charge - v_delivery_discount + coalesce(v_order.tax_amount, 0));');
  if v_new = v_old then
    raise exception 'store import fixes: recalculate_order_totals has changed';
  end if;
  execute v_new;
end $$;

-- -----------------------------------------------------------------------------
-- 2. Orders placed before the first sync: the marker stays where it is
-- -----------------------------------------------------------------------------
create or replace function public._channel_presync_restock(p_channel public.sales_channels, p_order jsonb, p_items jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_created timestamptz;
  v_item jsonb;
  v_label text := coalesce(nullif(p_order ->> 'number', ''), p_order ->> 'external_id');
begin
  -- Read by the link trigger in the same transaction (see _orders_channel_import_trigger).
  perform set_config('app.channel_presync_order', '', true);
  if p_channel.first_sync_at is null or not coalesce((p_channel.settings ->> 'inventory_sync')::boolean, false) then
    return;
  end if;
  begin
    v_created := nullif(p_order ->> 'created_at', '')::timestamptz;
  exception when others then
    v_created := null;
  end;
  if v_created is null or v_created >= p_channel.first_sync_at then
    return;
  end if;
  perform set_config('app.channel_presync_order', 'on', true);
  for v_item in select * from jsonb_array_elements(p_items) loop
    continue when coalesce((v_item ->> 'quantity')::int, 0) <= 0;
    if exists (select 1 from public.sales_channel_variants m
               join public.product_variants v on v.id = m.variant_id
               join public.products p on p.id = v.product_id
               where m.channel_id = p_channel.id and m.variant_id = (v_item ->> 'variant_id')::uuid
                 and m.inventory_item_id is not null and p.track_inventory) then
      perform public._apply_inventory_movement((v_item ->> 'variant_id')::uuid, 'ADJUSTMENT', (v_item ->> 'quantity')::int, 0, 0,
        'CHANNEL', p_channel.id, format('Order %s from %s', v_label, p_channel.name),
        'Placed in the store before the first sync, so the stock copied from the store had already counted it', null, false);
    end if;
  end loop;
end;
$$;
revoke all on function public._channel_presync_restock(public.sales_channels, jsonb, jsonb) from public, anon, authenticated;

-- A store order lowered the store's own count when it was placed; when we
-- import it, our "last sent" marker moves down with it so that is not taken
-- for a change made in the store. Not for an order placed before the first
-- sync: the stock copied then already excluded it, so the marker is right.
create or replace function public._orders_channel_import_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.source = 'API' and new.created_at = now()
     and coalesce(current_setting('app.channel_presync_order', true), '') <> 'on' then
    update public.sales_channel_variants m set last_pushed_qty = m.last_pushed_qty - r.qty
    from (select variant_id, sum(quantity)::int as qty from public.stock_reservations
          where order_id = new.id and status = 'ACTIVE' group by variant_id) r
    where m.channel_id = new.sales_channel_id and m.variant_id = r.variant_id and m.last_pushed_qty is not null;
  end if;
  return new;
end;
$$;
revoke all on function public._orders_channel_import_trigger() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 1 + 3b. Importing: skip fulfilled orders, keep the tax
-- -----------------------------------------------------------------------------
-- The store's fulfilment state of an order: given by the store, else read from
-- the fulfilments it reports (any live one: fulfilled, or partly when the
-- store does not say all items went).
create or replace function public._channel_order_fulfillment_state(p_order jsonb)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(
    nullif(upper(trim(coalesce(p_order ->> 'fulfillment_status', ''))), ''),
    (select case when bool_or(coalesce((f ->> 'all_fulfilled')::boolean, false)) then 'FULFILLED' else 'PARTIALLY_FULFILLED' end
     from jsonb_array_elements(case when jsonb_typeof(p_order -> 'fulfillments') = 'array' then p_order -> 'fulfillments' else '[]'::jsonb end) f
     where upper(coalesce(f ->> 'status', 'SUCCESS')) not in ('CANCELLED', 'ERROR', 'FAILURE')
     having count(*) > 0))
$$;

-- Taxes and fees the customer pays on top of products and delivery: given by
-- the store, else what its total holds beyond products + delivery − discounts.
create or replace function public._channel_order_tax(p_order jsonb, p_subtotal numeric, p_shipping numeric)
returns numeric
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_total numeric := nullif(p_order ->> 'total', '')::numeric;
  v_extra numeric;
begin
  if nullif(p_order ->> 'tax_total', '') is not null then
    return public.money(greatest((p_order ->> 'tax_total')::numeric, 0));
  end if;
  if v_total is null or nullif(p_order ->> 'discount_total', '') is null then
    return 0;
  end if;
  v_extra := v_total - (p_subtotal + p_shipping - greatest((p_order ->> 'discount_total')::numeric, 0));
  return case when v_extra >= 0.01 then public.money(v_extra) else 0 end;
exception when others then
  return 0;
end;
$$;
revoke all on function public._channel_order_fulfillment_state(jsonb), public._channel_order_tax(jsonb, numeric, numeric) from public, anon, authenticated;

do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.channel_ingest_order(uuid,jsonb,text)'::regprocedure));
  v_new text;
begin
  if position('_channel_order_fulfillment_state' in v_old) > 0 then
    return;
  end if;
  v_new := pg_temp.lf_replace(v_old, $o$  v_num text;
begin
$o$, $n$  v_num text;
  v_tax numeric := 0;
begin
$n$);
  v_new := pg_temp.lf_replace(v_new, $o$    return jsonb_build_object('status', 'SKIPPED', 'import_id', v_import.id, 'error', 'cancelled');
  end if;
$o$, $n$    return jsonb_build_object('status', 'SKIPPED', 'import_id', v_import.id, 'error', 'cancelled');
  end if;
  -- Only orders still to be shipped: one the store already fulfilled has left (importing it by hand still works).
  if coalesce(public._channel_order_fulfillment_state(p_order), '') in ('FULFILLED', 'PARTIALLY_FULFILLED', 'RESTOCKED')
     and upper(coalesce(p_via, '')) <> 'RETRY' then
    update public.channel_order_imports set status = 'SKIPPED',
      error = case public._channel_order_fulfillment_state(p_order)
        when 'PARTIALLY_FULFILLED' then 'Partly fulfilled in ' || v_platform_name || ' before it was imported'
        when 'RESTOCKED' then 'Restocked in ' || v_platform_name || ' before it was imported'
        else 'Already fulfilled in ' || v_platform_name || ' before it was imported' end
    where id = v_import.id;
    return jsonb_build_object('status', 'SKIPPED', 'import_id', v_import.id, 'error', 'fulfilled');
  end if;
$n$);
  v_new := pg_temp.lf_replace(v_new, $o$    v_total := coalesce(nullif(v_o ->> 'total', '')::numeric, v_subtotal + v_shipping);
    v_discount := greatest(v_subtotal + v_shipping - v_total, 0);
$o$, $n$    v_tax := public._channel_order_tax(v_o, v_subtotal, v_shipping);
    v_total := coalesce(nullif(v_o ->> 'total', '')::numeric, v_subtotal + v_shipping + v_tax);
    v_discount := greatest(v_subtotal + v_shipping + v_tax - v_total, 0);
$n$);
  v_new := pg_temp.lf_replace(v_new, $o$    if v_total > v_subtotal + v_shipping + 0.009 then
$o$, $n$    if v_total > v_subtotal + v_shipping + v_tax + 0.009 then
$n$);
  v_new := pg_temp.lf_replace(v_new, $o$    ), 'API');
    perform set_config('app.order_number', '', true);
$o$, $n$    ), 'API');
    perform set_config('app.order_number', '', true);
    if v_tax > 0 then
      update public.orders set tax_amount = v_tax where id = v_order.id;
      v_order := public.recalculate_order_totals(v_order.id);
    end if;
$n$);
  if (length(v_new) - length(replace(v_new, 'v_tax', ''))) / length('v_tax') <> 7
     or position('_channel_order_fulfillment_state' in v_new) = 0 then
    raise exception 'store import fixes: channel_ingest_order has changed';
  end if;
  execute v_new;
end $$;

select public._tenancy_own_functions();
