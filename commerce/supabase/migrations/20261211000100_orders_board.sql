-- =============================================================================
-- Orders Dashboard: every order with its status now, and a filter panel.
--
-- Asked for on 31 Oct 2026: the Orders Dashboard gets the search options of the
-- order lists (date, approval time, product, source, courier, who took the
-- order, courier payment, invoice, status, order tags, district) and lists every
-- order with the status it has now: approved stages (Pending, RTS, Shipped,
-- Delivered, Returned, ...) and web orders by their call status (Processing,
-- No response, ...).
--
--   orders_board(filters, limit, offset)
--     One page of the orders that match, how many match and their value, and how
--     many orders are in each status for the same filters (the status filter
--     itself left out, so the counts show what each status would give).
--   orders_board_options()
--     What the filter panel offers: couriers, staff, sources, districts with
--     orders, order tags and call statuses.
--
-- Both need orders.view, read through row security (one business's orders) and
-- never return costs.
--
-- Filters (all optional):
--   date_by          approved (default) | order | shipped | delivered: the date
--                    the date range and the time range look at. An order without
--                    that date (a web order has no approval date) is left out
--                    only when a range is set.
--   date_from/to     YYYY-MM-DD in the store's time zone
--   time_from/to     minutes after midnight (0 to 1439) on that date; a range
--                    past midnight (22:00 to 02:00) wraps
--   product          product name, variant or SKU contains
--   source           where the order came from (Facebook, Google, Unknown, ...)
--   courier_id       a courier's id, or "none" for orders not booked with one
--   taken_by         staff who created, were given, called or approved it
--   courier_payment  paid: the courier paid the cash out (statement marked paid)
--                    unpaid: delivered, the courier still holds the cash
--                    none: nothing due from a courier
--   invoice          order number, web reference, store number, tracking or
--                    consignment number, or courier statement number (contains)
--   statuses         stage keys (PENDING, RTS, SHIPPED, DELIVERED, PARTIAL,
--                    RETURN_PENDING, RETURNED, CANCELLED, LOST, PRE_ORDER),
--                    WEB:<call status> (WEB:NO_RESPONSE, ...), or WEB for every
--                    web order
--   tags             order tags (any of them)
--   district         delivery district
--   sort             newest (default) | oldest | amount
--
-- Safe to re-run.
-- =============================================================================

create or replace function public.orders_board(p_filters jsonb default '{}'::jsonb, p_limit integer default 50, p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz text := public.store_timezone();
  v_by text := coalesce(nullif(p_filters ->> 'date_by', ''), 'approved');
  v_from date := nullif(p_filters ->> 'date_from', '')::date;
  v_to date := nullif(p_filters ->> 'date_to', '')::date;
  v_start timestamptz;
  v_end timestamptz;
  v_tfrom integer := nullif(p_filters ->> 'time_from', '')::integer;
  v_tto integer := nullif(p_filters ->> 'time_to', '')::integer;
  v_product text := nullif(trim(coalesce(p_filters ->> 'product', '')), '');
  v_source text := nullif(trim(coalesce(p_filters ->> 'source', '')), '');
  v_courier text := nullif(p_filters ->> 'courier_id', '');
  v_taken uuid := nullif(p_filters ->> 'taken_by', '')::uuid;
  v_pay text := nullif(p_filters ->> 'courier_payment', '');
  v_invoice text := nullif(trim(coalesce(p_filters ->> 'invoice', '')), '');
  v_district text := nullif(trim(coalesce(p_filters ->> 'district', '')), '');
  v_sort text := coalesce(nullif(p_filters ->> 'sort', ''), 'newest');
  v_keys text[];
  v_tags text[];
  v_result jsonb;
begin
  perform public.require_permission('orders.view');
  if v_by not in ('approved', 'order', 'shipped', 'delivered') then
    raise exception 'VALIDATION: unknown date to filter by' using errcode = '22023';
  end if;
  if v_pay is not null and v_pay not in ('paid', 'unpaid', 'none') then
    raise exception 'VALIDATION: unknown courier payment status' using errcode = '22023';
  end if;
  if v_sort not in ('newest', 'oldest', 'amount') then
    raise exception 'VALIDATION: unknown sort' using errcode = '22023';
  end if;
  if (v_tfrom is not null and (v_tfrom < 0 or v_tfrom > 1439)) or (v_tto is not null and (v_tto < 0 or v_tto > 1439)) then
    raise exception 'VALIDATION: a time is minutes after midnight, 0 to 1439' using errcode = '22023';
  end if;
  if v_courier is not null and v_courier <> 'none' then
    perform v_courier::uuid;
  end if;
  if v_from is not null then v_start := public._ts_from(v_from); end if;
  if v_to is not null then v_end := public._ts_from(v_to + 1); end if;
  if jsonb_typeof(p_filters -> 'statuses') = 'array' and jsonb_array_length(p_filters -> 'statuses') > 0 then
    select array_agg(s) into v_keys from jsonb_array_elements_text(p_filters -> 'statuses') s;
  end if;
  if jsonb_typeof(p_filters -> 'tags') = 'array' and jsonb_array_length(p_filters -> 'tags') > 0 then
    select array_agg(t) into v_tags from jsonb_array_elements_text(p_filters -> 'tags') t;
  end if;

  with src as (
    select o.id, o.total_amount, o.created_at,
      case v_by when 'order' then o.created_at when 'shipped' then o.shipped_at
                when 'delivered' then o.delivered_at else o.confirmed_at end as ts,
      case when o.confirmed_at is not null then public.order_stage(o.status, o.confirmed_at)
           when o.status in ('CANCELLED', 'REJECTED_FRAUD') and not coalesce(rs.closes_order, false) then 'WEB:CANCELLED'
           else 'WEB:' || coalesce(o.review_status, 'PROCESSING') end as status_key
    from public.orders o
    left join public.order_review_statuses rs on rs.code = o.review_status
    where (v_product is null or exists (
            select 1 from public.order_items oi where oi.order_id = o.id
              and (oi.product_name ilike '%' || v_product || '%' or oi.sku ilike '%' || v_product || '%'
                   or oi.variant_title ilike '%' || v_product || '%')))
      and (v_source is null or lower(coalesce((select a.source from public.order_attributions a where a.order_id = o.id), 'Unknown')) = lower(v_source))
      and (v_courier is null
           or (v_courier = 'none' and not exists (select 1 from public.shipments s where s.order_id = o.id and s.is_active))
           or exists (select 1 from public.shipments s where s.order_id = o.id and s.is_active and s.courier_id::text = v_courier))
      and (v_taken is null or v_taken in (o.created_by, o.assigned_to, o.review_updated_by, o.approved_by))
      and (v_pay is null or v_pay = (case
             when exists (select 1 from public.courier_invoice_lines l where l.order_id = o.id and l.settled_at is not null) then 'paid'
             when o.status in ('DELIVERED', 'PARTIALLY_DELIVERED') and o.cod_amount > 0 then 'unpaid'
             else 'none' end))
      and (v_invoice is null
           or o.order_number ilike '%' || v_invoice || '%'
           or o.web_number ilike '%' || v_invoice || '%'
           or o.external_order_number ilike '%' || v_invoice || '%'
           or exists (select 1 from public.shipments s where s.order_id = o.id
                        and (s.tracking_number ilike '%' || v_invoice || '%' or s.consignment_id ilike '%' || v_invoice || '%'))
           or exists (select 1 from public.courier_invoice_lines l join public.courier_invoices i on i.id = l.invoice_id
                      where l.order_id = o.id
                        and (i.invoice_number ilike '%' || v_invoice || '%' or l.consignment_id ilike '%' || v_invoice || '%'
                             or l.order_ref ilike '%' || v_invoice || '%')))
      and (v_tags is null or o.tags && v_tags)
      and (v_district is null or lower(trim(o.shipping_district)) = lower(v_district))
  ), base as (
    select * from src
    where (v_start is null or src.ts >= v_start)
      and (v_end is null or src.ts < v_end)
      and ((v_tfrom is null and v_tto is null) or (src.ts is not null and (
        case when coalesce(v_tfrom, 0) <= coalesce(v_tto, 1439)
             then extract(hour from src.ts at time zone v_tz) * 60 + extract(minute from src.ts at time zone v_tz)
                    between coalesce(v_tfrom, 0) and coalesce(v_tto, 1439)
             else extract(hour from src.ts at time zone v_tz) * 60 + extract(minute from src.ts at time zone v_tz) >= v_tfrom
               or extract(hour from src.ts at time zone v_tz) * 60 + extract(minute from src.ts at time zone v_tz) <= v_tto
        end)))
  ), picked as (
    select * from base
    where v_keys is null or base.status_key = any(v_keys) or ('WEB' = any(v_keys) and base.status_key like 'WEB:%')
  ), page as (
    select pk.id, pk.ts, pk.status_key, pk.created_at, pk.total_amount from picked pk
    order by
      case when v_sort = 'oldest' then coalesce(pk.ts, pk.created_at) end asc,
      case when v_sort = 'amount' then pk.total_amount end desc,
      coalesce(pk.ts, pk.created_at) desc, pk.id
    limit least(greatest(p_limit, 1), 200) offset greatest(p_offset, 0)
  )
  select jsonb_build_object(
    'total', (select count(*) from picked),
    'value', (select coalesce(sum(picked.total_amount), 0) from picked),
    'counts', coalesce((select jsonb_agg(jsonb_build_object('key', c.status_key, 'n', c.n, 'value', c.amount) order by c.status_key)
                        from (select base.status_key, count(*) as n, coalesce(sum(base.total_amount), 0) as amount
                              from base group by base.status_key) c), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'id', o.id, 'order_number', o.order_number, 'web_number', o.web_number,
        'store_number', o.external_order_number,
        'channel', (select sc.platform from public.sales_channels sc where sc.id = o.sales_channel_id),
        'status_key', pg.status_key, 'status', o.status, 'review_status', o.review_status,
        'date', pg.ts, 'created_at', o.created_at, 'confirmed_at', o.confirmed_at, 'shipped_at', o.shipped_at,
        'delivered_at', o.delivered_at, 'returned_at', o.returned_at, 'cancelled_at', o.cancelled_at,
        'customer_name', o.customer_name, 'customer_phone', o.customer_phone, 'district', o.shipping_district,
        'total_amount', o.total_amount, 'amount_paid', o.amount_paid, 'cod_amount', o.cod_amount,
        'item_count', (select coalesce(sum(oi.quantity), 0) from public.order_items oi where oi.order_id = o.id),
        'items', (select string_agg(oi.product_name || coalesce(' · ' || oi.variant_title, '') || ' ×' || oi.quantity, ', ' order by oi.created_at)
                  from public.order_items oi where oi.order_id = o.id),
        'courier', (select jsonb_build_object('name', c.name, 'number', coalesce(s.tracking_number, s.consignment_id), 'status', s.status,
                             'tracking_url', public._tracking_url(c.provider, c.tracking_url_template, coalesce(s.tracking_number, s.consignment_id)))
                    from public.shipments s join public.couriers c on c.id = s.courier_id
                    where s.order_id = o.id and s.is_active order by s.created_at desc limit 1),
        'courier_payment', case
            when exists (select 1 from public.courier_invoice_lines l where l.order_id = o.id and l.settled_at is not null) then 'paid'
            when o.status in ('DELIVERED', 'PARTIALLY_DELIVERED') and o.cod_amount > 0 then 'unpaid'
            else 'none' end,
        'courier_paid', (select jsonb_build_object('amount', coalesce(sum(l.cod_collected), 0), 'at', max(l.settled_at), 'statement', max(i.invoice_number))
                         from public.courier_invoice_lines l join public.courier_invoices i on i.id = l.invoice_id
                         where l.order_id = o.id and l.settled_at is not null),
        'taken_by', (select coalesce(nullif(pr.full_name, ''), pr.email) from public.profiles pr
                     where pr.id = coalesce(o.approved_by, o.review_updated_by, o.created_by, o.assigned_to)),
        'source', (select a.source from public.order_attributions a where a.order_id = o.id),
        'tags', o.tags,
        'contact_attempts', o.contact_attempts, 'follow_up_at', o.follow_up_at)
      order by
        case when v_sort = 'oldest' then coalesce(pg.ts, pg.created_at) end asc,
        case when v_sort = 'amount' then pg.total_amount end desc,
        coalesce(pg.ts, pg.created_at) desc, pg.id)
      from page pg join public.orders o on o.id = pg.id), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.orders_board(jsonb, integer, integer) from public, anon;
grant execute on function public.orders_board(jsonb, integer, integer) to authenticated, service_role;

create or replace function public.orders_board_options()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('orders.view');
  return jsonb_build_object(
    'couriers', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'active', c.is_active) order by c.is_active desc, c.name)
                          from public.couriers c), '[]'::jsonb),
    -- Everyone who has been staff, so orders taken by someone who has left can still be found.
    'staff', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', coalesce(nullif(p.full_name, ''), p.email), 'active', p.is_active)
                                        order by p.is_active desc, coalesce(nullif(p.full_name, ''), p.email))
                       from public.profiles p where p.role_id is not null), '[]'::jsonb),
    'sources', coalesce((select jsonb_agg(x.s order by x.s) from (
                   select distinct coalesce(a.source, 'Unknown') as s from public.order_attributions a
                   union select 'Unknown') x), '[]'::jsonb),
    'districts', coalesce((select jsonb_agg(x.d order by x.d) from (
                   select min(trim(o.shipping_district)) as d from public.orders o
                   where nullif(trim(o.shipping_district), '') is not null
                   group by lower(trim(o.shipping_district))) x), '[]'::jsonb),
    'tags', coalesce((select jsonb_agg(jsonb_build_object('name', t.name, 'color', t.color) order by t.name) from public.order_tags t), '[]'::jsonb),
    'call_statuses', coalesce((select jsonb_agg(jsonb_build_object('code', r.code, 'label', r.label, 'color', r.color) order by r.sort_order, r.label)
                               from public.order_review_statuses r where r.is_active), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.orders_board_options() from public, anon;
grant execute on function public.orders_board_options() to authenticated, service_role;

select public._tenancy_own_functions();
