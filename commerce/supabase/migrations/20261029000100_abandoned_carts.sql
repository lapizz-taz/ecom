-- =============================================================================
-- Abandoned carts
--
--   * Our store: the storefront keeps a copy of each visitor's cart on the
--     server (prices and names come from the catalog, never from the
--     browser). A cart with items and no activity for a while (Settings →
--     Orders, default 60 minutes) is abandoned. Reaching checkout links it to
--     the incomplete checkout (phone); placing an order converts it — when it
--     had been abandoned first, it counts as recovered. Staff can call, send
--     a link that puts the same items back in the customer's cart, or create
--     the order for them.
--   * Shopify: abandoned checkouts fetched from the Admin API (read_orders)
--     by the channels function, stored per store; Shopify's completedAt marks
--     them recovered. Staff follow-up (calls, notes, dismiss) is kept here.
-- =============================================================================

update public.settings set value = value || jsonb_build_object('track_carts', true, 'abandoned_cart_minutes', 60)
where key = 'orders' and not (value ? 'track_carts');

create table if not exists public.store_carts (
  id uuid primary key default gen_random_uuid(),
  visitor_id text not null check (length(visitor_id) between 8 and 64),
  session_id text,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'CONVERTED', 'EMPTIED', 'DISMISSED')),
  reached_checkout boolean not null default false,
  recovered boolean not null default false,
  items jsonb not null default '[]'::jsonb,
  item_count int not null default 0,
  subtotal numeric(12,2) not null default 0,
  customer_user_id uuid,
  customer_id uuid references public.customers(id),
  phone text,
  customer_name text,
  lead_id uuid references public.checkout_leads(id),
  order_id uuid references public.orders(id),
  source text,
  attribution jsonb,
  contacted boolean not null default false,
  contact_count int not null default 0,
  last_contacted_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  converted_at timestamptz
);
create unique index if not exists store_carts_active_visitor_idx on public.store_carts(visitor_id) where status = 'ACTIVE';
create index if not exists store_carts_status_idx on public.store_carts(status, last_activity_at desc);
create index if not exists store_carts_phone_idx on public.store_carts(phone) where phone is not null;
create index if not exists store_carts_lead_idx on public.store_carts(lead_id) where lead_id is not null;

alter table public.store_carts enable row level security;
revoke all on public.store_carts from anon, authenticated;

/** Minutes without activity after which a cart counts as abandoned. */
create or replace function public._abandoned_after()
returns interval
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select make_interval(mins => least(greatest(coalesce(public.setting_numeric('orders', array['abandoned_cart_minutes'], 60), 60)::int, 5), 10080))
$$;

/**
 * Called by the storefront whenever the cart changes. Only variant ids and
 * quantities are taken from the browser; names, prices and images come from
 * the catalog. Returns the cart id (null when tracking is off or nothing to keep).
 */
