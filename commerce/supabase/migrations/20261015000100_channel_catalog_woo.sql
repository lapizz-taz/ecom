-- =============================================================================
-- Store catalogs (Shopify and WooCommerce): stock sync for WooCommerce, and
-- importing a store's products into this app's catalog.
--
-- WooCommerce stock uses the same queue, mapping and reconciliation as
-- Shopify. A WooCommerce store has one stock figure per product / variation,
-- shown as the single location "default". Its inventory item is the REST path
-- of the product ("products/12") or variation ("products/12/variations/34").
--
-- WooCommerce fulfilment (order → Completed, with the courier and tracking in
-- a customer note) is off unless staff turn it on for that store.
--
-- Importing products: staff pick store products; a preview lists what will be
-- created; applying creates products and variants here (prices, options,
-- image), links them to the store and, only when asked, records the store's
-- quantity as opening stock (a movement in the history, never a silent set).
-- =============================================================================

alter table public.channel_catalog_items add column if not exists price numeric(12,2);
alter table public.channel_catalog_items add column if not exists compare_at_price numeric(12,2);
alter table public.channel_catalog_items add column if not exists image_url text;
alter table public.channel_catalog_items add column if not exists options jsonb not null default '{}'::jsonb;
alter table public.channel_catalog_items add column if not exists product_description text;
create index if not exists channel_catalog_items_product_idx on public.channel_catalog_items(channel_id, external_product_id);

