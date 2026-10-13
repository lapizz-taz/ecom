-- Round-3 attack-simulation fix (DoS #4): bound checkout-lead creation per
-- merchant. capture_checkout_lead() upserts on (merchant_id, visitor_id), so a
-- visitor refilling the same cart updates one row — but a storefront visitor
-- rotating random visitor_ids (each only needs to be 8+ chars) could insert an
-- unbounded number of new rows for one merchant and flood checkout_leads.
--
-- The fix caps only brand-new rows: updating a lead that already exists for this
-- merchant+visitor is always allowed, so a real shopper is never blocked. Once a
-- merchant already holds many recent OPEN/CONTACTED leads, further new visitors
-- are dropped silently (return null) until the window clears. The cap is high
-- enough that genuine traffic — even a flash sale — stays well under it.

-- Supporting index so the per-merchant open-lead count is cheap even under a flood.
create index if not exists checkout_leads_merchant_open_idx
  on public.checkout_leads (merchant_id, updated_at desc)
  where status in ('OPEN', 'CONTACTED');

create or replace function public.capture_checkout_lead(p_input jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_visitor text := nullif(left(p_input ->> 'visitor_id', 64), '');
  v_phone text := public.clean_phone(p_input ->> 'phone');
  v_id uuid;
  v_items jsonb := coalesce(p_input -> 'items', '[]'::jsonb);
  v_source text;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if not public.setting_bool('orders', array['capture_incomplete'], true)
     or v_visitor is null or length(v_visitor) < 8 or v_phone is null
     or jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) = 0 or jsonb_array_length(v_items) > 50 then
    return null;
  end if;
  if exists (select 1 from public.orders where customer_phone = v_phone and created_at > now() - interval '30 minutes') then
    return null;
  end if;
  -- Abuse cap: only a brand-new row counts against the limit. An existing open
  -- lead for this merchant+visitor always updates; new visitors are dropped once
  -- the merchant already has many recent open leads.
  if not exists (
       select 1 from public.checkout_leads
       where merchant_id = public.current_merchant_id()
         and visitor_id = v_visitor and status in ('OPEN', 'CONTACTED'))
     and (select count(*) from public.checkout_leads
          where merchant_id = public.current_merchant_id()
            and status in ('OPEN', 'CONTACTED')
            and updated_at > now() - interval '1 hour') >= 1000 then
    return null;
  end if;
  v_source := case when jsonb_typeof(p_input -> 'attribution' -> 'last_touch') = 'object'
    then public.classify_touch(p_input -> 'attribution' -> 'last_touch') ->> 'source' else 'Direct' end;

  insert into public.checkout_leads(visitor_id, phone, customer_name, address, district, area, items, subtotal, total, attribution, source)
  values (v_visitor, v_phone, left(nullif(trim(p_input ->> 'customer_name'), ''), 100), left(nullif(trim(p_input ->> 'address'), ''), 300),
    left(nullif(trim(p_input ->> 'district'), ''), 60), left(nullif(trim(p_input ->> 'area'), ''), 80), v_items,
    coalesce((p_input ->> 'subtotal')::numeric, 0), coalesce((p_input ->> 'total')::numeric, 0),
    case when length(coalesce(p_input -> 'attribution', 'null'::jsonb)::text) <= 20000 then p_input -> 'attribution' end, v_source)
  on conflict (merchant_id, visitor_id) where status in ('OPEN', 'CONTACTED') do update set
    phone = excluded.phone,
    customer_name = coalesce(excluded.customer_name, public.checkout_leads.customer_name),
    address = coalesce(excluded.address, public.checkout_leads.address),
    district = coalesce(excluded.district, public.checkout_leads.district),
    area = coalesce(excluded.area, public.checkout_leads.area),
    items = excluded.items, subtotal = excluded.subtotal, total = excluded.total,
    attribution = coalesce(excluded.attribution, public.checkout_leads.attribution),
    source = excluded.source, updated_at = now()
  returning id into v_id;

  -- The visitor's cart reached checkout: now we know who it is.
  update public.store_carts set reached_checkout = true, lead_id = v_id, phone = v_phone,
    customer_name = coalesce(left(nullif(trim(p_input ->> 'customer_name'), ''), 100), customer_name),
    last_activity_at = now(), updated_at = now()
  where visitor_id = v_visitor and status = 'ACTIVE';
  return v_id;
end;
$$;
