-- =============================================================================
-- 1. Website API keys: a custom-coded shop (any framework) reads the catalog,
--    prices a cart and places orders through the same server-side checkout as
--    the hosted store (prices, stock, fraud check, block list, merge rules).
--    Keys are stored as SHA-256 hashes; the full key is shown once.
--      PUBLISHABLE  for browser code, only from the listed origins
--      SECRET       for the shop's own server, never from a browser
--    Orders placed with a key are accepted even when the hosted store is
--    switched off (the key is the shop's front door), and are tagged with the
--    key's site name.
-- 2. Custom domains: the client's own domain for the hosted store. The edge
--    function attaches it to the Vercel project; this table records what
--    Vercel reported (DNS records to add, verified or not).
-- =============================================================================

create table if not exists public.site_api_keys (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 2 and 60),
  kind text not null check (kind in ('PUBLISHABLE', 'SECRET')),
  prefix text not null,
  key_hash text not null unique,
  allowed_origins text[] not null default '{}',
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  request_count bigint not null default 0,
  revoked_at timestamptz,
  revoked_by uuid references public.profiles(id)
);
alter table public.site_api_keys enable row level security;
revoke all on public.site_api_keys from anon, authenticated;
grant all on public.site_api_keys to service_role;

create table if not exists public.store_domains (
  id uuid primary key default gen_random_uuid(),
  domain text not null unique check (domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$'),
  status text not null default 'PENDING' check (status in ('PENDING', 'VERIFYING', 'ACTIVE', 'ERROR', 'MANUAL', 'REMOVED')),
  records jsonb not null default '[]'::jsonb,
  detail text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  checked_at timestamptz,
  updated_at timestamptz not null default now()
);
create or replace trigger store_domains_updated_at before update on public.store_domains
  for each row execute function public.set_updated_at();
alter table public.store_domains enable row level security;
revoke all on public.store_domains from anon, authenticated;
grant all on public.store_domains to service_role;

-- -----------------------------------------------------------------------------
-- Keys
-- -----------------------------------------------------------------------------
create or replace function public._origin_ok(p_origin text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$ select p_origin ~* '^https://[a-z0-9.-]+\.[a-z]{2,}(:[0-9]{2,5})?$' or p_origin ~* '^http://(localhost|127\.0\.0\.1)(:[0-9]{2,5})?$' $$;

create or replace function public.admin_site_key_create(p_name text, p_kind text, p_origins text[] default '{}')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind text := upper(coalesce(p_kind, ''));
  v_origins text[];
  v_key text;
  v_row public.site_api_keys;
begin
  perform public.require_permission('settings.manage');
  if v_kind not in ('PUBLISHABLE', 'SECRET') then
    raise exception 'VALIDATION: choose a browser (publishable) or server (secret) key' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct rtrim(lower(trim(o)), '/')), '{}') into v_origins
  from unnest(coalesce(p_origins, '{}')) o where trim(o) <> '';
  if exists (select 1 from unnest(v_origins) o where not public._origin_ok(o)) then
    raise exception 'VALIDATION: each website address must look like https://shop.com (no path)' using errcode = '22023';
  end if;
  if v_kind = 'PUBLISHABLE' and coalesce(array_length(v_origins, 1), 0) = 0 then
    raise exception 'VALIDATION: a browser key needs the website address it will be used from' using errcode = '22023';
  end if;
  v_key := case v_kind when 'SECRET' then 'sk_live_' else 'pk_live_' end || encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.site_api_keys(name, kind, prefix, key_hash, allowed_origins, created_by)
  values (trim(p_name), v_kind, left(v_key, 14), encode(extensions.digest(v_key, 'sha256'), 'hex'), v_origins, auth.uid())
  returning * into v_row;
  perform public.log_audit('site_api_key.create', 'site_api_key', v_row.id::text, null,
    jsonb_build_object('name', v_row.name, 'kind', v_row.kind, 'origins', to_jsonb(v_row.allowed_origins)));
  -- The only time the full key leaves the database.
  return jsonb_build_object('id', v_row.id, 'key', v_key, 'prefix', v_row.prefix, 'kind', v_row.kind);
end;
$$;

create or replace function public.admin_site_keys()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('settings.view');
  return coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'name', k.name, 'kind', k.kind, 'prefix', k.prefix,
      'allowed_origins', to_jsonb(k.allowed_origins), 'created_at', k.created_at, 'last_used_at', k.last_used_at,
      'request_count', k.request_count, 'revoked_at', k.revoked_at,
      'orders', (select count(*) from public.orders o where ('site:' || k.name) = any(o.tags)))
    order by k.revoked_at nulls first, k.created_at desc) from public.site_api_keys k), '[]'::jsonb);