-- -----------------------------------------------------------------------------
-- Catalog import keeps prices, options and image too (for importing products).
-- -----------------------------------------------------------------------------
create or replace function public.channel_catalog_import(p_channel_id uuid, p_items jsonb, p_locations jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_loc text;
  v_linked int := 0;
begin
  perform public._require_system();
  select settings ->> 'location_id' into v_loc from public.sales_channels where id = p_channel_id;
  update public.sales_channels set locations = coalesce(p_locations, '[]'::jsonb), catalog_imported_at = now() where id = p_channel_id;
  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    insert into public.channel_catalog_items(channel_id, external_variant_id, external_product_id, inventory_item_id, sku, barcode,
      product_title, variant_title, product_status, tracked, levels, imported_at, price, compare_at_price, image_url, options, product_description)
    values (p_channel_id, v_item ->> 'external_variant_id', v_item ->> 'external_product_id', v_item ->> 'inventory_item_id',
      nullif(trim(v_item ->> 'sku'), ''), nullif(trim(v_item ->> 'barcode'), ''), v_item ->> 'product_title', v_item ->> 'variant_title',
      v_item ->> 'product_status', coalesce((v_item ->> 'tracked')::boolean, true), coalesce(v_item -> 'levels', '[]'::jsonb), now(),
      case when (v_item ->> 'price') ~ '^[0-9]+(\.[0-9]+)?$' then public.money((v_item ->> 'price')::numeric) end,
      case when (v_item ->> 'compare_at_price') ~ '^[0-9]+(\.[0-9]+)?$' then public.money((v_item ->> 'compare_at_price')::numeric) end,
      case when (v_item ->> 'image_url') ~ '^https://' then left(v_item ->> 'image_url', 1000) end,
      case when jsonb_typeof(v_item -> 'options') = 'object' then v_item -> 'options' else '{}'::jsonb end,
      left(nullif(trim(v_item ->> 'product_description'), ''), 5000))
    on conflict (channel_id, external_variant_id) do update set
      external_product_id = excluded.external_product_id, inventory_item_id = excluded.inventory_item_id, sku = excluded.sku,
      barcode = excluded.barcode, product_title = excluded.product_title, variant_title = excluded.variant_title,
      product_status = excluded.product_status, tracked = excluded.tracked, levels = excluded.levels, imported_at = now(),
      price = excluded.price, compare_at_price = excluded.compare_at_price, image_url = excluded.image_url, options = excluded.options,
      product_description = excluded.product_description;
  end loop;

  -- Existing links (from imported orders) get the inventory item and SKU.
  update public.sales_channel_variants m set inventory_item_id = ci.inventory_item_id, sku = ci.sku,
    sync_status = case when not ci.tracked then 'UNTRACKED' when m.sync_status = 'UNTRACKED' then 'NEW' else m.sync_status end,
    shopify_available = (select (l ->> 'available')::int from jsonb_array_elements(ci.levels) l where l ->> 'location_id' = v_loc limit 1)
  from public.channel_catalog_items ci
  where ci.channel_id = p_channel_id and m.channel_id = p_channel_id and m.external_variant_id = ci.external_variant_id;

  -- New links: one store SKU ↔ exactly one active variant of ours.
  insert into public.sales_channel_variants(channel_id, external_variant_id, external_product_id, variant_id, inventory_item_id, sku,
    shopify_available, sync_status)
  select ci.channel_id, ci.external_variant_id, ci.external_product_id, v.id, ci.inventory_item_id, ci.sku,
    (select (l ->> 'available')::int from jsonb_array_elements(ci.levels) l where l ->> 'location_id' = v_loc limit 1),
    case when ci.tracked then 'NEW' else 'UNTRACKED' end
  from public.channel_catalog_items ci
  join public.product_variants v on lower(v.sku) = lower(ci.sku) and v.is_active
  where ci.channel_id = p_channel_id and ci.sku is not null
    and not exists (select 1 from public.sales_channel_variants m where m.channel_id = ci.channel_id and m.external_variant_id = ci.external_variant_id)
    and (select count(*) from public.product_variants v2 where lower(v2.sku) = lower(ci.sku) and v2.is_active) = 1
    and (select count(*) from public.channel_catalog_items c2 where c2.channel_id = ci.channel_id and lower(c2.sku) = lower(ci.sku)) = 1
  on conflict do nothing;
  get diagnostics v_linked = row_count;

  return jsonb_build_object('items', jsonb_array_length(coalesce(p_items, '[]'::jsonb)), 'linked', v_linked,
    'mapped', (select count(*) from public.sales_channel_variants where channel_id = p_channel_id and inventory_item_id is not null));
end;
$$;

-- -----------------------------------------------------------------------------
-- Fulfilment: Shopify on by default; WooCommerce only when turned on.
-- -----------------------------------------------------------------------------
create or replace function public._queue_channel_fulfillment(p_order_id uuid)
returns uuid
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
    return null;
  end if;
  select * into v_channel from public.sales_channels where id = v_order.sales_channel_id;
  if not public._channel_opt(v_channel, 'fulfill_on_ship', v_channel.platform = 'SHOPIFY') then
    return null;
  end if;
  insert into public.channel_fulfillments(channel_id, order_id, external_order_id, status)
  values (v_channel.id, v_order.id, v_order.external_order_id, 'PENDING')
  on conflict (order_id) where source = 'APP' do update
    set status = case when channel_fulfillments.status in ('FULFILLED', 'PROCESSING') then channel_fulfillments.status else 'PENDING' end
  returning * into v_f;
  if v_f.status = 'PENDING' then
    perform public.channel_job_enqueue(v_channel.id, 'FULFILL', v_order.id);
  end if;
  return v_f.id;
end;
$$;
revoke all on function public._queue_channel_fulfillment(uuid) from public, anon, authenticated;

-- Order page and settings show the store's real default.
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
      'fulfill_on_ship', public._channel_opt(c, 'fulfill_on_ship', c.platform = 'SHOPIFY'), 'notify_customer', public._channel_opt(c, 'notify_customer', true))
      from public.sales_channels c where c.id = v_order.sales_channel_id),
    'external_order_id', v_order.external_order_id, 'external_order_number', v_order.external_order_number,
    'fulfillments', coalesce((select jsonb_agg(jsonb_build_object(
        'id', f.id, 'source', f.source, 'status', f.status, 'fulfillment_id', f.fulfillment_id, 'courier', f.courier,
        'tracking_number', f.tracking_number, 'tracking_url', f.tracking_url, 'shopify_status', f.shopify_status,
        'notification_status', f.notification_status, 'notification_note', f.notification_note, 'line_items', f.line_items,
        'attempts', f.attempts, 'last_error', f.last_error, 'fulfilled_at', f.fulfilled_at, 'synced_at', f.synced_at, 'created_at', f.created_at)
      order by f.created_at) from public.channel_fulfillments f where f.order_id = p_order_id), '[]'::jsonb),
    'job', (select jsonb_build_object('status', j.status, 'attempts', j.attempts, 'next_attempt_at', j.next_attempt_at, 'last_error', j.last_error)
      from public.channel_sync_jobs j where j.kind = 'FULFILL' and j.ref_id = p_order_id order by j.created_at desc limit 1)
  );
