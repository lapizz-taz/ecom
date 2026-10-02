-- =============================================================================
-- 1500 · Courier-history check at checkout:
--   * API keys for outside services (the courier fraud-check API) kept in
--     Supabase Vault, connected from the admin, never readable by the API
--   * fraud provider on/off switch used when a service is connected
--   * a failed lookup is reused for a couple of minutes so a slow or broken
--     service doesn't hold up every step of the checkout
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Integration credentials (secret in Vault; this table only links to it)
-- -----------------------------------------------------------------------------
create table public.integration_credentials (
  key text primary key check (key ~ '^[a-z0-9_.]{3,60}$'),
  secret_id uuid,
  hint text,
  connected_by uuid,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.integration_credentials enable row level security;
-- No policies: not readable through the API at all.
revoke all on public.integration_credentials from anon, authenticated;
grant all on public.integration_credentials to service_role;

create or replace function public.integration_secret_store(p_key text, p_value jsonb, p_hint text, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_secret uuid;
  v_name text := 'integration:' || p_key;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_value is null or jsonb_typeof(p_value) <> 'object' then
    raise exception 'VALIDATION: credentials must be an object' using errcode = '22023';
  end if;
  select secret_id into v_secret from public.integration_credentials where key = p_key;
  if v_secret is null then
    select id into v_secret from vault.secrets where name = v_name;
  end if;
  if v_secret is null then
    v_secret := vault.create_secret(p_value::text, v_name, 'Integration credentials');
  else
    perform vault.update_secret(v_secret, p_value::text);
  end if;

  insert into public.integration_credentials(key, secret_id, hint, connected_by, connected_at, updated_at)
  values (p_key, v_secret, p_hint, p_actor, now(), now())
  on conflict (key) do update set secret_id = excluded.secret_id, hint = excluded.hint,
    connected_by = excluded.connected_by, connected_at = now(), updated_at = now();

  insert into public.audit_logs(actor_id, actor_email, action, entity_type, entity_id, metadata)
  values (p_actor, (select email from public.profiles where id = p_actor), 'integration.connected', 'integration',
          p_key, jsonb_build_object('hint', p_hint));
end;
$$;

create or replace function public.integration_secret_get(p_key text)
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
  select secret_id into v_secret from public.integration_credentials where key = p_key and hint is not null;
  if v_secret is null then
    return null;
  end if;
  select decrypted_secret into v_value from vault.decrypted_secrets where id = v_secret;
  return nullif(nullif(v_value, ''), '{}')::jsonb;
end;
$$;

create or replace function public.integration_secret_clear(p_key text, p_actor uuid)
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
  select secret_id into v_secret from public.integration_credentials where key = p_key;
  if v_secret is not null then
    perform vault.update_secret(v_secret, '{}');
  end if;
  update public.integration_credentials set hint = null, updated_at = now() where key = p_key;
  insert into public.audit_logs(actor_id, actor_email, action, entity_type, entity_id, metadata)
  values (p_actor, (select email from public.profiles where id = p_actor), 'integration.disconnected', 'integration',
          p_key, '{}'::jsonb);
end;
$$;

-- Turns a fraud provider on or off (used when a service is connected).
create or replace function public.fraud_set_provider(p_provider text, p_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_value jsonb;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_provider !~ '^[a-z_]{2,40}$' then
    raise exception 'VALIDATION: unknown provider' using errcode = '22023';
  end if;
  update public.settings set value = jsonb_set(value, '{providers}', (
    select coalesce(jsonb_agg(distinct p order by p), '[]'::jsonb)
    from (
      select jsonb_array_elements_text(coalesce(value -> 'providers', '["internal"]'::jsonb)) as p
      union all
      select p_provider where p_enabled
    ) s
    where p_enabled or s.p <> p_provider
  ))
  where key = 'fraud'
  returning value into v_value;
  return v_value -> 'providers';
end;
$$;

-- Connection status for the admin (never the secret itself).
create or replace function public.admin_integration_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('settings.view');
  return coalesce((
    select jsonb_object_agg(c.key, jsonb_build_object(
      'connected', c.hint is not null,
      'hint', c.hint,
      'connected_at', c.connected_at,
      'connected_by_name', (select coalesce(nullif(p.full_name, ''), p.email) from public.profiles p where p.id = c.connected_by)))
    from public.integration_credentials c
  ), '{}'::jsonb);
end;
$$;

-- -----------------------------------------------------------------------------
-- Checkout cache: a failed lookup is reused for 2 minutes (instead of being
-- retried on every price update); successful checks for cache_minutes.
-- -----------------------------------------------------------------------------
create or replace function public.recent_fraud_check(p_phone text)
returns public.fraud_checks
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select * from public.fraud_checks
  where phone = public.clean_phone(p_phone)
    and created_at > now() - make_interval(mins => case when status = 'ERROR' then 2
          else public.setting_numeric('fraud', array['cache_minutes'], 30)::int end)
  order by created_at desc
  limit 1
$$;

revoke execute on function
  public.integration_secret_store(text, jsonb, text, uuid), public.integration_secret_get(text),
  public.integration_secret_clear(text, uuid), public.fraud_set_provider(text, boolean),
  public.admin_integration_status(), public.recent_fraud_check(text)
from public, anon, authenticated;

grant execute on function
  public.integration_secret_store(text, jsonb, text, uuid), public.integration_secret_get(text),
  public.integration_secret_clear(text, uuid), public.fraud_set_provider(text, boolean),
  public.admin_integration_status(), public.recent_fraud_check(text)
to service_role;

grant execute on function public.admin_integration_status() to authenticated;
