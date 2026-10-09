-- Ctrl+K quick search across the admin: orders (number, phone, name),
-- courier parcels (tracking / consignment id), customers, products (name, SKU)
-- and courier invoices. One round trip; each group only appears for staff who
-- may see it. Small result sets, served by the existing trigram and btree
-- indexes.

create or replace function public.admin_global_search(p_q text, p_limit int default 6)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_q text := trim(coalesce(p_q, ''));
  v_like text;
  v_digits text := regexp_replace(coalesce(p_q, ''), '\D', '', 'g');
  v_limit int := least(greatest(coalesce(p_limit, 6), 1), 20);
  v_out jsonb := '{}'::jsonb;
  v_sys boolean := public.is_system_context();
begin
  if not (v_sys or public.is_staff()) then
    raise exception 'PERMISSION_DENIED: staff only' using errcode = '42501';
  end if;
  if length(v_q) < 2 then
    return v_out;
  end if;
  v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  -- Local phone numbers are stored as 01XXXXXXXXX; accept +880 / 880 prefixes.
  if v_digits like '880%' then
    v_digits := '0' || substr(v_digits, 4);
  end if;

  if v_sys or public.has_permission('orders.view') then
    v_out := v_out || jsonb_build_object('orders', coalesce((
      select jsonb_agg(r) from (
        select o.id, o.order_number, o.customer_name, o.customer_phone, o.status, o.total_amount, o.created_at,
               (o.confirmed_at is not null) as approved
        from public.orders o
        where o.order_number ilike v_like
           or o.customer_name ilike v_like
           or (length(v_digits) >= 5 and o.customer_phone like '%' || v_digits || '%')
        order by (o.order_number ilike v_q) desc, o.created_at desc
        limit v_limit) r), '[]'::jsonb));

    v_out := v_out || jsonb_build_object('parcels', coalesce((
      select jsonb_agg(r) from (
        select s.id, s.order_id, o.order_number, s.tracking_number, s.consignment_id, s.status, c.name as courier
        from public.shipments s
        join public.orders o on o.id = s.order_id
        join public.couriers c on c.id = s.courier_id
        where s.tracking_number ilike v_like or s.consignment_id ilike v_like
        order by s.is_active desc, s.created_at desc
        limit v_limit) r), '[]'::jsonb));
  end if;

  if v_sys or public.has_permission('customers.view') then
    v_out := v_out || jsonb_build_object('customers', coalesce((
      select jsonb_agg(r) from (
        select c.id, c.full_name, c.phone, c.status, c.total_orders
        from public.customers c
        where c.full_name ilike v_like
           or (length(v_digits) >= 5 and c.phone like '%' || v_digits || '%')
        order by c.updated_at desc
        limit v_limit) r), '[]'::jsonb));
  end if;

  if v_sys or public.has_permission('products.view') then
    v_out := v_out || jsonb_build_object('products', coalesce((
      select jsonb_agg(r) from (
        select distinct on (p.id) p.id, p.name, p.status, coalesce(v.sku, p.sku) as sku
        from public.products p
        left join public.product_variants v on v.product_id = p.id and v.sku ilike v_like
        where p.name ilike v_like or p.sku ilike v_like or v.id is not null
        order by p.id, v.sku nulls last
        limit v_limit) r), '[]'::jsonb));
  end if;

  if v_sys or public.has_permission('couriers.view') then
    v_out := v_out || jsonb_build_object('invoices', coalesce((
      select jsonb_agg(r) from (
        select i.id, i.invoice_number, i.invoice_date, c.name as courier, i.status
        from public.courier_invoices i
        join public.couriers c on c.id = i.courier_id
        where i.invoice_number ilike v_like
        order by i.created_at desc
        limit v_limit) r), '[]'::jsonb));
  end if;

  return v_out;
end;
$$;

revoke all on function public.admin_global_search(text, int) from public, anon;
grant execute on function public.admin_global_search(text, int) to authenticated;

-- Support → Report issue: a staff member describes a problem; it lands in the
-- System log (where owners already look) with the page and who reported it.
create or replace function public.report_issue(p_message text, p_context jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_msg text := trim(coalesce(p_message, ''));
  v_name text;
begin
  if not public.is_staff() then
    raise exception 'PERMISSION_DENIED: staff only' using errcode = '42501';
  end if;
  if length(v_msg) < 5 then
    raise exception 'VALIDATION: Describe the problem in a few words' using errcode = '22023';
  end if;
  select coalesce(nullif(trim(full_name), ''), email) into v_name from public.profiles where id = auth.uid();
  return public._log_system_event('WARN', 'OTHER', 'staff-report', left('Reported by ' || coalesce(v_name, 'staff') || ': ' || v_msg, 2000),
    jsonb_strip_nulls(jsonb_build_object(
      'page', left(p_context ->> 'page', 300),
      'browser', left(p_context ->> 'browser', 300),
      'screen', left(p_context ->> 'screen', 40),
      'user_id', auth.uid())));
end;
$$;

revoke all on function public.report_issue(text, jsonb) from public, anon;
grant execute on function public.report_issue(text, jsonb) to authenticated;