end;
$$;
revoke all on function public.order_channel_info(uuid) from public, anon;
grant execute on function public.order_channel_info(uuid) to authenticated;

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
  return v_row;
end;
$$;
revoke all on function public.channel_fulfillment_update(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.channel_fulfillment_update(uuid, jsonb) to service_role;

-- -----------------------------------------------------------------------------
-- Sync screen: the platform, and WooCommerce fulfilment off unless turned on.
-- -----------------------------------------------------------------------------
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
      'catalog_imported_at', v_c.catalog_imported_at, 'scopes', to_jsonb(v_c.scopes),
      'settings', jsonb_build_object(
        'inventory_sync', public._channel_opt(v_c, 'inventory_sync', false), 'location_id', v_c.settings ->> 'location_id',
        'external_changes', coalesce(v_c.settings ->> 'external_changes', 'FLAG'),
        'fulfill_on_ship', public._channel_opt(v_c, 'fulfill_on_ship', v_c.platform = 'SHOPIFY'), 'notify_customer', public._channel_opt(v_c, 'notify_customer', true),
        'fulfill_without_tracking', public._channel_opt(v_c, 'fulfill_without_tracking', false))),
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
                       when (select count(*) from public.channel_catalog_items c2 where c2.channel_id = ci.channel_id and lower(c2.sku) = lower(ci.sku)) > 1 then 'DUPLICATE_SKU_SHOPIFY'
                       when (select count(*) from public.product_variants v2 where lower(v2.sku) = lower(ci.sku) and v2.is_active) > 1 then 'DUPLICATE_SKU_HERE'
                       else 'NO_MATCH' end) order by ci.product_title, ci.variant_title)
      from public.channel_catalog_items ci
      where ci.channel_id = p_channel_id
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
          'last_error', f.last_error, 'created_at', f.created_at, 'fulfilled_at', f.fulfilled_at) as x
        from public.channel_fulfillments f join public.orders o on o.id = f.order_id
        where f.channel_id = p_channel_id order by f.created_at desc limit 30) q), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.channel_inventory_overview(uuid) from public, anon;
