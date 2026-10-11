-- =============================================================================
-- Merchant context for edge functions and the storefront.
--
-- * merchant_for(kind, key): the merchant that owns something arriving from
--   outside (a webhook for a channel or courier, a payment return, a website
--   API key, an OAuth state, a VoiceDrive call). Edge functions call it with
--   the service role, then act inside that merchant. Keys that are not unique
--   across merchants answer null rather than guess.
-- * storefront_resolve(host): which merchant's store a browser is looking at
--   (a connected custom domain, else the platform's default store).
-- * platform_settings / platform credentials: configuration and secrets that
--   belong to the platform itself (not to any merchant), kept apart from
--   merchant integration credentials.
-- * platform_audit_logs: append-only record of platform-level actions.
-- * get_my_access() also says which merchant the staff member works for.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Platform settings and audit log
-- -----------------------------------------------------------------------------
create or replace function public._tenancy_global_tables()
returns text[]
language sql
immutable
as $$
  select array['permissions', 'order_status_transitions', 'pbx_packages', 'pbx_gateway_status',
               'merchants', 'platform_staff', 'support_sessions', 'tenancy_exempt_functions',
               'platform_settings', 'platform_audit_logs', 'platform_credentials']
$$;

create table public.platform_settings (
  key text primary key check (key ~ '^[a-z0-9_.]{2,60}$'),
  value jsonb not null default '{}'::jsonb,
  description text,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger platform_settings_updated_at before update on public.platform_settings
  for each row execute function public.set_updated_at();
alter table public.platform_settings enable row level security;
revoke all on public.platform_settings from anon, authenticated;

insert into public.platform_settings (key, value, description) values
  ('storefront', jsonb_build_object('default_merchant_id', '00000000-0000-4000-8000-000000000001'),
   'Store shown on the platform''s own address (custom domains choose their merchant themselves)');

create table public.platform_audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid,
  actor_email text,
  action text not null check (length(action) between 3 and 80),
  merchant_id uuid references public.merchants(id),
  entity_type text,
  entity_id text,
  reason text,
  before jsonb,
  after jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index platform_audit_logs_created_idx on public.platform_audit_logs (created_at desc);
create index platform_audit_logs_merchant_idx on public.platform_audit_logs (merchant_id, created_at desc) where merchant_id is not null;
create index platform_audit_logs_actor_idx on public.platform_audit_logs (actor_id, created_at desc);
create trigger platform_audit_logs_immutable before update or delete on public.platform_audit_logs
  for each row execute function public.prevent_mutation();
alter table public.platform_audit_logs enable row level security;
revoke all on public.platform_audit_logs from anon, authenticated;
revoke truncate on public.platform_audit_logs from public, service_role;

-- Records one platform action. Platform functions call it; it never fails silently.
create or replace function public._platform_audit(
  p_action text, p_merchant uuid, p_entity_type text, p_entity_id text,
  p_reason text default null, p_before jsonb default null, p_after jsonb default null, p_metadata jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id bigint;
begin
  insert into public.platform_audit_logs (actor_id, actor_email, action, merchant_id, entity_type, entity_id, reason, before, after, metadata)
  values (auth.uid(), (select email from public.platform_staff where user_id = auth.uid()), p_action, p_merchant,
          p_entity_type, p_entity_id, p_reason, p_before, p_after, coalesce(p_metadata, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end;
$$;
revoke execute on function public._platform_audit(text, uuid, text, text, text, jsonb, jsonb, jsonb) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Platform credentials (Vault), separate from merchant integration credentials
-- -----------------------------------------------------------------------------
create table public.platform_credentials (
  key text primary key check (key ~ '^[a-z0-9_.:-]{2,80}$'),
  secret_id uuid not null,
  hint text,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.platform_credentials enable row level security;
revoke all on public.platform_credentials from anon, authenticated;

create or replace function public.platform_secret_store(p_key text, p_value jsonb, p_hint text, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_secret uuid;
  v_name text := 'platform:' || p_key;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_key !~ '^[a-z0-9_.:-]{2,80}$' then
    raise exception 'VALIDATION: bad credential key' using errcode = '22023';
  end if;
  if p_value is null or jsonb_typeof(p_value) <> 'object' then
    raise exception 'VALIDATION: credentials must be an object' using errcode = '22023';
  end if;
  select secret_id into v_secret from public.platform_credentials where key = p_key;
  if v_secret is null then
    select id into v_secret from vault.secrets where name = v_name;
  end if;
  if v_secret is null then
    v_secret := vault.create_secret(p_value::text, v_name, 'Platform credentials');
  else
    perform vault.update_secret(v_secret, p_value::text);
  end if;
  insert into public.platform_credentials (key, secret_id, hint, updated_by, updated_at)
  values (p_key, v_secret, p_hint, p_actor, now())
  on conflict (key) do update set secret_id = excluded.secret_id, hint = excluded.hint, updated_by = excluded.updated_by, updated_at = now();
  insert into public.platform_audit_logs (actor_id, actor_email, action, entity_type, entity_id, metadata)
  values (p_actor, (select email from public.platform_staff where user_id = p_actor), 'platform_credential.saved', 'platform_credential',
          p_key, jsonb_build_object('hint', p_hint));
end;
$$;

create or replace function public.platform_secret_get(p_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_secret uuid;
  v_value text;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select secret_id into v_secret from public.platform_credentials where key = p_key and hint is not null;
  if v_secret is null then
    return null;
  end if;
  select decrypted_secret into v_value from vault.decrypted_secrets where id = v_secret;
  return nullif(nullif(v_value, ''), '{}')::jsonb;
end;
$$;

create or replace function public.platform_secret_clear(p_key text, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_secret uuid;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select secret_id into v_secret from public.platform_credentials where key = p_key;
  if v_secret is not null then
    perform vault.update_secret(v_secret, '{}');
  end if;
  update public.platform_credentials set hint = null, updated_by = p_actor, updated_at = now() where key = p_key;
  insert into public.platform_audit_logs (actor_id, actor_email, action, entity_type, entity_id)
  values (p_actor, (select email from public.platform_staff where user_id = p_actor), 'platform_credential.cleared', 'platform_credential', p_key);
end;
$$;
revoke execute on function public.platform_secret_store(text, jsonb, text, uuid) from public, anon, authenticated;
revoke execute on function public.platform_secret_get(text) from public, anon, authenticated;
revoke execute on function public.platform_secret_clear(text, uuid) from public, anon, authenticated;

-- VoiceDrive's gateway token, TURN secret and SIP trunk passwords belong to the
-- platform's PBX gateway, not to one merchant: copy them (inside Vault) from
-- Merchant #1's integration credentials. The originals are left in place.
do $$
declare
  r record;
  v_value text;
  v_secret uuid;
begin
  for r in
    select ic.key, ic.secret_id, ic.hint, ic.connected_by
    from public.integration_credentials ic
    where ic.merchant_id = '00000000-0000-4000-8000-000000000001'
      and ic.hint is not null
      and (ic.key in ('voicedrive.gateway', 'voicedrive.turn') or ic.key like 'voicedrive.trunk.%')
  loop
    select decrypted_secret into v_value from vault.decrypted_secrets where id = r.secret_id;
    continue when v_value is null or v_value in ('', '{}');
    v_secret := vault.create_secret(v_value, 'platform:' || r.key, 'Platform credentials');
    insert into public.platform_credentials (key, secret_id, hint, updated_by)
    values (r.key, v_secret, r.hint, r.connected_by)
    on conflict (key) do nothing;
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- Which merchant owns this?
-- -----------------------------------------------------------------------------
create or replace function public.merchant_for(p_kind text, p_key text)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
  v_uuid uuid;
  v_a text;
  v_b text;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_key is null or length(p_key) = 0 or length(p_key) > 300 then
    return null;
  end if;
  if p_kind in ('channel', 'courier', 'payment', 'pbx_call', 'order', 'profile') then
    if p_key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      return null;
    end if;
    v_uuid := p_key::uuid;
  end if;
  v_a := split_part(p_key, ':', 1);
  v_b := substr(p_key, length(v_a) + 2);

  v_ids := case p_kind
    when 'channel' then array(select merchant_id from public.sales_channels where id = v_uuid)
    when 'channel_oauth_state' then array(select merchant_id from public.channel_oauth_states where state = p_key)
    when 'ad_oauth_state' then array(select merchant_id from public.ad_oauth_states where state = p_key)
    when 'courier' then array(select merchant_id from public.couriers where id = v_uuid)
    -- "<provider>:<consignment id>" for provider-wide courier webhooks
    when 'consignment' then array(select distinct s.merchant_id from public.shipments s join public.couriers c on c.id = s.courier_id
                                  where c.provider = v_a and (s.consignment_id = v_b or s.tracking_number = v_b))
    -- "<provider>:<gateway session or our reference>" for payment returns and IPNs
    when 'payment_session' then array(select distinct merchant_id from public.payments
                                      where provider = v_a and (metadata @> jsonb_build_object('sessions', jsonb_build_array(v_b)) or reference = v_b))
    when 'payment' then array(select merchant_id from public.payments where id = v_uuid)
    when 'site_api_key' then array(select merchant_id from public.site_api_keys where key_hash = p_key and revoked_at is null)
    when 'store_domain' then array(select merchant_id from public.store_domains where domain = lower(p_key) and status <> 'REMOVED')
    when 'pbx_bkash_reference' then array(select merchant_id from public.pbx_bkash_transactions where reference = p_key)
    when 'pbx_bkash_payment' then array(select merchant_id from public.pbx_bkash_transactions where payment_id = p_key)
    when 'pbx_sip_username' then array(select merchant_id from public.pbx_agents where sip_username = p_key)
    when 'pbx_did' then array(select merchant_id from public.pbx_businesses where did in (p_key, public.normalize_phone(p_key)))
    when 'pbx_business_code' then array(select merchant_id from public.pbx_businesses where code::text = p_key)
    when 'pbx_call' then array(select merchant_id from public.pbx_call_records where id = v_uuid)
    when 'order' then array(select merchant_id from public.orders where id = v_uuid)
    when 'profile' then array(select merchant_id from public.profiles where id = v_uuid)
    else null
  end;
  if v_ids is null then
    raise exception 'VALIDATION: unknown lookup %', p_kind using errcode = '22023';
  end if;
  -- Not found, or found in more than one merchant: no answer rather than a guess.
  if cardinality(v_ids) <> 1 then
    return null;
  end if;
  return (select id from public.merchants where id = v_ids[1] and status <> 'CLOSED');
end;
$$;
revoke execute on function public.merchant_for(text, text) from public, anon, authenticated;

-- The store a browser is looking at: a connected custom domain, otherwise the
-- platform's own store. Public (the storefront needs it before anything else).
create or replace function public.storefront_resolve(p_host text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_host text := lower(trim(coalesce(p_host, '')));
  v_id uuid;
  v_m public.merchants;
begin
  v_host := regexp_replace(v_host, ':[0-9]+$', '');
  if v_host <> '' then
    select merchant_id into v_id from public.store_domains
    where domain in (v_host, regexp_replace(v_host, '^www\.', ''), 'www.' || v_host) and status <> 'REMOVED'
    order by (domain = v_host) desc limit 1;
  end if;
  if v_id is null then
    select nullif(value ->> 'default_merchant_id', '')::uuid into v_id from public.platform_settings where key = 'storefront';
  end if;
  select * into v_m from public.merchants where id = v_id and status <> 'CLOSED';
  if v_m.id is null then
    return null;
  end if;
  return jsonb_build_object('merchant_id', v_m.id, 'name', v_m.name, 'status', v_m.status);
end;
$$;
grant execute on function public.storefront_resolve(text) to anon, authenticated;

-- Signed-in, active platform staff (the people who run the platform).
create or replace function public.is_platform_staff()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(auth.jwt() ->> 'role', '') = 'authenticated'
     and exists (select 1 from public.platform_staff where user_id = auth.uid() and is_active)
$$;
grant execute on function public.is_platform_staff() to authenticated;

-- -----------------------------------------------------------------------------
-- Staff access says which merchant
-- -----------------------------------------------------------------------------
do $$
declare
  v_old text := pg_get_functiondef('public.get_my_access()'::regprocedure);
  v_new text;
begin
  v_new := replace(v_old, $o$    'user_id', v_p.id,$o$,
    $n$    'user_id', v_p.id,
    'merchant_id', v_p.merchant_id,
    'merchant', (select jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name, 'status', m.status)
                 from public.merchants m where m.id = v_p.merchant_id),$n$);
  if v_new = v_old then
    raise exception 'merchant context: get_my_access() has changed; update this migration';
  end if;
  execute v_new;
end $$;

-- The VoiceDrive gateway lists every merchant's SIP trunks (it is shared infrastructure).
alter function public.pbx_gw_trunks() owner to postgres;

insert into public.tenancy_exempt_functions (name, reason) values
  ('merchant_for', 'Finds the merchant that owns an incoming webhook, payment or key; service role only'),
  ('storefront_resolve', 'Maps a web address to a merchant before any merchant is known'),
  ('platform_secret_store', 'Platform credentials are not merchant data'),
  ('platform_secret_get', 'Platform credentials are not merchant data'),
  ('platform_secret_clear', 'Platform credentials are not merchant data'),
  ('_platform_audit', 'Platform audit log is not merchant data'),
  ('pbx_gw_trunks', 'The shared VoiceDrive gateway needs every merchant''s SIP trunks'),
  ('is_platform_staff', 'Platform staff are not merchant data');

select public._tenancy_own_functions();
