-- external-api part 1 of 5: run the parts in order
insert into public.features (code, name, description, category, is_core, globally_enabled, release_stage, sort_order)
values ('external_api', 'External API', 'Connect your own systems to orders, products, stock and customers', 'store', false, true, 'GA', 14)
on conflict (code) do nothing;
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
