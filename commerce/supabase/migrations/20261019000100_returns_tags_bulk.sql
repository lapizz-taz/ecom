-- Returns, merged return tab, Fullfilio tags on Shopify, product bulk edit.
--
-- 1. Delivered is final. A delivered (or partly delivered) order can no longer become a return, by hand or by a courier
--    webhook; a courier "return" after delivery is written to the order log and the order stays delivered.
-- 2. One "Return pending" tab: delivery failed / refused, return asked for and on its way back are the same stage now
--    (Steadfast "cancelled" and Pathao "return" / "delivery failed" land there automatically).
-- 3. Shopify tags carry the app name: "Fullfilio: Delivered", "Fullfilio: merged into 1007" (old "Status: …" tags are
--    replaced on the next sync).
-- 4. Bulk product edit (status, price, cost, category, stock counting) and bulk stock adjustments, all-or-nothing.

-- 1. Delivered is final --------------------------------------------------------------------------------------
delete from public.order_status_transitions
where from_status in ('DELIVERED', 'PARTIALLY_DELIVERED') and to_status = 'RETURN_REQUESTED';

create or replace function public.apply_shipment_status(
  p_shipment_id uuid,
  p_status public.shipment_status,
  p_description text default null,
  p_location text default null,
  p_occurred_at timestamptz default null,
  p_source public.data_source default 'MANUAL',
  p_raw jsonb default null,
  p_event_key text default null
)
returns public.shipments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ship public.shipments;
  v_order public.orders;
  v_event_id uuid;
