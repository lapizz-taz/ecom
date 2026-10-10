-- =============================================================================
-- Store sync v3: merging store orders, order status sent to Shopify, two-way
-- stock, cost and product updates from the store, honest attribution.
--
-- Merging (root cause fixed): orders imported from Shopify / WooCommerce never
-- went through the merge / duplicate check, and the merge rule excluded them.
-- Now every new order (website, admin or store) is checked:
--   * same customer phone, same district, within the merge window (72 h);
--   * the earlier order may be in Web Orders (Processing / Good but no
--     response …) or in Approved Orders before packing (no courier, no label);
--   * the new order must be unpaid, without coupon or discount, not shipped;
--   * cancelled, shipped, delivered, returned, lost orders never merge.
-- Each Shopify order in a merged group keeps its own link: when the group is
-- shipped / delivered / cancelled, every Shopify order in it is updated.
--
-- Order status → Shopify (one idempotent job per order; each step checks
-- Shopify first and is recorded): cancel (restock on Shopify only when this
-- app does not manage Shopify's stock, so stock is never restored twice),
-- fulfil with tracking, Delivered / Attempted / Failure delivery events, mark
-- paid when a cash-on-delivery order is delivered, and a "Status: …" tag.
-- A cancel that came from Shopify is never sent back.
--
-- Two-way stock: a change made in the store (not explained by an order) is
-- applied here as a recorded adjustment of the difference, so changes made on
-- both sides at once are both kept. Cost changes in the store update the cost
-- here; product details follow the store (prices, cost, barcode, weight,
-- names, description, images, category from type / collection).
--
-- Attribution: a visit from facebook.com / instagram.com without ad tags is
-- "Social — paid or organic unknown", not "Organic". Shopify's own UTM fields
-- and marketing events are used when present.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Settings
-- -----------------------------------------------------------------------------
update public.settings set value = value || jsonb_build_object('auto_merge_window_hours', 72)
where key = 'orders' and coalesce((value ->> 'auto_merge_window_hours')::numeric, 12) = 12;

alter table public.channel_catalog_items add column if not exists collections text[] not null default '{}';

-- What has been sent to the store for one order (besides the fulfilment).
create table if not exists public.channel_order_sync (
  order_id uuid primary key references public.orders(id),
  channel_id uuid not null references public.sales_channels(id),
  external_order_id text not null,
  cancel_status text check (cancel_status in ('PENDING', 'REQUESTED', 'CONFIRMED', 'FAILED', 'SKIPPED')),
  cancel_error text,
  cancel_requested_at timestamptz,
  cancel_confirmed_at timestamptz,
  restocked_in_store boolean,
  paid_status text check (paid_status in ('PENDING', 'MARKED', 'FAILED', 'SKIPPED')),
  paid_error text,
  paid_at timestamptz,
  status_tag text,
  tag_error text,
  events jsonb not null default '{}'::jsonb,
  event_error text,
  updated_at timestamptz not null default now()
);
alter table public.channel_order_sync enable row level security;
revoke all on public.channel_order_sync from anon, authenticated;
grant all on public.channel_order_sync to service_role;
create or replace trigger channel_order_sync_updated_at before update on public.channel_order_sync
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Merging
-- -----------------------------------------------------------------------------
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
  v_approved constant public.order_status[] := array['CONFIRMED', 'PROCESSING']::public.order_status[];
begin
  if not public.setting_bool('orders', array['auto_merge_web_enabled'], true) then
    return null;
  end if;
  select * into v_order from public.orders where id = p_order_id;
  if not found or v_order.customer_phone is null then
    return null;
  end if;
  -- One merge at a time per customer, so two orders arriving together cannot
  -- form two groups.
  perform pg_advisory_xact_lock(hashtextextended('order-merge:' || v_order.customer_phone, 0));
  select * into v_order from public.orders where id = p_order_id for update;
  -- The new order: still in Web Orders, unpaid, no coupon or discount, nothing booked.
  if v_order.confirmed_at is not null or v_order.merged_into is not null or not (v_order.status = any(v_web))
     or not (v_order.review_status = any(v_priority))
     or v_order.amount_paid > 0 or v_order.coupon_id is not null
     or coalesce(v_order.manual_discount, 0) > 0 or coalesce(v_order.coupon_discount, 0) > 0
     or exists (select 1 from public.payments where order_id = v_order.id and status = 'REQUIRES_VERIFICATION')
     or exists (select 1 from public.shipments where order_id = v_order.id and is_active) then
    return null;
  end if;

  -- The earlier order: in Web Orders (eligible call status) or in Approved
  -- Orders before packing. Cancelled / shipped / delivered / returned / lost
  -- orders are never a target.
  select o.* into v_target from public.orders o
  where o.customer_phone = v_order.customer_phone
    and o.id <> v_order.id
    and o.merged_into is null
    and ((o.confirmed_at is null and o.status = any(v_web) and o.review_status = any(v_priority))
         or (o.confirmed_at is not null and o.status = any(v_approved)))
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
    format('same customer %s, %s apart%s', v_order.customer_phone,
      case when v_order.created_at - v_target.created_at < interval '1 hour'
        then ceil(extract(epoch from v_order.created_at - v_target.created_at) / 60)::int || ' min'
        else round(extract(epoch from v_order.created_at - v_target.created_at) / 3600, 1) || ' h' end,
      case when v_target.confirmed_at is not null then ', into an approved order' else '' end));
  return v_target.id;
end;
$$;

