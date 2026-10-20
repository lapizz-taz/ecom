-- Products an imported order created follow the store's stock.
--
-- An order can come in before its product is imported (often right after connecting): the
-- order import then makes a draft product that counts no stock (_channel_variant), since the
-- store keeps the stock. The first sync skipped such a product (it counts no stock), so it
-- stayed at 0 here and "Not synced yet" while the store had stock.
--
-- Now, once the store's stock syncs here (after the first sync) and the store counts the item,
-- such a product takes the store's tracking and its number, like an imported product: at the
-- first sync, or when its store product is read later (product webhooks, the hourly sync).
-- Never in the middle of the order import itself: the store's number already left out that
-- order, and the order's lines stay as made (counting no stock), so nothing is counted twice.
-- Only products no one made or touched: made by an order import, counting no stock, with no
-- stock movement ever, and every variant linked to this store.

create or replace function public._channel_adopt_placeholders(p_channel_id uuid, p_external_variant_id text default null)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_c public.sales_channels;
  v_store text;
  v_loc text;
  v_products uuid[];
  v_product uuid;
  v_r record;
  v_n int := 0;
begin
  select * into v_c from public.sales_channels where id = p_channel_id;
  if not found or v_c.status <> 'CONNECTED' or v_c.first_sync_at is null or not public._channel_opt(v_c, 'inventory_sync', false) then
    return 0;
  end if;
  v_loc := nullif(v_c.settings ->> 'location_id', '');
  if v_loc is null then
    return 0;
  end if;
  v_store := case v_c.platform when 'SHOPIFY' then 'Shopify' else 'WooCommerce' end;

  select coalesce(array_agg(distinct p.id), '{}') into v_products
  from public.sales_channel_variants m
  join public.product_variants v on v.id = m.variant_id
  join public.products p on p.id = v.product_id
  where m.channel_id = p_channel_id
    and (p_external_variant_id is null or m.external_variant_id = p_external_variant_id)
    and not p.track_inventory and p.created_by is null and lower(v_c.platform::text) = any(p.tags)
    and not exists (select 1 from public.inventory_movements im join public.product_variants pv on pv.id = im.variant_id where pv.product_id = p.id)
    and not exists (select 1 from public.product_variants pv where pv.product_id = p.id
                    and not exists (select 1 from public.sales_channel_variants x where x.channel_id = p_channel_id and x.variant_id = pv.id));

  foreach v_product in array v_products loop
    -- Every variant needs the store's number at the synced location; otherwise wait for it.
    continue when exists (
      select 1 from public.product_variants pv
      join public.sales_channel_variants m on m.channel_id = p_channel_id and m.variant_id = pv.id
      left join public.channel_catalog_items ci on ci.channel_id = m.channel_id and ci.external_variant_id = m.external_variant_id
        and ci.removed_at is null and ci.tracked
      where pv.product_id = v_product
        and (ci.external_variant_id is null
             or not exists (select 1 from jsonb_array_elements(ci.levels) l where l ->> 'location_id' = v_loc and l ->> 'available' is not null)));

    update public.products set track_inventory = true where id = v_product;
    for v_r in
      select m.external_variant_id, m.variant_id, ci.inventory_item_id, ci.unit_cost,
        (select (l ->> 'available')::int from jsonb_array_elements(ci.levels) l where l ->> 'location_id' = v_loc limit 1) as qty
      from public.product_variants pv
      join public.sales_channel_variants m on m.channel_id = p_channel_id and m.variant_id = pv.id
      join public.channel_catalog_items ci on ci.channel_id = m.channel_id and ci.external_variant_id = m.external_variant_id
      where pv.product_id = v_product
    loop
      if v_r.qty > 0 then
        perform public._apply_inventory_movement(v_r.variant_id, 'ADJUSTMENT', v_r.qty, 0, 0, 'CHANNEL', p_channel_id,
          format('Opening stock from %s', v_c.name), format('Made by an order from %s: %s in stock there', v_store, v_r.qty), v_r.unit_cost, false);
      end if;
      update public.sales_channel_variants
      set inventory_item_id = coalesce(inventory_item_id, v_r.inventory_item_id), shopify_available = v_r.qty, last_pushed_qty = v_r.qty,
        sync_status = 'OK', last_error = null, mismatch_since = null, synced_at = now()
      where channel_id = p_channel_id and external_variant_id = v_r.external_variant_id;
      v_n := v_n + 1;
    end loop;
  end loop;
  return v_n;
end;
$$;

create or replace function public._channel_placeholder_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_table_name = 'sales_channels' then
    perform public._channel_adopt_placeholders(new.id);
  else
    perform public._channel_adopt_placeholders(new.channel_id, new.external_variant_id);
  end if;
  return null;
end;
$$;

revoke execute on function public._channel_adopt_placeholders(uuid, text) from public, anon, authenticated;
revoke execute on function public._channel_placeholder_trigger() from public, anon, authenticated;

-- The first sync turned stock sync on.
create or replace trigger channel_placeholders_first_sync after update of first_sync_at on public.sales_channels
  for each row when (old.first_sync_at is null and new.first_sync_at is not null) execute function public._channel_placeholder_trigger();
-- The store product (with its current stock) was read after an order made ours.
create or replace trigger channel_placeholders_catalog after insert or update of tracked, levels, removed_at on public.channel_catalog_items
  for each row when (new.tracked and new.removed_at is null) execute function public._channel_placeholder_trigger();

-- Stores already synced: products orders made before now take the store's number once.
do $$
declare
  r record;
  v_n int;
begin
  for r in select id, merchant_id from public.sales_channels where status = 'CONNECTED' and first_sync_at is not null loop
    perform set_config('app.merchant_id', r.merchant_id::text, true);
    v_n := public._channel_adopt_placeholders(r.id);
    if v_n > 0 then
      raise notice 'Store %: % item(s) made by orders now follow the store stock', r.id, v_n;
    end if;
  end loop;
  perform set_config('app.merchant_id', '', true);
end $$;

select public._tenancy_own_functions();
