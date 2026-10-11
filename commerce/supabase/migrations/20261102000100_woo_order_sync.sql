-- WooCommerce orders follow the order here, like Shopify ones: Confirmed, Shipped,
-- Delivered, Partially delivered, Return in transit, Returned and Cancelled are set on the
-- WooCommerce order (the Fullfilio Connect plugin adds the statuses WooCommerce lacks).
--
-- Stock, never counted twice:
--   * When this app keeps the store's stock in step (inventory sync on), WooCommerce's
--     own restock on cancel is switched off by the plugin and the store gets our count.
--   * Otherwise WooCommerce keeps its own stock: a cancel restores it the WooCommerce way
--     (only what WooCommerce took off), and items that came back here as good (returned
--     or the undelivered part of a partial delivery) are put back by the plugin. The plugin
--     records what it put back per order line, so a retry or a second return adds only the
--     difference, and never more than WooCommerce took off for that line.
--
-- Replaces the Delivered / Returned-only status push (channel_status_pushes stays as
-- history). Also: a delivered or returned earlier order is a past order, not a duplicate.

alter table public.channel_order_sync add column if not exists store_status text;
alter table public.channel_order_sync add column if not exists store_status_error text;
alter table public.channel_order_sync add column if not exists store_status_at timestamptz;
alter table public.channel_order_sync add column if not exists store_restock jsonb;

drop trigger if exists orders_woo_status_push on public.orders;

-- Plugin switches: tell it whether this app keeps the store's stock.
create or replace function public._plugin_config(p_settings jsonb)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'order_events', true, 'capture_leads', true, 'attribution', true, 'custom_statuses', true,
    'shield', false, 'shield_fail_open', true, 'shield_timeout', 4)
    || coalesce(p_settings -> 'plugin_config', '{}'::jsonb)
    || jsonb_build_object('stock_sync', coalesce((p_settings ->> 'inventory_sync')::boolean, false))
$$;

-- Queue the store update for one store order (Shopify and WooCommerce).
create or replace function public._queue_channel_order_sync(p_order_id uuid, p_cancel boolean default false)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_channel public.sales_channels;
begin
  select * into v_order from public.orders where id = p_order_id;
  if v_order.sales_channel_id is null or v_order.external_order_id is null then
    return;
  end if;
  select * into v_channel from public.sales_channels where id = v_order.sales_channel_id;
  if v_channel.platform not in ('SHOPIFY', 'WOOCOMMERCE') or v_channel.status = 'DISCONNECTED' then
    return;
  end if;
  if v_channel.platform = 'WOOCOMMERCE' and not public._channel_opt(v_channel, 'status_sync', true) then
    return;
  end if;
  insert into public.channel_order_sync(order_id, channel_id, external_order_id)
  values (v_order.id, v_channel.id, v_order.external_order_id)
  on conflict (order_id) do nothing;
  if p_cancel and v_channel.platform = 'SHOPIFY' and public._channel_opt(v_channel, 'cancel_on_shopify', true) then
    update public.channel_order_sync set cancel_status = 'PENDING', cancel_error = null
    where order_id = v_order.id and coalesce(cancel_status, '') not in ('REQUESTED', 'CONFIRMED');
  end if;
  perform public.channel_job_enqueue(v_channel.id, 'FULFILL', v_order.id);
end;
$$;

-- Items received back as good change what goes back to the store's stock.
create or replace function public._order_items_channel_restock_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from public.orders o join public.sales_channels c on c.id = o.sales_channel_id
             where o.id = new.order_id and c.platform = 'WOOCOMMERCE') then
    perform public._queue_channel_order_sync(new.order_id);
  end if;
  return new;
end;
$$;
drop trigger if exists order_items_channel_restock on public.order_items;
create trigger order_items_channel_restock after update of returned_quantity on public.order_items
  for each row when (new.returned_quantity is distinct from old.returned_quantity)
  execute function public._order_items_channel_restock_trigger();