-- The order a merged order now lives in (itself when not merged).
create or replace function public._effective_order_id(p_order_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := p_order_id;
  v_next uuid;
  i int := 0;
begin
  loop
    select merged_into into v_next from public.orders where id = v_id;
    exit when v_next is null or i > 5;
    v_id := v_next;
    i := i + 1;
  end loop;
  return v_id;
end;
$$;

-- Store import: after the order is saved, merge or flag it like any new order.
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
        || coalesce(E'\n' || array_to_string(v_warnings, E'\n'), '')
    ), 'API');

    update public.orders set sales_channel_id = p_channel_id, external_order_id = v_ext, external_order_number = v_o ->> 'number'
    where id = v_order.id;

    if v_paid > 0 then
      perform public.record_order_payment(v_order.id, case when v_paid >= v_order.total_amount then 'FULL' else 'ADVANCE' end::public.order_payment_kind,
        'GATEWAY', least(v_paid, v_order.total_amount), coalesce(v_o ->> 'number', v_ext),
        format('Paid in %s%s', v_platform_name, coalesce(' via ' || nullif(v_o ->> 'gateway', ''), '')),
        'channel-pay:' || p_channel_id || ':' || v_ext);
    end if;
  exception when others then
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

  -- Same customer with an open order: merge (or flag) like any new order.
  v_shown := public._after_order_created(v_order.id);

  return jsonb_build_object('status', 'IMPORTED', 'import_id', v_import.id, 'order_id', v_order.id, 'order_number', v_order.order_number,
    'phone', v_order.customer_phone, 'total', v_order.total_amount, 'warnings', to_jsonb(v_warnings),
    'merged_into', case when v_shown is distinct from v_order.id then (select order_number from public.orders where id = v_shown) end);
end;
$$;

-- -----------------------------------------------------------------------------
-- Order status → store
-- -----------------------------------------------------------------------------
-- The tag that shows our status on the store's order.
create or replace function public._channel_status_tag(p_status public.order_status)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select 'Status: ' || case p_status
    when 'PENDING' then 'New' when 'FRAUD_CHECK' then 'New' when 'FRAUD_REVIEW' then 'New' when 'ADVANCE_REQUIRED' then 'Waiting for advance'
    when 'CONFIRMATION_REQUIRED' then 'New' when 'CONFIRMED' then 'Confirmed' when 'PRE_ORDER' then 'Pre-order'
    when 'PROCESSING' then 'Confirmed' when 'PRODUCTION' then 'In production' when 'QUALITY_CHECK' then 'Packing' when 'PACKING' then 'Packing'
    when 'READY_TO_SHIP' then 'Ready to ship' when 'SHIPPED' then 'Shipped' when 'PENDING_CANCEL' then 'Cancelling'
    when 'DELIVERED' then 'Delivered' when 'PARTIALLY_DELIVERED' then 'Partly delivered' when 'CANCELLED' then 'Cancelled'
    when 'RETURN_REQUESTED' then 'Return requested' when 'RETURNING' then 'Returning' when 'RETURNED' then 'Returned'
    when 'FAILED_DELIVERY' then 'Delivery failed' when 'LOST' then 'Lost' when 'REJECTED_FRAUD' then 'Cancelled'
    else initcap(replace(p_status::text, '_', ' ')) end
$$;

-- Queue the store update for one store order (and remember a wanted cancel).
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
  if v_channel.platform <> 'SHOPIFY' or v_channel.status = 'DISCONNECTED' then
    return;
  end if;
  insert into public.channel_order_sync(order_id, channel_id, external_order_id)
  values (v_order.id, v_channel.id, v_order.external_order_id)
  on conflict (order_id) do nothing;
  if p_cancel and public._channel_opt(v_channel, 'cancel_on_shopify', true) then
    update public.channel_order_sync set cancel_status = 'PENDING', cancel_error = null
    where order_id = v_order.id and coalesce(cancel_status, '') not in ('REQUESTED', 'CONFIRMED');
  end if;
  perform public.channel_job_enqueue(v_channel.id, 'FULFILL', v_order.id);
end;
$$;

-- Every status change of an order (and of a merged group) reaches the store.
create or replace function public._orders_channel_status_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_src record;
  v_from_store boolean := coalesce(current_setting('app.channel_cancel', true), '') = '1';
begin
  -- This order itself (unless it was cancelled because it merged into another).
  if new.sales_channel_id is not null and new.merged_into is null then
    perform public._queue_channel_order_sync(new.id, new.status = 'CANCELLED' and not v_from_store);
  end if;
  -- Store orders merged into this one follow it.
  for v_src in select id from public.orders where merged_into = new.id and sales_channel_id is not null loop
    if new.status = 'SHIPPED' then
      perform public._queue_channel_fulfillment(v_src.id);
    elsif new.status = 'DELIVERED' then
      perform public._queue_channel_delivered(v_src.id);
    end if;
    perform public._queue_channel_order_sync(v_src.id, new.status = 'CANCELLED');
  end loop;
  return new;
end;
$$;
create or replace trigger orders_channel_status after update of status on public.orders
  for each row when (old.status is distinct from new.status)
  execute function public._orders_channel_status_trigger();