create or replace function public.storefront_cart_sync(p_visitor_id text, p_session_id text, p_items jsonb, p_attribution jsonb default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lines jsonb;
  v_count int;
  v_subtotal numeric;
  v_cart public.store_carts;
  v_customer public.customers;
  v_source text;
  v_attr jsonb := case when jsonb_typeof(p_attribution) = 'object' and length(p_attribution::text) <= 20000 then p_attribution end;
begin
  if not public.setting_bool('orders', array['track_carts'], true)
     or p_visitor_id is null or p_visitor_id !~ '^[A-Za-z0-9_-]{8,64}$'
     or jsonb_typeof(coalesce(p_items, 'null'::jsonb)) <> 'array' or jsonb_array_length(p_items) > 50 then
    return null;
  end if;

  select * into v_cart from public.store_carts where visitor_id = p_visitor_id and status = 'ACTIVE';
  -- At most one write per second per visitor.
  if v_cart.id is not null and v_cart.last_activity_at > now() - interval '1 second' then
    return v_cart.id;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'variant_id', v.id, 'product_id', p.id, 'name', p.name,
      'variant', case when v.title is null or v.title = 'Default' then null else v.title end,
      'sku', v.sku, 'quantity', x.quantity, 'unit_price', coalesce(v.price, p.price),
      'image', (select i.url from public.product_images i where i.product_id = p.id order by (i.variant_id = v.id) desc nulls last, i.is_primary desc, i.position limit 1))
      order by x.ord), '[]'::jsonb),
    coalesce(sum(x.quantity), 0), coalesce(sum(x.quantity * coalesce(v.price, p.price)), 0)
  into v_lines, v_count, v_subtotal
  from (
    select distinct on (e ->> 'variant_id') (e ->> 'variant_id')::uuid as variant_id,
      least(greatest(coalesce((e ->> 'quantity')::int, 1), 1), 100) as quantity, ord
    from jsonb_array_elements(p_items) with ordinality as t(e, ord)
    where coalesce(e ->> 'variant_id', '') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' and coalesce(e ->> 'quantity', '1') ~ '^[0-9]{1,3}$'
    order by e ->> 'variant_id', ord
  ) x
  join public.product_variants v on v.id = x.variant_id and v.is_active
  join public.products p on p.id = v.product_id and p.status = 'ACTIVE';

  if v_count = 0 then
    if v_cart.id is not null then
      update public.store_carts set status = 'EMPTIED', items = '[]'::jsonb, item_count = 0, subtotal = 0,
        last_activity_at = now(), updated_at = now()
      where id = v_cart.id;
    end if;
    return null;
  end if;

  if auth.uid() is not null then
    select * into v_customer from public.customers where auth_user_id = auth.uid() limit 1;
  end if;
  v_source := case when jsonb_typeof(v_attr -> 'last_touch') = 'object' then public.classify_touch(v_attr -> 'last_touch') ->> 'source' end;

  insert into public.store_carts(visitor_id, session_id, items, item_count, subtotal, customer_user_id, customer_id, phone, customer_name, source, attribution)
  values (p_visitor_id, left(p_session_id, 64), v_lines, v_count, v_subtotal, auth.uid(), v_customer.id, v_customer.phone, v_customer.full_name,
    coalesce(v_source, 'Direct'), v_attr)
  on conflict (visitor_id) where status = 'ACTIVE' do update set
    session_id = coalesce(excluded.session_id, public.store_carts.session_id),
    items = excluded.items, item_count = excluded.item_count, subtotal = excluded.subtotal,
    customer_user_id = coalesce(excluded.customer_user_id, public.store_carts.customer_user_id),
    customer_id = coalesce(excluded.customer_id, public.store_carts.customer_id),
    phone = coalesce(public.store_carts.phone, excluded.phone),
    customer_name = coalesce(public.store_carts.customer_name, excluded.customer_name),
    source = case when v_source is not null then excluded.source else public.store_carts.source end,
    attribution = coalesce(excluded.attribution, public.store_carts.attribution),
    last_activity_at = now(), updated_at = now()
  returning * into v_cart;
  return v_cart.id;
end;
$$;

/**
 * The items of a cart, for the "finish your order" link staff send. Only
 * products that are still for sale; the cart id is the (unguessable) key.
 */
