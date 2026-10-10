-- =============================================================================
-- Store sync v2: the first sync, full product data, new products coming in by
-- themselves, and "Delivered" sent to Shopify.
--
-- First sync (one confirmed step, previewed first):
--   * every store product not here yet is created here (prices, cost, SKU,
--     barcode, weight, vendor, type, tags, images) with the store's quantity
--     as opening stock;
--   * products that already exist here (same SKU) are linked, and their stock
--     is set to the store's number once, as a recorded stock correction;
--   * stock sync is turned on. From then on this app's stock is the truth and
--     every change here is sent to the store.
--
-- New products made in the store later are imported automatically (with the
-- store's quantity as opening stock) when "import new products" is on.
-- Products already here are never overwritten from the store, except empty
-- fields (cost, barcode, weight, image) that the store can fill in.
--
-- Delivered: when an order from Shopify is delivered here, a job adds a
-- "Delivered" event to its Shopify fulfilment (fulfilled first if it was not).
-- It is recorded as delivered on Shopify only after Shopify confirms it.
-- =============================================================================

alter table public.channel_catalog_items add column if not exists unit_cost numeric(12,2);
alter table public.channel_catalog_items add column if not exists images jsonb not null default '[]'::jsonb;
alter table public.channel_catalog_items add column if not exists vendor text;
alter table public.channel_catalog_items add column if not exists product_type text;
alter table public.channel_catalog_items add column if not exists tags text[] not null default '{}';
alter table public.channel_catalog_items add column if not exists weight_grams int;
alter table public.channel_catalog_items add column if not exists removed_at timestamptz;

alter table public.sales_channels add column if not exists first_sync_at timestamptz;

alter table public.channel_fulfillments add column if not exists delivered_status text
  check (delivered_status in ('PENDING', 'MARKED', 'FAILED', 'SKIPPED'));
alter table public.channel_fulfillments add column if not exists delivered_at timestamptz;
alter table public.channel_fulfillments add column if not exists delivered_event_id text;
alter table public.channel_fulfillments add column if not exists delivered_error text;

-- -----------------------------------------------------------------------------
-- Catalog rows
-- -----------------------------------------------------------------------------
create or replace function public._channel_catalog_put(p_channel_id uuid, v_item jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_num text := '^[0-9]+(\.[0-9]+)?$';
begin
  insert into public.channel_catalog_items(channel_id, external_variant_id, external_product_id, inventory_item_id, sku, barcode,
    product_title, variant_title, product_status, tracked, levels, imported_at, price, compare_at_price, image_url, options, product_description,
    unit_cost, images, vendor, product_type, tags, weight_grams, removed_at)
  values (p_channel_id, v_item ->> 'external_variant_id', v_item ->> 'external_product_id', v_item ->> 'inventory_item_id',
    nullif(trim(v_item ->> 'sku'), ''), nullif(trim(v_item ->> 'barcode'), ''), v_item ->> 'product_title', v_item ->> 'variant_title',
    v_item ->> 'product_status', coalesce((v_item ->> 'tracked')::boolean, true), coalesce(v_item -> 'levels', '[]'::jsonb), now(),
    case when (v_item ->> 'price') ~ v_num then public.money((v_item ->> 'price')::numeric) end,
    case when (v_item ->> 'compare_at_price') ~ v_num then public.money((v_item ->> 'compare_at_price')::numeric) end,
    case when (v_item ->> 'image_url') ~ '^https://' then left(v_item ->> 'image_url', 1000) end,
    case when jsonb_typeof(v_item -> 'options') = 'object' then v_item -> 'options' else '{}'::jsonb end,
    left(nullif(trim(v_item ->> 'product_description'), ''), 5000),
    case when (v_item ->> 'unit_cost') ~ v_num then public.money((v_item ->> 'unit_cost')::numeric) end,
    coalesce((select jsonb_agg(left(u, 1000)) from (select jsonb_array_elements_text(v_item -> 'images') u
      where jsonb_typeof(v_item -> 'images') = 'array' limit 10) q where u ~ '^https://'), '[]'::jsonb),
    left(nullif(trim(v_item ->> 'vendor'), ''), 120), left(nullif(trim(v_item ->> 'product_type'), ''), 120),
    coalesce((select array_agg(left(trim(t), 60)) from (select jsonb_array_elements_text(v_item -> 'tags') t
      where jsonb_typeof(v_item -> 'tags') = 'array' limit 30) q where trim(t) <> ''), '{}'),
    case when (v_item ->> 'weight_grams') ~ '^[0-9]+$' then least((v_item ->> 'weight_grams')::int, 1000000) end,
    null)
  on conflict (channel_id, external_variant_id) do update set
    external_product_id = excluded.external_product_id, inventory_item_id = excluded.inventory_item_id, sku = excluded.sku,
    barcode = excluded.barcode, product_title = excluded.product_title, variant_title = excluded.variant_title,
    product_status = excluded.product_status, tracked = excluded.tracked, levels = excluded.levels, imported_at = now(),
    price = excluded.price, compare_at_price = excluded.compare_at_price, image_url = excluded.image_url, options = excluded.options,
    product_description = excluded.product_description, unit_cost = excluded.unit_cost, images = excluded.images, vendor = excluded.vendor,
    product_type = excluded.product_type, tags = excluded.tags, weight_grams = excluded.weight_grams, removed_at = null;
end;
$$;

-- Links store variants to ours where the SKU matches exactly one on each side,
-- and refreshes the inventory item / store quantity of every link.
create or replace function public._channel_link_by_sku(p_channel_id uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_loc text;
  v_linked int;
begin
  select settings ->> 'location_id' into v_loc from public.sales_channels where id = p_channel_id;
  update public.sales_channel_variants m set inventory_item_id = ci.inventory_item_id, sku = ci.sku,
    sync_status = case when not ci.tracked then 'UNTRACKED' when m.sync_status = 'UNTRACKED' then 'NEW' else m.sync_status end,
    shopify_available = (select (l ->> 'available')::int from jsonb_array_elements(ci.levels) l where l ->> 'location_id' = v_loc limit 1)
  from public.channel_catalog_items ci
  where ci.channel_id = p_channel_id and m.channel_id = p_channel_id and m.external_variant_id = ci.external_variant_id
    and ci.removed_at is null;

  insert into public.sales_channel_variants(channel_id, external_variant_id, external_product_id, variant_id, inventory_item_id, sku,
    shopify_available, sync_status)
  select ci.channel_id, ci.external_variant_id, ci.external_product_id, v.id, ci.inventory_item_id, ci.sku,
    (select (l ->> 'available')::int from jsonb_array_elements(ci.levels) l where l ->> 'location_id' = v_loc limit 1),
    case when ci.tracked then 'NEW' else 'UNTRACKED' end
  from public.channel_catalog_items ci
  join public.product_variants v on lower(v.sku) = lower(ci.sku) and v.is_active
  where ci.channel_id = p_channel_id and ci.sku is not null and ci.removed_at is null
    and not exists (select 1 from public.sales_channel_variants m where m.channel_id = ci.channel_id and m.external_variant_id = ci.external_variant_id)
    and (select count(*) from public.product_variants v2 where lower(v2.sku) = lower(ci.sku) and v2.is_active) = 1
    and (select count(*) from public.channel_catalog_items c2 where c2.channel_id = ci.channel_id and lower(c2.sku) = lower(ci.sku) and c2.removed_at is null) = 1
  on conflict do nothing;
  get diagnostics v_linked = row_count;
  return v_linked;
end;
$$;

-- Full catalog read (connect, hourly refresh, "Read catalog").
create or replace function public.channel_catalog_import(p_channel_id uuid, p_items jsonb, p_locations jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_linked int;
  v_auto jsonb;
begin
  perform public._require_system();
  update public.sales_channels set locations = coalesce(p_locations, '[]'::jsonb), catalog_imported_at = now() where id = p_channel_id;
  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    perform public._channel_catalog_put(p_channel_id, v_item);
  end loop;
  v_linked := public._channel_link_by_sku(p_channel_id);
  v_auto := public._channel_autoimport(p_channel_id, null);
  return jsonb_build_object('items', jsonb_array_length(coalesce(p_items, '[]'::jsonb)), 'linked', v_linked,
    'mapped', (select count(*) from public.sales_channel_variants where channel_id = p_channel_id and inventory_item_id is not null),
    'imported', coalesce((v_auto ->> 'created')::int, 0));
end;
$$;

-- One product from a webhook (products/create, products/update) or, with no
-- items, products/delete. Our products are never removed: the link stops.
create or replace function public.channel_catalog_product_upsert(p_channel_id uuid, p_product_id text, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_removed int;
  v_auto jsonb;
  v_keep text[];
begin
  perform public._require_system();
  if nullif(trim(coalesce(p_product_id, '')), '') is null then
    raise exception 'VALIDATION: product id missing' using errcode = '22023';
  end if;
  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    continue when v_item ->> 'external_product_id' is distinct from p_product_id;
    perform public._channel_catalog_put(p_channel_id, v_item);
  end loop;
  select coalesce(array_agg(x ->> 'external_variant_id'), '{}') into v_keep from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x;
  update public.channel_catalog_items set removed_at = now()
  where channel_id = p_channel_id and external_product_id = p_product_id and removed_at is null
    and not (external_variant_id = any (v_keep));
  get diagnostics v_removed = row_count;
  -- A variant gone from the store: stop syncing it (its stock here is kept).
  update public.sales_channel_variants m set inventory_item_id = null, sync_status = 'FAILED',
    last_error = 'Removed from the store', mismatch_since = null
  from public.channel_catalog_items ci
  where ci.channel_id = p_channel_id and ci.external_product_id = p_product_id and ci.removed_at is not null
    and m.channel_id = p_channel_id and m.external_variant_id = ci.external_variant_id and m.inventory_item_id is not null;
  perform public._channel_link_by_sku(p_channel_id);
  v_auto := public._channel_autoimport(p_channel_id, array[p_product_id]);
  return jsonb_build_object('items', jsonb_array_length(coalesce(p_items, '[]'::jsonb)), 'removed', v_removed,
    'imported', coalesce((v_auto ->> 'created')::int, 0));
end;
$$;

-- -----------------------------------------------------------------------------
-- Importing store products (staff pick, first sync, or automatic)
-- -----------------------------------------------------------------------------
-- Empty fields of one of our variants (and its product) filled from the store.
create or replace function public._channel_fill_blanks(p_variant_id uuid, p_ci public.channel_catalog_items)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product uuid;
begin
  -- A cost of 0 counts as "not entered".
  update public.product_variants set
    cost_price = case when coalesce(cost_price, 0) = 0 then coalesce(p_ci.unit_cost, cost_price) else cost_price end,
    barcode = coalesce(barcode, p_ci.barcode),
    weight_grams = coalesce(weight_grams, p_ci.weight_grams)
  where id = p_variant_id
    and (coalesce(cost_price, 0) = 0 and p_ci.unit_cost is not null or barcode is null and p_ci.barcode is not null
         or weight_grams is null and p_ci.weight_grams is not null);
  select product_id into v_product from public.product_variants where id = p_variant_id;
  update public.products set cost_price = case when coalesce(cost_price, 0) = 0 then coalesce(p_ci.unit_cost, cost_price) else cost_price end,
    brand = coalesce(brand, p_ci.vendor)
  where id = v_product and (coalesce(cost_price, 0) = 0 and p_ci.unit_cost is not null or brand is null and p_ci.vendor is not null);
  if not exists (select 1 from public.product_images where product_id = v_product) then
    insert into public.product_images(product_id, url, is_primary, position)
    select v_product, u, n = 1, (n - 1)::int
    from jsonb_array_elements_text(case when jsonb_array_length(p_ci.images) > 0 then p_ci.images
                                        when p_ci.image_url is not null then jsonb_build_array(p_ci.image_url) else '[]'::jsonb end)
      with ordinality as t(u, n);
  end if;
end;
$$;

-- p_location: the store location whose quantity is used (null → the channel's).
create or replace function public._channel_catalog_adopt(p_channel_id uuid, p_product_ids text[], p_with_stock boolean, p_apply boolean, p_location text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_c public.sales_channels;
  v_pid text;
  v_first public.channel_catalog_items;
  v_ci public.channel_catalog_items;
  v_product uuid;
  v_variant uuid;
  v_existing uuid;
  v_sku text;
  v_qty int;
  v_opts text[];
  v_plan jsonb := '[]'::jsonb;
  v_created int := 0;
  v_linked int := 0;
  v_pos int;
  v_prefix text;
  v_loc text;
  v_category uuid;
begin
  select * into v_c from public.sales_channels where id = p_channel_id;
  if not found then
    raise exception 'NOT_FOUND: sales channel not found' using errcode = 'P0002';
  end if;
  v_prefix := case v_c.platform when 'SHOPIFY' then 'SHOP' else 'WOO' end;
  v_loc := coalesce(p_location, v_c.settings ->> 'location_id');

  foreach v_pid in array p_product_ids loop
    select * into v_first from public.channel_catalog_items where channel_id = p_channel_id and external_product_id = v_pid and removed_at is null
    order by external_variant_id limit 1;
    continue when not found;
    -- A product imported before: new variants join it instead of making a second product.
    select pv.product_id into v_product from public.sales_channel_variants m join public.product_variants pv on pv.id = m.variant_id
    where m.channel_id = p_channel_id and m.external_product_id = v_pid limit 1;
    select coalesce(max(position) + 1, 0) into v_pos from public.product_variants where product_id = v_product;
    select coalesce(array_agg(k order by k), '{}') into v_opts
    from (select distinct jsonb_object_keys(options) k from public.channel_catalog_items
          where channel_id = p_channel_id and external_product_id = v_pid and removed_at is null) o;

    for v_ci in select * from public.channel_catalog_items where channel_id = p_channel_id and external_product_id = v_pid and removed_at is null
                order by external_variant_id loop
      if exists (select 1 from public.sales_channel_variants m join public.product_variants pv on pv.id = m.variant_id
                 where m.channel_id = p_channel_id and m.external_variant_id = v_ci.external_variant_id) then
        v_plan := v_plan || jsonb_build_object('product_id', v_pid, 'external_variant_id', v_ci.external_variant_id, 'action', 'ALREADY_LINKED',
          'title', concat_ws(' — ', v_ci.product_title, nullif(v_ci.variant_title, 'Default Title')), 'sku', v_ci.sku);
        continue;
      end if;
      v_sku := coalesce(v_ci.sku, v_prefix || '-' || regexp_replace(v_ci.external_variant_id, '[^A-Za-z0-9]+', '', 'g'));
      select id into v_existing from public.product_variants where lower(sku) = lower(v_sku) limit 1;
      v_qty := case when v_ci.tracked then greatest(coalesce((select (l ->> 'available')::int from jsonb_array_elements(v_ci.levels) l
                 where l ->> 'location_id' = coalesce(v_loc, l ->> 'location_id') limit 1), 0), 0) else 0 end;
      v_plan := v_plan || jsonb_build_object('product_id', v_pid, 'external_variant_id', v_ci.external_variant_id,
        'action', case when v_existing is not null then 'LINK' else 'CREATE' end,
        'title', concat_ws(' — ', v_ci.product_title, nullif(v_ci.variant_title, 'Default Title')), 'sku', v_sku,
        'price', v_ci.price, 'cost', v_ci.unit_cost, 'stock', case when p_with_stock and v_existing is null then v_qty end);
      continue when not p_apply;

      if v_existing is not null then
        v_variant := v_existing;
        v_linked := v_linked + 1;
        perform public._channel_fill_blanks(v_variant, v_ci);
      else
        if v_product is null then
          select id into v_category from public.categories
          where v_first.product_type is not null and (lower(name) = lower(v_first.product_type) or slug = public.slugify(v_first.product_type)) limit 1;
          insert into public.products(name, slug, status, price, compare_at_price, cost_price, description, option_names, track_inventory,
            tags, brand, category_id, weight_grams, created_by)
          values (left(coalesce(nullif(trim(v_first.product_title), ''), 'Product'), 200),
            left(public.slugify(coalesce(v_first.product_title, 'product')), 60) || '-' || left(md5(p_channel_id::text || v_pid), 6),
            case when upper(coalesce(v_first.product_status, 'ACTIVE')) in ('ACTIVE', 'PUBLISH') then 'ACTIVE' else 'DRAFT' end::public.product_status,
            coalesce(v_first.price, 0), v_first.compare_at_price, coalesce(v_first.unit_cost, 0), v_first.product_description, v_opts,
            true, (select array_agg(distinct t) from unnest(array[lower(v_c.platform::text)] || v_first.tags
                     || case when v_category is null and v_first.product_type is not null then array[v_first.product_type] else '{}'::text[] end) t),
            v_first.vendor, v_category, v_first.weight_grams, auth.uid())
          returning id into v_product;
          insert into public.product_images(product_id, url, is_primary, position)
          select v_product, u, n = 1, (n - 1)::int
          from jsonb_array_elements_text(case when jsonb_array_length(v_first.images) > 0 then v_first.images
                                              when v_first.image_url is not null then jsonb_build_array(v_first.image_url) else '[]'::jsonb end)
            with ordinality as t(u, n);
        end if;
        insert into public.product_variants(product_id, sku, title, option_values, price, compare_at_price, cost_price, barcode, weight_grams, position, is_default)
        values (v_product, v_sku, coalesce(nullif(nullif(trim(v_ci.variant_title), ''), 'Default Title'), 'Default'), v_ci.options,
          v_ci.price, v_ci.compare_at_price, v_ci.unit_cost, v_ci.barcode, v_ci.weight_grams, v_pos,
          v_pos = 0 and not exists (select 1 from public.product_variants where product_id = v_product))
        returning id into v_variant;
        v_pos := v_pos + 1;
        v_created := v_created + 1;
        if p_with_stock and v_qty > 0 then
          perform public._apply_inventory_movement(v_variant, 'ADJUSTMENT', v_qty, 0, 0, 'CHANNEL', p_channel_id,
            format('Opening stock from %s', v_c.name), format('Imported from %s: %s in stock there', v_c.name, v_qty), v_ci.unit_cost, false);
        end if;
      end if;
      insert into public.sales_channel_variants(channel_id, external_variant_id, external_product_id, variant_id, inventory_item_id, sku,
        shopify_available, last_pushed_qty, sync_status)
      values (p_channel_id, v_ci.external_variant_id, v_pid, v_variant, v_ci.inventory_item_id, v_ci.sku,
        case when v_ci.tracked then v_qty end, case when v_ci.tracked and p_with_stock and v_existing is null then v_qty end,
        case when not v_ci.tracked then 'UNTRACKED' when p_with_stock and v_existing is null then 'OK' else 'NEW' end)
      on conflict (channel_id, external_variant_id) do update
        set variant_id = excluded.variant_id, inventory_item_id = excluded.inventory_item_id, sku = excluded.sku;
    end loop;
  end loop;
  return jsonb_build_object('applied', p_apply, 'created', v_created, 'linked', v_linked, 'plan', v_plan);
end;
$$;

-- Staff: import picked products (same signature as before).
create or replace function public.channel_catalog_adopt(p_channel_id uuid, p_product_ids text[], p_with_stock boolean default false, p_apply boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_r jsonb;
begin
  perform public.require_permission('products.manage');
  if p_with_stock then
    perform public.require_permission('inventory.adjust');
  end if;
  if coalesce(array_length(p_product_ids, 1), 0) = 0 then
    raise exception 'VALIDATION: choose at least one product' using errcode = '22023';
  end if;
  if array_length(p_product_ids, 1) > 500 then
    raise exception 'VALIDATION: import at most 500 products at a time' using errcode = '22023';
  end if;
  v_r := public._channel_catalog_adopt(p_channel_id, p_product_ids, p_with_stock, p_apply, null);
  if p_apply then
    perform public.log_audit('channel.catalog_adopt', 'sales_channel', p_channel_id::text, null,
      jsonb_build_object('products', p_product_ids, 'created', v_r -> 'created', 'linked', v_r -> 'linked', 'with_stock', p_with_stock));
  end if;
  return v_r;
end;
$$;

-- New store products → here, with the store's quantity as opening stock.
-- Only after the first sync, and only while "import new products" is on.
create or replace function public._channel_autoimport(p_channel_id uuid, p_product_ids text[])
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_c public.sales_channels;
  v_ids text[];
  v_r jsonb;
begin
  select * into v_c from public.sales_channels where id = p_channel_id;
  if v_c.first_sync_at is null or not public._channel_opt(v_c, 'auto_import_products', true) then
    return jsonb_build_object('created', 0, 'skipped', 'off');
  end if;
  select coalesce(array_agg(distinct ci.external_product_id), '{}') into v_ids
  from public.channel_catalog_items ci
  where ci.channel_id = p_channel_id and ci.removed_at is null and ci.external_product_id is not null
    and upper(coalesce(ci.product_status, 'ACTIVE')) not in ('ARCHIVED', 'TRASH')
    and (p_product_ids is null or ci.external_product_id = any (p_product_ids))
    and not exists (select 1 from public.sales_channel_variants m where m.channel_id = ci.channel_id and m.external_variant_id = ci.external_variant_id);
  if coalesce(array_length(v_ids, 1), 0) = 0 then
    return jsonb_build_object('created', 0);
  end if;
  v_r := public._channel_catalog_adopt(p_channel_id, v_ids[1:500], true, true, null);
  if (v_r ->> 'created')::int > 0 or (v_r ->> 'linked')::int > 0 then
    perform public.log_audit('channel.catalog_auto_import', 'sales_channel', p_channel_id::text, null,
      jsonb_build_object('products', v_ids[1:500], 'created', v_r -> 'created', 'linked', v_r -> 'linked'));
  end if;
  return v_r - 'plan';
end;
$$;

-- -----------------------------------------------------------------------------
-- First sync
--   p_apply false → the plan only: the real steps run and are rolled back, so
--   the preview is exactly what applying does. p_apply true → done, in one
--   transaction.
-- -----------------------------------------------------------------------------
create or replace function public._channel_first_sync_run(p_channel_id uuid, p_location_id text, p_auto_import boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_c public.sales_channels;
  v_store text;
  v_ids text[];
  v_adopt jsonb;
  v_m record;
  v_stock jsonb := '[]'::jsonb;
  v_delta int;
  v_store_qty int;
  v_linked_before int;
begin
  select * into v_c from public.sales_channels where id = p_channel_id for update;
  if not found then
    raise exception 'NOT_FOUND: sales channel not found' using errcode = 'P0002';
  end if;
  v_store := case v_c.platform when 'SHOPIFY' then 'Shopify' else 'WooCommerce' end;
  if v_c.status <> 'CONNECTED' then
    raise exception 'VALIDATION: connect the store first' using errcode = '22023';
  end if;
  if v_c.catalog_imported_at is null then
    raise exception 'VALIDATION: read the store''s catalog first' using errcode = '22023';
  end if;
  if p_location_id is null or not exists (select 1 from jsonb_array_elements(v_c.locations) l where l ->> 'id' = p_location_id) then
    raise exception 'VALIDATION: choose one of the store''s locations' using errcode = '22023';
  end if;
  select count(*) into v_linked_before from public.sales_channel_variants where channel_id = p_channel_id and inventory_item_id is not null;

  -- Stock sync stays off while we work, so nothing is pushed half-way.
  update public.sales_channels set settings = settings || jsonb_build_object('location_id', p_location_id, 'inventory_sync', false)
  where id = p_channel_id;
  perform public._channel_link_by_sku(p_channel_id);

  -- 1. Products not here yet (and new variants of ones that are) are created
  --    with the store's quantity; SKUs that exist here are linked.
  select coalesce(array_agg(distinct ci.external_product_id), '{}') into v_ids
  from public.channel_catalog_items ci
  where ci.channel_id = p_channel_id and ci.removed_at is null and ci.external_product_id is not null
    and upper(coalesce(ci.product_status, 'ACTIVE')) not in ('ARCHIVED', 'TRASH')
    and not exists (select 1 from public.sales_channel_variants m where m.channel_id = ci.channel_id and m.external_variant_id = ci.external_variant_id);
  v_adopt := case when coalesce(array_length(v_ids, 1), 0) > 0
    then public._channel_catalog_adopt(p_channel_id, v_ids[1:2000], true, true, p_location_id)
    else jsonb_build_object('created', 0, 'linked', 0, 'plan', '[]'::jsonb) end;

  -- 2. Every linked variant takes the store's number once (a recorded correction).
  for v_m in
    select m.variant_id, v.sku, p.name as product, v.title as variant, p.track_inventory,
      greatest(coalesce(i.available, 0), 0) as ours, ci.tracked, ci.levels
    from public.sales_channel_variants m
    join public.product_variants v on v.id = m.variant_id
    join public.products p on p.id = v.product_id
    left join public.inventory i on i.variant_id = m.variant_id
    join public.channel_catalog_items ci on ci.channel_id = m.channel_id and ci.external_variant_id = m.external_variant_id and ci.removed_at is null
    where m.channel_id = p_channel_id
    order by p.name, v.title
  loop
    continue when not v_m.tracked or not v_m.track_inventory;
    v_store_qty := (select (l ->> 'available')::int from jsonb_array_elements(v_m.levels) l where l ->> 'location_id' = p_location_id limit 1);
    continue when v_store_qty is null;
    v_delta := greatest(v_store_qty, 0) - v_m.ours;
    if v_delta <> 0 then
      v_stock := v_stock || jsonb_build_object('variant_id', v_m.variant_id, 'sku', v_m.sku,
        'title', concat_ws(' — ', v_m.product, nullif(v_m.variant, 'Default')), 'ours', v_m.ours, 'store', v_store_qty, 'change', v_delta);
      perform public._apply_inventory_movement(v_m.variant_id, 'ADJUSTMENT', v_delta, 0, 0, 'CHANNEL', p_channel_id,
        format('First sync with %s', v_c.name), format('First sync: stock set to %s''s %s (was %s here)', v_store, v_store_qty, v_m.ours), null, false);
    end if;
    update public.sales_channel_variants set shopify_available = v_store_qty, last_pushed_qty = v_store_qty,
      sync_status = 'OK', last_error = null, mismatch_since = null, synced_at = now()
    where channel_id = p_channel_id and variant_id = v_m.variant_id;
  end loop;

  -- 3. Empty fields (cost, barcode, weight, image) of linked products filled in.
  perform public._channel_fill_blanks(m.variant_id, ci)
  from public.sales_channel_variants m
  join public.channel_catalog_items ci on ci.channel_id = m.channel_id and ci.external_variant_id = m.external_variant_id
  where m.channel_id = p_channel_id;

  -- 4. From now on this app's stock is the truth.
  update public.sales_channels set first_sync_at = now(),
    settings = settings || jsonb_build_object('location_id', p_location_id, 'inventory_sync', true, 'auto_import_products', coalesce(p_auto_import, true))
  where id = p_channel_id;
  -- Anything still different (e.g. the store had a negative number) is sent now.
  perform public.channel_job_enqueue(p_channel_id, 'INVENTORY', m.variant_id)
  from public.sales_channel_variants m
  left join public.inventory i on i.variant_id = m.variant_id
  where m.channel_id = p_channel_id and m.inventory_item_id is not null and m.sync_status <> 'UNTRACKED'
    and m.shopify_available is distinct from greatest(coalesce(i.available, 0), 0);

  return jsonb_build_object(
    'store', v_store, 'location_id', p_location_id,
    'products', (select count(distinct x ->> 'product_id') from jsonb_array_elements(v_adopt -> 'plan') x where x ->> 'action' = 'CREATE'),
    'create', (select count(*) from jsonb_array_elements(v_adopt -> 'plan') x where x ->> 'action' = 'CREATE'),
    -- Linked to a product that was already here (by SKU).
    'link', greatest((select count(*) from public.sales_channel_variants where channel_id = p_channel_id and inventory_item_id is not null)
            - v_linked_before - coalesce((v_adopt ->> 'created')::int, 0), 0),
    'already_linked', v_linked_before,
    'untracked', (select count(*) from public.channel_catalog_items where channel_id = p_channel_id and removed_at is null and not tracked),
    'stock_changes', v_stock,
    'items', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (select x from jsonb_array_elements(v_adopt -> 'plan') x
              where x ->> 'action' in ('CREATE', 'LINK') limit 300) q));
end;
$$;

create or replace function public.channel_first_sync(p_channel_id uuid, p_location_id text, p_auto_import boolean default true, p_apply boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_out jsonb;
begin
  perform public.require_permission('settings.manage');
  perform public.require_permission('products.manage');
  perform public.require_permission('inventory.adjust');
  if p_apply then
    v_out := public._channel_first_sync_run(p_channel_id, p_location_id, p_auto_import);
    perform public.log_audit('channel.first_sync', 'sales_channel', p_channel_id::text, null,
      jsonb_build_object('location_id', p_location_id, 'create', v_out -> 'create', 'link', v_out -> 'link',
        'stock_corrected', jsonb_array_length(v_out -> 'stock_changes')));
    return v_out || jsonb_build_object('applied', true);
  end if;
  begin
    v_out := public._channel_first_sync_run(p_channel_id, p_location_id, p_auto_import);
    raise exception 'preview' using errcode = 'XP001';
  exception when sqlstate 'XP001' then
    null; -- everything above is rolled back; v_out keeps the plan
  end;
  return v_out || jsonb_build_object('applied', false);
end;
$$;

-- -----------------------------------------------------------------------------
-- Delivered on Shopify
-- -----------------------------------------------------------------------------
create or replace function public._queue_channel_delivered(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_channel public.sales_channels;
  v_f public.channel_fulfillments;
begin
  select * into v_order from public.orders where id = p_order_id;
  if v_order.sales_channel_id is null or v_order.external_order_id is null then
    return;
  end if;
  select * into v_channel from public.sales_channels where id = v_order.sales_channel_id;
  if v_channel.platform <> 'SHOPIFY' or not public._channel_opt(v_channel, 'mark_delivered', true) then
    return;
  end if;
  -- Delivered without ever being Shipped here: fulfil first (same job).
  if not exists (select 1 from public.channel_fulfillments where order_id = p_order_id and source = 'APP') then
    perform public._queue_channel_fulfillment(p_order_id);
  end if;
  update public.channel_fulfillments set delivered_status = 'PENDING', delivered_error = null
  where order_id = p_order_id and source = 'APP' and coalesce(delivered_status, '') <> 'MARKED'
  returning * into v_f;
  if v_f.id is null and exists (select 1 from public.channel_fulfillments where order_id = p_order_id and source = 'SHOPIFY') then
    -- Fulfilled by hand in Shopify and nothing of ours: mark that fulfilment.
    insert into public.channel_fulfillments(channel_id, order_id, external_order_id, status, delivered_status, last_error)
    values (v_channel.id, p_order_id, v_order.external_order_id, 'SKIPPED', 'PENDING', 'Fulfilled in Shopify')
    on conflict (order_id) where source = 'APP' do nothing
    returning * into v_f;
  end if;
  if v_f.id is not null then
    perform public.channel_job_enqueue(v_channel.id, 'FULFILL', p_order_id);
  end if;
end;
$$;

create or replace function public._orders_channel_delivered_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._queue_channel_delivered(new.id);
  return new;
end;
$$;
create or replace trigger orders_channel_delivered after update of status on public.orders
  for each row when (new.status = 'DELIVERED' and old.status is distinct from new.status and new.sales_channel_id is not null)
  execute function public._orders_channel_delivered_trigger();

create or replace function public.channel_fulfillment_context(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_f public.channel_fulfillments;
  v_ship record;
begin
  perform public._require_system();
  select * into v_order from public.orders where id = p_order_id;
  select * into v_f from public.channel_fulfillments where order_id = p_order_id and source = 'APP';
  select s.consignment_id, s.tracking_number, s.created_at, s.status, c.name as courier_name, c.provider, c.tracking_url_template
  into v_ship from public.shipments s join public.couriers c on c.id = s.courier_id
  where s.order_id = p_order_id and s.is_active order by s.created_at desc limit 1;
  return jsonb_build_object(
    'order', jsonb_build_object('id', v_order.id, 'order_number', v_order.order_number, 'status', v_order.status,
      'external_order_id', v_order.external_order_id, 'customer_email', v_order.customer_email, 'shipped_at', v_order.shipped_at,
      'delivered_at', v_order.delivered_at),
    'fulfillment', to_jsonb(v_f),
    -- The Shopify fulfilment that gets "Delivered": ours, or the one made in Shopify.
    'delivered_target', coalesce(v_f.fulfillment_id, (select f.fulfillment_id from public.channel_fulfillments f
      where f.order_id = p_order_id and f.source = 'SHOPIFY' and f.fulfillment_id is not null order by f.created_at desc limit 1)),
    'shipment', case when v_ship is null then null else jsonb_build_object(
      'courier', v_ship.courier_name, 'provider', v_ship.provider,
      'tracking', coalesce(v_ship.consignment_id, v_ship.tracking_number),
      'tracking_url', case when v_ship.tracking_url_template is not null and coalesce(v_ship.consignment_id, v_ship.tracking_number) is not null
        then replace(v_ship.tracking_url_template, '{tracking}', coalesce(v_ship.consignment_id, v_ship.tracking_number)) end,
      'shipped_at', v_ship.created_at) end,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('variant_id', i.variant_id, 'sku', i.sku,
        'quantity', i.quantity - i.returned_quantity,
        'external_variant_id', (select m.external_variant_id from public.sales_channel_variants m
                                where m.channel_id = v_order.sales_channel_id and m.variant_id = i.variant_id limit 1)))
      from public.order_items i where i.order_id = p_order_id), '[]'::jsonb)
  );
end;
$$;

create or replace function public.channel_fulfillment_update(p_order_id uuid, p jsonb)
returns public.channel_fulfillments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old public.channel_fulfillments;
  v_row public.channel_fulfillments;
  v_status text := p ->> 'status';
  v_store text;
begin
  perform public._require_system();
  select * into v_old from public.channel_fulfillments where order_id = p_order_id and source = 'APP' for update;
  if not found then
    raise exception 'NOT_FOUND: no fulfilment for this order' using errcode = 'P0002';
  end if;
  if v_status = 'FULFILLED' and nullif(p ->> 'fulfillment_id', '') is null then
    raise exception 'VALIDATION: a fulfilment is only recorded with the store''s fulfilment id' using errcode = '22023';
  end if;
  if p ->> 'delivered_status' = 'MARKED' and nullif(p ->> 'delivered_event_id', '') is null then
    raise exception 'VALIDATION: delivered is only recorded with the store''s event id' using errcode = '22023';
  end if;
  select case platform when 'SHOPIFY' then 'Shopify' else 'WooCommerce' end into v_store from public.sales_channels where id = v_old.channel_id;
  update public.channel_fulfillments set
    status = coalesce(v_status, status),
    fulfillment_id = coalesce(nullif(p ->> 'fulfillment_id', ''), fulfillment_id),
    fulfillment_order_ids = coalesce((select array_agg(x) from jsonb_array_elements_text(p -> 'fulfillment_order_ids') x), fulfillment_order_ids),
    line_items = coalesce(p -> 'line_items', line_items),
    courier = coalesce(p ->> 'courier', courier),
    tracking_number = coalesce(p ->> 'tracking_number', tracking_number),
    tracking_url = coalesce(p ->> 'tracking_url', tracking_url),
    shipped_at = coalesce((p ->> 'shipped_at')::timestamptz, shipped_at),
    shopify_status = coalesce(p ->> 'shopify_status', shopify_status),
    notify_requested = coalesce((p ->> 'notify_requested')::boolean, notify_requested),
    notification_status = coalesce(p ->> 'notification_status', notification_status),
    notification_note = coalesce(p ->> 'notification_note', notification_note),
    attempts = attempts + case when (p ->> 'attempted')::boolean then 1 else 0 end,
    last_error = case when p ? 'error' then nullif(p ->> 'error', '') else last_error end,
    fulfilled_at = case when v_status = 'FULFILLED' and v_old.status <> 'FULFILLED' then now() else fulfilled_at end,
    delivered_status = coalesce(p ->> 'delivered_status', delivered_status),
    delivered_event_id = coalesce(nullif(p ->> 'delivered_event_id', ''), delivered_event_id),
    delivered_at = case when p ->> 'delivered_status' = 'MARKED' and v_old.delivered_status is distinct from 'MARKED' then now() else delivered_at end,
    delivered_error = case when p ? 'delivered_error' then nullif(p ->> 'delivered_error', '') else delivered_error end,
    synced_at = now()
  where id = v_old.id returning * into v_row;

  if v_row.status is distinct from v_old.status then
    perform public._order_log(p_order_id, 'CHANNEL_FULFILLMENT',
      case v_row.status
        when 'FULFILLED' then format('Fulfilled on %s%s%s', v_store, coalesce(' · ' || v_row.courier, ''), coalesce(' ' || v_row.tracking_number, ''))
          || case v_row.notification_status when 'REQUESTED' then format(' — %s asked to e-mail the customer', v_store)
               when 'NO_EMAIL' then ' — no customer e-mail on the order, so no shipping e-mail' else '' end
        when 'NEEDS_TRACKING' then format('%s not fulfilled yet: add the courier tracking number', v_store)
        when 'FAILED' then format('%s fulfilment failed: %s', v_store, coalesce(v_row.last_error, 'unknown error'))
        when 'SKIPPED' then format('%s fulfilment skipped: %s', v_store, coalesce(v_row.last_error, ''))
        else format('%s fulfilment %s', v_store, lower(v_row.status)) end,
      null, null, jsonb_build_object('fulfillment_id', v_row.fulfillment_id, 'status', v_row.status));
  end if;
  if v_row.delivered_status is distinct from v_old.delivered_status and v_row.delivered_status in ('MARKED', 'FAILED', 'SKIPPED') then
    perform public._order_log(p_order_id, 'CHANNEL_FULFILLMENT',
      case v_row.delivered_status
        when 'MARKED' then format('Marked delivered on %s', v_store)
        when 'FAILED' then format('Could not mark delivered on %s: %s', v_store, coalesce(v_row.delivered_error, 'unknown error'))
        else format('Not marked delivered on %s: %s', v_store, coalesce(v_row.delivered_error, '')) end,
      null, null, jsonb_build_object('event_id', v_row.delivered_event_id, 'delivered_status', v_row.delivered_status));
  end if;
  return v_row;
end;
$$;

-- Staff: try a failed / waiting fulfilment (or delivered mark) again now.
create or replace function public.channel_fulfillment_retry(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_f public.channel_fulfillments;
  v_order public.orders;
begin
  perform public.require_permission('orders.update');
  select * into v_order from public.orders where id = p_order_id;
  if not found then
    raise exception 'NOT_FOUND: order not found' using errcode = 'P0002';
  end if;
  if v_order.status not in ('SHIPPED', 'DELIVERED', 'PARTIALLY_DELIVERED') then
    raise exception 'VALIDATION: only shipped orders are fulfilled on the store' using errcode = '22023';
  end if;
  perform public._queue_channel_fulfillment(p_order_id);
  update public.channel_fulfillments set status = 'PENDING', last_error = null
  where order_id = p_order_id and source = 'APP' and status in ('FAILED', 'NEEDS_TRACKING')
  returning * into v_f;
  if v_order.status = 'DELIVERED' then
    update public.channel_fulfillments set delivered_status = 'PENDING', delivered_error = null
    where order_id = p_order_id and source = 'APP' and delivered_status in ('FAILED', 'SKIPPED');
  end if;
  select * into v_f from public.channel_fulfillments where order_id = p_order_id and source = 'APP';
  if v_f.status = 'PENDING' or v_f.delivered_status = 'PENDING' then
    update public.channel_sync_jobs set status = 'PENDING', attempts = 0, next_attempt_at = now()
    where kind = 'FULFILL' and ref_id = p_order_id and status = 'FAILED'
      and not exists (select 1 from public.channel_sync_jobs o where o.kind = 'FULFILL' and o.ref_id = p_order_id and o.status in ('PENDING', 'RUNNING'));
    perform public.channel_job_enqueue(v_f.channel_id, 'FULFILL', p_order_id);
  end if;
  perform public.log_audit('channel.fulfillment_retry', 'order', p_order_id::text, null,
    jsonb_build_object('status', v_f.status, 'delivered_status', v_f.delivered_status));
  return jsonb_build_object('status', v_f.status, 'delivered_status', v_f.delivered_status);
end;
$$;

-- -----------------------------------------------------------------------------
-- Settings, order card and sync screen
-- -----------------------------------------------------------------------------
-- p: inventory_sync, location_id, external_changes (FLAG | SAAS_WINS), fulfill_on_ship,
--    notify_customer, fulfill_without_tracking, auto_import_products, mark_delivered
create or replace function public.channel_sync_settings_save(p_channel_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old public.sales_channels;
  v_new jsonb;
  v_loc text;
begin
  perform public.require_permission('settings.manage');
  select * into v_old from public.sales_channels where id = p_channel_id for update;
  if not found then
    raise exception 'NOT_FOUND: sales channel not found' using errcode = 'P0002';
  end if;
  v_loc := coalesce(nullif(p ->> 'location_id', ''), v_old.settings ->> 'location_id');
  if v_loc is not null and not exists (select 1 from jsonb_array_elements(v_old.locations) l where l ->> 'id' = v_loc) then
    raise exception 'VALIDATION: choose one of the store''s locations (import the catalog first)' using errcode = '22023';
  end if;
  if coalesce((p ->> 'inventory_sync')::boolean, false) and v_loc is null then
    raise exception 'VALIDATION: choose the store location to keep in step before turning stock sync on' using errcode = '22023';
  end if;
  if p ? 'external_changes' and p ->> 'external_changes' not in ('FLAG', 'SAAS_WINS') then
    raise exception 'VALIDATION: unknown policy' using errcode = '22023';
  end if;
  v_new := v_old.settings || jsonb_strip_nulls(jsonb_build_object(
    'inventory_sync', (p ->> 'inventory_sync')::boolean, 'location_id', v_loc, 'external_changes', p ->> 'external_changes',
    'fulfill_on_ship', (p ->> 'fulfill_on_ship')::boolean, 'notify_customer', (p ->> 'notify_customer')::boolean,
    'fulfill_without_tracking', (p ->> 'fulfill_without_tracking')::boolean,
    'auto_import_products', (p ->> 'auto_import_products')::boolean, 'mark_delivered', (p ->> 'mark_delivered')::boolean));
  update public.sales_channels set settings = v_new where id = p_channel_id;

  if (coalesce((v_new ->> 'inventory_sync')::boolean, false) and not public._channel_opt(v_old, 'inventory_sync', false))
     or v_loc is distinct from v_old.settings ->> 'location_id' then
    update public.sales_channel_variants m set last_pushed_qty = m.shopify_available,
      sync_status = case when m.inventory_item_id is null then m.sync_status
                         when m.shopify_available is null then 'NEW'
                         when m.shopify_available = (select greatest(coalesce(i.available, 0), 0) from public.inventory i where i.variant_id = m.variant_id) then 'OK'
                         else 'MISMATCH' end
    where m.channel_id = p_channel_id and m.sync_status <> 'UNTRACKED';
  end if;
  perform public.log_audit('channel.sync_settings', 'sales_channel', p_channel_id::text,
    jsonb_build_object('settings', v_old.settings), jsonb_build_object('settings', v_new));
  return v_new;
end;
$$;

create or replace function public.order_channel_info(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
begin
  perform public.require_permission('orders.view');
  select * into v_order from public.orders where id = p_order_id;
  if v_order.sales_channel_id is null then
    return null;
  end if;
  return jsonb_build_object(
    'channel', (select jsonb_build_object('id', c.id, 'name', c.name, 'platform', c.platform, 'shop_domain', c.shop_domain,
      'fulfill_on_ship', public._channel_opt(c, 'fulfill_on_ship', c.platform = 'SHOPIFY'), 'notify_customer', public._channel_opt(c, 'notify_customer', true),
      'mark_delivered', c.platform = 'SHOPIFY' and public._channel_opt(c, 'mark_delivered', true))
      from public.sales_channels c where c.id = v_order.sales_channel_id),
    'external_order_id', v_order.external_order_id, 'external_order_number', v_order.external_order_number,
    'fulfillments', coalesce((select jsonb_agg(jsonb_build_object(
        'id', f.id, 'source', f.source, 'status', f.status, 'fulfillment_id', f.fulfillment_id, 'courier', f.courier,
        'tracking_number', f.tracking_number, 'tracking_url', f.tracking_url, 'shopify_status', f.shopify_status,
        'notification_status', f.notification_status, 'notification_note', f.notification_note, 'line_items', f.line_items,
        'attempts', f.attempts, 'last_error', f.last_error, 'fulfilled_at', f.fulfilled_at, 'synced_at', f.synced_at, 'created_at', f.created_at,
        'delivered_status', f.delivered_status, 'delivered_at', f.delivered_at, 'delivered_error', f.delivered_error)
      order by f.created_at) from public.channel_fulfillments f where f.order_id = p_order_id), '[]'::jsonb),
    'job', (select jsonb_build_object('status', j.status, 'attempts', j.attempts, 'next_attempt_at', j.next_attempt_at, 'last_error', j.last_error)
      from public.channel_sync_jobs j where j.kind = 'FULFILL' and j.ref_id = p_order_id order by j.created_at desc limit 1)
  );
end;
$$;

create or replace function public.channel_inventory_overview(p_channel_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_c public.sales_channels;
begin
  perform public.require_permission('inventory.view');
  select * into v_c from public.sales_channels where id = p_channel_id;
  if not found then
    raise exception 'NOT_FOUND: sales channel not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'channel', jsonb_build_object('id', v_c.id, 'name', v_c.name, 'status', v_c.status, 'platform', v_c.platform, 'locations', v_c.locations,
      'catalog_imported_at', v_c.catalog_imported_at, 'first_sync_at', v_c.first_sync_at, 'scopes', to_jsonb(v_c.scopes),
      'catalog_items', (select count(*) from public.channel_catalog_items where channel_id = v_c.id and removed_at is null),
      'settings', jsonb_build_object(
        'inventory_sync', public._channel_opt(v_c, 'inventory_sync', false), 'location_id', v_c.settings ->> 'location_id',
        'external_changes', coalesce(v_c.settings ->> 'external_changes', 'FLAG'),
        'fulfill_on_ship', public._channel_opt(v_c, 'fulfill_on_ship', v_c.platform = 'SHOPIFY'), 'notify_customer', public._channel_opt(v_c, 'notify_customer', true),
        'fulfill_without_tracking', public._channel_opt(v_c, 'fulfill_without_tracking', false),
        'auto_import_products', public._channel_opt(v_c, 'auto_import_products', true),
        'mark_delivered', v_c.platform = 'SHOPIFY' and public._channel_opt(v_c, 'mark_delivered', true))),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'variant_id', m.variant_id, 'external_variant_id', m.external_variant_id, 'inventory_item_id', m.inventory_item_id,
        'sku', v.sku, 'product', p.name, 'variant', v.title, 'shopify_title', concat_ws(' — ', ci.product_title, nullif(ci.variant_title, 'Default Title')),
        'on_hand', coalesce(i.on_hand, 0), 'reserved', coalesce(i.reserved, 0), 'available', greatest(coalesce(i.available, 0), 0),
        'shopify', m.shopify_available, 'last_pushed', m.last_pushed_qty, 'status', m.sync_status, 'error', m.last_error,
        'synced_at', m.synced_at, 'track_inventory', p.track_inventory,
        'difference', case when m.shopify_available is null then null else m.shopify_available - greatest(coalesce(i.available, 0), 0) end)
      order by (m.shopify_available is distinct from greatest(coalesce(i.available, 0), 0)) desc, p.name, v.title)
      from public.sales_channel_variants m
      join public.product_variants v on v.id = m.variant_id
      join public.products p on p.id = v.product_id
      left join public.inventory i on i.variant_id = m.variant_id
      left join public.channel_catalog_items ci on ci.channel_id = m.channel_id and ci.external_variant_id = m.external_variant_id
      where m.channel_id = p_channel_id), '[]'::jsonb),
    'unmapped', coalesce((select jsonb_agg(jsonb_build_object('external_variant_id', ci.external_variant_id, 'sku', ci.sku,
        'title', concat_ws(' — ', ci.product_title, nullif(ci.variant_title, 'Default Title')), 'status', ci.product_status,
        'available', (select (l ->> 'available')::int from jsonb_array_elements(ci.levels) l where l ->> 'location_id' = v_c.settings ->> 'location_id' limit 1),
        'reason', case when ci.sku is null then 'NO_SKU'
                       when (select count(*) from public.channel_catalog_items c2 where c2.channel_id = ci.channel_id and lower(c2.sku) = lower(ci.sku) and c2.removed_at is null) > 1 then 'DUPLICATE_SKU_SHOPIFY'
                       when (select count(*) from public.product_variants v2 where lower(v2.sku) = lower(ci.sku) and v2.is_active) > 1 then 'DUPLICATE_SKU_HERE'
                       else 'NO_MATCH' end) order by ci.product_title, ci.variant_title)
      from public.channel_catalog_items ci
      where ci.channel_id = p_channel_id and ci.removed_at is null
        and not exists (select 1 from public.sales_channel_variants m where m.channel_id = ci.channel_id and m.external_variant_id = ci.external_variant_id)), '[]'::jsonb),
    'jobs', jsonb_build_object(
      'pending', (select count(*) from public.channel_sync_jobs where channel_id = p_channel_id and status in ('PENDING', 'RUNNING')),
      'failed', (select count(*) from public.channel_sync_jobs where channel_id = p_channel_id and status = 'FAILED')),
    'recent_jobs', coalesce((select jsonb_agg(jsonb_build_object('id', j.id, 'kind', j.kind, 'status', j.status, 'attempts', j.attempts,
        'last_error', j.last_error, 'updated_at', j.updated_at, 'ref_id', j.ref_id,
        'label', case when j.kind = 'FULFILL' then (select order_number from public.orders where id = j.ref_id)
                      else (select coalesce(pv.sku, pv.title) from public.product_variants pv where pv.id = j.ref_id) end)
        order by j.updated_at desc)
      from (select * from public.channel_sync_jobs where channel_id = p_channel_id order by updated_at desc limit 30) j), '[]'::jsonb),
    'fulfillments', coalesce((select jsonb_agg(x order by x ->> 'created_at' desc) from (
        select jsonb_build_object('order_id', f.order_id, 'order_number', o.order_number, 'status', f.status, 'source', f.source,
          'courier', f.courier, 'tracking_number', f.tracking_number, 'tracking_url', f.tracking_url, 'notification_status', f.notification_status,
          'last_error', f.last_error, 'created_at', f.created_at, 'fulfilled_at', f.fulfilled_at,
          'delivered_status', f.delivered_status, 'delivered_at', f.delivered_at, 'delivered_error', f.delivered_error) as x
        from public.channel_fulfillments f join public.orders o on o.id = f.order_id
        where f.channel_id = p_channel_id order by f.created_at desc limit 30) q), '[]'::jsonb)
  );
end;
$$;

-- The store's products for "Import products" (removed ones left out).
create or replace function public.channel_catalog_products(p_channel_id uuid, p_search text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_loc text;
begin
  perform public.require_permission('products.view');
  select settings ->> 'location_id' into v_loc from public.sales_channels where id = p_channel_id;
  return coalesce((
    select jsonb_agg(x order by x ->> 'title') from (
      select jsonb_build_object(
        'product_id', ci.external_product_id,
        'title', max(ci.product_title),
        'status', max(ci.product_status),
        'image_url', coalesce(max(ci.image_url), max(ci.images ->> 0)),
        'variants', count(*),
        'linked', count(m.variant_id),
        'price', min(ci.price),
        'cost', min(ci.unit_cost),
        'vendor', max(ci.vendor),
        'stock', sum(case when ci.tracked then (select (l ->> 'available')::int from jsonb_array_elements(ci.levels) l
                   where l ->> 'location_id' = coalesce(v_loc, l ->> 'location_id') limit 1) end),
        'skus', (array_agg(ci.sku order by ci.external_variant_id) filter (where ci.sku is not null))[1:3]) as x
      from public.channel_catalog_items ci
      left join public.sales_channel_variants m on m.channel_id = ci.channel_id and m.external_variant_id = ci.external_variant_id
      where ci.channel_id = p_channel_id and ci.external_product_id is not null and ci.removed_at is null
        and (p_search is null or ci.product_title ilike '%' || p_search || '%' or ci.sku ilike '%' || p_search || '%')
      group by ci.external_product_id
      limit 1000) q), '[]'::jsonb);
end;
$$;

revoke all on function public._channel_catalog_put(uuid, jsonb), public._channel_link_by_sku(uuid),
  public.channel_catalog_import(uuid, jsonb, jsonb), public.channel_catalog_product_upsert(uuid, text, jsonb),
  public._channel_fill_blanks(uuid, public.channel_catalog_items), public._channel_catalog_adopt(uuid, text[], boolean, boolean, text),
  public.channel_catalog_adopt(uuid, text[], boolean, boolean), public._channel_autoimport(uuid, text[]),
  public.channel_first_sync(uuid, text, boolean, boolean), public._channel_first_sync_run(uuid, text, boolean), public._queue_channel_delivered(uuid), public._orders_channel_delivered_trigger(),
  public.channel_fulfillment_context(uuid), public.channel_fulfillment_update(uuid, jsonb), public.channel_fulfillment_retry(uuid),
  public.channel_sync_settings_save(uuid, jsonb), public.order_channel_info(uuid), public.channel_inventory_overview(uuid),
  public.channel_catalog_products(uuid, text)
from public, anon, authenticated;
grant execute on function public.channel_catalog_import(uuid, jsonb, jsonb), public.channel_catalog_product_upsert(uuid, text, jsonb),
  public.channel_fulfillment_context(uuid), public.channel_fulfillment_update(uuid, jsonb)
to service_role;
grant execute on function public.channel_catalog_adopt(uuid, text[], boolean, boolean), public.channel_first_sync(uuid, text, boolean, boolean),
  public.channel_fulfillment_retry(uuid), public.channel_sync_settings_save(uuid, jsonb), public.order_channel_info(uuid),
  public.channel_inventory_overview(uuid), public.channel_catalog_products(uuid, text)
to authenticated, service_role;
