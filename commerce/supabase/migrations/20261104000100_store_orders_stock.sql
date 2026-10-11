-- =============================================================================
-- Store orders and stock.
--
-- * An order placed in Shopify or WooCommerce is already sold, so importing it
--   never fails because stock here is short. Stock may go below zero; the
--   import then carries a warning naming the product, so the count gets fixed.
-- * The first sync copies the store's stock. The store had already subtracted
--   orders placed before that moment, so importing one of them adds its
--   quantity back before reserving it (the sale is counted once, not twice).
-- * Products created from store items follow the store: an item whose stock
--   the store does not count is created without stock tracking here, so its
--   orders are never held up by a zero that means "not counted".
-- =============================================================================

-- Patches below compare and rewrite existing function text. Line endings are
-- normalized first, so they also apply when this file is pasted into an editor
-- that sends Windows line endings.
create or replace function pg_temp.lf(p text) returns text
language sql immutable as $$ select replace(p, E'\r', '') $$;
create or replace function pg_temp.lf_replace(p text, p_from text, p_to text) returns text
language sql immutable as $$ select replace(pg_temp.lf(p), pg_temp.lf(p_from), pg_temp.lf(p_to)) $$;

-- -----------------------------------------------------------------------------
-- 1. Overselling is allowed while a store order is being imported
-- -----------------------------------------------------------------------------
create or replace function public.allow_overselling()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(current_setting('app.store_order_import', true), '') = 'on'
      or coalesce(public.setting_bool('inventory', array['allow_overselling'], false), false)
$$;

-- -----------------------------------------------------------------------------
-- 2. Orders placed before the first sync: the store's stock already counted them
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

-- Products of an order whose stock here went below zero, one warning each.
create or replace function public._order_stock_shortfalls(p_order_id uuid)
returns text[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(format('%s: stock here is now %s. The store had already sold it, so the order was imported anyway; add stock or correct the count',
    concat_ws(' — ', p.name, nullif(v.title, 'Default')), i.available) order by p.name), '{}')
  from (select distinct variant_id from public.order_items where order_id = p_order_id and track_inventory) oi
  join public.inventory i on i.variant_id = oi.variant_id
  join public.product_variants v on v.id = oi.variant_id
  join public.products p on p.id = v.product_id
  where i.available < 0
$$;
revoke all on function public._order_stock_shortfalls(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. Importing a store order: never held up by stock here
-- -----------------------------------------------------------------------------
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.channel_ingest_order(uuid,jsonb,text)'::regprocedure));
  v_new text;
begin
  v_new := pg_temp.lf_replace(v_old, $o$    perform set_config('app.order_number', coalesce(v_num, ''), true);
$o$, $n$    perform set_config('app.order_number', coalesce(v_num, ''), true);
    perform set_config('app.store_order_import', 'on', true);
    perform public._channel_presync_restock(v_channel, v_o, v_items);
$n$);
  v_new := pg_temp.lf_replace(v_new, $o$    update public.orders set sales_channel_id = p_channel_id, external_order_id = v_ext, external_order_number = v_o ->> 'number'
$o$, $n$    perform set_config('app.store_order_import', '', true);
    v_warnings := v_warnings || public._order_stock_shortfalls(v_order.id);
    update public.orders set sales_channel_id = p_channel_id, external_order_id = v_ext, external_order_number = v_o ->> 'number'
$n$);
  v_new := pg_temp.lf_replace(v_new, $o$    v_error := regexp_replace(sqlerrm, '^[A-Z_]+: ', '');
$o$, $n$    perform set_config('app.store_order_import', '', true);
    v_error := regexp_replace(sqlerrm, '^[A-Z_]+: ', '');
$n$);
  if (length(v_new) - length(replace(v_new, 'app.store_order_import', ''))) / length('app.store_order_import') <> 3 then
    raise exception 'store orders: channel_ingest_order has changed';
  end if;
  execute v_new;
end $$;

-- -----------------------------------------------------------------------------
-- 4. Products made from store items count stock only if the store does
-- -----------------------------------------------------------------------------
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public._channel_catalog_adopt(uuid,text[],boolean,boolean,text)'::regprocedure));
  v_new text;
begin
  v_new := pg_temp.lf_replace(v_old, $o$            true, (select array_agg(distinct t) from unnest(array[lower(v_c.platform::text)] || v_first.tags$o$,
    $n$            exists (select 1 from public.channel_catalog_items x where x.channel_id = p_channel_id and x.external_product_id = v_pid
                      and x.removed_at is null and x.tracked),
            (select array_agg(distinct t) from unnest(array[lower(v_c.platform::text)] || v_first.tags$n$);
  if v_new = v_old then
    raise exception 'store orders: _channel_catalog_adopt has changed';
  end if;
  execute v_new;
end $$;

select public._tenancy_own_functions();
