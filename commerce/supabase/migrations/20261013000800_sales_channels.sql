-- =============================================================================
-- Sales channels: Shopify and WooCommerce stores send their orders here.
--   * sales_channels           one row per connected store (tokens in Vault)
--   * sales_channel_variants   their product variants ↔ ours
--   * channel_order_imports    every order received, imported or not, with the
--                              reason when it could not be imported (staff can
--                              fix the phone / district and import it again)
--   * channel_webhook_deliveries  delivery ids already handled (duplicates are
--                              acknowledged and ignored)
-- An order is imported once: the import row and a unique index on
-- orders(sales_channel_id, external_order_id) both guarantee it. Imports run
-- through _create_order, so customers, stock, totals and the order log behave
-- exactly as for any other order; prices come from the store that sold them.
-- =============================================================================

create table if not exists public.sales_channels (
  id uuid primary key default gen_random_uuid(),
  platform text not null check (platform in ('SHOPIFY', 'WOOCOMMERCE')),
  name text not null check (length(trim(name)) between 1 and 120),
  shop_domain text not null check (length(shop_domain) between 4 and 255),
  status text not null default 'PENDING' check (status in ('PENDING', 'CONNECTED', 'ERROR', 'DISCONNECTED')),
  auth_mode text check (auth_mode in ('OAUTH', 'TOKEN', 'KEYS')),
  scopes text[] not null default '{}',
  currency text,
  settings jsonb not null default '{"import_orders": true}'::jsonb check (jsonb_typeof(settings) = 'object'),
  webhooks jsonb not null default '[]'::jsonb,
  last_test jsonb,
  last_tested_at timestamptz,
  last_sync_at timestamptz,
  last_order_at timestamptz,
  last_error text,
  orders_imported int not null default 0,
  created_by uuid references public.profiles(id),
  connected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists sales_channels_domain_uq on public.sales_channels(platform, lower(shop_domain));
create trigger sales_channels_updated_at before update on public.sales_channels
  for each row execute function public.set_updated_at();

create table if not exists public.sales_channel_variants (
  channel_id uuid not null references public.sales_channels(id),
  external_variant_id text not null,
  external_product_id text,
  variant_id uuid not null references public.product_variants(id),
  created_at timestamptz not null default now(),
  primary key (channel_id, external_variant_id)
);

create table if not exists public.channel_order_imports (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.sales_channels(id),
  external_id text not null,
  external_number text,
  status text not null check (status in ('IMPORTED', 'FAILED', 'SKIPPED')),
  order_id uuid references public.orders(id),
  payload jsonb not null,
  overrides jsonb not null default '{}'::jsonb,
  error text,
  warnings text[] not null default '{}',
  attempts int not null default 1,
  received_via text not null default 'WEBHOOK' check (received_via in ('WEBHOOK', 'SYNC', 'RETRY')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel_id, external_id)
);
create index if not exists channel_order_imports_status_idx on public.channel_order_imports(status, created_at desc);
create trigger channel_order_imports_updated_at before update on public.channel_order_imports
  for each row execute function public.set_updated_at();

create table if not exists public.channel_webhook_deliveries (
  channel_id uuid not null references public.sales_channels(id),
  delivery_id text not null,
  topic text,
  received_at timestamptz not null default now(),
  primary key (channel_id, delivery_id)
);

create table if not exists public.channel_oauth_states (
  state text primary key,
  channel_id uuid not null references public.sales_channels(id),
  created_by uuid,
  return_to text not null,
  expires_at timestamptz not null,
  used_at timestamptz
);

alter table public.orders add column if not exists sales_channel_id uuid references public.sales_channels(id);
alter table public.orders add column if not exists external_order_id text;
alter table public.orders add column if not exists external_order_number text;
create unique index if not exists orders_channel_external_uq on public.orders(sales_channel_id, external_order_id)
  where sales_channel_id is not null;

alter table public.sales_channels enable row level security;
alter table public.sales_channel_variants enable row level security;
alter table public.channel_order_imports enable row level security;
alter table public.channel_webhook_deliveries enable row level security;
alter table public.channel_oauth_states enable row level security;
-- No policies: staff read through the functions below; the edge function writes.
revoke all on public.sales_channels, public.sales_channel_variants, public.channel_order_imports,
  public.channel_webhook_deliveries, public.channel_oauth_states from anon, authenticated;
grant all on public.sales_channels, public.sales_channel_variants, public.channel_order_imports,
  public.channel_webhook_deliveries, public.channel_oauth_states to service_role;

-- -----------------------------------------------------------------------------
-- District from free text (city, state, address). Common old spellings count.
-- -----------------------------------------------------------------------------
create or replace function public._bd_district(p_hints text[])
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_hint text;
  v_text text;
  v_name text;
  v_aliases jsonb := jsonb_build_object(
    'chittagong', 'Chattogram', 'ctg', 'Chattogram', 'comilla', 'Cumilla', 'barisal', 'Barishal', 'bogra', 'Bogura',
    'jessore', 'Jashore', 'jhalakati', 'Jhalokathi', 'jhalokati', 'Jhalokathi', 'khagrachari', 'Khagrachhari',
    'netrakona', 'Netrokona', 'maulvibazar', 'Moulvibazar', 'chapai nawabganj', 'Chapainawabganj', 'nawabganj', 'Chapainawabganj',
    'coxs bazar', 'Cox''s Bazar', 'cox bazar', 'Cox''s Bazar', 'brahmanbaria', 'Brahmanbaria', 'b baria', 'Brahmanbaria',
    'laxmipur', 'Lakshmipur', 'narsinghdi', 'Narsingdi', 'jaipurhat', 'Joypurhat', 'munshigonj', 'Munshiganj',
    'narayangonj', 'Narayanganj', 'kishorgonj', 'Kishoreganj', 'gopalgonj', 'Gopalganj', 'manikgonj', 'Manikganj',
    'sirajgonj', 'Sirajganj', 'habigonj', 'Habiganj', 'sunamgonj', 'Sunamganj', 'dacca', 'Dhaka', 'savar', 'Dhaka',
    'mirpur', 'Dhaka', 'uttara', 'Dhaka', 'dhanmondi', 'Dhaka', 'gulshan', 'Dhaka', 'mohammadpur', 'Dhaka', 'tongi', 'Gazipur');
  v_districts jsonb := coalesce(public.get_setting('delivery') -> 'districts', '[]'::jsonb);
  v_key text;
begin
  foreach v_hint in array coalesce(p_hints, '{}') loop
    v_text := lower(regexp_replace(replace(replace(coalesce(v_hint, ''), '''', ''), '’', ''), '[^A-Za-z ]+', ' ', 'g'));
    v_text := regexp_replace(v_text, '\m(district|division|zila|zilla|sadar|city|bd|bangladesh)\M', ' ', 'g');
    v_text := trim(regexp_replace(v_text, '\s+', ' ', 'g'));
    continue when v_text = '';
    -- Exact name first, then a district named inside the text, then old spellings.
    select d into v_name from jsonb_array_elements_text(v_districts) d
    where lower(regexp_replace(d, '[^A-Za-z ]+', '', 'g')) = v_text limit 1;
    if v_name is not null then return v_name; end if;
    select d into v_name from jsonb_array_elements_text(v_districts) d
    where v_text ~ ('\m' || lower(regexp_replace(d, '[^A-Za-z ]+', '', 'g')) || '\M')
    order by length(d) desc limit 1;
    if v_name is not null then return v_name; end if;
    for v_key in select k from jsonb_object_keys(v_aliases) k order by length(k) desc loop
      if v_text ~ ('\m' || v_key || '\M') then
        return v_aliases ->> v_key;
      end if;
    end loop;
  end loop;
  return null;
end;
$$;

-- -----------------------------------------------------------------------------
-- Connection bookkeeping (edge function, service role)
-- -----------------------------------------------------------------------------
create or replace function public.channel_upsert(p jsonb, p_actor uuid)
returns public.sales_channels
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.sales_channels;
  v_platform text := upper(p ->> 'platform');
  v_domain text := lower(trim(p ->> 'shop_domain'));
begin
  perform public._require_system();
  if v_platform not in ('SHOPIFY', 'WOOCOMMERCE') then
    raise exception 'VALIDATION: unknown platform' using errcode = '22023';
  end if;
  insert into public.sales_channels(platform, name, shop_domain, auth_mode, created_by)
  values (v_platform, coalesce(nullif(trim(p ->> 'name'), ''), v_domain), v_domain, p ->> 'auth_mode', p_actor)
  on conflict (platform, lower(shop_domain)) do update
    set auth_mode = coalesce(excluded.auth_mode, sales_channels.auth_mode),
        status = case when sales_channels.status = 'DISCONNECTED' then 'PENDING' else sales_channels.status end
  returning * into v_row;
  return v_row;
end;
$$;

-- p: any of name, status, scopes, currency, webhooks, last_test, last_error, connected (bool)
create or replace function public.channel_update(p_id uuid, p jsonb, p_actor uuid default null)
returns public.sales_channels
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old public.sales_channels;
  v_row public.sales_channels;
begin
  perform public._require_system();
  select * into v_old from public.sales_channels where id = p_id for update;
  if not found then
    raise exception 'NOT_FOUND: sales channel not found' using errcode = 'P0002';
  end if;
  update public.sales_channels set
    name = coalesce(nullif(trim(p ->> 'name'), ''), name),
    status = coalesce(p ->> 'status', status),
    scopes = coalesce((select array_agg(x) from jsonb_array_elements_text(p -> 'scopes') x), scopes),
    currency = coalesce(p ->> 'currency', currency),
    webhooks = coalesce(p -> 'webhooks', webhooks),
    last_test = coalesce(p -> 'last_test', last_test),
    last_tested_at = case when p ? 'last_test' then now() else last_tested_at end,
    last_error = case when p ? 'last_error' then nullif(p ->> 'last_error', '') else last_error end,
    last_sync_at = case when (p ->> 'synced')::boolean then now() else last_sync_at end,
    connected_at = case when (p ->> 'status') = 'CONNECTED' and v_old.status <> 'CONNECTED' then now() else connected_at end
  where id = p_id returning * into v_row;
  if (p ->> 'status') is distinct from v_old.status and p ? 'status' then
    insert into public.audit_logs(actor_id, actor_email, action, entity_type, entity_id, old_values, new_values)
    values (p_actor, (select email from public.profiles where id = p_actor), 'channel.' || lower(v_row.status), 'sales_channel',
            p_id::text, jsonb_build_object('status', v_old.status), jsonb_build_object('status', v_row.status, 'error', v_row.last_error));
  end if;
  return v_row;
end;
$$;

create or replace function public.channel_get(p_id uuid)
returns public.sales_channels
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.sales_channels;
begin
  perform public._require_system();
  select * into v_row from public.sales_channels where id = p_id;
  return v_row;
end;
$$;

create or replace function public.channel_oauth_state_create(p_channel_id uuid, p_state text, p_actor uuid, p_return_to text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._require_system();
  if p_return_to !~ '^https?://[^/]+/admin(/|$|\?)' then
    raise exception 'VALIDATION: invalid return address' using errcode = '22023';
  end if;
  insert into public.channel_oauth_states(state, channel_id, created_by, return_to, expires_at)
  values (p_state, p_channel_id, p_actor, p_return_to, now() + interval '20 minutes');
end;
$$;

-- Takes a state once: unknown, used or expired → null.
create or replace function public.channel_oauth_state_take(p_state text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.channel_oauth_states;
begin
  perform public._require_system();
  update public.channel_oauth_states set used_at = now()
  where state = p_state and used_at is null and expires_at > now()
  returning * into v_row;
  if not found then
    return null;
  end if;
  return jsonb_build_object('channel_id', v_row.channel_id, 'created_by', v_row.created_by, 'return_to', v_row.return_to);
end;
$$;

-- Was this delivery already handled? (It is recorded only after it succeeds,
-- so a delivery that failed half-way is processed again when the store retries.)
create or replace function public.channel_delivery_seen(p_channel_id uuid, p_delivery_id text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._require_system();
  return exists (select 1 from public.channel_webhook_deliveries where channel_id = p_channel_id and delivery_id = left(p_delivery_id, 200));
end;
$$;

-- True the first time a delivery id is seen; false for a repeat.
create or replace function public.channel_delivery_first(p_channel_id uuid, p_delivery_id text, p_topic text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_new boolean;
begin
  perform public._require_system();
  if nullif(trim(coalesce(p_delivery_id, '')), '') is null then
    return true;
  end if;
  insert into public.channel_webhook_deliveries(channel_id, delivery_id, topic)
  values (p_channel_id, left(p_delivery_id, 200), left(p_topic, 80))
  on conflict do nothing;
  get diagnostics v_new = row_count;
  return v_new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Products: their variant → ours (linked, matched by SKU, or created as a
-- draft product that tracks no stock, since the store keeps the stock).
-- -----------------------------------------------------------------------------
create or replace function public._channel_variant(p_channel public.sales_channels, p_line jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ext text := coalesce(nullif(p_line ->> 'external_variant_id', ''), 'custom:' || md5(lower(coalesce(p_line ->> 'title', ''))));
  v_sku text := nullif(trim(coalesce(p_line ->> 'sku', '')), '');
  v_title text := coalesce(nullif(trim(p_line ->> 'title'), ''), 'Item');
  v_variant uuid;
  v_product uuid;
  v_price numeric := greatest(coalesce(nullif(p_line ->> 'unit_price', '')::numeric, 0), 0);
  v_prefix text := case p_channel.platform when 'SHOPIFY' then 'SHOP' else 'WOO' end;
begin
  select variant_id into v_variant from public.sales_channel_variants where channel_id = p_channel.id and external_variant_id = v_ext;
  if v_variant is not null and exists (select 1 from public.product_variants where id = v_variant) then
    return v_variant;
  end if;
  if v_sku is not null then
    select id into v_variant from public.product_variants where lower(sku) = lower(v_sku) order by is_active desc limit 1;
  end if;
  if v_variant is null then
    v_sku := coalesce(v_sku, v_prefix || '-' || left(regexp_replace(v_ext, '[^A-Za-z0-9]+', '', 'g'), 40));
    select id into v_variant from public.product_variants where lower(sku) = lower(v_sku) limit 1;
  end if;
  if v_variant is null then
    insert into public.products(name, slug, status, price, track_inventory, tags, created_by)
    values (left(v_title, 200), left(public.slugify(v_title), 60) || '-' || left(md5(p_channel.id::text || v_ext), 8), 'DRAFT',
            public.money(v_price), false, array[lower(p_channel.platform)], null)
    returning id into v_product;
    insert into public.product_variants(product_id, sku, title, price, is_default)
    values (v_product, v_sku, coalesce(nullif(trim(p_line ->> 'variant_title'), ''), 'Default'), public.money(v_price), true)
    returning id into v_variant;
    if nullif(p_line ->> 'image_url', '') is not null and (p_line ->> 'image_url') ~ '^https://' then
      insert into public.product_images(product_id, url, is_primary, position) values (v_product, p_line ->> 'image_url', true, 0);
    end if;
  end if;
  insert into public.sales_channel_variants(channel_id, external_variant_id, external_product_id, variant_id)
  values (p_channel.id, v_ext, nullif(p_line ->> 'external_product_id', ''), v_variant)
  on conflict (channel_id, external_variant_id) do update set variant_id = excluded.variant_id;
  return v_variant;
end;
$$;

-- -----------------------------------------------------------------------------
-- Import one order. p_order is the normalized order from the edge function:
--   { external_id, number, created_at, cancelled, test,
--     customer: { name, phone, email },
--     shipping: { address, area, city, state, postal_code, district_hint },
--     lines: [{ external_variant_id, external_product_id, sku, title, variant_title, quantity, unit_price, image_url }],
--     subtotal, shipping_price, discount_total, total, paid_amount, currency, gateway, note,
--     attribution: { first_touch, last_touch } }
-- Staff fixes saved on the import (phone, name, address, district) win.
-- Returns { status: IMPORTED | DUPLICATE | FAILED | SKIPPED, order_id, order_number, import_id, error }.
-- -----------------------------------------------------------------------------
create or replace function public.channel_ingest_order(p_channel_id uuid, p_order jsonb, p_via text default 'WEBHOOK')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_channel public.sales_channels;
  v_ext text := nullif(trim(coalesce(p_order ->> 'external_id', '')), '');
  v_import public.channel_order_imports;
  v_fix jsonb;
  v_o jsonb;
  v_items jsonb := '[]'::jsonb;
  v_line jsonb;
  v_district text;
  v_subtotal numeric := 0;
  v_shipping numeric;
  v_total numeric;
  v_paid numeric;
  v_discount numeric;
  v_warnings text[] := '{}';
  v_order public.orders;
  v_platform_name text;
  v_error text;
begin
  perform public._require_system();
  select * into v_channel from public.sales_channels where id = p_channel_id;
  if not found then
    raise exception 'NOT_FOUND: sales channel not found' using errcode = 'P0002';
  end if;
  if v_ext is null then
    raise exception 'VALIDATION: the order has no id' using errcode = '22023';
  end if;
  v_platform_name := case v_channel.platform when 'SHOPIFY' then 'Shopify' else 'WooCommerce' end;
  -- One import at a time per order, so a webhook and a sync never both create it.
  perform pg_advisory_xact_lock(hashtextextended('channel-order:' || p_channel_id || ':' || v_ext, 0));

  select * into v_import from public.channel_order_imports where channel_id = p_channel_id and external_id = v_ext for update;
  if found and v_import.status = 'IMPORTED' then
    return jsonb_build_object('status', 'DUPLICATE', 'import_id', v_import.id, 'order_id', v_import.order_id,
      'order_number', (select order_number from public.orders where id = v_import.order_id));
  end if;
  if not found then
    insert into public.channel_order_imports(channel_id, external_id, external_number, status, payload, received_via)
    values (p_channel_id, v_ext, p_order ->> 'number', 'FAILED', p_order, upper(coalesce(p_via, 'WEBHOOK')))
    returning * into v_import;
  else
    update public.channel_order_imports set payload = p_order, external_number = coalesce(p_order ->> 'number', external_number),
      attempts = attempts + 1, received_via = upper(coalesce(p_via, received_via))
    where id = v_import.id returning * into v_import;
  end if;

  if coalesce((p_order ->> 'cancelled')::boolean, false) then
    update public.channel_order_imports set status = 'SKIPPED', error = 'Cancelled in ' || v_platform_name || ' before it was imported'
    where id = v_import.id;
    return jsonb_build_object('status', 'SKIPPED', 'import_id', v_import.id, 'error', 'cancelled');
  end if;
  if not coalesce((v_channel.settings ->> 'import_orders')::boolean, true) and upper(coalesce(p_via, '')) <> 'RETRY' then
    update public.channel_order_imports set status = 'SKIPPED', error = 'Order import is switched off for this store' where id = v_import.id;
    return jsonb_build_object('status', 'SKIPPED', 'import_id', v_import.id, 'error', 'import off');
  end if;

  v_fix := coalesce(v_import.overrides, '{}'::jsonb);
  v_o := p_order;
  begin
    -- Lines → our variants.
    if jsonb_typeof(v_o -> 'lines') <> 'array' or jsonb_array_length(v_o -> 'lines') = 0 then
      raise exception 'VALIDATION: the order has no products' using errcode = '22023';
    end if;
    for v_line in select * from jsonb_array_elements(v_o -> 'lines') loop
      continue when coalesce((v_line ->> 'quantity')::int, 0) <= 0;
      v_items := v_items || jsonb_build_object(
        'variant_id', public._channel_variant(v_channel, v_line),
        'quantity', (v_line ->> 'quantity')::int,
        'unit_price', public.money(greatest(coalesce(nullif(v_line ->> 'unit_price', '')::numeric, 0), 0)));
      v_subtotal := v_subtotal + public.money(greatest(coalesce(nullif(v_line ->> 'unit_price', '')::numeric, 0), 0)) * (v_line ->> 'quantity')::int;
    end loop;
    if jsonb_array_length(v_items) = 0 then
      raise exception 'VALIDATION: the order has no products to ship' using errcode = '22023';
    end if;

    v_district := coalesce(nullif(v_fix ->> 'district', ''),
      public._bd_district(array[v_o #>> '{shipping,district_hint}', v_o #>> '{shipping,city}', v_o #>> '{shipping,state}',
                                v_o #>> '{shipping,area}', v_o #>> '{shipping,address}']));
    if v_district is null then
      raise exception 'DISTRICT_UNKNOWN: could not tell the district from "%". Choose it and import again',
        concat_ws(', ', nullif(v_o #>> '{shipping,city}', ''), nullif(v_o #>> '{shipping,state}', '')) using errcode = '22023';
    end if;

    v_shipping := greatest(coalesce(nullif(v_o ->> 'shipping_price', '')::numeric, 0), 0);
    v_total := coalesce(nullif(v_o ->> 'total', '')::numeric, v_subtotal + v_shipping);
    -- Their total = products + delivery − discounts (+ taxes/fees, which we flag).
    v_discount := greatest(v_subtotal + v_shipping - v_total, 0);
    if v_discount > v_subtotal then
      v_shipping := greatest(v_shipping - (v_discount - v_subtotal), 0);
      v_discount := v_subtotal;
    end if;
    if v_total > v_subtotal + v_shipping + 0.009 then
      v_warnings := v_warnings || format('%s total %s is higher than products + delivery (%s): taxes or fees were not imported',
                                         v_platform_name, v_total, v_subtotal + v_shipping);
    end if;
    v_paid := least(greatest(coalesce(nullif(v_o ->> 'paid_amount', '')::numeric, 0), 0), v_total);

    v_order := public._create_order(jsonb_build_object(
      'customer', jsonb_build_object(
        'full_name', coalesce(nullif(trim(v_fix ->> 'name'), ''), nullif(trim(v_o #>> '{customer,name}'), ''), 'Customer'),
        'phone', coalesce(nullif(v_fix ->> 'phone', ''), v_o #>> '{customer,phone}'),
        'email', nullif(v_o #>> '{customer,email}', '')),
      'shipping', jsonb_build_object(
        'address', coalesce(nullif(trim(v_fix ->> 'address'), ''), nullif(trim(v_o #>> '{shipping,address}'), ''), ''),
        'district', v_district,
        'area', nullif(v_o #>> '{shipping,area}', ''),
        'city', nullif(v_o #>> '{shipping,city}', ''),
        'postal_code', nullif(v_o #>> '{shipping,postal_code}', '')),
      'items', v_items,
      'delivery_charge', v_shipping,
      'manual_discount', v_discount,
      'payment_method', case when v_paid >= v_total and v_total > 0 then 'FULL_PAYMENT' when v_paid > 0 then 'ADVANCE' else 'COD' end,
      'customer_note', nullif(trim(coalesce(v_o ->> 'note', '')), ''),
      'idempotency_key', 'channel:' || p_channel_id || ':' || v_ext,
      'utm', jsonb_build_object('source', v_o #>> '{attribution,last_touch,params,utm_source}',
                                'medium', v_o #>> '{attribution,last_touch,params,utm_medium}',
                                'campaign', v_o #>> '{attribution,last_touch,params,utm_campaign}'),
      'internal_note', format('Imported from %s %s (%s)', v_platform_name, coalesce(v_o ->> 'number', v_ext), v_channel.name)
        || coalesce(E'\n' || array_to_string(v_warnings, E'\n'), '')
    ), 'API');

    update public.orders set sales_channel_id = p_channel_id, external_order_id = v_ext, external_order_number = v_o ->> 'number'
    where id = v_order.id;

    -- Paid in the store (from its API, never from a browser).
    if v_paid > 0 then
      perform public.record_order_payment(v_order.id, case when v_paid >= v_order.total_amount then 'FULL' else 'ADVANCE' end::public.order_payment_kind,
        'GATEWAY', least(v_paid, v_order.total_amount), coalesce(v_o ->> 'number', v_ext),
        format('Paid in %s%s', v_platform_name, coalesce(' via ' || nullif(v_o ->> 'gateway', ''), '')),
        'channel-pay:' || p_channel_id || ':' || v_ext);
    end if;
  exception when others then
    v_error := regexp_replace(sqlerrm, '^[A-Z_]+: ', '');
    update public.channel_order_imports set status = 'FAILED', error = left(v_error, 500), order_id = null
    where id = v_import.id;
    update public.sales_channels set last_order_at = now() where id = p_channel_id;
    return jsonb_build_object('status', 'FAILED', 'import_id', v_import.id, 'error', v_error);
  end;

  -- Where the sale came from, if the store passed it on (never guessed).
  if jsonb_typeof(v_o -> 'attribution') = 'object' then
    begin
      perform public.record_order_attribution(v_order.id, v_o -> 'attribution');
    exception when others then
      v_warnings := v_warnings || ('Source not recorded: ' || sqlerrm);
    end;
  end if;

  update public.channel_order_imports set status = 'IMPORTED', order_id = v_order.id, error = null, warnings = v_warnings
  where id = v_import.id;
  update public.sales_channels set orders_imported = orders_imported + 1, last_order_at = now() where id = p_channel_id;
  return jsonb_build_object('status', 'IMPORTED', 'import_id', v_import.id, 'order_id', v_order.id, 'order_number', v_order.order_number,
    'phone', v_order.customer_phone, 'total', v_order.total_amount, 'warnings', to_jsonb(v_warnings));
end;
$$;

-- The store cancelled an order: cancel ours while it is still waiting to be
-- confirmed; otherwise leave a note for staff (it may already be packed).
create or replace function public.channel_order_cancelled(p_channel_id uuid, p_external_id text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_channel public.sales_channels;
  v_order public.orders;
  v_name text;
begin
  perform public._require_system();
  select * into v_channel from public.sales_channels where id = p_channel_id;
  v_name := case v_channel.platform when 'SHOPIFY' then 'Shopify' else 'WooCommerce' end;
  select * into v_order from public.orders where sales_channel_id = p_channel_id and external_order_id = p_external_id;
  if not found then
    update public.channel_order_imports set status = 'SKIPPED', error = 'Cancelled in ' || v_name
    where channel_id = p_channel_id and external_id = p_external_id and status = 'FAILED';
    return jsonb_build_object('status', 'NO_ORDER');
  end if;
  if v_order.status in ('CANCELLED', 'REJECTED_FRAUD') then
    return jsonb_build_object('status', 'ALREADY', 'order_id', v_order.id);
  end if;
  if v_order.status in ('PENDING', 'FRAUD_CHECK', 'FRAUD_REVIEW', 'ADVANCE_REQUIRED', 'CONFIRMATION_REQUIRED') then
    begin
      perform public.transition_order_status(v_order.id, 'CANCELLED', 'Cancelled in ' || v_name || coalesce(': ' || nullif(p_reason, ''), ''));
      return jsonb_build_object('status', 'CANCELLED', 'order_id', v_order.id);
    exception when others then
      null; -- fall through to the note
    end;
  end if;
  insert into public.order_notes(order_id, kind, visibility, body, created_by_name)
  values (v_order.id, 'SYSTEM', 'INTERNAL', format('Cancelled in %s%s — check before shipping. This order is already %s here.',
          v_name, coalesce(' (' || nullif(p_reason, '') || ')', ''), lower(replace(v_order.status::text, '_', ' '))), v_name);
  return jsonb_build_object('status', 'NOTED', 'order_id', v_order.id);
end;
$$;

-- Courier-history check run after an import, for the success rate on the lists.
create or replace function public.channel_attach_fraud_check(p_order_id uuid, p_check_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._require_system();
  update public.orders set fraud_check_id = p_check_id where id = p_order_id and fraud_check_id is null;
end;
$$;

-- Staff fixes for a failed import (the edge function imports it again).
create or replace function public.channel_import_for_retry(p_import_id uuid, p_overrides jsonb, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.channel_order_imports;
  v_clean jsonb := '{}'::jsonb;
begin
  perform public._require_system();
  select * into v_row from public.channel_order_imports where id = p_import_id for update;
  if not found then
    raise exception 'NOT_FOUND: import not found' using errcode = 'P0002';
  end if;
  if v_row.status = 'IMPORTED' then
    raise exception 'VALIDATION: this order is already imported' using errcode = '22023';
  end if;
  select coalesce(jsonb_object_agg(k, to_jsonb(left(trim(v), 300))), '{}'::jsonb) into v_clean
  from jsonb_each_text(coalesce(p_overrides, '{}'::jsonb)) as e(k, v)
  where k in ('phone', 'name', 'address', 'district') and nullif(trim(v), '') is not null;
  update public.channel_order_imports set overrides = overrides || v_clean where id = p_import_id returning * into v_row;
  insert into public.audit_logs(actor_id, actor_email, action, entity_type, entity_id, new_values)
  values (p_actor, (select email from public.profiles where id = p_actor), 'channel.import_retry', 'channel_order_import',
          p_import_id::text, v_clean);
  return jsonb_build_object('channel_id', v_row.channel_id, 'payload', v_row.payload);
end;
$$;

-- -----------------------------------------------------------------------------
-- Staff views (no secrets: tokens live in Vault)
-- -----------------------------------------------------------------------------
create or replace function public.sales_channels_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('settings.view');
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', c.id, 'platform', c.platform, 'name', c.name, 'shop_domain', c.shop_domain, 'status', c.status,
      'auth_mode', c.auth_mode, 'scopes', to_jsonb(c.scopes), 'currency', c.currency, 'settings', c.settings,
      'webhooks', c.webhooks, 'last_test', c.last_test, 'last_tested_at', c.last_tested_at, 'last_sync_at', c.last_sync_at,
      'last_order_at', c.last_order_at, 'last_error', c.last_error, 'orders_imported', c.orders_imported,
      'connected_at', c.connected_at, 'created_at', c.created_at,
      'failed', (select count(*) from public.channel_order_imports i where i.channel_id = c.id and i.status = 'FAILED'),
      'today', (select count(*) from public.channel_order_imports i where i.channel_id = c.id and i.status = 'IMPORTED'
                and i.updated_at >= date_trunc('day', now() at time zone public.store_timezone()) at time zone public.store_timezone()))
    order by c.status = 'DISCONNECTED', c.created_at) from public.sales_channels c), '[]'::jsonb);
end;
$$;

-- p: { channel_id?, status?, limit?, offset? }
create or replace function public.channel_imports_list(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_channel uuid := nullif(p ->> 'channel_id', '')::uuid;
  v_status text := nullif(upper(p ->> 'status'), '');
  v_limit int := least(greatest(coalesce((p ->> 'limit')::int, 20), 1), 100);
  v_offset int := greatest(coalesce((p ->> 'offset')::int, 0), 0);
begin
  perform public.require_permission('orders.view');
  return (
    with rows as (
      select i.* from public.channel_order_imports i
      where (v_channel is null or i.channel_id = v_channel) and (v_status is null or i.status = v_status)
    )
    select jsonb_build_object(
      'total', (select count(*) from rows),
      'items', coalesce((select jsonb_agg(jsonb_build_object(
          'id', r.id, 'channel_id', r.channel_id, 'channel', c.name, 'platform', c.platform,
          'external_id', r.external_id, 'external_number', r.external_number, 'status', r.status, 'error', r.error,
          'warnings', to_jsonb(r.warnings), 'attempts', r.attempts, 'received_via', r.received_via,
          'order_id', r.order_id, 'order_number', o.order_number,
          'customer', jsonb_build_object('name', coalesce(r.overrides ->> 'name', r.payload #>> '{customer,name}'),
                                         'phone', coalesce(r.overrides ->> 'phone', r.payload #>> '{customer,phone}')),
          'shipping', jsonb_build_object('address', coalesce(r.overrides ->> 'address', r.payload #>> '{shipping,address}'),
                                         'city', r.payload #>> '{shipping,city}', 'state', r.payload #>> '{shipping,state}',
                                         'district', r.overrides ->> 'district'),
          'total', r.payload ->> 'total', 'currency', r.payload ->> 'currency',
          'items', (select count(*) from jsonb_array_elements(case when jsonb_typeof(r.payload -> 'lines') = 'array' then r.payload -> 'lines' else '[]'::jsonb end)),
          'created_at', r.created_at, 'updated_at', r.updated_at) order by r.created_at desc)
        from (select * from rows order by created_at desc limit v_limit offset v_offset) r
        join public.sales_channels c on c.id = r.channel_id
        left join public.orders o on o.id = r.order_id), '[]'::jsonb)
    ));
end;
$$;

-- p: { name?, import_orders? }
create or replace function public.sales_channel_settings_save(p_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old public.sales_channels;
  v_row public.sales_channels;
begin
  perform public.require_permission('settings.manage');
  select * into v_old from public.sales_channels where id = p_id for update;
  if not found then
    raise exception 'NOT_FOUND: sales channel not found' using errcode = 'P0002';
  end if;
  update public.sales_channels set
    name = coalesce(nullif(left(trim(p ->> 'name'), 120), ''), name),
    settings = settings || case when p ? 'import_orders' then jsonb_build_object('import_orders', coalesce((p ->> 'import_orders')::boolean, true)) else '{}'::jsonb end
  where id = p_id returning * into v_row;
  perform public.log_audit('channel.settings', 'sales_channel', p_id::text,
    jsonb_build_object('name', v_old.name, 'settings', v_old.settings), jsonb_build_object('name', v_row.name, 'settings', v_row.settings));
  return jsonb_build_object('id', v_row.id, 'name', v_row.name, 'settings', v_row.settings);
end;
$$;

revoke all on function public._bd_district(text[]), public.channel_upsert(jsonb, uuid), public.channel_update(uuid, jsonb, uuid),
  public.channel_get(uuid), public.channel_oauth_state_create(uuid, text, uuid, text), public.channel_oauth_state_take(text),
  public.channel_delivery_first(uuid, text, text), public.channel_delivery_seen(uuid, text), public._channel_variant(public.sales_channels, jsonb),
  public.channel_ingest_order(uuid, jsonb, text), public.channel_order_cancelled(uuid, text, text),
  public.channel_attach_fraud_check(uuid, uuid), public.channel_import_for_retry(uuid, jsonb, uuid),
  public.sales_channels_list(), public.channel_imports_list(jsonb), public.sales_channel_settings_save(uuid, jsonb)
from public, anon, authenticated;
grant execute on function public.channel_upsert(jsonb, uuid), public.channel_update(uuid, jsonb, uuid), public.channel_get(uuid),
  public.channel_oauth_state_create(uuid, text, uuid, text), public.channel_oauth_state_take(text),
  public.channel_delivery_first(uuid, text, text), public.channel_delivery_seen(uuid, text), public.channel_ingest_order(uuid, jsonb, text),
  public.channel_order_cancelled(uuid, text, text), public.channel_attach_fraud_check(uuid, uuid),
  public.channel_import_for_retry(uuid, jsonb, uuid)
to service_role;
grant execute on function public.sales_channels_list(), public.channel_imports_list(jsonb), public.sales_channel_settings_save(uuid, jsonb)
to authenticated;
