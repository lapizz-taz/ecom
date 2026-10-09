-- =============================================================================
-- Smart automatic merging of web orders.
--
-- When a customer (same phone number) places another order while an earlier
-- one is still in Web Orders, the new order is merged into the earlier one in
-- the background — no pop-up. Rules (all in settings.orders, editable):
--   * auto_merge_web_enabled    on/off (default on)
--   * auto_merge_window_hours   how far apart the two orders may be (default 12)
--   * merge_review_priority     call statuses that may be merged, best first;
--                               the merged order takes the best one
--                               (Processing beats Good-but-no-response)
-- Only orders that are safe to combine are merged: both unapproved, nothing
-- paid on the new one, no coupon on the new one, no courier or label yet, same
-- district, not from Shopify/WooCommerce (those stay 1:1 with the store's
-- order so fulfilment can be sent back). Anything else is flagged instead.
-- The merged order is kept (cancelled as "merged into"), never removed; its
-- items, stock reservation and messages move or are skipped exactly once.
--
-- A new web order whose customer already has an order in Approved Orders is
-- flagged "Maybe duplicate — already in Approved Orders" and left for staff.
-- =============================================================================

alter table public.order_merges add column if not exists source_status text;
alter table public.order_merges add column if not exists source_review_status text;
alter table public.order_merges add column if not exists target_review_before text;
alter table public.order_merges add column if not exists target_review_after text;
alter table public.order_merges add column if not exists reason text;
create unique index if not exists order_merges_source_uq on public.order_merges(source_order_id) where source_order_id is not null;
create index if not exists order_merges_order_idx on public.order_merges(order_id, created_at);

alter table public.orders add column if not exists duplicate_reason text;
create index if not exists orders_phone_web_idx on public.orders(customer_phone, created_at desc)
  where confirmed_at is null and merged_into is null;
create index if not exists orders_phone_open_idx on public.orders(customer_phone) where confirmed_at is not null;

-- Defaults for the new settings (kept if already set).
update public.settings set value = jsonb_build_object(
    'auto_merge_web_enabled', true,
    'auto_merge_window_hours', 12,
    'merge_review_priority', jsonb_build_array('PROCESSING', 'FOLLOW_UP', 'GOOD_NO_RESPONSE', 'NO_RESPONSE')) || value
where key = 'orders';

-- Adds one line to an order: the same product at the same price is added to
-- the existing line (1 + 2 = 3), anything else becomes a new line. Stock for
-- the added quantity is reserved here.
create or replace function public._merge_line_into(p_order public.orders, p_line jsonb)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.order_items;
  v_qty int := (p_line ->> 'quantity')::int;
  v_inv public.inventory;
begin
  select * into v_item from public.order_items
  where order_id = p_order.id and variant_id = (p_line ->> 'variant_id')::uuid
    and unit_price = (p_line ->> 'unit_price')::numeric and returned_quantity = 0
  order by created_at limit 1 for update;
  if not found then
    return public._add_order_lines(p_order, jsonb_build_array(p_line));
  end if;
  if v_item.track_inventory then
    select * into v_inv from public.inventory where variant_id = v_item.variant_id for update;
    if v_inv.available < v_qty and not public.allow_overselling() then
      raise exception 'INSUFFICIENT_STOCK: % has only % available', v_item.product_name, greatest(v_inv.available, 0) using errcode = 'P0001';
    end if;
    perform public._apply_inventory_movement(v_item.variant_id, 'RESERVATION', 0, v_qty, 0,
      'ORDER', p_order.id, p_order.order_number, 'Reserved for order (merged)', null, true);
    insert into public.stock_reservations(order_id, order_item_id, variant_id, quantity)
    values (p_order.id, v_item.id, v_item.variant_id, v_qty);
  end if;
  update public.order_items set quantity = quantity + v_qty, line_subtotal = line_subtotal + public.money(v_item.unit_price * v_qty),
    line_total = line_total + public.money(v_item.unit_price * v_qty)
  where id = v_item.id;
  return v_qty;
