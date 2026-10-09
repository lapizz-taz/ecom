-- =============================================================================
-- Order lists: the delivery success rate staff see next to each order is the
-- same one the checkout check used (the courier service's own overall rate
-- when it gives one, else delivered ÷ completed parcels), with the parcel
-- counts behind it and the service's verdict.
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
begin
  perform public.require_permission('orders.view');
  if p_filters ? 'statuses' then
    select array_agg(s::public.order_status) into v_statuses from jsonb_array_elements_text(p_filters -> 'statuses') s;
  elsif nullif(p_filters ->> 'status', '') is not null then
    v_statuses := array[(p_filters ->> 'status')::public.order_status];
  end if;

  with filtered as (
    select o.*
    from public.orders o
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
      f.created_at desc
    limit least(greatest(p_limit, 1), 200) offset greatest(p_offset, 0)
  )
  select jsonb_build_object(
    'total', (select total from counted),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
      'id', p.id, 'order_number', p.order_number, 'status', p.status, 'payment_status', p.payment_status,
      'payment_method', p.payment_method, 'fraud_status', p.fraud_status, 'risk_level', p.risk_level,
      'source', p.source, 'customer_id', p.customer_id, 'customer_name', p.customer_name,
      'customer_phone', p.customer_phone, 'shipping_district', p.shipping_district,
      'total_amount', p.total_amount, 'amount_paid', p.amount_paid, 'cod_amount', p.cod_amount,
      'advance_required', p.advance_required, 'created_at', p.created_at,
      'label_printed_at', p.label_printed_at, 'label_print_count', p.label_print_count,
      'duplicate_status', p.duplicate_status, 'merged_count', p.merged_count,
      'duplicate_of_number', (select d.order_number from public.orders d where d.id = p.duplicate_of),
      'merged_into_number', (select d.order_number from public.orders d where d.id = p.merged_into),
      'item_count', (select coalesce(sum(quantity), 0) from public.order_items oi where oi.order_id = p.id),
      'items_preview', (select string_agg(oi.product_name || coalesce(' · ' || oi.variant_title, '') || ' ×' || oi.quantity, ', ' order by oi.created_at)
                        from public.order_items oi where oi.order_id = p.id),
      'courier_name', (select c.name from public.shipments s join public.couriers c on c.id = s.courier_id
                       where s.order_id = p.id and s.is_active limit 1),
      'tracking_number', (select s.tracking_number from public.shipments s where s.order_id = p.id and s.is_active limit 1),
      'stage', public.order_stage(p.status, p.confirmed_at),
      'confirmed_at', p.confirmed_at,
      'review_status', p.review_status, 'review_note', p.review_note, 'follow_up_at', p.follow_up_at,
      'contact_attempts', p.contact_attempts, 'last_contact_at', p.last_contact_at,
      'partial_return_amount', p.partial_return_amount,
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