-- A cancel that Shopify sent is not sent back; it confirms ours.
create or replace function public.channel_order_cancelled(p_channel_id uuid, p_external_id text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_channel public.sales_channels;
  v_order public.orders;
  v_name text;
begin
  perform public._require_system();
  select * into v_channel from public.sales_channels where id = p_channel_id;
  v_name := case v_channel.platform when 'SHOPIFY' then 'Shopify' else 'WooCommerce' end;
  select * into v_order from public.orders where sales_channel_id = p_channel_id and external_order_id = p_external_id;
  if not found then
    update public.channel_order_imports set status = 'SKIPPED', error = 'Cancelled in ' || v_name
    where channel_id = p_channel_id and external_id = p_external_id and status = 'FAILED';
    return jsonb_build_object('status', 'NO_ORDER');
  end if;
  update public.channel_order_sync set cancel_status = 'CONFIRMED', cancel_confirmed_at = now(), cancel_error = null
  where order_id = v_order.id and cancel_status in ('PENDING', 'REQUESTED', 'FAILED');
  if found then
    perform public._order_log(v_order.id, 'CHANNEL_SYNC', format('Cancelled on %s (confirmed by %s)', v_name, v_name));
  end if;
  if v_order.status in ('CANCELLED', 'REJECTED_FRAUD') then
    return jsonb_build_object('status', 'ALREADY', 'order_id', v_order.id);
  end if;
  if v_order.merged_into is not null then
    insert into public.order_notes(order_id, kind, visibility, body, created_by_name)
    values (public._effective_order_id(v_order.id), 'SYSTEM', 'INTERNAL',
      format('%s order %s was cancelled in %s%s. It is merged into this order — remove its items before shipping if needed.',
        v_name, coalesce(v_order.external_order_number, p_external_id), v_name, coalesce(' (' || nullif(p_reason, '') || ')', '')), v_name);
    return jsonb_build_object('status', 'NOTED', 'order_id', v_order.id);
  end if;
  if v_order.status in ('PENDING', 'FRAUD_CHECK', 'FRAUD_REVIEW', 'ADVANCE_REQUIRED', 'CONFIRMATION_REQUIRED', 'CONFIRMED', 'PROCESSING') then
    begin
      perform set_config('app.channel_cancel', '1', true);
      perform public._transition_order(v_order.id, 'CANCELLED', 'Cancelled in ' || v_name || coalesce(': ' || nullif(p_reason, ''), ''));
      perform set_config('app.channel_cancel', '', true);
      return jsonb_build_object('status', 'CANCELLED', 'order_id', v_order.id);
    exception when others then
      perform set_config('app.channel_cancel', '', true);
    end;
  end if;
  insert into public.order_notes(order_id, kind, visibility, body, created_by_name)
  values (v_order.id, 'SYSTEM', 'INTERNAL', format('Cancelled in %s%s — check before shipping. This order is already %s here.',
          v_name, coalesce(' (' || nullif(p_reason, '') || ')', ''), lower(replace(v_order.status::text, '_', ' '))), v_name);
  return jsonb_build_object('status', 'NOTED', 'order_id', v_order.id);
end;
$$;

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
begin
  perform public._require_system();
  select * into v_order from public.orders where id = p_order_id;
  select * into v_eff from public.orders where id = public._effective_order_id(p_order_id);
  select * into v_c from public.sales_channels where id = v_order.sales_channel_id;
  select * into v_f from public.channel_fulfillments where order_id = p_order_id and source = 'APP';
  select * into v_sync from public.channel_order_sync where order_id = p_order_id;
  select s.consignment_id, s.tracking_number, s.created_at, s.status, c.name as courier_name, c.provider, c.tracking_url_template
  into v_ship from public.shipments s join public.couriers c on c.id = s.courier_id
  where s.order_id = v_eff.id and s.is_active order by s.created_at desc limit 1;
  return jsonb_build_object(
    -- Status, dates and shipment of the order it lives in (itself, or the one it merged into).
    'order', jsonb_build_object('id', v_order.id, 'order_number', v_order.order_number, 'status', v_eff.status,
      'own_status', v_order.status, 'merged_into', case when v_eff.id <> v_order.id then v_eff.order_number end,
      'external_order_id', v_order.external_order_id, 'customer_email', v_order.customer_email, 'shipped_at', v_eff.shipped_at,
      'delivered_at', v_eff.delivered_at, 'payment_method', v_order.payment_method, 'was_delivered', v_eff.delivered_at is not null),
    -- null (not an empty row) when there is none.
    'fulfillment', case when v_f.id is null then null else to_jsonb(v_f) end,
    'delivered_target', coalesce(v_f.fulfillment_id, (select f.fulfillment_id from public.channel_fulfillments f
      where f.order_id = p_order_id and f.source = 'SHOPIFY' and f.fulfillment_id is not null order by f.created_at desc limit 1)),
    'sync', case when v_sync.order_id is null then null else to_jsonb(v_sync) end,
    'settings', jsonb_build_object(
      'inventory_sync', public._channel_opt(v_c, 'inventory_sync', false),
      'mark_paid_on_delivery', public._channel_opt(v_c, 'mark_paid_on_delivery', true),
      'status_tags', public._channel_opt(v_c, 'status_tags', true),
      'courier_events', public._channel_opt(v_c, 'courier_events', true)),
    'status_tag', case when v_eff.id <> v_order.id and v_eff.status <> 'CANCELLED'
      then public._channel_status_tag(v_eff.status) else public._channel_status_tag(v_order.status) end,
    'merged_tag', case when v_eff.id <> v_order.id then 'Merged: ' || v_eff.order_number end,
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

-- Worker records what the store did (system only).
create or replace function public.channel_order_sync_update(p_order_id uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old public.channel_order_sync;
  v_new public.channel_order_sync;
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
    event_error = case when p ? 'event_error' then nullif(p ->> 'event_error', '') else event_error end
  where order_id = p_order_id returning * into v_new;

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
    tag_error = null, event_error = null
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
      'mark_delivered', c.platform = 'SHOPIFY' and public._channel_opt(c, 'mark_delivered', true),
      'cancel_on_shopify', c.platform = 'SHOPIFY' and public._channel_opt(c, 'cancel_on_shopify', true))
      from public.sales_channels c where c.id = v_order.sales_channel_id),
    'external_order_id', v_order.external_order_id, 'external_order_number', v_order.external_order_number,
    'merged_into', (select order_number from public.orders where id = v_order.merged_into),
    'fulfillments', coalesce((select jsonb_agg(jsonb_build_object(
        'id', f.id, 'source', f.source, 'status', f.status, 'fulfillment_id', f.fulfillment_id, 'courier', f.courier,
        'tracking_number', f.tracking_number, 'tracking_url', f.tracking_url, 'shopify_status', f.shopify_status,
        'notification_status', f.notification_status, 'notification_note', f.notification_note, 'line_items', f.line_items,
        'attempts', f.attempts, 'last_error', f.last_error, 'fulfilled_at', f.fulfilled_at, 'synced_at', f.synced_at, 'created_at', f.created_at,
        'delivered_status', f.delivered_status, 'delivered_at', f.delivered_at, 'delivered_error', f.delivered_error)
      order by f.created_at) from public.channel_fulfillments f where f.order_id = p_order_id), '[]'::jsonb),
    'sync', (select to_jsonb(s) - 'channel_id' from public.channel_order_sync s where s.order_id = p_order_id),
    'job', (select jsonb_build_object('status', j.status, 'attempts', j.attempts, 'next_attempt_at', j.next_attempt_at, 'last_error', j.last_error)
      from public.channel_sync_jobs j where j.kind = 'FULFILL' and j.ref_id = p_order_id order by j.created_at desc limit 1)
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Stock: two-way, cost, product details
-- -----------------------------------------------------------------------------
-- A change made in the store, applied here as the difference (so a change
-- made here at the same moment is kept too). System only.
create or replace function public.channel_inventory_adopt_change(p_channel_id uuid, p_variant_id uuid, p_store_qty int)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_m public.sales_channel_variants;
  v_c public.sales_channels;
  v_inv public.inventory;
  v_delta int;
begin
  perform public._require_system();
  select * into v_m from public.sales_channel_variants where channel_id = p_channel_id and variant_id = p_variant_id for update;
  if not found or v_m.last_pushed_qty is null or p_store_qty is null then
    return jsonb_build_object('status', 'SKIPPED');
  end if;
  select * into v_c from public.sales_channels where id = p_channel_id;
  v_delta := p_store_qty - v_m.last_pushed_qty;
  if v_delta <> 0 then
    select * into v_inv from public.inventory where variant_id = p_variant_id for update;
    v_delta := greatest(v_delta, -coalesce(v_inv.on_hand, 0));
    if v_delta <> 0 then
      perform public._apply_inventory_movement(p_variant_id, 'ADJUSTMENT', v_delta, 0, 0, 'CHANNEL', p_channel_id,
        format('Changed in %s', v_c.name),
        format('Changed in %s: %s → %s (applied here as %s%s)', case v_c.platform when 'SHOPIFY' then 'Shopify' else 'WooCommerce' end,
          v_m.last_pushed_qty, p_store_qty, case when v_delta > 0 then '+' else '' end, v_delta), null, false);
    end if;
  end if;
  update public.sales_channel_variants set last_pushed_qty = p_store_qty, shopify_available = p_store_qty, sync_status = 'OK',
    last_error = null, mismatch_since = null, synced_at = now()
  where channel_id = p_channel_id and variant_id = p_variant_id;
  return jsonb_build_object('status', 'ADOPTED', 'change', v_delta);
end;
$$;

-- Shopify told us a level changed. A minute's grace lets the order arrive first.
create or replace function public.channel_inventory_seen(p_channel_id uuid, p_inventory_item_id text, p_location_id text, p_available int)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_c public.sales_channels;
  v_m public.sales_channel_variants;
  v_queued int := 0;
begin
  perform public._require_system();
  select * into v_c from public.sales_channels where id = p_channel_id;
  if coalesce(v_c.settings ->> 'location_id', '') <> p_location_id then
    return jsonb_build_object('status', 'OTHER_LOCATION');
  end if;
  for v_m in select * from public.sales_channel_variants where channel_id = p_channel_id and inventory_item_id = p_inventory_item_id for update loop
    update public.sales_channel_variants set shopify_available = p_available, synced_at = now() where channel_id = v_m.channel_id and external_variant_id = v_m.external_variant_id;
    if p_available is distinct from v_m.last_pushed_qty and public._channel_opt(v_c, 'inventory_sync', false) then
      perform public.channel_job_enqueue(p_channel_id, 'INVENTORY', v_m.variant_id, '{"reason":"store_changed"}'::jsonb, 60);
      v_queued := v_queued + 1;
    end if;
  end loop;
  return jsonb_build_object('status', 'OK', 'queued', v_queued);
end;
$$;

-- The store's cost for an inventory item changed (inventory_items/update).
create or replace function public.channel_cost_seen(p_channel_id uuid, p_inventory_item_id text, p_cost numeric)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n int;
begin
  perform public._require_system();
  if p_cost is null or p_cost < 0 then
    return jsonb_build_object('status', 'NO_COST');
  end if;
  update public.channel_catalog_items set unit_cost = public.money(p_cost)
  where channel_id = p_channel_id and inventory_item_id = p_inventory_item_id;
  with v as (
    update public.product_variants pv set cost_price = public.money(p_cost)
    from public.sales_channel_variants m
    where m.channel_id = p_channel_id and m.inventory_item_id = p_inventory_item_id and pv.id = m.variant_id
      and pv.cost_price is distinct from public.money(p_cost)
    returning pv.product_id)
  update public.products p set cost_price = public.money(p_cost)
  from (select distinct product_id from v) x
  where p.id = x.product_id and (select count(*) from public.product_variants where product_id = p.id) = 1;
  get diagnostics v_n = row_count;
  return jsonb_build_object('status', 'OK', 'products', v_n);
end;
$$;

-- Product details follow the store for linked products (when that is on).
create or replace function public._channel_apply_store_details(p_channel_id uuid, p_product_ids text[])
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_c public.sales_channels;
  v_n int := 0;
  v_p record;
  v_cat uuid;
  v_name text;
begin
  select * into v_c from public.sales_channels where id = p_channel_id;
  if v_c.first_sync_at is null or not public._channel_opt(v_c, 'update_products', true) then
    return 0;
  end if;
  -- Variants: price, compare-at, cost (when the store has one), barcode, weight.
  update public.product_variants pv set
    price = coalesce(ci.price, pv.price), compare_at_price = ci.compare_at_price,
    cost_price = coalesce(ci.unit_cost, pv.cost_price), barcode = coalesce(ci.barcode, pv.barcode),
    weight_grams = coalesce(ci.weight_grams, pv.weight_grams),
    title = case when nullif(nullif(trim(ci.variant_title), ''), 'Default Title') is not null then ci.variant_title else pv.title end
  from public.sales_channel_variants m
  join public.channel_catalog_items ci on ci.channel_id = m.channel_id and ci.external_variant_id = m.external_variant_id and ci.removed_at is null
  where m.channel_id = p_channel_id and pv.id = m.variant_id
    and (p_product_ids is null or ci.external_product_id = any (p_product_ids))
    and (pv.price is distinct from coalesce(ci.price, pv.price) or pv.compare_at_price is distinct from ci.compare_at_price
         or pv.cost_price is distinct from coalesce(ci.unit_cost, pv.cost_price) or pv.barcode is distinct from coalesce(ci.barcode, pv.barcode)
         or pv.weight_grams is distinct from coalesce(ci.weight_grams, pv.weight_grams)
         or (nullif(nullif(trim(ci.variant_title), ''), 'Default Title') is not null and pv.title is distinct from ci.variant_title));
  get diagnostics v_n = row_count;

  -- Products: name, description, brand, price shown, category from type / collection, images.
  for v_p in
    select distinct on (pv.product_id) pv.product_id, ci.product_title, ci.product_description, ci.vendor, ci.product_type, ci.collections,
      ci.images, ci.image_url, ci.price, ci.compare_at_price, ci.unit_cost, ci.product_status
    from public.sales_channel_variants m
    join public.channel_catalog_items ci on ci.channel_id = m.channel_id and ci.external_variant_id = m.external_variant_id and ci.removed_at is null
    join public.product_variants pv on pv.id = m.variant_id
    where m.channel_id = p_channel_id and (p_product_ids is null or ci.external_product_id = any (p_product_ids))
    order by pv.product_id, ci.external_variant_id
  loop
    v_name := coalesce(nullif(trim(v_p.product_type), ''), v_p.collections[1]);
    v_cat := null;
    if v_name is not null then
      select id into v_cat from public.categories where lower(name) = lower(v_name) or slug = public.slugify(v_name) limit 1;
      if v_cat is null then
        insert into public.categories(name, slug) values (left(v_name, 120), left(public.slugify(v_name), 80))
        on conflict do nothing returning id into v_cat;
        if v_cat is null then
          select id into v_cat from public.categories where slug = left(public.slugify(v_name), 80);
        end if;
      end if;
    end if;
    update public.products p set
      name = coalesce(nullif(trim(v_p.product_title), ''), p.name),
      description = coalesce(v_p.product_description, p.description),
      brand = coalesce(v_p.vendor, p.brand),
      price = coalesce(v_p.price, p.price),
      compare_at_price = v_p.compare_at_price,
      cost_price = case when v_p.unit_cost is not null then v_p.unit_cost else p.cost_price end,
      category_id = coalesce(p.category_id, v_cat)
    where p.id = v_p.product_id
      and (p.name is distinct from coalesce(nullif(trim(v_p.product_title), ''), p.name) or p.description is distinct from coalesce(v_p.product_description, p.description)
           or p.brand is distinct from coalesce(v_p.vendor, p.brand) or p.price is distinct from coalesce(v_p.price, p.price)
           or p.compare_at_price is distinct from v_p.compare_at_price
           or (v_p.unit_cost is not null and p.cost_price is distinct from v_p.unit_cost) or (p.category_id is null and v_cat is not null));
    if found then
      v_n := v_n + 1;
    end if;
    if not exists (select 1 from public.product_images where product_id = v_p.product_id) then
      insert into public.product_images(product_id, url, is_primary, position)
      select v_p.product_id, u, n = 1, (n - 1)::int
      from jsonb_array_elements_text(case when jsonb_array_length(v_p.images) > 0 then v_p.images
                                          when v_p.image_url is not null then jsonb_build_array(v_p.image_url) else '[]'::jsonb end)
        with ordinality as t(u, n);
    end if;
  end loop;
  return v_n;
end;
$$;

-- Catalog rows keep the collections too.
create or replace function public._channel_catalog_collections(p_channel_id uuid, p_items jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.channel_catalog_items ci set collections = coalesce((select array_agg(left(trim(t), 120))
      from jsonb_array_elements_text(x -> 'collections') t where trim(t) <> ''), '{}')
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
  where ci.channel_id = p_channel_id and ci.external_variant_id = x ->> 'external_variant_id' and jsonb_typeof(x -> 'collections') = 'array';
end;
$$;

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
  v_updated int;
begin
  perform public._require_system();
  update public.sales_channels set locations = coalesce(p_locations, '[]'::jsonb), catalog_imported_at = now() where id = p_channel_id;
  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    perform public._channel_catalog_put(p_channel_id, v_item);
  end loop;
  perform public._channel_catalog_collections(p_channel_id, p_items);
  v_linked := public._channel_link_by_sku(p_channel_id);
  v_auto := public._channel_autoimport(p_channel_id, null);
  v_updated := public._channel_apply_store_details(p_channel_id, null);
  return jsonb_build_object('items', jsonb_array_length(coalesce(p_items, '[]'::jsonb)), 'linked', v_linked,
    'mapped', (select count(*) from public.sales_channel_variants where channel_id = p_channel_id and inventory_item_id is not null),
    'imported', coalesce((v_auto ->> 'created')::int, 0), 'updated', v_updated);
end;
$$;

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
  v_updated int;
begin
  perform public._require_system();
  if nullif(trim(coalesce(p_product_id, '')), '') is null then
    raise exception 'VALIDATION: product id missing' using errcode = '22023';
  end if;
  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    continue when v_item ->> 'external_product_id' is distinct from p_product_id;
    perform public._channel_catalog_put(p_channel_id, v_item);
  end loop;
  perform public._channel_catalog_collections(p_channel_id, p_items);
  select coalesce(array_agg(x ->> 'external_variant_id'), '{}') into v_keep from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x;
  update public.channel_catalog_items set removed_at = now()
  where channel_id = p_channel_id and external_product_id = p_product_id and removed_at is null
    and not (external_variant_id = any (v_keep));
  get diagnostics v_removed = row_count;
  update public.sales_channel_variants m set inventory_item_id = null, sync_status = 'FAILED',
    last_error = 'Removed from the store', mismatch_since = null
  from public.channel_catalog_items ci
  where ci.channel_id = p_channel_id and ci.external_product_id = p_product_id and ci.removed_at is not null
    and m.channel_id = p_channel_id and m.external_variant_id = ci.external_variant_id and m.inventory_item_id is not null;
  perform public._channel_link_by_sku(p_channel_id);
  v_auto := public._channel_autoimport(p_channel_id, array[p_product_id]);
  v_updated := public._channel_apply_store_details(p_channel_id, array[p_product_id]);
  return jsonb_build_object('items', jsonb_array_length(coalesce(p_items, '[]'::jsonb)), 'removed', v_removed,
    'imported', coalesce((v_auto ->> 'created')::int, 0), 'updated', v_updated);
end;
$$;

-- First sync: also turns on two-way stock and fills product details.
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
    update public.sales_channels set settings = settings || '{"external_changes":"TWO_WAY"}'::jsonb where id = p_channel_id;
    perform public._channel_apply_store_details(p_channel_id, null);
    perform public.log_audit('channel.first_sync', 'sales_channel', p_channel_id::text, null,
      jsonb_build_object('location_id', p_location_id, 'create', v_out -> 'create', 'link', v_out -> 'link',
        'stock_corrected', jsonb_array_length(v_out -> 'stock_changes')));
    return v_out || jsonb_build_object('applied', true);
  end if;
  begin
    v_out := public._channel_first_sync_run(p_channel_id, p_location_id, p_auto_import);
    raise exception 'preview' using errcode = 'XP001';
  exception when sqlstate 'XP001' then
    null;
  end;
  return v_out || jsonb_build_object('applied', false);
end;
$$;

-- p: inventory_sync, location_id, external_changes (FLAG | SAAS_WINS | TWO_WAY), fulfill_on_ship,
--    notify_customer, fulfill_without_tracking, auto_import_products, mark_delivered,
--    cancel_on_shopify, mark_paid_on_delivery, status_tags, courier_events, update_products
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
    'update_products', (p ->> 'update_products')::boolean));
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

