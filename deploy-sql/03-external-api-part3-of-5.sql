-- external-api part 3 of 5: run the parts in order
create or replace function public._api_order_json(o public.orders, p_full boolean)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', o.id, 'order_number', o.order_number, 'status', o.status, 'payment_status', o.payment_status, 'payment_method', o.payment_method,
    'source', o.source, 'customer', jsonb_build_object('name', o.customer_name, 'phone', o.customer_phone, 'email', o.customer_email),
    'shipping', jsonb_build_object('address', o.shipping_address, 'area', o.shipping_area, 'city', o.shipping_city, 'district', o.shipping_district, 'postal_code', o.shipping_postal_code),
    'subtotal', o.subtotal, 'discount_total', o.discount_total, 'delivery_charge', o.delivery_charge, 'total', o.total_amount,
    'amount_paid', o.amount_paid, 'cod_amount', o.cod_amount, 'currency', 'BDT', 'tags', to_jsonb(coalesce(o.tags, '{}')),
    'note', o.customer_note, 'external_order_number', o.external_order_number,
    'created_at', o.created_at, 'updated_at', o.updated_at, 'confirmed_at', o.confirmed_at, 'shipped_at', o.shipped_at, 'delivered_at', o.delivered_at,
    'items', case when p_full then coalesce((select jsonb_agg(jsonb_build_object('sku', i.sku, 'name', i.product_name, 'variant', i.variant_title,
        'quantity', i.quantity, 'unit_price', i.unit_price, 'total', i.line_total) order by i.created_at) from public.order_items i where i.order_id = o.id), '[]'::jsonb)
      else null end,
    'shipment', case when p_full then (select jsonb_build_object('courier', c.name, 'tracking_number', s.tracking_number, 'consignment_id', s.consignment_id, 'status', s.status)
        from public.shipments s left join public.couriers c on c.id = s.courier_id where s.order_id = o.id and s.is_active order by s.created_at desc limit 1)
      else null end)
$$;
create or replace function public.api_orders(p_key uuid, p jsonb default '{}')
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit int := least(greatest(coalesce((p ->> 'limit')::int, 50), 1), 100);
  v_offset int := greatest(coalesce((p ->> 'offset')::int, 0), 0);
  v_status text := nullif(upper(trim(coalesce(p ->> 'status', ''))), '');
  v_since timestamptz := nullif(p ->> 'updated_since', '')::timestamptz;
  v_rows jsonb;
  v_total bigint;
begin
  perform public._api_require(p_key, 'orders:read');
  if v_status is not null and not v_status = any(enum_range(null::public.order_status)::text[]) then
    raise exception 'VALIDATION: unknown status %', v_status using errcode = '22023';
  end if;
  select count(*) into v_total from public.orders o
  where o.merged_into is null and (v_status is null or o.status::text = v_status) and (v_since is null or o.updated_at >= v_since);
  select coalesce(jsonb_agg(public._api_order_json(o, false) order by o.updated_at desc, o.id), '[]'::jsonb) into v_rows from (
    select * from public.orders o
    where o.merged_into is null and (v_status is null or o.status::text = v_status) and (v_since is null or o.updated_at >= v_since)
    order by o.updated_at desc, o.id limit v_limit offset v_offset) o;
  return jsonb_build_object('data', v_rows, 'total', v_total, 'limit', v_limit, 'offset', v_offset);
end;
$$;
create or replace function public.api_order(p_key uuid, p_ref text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v public.orders;
begin
  perform public._api_require(p_key, 'orders:read');
  select * into v from public.orders where order_number = p_ref or id::text = p_ref limit 1;
  if not found then
    raise exception 'NOT_FOUND: order % not found', p_ref using errcode = 'P0002';
  end if;
  return public._api_order_json(v, true);
end;
$$;
create or replace function public.api_order_set_status(p_key uuid, p_ref text, p_status text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.orders;
  v_name text;
begin
  perform public._api_require(p_key, 'orders:write');
  select * into v from public.orders where order_number = p_ref or id::text = p_ref limit 1;
  if not found then
    raise exception 'NOT_FOUND: order % not found', p_ref using errcode = 'P0002';
  end if;
  if not upper(coalesce(p_status, '')) = any(enum_range(null::public.order_status)::text[]) then
    raise exception 'VALIDATION: unknown status %', p_status using errcode = '22023';
  end if;
  -- Fraud decisions stay with people in the admin.
  if upper(p_status) in ('REJECTED_FRAUD', 'FRAUD_REVIEW') or v.status in ('FRAUD_REVIEW', 'REJECTED_FRAUD', 'ADVANCE_REQUIRED') then
    raise exception 'PERMISSION_DENIED: fraud and advance-payment decisions are made in the admin' using errcode = '42501';
  end if;
  select name into v_name from public.api_keys where id = p_key;
  v := public.transition_order_status(v.id, upper(p_status)::public.order_status, coalesce(nullif(trim(p_note), ''), format('Updated through the API (%s)', v_name)));
  perform public._order_log(v.id, 'API', format('Status set to %s through the API key "%s"', v.status, v_name), null, null, jsonb_build_object('api_key_id', p_key));
  return public._api_order_json(v, true);
end;
$$;