end;
$$;

-- Moves every line of p_source into p_target and marks p_source merged.
-- Caller holds both rows locked. Returns the updated target.
create or replace function public._merge_web_orders(p_target_id uuid, p_source_id uuid, p_reason text, p_kind text default 'AUTO')
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_target public.orders;
  v_source public.orders;
  v_line jsonb;
  v_lines jsonb;
  v_before numeric;
  v_qty int := 0;
  v_priority jsonb := coalesce(public.get_setting('orders') -> 'merge_review_priority', '["PROCESSING","FOLLOW_UP","GOOD_NO_RESPONSE","NO_RESPONSE"]'::jsonb);
  v_result text;
  v_note text;
  v_review_before text;
begin
  select * into v_target from public.orders where id = p_target_id;
  v_review_before := v_target.review_status;
  select * into v_source from public.orders where id = p_source_id;
  select coalesce(jsonb_agg(jsonb_build_object(
      'product_id', product_id, 'variant_id', variant_id, 'product_name', product_name,
      'variant_title', coalesce(variant_title, 'Default'), 'sku', sku, 'image_url', image_url,
      'unit_price', unit_price, 'unit_cost', unit_cost, 'quantity', quantity, 'line_subtotal', line_subtotal,
      'track_inventory', track_inventory, 'requires_production', requires_production) order by created_at), '[]'::jsonb)
  into v_lines from public.order_items where order_id = v_source.id;

  v_before := v_target.total_amount;
  perform public._release_order_stock(v_source.id, format('Released: merged into %s', v_target.order_number));
  for v_line in select * from jsonb_array_elements(v_lines) loop
    v_qty := v_qty + public._merge_line_into(v_target, v_line);
  end loop;

  -- The better call status wins (by the configured priority).
  select x into v_result from jsonb_array_elements_text(v_priority) with ordinality as p(x, n)
  where x in (v_target.review_status, v_source.review_status) order by n limit 1;
  v_result := coalesce(v_result, v_target.review_status);

  v_note := case when public.normalize_address(v_source.shipping_address) is distinct from public.normalize_address(v_target.shipping_address)
    then format('Merged order %s gave another address: %s', v_source.order_number, v_source.shipping_address) end;
  update public.orders set
    merged_count = merged_count + 1 + v_source.merged_count,
    review_status = v_result,
    customer_note = case
      when v_source.customer_note is null and v_note is null then customer_note
      else concat_ws(E'\n', customer_note, v_source.customer_note, v_note) end
  where id = v_target.id;
  v_target := public.recalculate_order_totals(v_target.id);

  update public.orders set merged_into = v_target.id, duplicate_status = 'MERGED', review_status = 'DUPLICATE'
  where id = v_source.id;
  perform public._transition_order(v_source.id, 'CANCELLED', format('Merged into %s', v_target.order_number),
    jsonb_build_object('merged_into', v_target.id));
  -- One order, one set of messages: the merged order's queued messages are skipped.
  update public.notification_logs set status = 'SKIPPED', error = 'Order merged'
  where order_id = v_source.id and status = 'QUEUED';

  insert into public.order_merges(order_id, source_order_id, kind, idempotency_key, items, amount, created_by,
    source_status, source_review_status, target_review_before, target_review_after, reason)
  values (v_target.id, v_source.id, p_kind, v_source.idempotency_key, v_lines, v_target.total_amount - v_before, auth.uid(),
    v_source.status::text, v_source.review_status, v_review_before, v_result, p_reason);

  perform public._order_log(v_target.id, 'ORDER_MERGED',
    format('%s merged into this order automatically (%s item(s), %s)', v_source.order_number, v_qty, p_reason), null, null,
    jsonb_build_object('source_order_id', v_source.id, 'order_number', v_source.order_number, 'added_amount', v_target.total_amount - v_before,
      'source_review_status', v_source.review_status, 'review_status', v_result));
  perform public.log_audit('order.auto_merged', 'order', v_target.id::text,
    jsonb_build_object('total', v_before), jsonb_build_object('total', v_target.total_amount, 'review_status', v_result),
    jsonb_build_object('order_number', v_target.order_number, 'merged_order', v_source.order_number, 'reason', p_reason));
  perform public.refresh_customer_stats(v_target.customer_id);
  return v_target;
