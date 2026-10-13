-- =============================================================================
-- Courier panel accounts: the merchant's OWN logins to the courier merchant
-- panels (Steadfast, Pathao, RedX, Carrybee, Paperfly), used to read each
-- courier's "fraud check" / customer success page for a phone number.
--
-- This is a SECOND source for the delivery-success ("receive rate") check, next
-- to the platform's BD Courier connection. It runs on the merchant's own
-- courier accounts, so it costs the merchant nothing and uses no platform
-- credits. The couriers have no official API for this; the edge function signs
-- in to each panel exactly like the merchant's browser would.
--
-- Passwords live in Vault (one secret per merchant, courier-panel:<merchant>).
-- The courier_panel_accounts table keeps only a masked hint and timestamps so
-- the admin UI can show which couriers are connected without touching Vault.
-- =============================================================================

create table public.courier_panel_accounts (
  merchant_id uuid not null references public.merchants(id),
  provider text not null check (provider in ('steadfast', 'pathao', 'redx', 'carrybee', 'paperfly')),
  hint text,
  connected_by uuid,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (merchant_id, provider)
);

-- Tenant isolation, matching the pattern the tenancy migration applies to every
-- business table (this table is created after that migration ran).
alter table public.courier_panel_accounts enable row level security;
create policy tenant_isolation on public.courier_panel_accounts as restrictive for all to public
  using (merchant_id = public.current_merchant_id()) with check (merchant_id = public.current_merchant_id());
create policy app_owner_all on public.courier_panel_accounts for all to app_owner using (true) with check (true);
create policy staff_read on public.courier_panel_accounts for select to authenticated using ((select public.is_staff()));

-- -----------------------------------------------------------------------------
-- Vault-backed credential store (one secret per merchant, all providers in one
-- JSON object). Reads and writes are service-role only (is_system_context),
-- like gateway_token_get/put — the edge function holds the secrets, never the
-- browser.
-- -----------------------------------------------------------------------------

-- Full credentials for every connected panel, for the edge function.
create or replace function public.courier_panel_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_merchant uuid := public.current_merchant_id();
  v_value text;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if v_merchant is null then
    raise exception 'MERCHANT_REQUIRED' using errcode = '42501';
  end if;
  select decrypted_secret into v_value from vault.decrypted_secrets
  where name = 'courier-panel:' || v_merchant::text;
  return coalesce(nullif(v_value, '')::jsonb, '{}'::jsonb);
end;
$$;

-- Save one provider's login (merged into the merchant's secret) and record a
-- masked hint for the UI. p_value is {email,password} / {phone,password} /
-- {user,password} depending on the courier.
create or replace function public.courier_panel_put(p_provider text, p_value jsonb, p_hint text, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_merchant uuid := public.current_merchant_id();
  v_name text;
  v_secret uuid;
  v_all jsonb;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if v_merchant is null then
    raise exception 'MERCHANT_REQUIRED' using errcode = '42501';
  end if;
  if p_provider !~ '^(steadfast|pathao|redx|carrybee|paperfly)$' or jsonb_typeof(p_value) <> 'object' then
    raise exception 'VALIDATION: bad courier panel login' using errcode = '22023';
  end if;
  v_name := 'courier-panel:' || v_merchant::text;
  select id into v_secret from vault.secrets where name = v_name;
  if v_secret is null then
    v_all := jsonb_build_object(p_provider, p_value);
    perform vault.create_secret(v_all::text, v_name, 'Courier merchant-panel logins for fraud checks');
  else
    select coalesce(decrypted_secret::jsonb, '{}'::jsonb) into v_all from vault.decrypted_secrets where id = v_secret;
    v_all := coalesce(v_all, '{}'::jsonb) || jsonb_build_object(p_provider, p_value);
    perform vault.update_secret(v_secret, v_all::text);
  end if;
  insert into public.courier_panel_accounts (merchant_id, provider, hint, connected_by, connected_at, updated_at)
  values (v_merchant, p_provider, left(p_hint, 120), p_actor, now(), now())
  on conflict (merchant_id, provider) do update set hint = excluded.hint, connected_by = excluded.connected_by, updated_at = now();
end;
$$;

-- Remove one provider's login.
create or replace function public.courier_panel_clear(p_provider text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_merchant uuid := public.current_merchant_id();
  v_name text;
  v_secret uuid;
  v_all jsonb;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if v_merchant is null then
    raise exception 'MERCHANT_REQUIRED' using errcode = '42501';
  end if;
  if p_provider !~ '^(steadfast|pathao|redx|carrybee|paperfly)$' then
    raise exception 'VALIDATION: bad provider' using errcode = '22023';
  end if;
  v_name := 'courier-panel:' || v_merchant::text;
  select id into v_secret from vault.secrets where name = v_name;
  if v_secret is not null then
    select coalesce(decrypted_secret::jsonb, '{}'::jsonb) into v_all from vault.decrypted_secrets where id = v_secret;
    v_all := coalesce(v_all, '{}'::jsonb) - p_provider;
    if v_all = '{}'::jsonb then
      perform vault.update_secret(v_secret, '{}');
    else
      perform vault.update_secret(v_secret, v_all::text);
    end if;
  end if;
  delete from public.courier_panel_accounts where merchant_id = v_merchant and provider = p_provider;
end;
$$;

grant execute on function public.courier_panel_get() to service_role, app_owner;
grant execute on function public.courier_panel_put(text, jsonb, text, uuid) to service_role, app_owner;
grant execute on function public.courier_panel_clear(text) to service_role, app_owner;

insert into public.tenancy_exempt_functions (name, reason) values
  ('courier_panel_get', 'Vault; secret name includes current_merchant_id()'),
  ('courier_panel_put', 'Vault; secret name includes current_merchant_id()'),
  ('courier_panel_clear', 'Vault; secret name includes current_merchant_id()')
on conflict (name) do nothing;

select public._tenancy_own_functions();
