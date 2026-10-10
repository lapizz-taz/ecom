-- Store order numbers and the full store catalog.
--
-- 1. Orders imported from Shopify / WooCommerce keep the store's own number (Shopify #10768 → order 10768)
--    instead of a new number from this app's counter. If that number is already used here (e.g. two stores
--    both have #1001), the order falls back to the normal counter and the store number stays on the order.
-- 2. Archived store products are imported too (as Archived here), so "products in the store" and
--    "products imported" match. Before, archived products were skipped without saying so.
-- 3. channel_catalog_summary: store totals next to what is here, with the reason for anything missing.

-- 1. Store order numbers ----------------------------------------------------------------------------------

-- The importer sets app.order_number for the insert it is about to do; nothing else sets it.
create or replace function public._orders_store_number()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_num text := coalesce(current_setting('app.order_number', true), '');
begin
  if v_num ~ '^[A-Z0-9][A-Z0-9-]{0,29}$' then
    new.order_number := v_num;
  end if;
  return new;
end;
$$;
create or replace trigger orders_store_number before insert on public.orders
  for each row execute function public._orders_store_number();

create or replace function public.channel_ingest_order(p_channel_id uuid, p_order jsonb, p_via text default 'WEBHOOK')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_channel public.sales_channels;
  v_ext text := nullif(trim(coalesce(p_order ->> 'external_id', '')), '');
  v_import public.channel_order_imports;
  v_fix jsonb;
  v_o jsonb;
  v_items jsonb := '[]'::jsonb;
  v_line jsonb;
  v_district text;
  v_subtotal numeric := 0;
  v_shipping numeric;
  v_total numeric;
  v_paid numeric;
  v_discount numeric;
  v_warnings text[] := '{}';
  v_order public.orders;
  v_platform_name text;
  v_error text;
  v_shown uuid;
  v_num text;
