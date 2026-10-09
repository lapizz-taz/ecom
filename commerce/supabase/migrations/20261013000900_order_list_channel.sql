-- =============================================================================
-- Order lists show which store an order came from (Shopify / WooCommerce, with
-- the store's own order number) and can be filtered by it:
--   sales_channel = 'own' | 'SHOPIFY' | 'WOOCOMMERCE' | <channel id>
-- =============================================================================

create or replace function public.admin_search_orders(
  p_filters jsonb default '{}'::jsonb,
  p_sort text default 'created_at',
  p_direction text default 'desc',
  p_limit int default 25,
  p_offset int default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
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
$$;