begin
  perform public.require_permission('shipments.manage');
  select * into v_ship from public.shipments where id = p_shipment_id for update;
  if not found then
    raise exception 'NOT_FOUND: shipment not found' using errcode = 'P0002';
  end if;

  insert into public.shipment_events(shipment_id, status, description, location, source, event_key, raw, occurred_at, created_by)
  values (p_shipment_id, p_status, p_description, p_location, p_source, p_event_key, p_raw, coalesce(p_occurred_at, now()), auth.uid())
  on conflict (event_key) do nothing
  returning id into v_event_id;
  if v_event_id is null then
    return v_ship; -- duplicate callback
  end if;

  update public.shipments set status = p_status,
    delivered_at = case when p_status in ('DELIVERED', 'PARTIALLY_DELIVERED') then coalesce(delivered_at, coalesce(p_occurred_at, now())) else delivered_at end,
    return_status = case when p_status = 'RETURNING' then 'IN_TRANSIT'
                         when p_status = 'RETURNED' then 'IN_TRANSIT' else return_status end
  where id = p_shipment_id returning * into v_ship;

  if not v_ship.is_active then
    return v_ship;
  end if;
  select * into v_order from public.orders where id = v_ship.order_id for update;

  -- Cancel asked for, but the courier picked the parcel up anyway.
  if v_order.status = 'PENDING_CANCEL' and v_order.shipped_at is null
     and p_status in ('PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'PARTIALLY_DELIVERED', 'FAILED', 'RETURNING', 'RETURNED') then
    perform public._commit_order_stock(v_order.id);
    update public.orders set shipped_at = coalesce(p_occurred_at, now()) where id = v_order.id returning * into v_order;
    perform public._order_log(v_order.id, 'PICKED_UP_DESPITE_CANCEL',
      'The courier picked the parcel up before the cancellation went through');
  end if;

  if p_status in ('PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY') and v_order.status in ('PACKING', 'READY_TO_SHIP', 'PROCESSING') then
    if v_order.status <> 'READY_TO_SHIP' then
      perform public._order_advance_to(v_order.id, 'READY_TO_SHIP', 'Picked up by courier');
    end if;
    perform public._transition_order(v_order.id, 'SHIPPED', coalesce(p_description, 'Picked up by courier'));
  elsif p_status in ('DELIVERED', 'PARTIALLY_DELIVERED') then
    if v_order.status in ('PACKING', 'READY_TO_SHIP', 'PROCESSING') then
      if v_order.status <> 'READY_TO_SHIP' then
        perform public._order_advance_to(v_order.id, 'READY_TO_SHIP', 'Courier update');
      end if;
      perform public._transition_order(v_order.id, 'SHIPPED', 'Courier update');
      v_order.status := 'SHIPPED';
    end if;
    if p_status = 'PARTIALLY_DELIVERED' and v_order.status in ('SHIPPED', 'FAILED_DELIVERY') then
      perform public._transition_order(v_order.id, 'PARTIALLY_DELIVERED',
        coalesce(p_description, 'Partially delivered by courier — record which items came back'));
    elsif v_order.status in ('SHIPPED', 'RETURN_REQUESTED', 'FAILED_DELIVERY', 'PENDING_CANCEL', 'LOST') then
      if v_order.status = 'FAILED_DELIVERY' then
        perform public._transition_order(v_order.id, 'SHIPPED', 'Re-attempted delivery');
      end if;
      perform public._transition_order(v_order.id, 'DELIVERED', coalesce(p_description, 'Delivered by courier'));
    end if;
  elsif p_status = 'FAILED' and v_order.status = 'SHIPPED' then
    perform public._transition_order(v_order.id, 'FAILED_DELIVERY', coalesce(p_description, 'Delivery failed'));
  elsif p_status in ('RETURNING', 'RETURNED') then
    if v_order.status in ('SHIPPED', 'FAILED_DELIVERY', 'RETURN_REQUESTED', 'PENDING_CANCEL') then
      perform public._transition_order(v_order.id, 'RETURNING', coalesce(p_description, 'Parcel returning to merchant'));
    elsif v_order.status in ('DELIVERED', 'PARTIALLY_DELIVERED') then
      -- Delivered is final: a later courier "return" is recorded, the order stays delivered.
      perform public._order_log(v_order.id, 'COURIER_RETURN_AFTER_DELIVERY',
        format('The courier reported "%s" after delivery. The order stays %s; check with the courier.',
          lower(p_status::text), lower(replace(v_order.status::text, '_', ' '))));
      return v_ship;
    end if;
    if p_status = 'RETURNED' then
      perform public._order_log(v_order.id, 'PARCEL_RETURNED',
        'Courier marked the parcel as returned. Receive it to restock or mark damaged.');
    end if;
  elsif p_status = 'CANCELLED' and v_order.status = 'PENDING_CANCEL' and v_order.shipped_at is null then
    perform public._transition_order(v_order.id, 'CANCELLED', coalesce(p_description, 'Courier cancelled the parcel'));
  end if;
  return v_ship;
end;
$$;

-- 2. One return stage ----------------------------------------------------------------------------------------
create or replace function public.order_stage(p_status public.order_status, p_confirmed_at timestamptz)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_confirmed_at is null then 'WEB'
    when p_status in ('CONFIRMED', 'PROCESSING', 'PRODUCTION', 'QUALITY_CHECK', 'PACKING') then 'PENDING'
    when p_status = 'PRE_ORDER' then 'PRE_ORDER'
    when p_status = 'READY_TO_SHIP' then 'RTS'
    when p_status = 'SHIPPED' then 'SHIPPED'
    when p_status = 'PENDING_CANCEL' then 'PENDING_CANCEL'
    when p_status = 'DELIVERED' then 'DELIVERED'
    when p_status = 'PARTIALLY_DELIVERED' then 'PARTIAL'
    when p_status in ('FAILED_DELIVERY', 'RETURN_REQUESTED', 'RETURNING') then 'RETURN_PENDING'
    when p_status = 'RETURNED' then 'RETURNED'
    when p_status = 'LOST' then 'LOST'
    else 'CANCELLED'
  end
$$;

-- 3. Fullfilio tags --------------------------------------------------------------------------------------------
create or replace function public._channel_status_tag(p_status public.order_status)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select 'Fullfilio: ' || case p_status
    when 'PENDING' then 'New' when 'FRAUD_CHECK' then 'New' when 'FRAUD_REVIEW' then 'New' when 'ADVANCE_REQUIRED' then 'Waiting for advance'
    when 'CONFIRMATION_REQUIRED' then 'New' when 'CONFIRMED' then 'Confirmed' when 'PRE_ORDER' then 'Pre-order'
    when 'PROCESSING' then 'Confirmed' when 'PRODUCTION' then 'In production' when 'QUALITY_CHECK' then 'Packing' when 'PACKING' then 'Packing'
    when 'READY_TO_SHIP' then 'Ready to ship' when 'SHIPPED' then 'Shipped' when 'PENDING_CANCEL' then 'Cancelling'
    when 'DELIVERED' then 'Delivered' when 'PARTIALLY_DELIVERED' then 'Partly delivered' when 'CANCELLED' then 'Cancelled'
    when 'RETURN_REQUESTED' then 'Return requested' when 'RETURNING' then 'Returning' when 'RETURNED' then 'Returned'
    when 'FAILED_DELIVERY' then 'Delivery failed' when 'LOST' then 'Lost' when 'REJECTED_FRAUD' then 'Cancelled'
    else initcap(replace(p_status::text, '_', ' ')) end
$$;

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
      from public.order_items i where i.order_id = p_order_id), '[]'::jsonb)
  );
