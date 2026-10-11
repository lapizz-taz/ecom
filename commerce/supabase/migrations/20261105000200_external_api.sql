-- =============================================================================
-- External API: a business connects its own systems (ERP, accounting, a
-- warehouse app, Zapier/Make, scripts) to its orders, products, stock and
-- customers over REST.
--
--   * Keys are created by staff with settings.manage, shown once, stored only
--     as SHA-256 hashes, and carry scopes: orders:read, orders:write,
--     products:read, inventory:read, inventory:write, customers:read.
--   * Every API function checks the key and its scope here in the database
--     (not only in the edge function), then runs the same rules as the admin
--     (order status path, stock adjustments with a reason).
--   * Each request is logged (method, path, status, time) for the Logs tab.
--   * Gated by the plan feature "external_api".
-- =============================================================================

insert into public.features (code, name, description, category, is_core, globally_enabled, release_stage, sort_order)
values ('external_api', 'External API', 'Connect your own systems to orders, products, stock and customers', 'store', false, true, 'GA', 14)
on conflict (code) do nothing;
-- Plans that include the Website API include the External API too.
update public.plans set features = features || jsonb_build_object('external_api', true)
where coalesce((features ->> 'website_api')::boolean, false) and not features ? 'external_api';

create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null default public.current_merchant_id() references public.merchants(id),
  name text not null check (length(trim(name)) between 2 and 60),
  prefix text not null,
  key_hash text not null unique,
  scopes text[] not null check (scopes <@ array['orders:read', 'orders:write', 'products:read', 'inventory:read', 'inventory:write', 'customers:read'] and cardinality(scopes) > 0),
  expires_at timestamptz,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  request_count bigint not null default 0,
  revoked_at timestamptz,
  revoked_by uuid references public.profiles(id)
);
create index if not exists api_keys_merchant_idx on public.api_keys (merchant_id);

create table if not exists public.api_request_logs (
  id bigint generated always as identity primary key,
  merchant_id uuid not null default public.current_merchant_id() references public.merchants(id),
  key_id uuid references public.api_keys(id),
  method text not null,
  path text not null,
  status int not null,
  duration_ms int,
  ip text,
  error_code text,
  created_at timestamptz not null default now()
);
create index if not exists api_request_logs_merchant_idx on public.api_request_logs (merchant_id, created_at desc);

do $$
declare t text;
begin
  foreach t in array array['api_keys', 'api_request_logs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format('create policy tenant_isolation on public.%I as restrictive using (merchant_id = (select public.current_merchant_id()))', t);
    execute format('drop policy if exists app_owner_all on public.%I', t);
    execute format('create policy app_owner_all on public.%I to app_owner using (true) with check (true)', t);
    execute format('grant all on public.%I to app_owner', t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- Staff: create, list, revoke keys; read the request log
-- -----------------------------------------------------------------------------
create or replace function public.admin_api_key_create(p_name text, p_scopes text[], p_expires_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_scopes text[];
  v_key text;
  v_row public.api_keys;
begin
  perform public.require_permission('settings.manage');
  perform public.require_feature('external_api');
  select coalesce(array_agg(distinct lower(trim(s)) order by lower(trim(s))), '{}') into v_scopes from unnest(coalesce(p_scopes, '{}')) s where trim(s) <> '';
  if cardinality(v_scopes) = 0 then
    raise exception 'VALIDATION: choose what this key may do' using errcode = '22023';
  end if;
  if not v_scopes <@ array['orders:read', 'orders:write', 'products:read', 'inventory:read', 'inventory:write', 'customers:read'] then
    raise exception 'VALIDATION: unknown permission in %', array_to_string(v_scopes, ', ') using errcode = '22023';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'VALIDATION: the expiry date must be in the future' using errcode = '22023';
  end if;
  v_key := 'ffl_live_' || encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.api_keys (name, prefix, key_hash, scopes, expires_at, created_by)
  values (trim(p_name), left(v_key, 15), encode(extensions.digest(v_key, 'sha256'), 'hex'), v_scopes, p_expires_at, auth.uid())
  returning * into v_row;
  perform public.log_audit('api_key.create', 'api_key', v_row.id::text, null,
    jsonb_build_object('name', v_row.name, 'scopes', to_jsonb(v_row.scopes), 'expires_at', v_row.expires_at));
  -- The only time the full key leaves the database.
  return jsonb_build_object('id', v_row.id, 'key', v_key, 'prefix', v_row.prefix, 'scopes', to_jsonb(v_row.scopes));
end;
$$;

create or replace function public.admin_api_keys()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('settings.view');
  return coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'name', k.name, 'prefix', k.prefix, 'scopes', to_jsonb(k.scopes),
      'expires_at', k.expires_at, 'created_at', k.created_at, 'last_used_at', k.last_used_at, 'request_count', k.request_count,
      'revoked_at', k.revoked_at, 'created_by', (select full_name from public.profiles p where p.id = k.created_by))
    order by k.revoked_at nulls first, k.created_at desc) from public.api_keys k), '[]'::jsonb);
end;
$$;

