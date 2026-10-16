-- =============================================================================
-- Delivery record by phone number
--
--   * New Order shows the customer's delivery record as soon as the phone is
--     typed (before any order exists): admin_phone_customer_record().
--   * Incomplete checkouts show the success rate of each visitor's phone:
--     admin_phone_courier_summaries() for a page of phones at once.
--   * The order page keeps using admin_order_customer_record(), now built on
--     the same phone record so all three agree.
-- =============================================================================

-- The record for one (clean) phone: our own orders, the newest courier check,
-- a later failed check and the store's success-rate thresholds.
create or replace function public._phone_customer_record(p_phone text, p_fallback_check uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_check public.fraud_checks;
begin
  -- The newest courier check for this phone; a complete one from the last day wins
  -- over a newer one that could not reach every source.
  select * into v_check from public.fraud_checks
  where phone = p_phone and status <> 'ERROR' and provider <> 'internal'
  order by (status = 'SUCCESS' and provider_response -> 'courier_history' -> 'source_notes' is null
            and created_at > now() - interval '1 day') desc,
           created_at desc
  limit 1;
  if v_check.id is null and p_fallback_check is not null then
    select * into v_check from public.fraud_checks where id = p_fallback_check;
  end if;
  return jsonb_build_object(
    'ours', (select jsonb_build_object(
        'total', count(*),
        'delivered', count(*) filter (where o.status in ('DELIVERED', 'PARTIALLY_DELIVERED')),
        'cancelled', count(*) filter (where o.status in ('CANCELLED', 'REJECTED_FRAUD')),
        'returned', count(*) filter (where o.status in ('RETURN_REQUESTED', 'RETURNING', 'RETURNED')),
        'in_progress', count(*) filter (where o.status not in ('DELIVERED', 'PARTIALLY_DELIVERED', 'CANCELLED', 'REJECTED_FRAUD',
                                                                'RETURN_REQUESTED', 'RETURNING', 'RETURNED', 'LOST')),
        'by_stage', (select jsonb_object_agg(stage, n) from (
            select public.order_stage(x.status, x.confirmed_at) as stage, count(*) as n
            from public.orders x where x.customer_phone = p_phone group by 1) s))
      from public.orders o where o.customer_phone = p_phone),
    'check', case when v_check.id is null then null else jsonb_build_object(
        'id', v_check.id, 'checked_at', v_check.created_at, 'provider', v_check.provider, 'status', v_check.status,
        'rate', coalesce((v_check.metrics ->> 'receive_rate')::numeric, v_check.courier_score),
        'tier', v_check.metrics ->> 'receive_rate_tier',
        'parcels', (v_check.metrics ->> 'parcel_count')::int,
        'total', v_check.previous_orders, 'delivered', v_check.delivered_orders,
        'cancelled', v_check.returned_orders + v_check.failed_delivery_orders,
        'returned', v_check.returned_orders, 'failed', v_check.failed_delivery_orders,
        'service', v_check.provider_response -> 'courier_history' ->> 'service',
        'notes', v_check.provider_response -> 'courier_history' -> 'source_notes',
        'couriers', v_check.provider_response -> 'courier_history' -> 'couriers',
        'verdict', v_check.provider_response -> 'courier_history' -> 'verdict') end,
    -- A courier check for this phone that failed after the one shown (or with none shown).
    'last_failure', (select jsonb_build_object('at', f.created_at, 'error', left(coalesce(f.error, ''), 300))
                     from public.fraud_checks f
                     where f.phone = p_phone and f.status = 'ERROR' and f.provider <> 'internal'
                       and f.created_at > coalesce(v_check.created_at, '-infinity'::timestamptz)
                     order by f.created_at desc limit 1),
    'policy', (select jsonb_build_object(
                 'good_min', coalesce((r ->> 'good_min')::numeric, 80),
                 'mid_min', coalesce((r ->> 'mid_min')::numeric, 50),
                 'min_parcels', coalesce((r ->> 'min_parcels')::int, 1))
               from (select coalesce(public.get_setting('fraud') -> 'receive_rate', '{}'::jsonb) as r) x)
  );
end;
$$;
revoke all on function public._phone_customer_record(text, uuid) from public, anon, authenticated;

create or replace function public.admin_order_customer_record(p_order_id uuid)
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
  if not found then
    raise exception 'NOT_FOUND: order not found' using errcode = 'P0002';
  end if;
  return public._phone_customer_record(v_order.customer_phone, v_order.fraud_check_id) || jsonb_build_object(
    'shipment', (select jsonb_build_object('courier', c.name, 'provider', c.provider, 'tracking_number', s.tracking_number,
                          'consignment_id', s.consignment_id, 'cod_amount', s.cod_amount, 'uploaded', c.api_enabled and coalesce(s.consignment_id, s.tracking_number) is not null,
                          'tracking_url', public._tracking_url(c.provider, c.tracking_url_template, coalesce(s.tracking_number, s.consignment_id)))
                 from public.shipments s join public.couriers c on c.id = s.courier_id
                 where s.order_id = p_order_id and s.is_active order by s.created_at desc limit 1));
end;
$$;

-- The record for a phone typed on New Order (no order yet).
create or replace function public.admin_phone_customer_record(p_phone text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_phone text := public.clean_phone(p_phone);
begin
  if not (public.has_permission('orders.view') or public.has_permission('orders.create')) then
    raise exception 'PERMISSION_DENIED: orders.view is required' using errcode = '42501';
  end if;
  if v_phone is null or length(v_phone) < 11 then
    raise exception 'VALIDATION: a full mobile number is required' using errcode = '22023';
  end if;
  return public._phone_customer_record(v_phone) || jsonb_build_object('phone', v_phone);
end;
$$;

-- Success rate per phone for a page of incomplete checkouts (same shape as the order list's).
create or replace function public.admin_phone_courier_summaries(p_phones text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('orders.view');
  if coalesce(array_length(p_phones, 1), 0) > 200 then
    raise exception 'VALIDATION: at most 200 phones at once' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_object_agg(p.phone, (
      select jsonb_build_object('delivered', fc.delivered_orders,
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
      from public.fraud_checks fc
      where fc.phone = p.phone and fc.status <> 'ERROR' and fc.provider <> 'internal'
      order by (fc.status = 'SUCCESS' and fc.provider_response -> 'courier_history' -> 'source_notes' is null
                and fc.created_at > now() - interval '1 day') desc, fc.created_at desc
      limit 1))
    from (select distinct public.clean_phone(x) as phone from unnest(p_phones) x) p
    where p.phone is not null
  ), '{}'::jsonb);
end;
$$;

revoke all on function public.admin_phone_customer_record(text), public.admin_phone_courier_summaries(text[]) from public, anon;
grant execute on function public.admin_phone_customer_record(text), public.admin_phone_courier_summaries(text[]) to authenticated;

select public._tenancy_own_functions();

alter function public._phone_customer_record(text, uuid) owner to app_owner;
alter function public.admin_order_customer_record(uuid) owner to app_owner;
alter function public.admin_phone_customer_record(text) owner to app_owner;
alter function public.admin_phone_courier_summaries(text[]) owner to app_owner;