end;
$$;

create or replace function public.admin_site_key_revoke(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('settings.manage');
  update public.site_api_keys set revoked_at = now(), revoked_by = auth.uid() where id = p_id and revoked_at is null;
  if not found then
    raise exception 'NOT_FOUND: key not found or already turned off' using errcode = 'P0002';
  end if;
  perform public.log_audit('site_api_key.revoke', 'site_api_key', p_id::text, null, null);
end;
$$;

-- Edge function: the active key with this hash (and count the request).
create or replace function public.site_api_key_check(p_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.site_api_keys;
begin
  perform public._require_system();
  update public.site_api_keys set last_used_at = now(), request_count = request_count + 1
  where key_hash = p_hash and revoked_at is null
  returning * into v_row;
  if not found then
    return null;
  end if;
  return jsonb_build_object('id', v_row.id, 'name', v_row.name, 'kind', v_row.kind, 'allowed_origins', to_jsonb(v_row.allowed_origins));
end;
$$;

-- The hosted-store guard lets an order through when it comes in with a key.
create or replace function public._orders_store_open_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.source = 'STOREFRONT' and public.storefront_mode() <> 'OWN'
     and coalesce(current_setting('app.site_api_key', true), '') = '' then
    raise exception 'ORDER_BLOCKED: The online store is closed. Orders are not being taken here right now.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- Edge function: place an order for a website (same checkout as the hosted store).
create or replace function public.site_api_place_order(p_key_id uuid, p_payload jsonb, p_fraud_check_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key public.site_api_keys;
  v_result jsonb;
begin
  perform public._require_system();
  select * into v_key from public.site_api_keys where id = p_key_id and revoked_at is null;
  if not found then
    raise exception 'PERMISSION_DENIED: this key has been turned off' using errcode = '42501';
  end if;
  perform set_config('app.site_api_key', v_key.id::text, true);
  v_result := public.place_storefront_order(p_payload, p_fraud_check_id);
  perform set_config('app.site_api_key', '', true);
  update public.orders set tags = (select array_agg(distinct t) from unnest(coalesce(tags, '{}') || array['site:' || v_key.name]) t)
  where id = (v_result ->> 'id')::uuid;
  if not coalesce((v_result ->> 'merged')::boolean, false) then
    perform public._order_log((v_result ->> 'id')::uuid, 'SITE_API', format('Placed from the website "%s" (API key %s…)', v_key.name, v_key.prefix),
      null, null, jsonb_build_object('site_key_id', v_key.id));
  end if;
  return v_result;
end;
$$;

-- -----------------------------------------------------------------------------
-- Domains (written by the domains edge function after asking Vercel)
-- -----------------------------------------------------------------------------
create or replace function public.store_domain_save(p_domain text, p jsonb, p_actor uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.store_domains;
begin
  perform public._require_system();
  insert into public.store_domains(domain, status, records, detail, created_by, checked_at)
  values (lower(p_domain), coalesce(p ->> 'status', 'PENDING'), coalesce(p -> 'records', '[]'::jsonb), p ->> 'detail', p_actor, now())
  on conflict (domain) do update set
    status = coalesce(p ->> 'status', store_domains.status), records = coalesce(p -> 'records', store_domains.records),
    detail = case when p ? 'detail' then p ->> 'detail' else store_domains.detail end, checked_at = now()
  returning * into v_row;
  if p_actor is not null then
    perform public.log_audit('store_domain.' || lower(v_row.status), 'store_domain', v_row.id::text, null,
      jsonb_build_object('domain', v_row.domain, 'status', v_row.status));
  end if;
  return to_jsonb(v_row);
end;
$$;

create or replace function public.store_domains_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    perform public.require_permission('settings.view');
  end if;
  return coalesce((select jsonb_agg(to_jsonb(d) order by d.created_at) from public.store_domains d where d.status <> 'REMOVED'), '[]'::jsonb);
end;
$$;

revoke all on function public._origin_ok(text), public.admin_site_key_create(text, text, text[]), public.admin_site_keys(),
  public.admin_site_key_revoke(uuid), public.site_api_key_check(text), public._orders_store_open_guard(),
  public.site_api_place_order(uuid, jsonb, uuid), public.store_domain_save(text, jsonb, uuid), public.store_domains_list()
from public, anon, authenticated;
grant execute on function public.admin_site_key_create(text, text, text[]), public.admin_site_keys(), public.admin_site_key_revoke(uuid),
  public.store_domains_list() to authenticated;
grant execute on function public.site_api_key_check(text), public.site_api_place_order(uuid, jsonb, uuid),
  public.store_domain_save(text, jsonb, uuid), public.store_domains_list() to service_role;