grant execute on function public.channel_inventory_overview(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Import store products into this app's catalog.
--   p_product_ids: the store's product ids (all variants of each come along).
--   p_with_stock:  record the store's quantity as opening stock here.
--   p_apply:       false → only the plan.
-- Variants whose SKU already exists here are linked, not created again.
-- -----------------------------------------------------------------------------
create or replace function public.channel_catalog_adopt(p_channel_id uuid, p_product_ids text[], p_with_stock boolean default false, p_apply boolean default false)
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
begin
  perform public.require_permission('products.manage');
  if p_with_stock then
    perform public.require_permission('inventory.adjust');
  end if;
  select * into v_c from public.sales_channels where id = p_channel_id;
  if not found then
    raise exception 'NOT_FOUND: sales channel not found' using errcode = 'P0002';
  end if;
  if coalesce(array_length(p_product_ids, 1), 0) = 0 then
    raise exception 'VALIDATION: choose at least one product' using errcode = '22023';
  end if;
  if array_length(p_product_ids, 1) > 500 then
    raise exception 'VALIDATION: import at most 500 products at a time' using errcode = '22023';
  end if;
  v_prefix := case v_c.platform when 'SHOPIFY' then 'SHOP' else 'WOO' end;

  foreach v_pid in array p_product_ids loop
    select * into v_first from public.channel_catalog_items where channel_id = p_channel_id and external_product_id = v_pid
    order by external_variant_id limit 1;
    continue when not found;
    v_product := null;
    v_pos := 0;
    -- Options in the order the store lists them.
    select coalesce(array_agg(k order by k), '{}') into v_opts
    from (select distinct jsonb_object_keys(options) k from public.channel_catalog_items where channel_id = p_channel_id and external_product_id = v_pid) o;

    for v_ci in select * from public.channel_catalog_items where channel_id = p_channel_id and external_product_id = v_pid order by external_variant_id loop
      -- Already linked to one of ours: nothing to do.
      if exists (select 1 from public.sales_channel_variants m join public.product_variants pv on pv.id = m.variant_id
                 where m.channel_id = p_channel_id and m.external_variant_id = v_ci.external_variant_id) then
        v_plan := v_plan || jsonb_build_object('product_id', v_pid, 'external_variant_id', v_ci.external_variant_id, 'action', 'ALREADY_LINKED',
          'title', concat_ws(' — ', v_ci.product_title, nullif(v_ci.variant_title, 'Default Title')), 'sku', v_ci.sku);
        continue;
      end if;
      v_sku := coalesce(v_ci.sku, v_prefix || '-' || regexp_replace(v_ci.external_variant_id, '[^A-Za-z0-9]+', '', 'g'));
      select id into v_existing from public.product_variants where lower(sku) = lower(v_sku) limit 1;
      v_qty := case when v_ci.tracked then greatest(coalesce((select (l ->> 'available')::int from jsonb_array_elements(v_ci.levels) l
                 where l ->> 'location_id' = coalesce(v_c.settings ->> 'location_id', l ->> 'location_id') limit 1), 0), 0) else 0 end;
      v_plan := v_plan || jsonb_build_object('product_id', v_pid, 'external_variant_id', v_ci.external_variant_id,
        'action', case when v_existing is not null then 'LINK' else 'CREATE' end,
        'title', concat_ws(' — ', v_ci.product_title, nullif(v_ci.variant_title, 'Default Title')), 'sku', v_sku,
        'price', v_ci.price, 'stock', case when p_with_stock and v_existing is null then v_qty end);
      continue when not p_apply;

      if v_existing is not null then
        v_variant := v_existing;
        v_linked := v_linked + 1;
      else
        if v_product is null then
          insert into public.products(name, slug, status, price, compare_at_price, description, option_names, track_inventory, tags, created_by)
          values (left(coalesce(nullif(trim(v_first.product_title), ''), 'Product'), 200),
            left(public.slugify(coalesce(v_first.product_title, 'product')), 60) || '-' || left(md5(p_channel_id::text || v_pid), 6),
            case when upper(coalesce(v_first.product_status, 'ACTIVE')) in ('ACTIVE', 'PUBLISH') then 'ACTIVE' else 'DRAFT' end::public.product_status,
            coalesce(v_first.price, 0), v_first.compare_at_price, v_first.product_description, v_opts,
            true, array[lower(v_c.platform::text)], auth.uid())
          returning id into v_product;
          if v_first.image_url is not null then
            insert into public.product_images(product_id, url, is_primary, position) values (v_product, v_first.image_url, true, 0);
          end if;
        end if;
        insert into public.product_variants(product_id, sku, title, option_values, price, compare_at_price, barcode, position, is_default)
        values (v_product, v_sku, coalesce(nullif(nullif(trim(v_ci.variant_title), ''), 'Default Title'), 'Default'), v_ci.options,
          v_ci.price, v_ci.compare_at_price, v_ci.barcode, v_pos, v_pos = 0)
        returning id into v_variant;
        v_pos := v_pos + 1;
        v_created := v_created + 1;
        if p_with_stock and v_qty > 0 then
          perform public._apply_inventory_movement(v_variant, 'ADJUSTMENT', v_qty, 0, 0, 'CHANNEL', p_channel_id,
            format('Opening stock from %s', v_c.name), format('Imported from %s: %s in stock there', v_c.name, v_qty), null, false);
        end if;
      end if;
      insert into public.sales_channel_variants(channel_id, external_variant_id, external_product_id, variant_id, inventory_item_id, sku,
        shopify_available, last_pushed_qty, sync_status)
      values (p_channel_id, v_ci.external_variant_id, v_pid, v_variant, v_ci.inventory_item_id, v_ci.sku,
        case when v_ci.tracked then v_qty end, case when v_ci.tracked then v_qty end,
        case when not v_ci.tracked then 'UNTRACKED' when p_with_stock and v_existing is null then 'OK' else 'NEW' end)
      on conflict (channel_id, external_variant_id) do update
        set variant_id = excluded.variant_id, inventory_item_id = excluded.inventory_item_id, sku = excluded.sku;
    end loop;
  end loop;

  if p_apply then
    perform public.log_audit('channel.catalog_adopt', 'sales_channel', p_channel_id::text, null,
      jsonb_build_object('products', p_product_ids, 'created', v_created, 'linked', v_linked, 'with_stock', p_with_stock));
  end if;
  return jsonb_build_object('applied', p_apply, 'created', v_created, 'linked', v_linked, 'plan', v_plan);
end;
$$;
revoke all on function public.channel_catalog_adopt(uuid, text[], boolean, boolean) from public, anon;
grant execute on function public.channel_catalog_adopt(uuid, text[], boolean, boolean) to authenticated;

-- The store's products not yet in this catalog (grouped by product).
create or replace function public.channel_catalog_products(p_channel_id uuid, p_search text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('products.view');
  return coalesce((
    select jsonb_agg(x order by x ->> 'title') from (
      select jsonb_build_object(
        'product_id', ci.external_product_id,
        'title', max(ci.product_title),
        'status', max(ci.product_status),
        'image_url', max(ci.image_url),
        'variants', count(*),
        'linked', count(m.variant_id),
        'price', min(ci.price),
        'stock', sum(case when ci.tracked then (select (l ->> 'available')::int from jsonb_array_elements(ci.levels) l limit 1) end),
        'skus', (array_agg(ci.sku order by ci.external_variant_id) filter (where ci.sku is not null))[1:3]) as x
      from public.channel_catalog_items ci
      left join public.sales_channel_variants m on m.channel_id = ci.channel_id and m.external_variant_id = ci.external_variant_id
      where ci.channel_id = p_channel_id and ci.external_product_id is not null
        and (p_search is null or ci.product_title ilike '%' || p_search || '%' or ci.sku ilike '%' || p_search || '%')
      group by ci.external_product_id
      limit 1000) q), '[]'::jsonb);
end;
$$;
revoke all on function public.channel_catalog_products(uuid, text) from public, anon;
grant execute on function public.channel_catalog_products(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- Explicit Shopify order actions (mark paid, cancel): never automatic. The
-- edge function checks the staff permission, asks Shopify, then records what
-- Shopify answered on the order's history.
-- -----------------------------------------------------------------------------
create or replace function public.channel_order_action_context(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
begin
  perform public._require_system();
  select * into v_order from public.orders where id = p_order_id;
  if not found then
    raise exception 'NOT_FOUND: order not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object('order_id', v_order.id, 'order_number', v_order.order_number, 'status', v_order.status,
    'channel_id', v_order.sales_channel_id, 'external_order_id', v_order.external_order_id,
    'platform', (select platform from public.sales_channels where id = v_order.sales_channel_id));
end;
$$;

create or replace function public.channel_order_action_record(p_order_id uuid, p_action text, p_actor uuid, p_detail jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._require_system();
  if p_action not in ('MARK_PAID', 'CANCEL') then
    raise exception 'VALIDATION: unknown action' using errcode = '22023';
  end if;
  perform public._order_log(p_order_id, 'CHANNEL_ACTION',
    case p_action when 'MARK_PAID' then format('Marked paid on Shopify (Shopify now shows %s)', coalesce(p_detail ->> 'financial_status', 'paid'))
                  else 'Cancel sent to Shopify (no refund or restock on Shopify; stock follows this app)' end,
    null, null, p_detail);
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, new_values)
  values (p_actor, 'channel.order_' || lower(p_action), 'order', p_order_id::text, p_detail);
end;
$$;
revoke all on function public.channel_order_action_context(uuid), public.channel_order_action_record(uuid, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.channel_order_action_context(uuid), public.channel_order_action_record(uuid, text, uuid, jsonb) to service_role;
