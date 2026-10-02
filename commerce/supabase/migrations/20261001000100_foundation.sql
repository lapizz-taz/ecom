-- =============================================================================
-- 0100 · Foundation: extensions, enums, helpers, settings, RBAC, audit log
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
create type public.order_status as enum (
  'PENDING', 'FRAUD_CHECK', 'ADVANCE_REQUIRED', 'FRAUD_REVIEW', 'CONFIRMATION_REQUIRED',
  'CONFIRMED', 'PROCESSING', 'PRODUCTION', 'QUALITY_CHECK', 'PACKING', 'READY_TO_SHIP',
  'SHIPPED', 'DELIVERED', 'CANCELLED', 'RETURN_REQUESTED', 'RETURNED', 'FAILED_DELIVERY',
  'REJECTED_FRAUD'
);
create type public.payment_status as enum ('UNPAID', 'PARTIALLY_PAID', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED');
create type public.payment_method as enum ('COD', 'ADVANCE', 'FULL_PAYMENT');
create type public.order_source as enum ('STOREFRONT', 'ADMIN', 'IMPORT', 'API');
create type public.risk_level as enum ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
create type public.fraud_decision as enum ('ALLOW', 'REVIEW', 'ADVANCE_REQUIRED', 'BLOCK');
create type public.fraud_status as enum ('NOT_CHECKED', 'PASSED', 'REVIEW', 'ADVANCE_REQUIRED', 'APPROVED', 'REJECTED', 'ERROR');
create type public.advance_type as enum ('NONE', 'FIXED', 'DELIVERY_CHARGE', 'DELIVERY_PLUS_RETURN', 'PERCENTAGE', 'FULL');
create type public.advance_resolution as enum ('REFUNDED', 'RETAINED');
create type public.product_status as enum ('DRAFT', 'ACTIVE', 'ARCHIVED');
create type public.inventory_movement_type as enum (
  'PURCHASE', 'SALE', 'RETURN', 'ADJUSTMENT', 'DAMAGE', 'LOSS', 'TRANSFER', 'RESERVATION', 'RELEASE'
);
create type public.reservation_status as enum ('ACTIVE', 'RELEASED', 'COMMITTED');
create type public.customer_segment as enum ('NEW', 'REGULAR', 'VIP', 'HIGH_RISK', 'BLOCKED');
create type public.customer_status as enum ('ACTIVE', 'BLOCKED');
create type public.order_payment_kind as enum ('ADVANCE', 'FULL', 'BALANCE', 'COD', 'REFUND');
create type public.payment_channel as enum (
  'CASH', 'BKASH', 'NAGAD', 'ROCKET', 'CARD', 'BANK_TRANSFER', 'GATEWAY', 'COURIER_COD', 'OTHER'
);
create type public.payment_intent_status as enum (
  'PENDING', 'REQUIRES_VERIFICATION', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED'
);
create type public.payment_purpose as enum ('ADVANCE', 'FULL', 'BALANCE');
create type public.production_status as enum (
  'WAITING', 'IN_PRODUCTION', 'PAUSED', 'QUALITY_CHECK', 'PACKING', 'READY', 'CANCELLED'
);
create type public.production_priority as enum ('LOW', 'NORMAL', 'HIGH', 'URGENT');
create type public.shipment_status as enum (
  'PENDING', 'BOOKED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED',
  'PARTIALLY_DELIVERED', 'FAILED', 'RETURNING', 'RETURNED', 'CANCELLED', 'ON_HOLD'
);
create type public.return_status as enum ('NONE', 'REQUESTED', 'IN_TRANSIT', 'RECEIVED');
create type public.finance_type as enum ('INCOME', 'EXPENSE');
create type public.pnl_group as enum (
  'REVENUE', 'DELIVERY_INCOME', 'OTHER_INCOME', 'CONTRA_REVENUE', 'COGS', 'OPERATING_EXPENSE', 'NONE'
);
create type public.purchase_status as enum ('DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED');
create type public.settlement_status as enum ('UNPAID', 'PARTIALLY_PAID', 'PAID');
create type public.discount_type as enum ('PERCENTAGE', 'FIXED', 'FREE_DELIVERY');
create type public.marketing_platform as enum ('META', 'GOOGLE', 'TIKTOK', 'OTHER');
create type public.campaign_status as enum ('ACTIVE', 'PAUSED', 'ENDED');
create type public.data_source as enum ('MANUAL', 'API', 'WEBHOOK', 'SYSTEM');
create type public.notification_channel as enum ('SMS', 'WHATSAPP', 'EMAIL');
create type public.notification_event as enum (
  'ORDER_CREATED', 'ORDER_CONFIRMED', 'ADVANCE_REQUIRED', 'ADVANCE_RECEIVED',
  'ORDER_SHIPPED', 'ORDER_DELIVERED', 'ORDER_CANCELLED', 'ORDER_RETURNED'
);
create type public.notification_status as enum ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'SKIPPED');
create type public.note_visibility as enum ('INTERNAL', 'CUSTOMER');
create type public.note_kind as enum ('NOTE', 'CONTACT', 'SYSTEM');

