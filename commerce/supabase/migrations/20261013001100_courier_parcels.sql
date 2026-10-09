-- =============================================================================
-- Courier Management: every parcel in one list, by where it is.
--   pending_entry   approved and ready, not booked with a courier yet
--   assigned        booked / picked up / on the way / out for delivery
--   cancelled       booking cancelled, or the order cancelled after booking
--   return_pending  delivery failed or the parcel is on its way back
--   returned        back with us
--   damage_lost     lost by the courier, or returned with damaged items
-- Rider name and phone come from the courier's own updates when it sends them;
-- otherwise they are left empty (never guessed).
-- =============================================================================

create or replace function public._parcel_tab(p_order public.orders, p_ship public.shipments)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    when p_order.status = 'LOST' or exists (select 1 from public.order_items i where i.order_id = p_order.id and i.damaged_quantity > 0) then 'damage_lost'
    when p_ship.status = 'RETURNED' or p_order.status = 'RETURNED' then 'returned'
    when p_ship.status in ('FAILED', 'RETURNING') or p_order.status in ('RETURN_REQUESTED', 'RETURNING', 'FAILED_DELIVERY') then 'return_pending'
    when p_ship.status = 'CANCELLED' or (p_ship.id is not null and p_order.status in ('CANCELLED', 'PENDING_CANCEL')) then 'cancelled'
    when p_ship.status in ('PENDING', 'BOOKED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'ON_HOLD') then 'assigned'
    when p_ship.status in ('DELIVERED', 'PARTIALLY_DELIVERED') then 'delivered'
    when p_ship.id is null and p_order.status in ('CONFIRMED', 'PROCESSING', 'QUALITY_CHECK', 'PACKING', 'READY_TO_SHIP') then 'pending_entry'
    else null
  end
$$;

-- p: { tab?, q?, courier_id?, limit?, offset? }
create or replace function public.courier_parcels(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tab text := coalesce(nullif(p ->> 'tab', ''), 'all');
  v_q text := nullif(trim(coalesce(p ->> 'q', '')), '');
  v_courier uuid := nullif(p ->> 'courier_id', '')::uuid;
  v_limit int := least(greatest(coalesce((p ->> 'limit')::int, 25), 1), 100);
  v_offset int := greatest(coalesce((p ->> 'offset')::int, 0), 0);
  v_digits text;
begin
  perform public.require_permission('couriers.view');
  if v_tab not in ('all', 'pending_entry', 'assigned', 'cancelled', 'return_pending', 'returned', 'damage_lost', 'delivered') then
    raise exception 'VALIDATION: unknown parcel tab' using errcode = '22023';
  end if;
  v_digits := nullif(regexp_replace(coalesce(v_q, ''), '\D', '', 'g'), '');

  return (
    with base as (
      select o, s, public._parcel_tab(o, s) as tab
      from public.orders o
      left join lateral (
        select * from public.shipments s where s.order_id = o.id
        order by s.is_active desc, s.created_at desc limit 1
      ) s on true
      where o.merged_into is null
        and (v_courier is null or s.courier_id = v_courier)
        and (v_q is null or o.order_number ilike '%' || v_q || '%' or o.customer_name ilike '%' || v_q || '%'
             or (v_digits is not null and length(v_digits) >= 4 and o.customer_phone like '%' || v_digits || '%')
             or s.consignment_id ilike v_q || '%' or s.tracking_number ilike v_q || '%')
    ), tabbed as (
      select * from base where tab is not null
    ), rows as (
      select * from tabbed where v_tab = 'all' or tab = v_tab
    )
    select jsonb_build_object(
      'counts', jsonb_build_object(
        'all', (select count(*) from tabbed),
        'pending_entry', (select count(*) from tabbed where tab = 'pending_entry'),
        'assigned', (select count(*) from tabbed where tab = 'assigned'),
        'cancelled', (select count(*) from tabbed where tab = 'cancelled'),
        'return_pending', (select count(*) from tabbed where tab = 'return_pending'),
        'returned', (select count(*) from tabbed where tab = 'returned'),
        'damage_lost', (select count(*) from tabbed where tab = 'damage_lost'),
        'delivered', (select count(*) from tabbed where tab = 'delivered')),
      'total', (select count(*) from rows),
      'items', coalesce((
        select jsonb_agg(item order by created_at desc) from (
          select (r.o).created_at as created_at, jsonb_build_object(
            'id', (r.o).id, 'order_number', (r.o).order_number, 'created_at', (r.o).created_at, 'status', (r.o).status, 'tab', r.tab,
            'customer', jsonb_build_object('name', (r.o).customer_name, 'phone', (r.o).customer_phone,
              'address', (r.o).shipping_address, 'area', (r.o).shipping_area, 'district', (r.o).shipping_district),
            'customer_note', (r.o).customer_note,
            'total', (r.o).total_amount, 'cod_amount', (r.o).cod_amount, 'amount_paid', (r.o).amount_paid,
            'products', coalesce((select jsonb_agg(jsonb_build_object('name', i.product_name, 'variant', i.variant_title, 'qty', i.quantity,
                'image', i.image_url, 'damaged', i.damaged_quantity, 'returned', i.returned_quantity) order by i.created_at)
              from public.order_items i where i.order_id = (r.o).id), '[]'::jsonb),
            'item_count', (select coalesce(sum(i.quantity), 0) from public.order_items i where i.order_id = (r.o).id),
            'courier', case when (r.s).id is null then null else (
              select jsonb_build_object('id', c.id, 'name', c.name, 'provider', c.provider, 'tracking_url_template', c.tracking_url_template)
              from public.couriers c where c.id = (r.s).courier_id) end,
            'shipment', case when (r.s).id is null then null else jsonb_build_object(
              'id', (r.s).id, 'status', (r.s).status, 'consignment_id', (r.s).consignment_id, 'tracking_number', (r.s).tracking_number,
              'booked_at', (r.s).created_at, 'shipping_cost', (r.s).shipping_cost, 'cod_collected', (r.s).cod_collected,
              'delivered_at', (r.s).delivered_at) end,
            'attempts', (select count(*) from public.shipment_events e where e.shipment_id = (r.s).id and e.status = 'OUT_FOR_DELIVERY'),
            'rider', (select nullif(jsonb_strip_nulls(jsonb_build_object(
                  'name', coalesce(e.raw ->> 'rider_name', e.raw ->> 'delivery_man_name', e.raw ->> 'deliveryman_name', e.raw #>> '{rider,name}'),
                  'phone', coalesce(e.raw ->> 'rider_phone', e.raw ->> 'delivery_man_phone', e.raw ->> 'deliveryman_phone', e.raw #>> '{rider,phone}'))), '{}'::jsonb)
                from public.shipment_events e where e.shipment_id = (r.s).id
                  and coalesce(e.raw ->> 'rider_name', e.raw ->> 'delivery_man_name', e.raw ->> 'deliveryman_name', e.raw #>> '{rider,name}') is not null
                order by e.occurred_at desc limit 1),
            'rider_note', (select coalesce(nullif(e.raw ->> 'reason', ''), nullif(e.raw ->> 'note', ''), e.description)
                from public.shipment_events e where e.shipment_id = (r.s).id order by e.occurred_at desc limit 1),
            'last_update_at', (select max(e.occurred_at) from public.shipment_events e where e.shipment_id = (r.s).id),
            'tags', to_jsonb(coalesce((r.o).tags, '{}')),
            'in_charge', (select jsonb_build_object('id', pr.id, 'name', coalesce(pr.full_name, pr.email)) from public.profiles pr where pr.id = (r.o).assigned_to)
          ) as item
          from rows r
          order by (r.o).created_at desc
          limit v_limit offset v_offset
        ) x), '[]'::jsonb)
    )
  );
end;
$$;

revoke all on function public._parcel_tab(public.orders, public.shipments), public.courier_parcels(jsonb) from public, anon, authenticated;
grant execute on function public.courier_parcels(jsonb) to authenticated;
