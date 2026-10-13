-- =============================================================================
-- A fresh courier check becomes the record of the customer's open orders
--   Every courier check (the one run when an order is imported or placed, a
--   staff recheck from an order or the list, the WooCommerce checkout shield)
--   now also points the same customer's open orders at it, so Web Orders and
--   Approved Orders show the success rate without anyone pressing "check
--   again" — a recheck by phone used to leave the order on its old record.
--   An order never goes back to an older check, and keeps a complete record
--   rather than take a partial one (a source that could not be reached).
--   Delivered, cancelled, returned and lost orders keep the record they had.
--
--   The order page's delivery record prefers a complete check from the last
--   day over a newer partial one, for the same reason, and now also says how
--   sure it is: the check's status, the sources it could not reach, returned
--   and failed counts, a newer failed attempt, and the store's thresholds
--   (Settings → Fraud → delivery success) the risk label is judged against.
-- =============================================================================

create or replace function public._courier_check_to_open_orders()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_complete boolean := new.status = 'SUCCESS' and new.provider_response -> 'courier_history' -> 'source_notes' is null;
begin
  if new.provider = 'internal' or new.status = 'ERROR' then
    return null;
  end if;
  update public.orders o set fraud_check_id = new.id
  where o.merchant_id = new.merchant_id
    and o.customer_phone = new.phone
    and o.created_at > now() - interval '60 days'
    and o.status::text not in ('DELIVERED', 'PARTIALLY_DELIVERED', 'CANCELLED', 'REJECTED_FRAUD', 'RETURNED', 'LOST')
    and o.fraud_check_id is distinct from new.id
    and not exists (
      select 1 from public.fraud_checks prev
      where prev.id = o.fraud_check_id
        and (prev.created_at > new.created_at
             or (not v_complete and prev.provider <> 'internal' and prev.status = 'SUCCESS'
                 and prev.provider_response -> 'courier_history' -> 'source_notes' is null)));
  return null;
end;
$$;

drop trigger if exists fraud_checks_to_open_orders on public.fraud_checks;
create trigger fraud_checks_to_open_orders after insert on public.fraud_checks
  for each row execute function public._courier_check_to_open_orders();

revoke execute on function public._courier_check_to_open_orders() from public, anon, authenticated;

create or replace function public.admin_order_customer_record(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_check public.fraud_checks;
begin
  perform public.require_permission('orders.view');
  select * into v_order from public.orders where id = p_order_id;
  if not found then
    raise exception 'NOT_FOUND: order not found' using errcode = 'P0002';
  end if;
  -- The newest courier check for this phone; a complete one from the last day wins
  -- over a newer one that could not reach every source.
  select * into v_check from public.fraud_checks
  where phone = v_order.customer_phone and status <> 'ERROR' and provider <> 'internal'
  order by (status = 'SUCCESS' and provider_response -> 'courier_history' -> 'source_notes' is null
            and created_at > now() - interval '1 day') desc,
           created_at desc
  limit 1;
  if v_check.id is null then
    select * into v_check from public.fraud_checks where id = v_order.fraud_check_id;
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
            from public.orders x where x.customer_phone = v_order.customer_phone group by 1) s))
      from public.orders o where o.customer_phone = v_order.customer_phone),
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
                     where f.phone = v_order.customer_phone and f.status = 'ERROR' and f.provider <> 'internal'
                       and f.created_at > coalesce(v_check.created_at, '-infinity'::timestamptz)
                     order by f.created_at desc limit 1),
    'policy', (select jsonb_build_object(
                 'good_min', coalesce((r ->> 'good_min')::numeric, 80),
                 'mid_min', coalesce((r ->> 'mid_min')::numeric, 50),
                 'min_parcels', coalesce((r ->> 'min_parcels')::int, 1))
               from (select coalesce(public.get_setting('fraud') -> 'receive_rate', '{}'::jsonb) as r) x),
    'shipment', (select jsonb_build_object('courier', c.name, 'provider', c.provider, 'tracking_number', s.tracking_number,
                          'consignment_id', s.consignment_id, 'cod_amount', s.cod_amount, 'uploaded', c.api_enabled and coalesce(s.consignment_id, s.tracking_number) is not null,
                          'tracking_url', public._tracking_url(c.provider, c.tracking_url_template, coalesce(s.tracking_number, s.consignment_id)))
                 from public.shipments s join public.couriers c on c.id = s.courier_id
                 where s.order_id = p_order_id and s.is_active order by s.created_at desc limit 1)
  );
end;
$$;

select public._tenancy_own_functions();