end;
$$;

-- Looks for an earlier web order of the same customer that this new one can
-- join. Returns the order it was merged into, or null.
create or replace function public._auto_merge_web_order(p_order_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_target public.orders;
  v_hours numeric := public.setting_numeric('orders', array['auto_merge_window_hours'], 12);
  v_priority text[] := coalesce((select array_agg(x) from jsonb_array_elements_text(
      coalesce(public.get_setting('orders') -> 'merge_review_priority', '["PROCESSING","FOLLOW_UP","GOOD_NO_RESPONSE","NO_RESPONSE"]'::jsonb)) x), '{}');
  v_ok constant public.order_status[] := array['PENDING', 'CONFIRMATION_REQUIRED']::public.order_status[];
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
  if v_order.confirmed_at is not null or v_order.merged_into is not null or not (v_order.status = any(v_ok))
     or not (v_order.review_status = any(v_priority)) or v_order.sales_channel_id is not null
     or v_order.source not in ('STOREFRONT', 'ADMIN') or v_order.amount_paid > 0 or v_order.coupon_id is not null
     or exists (select 1 from public.payments where order_id = v_order.id and status = 'REQUIRES_VERIFICATION')
     or exists (select 1 from public.shipments where order_id = v_order.id and is_active) then
    return null;
  end if;

  select o.* into v_target from public.orders o
  where o.customer_phone = v_order.customer_phone
    and o.id <> v_order.id
    and o.confirmed_at is null and o.merged_into is null
    and o.status = any(v_ok)
    and o.review_status = any(v_priority)
    and o.sales_channel_id is null
    and o.source in ('STOREFRONT', 'ADMIN')
    and o.created_at <= v_order.created_at
    and o.created_at >= v_order.created_at - make_interval(secs => (v_hours * 3600)::int)
    and lower(o.shipping_district) = lower(v_order.shipping_district)
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

-- A new order is flagged when the customer already has an order being
-- processed in Approved Orders (any age), or another recent order.
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
      and d.status not in ('CANCELLED', 'REJECTED_FRAUD')
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

-- After a new order is saved: merge it if it can be, else flag a duplicate.
-- Returns the order the caller should show (the merged-into one when merged).
create or replace function public._after_order_created(p_order_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_into uuid;
begin
  begin
    v_into := public._auto_merge_web_order(p_order_id);
  exception when others then
    -- A failed merge never loses the order: it stays as it was, flagged.
    perform public.log_system_event('WARN', 'OTHER', 'auto_merge', format('Auto-merge skipped: %s', sqlerrm),
      jsonb_build_object('order_id', p_order_id));
    v_into := null;
  end;
  if v_into is not null then
    return v_into;
  end if;
  perform public._flag_possible_duplicate(p_order_id);
  return p_order_id;
end;
$$;

create or replace function public.place_storefront_order(p_payload jsonb, p_fraud_check_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_target public.orders;
  v_key text := nullif(p_payload ->> 'idempotency_key', '');
  v_is_new boolean;
  v_merged boolean := false;
  v_shown uuid;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  if v_key is not null then
    select o.* into v_order from public.order_merges m join public.orders o on o.id = m.order_id
    where m.idempotency_key = v_key;
    v_merged := found;
  end if;

  if not v_merged then
    v_is_new := v_key is null or not exists (select 1 from public.orders where idempotency_key = v_key);
    if v_is_new then
      v_target := public._find_merge_target(p_payload, p_fraud_check_id);
      if v_target.id is not null then
        v_order := public._merge_checkout_into(v_target.id, p_payload);
        v_merged := true;
      end if;
    end if;
  end if;

  if not v_merged then
    v_order := public._create_order(p_payload, 'STOREFRONT');
    if v_is_new then
      v_order := public._apply_fraud_decision(v_order.id, p_fraud_check_id);
      v_shown := public._after_order_created(v_order.id);
      if v_shown <> v_order.id then
        select * into v_order from public.orders where id = v_shown;
        v_merged := true;
      end if;
    end if;
  end if;

  return public._order_public_json(v_order) || jsonb_build_object(
    'merged', v_merged,
    'payment_requirement', public.payment_requirement_for(
      coalesce(v_order.fraud_decision, 'ALLOW'), v_order.advance_required, v_order.total_amount, v_order.payment_method));
end;
$$;

create or replace function public.admin_create_order(p_payload jsonb, p_confirm boolean default false)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_shown uuid;
  v_is_new boolean := nullif(p_payload ->> 'idempotency_key', '') is null
    or not exists (select 1 from public.orders where idempotency_key = p_payload ->> 'idempotency_key');
begin
  perform public.require_permission('orders.create');
  v_order := public._create_order(p_payload, 'ADMIN');
  if p_confirm then
    v_order := public._transition_order(v_order.id, 'CONFIRMED', 'Confirmed by staff when the order was created');
  end if;
  if v_is_new then
    v_shown := public._after_order_created(v_order.id);
    select * into v_order from public.orders where id = v_shown;
  end if;
  perform public.log_audit('order.created', 'order', v_order.id::text, null,
    jsonb_build_object('order_number', v_order.order_number, 'total', v_order.total_amount));
  return v_order;
end;
$$;

-- Staff: run the merge rules over the web orders already waiting (e.g. after
-- turning the feature on or widening the window). Oldest first, so each
-- customer ends with one order.
create or replace function public.admin_auto_merge_scan()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_merged int := 0;
begin
  perform public.require_permission('orders.update');
  for v_id in
    select o.id from public.orders o
    where o.confirmed_at is null and o.merged_into is null and o.status in ('PENDING', 'CONFIRMATION_REQUIRED')
      and exists (select 1 from public.orders p where p.customer_phone = o.customer_phone and p.id <> o.id
                  and p.confirmed_at is null and p.merged_into is null and p.created_at <= o.created_at)
    order by o.created_at
  loop
    if public._auto_merge_web_order(v_id) is not null then
      v_merged := v_merged + 1;
    end if;
  end loop;
  return jsonb_build_object('merged', v_merged);
end;
$$;

-- Merge details for the order page.
create or replace function public.order_merge_info(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_primary public.orders;
begin
  perform public.require_permission('orders.view');
  select * into v_order from public.orders where id = p_order_id;
  if not found then
    raise exception 'NOT_FOUND: order not found' using errcode = 'P0002';
  end if;
  select * into v_primary from public.orders where id = coalesce(v_order.merged_into, v_order.id);
  if not exists (select 1 from public.order_merges where order_id = v_primary.id) then
    return null;
  end if;
  return jsonb_build_object(
    'primary', jsonb_build_object('id', v_primary.id, 'order_number', v_primary.order_number, 'status', v_primary.status,
      'review_status', v_primary.review_status, 'total', v_primary.total_amount, 'created_at', v_primary.created_at),
    'is_primary', v_order.merged_into is null,
    'merges', coalesce((select jsonb_agg(jsonb_build_object(
        'id', m.id, 'kind', m.kind, 'at', m.created_at, 'amount', m.amount, 'reason', m.reason,
        'items', m.items, 'source_status', m.source_status, 'source_review_status', m.source_review_status,
        'review_after', m.target_review_after,
        'source', case when s.id is null then null else jsonb_build_object('id', s.id, 'order_number', s.order_number, 'created_at', s.created_at) end)
      order by m.created_at) from public.order_merges m left join public.orders s on s.id = m.source_order_id where m.order_id = v_primary.id), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(jsonb_build_object('name', i.product_name, 'variant', i.variant_title, 'quantity', i.quantity,
        'line_total', i.line_total) order by i.created_at) from public.order_items i where i.order_id = v_primary.id), '[]'::jsonb)
  );
end;
$$;

revoke all on function public._merge_line_into(public.orders, jsonb), public._merge_web_orders(uuid, uuid, text, text),
  public._auto_merge_web_order(uuid), public._after_order_created(uuid), public.admin_auto_merge_scan(), public.order_merge_info(uuid)
from public, anon, authenticated;
grant execute on function public.admin_auto_merge_scan(), public.order_merge_info(uuid) to authenticated;

-- The order list shows why an order is flagged and what the other order is doing.
CREATE OR REPLACE FUNCTION public.admin_search_orders(p_filters jsonb DEFAULT '{}'::jsonb, p_sort text DEFAULT 'created_at'::text, p_direction text DEFAULT 'desc'::text, p_limit integer DEFAULT 25, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_q text := nullif(trim(coalesce(p_filters ->> 'q', '')), '');
  v_phone text := public.clean_phone(p_filters ->> 'q');
  v_tz text := public.store_timezone();
  v_result jsonb;
  v_statuses public.order_status[];
  v_label text := nullif(p_filters ->> 'label', '');
  v_queue text := nullif(p_filters ->> 'queue', '');
  v_review text := nullif(p_filters ->> 'review_status', '');
  v_stage text := nullif(p_filters ->> 'stage', '');
  v_tags text[];
  v_employee uuid := nullif(p_filters ->> 'employee', '')::uuid;
  v_code text := nullif(trim(coalesce(p_filters ->> 'product_code', '')), '');
  v_name text := nullif(trim(coalesce(p_filters ->> 'product_name', '')), '');
  v_only boolean := coalesce((p_filters ->> 'only_product')::boolean, false);
  v_qty_min int := nullif(p_filters ->> 'qty_min', '')::int;
  v_qty_max int := nullif(p_filters ->> 'qty_max', '')::int;
  v_orders_min int := nullif(p_filters ->> 'customer_orders_min', '')::int;
  v_orders_max int := nullif(p_filters ->> 'customer_orders_max', '')::int;
  v_rate_min numeric := nullif(p_filters ->> 'success_min', '')::numeric;
  v_rate_max numeric := nullif(p_filters ->> 'success_max', '')::numeric;
  v_web_source text := nullif(p_filters ->> 'web_source', '');
  v_channel text := nullif(p_filters ->> 'channel', '');
  v_reference text := nullif(trim(coalesce(p_filters ->> 'reference', '')), '');
  v_uploaded text := nullif(p_filters ->> 'uploaded', '');
begin
  perform public.require_permission('orders.view');
  if p_filters ? 'statuses' then
    select array_agg(s::public.order_status) into v_statuses from jsonb_array_elements_text(p_filters -> 'statuses') s;
  elsif nullif(p_filters ->> 'status', '') is not null then
    v_statuses := array[(p_filters ->> 'status')::public.order_status];
  end if;
  if jsonb_typeof(p_filters -> 'tags') = 'array' and jsonb_array_length(p_filters -> 'tags') > 0 then
    select array_agg(t) into v_tags from jsonb_array_elements_text(p_filters -> 'tags') t;
  end if;

  with filtered as (
    select o.*
    from public.orders o
    left join public.order_attributions a on a.order_id = o.id
    where (v_statuses is null or o.status = any(v_statuses))
      and (v_queue is null or (v_queue = 'web' and o.confirmed_at is null) or (v_queue = 'approved' and o.confirmed_at is not null))
      and (v_review is null or o.review_status = v_review)
      and (v_stage is null or public.order_stage(o.status, o.confirmed_at) = v_stage)
      and (not coalesce((p_filters ->> 'follow_up_due')::boolean, false) or o.follow_up_at <= now())
      and (nullif(p_filters ->> 'payment_status', '') is null or o.payment_status = (p_filters ->> 'payment_status')::public.payment_status)
      and (nullif(p_filters ->> 'payment_method', '') is null or o.payment_method = (p_filters ->> 'payment_method')::public.payment_method)
      and (nullif(p_filters ->> 'fraud_status', '') is null or o.fraud_status = (p_filters ->> 'fraud_status')::public.fraud_status)
      and (nullif(p_filters ->> 'risk_level', '') is null or o.risk_level = (p_filters ->> 'risk_level')::public.risk_level)
      and (nullif(p_filters ->> 'source', '') is null or o.source = (p_filters ->> 'source')::public.order_source)
      and (nullif(p_filters ->> 'sales_channel', '') is null
           or (p_filters ->> 'sales_channel' = 'own' and o.sales_channel_id is null)
           or o.sales_channel_id::text = p_filters ->> 'sales_channel'
           or exists (select 1 from public.sales_channels sc where sc.id = o.sales_channel_id and sc.platform = upper(p_filters ->> 'sales_channel')))
      and (nullif(p_filters ->> 'customer_id', '') is null or o.customer_id = (p_filters ->> 'customer_id')::uuid)
      and (nullif(p_filters ->> 'district', '') is null or lower(o.shipping_district) = lower(p_filters ->> 'district'))
      and (nullif(p_filters ->> 'date_from', '') is null or o.created_at >= ((p_filters ->> 'date_from')::date::timestamp at time zone v_tz))
      and (nullif(p_filters ->> 'date_to', '') is null or o.created_at < (((p_filters ->> 'date_to')::date + 1)::timestamp at time zone v_tz))
      and (nullif(p_filters ->> 'courier_id', '') is null or exists (
            select 1 from public.shipments s where s.order_id = o.id and s.is_active and s.courier_id = (p_filters ->> 'courier_id')::uuid))
      and (not coalesce((p_filters ->> 'has_due')::boolean, false) or o.cod_amount > 0)
      and (not coalesce((p_filters ->> 'duplicates')::boolean, false)
           or (o.duplicate_status = 'SUSPECTED' and o.status not in ('CANCELLED', 'REJECTED_FRAUD')))
      and (v_label is null or (v_label = 'printed' and o.label_printed_at is not null)
                           or (v_label = 'not_printed' and o.label_printed_at is null))
      and (v_uploaded is null
           or (v_uploaded = 'yes') = exists (select 1 from public.shipments s join public.couriers c on c.id = s.courier_id
                                              where s.order_id = o.id and s.is_active and c.api_enabled
                                                and coalesce(s.consignment_id, s.tracking_number) is not null))
      and (v_tags is null or o.tags && v_tags)
      and (v_employee is null or v_employee in (o.created_by, o.assigned_to, o.review_updated_by, o.approved_by))
      and (v_code is null or exists (select 1 from public.order_items oi where oi.order_id = o.id and oi.sku ilike '%' || v_code || '%'))
      and (v_name is null or exists (select 1 from public.order_items oi where oi.order_id = o.id and oi.product_name ilike '%' || v_name || '%'))
      and (not v_only or (v_code is null and v_name is null) or not exists (
            select 1 from public.order_items oi where oi.order_id = o.id
              and not ((v_code is null or oi.sku ilike '%' || v_code || '%') and (v_name is null or oi.product_name ilike '%' || v_name || '%'))))
      and ((v_qty_min is null and v_qty_max is null) or (
            select coalesce(sum(oi.quantity), 0) from public.order_items oi where oi.order_id = o.id)
            between coalesce(v_qty_min, 0) and coalesce(v_qty_max, 2147483647))
      and ((v_orders_min is null and v_orders_max is null) or (
            select coalesce(c.total_orders, 0) from public.customers c where c.id = o.customer_id)
            between coalesce(v_orders_min, 0) and coalesce(v_orders_max, 2147483647))
      and ((v_rate_min is null and v_rate_max is null) or
            public._order_success_rate(o.fraud_check_id) between coalesce(v_rate_min, 0) and coalesce(v_rate_max, 100))
      and (v_web_source is null or lower(coalesce(a.source, 'Unknown')) = lower(v_web_source))
      and (v_channel is null or coalesce(a.channel, 'unknown') = v_channel)
      and (v_reference is null or a.campaign ilike '%' || v_reference || '%' or a.utm_campaign ilike '%' || v_reference || '%'
           or a.referrer_host ilike '%' || v_reference || '%' or a.landing_page ilike '%' || v_reference || '%'
           or a.utm_source ilike '%' || v_reference || '%')
      and (v_q is null
        or o.order_number ilike '%' || v_q || '%'
        or (v_phone is not null and length(v_phone) >= 4 and o.customer_phone like '%' || v_phone || '%')
        or o.customer_name ilike '%' || v_q || '%'
        or o.shipping_address ilike '%' || v_q || '%'
        or exists (select 1 from public.shipments s where s.order_id = o.id and (s.tracking_number ilike v_q || '%' or s.consignment_id ilike v_q || '%'))
        or exists (select 1 from public.order_items oi where oi.order_id = o.id and oi.sku ilike v_q || '%'))
  ), counted as (
    select count(*) as total from filtered
  ), page as (
    select f.* from filtered f
    order by
      case when p_direction = 'asc' and p_sort = 'created_at' then f.created_at end asc,
      case when p_direction <> 'asc' and p_sort = 'created_at' then f.created_at end desc,
      case when p_direction = 'asc' and p_sort = 'total_amount' then f.total_amount end asc,
      case when p_direction <> 'asc' and p_sort = 'total_amount' then f.total_amount end desc,
      case when p_direction = 'asc' and p_sort = 'order_number' then f.order_number end asc,
      case when p_direction <> 'asc' and p_sort = 'order_number' then f.order_number end desc,
      case when p_direction = 'asc' and p_sort = 'status' then f.status end asc,
      case when p_direction <> 'asc' and p_sort = 'status' then f.status end desc,
      case when p_direction = 'asc' and p_sort = 'follow_up_at' then f.follow_up_at end asc nulls last,
      case when p_direction <> 'asc' and p_sort = 'follow_up_at' then f.follow_up_at end desc nulls last,
      case when p_direction = 'asc' and p_sort = 'success_rate' then public._order_success_rate(f.fraud_check_id) end asc nulls last,
      case when p_direction <> 'asc' and p_sort = 'success_rate' then public._order_success_rate(f.fraud_check_id) end desc nulls last,
      f.created_at desc
    limit least(greatest(p_limit, 1), 200) offset greatest(p_offset, 0)
  )
  select jsonb_build_object(
    'total', (select total from counted),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
      'id', p.id, 'order_number', p.order_number, 'status', p.status, 'payment_status', p.payment_status,
      'payment_method', p.payment_method, 'fraud_status', p.fraud_status, 'risk_level', p.risk_level,
      'source', p.source, 'customer_id', p.customer_id, 'customer_name', p.customer_name,
      'sales_channel', case when p.sales_channel_id is not null then (select jsonb_build_object('id', sc.id, 'platform', sc.platform, 'name', sc.name,
        'number', p.external_order_number) from public.sales_channels sc where sc.id = p.sales_channel_id) end,
      'customer_phone', p.customer_phone, 'shipping_district', p.shipping_district, 'shipping_address', p.shipping_address,
      'total_amount', p.total_amount, 'amount_paid', p.amount_paid, 'cod_amount', p.cod_amount,
      'advance_required', p.advance_required, 'created_at', p.created_at, 'updated_at', p.updated_at,
      'label_printed_at', p.label_printed_at, 'label_print_count', p.label_print_count,
      'duplicate_status', p.duplicate_status, 'merged_count', p.merged_count,
      'duplicate_of_number', (select d.order_number from public.orders d where d.id = p.duplicate_of),
      'duplicate_reason', p.duplicate_reason,
      'duplicate_of_status', (select d.status from public.orders d where d.id = p.duplicate_of),
      'merged_into_number', (select d.order_number from public.orders d where d.id = p.merged_into),
      'item_count', (select coalesce(sum(quantity), 0) from public.order_items oi where oi.order_id = p.id),
      'items_preview', (select string_agg(oi.product_name || coalesce(' · ' || oi.variant_title, '') || ' ×' || oi.quantity, ', ' order by oi.created_at)
                        from public.order_items oi where oi.order_id = p.id),
      'lines', (select jsonb_agg(jsonb_build_object('name', l.product_name, 'variant', l.variant_title, 'sku', l.sku,
                                                    'quantity', l.quantity, 'image_url', l.image_url) order by l.created_at)
                from (select * from public.order_items oi where oi.order_id = p.id order by oi.created_at limit 4) l),
      'courier_name', (select c.name from public.shipments s join public.couriers c on c.id = s.courier_id
                       where s.order_id = p.id and s.is_active limit 1),
      'tracking_number', (select s.tracking_number from public.shipments s where s.order_id = p.id and s.is_active limit 1),
      'shipment', (select jsonb_build_object('courier', c.name, 'provider', c.provider, 'tracking_number', s.tracking_number,
                            'consignment_id', s.consignment_id, 'status', s.status, 'booked_at', s.created_at,
                            'uploaded', coalesce(s.consignment_id, s.tracking_number) is not null and c.api_enabled,
                            'tracking_url', public._tracking_url(c.provider, c.tracking_url_template, coalesce(s.tracking_number, s.consignment_id)))
                   from public.shipments s join public.couriers c on c.id = s.courier_id
                   where s.order_id = p.id and s.is_active order by s.created_at desc limit 1),
      'stage', public.order_stage(p.status, p.confirmed_at),
      'confirmed_at', p.confirmed_at,
      'review_status', p.review_status, 'review_note', p.review_note, 'follow_up_at', p.follow_up_at,
      'contact_attempts', p.contact_attempts, 'last_contact_at', p.last_contact_at,
      'partial_return_amount', p.partial_return_amount,
      'customer_note', p.customer_note,
      'tags', p.tags,
      'customer_total_orders', (select c.total_orders from public.customers c where c.id = p.customer_id),
      'handled_by', (select coalesce(nullif(pr.full_name, ''), pr.email) from public.profiles pr
                     where pr.id = coalesce(p.approved_by, p.review_updated_by, p.created_by)),
      'attribution', (select jsonb_build_object('source', a.source, 'channel', a.channel, 'is_paid', a.is_paid, 'campaign', a.campaign)
                      from public.order_attributions a where a.order_id = p.id),
      'courier_history', (select jsonb_build_object('delivered', fc.delivered_orders,
                            'completed', fc.delivered_orders + fc.returned_orders + fc.failed_delivery_orders, 'score', fc.courier_score,
                            'total', fc.previous_orders,
                            'cancelled', fc.returned_orders + fc.failed_delivery_orders,
                            'rate', coalesce((fc.metrics ->> 'receive_rate')::numeric, fc.courier_score),
                            'tier', fc.metrics ->> 'receive_rate_tier',
                            'ranges', (select jsonb_agg(coalesce(c ->> 'name', initcap(c ->> 'courier')) || ' ' || (c ->> 'parcel_range'))
                                       from jsonb_array_elements(case when jsonb_typeof(fc.provider_response -> 'courier_history' -> 'couriers') = 'array'
                                                                      then fc.provider_response -> 'courier_history' -> 'couriers' else '[]'::jsonb end) c
                                       where (c ->> 'rate_only')::boolean and nullif(c ->> 'parcel_range', '') is not null),
                            'verdict', fc.provider_response -> 'courier_history' -> 'verdict' ->> 'label',
                            'checked_at', fc.created_at)
                          from public.fraud_checks fc where fc.id = p.fraud_check_id and fc.status <> 'ERROR')
    )) from page p), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$function$;