create or replace function public.storefront_cart_restore(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_items jsonb;
  v_max int := greatest(coalesce(public.setting_numeric('orders', array['max_quantity_per_item'], 10)::int, 1), 1);
begin
  select coalesce(jsonb_agg(jsonb_build_object(
      'variantId', v.id, 'productId', p.id, 'slug', p.slug, 'name', p.name,
      'variantTitle', case when v.title = 'Default' then null else v.title end,
      'price', coalesce(v.price, p.price), 'image', e ->> 'image',
      'quantity', least((e ->> 'quantity')::int, x.max_qty), 'maxQuantity', x.max_qty) order by ord), '[]'::jsonb)
  into v_items
  from public.store_carts c
  cross join lateral jsonb_array_elements(c.items) with ordinality as t(e, ord)
  join public.product_variants v on v.id = (e ->> 'variant_id')::uuid and v.is_active
  join public.products p on p.id = v.product_id and p.status = 'ACTIVE'
  cross join lateral (select case when p.track_inventory
      then least(v_max, greatest(coalesce((select i.available from public.inventory i where i.variant_id = v.id), 0), 0))
      else v_max end as max_qty) x
  where c.id = p_id and c.status in ('ACTIVE', 'DISMISSED') and x.max_qty > 0;
  return v_items;
end;
$$;

-- -----------------------------------------------------------------------------
-- Link carts to checkouts and orders (existing functions, extended)
-- -----------------------------------------------------------------------------
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
  v_source := case when jsonb_typeof(p_input -> 'attribution' -> 'last_touch') = 'object'
    then public.classify_touch(p_input -> 'attribution' -> 'last_touch') ->> 'source' else 'Direct' end;

  insert into public.checkout_leads(visitor_id, phone, customer_name, address, district, area, items, subtotal, total, attribution, source)
  values (v_visitor, v_phone, left(nullif(trim(p_input ->> 'customer_name'), ''), 100), left(nullif(trim(p_input ->> 'address'), ''), 300),
    left(nullif(trim(p_input ->> 'district'), ''), 60), left(nullif(trim(p_input ->> 'area'), ''), 80), v_items,
    coalesce((p_input ->> 'subtotal')::numeric, 0), coalesce((p_input ->> 'total')::numeric, 0),
    case when length(coalesce(p_input -> 'attribution', 'null'::jsonb)::text) <= 20000 then p_input -> 'attribution' end, v_source)
  on conflict (visitor_id) where status in ('OPEN', 'CONTACTED') do update set
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

/** Marks open carts of a visitor / phone as converted by an order; abandoned-then-bought counts as recovered. */
create or replace function public._convert_store_carts(p_visitor_id text, p_phone text, p_order_id uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int;
begin
  update public.store_carts set status = 'CONVERTED', order_id = p_order_id, converted_at = now(), updated_at = now(),
    recovered = item_count > 0 and last_activity_at < now() - public._abandoned_after()
  where status in ('ACTIVE', 'DISMISSED')
    and ((p_visitor_id is not null and p_visitor_id <> '' and visitor_id = p_visitor_id)
      or (p_phone is not null and phone = p_phone and last_activity_at > now() - interval '14 days'));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.convert_checkout_lead(p_visitor_id text, p_phone text, p_order_id uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int;
begin
  if not (public.is_system_context() or public.has_permission('orders.create')) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.checkout_leads set status = 'CONVERTED', order_id = p_order_id, updated_at = now()
  where status in ('OPEN', 'CONTACTED')
    and (visitor_id = p_visitor_id or (phone = public.clean_phone(p_phone) and updated_at > now() - interval '7 days'));
  get diagnostics v_count = row_count;
  perform public._convert_store_carts(p_visitor_id, public.clean_phone(p_phone), p_order_id);
  return v_count;
end;
$$;

create or replace function public._orders_convert_leads()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.checkout_leads set status = 'CONVERTED', order_id = new.id, updated_at = now()
  where phone = new.customer_phone and status in ('OPEN', 'CONTACTED') and updated_at > now() - interval '7 days';
  perform public._convert_store_carts(null, new.customer_phone, new.id);
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Staff: our store's carts
-- -----------------------------------------------------------------------------
create or replace function public.admin_store_carts(p_view text default 'abandoned', p_search text default null, p_limit int default 50, p_offset int default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_after interval := public._abandoned_after();
  v_q text := nullif(trim(coalesce(p_search, '')), '');
  v_digits text := regexp_replace(coalesce(p_search, ''), '\D', '', 'g');
begin
  perform public.require_permission('orders.view');
  return (
    with base as (
      select c.*, (c.status = 'ACTIVE' and c.item_count > 0 and c.last_activity_at < now() - v_after) as is_abandoned
      from public.store_carts c
      where c.item_count > 0 or c.status = 'CONVERTED'
    ), filtered as (
      select * from base b
      where case coalesce(p_view, 'abandoned')
          when 'abandoned' then b.is_abandoned
          when 'active' then b.status = 'ACTIVE' and not b.is_abandoned
          when 'recovered' then b.status = 'CONVERTED' and b.recovered
          when 'converted' then b.status = 'CONVERTED'
          when 'dismissed' then b.status = 'DISMISSED'
          else true end
        and (v_q is null or b.customer_name ilike '%' || v_q || '%' or b.items::text ilike '%' || v_q || '%'
             or (length(v_digits) >= 4 and b.phone like '%' || v_digits || '%'))
    )
    select jsonb_build_object(
      'total', (select count(*) from filtered),
      'items', coalesce((select jsonb_agg(to_jsonb(f) - 'attribution' - 'customer_user_id' order by f.last_activity_at desc)
        from (select * from filtered order by last_activity_at desc limit least(greatest(p_limit, 1), 200) offset greatest(p_offset, 0)) f), '[]'::jsonb),
      'abandoned_after_minutes', extract(epoch from v_after)::int / 60,
      'stats', (select jsonb_build_object(
          'abandoned', count(*) filter (where is_abandoned),
          'abandoned_value', coalesce(sum(subtotal) filter (where is_abandoned), 0),
          'abandoned_with_phone', count(*) filter (where is_abandoned and phone is not null),
          'active', count(*) filter (where status = 'ACTIVE' and not is_abandoned and item_count > 0),
          'recovered', count(*) filter (where status = 'CONVERTED' and recovered and converted_at > now() - interval '30 days'),
          'recovered_value', coalesce(sum(subtotal) filter (where status = 'CONVERTED' and recovered and converted_at > now() - interval '30 days'), 0),
          'converted_30d', count(*) filter (where status = 'CONVERTED' and converted_at > now() - interval '30 days'),
          'carts_30d', count(*) filter (where created_at > now() - interval '30 days'))
        from base),
      'top_products', coalesce((select jsonb_agg(t order by (t ->> 'carts')::int desc) from (
          select jsonb_build_object('product_id', e ->> 'product_id', 'name', max(e ->> 'name'), 'image', max(e ->> 'image'),
            'carts', count(distinct b.id), 'quantity', sum((e ->> 'quantity')::int),
            'value', sum((e ->> 'quantity')::numeric * (e ->> 'unit_price')::numeric)) as t
          from base b cross join lateral jsonb_array_elements(b.items) e
          where b.is_abandoned and b.last_activity_at > now() - interval '30 days'
          group by e ->> 'product_id' order by count(distinct b.id) desc limit 8) x), '[]'::jsonb)));
end;
$$;

create or replace function public.admin_update_store_cart(p_id uuid, p_status text, p_note text default null)
returns public.store_carts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.store_carts;
begin
  perform public.require_permission('orders.update');
  if p_status not in ('CONTACTED', 'DISMISSED', 'OPEN') then
    raise exception 'VALIDATION: unknown status' using errcode = '22023';
  end if;
  update public.store_carts set
    status = case when p_status = 'DISMISSED' then 'DISMISSED' when p_status = 'OPEN' and status = 'DISMISSED' then 'ACTIVE' else status end,
    contacted = contacted or p_status = 'CONTACTED',
    contact_count = contact_count + case when p_status = 'CONTACTED' then 1 else 0 end,
    last_contacted_at = case when p_status = 'CONTACTED' then now() else last_contacted_at end,
    notes = case when nullif(trim(coalesce(p_note, '')), '') is null then notes
      else concat_ws(E'\n', notes, to_char(now() at time zone public.store_timezone(), 'DD Mon HH24:MI') || ' — ' || left(trim(p_note), 500)) end,
    updated_at = now()
  where id = p_id and status <> 'CONVERTED'
  returning * into v_row;
  if v_row.id is null then
    raise exception 'NOT_FOUND: cart not found or already ordered' using errcode = 'P0002';
  end if;
  perform public.log_audit('store_cart.' || lower(p_status), 'store_cart', p_id::text, null, jsonb_build_object('note', p_note));
  return v_row;
end;
$$;

create or replace function public.admin_get_store_cart(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('orders.view');
  return (select to_jsonb(c) - 'customer_user_id' from public.store_carts c where c.id = p_id);
end;
$$;

/** An order staff created from a cart: the cart is done and the order gets its ad source. */
create or replace function public.admin_link_store_cart(p_cart_id uuid, p_order_id uuid)
returns public.store_carts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cart public.store_carts;
begin
  perform public.require_permission('orders.create');
  select * into v_cart from public.store_carts where id = p_cart_id for update;
  if v_cart.id is null then
    raise exception 'NOT_FOUND: cart not found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.orders where id = p_order_id) then
    raise exception 'NOT_FOUND: order not found' using errcode = 'P0002';
  end if;
  if v_cart.status = 'CONVERTED' and v_cart.order_id is distinct from p_order_id then
    raise exception 'VALIDATION: this cart already became another order' using errcode = '22023';
  end if;
  if jsonb_typeof(v_cart.attribution) = 'object' and not exists (select 1 from public.order_attributions where order_id = p_order_id) then
    perform public._record_order_attribution(p_order_id, v_cart.attribution);
  end if;
  update public.store_carts set status = 'CONVERTED', order_id = p_order_id, converted_at = coalesce(converted_at, now()), updated_at = now(),
    recovered = recovered or (status <> 'CONVERTED' and last_activity_at < now() - public._abandoned_after())
  where id = p_cart_id returning * into v_cart;
  if v_cart.lead_id is not null then
    update public.checkout_leads set status = 'CONVERTED', order_id = p_order_id, updated_at = now()
    where id = v_cart.lead_id and status in ('OPEN', 'CONTACTED');
  end if;
  perform public._order_log(p_order_id, 'FROM_ABANDONED_CART', 'Created from an abandoned cart');
  return v_cart;
end;
$$;

-- -----------------------------------------------------------------------------
-- Shopify abandoned checkouts
-- -----------------------------------------------------------------------------
create table if not exists public.shopify_abandoned_checkouts (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.sales_channels(id),
  external_id text not null,
  legacy_id text,
  name text,
  recovery_url text,
  customer_name text,
  email text,
  phone text,
  address text,
  city text,
  province text,
  country text,
  items jsonb not null default '[]'::jsonb,
  item_count int not null default 0,
  subtotal numeric(12,2),
  total numeric(12,2) not null default 0,
  currency text,
  shop_created_at timestamptz,
  shop_updated_at timestamptz,
  completed_at timestamptz,
  status text not null default 'OPEN' check (status in ('OPEN', 'RECOVERED')),
  follow_up text not null default 'NONE' check (follow_up in ('NONE', 'CONTACTED', 'DISMISSED')),
  contact_count int not null default 0,
  last_contacted_at timestamptz,
  notes text,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (channel_id, external_id)
);
create index if not exists shopify_abandoned_created_idx on public.shopify_abandoned_checkouts(shop_created_at desc);
create index if not exists shopify_abandoned_phone_idx on public.shopify_abandoned_checkouts(phone) where phone is not null;

alter table public.shopify_abandoned_checkouts enable row level security;
revoke all on public.shopify_abandoned_checkouts from anon, authenticated;

/** Stores what the channels function fetched (service role only). p_error records a failed fetch instead. */
create or replace function public.channel_abandoned_upsert(p_channel_id uuid, p_rows jsonb, p_error text default null)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int := 0;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_error is not null then
    update public.sales_channels set settings = settings || jsonb_build_object('abandoned_error', left(p_error, 300), 'abandoned_checked_at', now())
    where id = p_channel_id;
    return 0;
  end if;
  insert into public.shopify_abandoned_checkouts(channel_id, external_id, legacy_id, name, recovery_url, customer_name, email, phone, address, city,
    province, country, items, item_count, subtotal, total, currency, shop_created_at, shop_updated_at, completed_at, status, synced_at)
  select p_channel_id, r ->> 'id', r ->> 'legacy_id', left(r ->> 'name', 60), left(r ->> 'recovery_url', 1000),
    left(nullif(trim(r ->> 'customer_name'), ''), 120), left(nullif(r ->> 'email', ''), 160),
    nullif(public.clean_phone(r ->> 'phone'), ''), left(nullif(trim(r ->> 'address'), ''), 300), left(nullif(trim(r ->> 'city'), ''), 80),
    left(nullif(trim(r ->> 'province'), ''), 80), left(nullif(trim(r ->> 'country'), ''), 80),
    coalesce(r -> 'items', '[]'::jsonb), coalesce((r ->> 'item_count')::int, 0), nullif(r ->> 'subtotal', '')::numeric,
    coalesce(nullif(r ->> 'total', '')::numeric, 0), left(r ->> 'currency', 3),
    nullif(r ->> 'created_at', '')::timestamptz, nullif(r ->> 'updated_at', '')::timestamptz, nullif(r ->> 'completed_at', '')::timestamptz,
    case when nullif(r ->> 'completed_at', '') is not null then 'RECOVERED' else 'OPEN' end, now()
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
  where coalesce(r ->> 'id', '') <> ''
  on conflict (channel_id, external_id) do update set
    legacy_id = coalesce(excluded.legacy_id, shopify_abandoned_checkouts.legacy_id),
    name = coalesce(excluded.name, shopify_abandoned_checkouts.name),
    recovery_url = coalesce(excluded.recovery_url, shopify_abandoned_checkouts.recovery_url),
    customer_name = coalesce(excluded.customer_name, shopify_abandoned_checkouts.customer_name),
    email = coalesce(excluded.email, shopify_abandoned_checkouts.email),
    phone = coalesce(excluded.phone, shopify_abandoned_checkouts.phone),
    address = coalesce(excluded.address, shopify_abandoned_checkouts.address),
    city = coalesce(excluded.city, shopify_abandoned_checkouts.city),
    province = coalesce(excluded.province, shopify_abandoned_checkouts.province),
    country = coalesce(excluded.country, shopify_abandoned_checkouts.country),
    items = excluded.items, item_count = excluded.item_count, subtotal = excluded.subtotal, total = excluded.total,
    currency = coalesce(excluded.currency, shopify_abandoned_checkouts.currency),
    shop_updated_at = excluded.shop_updated_at,
    completed_at = coalesce(excluded.completed_at, shopify_abandoned_checkouts.completed_at),
    status = case when coalesce(excluded.completed_at, shopify_abandoned_checkouts.completed_at) is not null then 'RECOVERED' else 'OPEN' end,
    synced_at = now();
  get diagnostics v_count = row_count;
  update public.sales_channels set settings = (settings - 'abandoned_error') || jsonb_build_object('abandoned_synced_at', now(), 'abandoned_checked_at', now())
  where id = p_channel_id;
  return v_count;
end;
$$;

create or replace function public.admin_shopify_abandoned(p_view text default 'open', p_search text default null, p_limit int default 50, p_offset int default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_q text := nullif(trim(coalesce(p_search, '')), '');
  v_digits text := regexp_replace(coalesce(p_search, ''), '\D', '', 'g');
begin
  perform public.require_permission('orders.view');
  return (
    with filtered as (
      select a.*, c.name as store_name, c.shop_domain from public.shopify_abandoned_checkouts a
      join public.sales_channels c on c.id = a.channel_id
      where case coalesce(p_view, 'open')
          when 'open' then a.status = 'OPEN' and a.follow_up <> 'DISMISSED'
          when 'recovered' then a.status = 'RECOVERED'
          when 'dismissed' then a.follow_up = 'DISMISSED' and a.status = 'OPEN'
          else true end
        and (v_q is null or a.customer_name ilike '%' || v_q || '%' or a.email ilike '%' || v_q || '%' or a.name ilike '%' || v_q || '%'
             or a.items::text ilike '%' || v_q || '%' or a.country ilike '%' || v_q || '%' or a.legacy_id like '%' || v_q || '%'
             or (length(v_digits) >= 4 and a.phone like '%' || v_digits || '%'))
    )
    select jsonb_build_object(
      'total', (select count(*) from filtered),
      'items', coalesce((select jsonb_agg(to_jsonb(f) order by f.shop_created_at desc nulls last)
        from (select * from filtered order by shop_created_at desc nulls last limit least(greatest(p_limit, 1), 200) offset greatest(p_offset, 0)) f), '[]'::jsonb),
      'stats', (select jsonb_build_object(
          'open', count(*) filter (where status = 'OPEN' and follow_up <> 'DISMISSED'),
          'open_value', coalesce(sum(total) filter (where status = 'OPEN' and follow_up <> 'DISMISSED'), 0),
          'recovered_30d', count(*) filter (where status = 'RECOVERED' and completed_at > now() - interval '30 days'),
          'recovered_value_30d', coalesce(sum(total) filter (where status = 'RECOVERED' and completed_at > now() - interval '30 days'), 0),
          'with_contact', count(*) filter (where status = 'OPEN' and (phone is not null or email is not null)),
          'all_30d', count(*) filter (where shop_created_at > now() - interval '30 days'))
        from public.shopify_abandoned_checkouts),
      'channels', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'shop_domain', c.shop_domain, 'status', c.status,
          'synced_at', c.settings ->> 'abandoned_synced_at', 'error', c.settings ->> 'abandoned_error') order by c.created_at)
        from public.sales_channels c where c.platform = 'SHOPIFY' and c.status <> 'DISCONNECTED'), '[]'::jsonb)));
end;
$$;

create or replace function public.admin_update_shopify_abandoned(p_id uuid, p_status text, p_note text default null)
returns public.shopify_abandoned_checkouts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.shopify_abandoned_checkouts;
begin
  perform public.require_permission('orders.update');
  if p_status not in ('CONTACTED', 'DISMISSED', 'OPEN') then
    raise exception 'VALIDATION: unknown status' using errcode = '22023';
  end if;
  update public.shopify_abandoned_checkouts set
    follow_up = case p_status when 'DISMISSED' then 'DISMISSED' when 'CONTACTED' then 'CONTACTED'
      else case when contact_count > 0 then 'CONTACTED' else 'NONE' end end,
    contact_count = contact_count + case when p_status = 'CONTACTED' then 1 else 0 end,
    last_contacted_at = case when p_status = 'CONTACTED' then now() else last_contacted_at end,
    notes = case when nullif(trim(coalesce(p_note, '')), '') is null then notes
      else concat_ws(E'\n', notes, to_char(now() at time zone public.store_timezone(), 'DD Mon HH24:MI') || ' — ' || left(trim(p_note), 500)) end
  where id = p_id
  returning * into v_row;
  if v_row.id is null then
    raise exception 'NOT_FOUND: abandoned checkout not found' using errcode = 'P0002';
  end if;
  perform public.log_audit('shopify_abandoned.' || lower(p_status), 'shopify_abandoned_checkout', p_id::text, null, jsonb_build_object('note', p_note));
  return v_row;
end;
$$;

create or replace function public.admin_bulk_shopify_abandoned(p_ids uuid[], p_status text)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int;
begin
  perform public.require_permission('orders.update');
  if p_status not in ('CONTACTED', 'DISMISSED', 'OPEN') then
    raise exception 'VALIDATION: unknown status' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_ids), 0) = 0 or cardinality(p_ids) > 500 then
    raise exception 'VALIDATION: choose between 1 and 500 checkouts' using errcode = '22023';
  end if;
  update public.shopify_abandoned_checkouts set
    follow_up = case p_status when 'DISMISSED' then 'DISMISSED' when 'CONTACTED' then 'CONTACTED'
      else case when contact_count > 0 then 'CONTACTED' else 'NONE' end end,
    contact_count = contact_count + case when p_status = 'CONTACTED' then 1 else 0 end,
    last_contacted_at = case when p_status = 'CONTACTED' then now() else last_contacted_at end
  where id = any(p_ids);
  get diagnostics v_count = row_count;
  perform public.log_audit('shopify_abandoned.bulk_' || lower(p_status), 'shopify_abandoned_checkout', 'bulk', null, jsonb_build_object('count', v_count));
  return v_count;