-- Sync screen: status, queue, activity, settings.
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
        'update_products', public._channel_opt(v_c, 'update_products', true))),
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
          'cancel_status', s.cancel_status, 'paid_status', s.paid_status, 'status_tag', s.status_tag) as x
        from public.channel_fulfillments f join public.orders o on o.id = f.order_id
        left join public.channel_order_sync s on s.order_id = f.order_id
        where f.channel_id = p_channel_id order by f.created_at desc limit 30) q), '[]'::jsonb)
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Attribution
-- -----------------------------------------------------------------------------
-- A visit from a social site with no ad tags: we know the site, not whether it
-- was an ad. Shopify marking the visit as an ad (marketing event) counts as paid.
create or replace function public.classify_touch(p_touch jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  p jsonb := coalesce(p_touch -> 'params', '{}'::jsonb);
  src text := lower(trim(coalesce(p ->> 'utm_source', '')));
  med text := lower(trim(coalesce(p ->> 'utm_medium', '')));
  site text := lower(coalesce(p ->> 'site_source_name', ''));
  placement text := lower(coalesce(p ->> 'placement', ''));
  host text := lower(coalesce(substring(p_touch ->> 'referrer' from '^[a-z0-9+.-]+://([^/:?#]+)'), ''));
  shop_ad boolean := lower(coalesce(p ->> 'shopify_marketing_type', '')) = 'ad';
  paid boolean := med ~ '^(cpc|ppc|paid|paid[_ -]?social|paid[_ -]?search|ads?|cpm|cpv|cpa|display|sponsored|boost(ed)?|retargeting|remarketing)$' or shop_ad;
  organic_med boolean := med ~ '^(organic|social|bio|post|story|reel|referral|profile|link[_ -]?in[_ -]?bio)$';
  meta_ids boolean := p ? 'ad_id' or p ? 'adset_id' or p ? 'campaign_id';
  meta_src boolean := src in ('facebook', 'fb', 'meta', 'ig', 'instagram', 'an', 'msg', 'messenger', 'audience_network');
  insta boolean := src in ('ig', 'instagram') or site = 'ig' or placement like 'instagram%' or host ~ '(^|\.)instagram\.com$' or host like '%com.instagram.%';
  v_channel text;
  v_label text;
  v_medium text;
  v_paid boolean;
  v_platform text;
  v_click_type text := case when p ? 'fbclid' then 'fbclid' when p ? 'gclid' then 'gclid' when p ? 'gbraid' then 'gbraid'
    when p ? 'wbraid' then 'wbraid' when p ? 'ttclid' then 'ttclid' when p ? 'msclkid' then 'msclkid'
    when p ? 'srsltid' then 'srsltid' end;
begin
  if p_touch is null or jsonb_typeof(p_touch) <> 'object' then
    return jsonb_build_object('channel', 'unknown', 'source', 'Unknown', 'medium', 'Unknown', 'is_paid', null, 'platform', null);
  end if;

  if (meta_src and (paid or meta_ids)) or (p ? 'fbclid' and (paid or meta_ids)) or (shop_ad and (host ~ '(facebook|instagram|fb)\.' or meta_src)) then
    v_channel := 'paid_social'; v_paid := true; v_platform := 'META'; v_medium := 'Paid';
    v_label := case when insta then 'Instagram Ads' when site = 'msg' then 'Messenger Ads' else 'Facebook Ads' end;
  elsif p ? 'gclid' or p ? 'gbraid' or p ? 'wbraid' or (src in ('google', 'adwords', 'googleads', 'google_ads') and paid) then
    v_channel := 'paid_search'; v_paid := true; v_platform := 'GOOGLE'; v_medium := 'Paid'; v_label := 'Google Ads';
  elsif p ? 'ttclid' or (src in ('tiktok', 'tt') and paid) then
    v_channel := 'paid_social'; v_paid := true; v_platform := 'TIKTOK'; v_medium := 'Paid'; v_label := 'TikTok Ads';
  elsif p ? 'msclkid' or (src in ('bing', 'microsoft') and paid) then
    v_channel := 'paid_search'; v_paid := true; v_platform := 'OTHER'; v_medium := 'Paid'; v_label := 'Microsoft Ads';
  elsif paid and src <> '' then
    v_channel := 'paid_other'; v_paid := true; v_platform := 'OTHER'; v_medium := 'Paid'; v_label := initcap(src) || ' Ads';
  elsif p ? 'srsltid' then
    v_channel := 'organic_search'; v_paid := false; v_medium := 'Organic'; v_label := 'Google';
  elsif src <> '' then
    v_paid := false;
    if meta_src then
      v_label := case when insta then 'Instagram' when src in ('msg', 'messenger') then 'Messenger' else 'Facebook' end;
      if organic_med then
        v_channel := 'organic_social'; v_medium := 'Organic';
      else
        -- Tagged as Facebook / Instagram but not as an ad or a post: unknown.
        v_channel := 'social'; v_paid := null; v_medium := 'Social (paid or organic)';
      end if;
    elsif src in ('whatsapp', 'wa') then v_channel := 'messaging'; v_medium := 'Messaging'; v_label := 'WhatsApp';
    elsif src in ('google', 'bing', 'yahoo', 'duckduckgo', 'yandex') then v_channel := 'organic_search'; v_medium := 'Organic'; v_label := initcap(src);
    elsif src in ('email', 'newsletter', 'mailchimp', 'klaviyo', 'shopify_email') or med = 'email' then v_channel := 'email'; v_medium := 'Email'; v_label := 'Email';
    elsif src = 'sms' or med = 'sms' then v_channel := 'sms'; v_medium := 'SMS'; v_label := 'SMS';
    elsif src in ('tiktok', 'youtube', 'twitter', 'x', 'linkedin', 'pinterest', 'threads') then
      v_label := case src when 'x' then 'X' when 'tiktok' then 'TikTok' when 'youtube' then 'YouTube' else initcap(src) end;
      if organic_med then v_channel := 'organic_social'; v_medium := 'Organic';
      else v_channel := 'social'; v_paid := null; v_medium := 'Social (paid or organic)'; end if;
    else v_channel := 'referral'; v_medium := 'Referral'; v_label := initcap(src);
    end if;
  elsif p ? 'fbclid' then
    v_channel := 'social'; v_paid := null; v_medium := 'Social (paid or organic)'; v_label := case when insta then 'Instagram' else 'Facebook' end;
  elsif host <> '' then
    v_paid := false;
    if host ~ '(^|\.)(facebook\.com|fb\.com|fb\.me)$' or host like '%com.facebook.%' then
      v_channel := 'social'; v_paid := null; v_medium := 'Social (paid or organic)'; v_label := 'Facebook';
    elsif host ~ '(^|\.)instagram\.com$' or host like '%com.instagram.%' then
      v_channel := 'social'; v_paid := null; v_medium := 'Social (paid or organic)'; v_label := 'Instagram';
    elsif host ~ '(^|\.)(messenger\.com|m\.me)$' then v_channel := 'messaging'; v_medium := 'Messaging'; v_label := 'Messenger';
    elsif host ~ '(^|\.)(whatsapp\.com|wa\.me)$' then v_channel := 'messaging'; v_medium := 'Messaging'; v_label := 'WhatsApp';
    elsif host ~ '(^|\.)google\.[a-z.]+$' or host like '%com.google.%' then v_channel := 'organic_search'; v_medium := 'Organic'; v_label := 'Google';
    elsif host ~ '(^|\.)(bing\.com|duckduckgo\.com|search\.yahoo\.com|yandex\.[a-z]+|baidu\.com)$' then
      v_channel := 'organic_search'; v_medium := 'Organic'; v_label := initcap(split_part(regexp_replace(host, '^(www|search)\.', ''), '.', 1));
    elsif host ~ '(^|\.)(youtube\.com|youtu\.be)$' then v_channel := 'social'; v_paid := null; v_medium := 'Social (paid or organic)'; v_label := 'YouTube';
    elsif host ~ '(^|\.)tiktok\.com$' then v_channel := 'social'; v_paid := null; v_medium := 'Social (paid or organic)'; v_label := 'TikTok';
    elsif host ~ '(^|\.)(t\.co|twitter\.com|x\.com)$' then v_channel := 'social'; v_paid := null; v_medium := 'Social (paid or organic)'; v_label := 'X';
    else v_channel := 'referral'; v_medium := 'Referral'; v_label := regexp_replace(host, '^www\.', '');
    end if;
  else
    v_channel := 'direct'; v_paid := false; v_medium := 'Direct'; v_label := 'Direct';
  end if;

  return jsonb_build_object(
    'channel', v_channel, 'source', v_label, 'medium', v_medium, 'is_paid', v_paid, 'platform', v_platform,
    'click_id_type', v_click_type, 'click_id', case when v_click_type is not null then left(p ->> v_click_type, 200) end,
    'campaign', nullif(coalesce(p ->> 'campaign_name', p ->> 'utm_campaign'), ''),
    'adset', nullif(coalesce(p ->> 'adset_name', case when v_channel = 'paid_social' then p ->> 'utm_term' end), ''),
    'ad', nullif(coalesce(p ->> 'ad_name', case when v_channel = 'paid_social' then p ->> 'utm_content' end), ''),
    'campaign_id', nullif(p ->> 'campaign_id', ''), 'adset_id', nullif(p ->> 'adset_id', ''), 'ad_id', nullif(p ->> 'ad_id', ''),
    'referrer_host', nullif(host, ''));
end;
$$;

-- Fills in where a store order came from when the store had it ready later
-- (Shopify builds the customer journey a little after the order). System only.
create or replace function public.channel_order_attribution_fill(p_channel_id uuid, p_external_id text, p_attribution jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order_id uuid;
  v_row public.order_attributions;
  v_last jsonb := case when jsonb_typeof(p_attribution -> 'last_touch') = 'object' then p_attribution -> 'last_touch' end;
  v_first jsonb := case when jsonb_typeof(p_attribution -> 'first_touch') = 'object' then p_attribution -> 'first_touch' end;
  v_c jsonb;
  v_fc jsonb;
  v_params jsonb;
begin
  perform public._require_system();
  if v_last is null and v_first is null then
    return jsonb_build_object('status', 'NOTHING');
  end if;
  select id into v_order_id from public.orders where sales_channel_id = p_channel_id and external_order_id = p_external_id;
  if v_order_id is null then
    return jsonb_build_object('status', 'NO_ORDER');
  end if;
  select * into v_row from public.order_attributions where order_id = v_order_id;
  if not found then
    perform public._record_order_attribution(v_order_id, p_attribution);
    return jsonb_build_object('status', 'RECORDED');
  end if;
  if v_row.last_touch is not null or v_row.recorded_by = 'STAFF' then
    return jsonb_build_object('status', 'ALREADY');
  end if;
  v_last := coalesce(v_last, v_first);
  v_c := public.classify_touch(v_last);
  v_fc := case when v_first is not null then public.classify_touch(v_first) end;
  v_params := coalesce(v_last -> 'params', '{}'::jsonb);
  update public.order_attributions set channel = v_c ->> 'channel', source = v_c ->> 'source', medium = v_c ->> 'medium',
    is_paid = (v_c ->> 'is_paid')::boolean, platform = (v_c ->> 'platform')::public.marketing_platform,
    campaign = left(v_c ->> 'campaign', 200), adset = left(v_c ->> 'adset', 200), ad = left(v_c ->> 'ad', 200),
    campaign_id = left(v_c ->> 'campaign_id', 64), adset_id = left(v_c ->> 'adset_id', 64), ad_id = left(v_c ->> 'ad_id', 64),
    click_id_type = v_c ->> 'click_id_type', click_id = v_c ->> 'click_id',
    utm_source = left(v_params ->> 'utm_source', 120), utm_medium = left(v_params ->> 'utm_medium', 120),
    utm_campaign = left(v_params ->> 'utm_campaign', 200), utm_content = left(v_params ->> 'utm_content', 200), utm_term = left(v_params ->> 'utm_term', 200),
    landing_page = left(coalesce(v_last ->> 'landing', v_first ->> 'landing'), 300), referrer_host = v_c ->> 'referrer_host',
    first_channel = coalesce(v_fc ->> 'channel', v_c ->> 'channel'), first_source = coalesce(v_fc ->> 'source', v_c ->> 'source'),
    first_touch = v_first, last_touch = v_last, first_touch_at = (v_first ->> 'at')::timestamptz, last_touch_at = (v_last ->> 'at')::timestamptz,
    attributed_at = now()
  where order_id = v_order_id;
  update public.orders set utm_source = coalesce(utm_source, left(v_params ->> 'utm_source', 120)),
    utm_medium = coalesce(utm_medium, left(v_params ->> 'utm_medium', 120)), utm_campaign = coalesce(utm_campaign, left(v_params ->> 'utm_campaign', 200))
  where id = v_order_id;
  return jsonb_build_object('status', 'FILLED');
end;
$$;

-- -----------------------------------------------------------------------------
-- Access
-- -----------------------------------------------------------------------------
revoke all on function public._auto_merge_web_order(uuid), public._effective_order_id(uuid), public.channel_ingest_order(uuid, jsonb, text),
  public._channel_status_tag(public.order_status), public._queue_channel_order_sync(uuid, boolean), public._orders_channel_status_trigger(),
  public.channel_order_cancelled(uuid, text, text), public.channel_fulfillment_context(uuid), public.channel_order_sync_update(uuid, jsonb),
  public.channel_order_sync_retry(uuid), public.order_channel_info(uuid), public.channel_inventory_adopt_change(uuid, uuid, int),
  public.channel_inventory_seen(uuid, text, text, int), public.channel_cost_seen(uuid, text, numeric),
  public._channel_apply_store_details(uuid, text[]), public._channel_catalog_collections(uuid, jsonb),
  public.channel_catalog_import(uuid, jsonb, jsonb), public.channel_catalog_product_upsert(uuid, text, jsonb),
  public.channel_first_sync(uuid, text, boolean, boolean), public.channel_sync_settings_save(uuid, jsonb),
  public.channel_inventory_overview(uuid), public.classify_touch(jsonb), public.channel_order_attribution_fill(uuid, text, jsonb)
from public, anon, authenticated;
grant execute on function public.channel_ingest_order(uuid, jsonb, text), public.channel_order_cancelled(uuid, text, text),
  public.channel_fulfillment_context(uuid), public.channel_order_sync_update(uuid, jsonb), public.channel_inventory_adopt_change(uuid, uuid, int),
  public.channel_inventory_seen(uuid, text, text, int), public.channel_cost_seen(uuid, text, numeric),
  public.channel_catalog_import(uuid, jsonb, jsonb), public.channel_catalog_product_upsert(uuid, text, jsonb),
  public.channel_order_attribution_fill(uuid, text, jsonb)
to service_role;
grant execute on function public.channel_order_sync_retry(uuid), public.order_channel_info(uuid), public.channel_first_sync(uuid, text, boolean, boolean),
  public.channel_sync_settings_save(uuid, jsonb), public.channel_inventory_overview(uuid)
to authenticated, service_role;
grant execute on function public.classify_touch(jsonb) to authenticated, service_role;
