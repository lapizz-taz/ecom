-- =============================================================================
-- Courier Management, like the reference screen:
--   * In Transit (booked, picked up, on the way — no delivery attempt yet) is
--     its own tab; Assigned for Delivery means a rider has tried / is trying.
--   * Courier age (days since booking) and delivery attempts can be filtered,
--     as can the staff member in charge.
--   * Calls to the customer and to the rider are logged with their outcome
--     (shown as today's morning / afternoon counts), never guessed.
--   * Return analysis: return rate by courier, district and product.
-- =============================================================================

create table if not exists public.parcel_calls (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id),
  party text not null check (party in ('CUSTOMER', 'RIDER')),
  outcome text not null check (outcome in ('ANSWERED', 'NO_ANSWER', 'BUSY', 'SWITCHED_OFF', 'WRONG_NUMBER')),
  note text check (note is null or length(note) <= 500),
  called_by uuid references public.profiles(id),
  called_at timestamptz not null default now()
);
create index if not exists parcel_calls_order_idx on public.parcel_calls(order_id, called_at desc);
alter table public.parcel_calls enable row level security;
revoke all on public.parcel_calls from anon, authenticated;
grant all on public.parcel_calls to service_role;

-- Tab of one parcel. p_attempts: delivery attempts reported by the courier.
create or replace function public._parcel_tab2(p_order public.orders, p_ship public.shipments, p_attempts int)
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
    when p_ship.status in ('OUT_FOR_DELIVERY', 'ON_HOLD')
      or (p_ship.status in ('PENDING', 'BOOKED', 'PICKED_UP', 'IN_TRANSIT') and coalesce(p_attempts, 0) > 0) then 'assigned'
    when p_ship.status in ('PENDING', 'BOOKED', 'PICKED_UP', 'IN_TRANSIT') then 'in_transit'
    when p_ship.status in ('DELIVERED', 'PARTIALLY_DELIVERED') then 'delivered'
    when p_ship.id is null and p_order.status in ('CONFIRMED', 'PROCESSING', 'QUALITY_CHECK', 'PACKING', 'READY_TO_SHIP') then 'pending_entry'
    else null
  end
$$;

-- p: { tab?, q?, courier_id?, in_charge? (uuid | 'none'), age_from?, age_to?, attempt_from?, attempt_to?, limit?, offset? }
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
  v_charge text := nullif(p ->> 'in_charge', '');
  v_age_from int := nullif(p ->> 'age_from', '')::int;
  v_age_to int := nullif(p ->> 'age_to', '')::int;
  v_att_from int := nullif(p ->> 'attempt_from', '')::int;
  v_att_to int := nullif(p ->> 'attempt_to', '')::int;
  v_limit int := least(greatest(coalesce((p ->> 'limit')::int, 25), 1), 100);
  v_offset int := greatest(coalesce((p ->> 'offset')::int, 0), 0);
  v_digits text;
  v_today timestamptz := public._ts_from(public._local_date(now()));