begin
  perform public._require_system();
  select * into v_channel from public.sales_channels where id = p_channel_id;
  if not found then
    raise exception 'NOT_FOUND: sales channel not found' using errcode = 'P0002';
  end if;
  if v_ext is null then
    raise exception 'VALIDATION: the order has no id' using errcode = '22023';
  end if;
  v_platform_name := case v_channel.platform when 'SHOPIFY' then 'Shopify' else 'WooCommerce' end;
  perform pg_advisory_xact_lock(hashtextextended('channel-order:' || p_channel_id || ':' || v_ext, 0));

  select * into v_import from public.channel_order_imports where channel_id = p_channel_id and external_id = v_ext for update;
  if found and v_import.status = 'IMPORTED' then
    return jsonb_build_object('status', 'DUPLICATE', 'import_id', v_import.id, 'order_id', v_import.order_id,
      'order_number', (select order_number from public.orders where id = v_import.order_id));
  end if;
  if not found then
    insert into public.channel_order_imports(channel_id, external_id, external_number, status, payload, received_via)
    values (p_channel_id, v_ext, p_order ->> 'number', 'FAILED', p_order, upper(coalesce(p_via, 'WEBHOOK')))
    returning * into v_import;
  else
    update public.channel_order_imports set payload = p_order, external_number = coalesce(p_order ->> 'number', external_number),
      attempts = attempts + 1, received_via = upper(coalesce(p_via, received_via))
    where id = v_import.id returning * into v_import;
  end if;

  if coalesce((p_order ->> 'cancelled')::boolean, false) then
    update public.channel_order_imports set status = 'SKIPPED', error = 'Cancelled in ' || v_platform_name || ' before it was imported'
    where id = v_import.id;
    return jsonb_build_object('status', 'SKIPPED', 'import_id', v_import.id, 'error', 'cancelled');
  end if;
  if not coalesce((v_channel.settings ->> 'import_orders')::boolean, true) and upper(coalesce(p_via, '')) <> 'RETRY' then
    update public.channel_order_imports set status = 'SKIPPED', error = 'Order import is switched off for this store' where id = v_import.id;
    return jsonb_build_object('status', 'SKIPPED', 'import_id', v_import.id, 'error', 'import off');
  end if;

  v_fix := coalesce(v_import.overrides, '{}'::jsonb);
  v_o := p_order;
  -- Shopify "#10768" → "10768"; used only when it is a plain code and not taken here yet.
  v_num := upper(regexp_replace(trim(coalesce(v_o ->> 'number', '')), '^#+\s*', ''));
  if not public._channel_opt(v_channel, 'store_order_numbers', true) or v_num !~ '^[A-Z0-9][A-Z0-9-]{0,29}$'
     or exists (select 1 from public.orders where order_number = v_num) then
    v_num := null;
  end if;
  begin
    if jsonb_typeof(v_o -> 'lines') <> 'array' or jsonb_array_length(v_o -> 'lines') = 0 then
      raise exception 'VALIDATION: the order has no products' using errcode = '22023';
    end if;
    for v_line in select * from jsonb_array_elements(v_o -> 'lines') loop
      continue when coalesce((v_line ->> 'quantity')::int, 0) <= 0;
      v_items := v_items || jsonb_build_object(
        'variant_id', public._channel_variant(v_channel, v_line),
        'quantity', (v_line ->> 'quantity')::int,
        'unit_price', public.money(greatest(coalesce(nullif(v_line ->> 'unit_price', '')::numeric, 0), 0)));
      v_subtotal := v_subtotal + public.money(greatest(coalesce(nullif(v_line ->> 'unit_price', '')::numeric, 0), 0)) * (v_line ->> 'quantity')::int;
    end loop;
    if jsonb_array_length(v_items) = 0 then
      raise exception 'VALIDATION: the order has no products to ship' using errcode = '22023';
    end if;

    v_district := coalesce(nullif(v_fix ->> 'district', ''),
      public._bd_district(array[v_o #>> '{shipping,district_hint}', v_o #>> '{shipping,city}', v_o #>> '{shipping,state}',
                                v_o #>> '{shipping,area}', v_o #>> '{shipping,address}']));
    if v_district is null then
      raise exception 'DISTRICT_UNKNOWN: could not tell the district from "%". Choose it and import again',
        concat_ws(', ', nullif(v_o #>> '{shipping,city}', ''), nullif(v_o #>> '{shipping,state}', '')) using errcode = '22023';
    end if;

    v_shipping := greatest(coalesce(nullif(v_o ->> 'shipping_price', '')::numeric, 0), 0);
    v_total := coalesce(nullif(v_o ->> 'total', '')::numeric, v_subtotal + v_shipping);
    v_discount := greatest(v_subtotal + v_shipping - v_total, 0);
    if v_discount > v_subtotal then
      v_shipping := greatest(v_shipping - (v_discount - v_subtotal), 0);
      v_discount := v_subtotal;
    end if;
    if v_total > v_subtotal + v_shipping + 0.009 then
      v_warnings := v_warnings || format('%s total %s is higher than products + delivery (%s): taxes or fees were not imported',
                                         v_platform_name, v_total, v_subtotal + v_shipping);
    end if;
    v_paid := least(greatest(coalesce(nullif(v_o ->> 'paid_amount', '')::numeric, 0), 0), v_total);

    perform set_config('app.order_number', coalesce(v_num, ''), true);
    v_order := public._create_order(jsonb_build_object(
      'customer', jsonb_build_object(
        'full_name', coalesce(nullif(trim(v_fix ->> 'name'), ''), nullif(trim(v_o #>> '{customer,name}'), ''), 'Customer'),
        'phone', coalesce(nullif(v_fix ->> 'phone', ''), v_o #>> '{customer,phone}'),
        'email', nullif(v_o #>> '{customer,email}', '')),
      'shipping', jsonb_build_object(
        'address', coalesce(nullif(trim(v_fix ->> 'address'), ''), nullif(trim(v_o #>> '{shipping,address}'), ''), ''),
        'district', v_district,
        'area', nullif(v_o #>> '{shipping,area}', ''),
        'city', nullif(v_o #>> '{shipping,city}', ''),
        'postal_code', nullif(v_o #>> '{shipping,postal_code}', '')),
      'items', v_items,
      'delivery_charge', v_shipping,
      'manual_discount', v_discount,
      'payment_method', case when v_paid >= v_total and v_total > 0 then 'FULL_PAYMENT' when v_paid > 0 then 'ADVANCE' else 'COD' end,
      'customer_note', nullif(trim(coalesce(v_o ->> 'note', '')), ''),
      'idempotency_key', 'channel:' || p_channel_id || ':' || v_ext,
      'utm', jsonb_build_object('source', v_o #>> '{attribution,last_touch,params,utm_source}',
                                'medium', v_o #>> '{attribution,last_touch,params,utm_medium}',
                                'campaign', v_o #>> '{attribution,last_touch,params,utm_campaign}'),
      'internal_note', format('Imported from %s %s (%s)', v_platform_name, coalesce(v_o ->> 'number', v_ext), v_channel.name)
        || case when v_num is null and nullif(v_o ->> 'number', '') is not null
             then format(E'\n%s number %s is already used here, so this order got its own number', v_platform_name, v_o ->> 'number') else '' end
        || coalesce(E'\n' || array_to_string(v_warnings, E'\n'), '')
    ), 'API');
    perform set_config('app.order_number', '', true);

    update public.orders set sales_channel_id = p_channel_id, external_order_id = v_ext, external_order_number = v_o ->> 'number'
    where id = v_order.id;

    if v_paid > 0 then
      perform public.record_order_payment(v_order.id, case when v_paid >= v_order.total_amount then 'FULL' else 'ADVANCE' end::public.order_payment_kind,
        'GATEWAY', least(v_paid, v_order.total_amount), coalesce(v_o ->> 'number', v_ext),
        format('Paid in %s%s', v_platform_name, coalesce(' via ' || nullif(v_o ->> 'gateway', ''), '')),
        'channel-pay:' || p_channel_id || ':' || v_ext);
    end if;
  exception when others then
    perform set_config('app.order_number', '', true);
    v_error := regexp_replace(sqlerrm, '^[A-Z_]+: ', '');
    update public.channel_order_imports set status = 'FAILED', error = left(v_error, 500), order_id = null
    where id = v_import.id;
    update public.sales_channels set last_order_at = now() where id = p_channel_id;
    return jsonb_build_object('status', 'FAILED', 'import_id', v_import.id, 'error', v_error);
  end;

  if jsonb_typeof(v_o -> 'attribution') = 'object' then
    begin
      perform public.record_order_attribution(v_order.id, v_o -> 'attribution');
    exception when others then
      v_warnings := v_warnings || ('Source not recorded: ' || sqlerrm);
    end;
  end if;

  update public.channel_order_imports set status = 'IMPORTED', order_id = v_order.id, error = null, warnings = v_warnings
  where id = v_import.id;
  update public.sales_channels set orders_imported = orders_imported + 1, last_order_at = now() where id = p_channel_id;

  v_shown := public._after_order_created(v_order.id);

  return jsonb_build_object('status', 'IMPORTED', 'import_id', v_import.id, 'order_id', v_order.id, 'order_number', v_order.order_number,
    'phone', v_order.customer_phone, 'total', v_order.total_amount, 'warnings', to_jsonb(v_warnings),
    'merged_into', case when v_shown is distinct from v_order.id then (select order_number from public.orders where id = v_shown) end);
end;
$$;

-- 2. Archived store products are imported too ------------------------------------------------------------

create or replace function public._channel_store_status(p_status text)
returns public.product_status
language sql
immutable
set search_path = public, pg_temp
as $$
  select case when upper(coalesce(p_status, 'ACTIVE')) in ('ACTIVE', 'PUBLISH') then 'ACTIVE'
              when upper(p_status) = 'ARCHIVED' then 'ARCHIVED'
              else 'DRAFT' end::public.product_status
$$;

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
            public._channel_store_status(v_first.product_status),
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
    and upper(coalesce(ci.product_status, 'ACTIVE')) <> 'TRASH'
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

  update public.sales_channels set settings = settings || jsonb_build_object('location_id', p_location_id, 'inventory_sync', false)
  where id = p_channel_id;
  perform public._channel_link_by_sku(p_channel_id);

  select coalesce(array_agg(distinct ci.external_product_id), '{}') into v_ids
  from public.channel_catalog_items ci
  where ci.channel_id = p_channel_id and ci.removed_at is null and ci.external_product_id is not null
    and upper(coalesce(ci.product_status, 'ACTIVE')) <> 'TRASH'
    and not exists (select 1 from public.sales_channel_variants m where m.channel_id = ci.channel_id and m.external_variant_id = ci.external_variant_id);
  v_adopt := case when coalesce(array_length(v_ids, 1), 0) > 0
    then public._channel_catalog_adopt(p_channel_id, v_ids[1:2000], true, true, p_location_id)
    else jsonb_build_object('created', 0, 'linked', 0, 'plan', '[]'::jsonb) end;

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

  perform public._channel_fill_blanks(m.variant_id, ci)
  from public.sales_channel_variants m
  join public.channel_catalog_items ci on ci.channel_id = m.channel_id and ci.external_variant_id = m.external_variant_id
  where m.channel_id = p_channel_id;

  update public.sales_channels set first_sync_at = now(),
    settings = settings || jsonb_build_object('location_id', p_location_id, 'inventory_sync', true, 'auto_import_products', coalesce(p_auto_import, true))
  where id = p_channel_id;
  perform public.channel_job_enqueue(p_channel_id, 'INVENTORY', m.variant_id)
  from public.sales_channel_variants m
  left join public.inventory i on i.variant_id = m.variant_id
  where m.channel_id = p_channel_id and m.inventory_item_id is not null and m.sync_status <> 'UNTRACKED'
    and m.shopify_available is distinct from greatest(coalesce(i.available, 0), 0);

  return jsonb_build_object(
    'store', v_store, 'location_id', p_location_id,
    'products', (select count(distinct x ->> 'product_id') from jsonb_array_elements(v_adopt -> 'plan') x where x ->> 'action' = 'CREATE'),
    'create', (select count(*) from jsonb_array_elements(v_adopt -> 'plan') x where x ->> 'action' = 'CREATE'),
    'link', greatest((select count(*) from public.sales_channel_variants where channel_id = p_channel_id and inventory_item_id is not null)
            - v_linked_before - coalesce((v_adopt ->> 'created')::int, 0), 0),
    'already_linked', v_linked_before,
    'untracked', (select count(*) from public.channel_catalog_items where channel_id = p_channel_id and removed_at is null and not tracked),
    'stock_changes', v_stock,
    'items', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (select x from jsonb_array_elements(v_adopt -> 'plan') x
              where x ->> 'action' in ('CREATE', 'LINK') limit 300) q));
end;
$$;

-- 3. Store totals next to what is here ---------------------------------------------------------------------

create or replace function public.channel_catalog_summary(p_channel_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_c public.sales_channels;
begin
  perform public.require_permission('products.view');
  select * into v_c from public.sales_channels where id = p_channel_id;
  if not found then
    raise exception 'NOT_FOUND: sales channel not found' using errcode = 'P0002';
  end if;
  return (
    with items as (
      select ci.*, exists (select 1 from public.sales_channel_variants m
                           where m.channel_id = ci.channel_id and m.external_variant_id = ci.external_variant_id) as here
      from public.channel_catalog_items ci
      where ci.channel_id = p_channel_id and ci.removed_at is null and ci.external_product_id is not null
    ), prods as (
      select external_product_id, max(product_title) as title, upper(coalesce(max(product_status), 'ACTIVE')) as status,
        count(*) as variants, count(*) filter (where here) as here
      from items group by external_product_id
    )
    select jsonb_build_object(
      'read_at', v_c.catalog_imported_at,
      'store_products', (select count(*) from prods),
      'store_variants', (select count(*) from items),
      'by_status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from prods group by status) s), '{}'::jsonb),
      'imported_products', (select count(*) from prods where here = variants),
      'imported_variants', (select count(*) from items where here),
      'products_here', (select count(distinct pv.product_id) from public.sales_channel_variants m
                        join public.product_variants pv on pv.id = m.variant_id where m.channel_id = p_channel_id),
      'missing', coalesce((select jsonb_agg(jsonb_build_object('product_id', external_product_id, 'title', title, 'status', status,
          'variants', variants, 'imported', here,
          'reason', case when v_c.first_sync_at is null then 'FIRST_SYNC'
                         when status = 'TRASH' then 'TRASH'
                         when not public._channel_opt(v_c, 'auto_import_products', true) then 'AUTO_IMPORT_OFF'
                         else 'NEXT_REFRESH' end) order by title)
        from (select * from prods where here < variants limit 200) q), '[]'::jsonb))
  );
end;
$$;

revoke all on function public._orders_store_number(), public.channel_ingest_order(uuid, jsonb, text), public._channel_store_status(text),
  public._channel_catalog_adopt(uuid, text[], boolean, boolean, text), public._channel_autoimport(uuid, text[]),
  public._channel_first_sync_run(uuid, text, boolean), public.channel_catalog_summary(uuid)
from public, anon, authenticated;
grant execute on function public.channel_ingest_order(uuid, jsonb, text) to service_role;
grant execute on function public.channel_catalog_summary(uuid) to authenticated, service_role;

-- 4. Never merge into an approved order ----------------------------------------------------------------------
-- An approved order may already be packed or handed to a courier, so a new order only merges with another
-- order that is still in the Web Orders list. Duplicates of approved orders are still flagged, not merged.
create or replace function public._auto_merge_web_order(p_order_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_target public.orders;
  v_hours numeric := public.setting_numeric('orders', array['auto_merge_window_hours'], 72);
  v_priority text[] := coalesce((select array_agg(x) from jsonb_array_elements_text(
      coalesce(public.get_setting('orders') -> 'merge_review_priority', '["PROCESSING","FOLLOW_UP","GOOD_NO_RESPONSE","NO_RESPONSE"]'::jsonb)) x), '{}');
  v_web constant public.order_status[] := array['PENDING', 'CONFIRMATION_REQUIRED']::public.order_status[];
begin
  if not public.setting_bool('orders', array['auto_merge_web_enabled'], true) then
    return null;
  end if;
  select * into v_order from public.orders where id = p_order_id;
  if not found or v_order.customer_phone is null then
    return null;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('order-merge:' || v_order.customer_phone, 0));
  select * into v_order from public.orders where id = p_order_id for update;
  if v_order.confirmed_at is not null or v_order.merged_into is not null or not (v_order.status = any(v_web))
     or not (v_order.review_status = any(v_priority))
     or v_order.amount_paid > 0 or v_order.coupon_id is not null
     or coalesce(v_order.manual_discount, 0) > 0 or coalesce(v_order.coupon_discount, 0) > 0
     or exists (select 1 from public.payments where order_id = v_order.id and status = 'REQUIRES_VERIFICATION')
     or exists (select 1 from public.shipments where order_id = v_order.id and is_active) then
    return null;
  end if;

  select o.* into v_target from public.orders o
  where o.customer_phone = v_order.customer_phone
    and o.id <> v_order.id
    and o.merged_into is null
    and o.confirmed_at is null and o.status = any(v_web) and o.review_status = any(v_priority)
    and o.created_at <= v_order.created_at
    and o.created_at >= v_order.created_at - make_interval(secs => (v_hours * 3600)::int)
    and lower(o.shipping_district) is not distinct from lower(v_order.shipping_district)
    and o.label_printed_at is null
    and not exists (select 1 from public.shipments s where s.order_id = o.id and s.is_active)
  order by o.created_at
  limit 1
  for update;
  if not found then
    return null;
  end if;

  perform public._merge_web_orders(v_target.id, v_order.id,
    format('same customer %s, %s apart', v_order.customer_phone,
      case when v_order.created_at - v_target.created_at < interval '1 hour'
        then ceil(extract(epoch from v_order.created_at - v_target.created_at) / 60)::int || ' min'
        else round(extract(epoch from v_order.created_at - v_target.created_at) / 3600, 1) || ' h' end));
  return v_target.id;
end;
$$;
revoke all on function public._auto_merge_web_order(uuid) from public, anon, authenticated;

-- The checkout-time merge (same address within a few minutes) follows the same rule: never into an approved order.
create or replace function public._find_merge_target(p_payload jsonb, p_fraud_check_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_target public.orders;
  v_phone text := public.clean_phone(p_payload #>> '{customer,phone}');
  v_check public.fraud_checks;
  v_quote jsonb;
  v_eval jsonb;
  v_fraud_enabled boolean := public.setting_bool('fraud', array['enabled'], true);
begin
  if not public.setting_bool('orders', array['auto_merge_enabled'], true)
     or v_phone is null
     or nullif(trim(coalesce(p_payload ->> 'coupon_code', '')), '') is not null then
    return null;
  end if;

  select o.* into v_target
  from public.orders o
  join public.customers c on c.id = o.customer_id
  where o.customer_phone = v_phone
    and o.source = 'STOREFRONT'
    and o.merged_into is null
    and c.status <> 'BLOCKED'
    and o.created_at >= now() - make_interval(mins => public.setting_numeric('orders', array['auto_merge_minutes'], 3)::int)
    and o.confirmed_at is null
    and o.status in ('PENDING', 'FRAUD_CHECK', 'ADVANCE_REQUIRED', 'FRAUD_REVIEW', 'CONFIRMATION_REQUIRED')
    and o.payment_method = coalesce(nullif(p_payload ->> 'payment_method', ''), 'COD')::public.payment_method
    and o.delivery_method = coalesce(nullif(p_payload ->> 'delivery_method', ''), 'standard')
    and lower(o.shipping_district) = lower(trim(coalesce(p_payload #>> '{shipping,district}', '')))
    and public.normalize_address(o.shipping_address) = public.normalize_address(p_payload #>> '{shipping,address}')
    and o.label_printed_at is null
    and not exists (select 1 from public.shipments s where s.order_id = o.id and s.is_active)
  order by o.created_at desc
  limit 1
  for update of o;
  if not found then
    return null;
  end if;

  -- The merged order must not deserve a stricter decision than it already got.
  if v_fraud_enabled then
    select * into v_check from public.fraud_checks where id = p_fraud_check_id;
    if not found then
      return null;
    end if;
    v_quote := public.calculate_order_quote(p_payload -> 'items', v_target.shipping_district, v_target.shipping_area,
      v_target.delivery_method, null, v_phone, false, false);
    v_eval := public.evaluate_fraud_rules(v_check.metrics, jsonb_build_object(
      'order_value', v_target.total_amount + coalesce((v_quote ->> 'subtotal')::numeric, 0),
      'subtotal', v_target.subtotal + coalesce((v_quote ->> 'subtotal')::numeric, 0),
      'delivery_charge', v_target.delivery_charge, 'return_charge', v_target.return_charge,
      'district', v_target.shipping_district, 'area', v_target.shipping_area,
      'payment_method', v_target.payment_method, 'source', v_target.source));
    if public.decision_severity((v_eval ->> 'decision')::public.fraud_decision)
         > public.decision_severity(coalesce(v_target.fraud_decision, 'ALLOW'))
       or coalesce((v_eval ->> 'advance_amount')::numeric, 0) > v_target.advance_required then
      return null;
    end if;
  end if;
  return v_target;
end;
$$;
revoke all on function public._find_merge_target(jsonb, uuid) from public, anon, authenticated;