-- Everything the worker needs for one store order (system only).
create or replace function public.channel_fulfillment_context(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_eff public.orders;
  v_f public.channel_fulfillments;
  v_ship record;
  v_c public.sales_channels;
  v_sync public.channel_order_sync;
  v_import jsonb;
begin
  perform public._require_system();
  select * into v_order from public.orders where id = p_order_id;
  select * into v_eff from public.orders where id = public._effective_order_id(p_order_id);
  select * into v_c from public.sales_channels where id = v_order.sales_channel_id;
  select * into v_f from public.channel_fulfillments where order_id = p_order_id and source = 'APP';
  select * into v_sync from public.channel_order_sync where order_id = p_order_id;
  select payload -> 'lines' into v_import from public.channel_order_imports
  where channel_id = v_order.sales_channel_id and order_id = p_order_id order by created_at desc limit 1;
  select s.consignment_id, s.tracking_number, s.created_at, s.status, c.name as courier_name, c.provider, c.tracking_url_template
  into v_ship from public.shipments s join public.couriers c on c.id = s.courier_id
  where s.order_id = v_eff.id and s.is_active order by s.created_at desc limit 1;
  return jsonb_build_object(
    'order', jsonb_build_object('id', v_order.id, 'order_number', v_order.order_number, 'status', v_eff.status,
      'own_status', v_order.status, 'merged_into', case when v_eff.id <> v_order.id then v_eff.order_number end,
      'external_order_id', v_order.external_order_id, 'customer_email', v_order.customer_email, 'shipped_at', v_eff.shipped_at,
      'delivered_at', v_eff.delivered_at, 'payment_method', v_order.payment_method, 'was_delivered', v_eff.delivered_at is not null),
    'fulfillment', case when v_f.id is null then null else to_jsonb(v_f) end,
    'delivered_target', coalesce(v_f.fulfillment_id, (select f.fulfillment_id from public.channel_fulfillments f
      where f.order_id = p_order_id and f.source = 'SHOPIFY' and f.fulfillment_id is not null order by f.created_at desc limit 1)),
    'sync', case when v_sync.order_id is null then null else to_jsonb(v_sync) end,
    'settings', jsonb_build_object(
      'inventory_sync', public._channel_opt(v_c, 'inventory_sync', false),
      'mark_paid_on_delivery', public._channel_opt(v_c, 'mark_paid_on_delivery', true),
      'status_tags', public._channel_opt(v_c, 'status_tags', true),
      'courier_events', public._channel_opt(v_c, 'courier_events', true),
      'status_sync', public._channel_opt(v_c, 'status_sync', true),
      'fulfill_on_ship', public._channel_opt(v_c, 'fulfill_on_ship', v_c.platform = 'SHOPIFY')),
    'status_tag', case when v_eff.id <> v_order.id and v_eff.status <> 'CANCELLED'
      then public._channel_status_tag(v_eff.status) else public._channel_status_tag(v_order.status) end,
    'merged_tag', case when v_eff.id <> v_order.id then 'Fullfilio: merged into ' || v_eff.order_number end,
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
      from public.order_items i where i.order_id = p_order_id), '[]'::jsonb),
    -- Items received back as good, per line, with the store's ids for the line (from the
    -- product link, else from the imported store order).
    'restock_lines', coalesce((select jsonb_agg(jsonb_build_object(
        'external_variant_id', coalesce(
          (select m.external_variant_id from public.sales_channel_variants m where m.channel_id = v_order.sales_channel_id and m.variant_id = i.variant_id limit 1),
          (select l ->> 'external_variant_id' from jsonb_array_elements(coalesce(v_import, '[]'::jsonb)) l
           where nullif(l ->> 'sku', '') is not null and l ->> 'sku' = i.sku limit 1)),
        'sku', i.sku, 'name', i.product_name, 'quantity', i.returned_quantity) order by i.created_at)
      from public.order_items i where i.order_id = p_order_id and i.returned_quantity > 0), '[]'::jsonb)
  );
end;
$$;