end;
$$;

-- 4. Bulk product edit and bulk stock ----------------------------------------------------------------------------
create or replace function public.admin_products_bulk_update(p_ids uuid[], p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_quick jsonb := coalesce(p, '{}'::jsonb) - 'category_id';
  v_n int := 0;
begin
  perform public.require_permission('products.manage');
  if coalesce(array_length(p_ids, 1), 0) = 0 then
    raise exception 'VALIDATION: choose at least one product' using errcode = '22023';
  end if;
  if array_length(p_ids, 1) > 500 then
    raise exception 'VALIDATION: edit at most 500 products at a time' using errcode = '22023';
  end if;
  if p ? 'category_id' and nullif(p ->> 'category_id', '') is not null
     and not exists (select 1 from public.categories where id = (p ->> 'category_id')::uuid) then
    raise exception 'VALIDATION: category not found' using errcode = '22023';
  end if;
  foreach v_id in array p_ids loop
    if not exists (select 1 from public.products where id = v_id) then
      raise exception 'NOT_FOUND: product not found' using errcode = 'P0002';
    end if;
    if v_quick <> '{}'::jsonb then
      perform public.admin_product_quick_update(v_id, v_quick);
    end if;
    if p ? 'category_id' then
      update public.products set category_id = nullif(p ->> 'category_id', '')::uuid where id = v_id;
    end if;
    v_n := v_n + 1;
  end loop;
  perform public.log_audit('products.bulk_update', 'product', null, null, jsonb_build_object('ids', p_ids, 'changes', p));
  return jsonb_build_object('updated', v_n);
end;
$$;

-- Every line goes through adjust_stock (permission, ledger entry, store sync); one failure undoes them all.
create or replace function public.inventory_bulk_adjust(p_items jsonb, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_n int := 0;
  v_mode text;
  v_qty int;
begin
  perform public.require_permission('inventory.adjust');
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'VALIDATION: nothing to change' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) > 1000 then
    raise exception 'VALIDATION: change at most 1000 variants at a time' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_note, ''))) < 2 then
    raise exception 'VALIDATION: add a short note (why the stock changes)' using errcode = '22023';
  end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_mode := upper(coalesce(v_item ->> 'mode', 'ADD'));
    v_qty := (v_item ->> 'quantity')::int;
    if v_mode not in ('ADD', 'REMOVE', 'SET') or v_qty is null or v_qty < 0 then
      raise exception 'VALIDATION: each line needs a quantity of 0 or more and ADD, REMOVE or SET' using errcode = '22023';
    end if;
    continue when v_qty = 0 and v_mode <> 'SET';
    perform public.adjust_stock((v_item ->> 'variant_id')::uuid, 'ADJUSTMENT', v_qty, trim(p_note), v_mode, null);
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('changed', v_n);
end;
$$;

revoke all on function public.admin_products_bulk_update(uuid[], jsonb), public.inventory_bulk_adjust(jsonb, text) from public, anon;
grant execute on function public.admin_products_bulk_update(uuid[], jsonb), public.inventory_bulk_adjust(jsonb, text) to authenticated;