create or replace function public.admin_api_key_revoke(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('settings.manage');
  update public.api_keys set revoked_at = now(), revoked_by = auth.uid() where id = p_id and revoked_at is null;
  if not found then
    raise exception 'NOT_FOUND: key not found or already turned off' using errcode = 'P0002';
  end if;
  perform public.log_audit('api_key.revoke', 'api_key', p_id::text, null, null);
end;
$$;

create or replace function public.admin_api_logs(p_limit int default 100, p_key uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('settings.view');
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc) from (
    select l.id, l.key_id, k.name as key_name, l.method, l.path, l.status, l.duration_ms, l.error_code, l.created_at
    from public.api_request_logs l left join public.api_keys k on k.id = l.key_id
    where p_key is null or l.key_id = p_key
    order by l.created_at desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) x), '[]'::jsonb);
end;
$$;

-- -----------------------------------------------------------------------------
-- Edge function (service role): which business a key belongs to
-- -----------------------------------------------------------------------------
-- Exempt from tenancy (it is how the merchant is found); returns only the id.
create or replace function public.api_key_merchant(p_hash text)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select k.merchant_id from public.api_keys k join public.merchants m on m.id = k.merchant_id
  where k.key_hash = p_hash and k.revoked_at is null and (k.expires_at is null or k.expires_at > now()) and m.status <> 'CLOSED'
$$;

-- The key behind a request (counted), or null. Runs in the merchant's context.
create or replace function public.api_key_check(p_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.api_keys;
begin
  perform public._require_system();
  update public.api_keys set last_used_at = now(), request_count = request_count + 1
  where key_hash = p_hash and revoked_at is null and (expires_at is null or expires_at > now())
  returning * into v_row;
  if not found then
    return null;
  end if;
  return jsonb_build_object('id', v_row.id, 'name', v_row.name, 'scopes', to_jsonb(v_row.scopes),
    'feature', public.feature_enabled('external_api'));
end;
$$;

create or replace function public.api_request_log(p_key uuid, p_method text, p_path text, p_status int, p_duration_ms int, p_ip text, p_error text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._require_system();
  insert into public.api_request_logs (key_id, method, path, status, duration_ms, ip, error_code)
  values (p_key, left(p_method, 10), left(p_path, 300), p_status, p_duration_ms, left(p_ip, 64), left(p_error, 60));
end;
$$;

-- Every API function starts here: the key is live, belongs to this business and has the scope.
create or replace function public._api_require(p_key uuid, p_scope text)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._require_system();
  if not exists (select 1 from public.api_keys where id = p_key and revoked_at is null and (expires_at is null or expires_at > now())) then
    raise exception 'PERMISSION_DENIED: this API key is not valid or has been turned off' using errcode = '42501';
  end if;
  if not exists (select 1 from public.api_keys where id = p_key and p_scope = any(scopes)) then
    raise exception 'PERMISSION_DENIED: this API key does not have the % permission', p_scope using errcode = '42501';
  end if;
  perform public.require_feature('external_api');
end;
$$;

-- -----------------------------------------------------------------------------
-- API reads and writes
-- -----------------------------------------------------------------------------
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

create or replace function public.api_products(p_key uuid, p jsonb default '{}')
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit int := least(greatest(coalesce((p ->> 'limit')::int, 50), 1), 100);
  v_offset int := greatest(coalesce((p ->> 'offset')::int, 0), 0);
  v_search text := nullif(trim(coalesce(p ->> 'search', '')), '');
  v_rows jsonb;
  v_total bigint;
begin
  perform public._api_require(p_key, 'products:read');
  select count(*) into v_total from public.products pr where v_search is null or pr.name ilike '%' || v_search || '%' or pr.sku ilike v_search || '%';
  select coalesce(jsonb_agg(x.j order by x.updated_at desc), '[]'::jsonb) into v_rows from (
    select pr.updated_at, jsonb_build_object('id', pr.id, 'name', pr.name, 'slug', pr.slug, 'sku', pr.sku, 'status', pr.status, 'price', pr.price,
      'compare_at_price', pr.compare_at_price, 'brand', pr.brand, 'tags', to_jsonb(coalesce(pr.tags, '{}')), 'updated_at', pr.updated_at,
      'variants', coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'sku', v.sku, 'title', v.title, 'price', coalesce(v.price, pr.price), 'barcode', v.barcode,
          'active', v.is_active, 'available', i.available, 'on_hand', i.on_hand) order by v.position, v.created_at)
        from public.product_variants v left join public.inventory i on i.variant_id = v.id where v.product_id = pr.id), '[]'::jsonb)) j
    from public.products pr where v_search is null or pr.name ilike '%' || v_search || '%' or pr.sku ilike v_search || '%'
    order by pr.updated_at desc, pr.id limit v_limit offset v_offset) x;
  return jsonb_build_object('data', v_rows, 'total', v_total, 'limit', v_limit, 'offset', v_offset);
end;
$$;