begin
  perform public.require_permission('couriers.view');
  if v_tab not in ('all', 'in_transit', 'pending_entry', 'assigned', 'cancelled', 'return_pending', 'returned', 'damage_lost', 'delivered') then
    raise exception 'VALIDATION: unknown parcel tab' using errcode = '22023';
  end if;
  if v_charge is not null and v_charge <> 'none' and v_charge !~ '^[0-9a-f-]{36}$' then
    raise exception 'VALIDATION: unknown staff member' using errcode = '22023';
  end if;
  v_digits := nullif(regexp_replace(coalesce(v_q, ''), '\D', '', 'g'), '');

  return (
    with base as (
      select o, s, a.attempts, public._parcel_tab2(o, s, a.attempts) as tab,
        case when s.id is null then null else greatest(0, (public._local_date(coalesce(s.delivered_at, now())) - public._local_date(s.created_at)))::int end as age_days
      from public.orders o
      left join lateral (
        select * from public.shipments s where s.order_id = o.id
        order by s.is_active desc, s.created_at desc limit 1
      ) s on true
      cross join lateral (
        select count(*)::int as attempts from public.shipment_events e where e.shipment_id = s.id and e.status = 'OUT_FOR_DELIVERY'
      ) a
      where o.merged_into is null
        and (v_courier is null or s.courier_id = v_courier)
        and (v_charge is null or (v_charge = 'none' and o.assigned_to is null) or o.assigned_to::text = v_charge)
        and (v_q is null or o.order_number ilike '%' || v_q || '%' or o.customer_name ilike '%' || v_q || '%'
             or (v_digits is not null and length(v_digits) >= 4 and o.customer_phone like '%' || v_digits || '%')
             or s.consignment_id ilike v_q || '%' or s.tracking_number ilike v_q || '%')
    ), filtered as (
      select * from base where tab is not null
        and (v_age_from is null or age_days >= v_age_from) and (v_age_to is null or age_days <= v_age_to)
        and (v_att_from is null or attempts >= v_att_from) and (v_att_to is null or attempts <= v_att_to)
    ), rows as (
      select * from filtered where v_tab = 'all' or tab = v_tab
    )
    select jsonb_build_object(
      'counts', (select jsonb_build_object(
        'all', count(*),
        'in_transit', count(*) filter (where tab = 'in_transit'),
        'pending_entry', count(*) filter (where tab = 'pending_entry'),
        'assigned', count(*) filter (where tab = 'assigned'),
        'cancelled', count(*) filter (where tab = 'cancelled'),
        'return_pending', count(*) filter (where tab = 'return_pending'),
        'returned', count(*) filter (where tab = 'returned'),
        'damage_lost', count(*) filter (where tab = 'damage_lost'),
        'delivered', count(*) filter (where tab = 'delivered')) from filtered),
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
            'attempts', r.attempts,
            'age_days', r.age_days,
            'rider', (select nullif(jsonb_strip_nulls(jsonb_build_object(
                  'name', coalesce(e.raw ->> 'rider_name', e.raw ->> 'delivery_man_name', e.raw ->> 'deliveryman_name', e.raw #>> '{rider,name}'),
                  'phone', coalesce(e.raw ->> 'rider_phone', e.raw ->> 'delivery_man_phone', e.raw ->> 'deliveryman_phone', e.raw #>> '{rider,phone}'))), '{}'::jsonb)
                from public.shipment_events e where e.shipment_id = (r.s).id
                  and coalesce(e.raw ->> 'rider_name', e.raw ->> 'delivery_man_name', e.raw ->> 'deliveryman_name', e.raw #>> '{rider,name}') is not null
                order by e.occurred_at desc limit 1),
            'rider_note', (select coalesce(nullif(e.raw ->> 'reason', ''), nullif(e.raw ->> 'note', ''), e.description)
                from public.shipment_events e where e.shipment_id = (r.s).id order by e.occurred_at desc limit 1),
            'last_update_at', (select max(e.occurred_at) from public.shipment_events e where e.shipment_id = (r.s).id),
            'customer_calls', (select jsonb_build_object(
                'am', count(*) filter (where c.called_at >= v_today and extract(hour from c.called_at at time zone 'Asia/Dhaka') < 12),
                'pm', count(*) filter (where c.called_at >= v_today and extract(hour from c.called_at at time zone 'Asia/Dhaka') >= 12),
                'total', count(*), 'last_outcome', (array_agg(c.outcome order by c.called_at desc))[1], 'last_at', max(c.called_at))
              from public.parcel_calls c where c.order_id = (r.o).id and c.party = 'CUSTOMER'),
            'rider_calls', (select jsonb_build_object(
                'am', count(*) filter (where c.called_at >= v_today and extract(hour from c.called_at at time zone 'Asia/Dhaka') < 12),
                'pm', count(*) filter (where c.called_at >= v_today and extract(hour from c.called_at at time zone 'Asia/Dhaka') >= 12),
                'total', count(*), 'last_outcome', (array_agg(c.outcome order by c.called_at desc))[1], 'last_at', max(c.called_at))
              from public.parcel_calls c where c.order_id = (r.o).id and c.party = 'RIDER'),
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

-- Log a call to the customer or the rider about a parcel.
create or replace function public.parcel_call_log(p_order_id uuid, p_party text, p_outcome text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.parcel_calls;
begin
  perform public.require_permission('couriers.view');
  if not exists (select 1 from public.orders where id = p_order_id) then
    raise exception 'NOT_FOUND: order not found' using errcode = 'P0002';
  end if;
  if p_party not in ('CUSTOMER', 'RIDER') or p_outcome not in ('ANSWERED', 'NO_ANSWER', 'BUSY', 'SWITCHED_OFF', 'WRONG_NUMBER') then
    raise exception 'VALIDATION: unknown call party or outcome' using errcode = '22023';
  end if;
  insert into public.parcel_calls(order_id, party, outcome, note, called_by)
  values (p_order_id, p_party, p_outcome, nullif(trim(coalesce(p_note, '')), ''), auth.uid())
  returning * into v_row;
  perform public._order_log(p_order_id, 'PARCEL_CALL',
    format('Called the %s: %s%s', lower(p_party), lower(replace(p_outcome, '_', ' ')), coalesce(' — ' || v_row.note, '')),
    null, null, jsonb_build_object('party', p_party, 'outcome', p_outcome));
  return to_jsonb(v_row);
end;
$$;

-- One parcel's story: courier updates and calls, newest first.
create or replace function public.parcel_history(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('couriers.view');
  return coalesce((
    select jsonb_agg(x order by (x ->> 'at')::timestamptz desc) from (
      select jsonb_build_object('kind', 'COURIER', 'at', e.occurred_at, 'status', e.status,
        'text', coalesce(nullif(e.raw ->> 'reason', ''), e.description), 'source', e.source) as x
      from public.shipment_events e join public.shipments s on s.id = e.shipment_id where s.order_id = p_order_id
      union all
      select jsonb_build_object('kind', 'CALL', 'at', c.called_at, 'status', c.outcome, 'party', c.party, 'text', c.note,
        'by', (select coalesce(nullif(pr.full_name, ''), pr.email) from public.profiles pr where pr.id = c.called_by))
      from public.parcel_calls c where c.order_id = p_order_id
      union all
      select jsonb_build_object('kind', 'ORDER', 'at', h.created_at, 'status', h.to_status, 'text', h.message, 'by', h.actor_name)
      from public.order_status_history h where h.order_id = p_order_id and h.to_status is not null
    ) q), '[]'::jsonb);
end;
$$;

-- Return analysis over parcels booked between p_from and p_to (local dates).
create or replace function public.return_analysis(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('couriers.view');
  if p_to < p_from or p_to - p_from > 366 then
    raise exception 'VALIDATION: choose a range of up to a year' using errcode = '22023';
  end if;
  return (
    with ships as (
      select s.*, o.shipping_district, o.total_amount,
        case when s.status in ('RETURNED', 'RETURNING', 'FAILED') or o.status in ('RETURNED', 'RETURNING', 'RETURN_REQUESTED', 'FAILED_DELIVERY') then 'RETURN'
             when s.status in ('DELIVERED', 'PARTIALLY_DELIVERED') then 'DELIVERED'
             when s.status = 'CANCELLED' then 'CANCELLED' else 'OPEN' end as outcome
      from public.shipments s join public.orders o on o.id = s.order_id
      where s.is_active and o.merged_into is null
        and s.created_at >= public._ts_from(p_from) and s.created_at < public._ts_from(p_to + 1)
    ), closed as (select * from ships where outcome in ('RETURN', 'DELIVERED'))
    select jsonb_build_object(
      'summary', (select jsonb_build_object('parcels', count(*), 'delivered', count(*) filter (where outcome = 'DELIVERED'),
          'returned', count(*) filter (where outcome = 'RETURN'), 'open', count(*) filter (where outcome = 'OPEN'),
          'return_value', coalesce(sum(total_amount) filter (where outcome = 'RETURN'), 0),
          'return_charges', coalesce(sum(return_charge) filter (where outcome = 'RETURN'), 0)) from ships),
      'by_courier', coalesce((select jsonb_agg(x order by (x ->> 'returned')::int desc) from (
          select jsonb_build_object('courier', c.name, 'closed', count(*), 'returned', count(*) filter (where cl.outcome = 'RETURN'),
            'rate', round(100.0 * count(*) filter (where cl.outcome = 'RETURN') / nullif(count(*), 0), 1)) as x
          from closed cl join public.couriers c on c.id = cl.courier_id group by c.name) q), '[]'::jsonb),
      'by_district', coalesce((select jsonb_agg(x order by (x ->> 'returned')::int desc) from (
          select jsonb_build_object('district', coalesce(shipping_district, 'Unknown'), 'closed', count(*),
            'returned', count(*) filter (where outcome = 'RETURN'),
            'rate', round(100.0 * count(*) filter (where outcome = 'RETURN') / nullif(count(*), 0), 1)) as x
          from closed group by coalesce(shipping_district, 'Unknown') having count(*) filter (where outcome = 'RETURN') > 0
          order by count(*) filter (where outcome = 'RETURN') desc limit 15) q), '[]'::jsonb),
      'by_product', coalesce((select jsonb_agg(x order by (x ->> 'returned')::int desc) from (
          select jsonb_build_object('product', i.product_name, 'sold', sum(i.quantity),
            'returned', sum(i.quantity) filter (where cl.outcome = 'RETURN'),
            'rate', round(100.0 * coalesce(sum(i.quantity) filter (where cl.outcome = 'RETURN'), 0) / nullif(sum(i.quantity), 0), 1)) as x
          from closed cl join public.order_items i on i.order_id = cl.order_id group by i.product_name
          having sum(i.quantity) filter (where cl.outcome = 'RETURN') > 0
          order by sum(i.quantity) filter (where cl.outcome = 'RETURN') desc limit 15) q), '[]'::jsonb),
      'reasons', coalesce((select jsonb_agg(x order by (x ->> 'count')::int desc) from (
          select jsonb_build_object('reason', reason, 'count', count(*)) as x from (
            select distinct on (cl.id) coalesce(nullif(e.raw ->> 'reason', ''), e.description, 'Not given') as reason
            from closed cl left join public.shipment_events e on e.shipment_id = cl.id and e.status in ('FAILED', 'RETURNING', 'RETURNED', 'ON_HOLD')
            where cl.outcome = 'RETURN' order by cl.id, e.occurred_at desc) r
          group by reason order by count(*) desc limit 10) q), '[]'::jsonb)
    ));
end;
$$;

revoke all on function public._parcel_tab2(public.orders, public.shipments, int), public.courier_parcels(jsonb),
  public.parcel_call_log(uuid, text, text, text), public.parcel_history(uuid), public.return_analysis(date, date)
from public, anon, authenticated;
grant execute on function public.courier_parcels(jsonb), public.parcel_call_log(uuid, text, text, text), public.parcel_history(uuid),
  public.return_analysis(date, date) to authenticated;