end;
$$;

-- Web Orders menu count: carts abandoned in the last 7 days.
create or replace function public.abandoned_counts()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('orders.view');
  return jsonb_build_object(
    'store', (select count(*) from public.store_carts where status = 'ACTIVE' and item_count > 0
              and last_activity_at < now() - public._abandoned_after() and last_activity_at > now() - interval '7 days'),
    'shopify', (select count(*) from public.shopify_abandoned_checkouts where status = 'OPEN' and follow_up = 'NONE'
                and shop_created_at > now() - interval '7 days'));
end;
$$;

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
revoke all on function public._abandoned_after(), public._convert_store_carts(text, text, uuid),
  public.channel_abandoned_upsert(uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.storefront_cart_sync(text, text, jsonb, jsonb), public.storefront_cart_restore(uuid),
  public.admin_store_carts(text, text, int, int), public.admin_update_store_cart(uuid, text, text), public.admin_get_store_cart(uuid),
  public.admin_link_store_cart(uuid, uuid), public.admin_shopify_abandoned(text, text, int, int),
  public.admin_update_shopify_abandoned(uuid, text, text), public.admin_bulk_shopify_abandoned(uuid[], text), public.abandoned_counts() from public;
grant execute on function public.storefront_cart_sync(text, text, jsonb, jsonb), public.storefront_cart_restore(uuid) to anon, authenticated;
grant execute on function public.admin_store_carts(text, text, int, int), public.admin_update_store_cart(uuid, text, text), public.admin_get_store_cart(uuid),
  public.admin_link_store_cart(uuid, uuid), public.admin_shopify_abandoned(text, text, int, int),
  public.admin_update_shopify_abandoned(uuid, text, text), public.admin_bulk_shopify_abandoned(uuid[], text), public.abandoned_counts() to authenticated;
revoke all on function public.admin_store_carts(text, text, int, int), public.admin_update_store_cart(uuid, text, text), public.admin_get_store_cart(uuid),
  public.admin_link_store_cart(uuid, uuid), public.admin_shopify_abandoned(text, text, int, int),
  public.admin_update_shopify_abandoned(uuid, text, text), public.admin_bulk_shopify_abandoned(uuid[], text), public.abandoned_counts() from anon;