-- Store updates written by the worker (system only).
create or replace function public.channel_order_sync_update(p_order_id uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old public.channel_order_sync;
  v_new public.channel_order_sync;
  v_store text;
  v_put int;
begin
  perform public._require_system();
  select * into v_old from public.channel_order_sync where order_id = p_order_id for update;
  if not found then
    raise exception 'NOT_FOUND: no store sync for this order' using errcode = 'P0002';
  end if;
  update public.channel_order_sync set
    cancel_status = coalesce(p ->> 'cancel_status', cancel_status),
    cancel_error = case when p ? 'cancel_error' then nullif(p ->> 'cancel_error', '') else cancel_error end,
    cancel_requested_at = case when p ->> 'cancel_status' = 'REQUESTED' then coalesce(cancel_requested_at, now()) else cancel_requested_at end,
    cancel_confirmed_at = case when p ->> 'cancel_status' = 'CONFIRMED' then coalesce(cancel_confirmed_at, now()) else cancel_confirmed_at end,
    restocked_in_store = coalesce((p ->> 'restocked_in_store')::boolean, restocked_in_store),
    paid_status = coalesce(p ->> 'paid_status', paid_status),
    paid_error = case when p ? 'paid_error' then nullif(p ->> 'paid_error', '') else paid_error end,
    paid_at = case when p ->> 'paid_status' = 'MARKED' then coalesce(paid_at, now()) else paid_at end,
    status_tag = coalesce(p ->> 'status_tag', status_tag),
    tag_error = case when p ? 'tag_error' then nullif(p ->> 'tag_error', '') else tag_error end,
    events = events || coalesce(p -> 'events', '{}'::jsonb),
    event_error = case when p ? 'event_error' then nullif(p ->> 'event_error', '') else event_error end,
    store_status = coalesce(nullif(p ->> 'store_status', ''), store_status),
    store_status_at = case when nullif(p ->> 'store_status', '') is not null then now() else store_status_at end,
    store_status_error = case when p ? 'store_status_error' then nullif(p ->> 'store_status_error', '') else store_status_error end,
    store_restock = case when p ? 'store_restock' then p -> 'store_restock' else store_restock end,
    updated_at = now()
  where order_id = p_order_id returning * into v_new;

  select case c.platform when 'SHOPIFY' then 'Shopify' else 'WooCommerce' end into v_store
  from public.sales_channels c where c.id = v_new.channel_id;
  if v_new.cancel_status is distinct from v_old.cancel_status and v_new.cancel_status in ('REQUESTED', 'CONFIRMED', 'FAILED') then
    perform public._order_log(p_order_id, 'CHANNEL_SYNC', case v_new.cancel_status
      when 'REQUESTED' then 'Cancel sent to Shopify' || case when v_new.restocked_in_store then ' (Shopify restocks)' else ' (stock handled here, not restocked twice)' end
      when 'CONFIRMED' then 'Cancelled on Shopify'
      else 'Shopify did not cancel the order: ' || coalesce(v_new.cancel_error, 'unknown error') end);
  end if;
  if v_new.paid_status is distinct from v_old.paid_status and v_new.paid_status in ('MARKED', 'FAILED') then
    perform public._order_log(p_order_id, 'CHANNEL_SYNC', case v_new.paid_status when 'MARKED' then 'Marked paid on Shopify'
      else 'Could not mark paid on Shopify: ' || coalesce(v_new.paid_error, 'unknown error') end);
  end if;
  if v_new.events is distinct from v_old.events then
    perform public._order_log(p_order_id, 'CHANNEL_SYNC', 'Shopify delivery update: ' ||
      (select string_agg(lower(replace(k, '_', ' ')), ', ') from jsonb_object_keys(v_new.events) k where not v_old.events ? k));
  end if;
  if v_new.store_status is distinct from v_old.store_status and v_new.store_status is not null then
    perform public._order_log(p_order_id, 'CHANNEL_SYNC', format('Set to %s on %s',
      initcap(replace(v_new.store_status, '-', ' ')), v_store));
  end if;
  if v_new.store_status_error is distinct from v_old.store_status_error and v_new.store_status_error is not null then
    perform public._order_log(p_order_id, 'CHANNEL_SYNC', format('%s status not updated: %s', v_store, v_new.store_status_error));
  end if;
  if v_new.store_restock is distinct from v_old.store_restock then
    select coalesce(sum((x ->> 'added')::int), 0) into v_put from jsonb_array_elements(coalesce(p -> 'restocked', '[]'::jsonb)) x;
    if v_put > 0 then
      perform public._order_log(p_order_id, 'CHANNEL_SYNC', format('%s item(s) put back in %s stock (%s)', v_put, v_store,
        (select string_agg(format('%s × %s', x ->> 'added', x ->> 'name'), ', ') from jsonb_array_elements(p -> 'restocked') x where (x ->> 'added')::int > 0)));
    end if;
  end if;
end;
$$;

-- Staff: send a failed store update again.
create or replace function public.channel_order_sync_retry(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sync public.channel_order_sync;
begin
  perform public.require_permission('orders.update');
  update public.channel_order_sync set
    cancel_status = case when cancel_status = 'FAILED' then 'PENDING' else cancel_status end,
    paid_status = case when paid_status = 'FAILED' then 'PENDING' else paid_status end,
    tag_error = null, event_error = null, store_status_error = null
  where order_id = p_order_id returning * into v_sync;
  if not found then
    raise exception 'NOT_FOUND: nothing was sent to the store for this order' using errcode = 'P0002';
  end if;
  update public.channel_sync_jobs set status = 'PENDING', attempts = 0, next_attempt_at = now()
  where kind = 'FULFILL' and ref_id = p_order_id and status = 'FAILED'
    and not exists (select 1 from public.channel_sync_jobs o where o.kind = 'FULFILL' and o.ref_id = p_order_id and o.status in ('PENDING', 'RUNNING'));
  perform public.channel_job_enqueue(v_sync.channel_id, 'FULFILL', p_order_id);
end;
$$;

-- A delivered, returned or otherwise finished earlier order is a past order of the same
-- customer, not a duplicate. Only open orders are compared.
create or replace function public._flag_possible_duplicate(p_order_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_dup public.orders;
  v_reason text;
  v_kind text;
begin
  if not public.setting_bool('orders', array['duplicate_check_enabled'], true) then
    return null;
  end if;
  select * into v_order from public.orders where id = p_order_id;
  if not found or v_order.status in ('CANCELLED', 'REJECTED_FRAUD') or v_order.merged_into is not null then
    return null;
  end if;

  -- Already in Approved Orders and not finished yet.
  select d.* into v_dup from public.orders d
  where d.customer_phone = v_order.customer_phone and d.id <> v_order.id
    and d.confirmed_at is not null and d.merged_into is null
    and d.status in ('CONFIRMED', 'PRE_ORDER', 'PROCESSING', 'PRODUCTION', 'QUALITY_CHECK', 'PACKING', 'READY_TO_SHIP', 'SHIPPED')
  order by d.created_at desc limit 1;
  if found then
    v_kind := 'APPROVED';
    v_reason := format('already in Approved Orders (%s)', v_dup.status);
  else
    select d.* into v_dup from public.orders d
    where d.id <> v_order.id
      and d.created_at <= v_order.created_at
      and d.created_at >= v_order.created_at
          - make_interval(hours => public.setting_numeric('orders', array['duplicate_window_hours'], 24)::int)
      and d.status not in ('CANCELLED', 'REJECTED_FRAUD', 'DELIVERED', 'PARTIALLY_DELIVERED', 'RETURN_REQUESTED',
                           'RETURNING', 'RETURNED', 'FAILED_DELIVERY', 'LOST')
      and d.merged_into is null
      and (d.customer_phone = v_order.customer_phone
           or (public.normalize_address(d.shipping_address) = public.normalize_address(v_order.shipping_address)
               and lower(d.shipping_district) = lower(v_order.shipping_district)))
    order by d.created_at desc limit 1;
    if not found then
      return null;
    end if;
    v_kind := case when v_dup.customer_phone = v_order.customer_phone then 'PHONE' else 'ADDRESS' end;
    v_reason := case when v_kind = 'PHONE' then 'same phone number' else 'same delivery address' end;
  end if;

  update public.orders set duplicate_of = v_dup.id, duplicate_status = 'SUSPECTED', duplicate_reason = v_kind where id = v_order.id;
  perform public._order_log(v_order.id, 'DUPLICATE_SUSPECTED',
    format('Possible duplicate of %s (%s)', v_dup.order_number, v_reason), null, null,
    jsonb_build_object('duplicate_of', v_dup.id, 'order_number', v_dup.order_number, 'reason', v_reason, 'kind', v_kind));
  perform public._order_log(v_dup.id, 'DUPLICATE_SUSPECTED',
    format('%s may be a duplicate of this order (%s)', v_order.order_number, v_reason), null, null,
    jsonb_build_object('duplicate', v_order.id, 'order_number', v_order.order_number, 'reason', v_reason, 'kind', v_kind));
  return v_dup.id;
end;
$$;

-- Store Sync settings: "Order status to WooCommerce" (on by default).
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
  if p ? 'external_changes' and p ->> 'external_changes' not in ('FLAG', 'SAAS_WINS', 'TWO_WAY') then
    raise exception 'VALIDATION: unknown policy' using errcode = '22023';
  end if;
  v_new := v_old.settings || jsonb_strip_nulls(jsonb_build_object(
    'inventory_sync', (p ->> 'inventory_sync')::boolean, 'location_id', v_loc, 'external_changes', p ->> 'external_changes',
    'fulfill_on_ship', (p ->> 'fulfill_on_ship')::boolean, 'notify_customer', (p ->> 'notify_customer')::boolean,
    'fulfill_without_tracking', (p ->> 'fulfill_without_tracking')::boolean,
    'auto_import_products', (p ->> 'auto_import_products')::boolean, 'mark_delivered', (p ->> 'mark_delivered')::boolean,
    'cancel_on_shopify', (p ->> 'cancel_on_shopify')::boolean, 'mark_paid_on_delivery', (p ->> 'mark_paid_on_delivery')::boolean,
    'status_tags', (p ->> 'status_tags')::boolean, 'courier_events', (p ->> 'courier_events')::boolean,
    'update_products', (p ->> 'update_products')::boolean, 'status_sync', (p ->> 'status_sync')::boolean));
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
      'shop_domain', v_c.shop_domain, 'last_error', v_c.last_error,
      'catalog_imported_at', v_c.catalog_imported_at, 'first_sync_at', v_c.first_sync_at, 'scopes', to_jsonb(v_c.scopes),
      'catalog_items', (select count(*) from public.channel_catalog_items where channel_id = v_c.id and removed_at is null),
      'settings', jsonb_build_object(
        'inventory_sync', public._channel_opt(v_c, 'inventory_sync', false), 'location_id', v_c.settings ->> 'location_id',
        'external_changes', coalesce(v_c.settings ->> 'external_changes', 'FLAG'),
        'fulfill_on_ship', public._channel_opt(v_c, 'fulfill_on_ship', v_c.platform = 'SHOPIFY'), 'notify_customer', public._channel_opt(v_c, 'notify_customer', true),
        'fulfill_without_tracking', public._channel_opt(v_c, 'fulfill_without_tracking', false),
        'auto_import_products', public._channel_opt(v_c, 'auto_import_products', true),
        'mark_delivered', v_c.platform = 'SHOPIFY' and public._channel_opt(v_c, 'mark_delivered', true),
        'cancel_on_shopify', v_c.platform = 'SHOPIFY' and public._channel_opt(v_c, 'cancel_on_shopify', true),
        'mark_paid_on_delivery', v_c.platform = 'SHOPIFY' and public._channel_opt(v_c, 'mark_paid_on_delivery', true),
        'status_tags', v_c.platform = 'SHOPIFY' and public._channel_opt(v_c, 'status_tags', true),
        'courier_events', v_c.platform = 'SHOPIFY' and public._channel_opt(v_c, 'courier_events', true),
        'update_products', public._channel_opt(v_c, 'update_products', true),
        'status_sync', v_c.platform = 'WOOCOMMERCE' and public._channel_opt(v_c, 'status_sync', true))),
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
      'pending', (select count(*) from public.channel_sync_jobs where channel_id = p_channel_id and status = 'PENDING'),
      'processing', (select count(*) from public.channel_sync_jobs where channel_id = p_channel_id and status = 'RUNNING'),
      'failed', (select count(*) from public.channel_sync_jobs where channel_id = p_channel_id and status = 'FAILED'),
      'completed', (select count(*) from public.channel_sync_jobs where channel_id = p_channel_id and status = 'DONE'),
      'completed_today', (select count(*) from public.channel_sync_jobs where channel_id = p_channel_id and status = 'DONE' and done_at > now() - interval '24 hours')),
    'recent_jobs', coalesce((select jsonb_agg(jsonb_build_object('id', j.id, 'kind', j.kind, 'status', j.status, 'attempts', j.attempts,
        'last_error', j.last_error, 'updated_at', j.updated_at, 'ref_id', j.ref_id, 'result', j.result, 'payload', j.payload,
        'label', case when j.kind = 'FULFILL' then (select order_number from public.orders where id = j.ref_id)
                      else (select p.name || coalesce(' · ' || nullif(pv.title, 'Default'), '') from public.product_variants pv join public.products p on p.id = pv.product_id where pv.id = j.ref_id) end,
        'sku', case when j.kind = 'INVENTORY' then (select pv.sku from public.product_variants pv where pv.id = j.ref_id) end)
        order by j.updated_at desc)
      from (select * from public.channel_sync_jobs where channel_id = p_channel_id order by updated_at desc limit 50) j), '[]'::jsonb),
    'fulfillments', coalesce((select jsonb_agg(x order by x ->> 'created_at' desc) from (
        select jsonb_build_object('order_id', f.order_id, 'order_number', o.order_number, 'status', f.status, 'source', f.source,
          'courier', f.courier, 'tracking_number', f.tracking_number, 'tracking_url', f.tracking_url, 'notification_status', f.notification_status,
          'last_error', f.last_error, 'created_at', f.created_at, 'fulfilled_at', f.fulfilled_at,
          'delivered_status', f.delivered_status, 'delivered_at', f.delivered_at, 'delivered_error', f.delivered_error,
          'cancel_status', s.cancel_status, 'paid_status', s.paid_status, 'status_tag', s.status_tag, 'store_status', s.store_status) as x
        from public.channel_fulfillments f join public.orders o on o.id = f.order_id
        left join public.channel_order_sync s on s.order_id = f.order_id
        where f.channel_id = p_channel_id order by f.created_at desc limit 30) q), '[]'::jsonb)
  );
end;
$$;