-- -----------------------------------------------------------------------------
-- Generic helpers
-- -----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Rejects UPDATE/DELETE on ledger-style tables. Corrections are new rows.
create or replace function public.prevent_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'IMMUTABLE_RECORD: % rows cannot be %d; record a correcting entry instead',
    tg_table_name, lower(tg_op)
    using errcode = 'P0001';
end;
$$;

-- Digits-only phone normalisation. Numbers in international form for the
-- configured country code are converted to the local trunk form (0XXXXXXXXXX).
create or replace function public.normalize_phone(p_phone text, p_country_code text default '880')
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when d = '' then null
    when d like '00' || p_country_code || '%' then '0' || substr(d, length(p_country_code) + 3)
    when d like p_country_code || '%' and length(d) > length(p_country_code) + 8
      then '0' || substr(d, length(p_country_code) + 1)
    else d
  end
  from (select regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') as d) s
$$;

create or replace function public.slugify(p_text text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select trim(both '-' from regexp_replace(lower(coalesce(p_text, '')), '[^a-z0-9]+', '-', 'g'))
$$;

-- Money is always rounded half-up to 2 decimals.
create or replace function public.money(p numeric)
returns numeric
language sql
immutable
set search_path = public, pg_temp
as $$
  select round(coalesce(p, 0), 2)
$$;

-- -----------------------------------------------------------------------------
-- Settings (database-driven business rules)
-- -----------------------------------------------------------------------------
create table public.settings (
  key text primary key check (key ~ '^[a-z][a-z0-9_]*$'),
  value jsonb not null default '{}'::jsonb check (jsonb_typeof(value) = 'object'),
  is_public boolean not null default false,
  description text,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger settings_updated_at before update on public.settings
  for each row execute function public.set_updated_at();

create or replace function public.get_setting(p_key text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select value from public.settings where key = p_key), '{}'::jsonb)
$$;

-- Typed accessors that fall back to a default when a key is missing.
create or replace function public.setting_numeric(p_key text, p_path text[], p_default numeric)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(nullif(public.get_setting(p_key) #>> p_path, '')::numeric, p_default)
$$;

create or replace function public.setting_bool(p_key text, p_path text[], p_default boolean)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(nullif(public.get_setting(p_key) #>> p_path, '')::boolean, p_default)
$$;

create or replace function public.setting_text(p_key text, p_path text[], p_default text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(nullif(public.get_setting(p_key) #>> p_path, ''), p_default)
$$;

create or replace function public.store_timezone()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.setting_text('store', array['timezone'], 'Asia/Dhaka')
$$;

create or replace function public.phone_country_code()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.setting_text('store', array['phone_country_code'], '880')
$$;

create or replace function public.clean_phone(p_phone text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.normalize_phone(p_phone, public.phone_country_code())
$$;

-- -----------------------------------------------------------------------------
-- RBAC: roles, permissions, role_permissions, profiles
-- -----------------------------------------------------------------------------
create table public.roles (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z][A-Z0-9_]*$'),
  name text not null,
  description text,
  is_system boolean not null default false,
  rank int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger roles_updated_at before update on public.roles
  for each row execute function public.set_updated_at();

create table public.permissions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z_]+\.[a-z_]+$'),
  module text not null,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger permissions_updated_at before update on public.permissions
  for each row execute function public.set_updated_at();

create table public.role_permissions (
  role_id uuid not null references public.roles(id) on delete cascade,
  permission_id uuid not null references public.permissions(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (role_id, permission_id)
);
create index role_permissions_permission_idx on public.role_permissions(permission_id);

-- Staff accounts. Storefront customers do not get a profile.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text not null default '',
  phone text,
  role_id uuid not null references public.roles(id),
  is_active boolean not null default true,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index profiles_role_idx on public.profiles(role_id);
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- True for the service role (edge functions) and for direct database sessions
-- (migrations, SQL editor, pg_cron). Never true for PostgREST user requests.
create or replace function public.is_system_context()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(auth.jwt() ->> 'role', '') = 'service_role'
      or (nullif(current_setting('request.jwt.claims', true), '') is null
          and session_user in ('postgres', 'supabase_admin'))
$$;

create or replace function public.current_role_code()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select r.code
  from public.profiles p
  join public.roles r on r.id = p.role_id
  where p.id = auth.uid() and p.is_active
$$;

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_active)
$$;

create or replace function public.has_permission(p_code text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles p
    join public.roles r on r.id = p.role_id
    where p.id = auth.uid()
      and p.is_active
      and (
        r.code = 'OWNER'
        or exists (
          select 1
          from public.role_permissions rp
          join public.permissions pm on pm.id = rp.permission_id
          where rp.role_id = r.id and pm.code = p_code
        )
      )
  )
$$;

create or replace function public.require_permission(p_code text)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if public.is_system_context() or public.has_permission(p_code) then
    return;
  end if;
  raise exception 'PERMISSION_DENIED: % is required', p_code using errcode = '42501';
end;
$$;

-- Everything the admin UI needs to know about the signed-in staff member.
create or replace function public.get_my_access()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when p.id is null then null else jsonb_build_object(
    'user_id', p.id,
    'email', p.email,
    'full_name', p.full_name,
    'role', r.code,
    'role_name', r.name,
    'permissions', case when r.code = 'OWNER'
      then (select coalesce(jsonb_agg(code order by code), '[]'::jsonb) from public.permissions)
      else (select coalesce(jsonb_agg(pm.code order by pm.code), '[]'::jsonb)
            from public.role_permissions rp join public.permissions pm on pm.id = rp.permission_id
            where rp.role_id = r.id)
    end
  ) end
  from (select auth.uid() as uid) me
  left join public.profiles p on p.id = me.uid and p.is_active
  left join public.roles r on r.id = p.role_id
$$;

-- -----------------------------------------------------------------------------
-- Audit log
-- -----------------------------------------------------------------------------
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,
  actor_email text,
  action text not null,
  entity_type text not null,
  entity_id text,
  old_values jsonb,
  new_values jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_created_idx on public.audit_logs(created_at desc);
create index audit_logs_entity_idx on public.audit_logs(entity_type, entity_id);
create index audit_logs_actor_idx on public.audit_logs(actor_id);
create index audit_logs_action_idx on public.audit_logs(action);
create trigger audit_logs_immutable before update or delete on public.audit_logs
  for each row execute function public.prevent_mutation();

create or replace function public.log_audit(
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_old jsonb default null,
  p_new jsonb default null,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  insert into public.audit_logs(actor_id, actor_email, action, entity_type, entity_id, old_values, new_values, metadata)
  values (
    v_uid,
    coalesce((select email from public.profiles where id = v_uid), auth.jwt() ->> 'email',
             case when public.is_system_context() then 'system' end),
    p_action, p_entity_type, p_entity_id, p_old, p_new, coalesce(p_metadata, '{}'::jsonb)
  );
end;
$$;

-- Row-level audit trigger for configuration tables. Records only changed keys.
create or replace function public.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_key text;
  v_id text;
begin
  if tg_op = 'INSERT' then
    v_new := to_jsonb(new);
    v_id := v_new ->> coalesce(tg_argv[0], 'id');
  elsif tg_op = 'DELETE' then
    v_old := to_jsonb(old);
    v_id := v_old ->> coalesce(tg_argv[0], 'id');
  else
    v_old := '{}'::jsonb;
    v_new := '{}'::jsonb;
    for v_key in select jsonb_object_keys(to_jsonb(new)) loop
      if v_key not in ('updated_at') and (to_jsonb(new) -> v_key) is distinct from (to_jsonb(old) -> v_key) then
        v_old := v_old || jsonb_build_object(v_key, to_jsonb(old) -> v_key);
        v_new := v_new || jsonb_build_object(v_key, to_jsonb(new) -> v_key);
      end if;
    end loop;
    if v_new = '{}'::jsonb then
      return new;
    end if;
    v_id := to_jsonb(new) ->> coalesce(tg_argv[0], 'id');
  end if;
  perform public.log_audit(tg_table_name || '.' || lower(tg_op), tg_table_name, v_id, v_old, v_new);
  return coalesce(new, old);
end;
$$;

create trigger settings_audit after insert or update or delete on public.settings
  for each row execute function public.audit_row_change('key');
create trigger role_permissions_audit after insert or delete on public.role_permissions
  for each row execute function public.audit_row_change('role_id');
create trigger profiles_audit after insert or update or delete on public.profiles
  for each row execute function public.audit_row_change();

-- -----------------------------------------------------------------------------
-- Staff administration (privilege-escalation safe)
-- -----------------------------------------------------------------------------
create or replace function public.admin_set_user_role(p_user_id uuid, p_role_code text, p_is_active boolean default true)
returns public.profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.roles;
  v_profile public.profiles;
  v_my_role text := public.current_role_code();
  v_my_rank int;
begin
  perform public.require_permission('users.manage');

  select * into v_role from public.roles where code = upper(p_role_code);
  if not found then
    raise exception 'VALIDATION: unknown role %', p_role_code using errcode = '22023';
  end if;

  if not public.is_system_context() then
    if p_user_id = auth.uid() then
      raise exception 'PERMISSION_DENIED: you cannot change your own role or status' using errcode = '42501';
    end if;
    if v_role.code = 'OWNER' and v_my_role <> 'OWNER' then
      raise exception 'PERMISSION_DENIED: only an owner can grant the OWNER role' using errcode = '42501';
    end if;
    if exists (select 1 from public.profiles p join public.roles r on r.id = p.role_id
               where p.id = p_user_id and r.code = 'OWNER') and v_my_role <> 'OWNER' then
      raise exception 'PERMISSION_DENIED: only an owner can modify another owner' using errcode = '42501';
    end if;
    -- Whoever holds users.manage can only hand out, or take away, roles up to their own rank.
    if v_my_role <> 'OWNER' then
      v_my_rank := coalesce((select rank from public.roles where code = v_my_role), 0);
      if v_role.rank > v_my_rank then
        raise exception 'PERMISSION_DENIED: you cannot grant a role above your own' using errcode = '42501';
      end if;
      if exists (select 1 from public.profiles p join public.roles r on r.id = p.role_id
                 where p.id = p_user_id and r.rank > v_my_rank) then
        raise exception 'PERMISSION_DENIED: you cannot change someone with a higher role than yours' using errcode = '42501';
      end if;
    end if;
  end if;

  select * into v_profile from public.profiles where id = p_user_id for update;
  if not found then
    insert into public.profiles(id, email, full_name, role_id, is_active)
    select u.id, u.email, coalesce(u.raw_user_meta_data ->> 'full_name', ''), v_role.id, p_is_active
    from auth.users u where u.id = p_user_id
    returning * into v_profile;
    if v_profile.id is null then
      raise exception 'NOT_FOUND: auth user % does not exist', p_user_id using errcode = 'P0002';
    end if;
  else
    -- Never leave the business without an active owner.
    if (select code from public.roles where id = v_profile.role_id) = 'OWNER'
       and (v_role.code <> 'OWNER' or not p_is_active)
       and (select count(*) from public.profiles p join public.roles r on r.id = p.role_id
            where r.code = 'OWNER' and p.is_active and p.id <> p_user_id) = 0 then
      raise exception 'VALIDATION: at least one active owner is required' using errcode = '22023';
    end if;
    update public.profiles set role_id = v_role.id, is_active = p_is_active
    where id = p_user_id returning * into v_profile;
  end if;

  perform public.log_audit('user.role_changed', 'profile', p_user_id::text, null,
    jsonb_build_object('role', v_role.code, 'is_active', p_is_active));
  return v_profile;
end;
$$;

-- Bootstrap: run once from the SQL editor (system context) after creating the
-- first auth user:  select public.grant_owner('owner@example.com');
create or replace function public.grant_owner(p_email text)
returns public.profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED: grant_owner can only be run from the SQL editor or service role'
      using errcode = '42501';
  end if;
  select id into v_user_id from auth.users where lower(email) = lower(p_email);
  if v_user_id is null then
    raise exception 'NOT_FOUND: no auth user with email %', p_email using errcode = 'P0002';
  end if;
  return public.admin_set_user_role(v_user_id, 'OWNER', true);
end;
$$;

create or replace function public.update_my_profile(p_full_name text, p_phone text default null)
returns public.profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles;
begin
  if length(trim(coalesce(p_full_name, ''))) = 0 then
    raise exception 'VALIDATION: name is required' using errcode = '22023';
  end if;
  update public.profiles
  set full_name = trim(p_full_name), phone = nullif(trim(coalesce(p_phone, '')), ''), last_seen_at = now()
  where id = auth.uid()
  returning * into v_profile;
  if not found then
    raise exception 'NOT_FOUND: no staff profile for current user' using errcode = 'P0002';
  end if;
  return v_profile;
end;
$$;

create or replace function public.admin_update_setting(p_key text, p_value jsonb)
returns public.settings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.settings;
  v_medium numeric;
  v_high numeric;
  v_critical numeric;
begin
  perform public.require_permission('settings.manage');
  if p_value is null or jsonb_typeof(p_value) <> 'object' then
    raise exception 'VALIDATION: setting value must be a JSON object' using errcode = '22023';
  end if;
  if p_key = 'fraud' then
    v_medium := (p_value #>> '{thresholds,medium}')::numeric;
    v_high := (p_value #>> '{thresholds,high}')::numeric;
    v_critical := (p_value #>> '{thresholds,critical}')::numeric;
    if v_medium is null or v_high is null or v_critical is null
       or not (0 <= v_medium and v_medium < v_high and v_high < v_critical and v_critical <= 100) then
      raise exception 'VALIDATION: fraud thresholds must satisfy 0 <= medium < high < critical <= 100'
        using errcode = '22023';
    end if;
  end if;
  if p_key = 'store' and coalesce(p_value ->> 'order_prefix', '') !~ '^[A-Z0-9]{1,8}$' then
    raise exception 'VALIDATION: order prefix must be 1-8 uppercase letters or digits' using errcode = '22023';
  end if;

  update public.settings set value = p_value, updated_by = auth.uid()
  where key = p_key returning * into v_row;
  if not found then
    raise exception 'NOT_FOUND: unknown setting %', p_key using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table public.settings enable row level security;
alter table public.roles enable row level security;
alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;
alter table public.profiles enable row level security;
alter table public.audit_logs enable row level security;

create policy settings_public_read on public.settings for select to anon, authenticated
  using (is_public);
create policy settings_staff_read on public.settings for select to authenticated
  using ((select public.has_permission('settings.view')));

create policy roles_staff_read on public.roles for select to authenticated
  using ((select public.is_staff()));
create policy permissions_staff_read on public.permissions for select to authenticated
  using ((select public.is_staff()));
create policy role_permissions_staff_read on public.role_permissions for select to authenticated
  using ((select public.is_staff()));
create policy role_permissions_manage on public.role_permissions for all to authenticated
  using ((select public.current_role_code()) = 'OWNER')
  with check ((select public.current_role_code()) = 'OWNER');

create policy profiles_self_read on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.has_permission('users.manage')));

create policy audit_logs_read on public.audit_logs for select to authenticated
  using ((select public.has_permission('audit.view')));

-- Writes to profiles, settings and audit_logs go through the functions above.
revoke insert, update, delete on public.profiles, public.settings, public.audit_logs from anon, authenticated;
revoke insert, update, delete on public.roles, public.permissions from anon, authenticated;
revoke insert, update, delete on public.role_permissions from anon;
revoke execute on function public.grant_owner(text) from anon, authenticated;
revoke execute on function public.log_audit(text, text, text, jsonb, jsonb, jsonb) from anon, authenticated;