create or replace function public.api_inventory(p_key uuid, p jsonb default '{}')
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit int := least(greatest(coalesce((p ->> 'limit')::int, 100), 1), 500);
  v_offset int := greatest(coalesce((p ->> 'offset')::int, 0), 0);
  v_sku text := nullif(trim(coalesce(p ->> 'sku', '')), '');
begin
  perform public._api_require(p_key, 'inventory:read');
  return jsonb_build_object('data', coalesce((select jsonb_agg(x.j order by x.sku) from (
      select v.sku, jsonb_build_object('sku', v.sku, 'variant_id', v.id, 'product', pr.name, 'variant', v.title,
        'on_hand', i.on_hand, 'reserved', i.reserved, 'available', i.available, 'damaged', i.damaged, 'updated_at', i.updated_at) j
      from public.product_variants v join public.products pr on pr.id = v.product_id join public.inventory i on i.variant_id = v.id
      where v_sku is null or v.sku = v_sku
      order by v.sku limit v_limit offset v_offset) x), '[]'::jsonb), 'limit', v_limit, 'offset', v_offset);
end;
$$;

-- Set or change stock by SKU; the same rules as a manual adjustment (reason required, no overselling).
create or replace function public.api_inventory_adjust(p_key uuid, p_sku text, p_mode text, p_quantity int, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_variant uuid;
  v_name text;
  v_inv public.inventory;
begin
  perform public._api_require(p_key, 'inventory:write');
  select id into v_variant from public.product_variants where sku = trim(coalesce(p_sku, ''));
  if v_variant is null then
    raise exception 'NOT_FOUND: no product with SKU %', p_sku using errcode = 'P0002';
  end if;
  if upper(coalesce(p_mode, '')) not in ('SET', 'ADD', 'REMOVE') then
    raise exception 'VALIDATION: mode must be set, add or remove' using errcode = '22023';
  end if;
  select name into v_name from public.api_keys where id = p_key;
  perform public.adjust_stock(v_variant, 'ADJUSTMENT', p_quantity,
    coalesce(nullif(trim(p_note), ''), 'API') || format(' (API key "%s")', v_name), upper(p_mode));
  select * into v_inv from public.inventory where variant_id = v_variant;
  return jsonb_build_object('sku', trim(p_sku), 'on_hand', v_inv.on_hand, 'reserved', v_inv.reserved, 'available', v_inv.available);
end;
$$;

create or replace function public.api_customers(p_key uuid, p jsonb default '{}')
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit int := least(greatest(coalesce((p ->> 'limit')::int, 50), 1), 100);
  v_offset int := greatest(coalesce((p ->> 'offset')::int, 0), 0);
  v_phone text := nullif(public.normalize_phone(nullif(trim(coalesce(p ->> 'phone', '')), '')), '');
begin
  perform public._api_require(p_key, 'customers:read');
  return jsonb_build_object('data', coalesce((select jsonb_agg(x.j order by x.last_order_at desc nulls last) from (
      select c.last_order_at, jsonb_build_object('id', c.id, 'name', c.full_name, 'phone', c.phone, 'email', c.email, 'district', c.district,
        'segment', c.segment, 'total_orders', c.total_orders, 'delivered_orders', c.delivered_orders, 'returned_orders', c.returned_orders,
        'total_spent', c.total_spent, 'first_order_at', c.first_order_at, 'last_order_at', c.last_order_at) j
      from public.customers c where v_phone is null or c.phone = v_phone
      order by c.last_order_at desc nulls last, c.id limit v_limit offset v_offset) x), '[]'::jsonb), 'limit', v_limit, 'offset', v_offset);
end;
$$;

revoke all on function public.admin_api_key_create(text, text[], timestamptz), public.admin_api_keys(), public.admin_api_key_revoke(uuid),
  public.admin_api_logs(int, uuid), public.api_key_merchant(text), public.api_key_check(text),
  public.api_request_log(uuid, text, text, int, int, text, text), public._api_require(uuid, text), public._api_order_json(public.orders, boolean),
  public.api_orders(uuid, jsonb), public.api_order(uuid, text), public.api_order_set_status(uuid, text, text, text), public.api_products(uuid, jsonb),
  public.api_inventory(uuid, jsonb), public.api_inventory_adjust(uuid, text, text, int, text), public.api_customers(uuid, jsonb)
from public, anon, authenticated;
grant execute on function public.admin_api_key_create(text, text[], timestamptz), public.admin_api_keys(), public.admin_api_key_revoke(uuid),
  public.admin_api_logs(int, uuid) to authenticated;
grant execute on function public.api_key_merchant(text), public.api_key_check(text), public.api_request_log(uuid, text, text, int, int, text, text),
  public.api_orders(uuid, jsonb), public.api_order(uuid, text), public.api_order_set_status(uuid, text, text, text), public.api_products(uuid, jsonb),
  public.api_inventory(uuid, jsonb), public.api_inventory_adjust(uuid, text, text, int, text), public.api_customers(uuid, jsonb)
to service_role;

insert into public.tenancy_exempt_functions (name, reason) values
  ('api_key_merchant', 'External API: finds which business a key belongs to (returns only the id; service role only)')
on conflict (name) do nothing;

select public._tenancy_own_functions();
