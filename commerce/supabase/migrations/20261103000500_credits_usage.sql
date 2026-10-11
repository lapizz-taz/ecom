-- =============================================================================
-- Credits, metered services and recharge.
--
-- * Credits: per merchant and credit type (SMS, courier checks, AI). Every
--   change is one immutable ledger entry with the resulting balance, the
--   reason and who made it; an idempotency key per entry makes retries
--   harmless (no double credit, no double charge). Credits are held in lots
--   so promotional credits can expire; spending uses the soonest-expiring first.
-- * SMS and BD Courier run on the platform's own provider accounts. Merchants
--   never hold those credentials.
-- * Usage policies (per service, set in the Super Admin panel): free allowance
--   and its period, who is eligible (plan, subscription status), what happens
--   after it (credits or blocked), monthly caps, unmetered plans. Merchant
--   exceptions override the limits. Every metered request is recorded.
-- * Recharge: a merchant buys a credit package (an invoice of kind CREDITS)
--   and pays through the platform's gateway; credits arrive only when the
--   gateway confirms the payment (or a second person verifies a manual one).
--
-- SMS charging policy (shown to merchants in the same words):
--   waiting in the queue ........ not charged
--   handed to the provider ...... charged (free allowance first, then credits)
--   provider rejects / gives up . refunded in full
--   temporary failure, retried .. charged once; retries are not charged again
--   delivered ................... charged
--   reported undelivered ........ charged, unless "refund undelivered" is on
--   skipped (not a mobile number) or blocked by policy ... never charged
--   interrupted while sending ... stays charged (it may have gone out)
-- BD Courier: one lookup that reaches BD Courier = one use. A repeat check of
-- the same number inside the cache window reuses the saved result and is not
-- counted. Lookups that fail (error, timeout) are refunded.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Credit types, balances, lots and the ledger
-- -----------------------------------------------------------------------------
create table public.credit_types (
  code text primary key check (code ~ '^[A-Z][A-Z_]{1,20}$'),
  name text not null,
  unit text not null,
  description text,
  -- What spends it; null = nothing spends it yet.
  used_by text,
  sort_order int not null default 100
);
insert into public.credit_types (code, name, unit, description, used_by, sort_order) values
  ('SMS', 'SMS credits', 'SMS part', 'One credit sends one SMS part (160 characters, or 70 with Bangla), unless the SMS policy says otherwise.', 'SMS', 1),
  ('COURIER', 'Courier check credits', 'check', 'One credit is one BD Courier history lookup, unless the BD Courier policy says otherwise.', 'BD Courier history checks', 2),
  ('AI', 'AI credits', 'credit', 'Reserved for AI features. Nothing spends them yet.', null, 3);

create table public.credit_balances (
  merchant_id uuid not null references public.merchants(id),
  credit_type text not null references public.credit_types(code),
  balance int not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now(),
  primary key (merchant_id, credit_type)
);

create table public.credit_ledger (
  id bigint generated always as identity primary key,
  merchant_id uuid not null references public.merchants(id),
  credit_type text not null references public.credit_types(code),
  kind text not null check (kind in ('RECHARGE', 'PROMO', 'ADJUSTMENT', 'USAGE', 'REFUND', 'EXPIRY')),
  amount int not null check (amount <> 0),
  balance_after int not null check (balance_after >= 0),
  reason text,
  actor_id uuid,
  actor_kind text not null default 'SYSTEM' check (actor_kind in ('PLATFORM', 'SYSTEM', 'MERCHANT')),
  reference_type text,
  reference_id text,
  idempotency_key text not null,
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (merchant_id, idempotency_key)
);
create index credit_ledger_merchant_idx on public.credit_ledger (merchant_id, credit_type, id desc);
create index credit_ledger_created_idx on public.credit_ledger (created_at desc);
create trigger credit_ledger_immutable before update or delete on public.credit_ledger
  for each row execute function public.prevent_mutation();

create table public.credit_lots (
  id bigint generated always as identity primary key,
  merchant_id uuid not null references public.merchants(id),
  credit_type text not null references public.credit_types(code),
  entry_id bigint not null references public.credit_ledger(id),
  granted int not null check (granted > 0),
  remaining int not null check (remaining >= 0 and remaining <= granted),
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
create index credit_lots_open_idx on public.credit_lots (merchant_id, credit_type, expires_at) where remaining > 0;

-- Which lots each spend took from (so a refund goes back where it came from).
create table public.credit_lot_usage (
  merchant_id uuid not null references public.merchants(id),
  entry_id bigint not null references public.credit_ledger(id),
  lot_id bigint not null references public.credit_lots(id),
  amount int not null check (amount > 0),
  primary key (entry_id, lot_id)
);

create table public.credit_packages (
  id uuid primary key default gen_random_uuid(),
  credit_type text not null references public.credit_types(code),
  name text not null check (length(trim(name)) between 2 and 60),
  credits int not null check (credits > 0),
  bonus_credits int not null default 0 check (bonus_credits >= 0),
  price numeric(12, 2) not null check (price > 0),
  currency text not null default 'BDT',
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
  sort_order int not null default 100,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger credit_packages_updated_at before update on public.credit_packages for each row execute function public.set_updated_at();
-- Starting points for the Super Admin to price; nothing is sold until a merchant pays.
insert into public.credit_packages (credit_type, name, credits, bonus_credits, price, sort_order) values
  ('SMS', 'SMS 500', 500, 0, 250, 1),
  ('SMS', 'SMS 2,000', 2000, 100, 900, 2),
  ('SMS', 'SMS 10,000', 10000, 1000, 4200, 3),
  ('COURIER', 'Courier checks 100', 100, 0, 150, 10),
  ('COURIER', 'Courier checks 500', 500, 50, 600, 11);

-- Usable credits right now (expired lots not counted even before the expiry job runs).
create or replace function public.credit_available(p_merchant uuid, p_type text)
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(remaining), 0)::int from public.credit_lots
  where merchant_id = p_merchant and credit_type = p_type and remaining > 0 and (expires_at is null or expires_at > now())
$$;

-- Writes off lots past their expiry. The caller holds the balance row lock.
create or replace function public._credit_expire(p_merchant uuid, p_type text)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  l public.credit_lots;
  v_bal int;
  v_entry bigint;
  v_n int := 0;
begin
  for l in select * from public.credit_lots
           where merchant_id = p_merchant and credit_type = p_type and remaining > 0 and expires_at <= now()
           order by id for update loop
    select balance into v_bal from public.credit_balances where merchant_id = p_merchant and credit_type = p_type;
    insert into public.credit_ledger (merchant_id, credit_type, kind, amount, balance_after, reason, actor_kind, reference_type, reference_id, idempotency_key)
    values (p_merchant, p_type, 'EXPIRY', -l.remaining, greatest(v_bal - l.remaining, 0), 'Credits expired', 'SYSTEM', 'credit_lot', l.id::text, 'expiry:' || l.id)
    on conflict (merchant_id, idempotency_key) do nothing
    returning id into v_entry;
    if v_entry is not null then
      insert into public.credit_lot_usage (merchant_id, entry_id, lot_id, amount) values (p_merchant, v_entry, l.id, l.remaining);
      update public.credit_balances set balance = greatest(balance - l.remaining, 0), updated_at = now() where merchant_id = p_merchant and credit_type = p_type;
      v_n := v_n + 1;
    end if;
    update public.credit_lots set remaining = 0 where id = l.id;
  end loop;
  return v_n;
end;
$$;

-- The one way credits change. Positive amounts add a lot (or, for a refund,
-- go back to the lots the refunded spend came from); negative amounts spend
-- from the soonest-expiring lots. The same idempotency key twice returns the
-- first entry and changes nothing.
create or replace function public._credit_post(
  p_merchant uuid, p_type text, p_amount int, p_kind text, p_reason text, p_actor uuid, p_actor_kind text,
  p_ref_type text, p_ref_id text, p_key text, p_expires_at timestamptz default null, p_metadata jsonb default '{}'::jsonb)
returns public.credit_ledger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e public.credit_ledger;
  v_bal int;
  v_need int;
  v_take int;
  l public.credit_lots;
  u record;
  v_restored int := 0;
begin
  if p_amount is null or p_amount = 0 then
    raise exception 'VALIDATION: the amount cannot be zero' using errcode = '22023';
  end if;
  if coalesce(p_key, '') = '' then
    raise exception 'VALIDATION: an idempotency key is required' using errcode = '22023';
  end if;
  select * into e from public.credit_ledger where merchant_id = p_merchant and idempotency_key = p_key;
  if e.id is not null then
    return e;
  end if;
  insert into public.credit_balances (merchant_id, credit_type) values (p_merchant, p_type) on conflict do nothing;
  perform 1 from public.credit_balances where merchant_id = p_merchant and credit_type = p_type for update;
  -- A concurrent duplicate may have finished while we waited for the lock.
  select * into e from public.credit_ledger where merchant_id = p_merchant and idempotency_key = p_key;
  if e.id is not null then
    return e;
  end if;
  perform public._credit_expire(p_merchant, p_type);
  select balance into v_bal from public.credit_balances where merchant_id = p_merchant and credit_type = p_type;

  if p_amount < 0 then
    if v_bal + p_amount < 0 then
      raise exception 'INSUFFICIENT_CREDITS: % % available, % needed', v_bal, (select name from public.credit_types where code = p_type), -p_amount
        using errcode = 'P0001';
    end if;
    insert into public.credit_ledger (merchant_id, credit_type, kind, amount, balance_after, reason, actor_id, actor_kind, reference_type, reference_id,
      idempotency_key, metadata)
    values (p_merchant, p_type, p_kind, p_amount, v_bal + p_amount, p_reason, p_actor, p_actor_kind, p_ref_type, p_ref_id, p_key, coalesce(p_metadata, '{}'::jsonb))
    returning * into e;
    v_need := -p_amount;
    for l in select * from public.credit_lots
             where merchant_id = p_merchant and credit_type = p_type and remaining > 0 and (expires_at is null or expires_at > now())
             order by expires_at nulls last, id for update loop
      v_take := least(l.remaining, v_need);
      update public.credit_lots set remaining = remaining - v_take where id = l.id;
      insert into public.credit_lot_usage (merchant_id, entry_id, lot_id, amount) values (p_merchant, e.id, l.id, v_take);
      v_need := v_need - v_take;
      exit when v_need = 0;
    end loop;
    if v_need > 0 then
      raise exception 'credits: balance and lots disagree for % %', p_merchant, p_type;
    end if;
  else
    insert into public.credit_ledger (merchant_id, credit_type, kind, amount, balance_after, reason, actor_id, actor_kind, reference_type, reference_id,
      idempotency_key, expires_at, metadata)
    values (p_merchant, p_type, p_kind, p_amount, v_bal + p_amount, p_reason, p_actor, p_actor_kind, p_ref_type, p_ref_id, p_key, p_expires_at,
            coalesce(p_metadata, '{}'::jsonb))
    returning * into e;
    if p_kind = 'REFUND' and (p_metadata ->> 'refund_of') is not null then
      for u in select lu.lot_id, lu.amount from public.credit_lot_usage lu where lu.entry_id = (p_metadata ->> 'refund_of')::bigint order by lu.lot_id loop
        exit when v_restored >= p_amount;
        update public.credit_lots set remaining = remaining + least(u.amount, p_amount - v_restored) where id = u.lot_id;
        v_restored := v_restored + least(u.amount, p_amount - v_restored);
      end loop;
    end if;
    if v_restored < p_amount then
      insert into public.credit_lots (merchant_id, credit_type, entry_id, granted, remaining, expires_at)
      values (p_merchant, p_type, e.id, p_amount - v_restored, p_amount - v_restored, p_expires_at);
    end if;
  end if;
  update public.credit_balances set balance = e.balance_after, updated_at = now() where merchant_id = p_merchant and credit_type = p_type;
  -- Restored credits whose lot has expired meanwhile are written off straight away.
  if v_restored > 0 then
    perform public._credit_expire(p_merchant, p_type);
  end if;
  return e;
end;
$$;

-- Hourly (from billing_run): expired promotional credits are written off.
create or replace function public.credits_expire_all()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  v_n int := 0;
begin
  for r in select distinct merchant_id, credit_type from public.credit_lots where remaining > 0 and expires_at <= now() loop
    perform 1 from public.credit_balances where merchant_id = r.merchant_id and credit_type = r.credit_type for update;
    v_n := v_n + public._credit_expire(r.merchant_id, r.credit_type);
  end loop;
  return v_n;
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. Usage policies, merchant exceptions and usage records
-- -----------------------------------------------------------------------------
insert into public.platform_settings (key, value, description) values
  ('usage.sms', jsonb_build_object(
     'free', jsonb_build_object('enabled', true, 'limit', 20, 'period', 'ONCE', 'plans', '[]'::jsonb, 'statuses', jsonb_build_array('ACTIVE')),
     'unit', 'SEGMENT', 'after_free', 'CREDITS', 'credits_per_unit', 1, 'monthly_cap', null,
     'unmetered_plans', jsonb_build_array('FOUNDER'), 'refund_undelivered', false, 'hold_hours', 6),
   'SMS: free allowance, who gets it, what counts as one use, charging after the allowance, caps'),
  ('usage.bd_courier', jsonb_build_object(
     'free', jsonb_build_object('enabled', true, 'limit', 5, 'period', 'MONTH', 'plans', '[]'::jsonb, 'statuses', jsonb_build_array('ACTIVE')),
     'unit', 'LOOKUP', 'after_free', 'CREDITS', 'credits_per_unit', 1, 'monthly_cap', 2000,
     'unmetered_plans', jsonb_build_array('FOUNDER')),
   'BD Courier lookups: free allowance, who gets it, charging after the allowance, caps'),
  ('credits', jsonb_build_object('approval_threshold', 1000),
   'Manual credit changes larger than this need a second person to approve'),
  ('sms', jsonb_build_object('connected', false, 'provider', null, 'hint', null, 'sender_id', '', 'sender_ids', '[]'::jsonb,
     'cost_per_segment', 0.25, 'balance', null),
   'The platform SMS provider (credentials are in platform credentials, never here)'),
  ('bd_courier', jsonb_build_object('connected', false, 'service', null, 'hint', null),
   'The platform BD Courier connection (the key is in platform credentials, never here)'),
  ('billing_gateways', jsonb_build_object('bkash', jsonb_build_object('enabled', false, 'sandbox', true),
     'paystation', jsonb_build_object('enabled', false, 'sandbox', true)),
   'Gateways merchants use to pay invoices and buy credits (platform accounts)')
on conflict (key) do nothing;

create table public.merchant_service_overrides (
  merchant_id uuid not null references public.merchants(id),
  service text not null check (service in ('SMS', 'BD_COURIER')),
  -- null keeps the policy's value.
  free_limit int check (free_limit >= 0),
  monthly_cap int check (monthly_cap >= 0),
  sender_id text check (sender_id ~ '^[A-Za-z0-9 ._+-]{1,20}$'),
  reason text not null,
  set_by uuid,
  set_at timestamptz not null default now(),
  primary key (merchant_id, service)
);

create table public.service_usage (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id),
  service text not null check (service in ('SMS', 'BD_COURIER')),
  units int not null check (units > 0),
  -- RESERVED: allowed and charged, waiting for the outcome. SUCCEEDED: done.
  -- FAILED: did not happen; any credits went back. DENIED: refused by policy.
  status text not null check (status in ('RESERVED', 'SUCCEEDED', 'FAILED', 'DENIED')),
  charge text not null check (charge in ('FREE', 'CREDITS', 'PLAN', 'NONE')),
  credits int not null default 0 check (credits >= 0),
  credit_type text references public.credit_types(code),
  ledger_entry_id bigint references public.credit_ledger(id),
  refunded_at timestamptz,
  -- SMS delivery report: DELIVERED / UNDELIVERED.
  outcome text check (outcome in ('DELIVERED', 'UNDELIVERED')),
  denied_reason text,
  error text,
  reference text,
  idempotency_key text not null,
  provider_cost numeric(10, 4),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (merchant_id, idempotency_key)
);
create index service_usage_merchant_idx on public.service_usage (merchant_id, service, created_at desc);
create index service_usage_created_idx on public.service_usage (service, created_at desc);

do $$
declare
  t text;
begin
  foreach t in array array['credit_balances', 'credit_ledger', 'credit_lots', 'credit_lot_usage', 'merchant_service_overrides', 'service_usage'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format($p$create policy tenant_isolation on public.%I as restrictive for all to public
      using (merchant_id = (select public.current_merchant_id())) with check (merchant_id = (select public.current_merchant_id()))$p$, t);
    execute format('create policy app_owner_read on public.%I for select to app_owner using (true)', t);
    execute format($p$create policy staff_read on public.%I for select to authenticated using ((select public.is_staff()))$p$, t);
    execute format('revoke insert, update, delete, truncate on public.%I from anon, authenticated', t);
  end loop;
end $$;
alter table public.credit_types enable row level security;
alter table public.credit_packages enable row level security;
create policy credit_types_read on public.credit_types for select to authenticated, app_owner using (true);
create policy credit_packages_read on public.credit_packages for select to authenticated using (status = 'ACTIVE');
revoke insert, update, delete, truncate on public.credit_types, public.credit_packages from anon, authenticated;

create or replace function public._tenancy_global_tables()
returns text[]
language sql
immutable
as $$
  select array['permissions', 'order_status_transitions', 'pbx_packages', 'pbx_gateway_status',
               'merchants', 'platform_staff', 'support_sessions', 'tenancy_exempt_functions',
               'platform_settings', 'platform_audit_logs', 'platform_credentials',
               'platform_modules', 'platform_roles', 'platform_role_permissions', 'platform_staff_merchants',
               'merchant_notes', 'platform_approvals', 'config_versions', 'features', 'plans', 'plan_addons',
               'credit_types', 'credit_packages']
$$;

create or replace function public._usage_feature(p_service text)
returns text
language sql
immutable
as $$
  select case p_service when 'SMS' then 'sms' when 'BD_COURIER' then 'courier_history' end
$$;

create or replace function public._usage_policy(p_service text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select value from public.platform_settings where key = 'usage.' || lower(p_service)), '{}'::jsonb)
$$;

-- Everything that decides whether one more use is allowed, and how it is paid.
create or replace function public._usage_state(p_merchant uuid, p_service text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_policy jsonb := public._usage_policy(p_service);
  v_free jsonb := coalesce(v_policy -> 'free', '{}'::jsonb);
  o public.merchant_service_overrides;
  v_ent jsonb := public.merchant_entitlements(p_merchant) -> public._usage_feature(p_service);
  v_plan text;
  v_sub_status text;
  v_mode text := public.merchant_access_mode(p_merchant);
  v_tz text := coalesce((select timezone from public.merchants where id = p_merchant), 'Asia/Dhaka');
  v_month timestamptz;
  v_type text := case p_service when 'SMS' then 'SMS' else 'COURIER' end;
  v_eligible boolean;
  v_limit int;
  v_used int;
  v_month_used int;
  v_cap int;
begin
  v_month := date_trunc('month', now() at time zone v_tz) at time zone v_tz;
  select * into o from public.merchant_service_overrides where merchant_id = p_merchant and service = p_service;
  select p.code, s.status into v_plan, v_sub_status
  from public.subscriptions s join public.plans p on p.id = s.plan_id where s.merchant_id = p_merchant and s.ended_at is null;
  v_limit := coalesce(o.free_limit, nullif(v_free ->> 'limit', '')::int, 0);
  -- An explicit merchant limit is a decision for that merchant; otherwise plan and status decide.
  v_eligible := v_mode <> 'BLOCKED' and (
    o.free_limit is not null
    or (coalesce((v_free ->> 'enabled')::boolean, false)
        and (jsonb_array_length(coalesce(v_free -> 'plans', '[]'::jsonb)) = 0 or (v_free -> 'plans') ? coalesce(v_plan, ''))
        and coalesce(v_free -> 'statuses', '["ACTIVE"]'::jsonb) ? coalesce(v_sub_status, 'NONE')));
  select coalesce(sum(units) filter (where charge = 'FREE' and (v_free ->> 'period' = 'ONCE' or created_at >= v_month)), 0),
         coalesce(sum(units) filter (where created_at >= v_month), 0)
  into v_used, v_month_used
  from public.service_usage
  where merchant_id = p_merchant and service = p_service and status in ('RESERVED', 'SUCCEEDED') and refunded_at is null;
  v_cap := coalesce(o.monthly_cap, nullif(v_policy ->> 'monthly_cap', '')::int);
  return jsonb_build_object(
    'service', p_service,
    'feature', public._usage_feature(p_service),
    'feature_state', coalesce(v_ent ->> 'state', 'NOT_IN_PLAN'),
    'feature_enabled', coalesce((v_ent ->> 'enabled')::boolean, false),
    'plan', v_plan,
    'subscription_status', v_sub_status,
    'access_mode', v_mode,
    'unmetered', coalesce(v_policy -> 'unmetered_plans', '[]'::jsonb) ? coalesce(v_plan, ''),
    'unit', coalesce(v_policy ->> 'unit', case p_service when 'SMS' then 'SEGMENT' else 'LOOKUP' end),
    'free', jsonb_build_object('eligible', v_eligible, 'limit', v_limit, 'used', v_used,
      'remaining', case when v_eligible then greatest(v_limit - v_used, 0) else 0 end,
      'period', coalesce(v_free ->> 'period', 'MONTH'), 'merchant_limit', o.free_limit),
    'month_used', v_month_used,
    'monthly_cap', v_cap,
    'after_free', coalesce(v_policy ->> 'after_free', 'CREDITS'),
    'credits_per_unit', coalesce((v_policy ->> 'credits_per_unit')::int, 1),
    'credit_type', v_type,
    'credits_available', public.credit_available(p_merchant, v_type),
    'sender_id', o.sender_id);
end;
$$;

-- Allows (and charges) one metered use, or refuses it with a reason. The same
-- key twice returns the first answer. Uses for one merchant and service are
-- decided one at a time, so parallel requests cannot share the last free use.
create or replace function public._usage_charge(p_merchant uuid, p_service text, p_units int, p_key text, p_reference text,
  p_record_denial boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  st jsonb;
  u public.service_usage;
  e public.credit_ledger;
  v_reason text;
  v_message text;
  v_charge text;
  v_credits int := 0;
  v_name text := case p_service when 'SMS' then 'SMS' else 'BD Courier check' end;
begin
  if p_units is null or p_units < 1 then
    raise exception 'VALIDATION: units must be at least 1' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_merchant::text || ':' || p_service, 0));
  select * into u from public.service_usage where merchant_id = p_merchant and idempotency_key = p_key;
  if u.id is not null then
    return jsonb_build_object('allowed', u.status in ('RESERVED', 'SUCCEEDED'), 'usage_id', u.id, 'charge', u.charge, 'credits', u.credits,
      'reason', u.denied_reason, 'duplicate', true);
  end if;
  st := public._usage_state(p_merchant, p_service);
  if not (st ->> 'feature_enabled')::boolean then
    v_reason := 'FEATURE_OFF';
    v_message := format('%s is %s', v_name, case st ->> 'feature_state'
      when 'NOT_IN_PLAN' then 'not included in this plan' when 'DISABLED_GLOBALLY' then 'switched off by the platform'
      when 'DISABLED_FOR_MERCHANT' then 'switched off for this account' else 'not available' end);
  elsif st ->> 'access_mode' = 'BLOCKED' then
    v_reason := 'ACCOUNT_RESTRICTED';
    v_message := 'The account is restricted';
  elsif (st ->> 'monthly_cap') is not null and (st ->> 'month_used')::int + p_units > (st ->> 'monthly_cap')::int then
    v_reason := 'LIMIT_REACHED';
    v_message := format('The monthly limit of %s %s is reached', st ->> 'monthly_cap', lower(v_name));
  elsif (st ->> 'unmetered')::boolean then
    v_charge := 'PLAN';
  elsif (st #>> '{free,remaining}')::int >= p_units then
    v_charge := 'FREE';
  elsif st ->> 'after_free' = 'BLOCK' then
    v_reason := 'FREE_LIMIT_REACHED';
    v_message := 'The free allowance is used up';
  elsif (st ->> 'credits_per_unit')::int = 0 then
    v_charge := 'NONE';
  else
    v_credits := p_units * (st ->> 'credits_per_unit')::int;
    if (st ->> 'credits_available')::int < v_credits then
      v_reason := 'NO_CREDITS';
      v_message := format('Not enough %s credits (%s needed, %s available)', lower(st ->> 'credit_type'), v_credits, st ->> 'credits_available');
    else
      v_charge := 'CREDITS';
    end if;
  end if;

  if v_reason is not null then
    if p_record_denial then
      insert into public.service_usage (merchant_id, service, units, status, charge, denied_reason, error, reference, idempotency_key, finished_at)
      values (p_merchant, p_service, p_units, 'DENIED', 'NONE', v_reason, v_message, p_reference, p_key, now())
      returning * into u;
    end if;
    return jsonb_build_object('allowed', false, 'usage_id', u.id, 'reason', v_reason, 'message', v_message);
  end if;

  insert into public.service_usage (merchant_id, service, units, status, charge, credits, credit_type, reference, idempotency_key)
  values (p_merchant, p_service, p_units, 'RESERVED', v_charge, v_credits, case when v_charge = 'CREDITS' then st ->> 'credit_type' end, p_reference, p_key)
  returning * into u;
  if v_charge = 'CREDITS' then
    e := public._credit_post(p_merchant, st ->> 'credit_type', -v_credits, 'USAGE', v_name, null, 'SYSTEM', 'service_usage', u.id::text, 'usage:' || u.id);
    update public.service_usage set ledger_entry_id = e.id where id = u.id;
  end if;
  return jsonb_build_object('allowed', true, 'usage_id', u.id, 'charge', v_charge, 'credits', v_credits);
end;
$$;

-- Gives back the credits of a use that did not happen (once).
create or replace function public._usage_refund(u public.service_usage, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if u.refunded_at is not null then
    return;
  end if;
  if u.charge = 'CREDITS' and u.credits > 0 and u.ledger_entry_id is not null then
    perform public._credit_post(u.merchant_id, u.credit_type, u.credits, 'REFUND', p_reason, null, 'SYSTEM', 'service_usage', u.id::text,
      'refund:' || u.id, null, jsonb_build_object('refund_of', u.ledger_entry_id));
  end if;
  update public.service_usage set refunded_at = now() where id = u.id;
end;
$$;

create or replace function public._usage_finish(p_usage uuid, p_success boolean, p_error text default null, p_provider_cost numeric default null,
  p_outcome text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  u public.service_usage;
begin
  select * into u from public.service_usage where id = p_usage for update;
  if u.id is null or u.status <> 'RESERVED' then
    return;
  end if;
  if p_success then
    update public.service_usage set status = 'SUCCEEDED', finished_at = now(),
      provider_cost = case when p_provider_cost >= 0 then p_provider_cost else provider_cost end, outcome = coalesce(p_outcome, outcome)
    where id = u.id;
  else
    update public.service_usage set status = 'FAILED', finished_at = now(), error = left(p_error, 500) where id = u.id;
    perform public._usage_refund(u, case u.service when 'SMS' then 'SMS not sent' else 'BD Courier check failed' end);
  end if;
end;
$$;

-- A delivery report for a sent SMS; undelivered ones are refunded when the policy says so.
create or replace function public._usage_outcome(p_usage uuid, p_outcome text, p_provider_cost numeric default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  u public.service_usage;
begin
  select * into u from public.service_usage where id = p_usage for update;
  if u.id is null or u.status <> 'SUCCEEDED' or p_outcome not in ('DELIVERED', 'UNDELIVERED') then
    return;
  end if;
  update public.service_usage set outcome = p_outcome,
    provider_cost = case when p_provider_cost >= 0 then p_provider_cost else provider_cost end
  where id = u.id;
  if p_outcome = 'UNDELIVERED' and coalesce((public._usage_policy(u.service) ->> 'refund_undelivered')::boolean, false) then
    perform public._usage_refund(u, 'SMS not delivered');
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. BD Courier lookups go through the gate
-- -----------------------------------------------------------------------------
-- Called by the edge functions (service role, merchant named in the request)
-- right before a lookup reaches BD Courier, and right after it.
create or replace function public.courier_lookup_begin(p_phone text, p_key text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_merchant uuid := public.current_merchant_id();
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if v_merchant is null then
    raise exception 'MERCHANT_REQUIRED: no merchant for this request' using errcode = 'P0001';
  end if;
  if coalesce(p_key, '') !~ '^[A-Za-z0-9-]{8,64}$' then
    raise exception 'VALIDATION: bad request key' using errcode = '22023';
  end if;
  return public._usage_charge(v_merchant, 'BD_COURIER', 1, 'bd:' || p_key, public._mask_phone(coalesce(public.clean_phone(p_phone), p_phone)));
end;
$$;

create or replace function public.courier_lookup_finish(p_usage uuid, p_success boolean, p_error text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if not exists (select 1 from public.service_usage where id = p_usage and merchant_id = public.current_merchant_id() and service = 'BD_COURIER') then
    raise exception 'NOT_FOUND: usage not found' using errcode = 'P0002';
  end if;
  perform public._usage_finish(p_usage, p_success, p_error);
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. SMS through the platform provider, charged by the SMS policy
-- -----------------------------------------------------------------------------
create or replace function public._platform_sms_provider()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when (value ->> 'connected')::boolean then value ->> 'provider' end from public.platform_settings where key = 'sms'
$$;

-- The sender ID a merchant's SMS go out with: its own approved one, else the platform default.
create or replace function public._sms_sender_for(p_merchant uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select sender_id from public.merchant_service_overrides where merchant_id = p_merchant and service = 'SMS'),
                  (select nullif(value ->> 'sender_id', '') from public.platform_settings where key = 'sms'))
$$;

create or replace function public._platform_service_connected(p_service text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select (value ->> 'connected')::boolean from public.platform_settings
                   where key = case p_service when 'SMS' then 'sms' else 'bd_courier' end), false)
$$;

-- What the dispatcher needs: the platform provider and this merchant's sender ID. No secrets.
create or replace function public.sms_dispatch_config()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb := coalesce((select value from public.platform_settings where key = 'sms'), '{}'::jsonb);
  v_merchant uuid := public.current_merchant_id();
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'connected', coalesce((v ->> 'connected')::boolean, false),
    'provider', v ->> 'provider',
    'sender_id', public._sms_sender_for(v_merchant),
    'enabled', case when v_merchant is null then true else public.setting_bool('sms', array['enabled'], false) end);
end;
$$;

-- Reserves (charges) one queued SMS. Free uses cost the merchant nothing; paid
-- ones are valued at the merchant's own "cost per SMS credit" for Finance.
create or replace function public._sms_reserve(r public.notification_logs)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_policy jsonb := public._usage_policy('SMS');
  v_units int := case when v_policy ->> 'unit' = 'MESSAGE' then 1 else greatest(coalesce(r.segments, 1), 1) end;
  v jsonb;
begin
  v := public._usage_charge(r.merchant_id, 'SMS', v_units, 'sms:' || r.id, r.id::text, false);
  if (v ->> 'allowed')::boolean and not coalesce((v ->> 'duplicate')::boolean, false) then
    update public.notification_logs set
      cost = case v ->> 'charge'
        when 'FREE' then 0 when 'NONE' then 0
        when 'CREDITS' then round((v ->> 'credits')::int * greatest(public.setting_numeric('sms', array['cost_per_sms'], 0.35), 0), 4)
        else cost end,
      cost_source = 'ESTIMATE'
    where id = r.id;
  end if;
  return v;
end;
$$;

create or replace function public.claim_notifications(p_limit integer default 20)
returns setof public.notification_logs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.notification_logs;
  v jsonb;
  v_out public.notification_logs;
  v_hold int := coalesce((public._usage_policy('SMS') ->> 'hold_hours')::int, 6);
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  -- Interrupted while sending: we cannot know whether it went out, so it stays charged.
  update public.notification_logs set status = 'FAILED',
    error = 'Sending was interrupted. Check with the provider before trying again.'
  where status = 'SENDING' and updated_at < now() - interval '15 minutes';
  for r in
    select * from public.notification_logs
    where status = 'QUEUED' and next_attempt_at <= now()
    order by next_attempt_at
    limit least(greatest(p_limit, 1), 100)
    for update skip locked
  loop
    if r.channel = 'SMS' then
      v := public._sms_reserve(r);
      if not (v ->> 'allowed')::boolean then
        if v ->> 'reason' = 'NO_CREDITS' and r.created_at > now() - make_interval(hours => v_hold) then
          -- Waits for credits (sent as soon as there are some), up to the policy's hold time.
          update public.notification_logs set next_attempt_at = now() + interval '10 minutes', error = 'Waiting for SMS credits: ' || (v ->> 'message')
          where id = r.id;
        else
          update public.notification_logs set status = 'FAILED', error = left(coalesce(v ->> 'message', v ->> 'reason'), 1000) where id = r.id;
        end if;
        continue;
      end if;
    end if;
    update public.notification_logs set status = 'SENDING', attempts = attempts + 1 where id = r.id returning * into v_out;
    return next v_out;
  end loop;
end;
$$;

create or replace function public.complete_notification(p_id uuid, p_success boolean, p_provider text, p_provider_message_id text, p_error text,
  p_cost numeric default null, p_permanent boolean default false, p_delivery_status text default null)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_log public.notification_logs;
  u public.service_usage;
  -- Provider charges are the platform's cost; only unmetered (own-business) accounts see them as their cost.
  v_own_cost boolean;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select * into u from public.service_usage s
  where s.merchant_id = (select merchant_id from public.notification_logs where id = p_id) and s.idempotency_key = 'sms:' || p_id;
  v_own_cost := u.id is null or u.charge = 'PLAN';
  update public.notification_logs set
    status = case when p_success then 'SENT' when p_permanent or attempts >= 3 then 'FAILED' else 'QUEUED' end::public.notification_status,
    provider = coalesce(p_provider, provider),
    provider_message_id = case when p_success then left(p_provider_message_id, 120) else provider_message_id end,
    error = case when p_success then null else left(p_error, 1000) end,
    sent_at = case when p_success then now() else sent_at end,
    next_attempt_at = case when p_success then next_attempt_at else now() + make_interval(mins => 5 * attempts) end,
    cost = case when p_success and v_own_cost and p_cost is not null and p_cost >= 0 then p_cost else cost end,
    cost_source = case when p_success and v_own_cost and p_cost is not null and p_cost >= 0 then 'PROVIDER' else cost_source end,
    delivery_status = case
      when p_success and channel = 'SMS' then
        case when p_delivery_status in ('PENDING', 'DELIVERED', 'FAILED', 'UNKNOWN') then p_delivery_status else 'UNKNOWN' end
      else delivery_status end,
    delivered_at = case when p_success and p_delivery_status = 'DELIVERED' then now() else delivered_at end
  where id = p_id and status = 'SENDING'
  returning * into v_log;
  if v_log.id is null then
    return null;
  end if;
  if u.id is not null then
    if v_log.status = 'SENT' then
      perform public._usage_finish(u.id, true, null, p_cost, case when p_delivery_status = 'DELIVERED' then 'DELIVERED' end);
    elsif v_log.status = 'FAILED' then
      perform public._usage_finish(u.id, false, p_error);
    end if;
  end if;
  if v_log.status = 'SENT' then
    perform public._post_sms_finance(p_id);
  end if;
  return v_log.status::text;
end;
$$;

create or replace function public.record_sms_delivery(p_id uuid, p_status text, p_cost numeric default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_log public.notification_logs;
  u public.service_usage;
  v_own_cost boolean;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select * into v_log from public.notification_logs where id = p_id and channel = 'SMS' and status = 'SENT';
  if v_log.id is null then
    return;
  end if;
  select * into u from public.service_usage where merchant_id = v_log.merchant_id and idempotency_key = 'sms:' || p_id;
  v_own_cost := u.id is null or u.charge = 'PLAN';
  update public.notification_logs set
    delivery_status = case when p_status in ('PENDING', 'DELIVERED', 'FAILED', 'UNKNOWN') then p_status else delivery_status end,
    delivered_at = case when p_status = 'DELIVERED' then coalesce(delivered_at, now()) else delivered_at end,
    status_checked_at = now(),
    cost = case when v_own_cost and p_cost is not null and p_cost >= 0 then p_cost else cost end,
    cost_source = case when v_own_cost and p_cost is not null and p_cost >= 0 then 'PROVIDER' else cost_source end
  where id = p_id;
  if u.id is not null and p_status in ('DELIVERED', 'FAILED') then
    perform public._usage_outcome(u.id, case p_status when 'DELIVERED' then 'DELIVERED' else 'UNDELIVERED' end, p_cost);
  end if;
  perform public._post_sms_finance(p_id);
end;
$$;

-- A test message from the merchant's SMS page: same provider, same charging.
create or replace function public.sms_log_test(p_to text, p_body text, p_actor uuid)
returns public.notification_logs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_to text := public.sms_phone(p_to);
  v_parts record;
  v_row public.notification_logs;
  v jsonb;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if v_to is null then
    raise exception 'VALIDATION: enter a Bangladesh mobile number (01XXXXXXXXX)' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_body, ''))) = 0 or length(p_body) > 1000 then
    raise exception 'VALIDATION: write a message of up to 1000 characters' using errcode = '22023';
  end if;
  if (select count(*) from public.notification_logs where purpose = 'TEST' and created_at > now() - interval '1 hour') >= 20 then
    raise exception 'VALIDATION: 20 test messages were sent in the last hour; try again later' using errcode = '22023';
  end if;
  select * into v_parts from public.sms_parts(p_body);
  insert into public.notification_logs(event, channel, recipient, body, status, attempts, purpose, segments, encoding,
    cost, cost_source, provider, created_by)
  values (null, 'SMS', v_to, p_body, 'SENDING', 1, 'TEST', v_parts.segments, v_parts.encoding,
    round(v_parts.segments * greatest(public.setting_numeric('sms', array['cost_per_sms'], 0.35), 0), 4), 'ESTIMATE',
    public._platform_sms_provider(), p_actor)
  returning * into v_row;
  v := public._sms_reserve(v_row);
  if not (v ->> 'allowed')::boolean then
    raise exception 'VALIDATION: %', v ->> 'message' using errcode = '22023';
  end if;
  select * into v_row from public.notification_logs where id = v_row.id;
  return v_row;
end;
$$;

-- The provider is the platform's now: these merchant-side connection changes are gone.
create or replace function public.sms_set_connection(p_provider text, p_hint text, p_sender_id text, p_balance numeric, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception 'VALIDATION: the SMS provider is managed by the platform' using errcode = '22023';
end;
$$;

create or replace function public.sms_set_balance(p_balance numeric)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception 'VALIDATION: the SMS provider is managed by the platform' using errcode = '22023';
end;
$$;

-- Merchant SMS settings: automatic SMS on/off and how Finance values one SMS credit.
create or replace function public.sms_update_settings(p_enabled boolean default null, p_sender_id text default null, p_cost_per_sms numeric default null,
  p_currency_text text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_patch jsonb := '{}'::jsonb;
  v_value jsonb;
begin
  perform public.require_permission('sms.manage');
  if p_sender_id is not null then
    raise exception 'VALIDATION: the sender ID is set by the platform; ask support to change it' using errcode = '22023';
  end if;
  if p_enabled is not null then
    if p_enabled then
      perform public.require_feature('sms');
      if public._platform_sms_provider() is null then
        raise exception 'VALIDATION: SMS is not available on the platform right now' using errcode = '22023';
      end if;
    end if;
    v_patch := v_patch || jsonb_build_object('enabled', p_enabled);
  end if;
  if p_cost_per_sms is not null then
    if p_cost_per_sms < 0 or p_cost_per_sms > 20 then
      raise exception 'VALIDATION: the cost per SMS must be between 0 and 20' using errcode = '22023';
    end if;
    v_patch := v_patch || jsonb_build_object('cost_per_sms', round(p_cost_per_sms, 4));
  end if;
  if p_currency_text is not null then
    if length(trim(p_currency_text)) > 6 then
      raise exception 'VALIDATION: the currency text can be up to 6 characters' using errcode = '22023';
    end if;
    v_patch := v_patch || jsonb_build_object('currency_text', trim(p_currency_text));
  end if;
  update public.settings set value = value || v_patch, updated_by = auth.uid()
  where key = 'sms' returning value into v_value;
  perform public.log_audit('sms.settings_changed', 'settings', 'sms', null, v_patch);
  return v_value;
end;
$$;

create or replace function public.sms_overview(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings jsonb := public.get_setting('sms');
  v_merchant uuid := public.current_merchant_id();
  v_result jsonb;
begin
  perform public.require_permission('sms.view');
  with l as (
    select * from public.notification_logs
    where channel = 'SMS'
      and (created_at at time zone public.store_timezone())::date between p_from and p_to
  )
  select jsonb_build_object(
    'settings', jsonb_build_object(
      'enabled', coalesce((v_settings ->> 'enabled')::boolean, false),
      -- Provided by the platform: merchants see whether it works and their sender ID, never the provider account.
      'connected', public._platform_sms_provider() is not null,
      'provided_by_platform', true,
      'sender_id', coalesce(public._sms_sender_for(v_merchant), ''),
      'cost_per_sms', coalesce((v_settings ->> 'cost_per_sms')::numeric, 0),
      'currency_text', coalesce(v_settings ->> 'currency_text', 'Tk')),
    'usage', public._usage_state(v_merchant, 'SMS'),
    'policy', jsonb_build_object('refund_undelivered', coalesce((public._usage_policy('SMS') ->> 'refund_undelivered')::boolean, false),
      'hold_hours', coalesce((public._usage_policy('SMS') ->> 'hold_hours')::int, 6)),
    'totals', (select jsonb_build_object(
      'sent', count(*) filter (where status = 'SENT'),
      'failed', count(*) filter (where status = 'FAILED'),
      'waiting', count(*) filter (where status in ('QUEUED', 'SENDING')),
      'waiting_credits', count(*) filter (where status = 'QUEUED' and error like 'Waiting for SMS credits%'),
      'skipped', count(*) filter (where status = 'SKIPPED'),
      'parts', coalesce(sum(segments) filter (where status = 'SENT'), 0),
      'cost', coalesce(sum(cost) filter (where status = 'SENT'), 0),
      'delivered', count(*) filter (where status = 'SENT' and delivery_status = 'DELIVERED'),
      'undelivered', count(*) filter (where status = 'SENT' and delivery_status = 'FAILED'),
      'awaiting_report', count(*) filter (where status = 'SENT' and delivery_status = 'PENDING'),
      'orders', count(distinct order_id) filter (where status = 'SENT')) from l),
    'by_event', coalesce((select jsonb_agg(x order by x.sent desc, x.event) from (
      select coalesce(event::text, 'TEST') as event,
             count(*) filter (where status = 'SENT') as sent,
             count(*) filter (where status = 'FAILED') as failed,
             coalesce(sum(segments) filter (where status = 'SENT'), 0) as parts,
             coalesce(sum(cost) filter (where status = 'SENT'), 0) as cost
      from l group by 1) x), '[]'::jsonb),
    'active_rules', (select count(*) from public.notifications where channel = 'SMS' and is_enabled)
  ) into v_result;
  return v_result;
end;
$$;

-- Queueing: the platform provider's name, and nothing queued while SMS is off for the account.
do $$
declare
  v_old text := pg_get_functiondef('public._enqueue_order_notification(uuid,public.notification_event,text,jsonb)'::regprocedure);
  v_new text;
begin
  v_new := replace(v_old, $o$public.setting_text('sms', array['provider'], null)$o$, $n$public._platform_sms_provider()$n$);
  v_new := replace(v_new, $o$        if not public.setting_bool('sms', array['enabled'], false) then$o$,
                          $n$        if not public.setting_bool('sms', array['enabled'], false) or not public.feature_enabled('sms') then$n$);
  if v_new = v_old or position('_platform_sms_provider' in v_new) = 0 or position($p$feature_enabled('sms')$p$ in v_new) = 0 then
    raise exception 'credits: _enqueue_order_notification has changed';
  end if;
  execute v_new;
end $$;

-- A free SMS is not an expense.
do $$
declare
  v_old text := pg_get_functiondef('public._post_sms_finance(uuid)'::regprocedure);
  v_new text;
begin
  v_new := replace(v_old, $o$v_log.status <> 'SENT' or v_log.cost is null then$o$, $n$v_log.status <> 'SENT' or v_log.cost is null or v_log.cost <= 0 then$n$);
  if v_new = v_old then
    raise exception 'credits: _post_sms_finance has changed';
  end if;
  execute v_new;
end $$;

-- Integrations page: SMS is provided by the platform.
do $$
declare
  v_old text := pg_get_functiondef('public.integrations_overview()'::regprocedure);
  v_new text;
begin
  v_new := replace(v_old,
    $o$'sms', (select jsonb_build_object('provider', value ->> 'provider', 'enabled', value -> 'enabled') from public.settings where key = 'sms'),$o$,
    $n$'sms', (select jsonb_build_object('provided_by_platform', true, 'connected', public._platform_sms_provider() is not null, 'enabled', value -> 'enabled')
             from public.settings where key = 'sms'),
    'bd_courier', jsonb_build_object('provided_by_platform', true,
      'connected', public._platform_service_connected('BD_COURIER'),
      'enabled', public.feature_enabled('courier_history')),$n$);
  if v_new = v_old then
    raise exception 'credits: integrations_overview has changed';
  end if;
  execute v_new;
end $$;

-- -----------------------------------------------------------------------------
-- 5. Recharge and gateway payments to the platform
-- -----------------------------------------------------------------------------
alter table public.billing_payments
  add column provider_session text,
  add column provider_txn_id text;
create unique index billing_payments_session_uq on public.billing_payments (provider, provider_session) where provider_session is not null;
-- One gateway transaction pays one payment, however often its callback arrives.
create unique index billing_payments_txn_uq on public.billing_payments (provider, provider_txn_id) where provider_txn_id is not null and status = 'SUCCEEDED';

-- Credits bought with an invoice, granted once per invoice line.
create or replace function public._billing_grant_credits(p_inv public.billing_invoices)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  l record;
begin
  for l in select x.line, x.n from jsonb_array_elements(p_inv.lines) with ordinality as x(line, n) where x.line ->> 'kind' = 'credits' loop
    perform public._credit_post(p_inv.merchant_id, l.line ->> 'credit_type', (l.line ->> 'credits')::int, 'RECHARGE',
      'Bought ' || coalesce(l.line ->> 'label', 'credits'), null, 'SYSTEM', 'billing_invoice', p_inv.id::text,
      'invoice:' || p_inv.id || ':' || l.n, null, jsonb_build_object('invoice', p_inv.number, 'package_id', l.line ->> 'package_id'));
  end loop;
end;
$$;

-- A verified payment (gateway confirmation, or a manual one verified by a
-- second person): pays the invoice when covered; a subscription period starts,
-- bought credits arrive.
create or replace function public._billing_apply_payment(p_payment public.billing_payments)
returns public.billing_invoices
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inv public.billing_invoices;
  s public.subscriptions;
begin
  select * into v_inv from public.billing_invoices where id = p_payment.invoice_id for update;
  if v_inv.status <> 'OPEN' then
    return v_inv;
  end if;
  update public.billing_invoices set amount_paid = amount_paid + p_payment.amount,
    status = case when amount_paid + p_payment.amount >= total then 'PAID' else status end,
    paid_at = case when amount_paid + p_payment.amount >= total then now() else paid_at end
  where id = v_inv.id returning * into v_inv;
  if v_inv.status = 'PAID' and v_inv.kind = 'SUBSCRIPTION' then
    select * into s from public.subscriptions where id = v_inv.subscription_id for update;
    if s.id is not null and s.ended_at is null and s.status in ('TRIALING', 'PAST_DUE', 'ACTIVE') then
      update public.subscriptions set status = 'ACTIVE', grace_until = null, trial_ends_at = case when s.status = 'TRIALING' then now() else trial_ends_at end,
        current_period_start = greatest(coalesce(current_period_start, v_inv.period_start), v_inv.period_start),
        current_period_end = greatest(coalesce(current_period_end, v_inv.period_end), v_inv.period_end)
      where id = s.id returning * into s;
      perform public._subscription_event(s, 'invoice.paid', jsonb_build_object('invoice', v_inv.number));
    end if;
  elsif v_inv.status = 'PAID' and v_inv.kind = 'CREDITS' then
    perform public._billing_grant_credits(v_inv);
  end if;
  return v_inv;
end;
$$;

-- Can the signed-in person pay this account's invoices? Owners and staff who
-- manage settings — also while the account is restricted, so they can pay to
-- lift the restriction.
create or replace function public.billing_can_pay()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p join public.roles r on r.id = p.role_id join public.merchants m on m.id = p.merchant_id
    where p.id = auth.uid() and p.merchant_id = public.current_merchant_id() and p.is_active and m.status <> 'CLOSED'
      and (r.code = 'OWNER' or exists (select 1 from public.role_permissions rp join public.permissions pm on pm.id = rp.permission_id
                                       where rp.role_id = r.id and pm.code in ('settings.manage', 'sms.manage'))))
$$;

-- The merchant chooses a credit package: an invoice to pay (reused for 30 minutes).
create or replace function public.credits_start_recharge(p_package uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_merchant uuid := public.current_merchant_id();
  k public.credit_packages;
  v_inv public.billing_invoices;
begin
  if not public.billing_can_pay() then
    raise exception 'PERMISSION_DENIED: only the owner or staff who manage settings can buy credits' using errcode = '42501';
  end if;
  select * into k from public.credit_packages where id = p_package and status = 'ACTIVE';
  if k.id is null then
    raise exception 'NOT_FOUND: package not available' using errcode = 'P0002';
  end if;
  select * into v_inv from public.billing_invoices
  where merchant_id = v_merchant and kind = 'CREDITS' and status = 'OPEN' and amount_paid = 0 and created_at > now() - interval '30 minutes'
    and lines -> 0 ->> 'package_id' = k.id::text
  order by created_at desc limit 1;
  if v_inv.id is null then
    if (select count(*) from public.billing_invoices where merchant_id = v_merchant and kind = 'CREDITS' and created_at > now() - interval '1 hour') >= 10 then
      raise exception 'VALIDATION: too many recharge attempts; try again in an hour' using errcode = '22023';
    end if;
    insert into public.billing_invoices (merchant_id, kind, lines, total, currency, due_at, created_by)
    values (v_merchant, 'CREDITS',
            jsonb_build_array(jsonb_build_object('kind', 'credits', 'label', k.name, 'amount', k.price, 'package_id', k.id,
              'credit_type', k.credit_type, 'credits', k.credits + k.bonus_credits, 'bonus', k.bonus_credits)),
            k.price, k.currency, now() + interval '1 day', auth.uid())
    returning * into v_inv;
  end if;
  return jsonb_build_object('id', v_inv.id, 'number', v_inv.number, 'total', v_inv.total, 'currency', v_inv.currency, 'lines', v_inv.lines,
    'gateways', (select coalesce(jsonb_agg(g.key order by g.key), '[]'::jsonb) from public.platform_settings ps, jsonb_each(ps.value) g
                 where ps.key = 'billing_gateways' and (g.value ->> 'enabled')::boolean));
end;
$$;

-- Starts a gateway attempt for one of the merchant's open invoices (edge function, after billing_can_pay).
create or replace function public.billing_gateway_payment_create(p_invoice uuid, p_provider text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_merchant uuid := public.current_merchant_id();
  v_inv public.billing_invoices;
  v public.billing_payments;
  m public.merchants;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select * into v_inv from public.billing_invoices where id = p_invoice and merchant_id = v_merchant;
  if v_inv.id is null then
    raise exception 'NOT_FOUND: invoice not found' using errcode = 'P0002';
  end if;
  if v_inv.status <> 'OPEN' or v_inv.total - v_inv.amount_paid <= 0 then
    raise exception 'VALIDATION: this invoice is already %', lower(v_inv.status) using errcode = '22023';
  end if;
  if not coalesce((select (value -> p_provider ->> 'enabled')::boolean from public.platform_settings where key = 'billing_gateways'), false) then
    raise exception 'VALIDATION: this payment method is not available' using errcode = '22023';
  end if;
  if (select count(*) from public.billing_payments where invoice_id = v_inv.id and method = 'GATEWAY' and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'VALIDATION: too many payment attempts for this invoice; try again later' using errcode = '22023';
  end if;
  select * into m from public.merchants where id = v_merchant;
  insert into public.billing_payments (merchant_id, invoice_id, amount, method, provider, reference, status, note)
  values (v_merchant, v_inv.id, v_inv.total - v_inv.amount_paid, 'GATEWAY', p_provider,
          'BP-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 14)), 'PENDING', 'Paid online by the merchant')
  returning * into v;
  return jsonb_build_object('payment_id', v.id, 'reference', v.reference, 'amount', v.amount, 'currency', v_inv.currency,
    'invoice_number', v_inv.number, 'kind', v_inv.kind,
    'merchant', jsonb_build_object('name', m.name, 'phone', coalesce(m.phone, ''), 'email', m.owner_email, 'address', coalesce(m.address, '')));
end;
$$;

create or replace function public.billing_gateway_payment_session(p_payment uuid, p_session text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.billing_payments set provider_session = left(p_session, 200)
  where id = p_payment and merchant_id = public.current_merchant_id() and status = 'PENDING';
end;
$$;

-- A gateway return or IPN names its session; this finds the payment and merchant.
create or replace function public.billing_gateway_lookup(p_provider text, p_session text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when public.is_system_context() then (
    select jsonb_build_object('payment_id', id, 'merchant_id', merchant_id, 'reference', reference, 'status', status, 'amount', amount, 'invoice_id', invoice_id)
    from public.billing_payments where method = 'GATEWAY' and provider = p_provider and (provider_session = p_session or reference = p_session)
    order by created_at desc limit 1) end
$$;

-- Records what the gateway confirmed, server to server. Never from a browser.
create or replace function public.billing_gateway_confirm(p_reference text, p_provider text, p_txn text, p_amount numeric, p_success boolean, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.billing_payments;
  v_inv public.billing_invoices;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select * into v from public.billing_payments where reference = p_reference and provider = p_provider and method = 'GATEWAY' for update;
  if v.id is null or (public.current_merchant_id() is not null and v.merchant_id <> public.current_merchant_id()) then
    return jsonb_build_object('status', 'unknown_payment');
  end if;
  if v.status = 'SUCCEEDED' then
    return jsonb_build_object('status', 'already_succeeded', 'invoice_id', v.invoice_id);
  end if;
  if not p_success then
    if v.status = 'PENDING' then
      update public.billing_payments set status = 'FAILED', raw = p_payload where id = v.id;
    end if;
    return jsonb_build_object('status', 'failed', 'invoice_id', v.invoice_id);
  end if;
  if p_amount is null or round(p_amount, 2) <> round(v.amount, 2) then
    update public.billing_payments set raw = p_payload, note = coalesce(note || ' · ', '') || format('gateway reported %s, expected %s', p_amount, v.amount)
    where id = v.id;
    perform public._platform_log('billing.gateway_amount_mismatch', v.merchant_id, 'billing_payment', v.id::text, null, null,
      jsonb_build_object('expected', v.amount, 'reported', p_amount, 'txn', p_txn), 'FAILED');
    return jsonb_build_object('status', 'amount_mismatch', 'invoice_id', v.invoice_id);
  end if;
  if p_txn is not null and exists (select 1 from public.billing_payments where provider = p_provider and provider_txn_id = p_txn and status = 'SUCCEEDED') then
    return jsonb_build_object('status', 'duplicate_transaction', 'invoice_id', v.invoice_id);
  end if;
  update public.billing_payments set status = 'SUCCEEDED', provider_txn_id = p_txn, verified_at = now(), raw = p_payload where id = v.id returning * into v;
  v_inv := public._billing_apply_payment(v);
  perform public._platform_log('billing.gateway_payment_succeeded', v.merchant_id, 'billing_payment', v.id::text, null, null,
    jsonb_build_object('amount', v.amount, 'provider', p_provider, 'txn', p_txn, 'invoice', v_inv.number, 'invoice_status', v_inv.status));
  if v_inv.status <> 'PAID' or v_inv.amount_paid > v_inv.total then
    -- Paid twice (two attempts both went through): flagged for the team to refund or credit.
    perform public._platform_log('billing.overpayment', v.merchant_id, 'billing_invoice', v_inv.id::text, null, null,
      jsonb_build_object('invoice', v_inv.number, 'payment', v.reference), 'FAILED');
  end if;
  return jsonb_build_object('status', 'succeeded', 'invoice_id', v.invoice_id, 'invoice_status', v_inv.status, 'kind', v_inv.kind);
end;
$$;

-- Gateway attempts whose browser never came back, for the reconcile job.
create or replace function public.billing_gateway_pending(p_limit int default 50)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when public.is_system_context() then coalesce((
    select jsonb_agg(jsonb_build_object('payment_id', id, 'merchant_id', merchant_id, 'provider', provider, 'reference', reference,
      'session', provider_session, 'age_minutes', floor(extract(epoch from now() - created_at) / 60)) order by created_at)
    from (select * from public.billing_payments
          where method = 'GATEWAY' and status = 'PENDING' and provider_session is not null
            and created_at < now() - interval '2 minutes' and created_at > now() - interval '2 days'
          order by created_at limit least(greatest(p_limit, 1), 200)) x), '[]'::jsonb) end
$$;

-- Hourly billing also writes off expired credits.
do $$
declare
  v_old text := pg_get_functiondef('public.billing_run()'::regprocedure);
  v_new text;
begin
  v_new := replace(v_old, E'  end loop;\n  return v;', E'  end loop;\n  v := v || jsonb_build_object(''credits_expired'', public.credits_expire_all());\n  return v;');
  if v_new = v_old then
    raise exception 'credits: billing_run has changed';
  end if;
  execute v_new;
end $$;

-- -----------------------------------------------------------------------------
-- 6. Super Admin: credits and packages
-- -----------------------------------------------------------------------------
create or replace function public.platform_credits_overview(p_q text default null, p_type text default null, p_limit int default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_q text := nullif(trim(coalesce(p_q, '')), '');
begin
  perform public._platform_require('credits', 'view');
  return jsonb_build_object(
    'types', coalesce((select jsonb_agg(jsonb_build_object('code', t.code, 'name', t.name, 'unit', t.unit, 'description', t.description, 'used_by', t.used_by,
        'outstanding', (select coalesce(sum(b.balance), 0) from public.credit_balances b where b.credit_type = t.code and b.merchant_id in (select public._platform_merchant_ids())),
        'merchants_with_balance', (select count(*) from public.credit_balances b where b.credit_type = t.code and b.balance > 0 and b.merchant_id in (select public._platform_merchant_ids())),
        'added_30d', (select coalesce(sum(l.amount), 0) from public.credit_ledger l where l.credit_type = t.code and l.amount > 0 and l.kind <> 'REFUND'
                      and l.created_at > now() - interval '30 days' and l.merchant_id in (select public._platform_merchant_ids())),
        'used_30d', (select coalesce(-sum(l.amount), 0) from public.credit_ledger l where l.credit_type = t.code and l.kind in ('USAGE', 'REFUND')
                     and l.created_at > now() - interval '30 days' and l.merchant_id in (select public._platform_merchant_ids())))
      order by t.sort_order) from public.credit_types t), '[]'::jsonb),
    'merchants', coalesce((select jsonb_agg(x order by x.number) from (
      select m.id, m.number, m.name, m.status,
             jsonb_object_agg(b.credit_type, b.balance) filter (where b.credit_type is not null) as balances
      from public.merchants m left join public.credit_balances b on b.merchant_id = m.id and (p_type is null or b.credit_type = p_type)
      where m.id in (select public._platform_merchant_ids())
        and (v_q is null or m.name ilike '%' || v_q || '%' or m.number::text = v_q)
      group by m.id order by m.number limit greatest(1, least(p_limit, 500))) x), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'merchant', jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name),
        'credit_type', l.credit_type, 'kind', l.kind, 'amount', l.amount, 'balance_after', l.balance_after, 'reason', l.reason,
        'actor', case l.actor_kind when 'PLATFORM' then (select coalesce(nullif(s.full_name, ''), s.email) from public.platform_staff s where s.user_id = l.actor_id)
                                   when 'MERCHANT' then 'merchant' else 'system' end,
        'created_at', l.created_at) order by l.id desc)
      from (select * from public.credit_ledger where merchant_id in (select public._platform_merchant_ids()) and (p_type is null or credit_type = p_type)
            order by id desc limit 50) l join public.merchants m on m.id = l.merchant_id), '[]'::jsonb),
    'packages', coalesce((select jsonb_agg(to_jsonb(k) order by k.status, k.credit_type, k.sort_order, k.price) from public.credit_packages k), '[]'::jsonb),
    'settings', coalesce((select value from public.platform_settings where key = 'credits'), '{}'::jsonb));
end;
$$;

create or replace function public.platform_merchant_credits(p_merchant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._platform_require('credits', 'view', p_merchant);
  return jsonb_build_object(
    'balances', coalesce((select jsonb_agg(jsonb_build_object('code', t.code, 'name', t.name, 'unit', t.unit,
        'balance', coalesce((select balance from public.credit_balances b where b.merchant_id = p_merchant and b.credit_type = t.code), 0),
        'available', public.credit_available(p_merchant, t.code),
        'expiring_30d', (select coalesce(sum(remaining), 0) from public.credit_lots where merchant_id = p_merchant and credit_type = t.code
                         and remaining > 0 and expires_at > now() and expires_at <= now() + interval '30 days'))
      order by t.sort_order) from public.credit_types t), '[]'::jsonb),
    'lots', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'credit_type', l.credit_type, 'granted', l.granted, 'remaining', l.remaining,
        'expires_at', l.expires_at, 'created_at', l.created_at, 'kind', e.kind, 'reason', e.reason) order by l.expires_at nulls last, l.id)
      from public.credit_lots l join public.credit_ledger e on e.id = l.entry_id where l.merchant_id = p_merchant and l.remaining > 0), '[]'::jsonb),
    'ledger', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'credit_type', l.credit_type, 'kind', l.kind, 'amount', l.amount,
        'balance_after', l.balance_after, 'reason', l.reason, 'reference_type', l.reference_type, 'reference_id', l.reference_id,
        'expires_at', l.expires_at, 'metadata', l.metadata,
        'actor', case l.actor_kind when 'PLATFORM' then (select coalesce(nullif(s.full_name, ''), s.email) from public.platform_staff s where s.user_id = l.actor_id)
                                   when 'MERCHANT' then 'merchant' else 'system' end,
        'created_at', l.created_at) order by l.id desc)
      from (select * from public.credit_ledger where merchant_id = p_merchant order by id desc limit 100) l), '[]'::jsonb),
    'usage', jsonb_build_object('sms', public._usage_state(p_merchant, 'SMS'), 'bd_courier', public._usage_state(p_merchant, 'BD_COURIER')),
    'overrides', coalesce((select jsonb_agg(to_jsonb(o)) from public.merchant_service_overrides o where o.merchant_id = p_merchant), '[]'::jsonb));
end;
$$;

-- Adds or removes credits by hand. Promotional grants may expire. Large changes wait for a second person.
create or replace function public.platform_credit_adjust(p_merchant uuid, p_type text, p_amount int, p_kind text, p_reason text,
  p_expires_at timestamptz default null, p_request_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_threshold int := coalesce((select (value ->> 'approval_threshold')::int from public.platform_settings where key = 'credits'), 1000);
  v_key text := 'admin:' || coalesce(p_request_id, gen_random_uuid());
  v_name text := (select name from public.merchants where id = p_merchant);
  e public.credit_ledger;
  v_approval uuid;
begin
  if p_kind = 'PROMO' then
    perform public._platform_require('credits', 'create', p_merchant);
    if p_amount is null or p_amount <= 0 then
      raise exception 'VALIDATION: promotional credits are added, not removed' using errcode = '22023';
    end if;
  elsif p_kind = 'ADJUSTMENT' then
    perform public._platform_require('credits', 'manage', p_merchant);
  else
    raise exception 'VALIDATION: choose a promotional grant or an adjustment' using errcode = '22023';
  end if;
  if v_name is null then
    raise exception 'NOT_FOUND: merchant not found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.credit_types where code = p_type) then
    raise exception 'VALIDATION: unknown credit type' using errcode = '22023';
  end if;
  if p_amount is null or p_amount = 0 or abs(p_amount) > 1000000 then
    raise exception 'VALIDATION: enter an amount between 1 and 1,000,000' using errcode = '22023';
  end if;
  if coalesce(length(trim(p_reason)), 0) < 5 then
    raise exception 'VALIDATION: give a reason (at least 5 characters)' using errcode = '22023';
  end if;
  if p_expires_at is not null and (p_amount < 0 or p_expires_at <= now()) then
    raise exception 'VALIDATION: an expiry date must be in the future, and only for added credits' using errcode = '22023';
  end if;
  if abs(p_amount) > v_threshold then
    v_approval := public.platform_request_approval('credits', 'credit_adjust', p_merchant,
      format('%s %s %s credits %s %s', case when p_amount > 0 then 'Add' else 'Remove' end, abs(p_amount), p_type,
             case when p_amount > 0 then 'to' else 'from' end, v_name),
      jsonb_build_object('credit_type', p_type, 'amount', p_amount, 'kind', p_kind, 'expires_at', p_expires_at, 'key', v_key), p_reason);
    return jsonb_build_object('pending_approval', v_approval);
  end if;
  -- The same request sent again (double click, retry): the first result, logged once.
  select * into e from public.credit_ledger where merchant_id = p_merchant and idempotency_key = v_key;
  if e.id is not null then
    return to_jsonb(e);
  end if;
  e := public._credit_post(p_merchant, p_type, p_amount, p_kind, trim(p_reason), auth.uid(), 'PLATFORM', 'platform_adjustment', null, v_key, p_expires_at);
  perform public._platform_log('credits.' || lower(p_kind), p_merchant, 'credit_ledger', e.id::text, p_reason, null,
    jsonb_build_object('credit_type', p_type, 'amount', p_amount, 'balance_after', e.balance_after, 'expires_at', p_expires_at));
  return to_jsonb(e);
end;
$$;

create or replace function public._platform_execute_approval_more(a public.platform_approvals)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e public.credit_ledger;
begin
  case a.action
    when 'credit_adjust' then
      e := public._credit_post(a.merchant_id, a.payload ->> 'credit_type', (a.payload ->> 'amount')::int, a.payload ->> 'kind', a.reason,
        a.requested_by, 'PLATFORM', 'platform_approval', a.id::text, a.payload ->> 'key', (a.payload ->> 'expires_at')::timestamptz,
        jsonb_build_object('approved_by', auth.uid()));
      perform public._platform_log('credits.' || lower(a.payload ->> 'kind'), a.merchant_id, 'credit_ledger', e.id::text, a.reason, null,
        jsonb_build_object('credit_type', e.credit_type, 'amount', e.amount, 'balance_after', e.balance_after, 'approval', a.id));
      return jsonb_build_object('entry_id', e.id, 'balance_after', e.balance_after);
    else
      raise exception 'VALIDATION: unknown approval action %', a.action using errcode = '22023';
  end case;
end;
$$;

create or replace function public.platform_credit_package_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.credit_packages;
  v_before jsonb;
  v_id uuid := nullif(p ->> 'id', '')::uuid;
begin
  perform public._platform_require('credits', 'manage');
  if v_id is null then
    insert into public.credit_packages (credit_type, name, credits, bonus_credits, price, sort_order, created_by)
    values (p ->> 'credit_type', trim(p ->> 'name'), (p ->> 'credits')::int, coalesce((p ->> 'bonus_credits')::int, 0), (p ->> 'price')::numeric,
            coalesce((p ->> 'sort_order')::int, 100), auth.uid())
    returning * into v;
  else
    select to_jsonb(k) into v_before from public.credit_packages k where id = v_id;
    update public.credit_packages set name = coalesce(nullif(trim(p ->> 'name'), ''), name), credits = coalesce((p ->> 'credits')::int, credits),
      bonus_credits = coalesce((p ->> 'bonus_credits')::int, bonus_credits), price = coalesce((p ->> 'price')::numeric, price),
      status = coalesce(p ->> 'status', status), sort_order = coalesce((p ->> 'sort_order')::int, sort_order)
    where id = v_id returning * into v;
    if v.id is null then
      raise exception 'NOT_FOUND: package not found' using errcode = 'P0002';
    end if;
  end if;
  perform public._platform_log(case when v_id is null then 'credits.package_created' else 'credits.package_updated' end, null, 'credit_package', v.id::text,
    p ->> 'note', v_before, to_jsonb(v));
  return to_jsonb(v);
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. Super Admin: usage policies, merchant exceptions, SMS / BD Courier / gateways
-- -----------------------------------------------------------------------------
create or replace function public._usage_module(p_service text)
returns text
language sql
immutable
as $$
  select case p_service when 'SMS' then 'sms' when 'BD_COURIER' then 'bd_courier' end
$$;

create or replace function public._usage_policy_validate(p_service text, p jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  f jsonb := coalesce(p -> 'free', '{}'::jsonb);
  v_cap int := nullif(p ->> 'monthly_cap', '')::int;
begin
  if p_service not in ('SMS', 'BD_COURIER') then
    raise exception 'VALIDATION: unknown service' using errcode = '22023';
  end if;
  if coalesce((f ->> 'limit')::int, -1) not between 0 and 1000000 then
    raise exception 'VALIDATION: the free limit must be between 0 and 1,000,000' using errcode = '22023';
  end if;
  if coalesce(f ->> 'period', '') not in ('ONCE', 'MONTH') then
    raise exception 'VALIDATION: the free allowance is once or every month' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(f -> 'plans', '[]'::jsonb)) <> 'array' or jsonb_typeof(coalesce(f -> 'statuses', '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p -> 'unmetered_plans', '[]'::jsonb)) <> 'array' then
    raise exception 'VALIDATION: plans and statuses are lists' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements_text(coalesce(f -> 'statuses', '[]'::jsonb)) s where s not in ('TRIALING', 'ACTIVE', 'PAST_DUE', 'PAUSED')) then
    raise exception 'VALIDATION: free usage can go to trial, active, past-due or paused subscriptions only' using errcode = '22023';
  end if;
  if coalesce(p ->> 'after_free', '') not in ('CREDITS', 'BLOCK') then
    raise exception 'VALIDATION: after the free allowance: charge credits or block' using errcode = '22023';
  end if;
  if coalesce((p ->> 'credits_per_unit')::int, -1) not between 0 and 1000 then
    raise exception 'VALIDATION: credits per use must be between 0 and 1000' using errcode = '22023';
  end if;
  if v_cap is not null and v_cap < 0 then
    raise exception 'VALIDATION: the monthly cap cannot be negative' using errcode = '22023';
  end if;
  if p_service = 'SMS' and coalesce(p ->> 'unit', '') not in ('SEGMENT', 'MESSAGE') then
    raise exception 'VALIDATION: an SMS use is one part or one message' using errcode = '22023';
  end if;
  if p_service = 'SMS' and coalesce((p ->> 'hold_hours')::int, -1) not between 0 and 72 then
    raise exception 'VALIDATION: messages can wait for credits 0 to 72 hours' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'free', jsonb_build_object('enabled', coalesce((f ->> 'enabled')::boolean, false), 'limit', (f ->> 'limit')::int, 'period', f ->> 'period',
      'plans', coalesce(f -> 'plans', '[]'::jsonb), 'statuses', coalesce(f -> 'statuses', '[]'::jsonb)),
    'unit', case when p_service = 'SMS' then p ->> 'unit' else 'LOOKUP' end,
    'after_free', p ->> 'after_free', 'credits_per_unit', (p ->> 'credits_per_unit')::int, 'monthly_cap', v_cap,
    'unmetered_plans', coalesce(p -> 'unmetered_plans', '[]'::jsonb))
    || case when p_service = 'SMS' then jsonb_build_object('refund_undelivered', coalesce((p ->> 'refund_undelivered')::boolean, false),
                                                           'hold_hours', (p ->> 'hold_hours')::int) else '{}'::jsonb end;
end;
$$;

create or replace function public.platform_usage_policy_save(p_service text, p_policy jsonb, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb;
  v_before jsonb := public._usage_policy(p_service);
begin
  perform public._platform_require(coalesce(public._usage_module(p_service), 'sms'), 'edit');
  v := public._usage_policy_validate(p_service, p_policy);
  if coalesce(length(trim(p_reason)), 0) < 5 then
    raise exception 'VALIDATION: give a reason (at least 5 characters)' using errcode = '22023';
  end if;
  update public.platform_settings set value = v, updated_by = auth.uid() where key = 'usage.' || lower(p_service);
  perform public._config_version('platform_setting', 'usage.' || lower(p_service), v, p_reason);
  perform public._platform_log(public._usage_module(p_service) || '.policy_changed', null, 'platform_setting', 'usage.' || lower(p_service), p_reason, v_before, v);
  return v;
end;
$$;

create or replace function public.platform_service_override_set(p_merchant uuid, p_service text, p_free_limit int, p_monthly_cap int,
  p_sender_id text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb;
  v_ids jsonb := coalesce((select value -> 'sender_ids' from public.platform_settings where key = 'sms'), '[]'::jsonb);
begin
  perform public._platform_require(public._usage_module(p_service), 'edit', p_merchant);
  if coalesce(length(trim(p_reason)), 0) < 3 then
    raise exception 'VALIDATION: give a reason' using errcode = '22023';
  end if;
  if p_sender_id is not null and p_service <> 'SMS' then
    raise exception 'VALIDATION: a sender ID is for SMS only' using errcode = '22023';
  end if;
  if nullif(trim(p_sender_id), '') is not null and jsonb_array_length(v_ids) > 0 and not v_ids ? trim(p_sender_id) then
    raise exception 'VALIDATION: use one of the approved sender IDs' using errcode = '22023';
  end if;
  select to_jsonb(o) into v_before from public.merchant_service_overrides o where merchant_id = p_merchant and service = p_service;
  if p_free_limit is null and p_monthly_cap is null and nullif(trim(p_sender_id), '') is null then
    delete from public.merchant_service_overrides where merchant_id = p_merchant and service = p_service;
  else
    insert into public.merchant_service_overrides (merchant_id, service, free_limit, monthly_cap, sender_id, reason, set_by)
    values (p_merchant, p_service, p_free_limit, p_monthly_cap, nullif(trim(p_sender_id), ''), trim(p_reason), auth.uid())
    on conflict (merchant_id, service) do update set free_limit = excluded.free_limit, monthly_cap = excluded.monthly_cap, sender_id = excluded.sender_id,
      reason = excluded.reason, set_by = excluded.set_by, set_at = now();
  end if;
  perform public._platform_log(public._usage_module(p_service) || '.merchant_limits_changed', p_merchant, 'merchant_service_override', p_service, p_reason,
    v_before, jsonb_build_object('free_limit', p_free_limit, 'monthly_cap', p_monthly_cap, 'sender_id', p_sender_id));
  return public._usage_state(p_merchant, p_service);
end;
$$;

-- Connection state (no secrets) for the SMS and BD Courier pages.
create or replace function public.platform_service_status(p_service text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_key text := case p_service when 'SMS' then 'sms' else 'bd_courier' end;
  v jsonb := coalesce((select value from public.platform_settings where key = v_key), '{}'::jsonb);
begin
  perform public._platform_require(public._usage_module(p_service), 'view');
  return jsonb_build_object(
    'config', v,
    'credential', (select jsonb_build_object('hint', c.hint, 'updated_at', c.updated_at,
        'updated_by', (select coalesce(nullif(s.full_name, ''), s.email) from public.platform_staff s where s.user_id = c.updated_by))
      from public.platform_credentials c where c.key = case p_service when 'SMS' then 'sms.' || coalesce(v ->> 'provider', '') else 'bd_courier' end and c.hint is not null),
    'policy', public._usage_policy(p_service),
    'feature', (select to_jsonb(f) from public.features f where f.code = public._usage_feature(p_service)),
    'plans', coalesce((select jsonb_agg(jsonb_build_object('code', code, 'name', name, 'includes', coalesce((features ->> public._usage_feature(p_service))::boolean, false))
      order by sort_order) from public.plans where status = 'ACTIVE'), '[]'::jsonb),
    'overrides', coalesce((select jsonb_agg(to_jsonb(o) || jsonb_build_object('merchant', jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name)) order by m.number)
      from public.merchant_service_overrides o join public.merchants m on m.id = o.merchant_id
      where o.service = p_service and o.merchant_id in (select public._platform_merchant_ids())), '[]'::jsonb),
    'exceptions', coalesce((select jsonb_agg(jsonb_build_object('merchant', jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name),
        'enabled', mf.enabled, 'reason', mf.reason, 'expires_at', mf.expires_at) order by m.number)
      from public.merchant_features mf join public.merchants m on m.id = mf.merchant_id
      where mf.feature_code = public._usage_feature(p_service) and mf.merchant_id in (select public._platform_merchant_ids())), '[]'::jsonb),
    'can', jsonb_build_object('edit', public.platform_can(public._usage_module(p_service), 'edit'),
                              'manage', public.platform_can(public._usage_module(p_service), 'manage')));
end;
$$;

create or replace function public.platform_sms_settings_save(p jsonb, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb := (select value from public.platform_settings where key = 'sms');
  v_ids jsonb := coalesce(p -> 'sender_ids', v_before -> 'sender_ids', '[]'::jsonb);
  v_default text := coalesce(p ->> 'sender_id', v_before ->> 'sender_id', '');
  v_cost numeric := coalesce((p ->> 'cost_per_segment')::numeric, (v_before ->> 'cost_per_segment')::numeric, 0);
  v jsonb;
begin
  perform public._platform_require('sms', 'edit');
  if jsonb_typeof(v_ids) <> 'array' or exists (select 1 from jsonb_array_elements_text(v_ids) s where s !~ '^[A-Za-z0-9 ._+-]{1,20}$') then
    raise exception 'VALIDATION: sender IDs have up to 20 letters, digits, spaces, dots or dashes' using errcode = '22023';
  end if;
  if v_default <> '' and jsonb_array_length(v_ids) > 0 and not v_ids ? v_default then
    raise exception 'VALIDATION: the default sender ID must be one of the approved ones' using errcode = '22023';
  end if;
  if v_cost < 0 or v_cost > 10 then
    raise exception 'VALIDATION: the provider cost per SMS part must be between 0 and 10' using errcode = '22023';
  end if;
  update public.platform_settings set value = value || jsonb_build_object('sender_ids', v_ids, 'sender_id', v_default, 'cost_per_segment', v_cost),
    updated_by = auth.uid()
  where key = 'sms' returning value into v;
  perform public._platform_log('sms.settings_changed', null, 'platform_setting', 'sms', p_reason, v_before, v);
  return v;
end;
$$;

-- Called by the platform-admin edge function after it tested the credentials.
create or replace function public.platform_sms_set_connection(p_provider text, p_hint text, p_sender_id text, p_balance numeric, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.platform_settings set value = value || case when p_provider is null then
      jsonb_build_object('connected', false, 'provider', null, 'hint', null, 'balance', null, 'connected_at', null)
    else jsonb_build_object('connected', true, 'provider', p_provider, 'hint', p_hint, 'balance', p_balance,
      'balance_checked_at', case when p_balance is null then null else now() end, 'connected_at', now(),
      'sender_id', coalesce(nullif(trim(p_sender_id), ''), value ->> 'sender_id', ''),
      'sender_ids', case when nullif(trim(p_sender_id), '') is null or coalesce(value -> 'sender_ids', '[]'::jsonb) ? trim(p_sender_id)
                         then coalesce(value -> 'sender_ids', '[]'::jsonb) else coalesce(value -> 'sender_ids', '[]'::jsonb) || to_jsonb(trim(p_sender_id)) end) end,
    updated_by = p_actor
  where key = 'sms' returning value into v;
  perform public._platform_log(case when p_provider is null then 'sms.disconnected' else 'sms.connected' end, null, 'platform_credential', 'sms', null, null,
    jsonb_build_object('provider', p_provider, 'hint', p_hint));
  return v;
end;
$$;

create or replace function public.platform_sms_set_balance(p_balance numeric)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.platform_settings set value = value || jsonb_build_object('balance', p_balance, 'balance_checked_at', now()) where key = 'sms';
end;
$$;

create or replace function public.platform_bd_courier_set_connection(p_service text, p_hint text, p_actor uuid, p_test_ok boolean default null, p_error text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.platform_settings set value = value
    || case when p_service is null and p_test_ok is null then jsonb_build_object('connected', false, 'service', null, 'hint', null, 'connected_at', null)
            when p_service is not null then jsonb_build_object('connected', true, 'service', p_service, 'hint', p_hint, 'connected_at', now())
            else '{}'::jsonb end
    || case when p_test_ok is not null then jsonb_build_object('last_test_at', now(), 'last_test_ok', p_test_ok, 'last_error', left(p_error, 300)) else '{}'::jsonb end,
    updated_by = coalesce(p_actor, updated_by)
  where key = 'bd_courier' returning value into v;
  if p_service is not null or p_test_ok is null then
    perform public._platform_log(case when p_service is null then 'bd_courier.disconnected' else 'bd_courier.connected' end, null, 'platform_credential',
      'bd_courier', null, null, jsonb_build_object('service', p_service, 'hint', p_hint));
  end if;
  return v;
end;
$$;

create or replace function public.platform_billing_gateway_set(p_provider text, p_connected boolean, p_hint text, p_sandbox boolean, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_provider not in ('bkash', 'paystation') then
    raise exception 'VALIDATION: unknown gateway' using errcode = '22023';
  end if;
  update public.platform_settings set value = jsonb_set(value, array[p_provider],
      coalesce(value -> p_provider, '{}'::jsonb) || jsonb_build_object('connected', p_connected, 'enabled', p_connected, 'hint', p_hint,
        'sandbox', coalesce(p_sandbox, (value -> p_provider ->> 'sandbox')::boolean, true), 'connected_at', case when p_connected then now() end)),
    updated_by = p_actor
  where key = 'billing_gateways' returning value into v;
  perform public._platform_log(case when p_connected then 'billing.gateway_connected' else 'billing.gateway_disconnected' end, null, 'platform_credential',
    'gateway.' || p_provider, null, null, jsonb_build_object('hint', p_hint, 'sandbox', p_sandbox));
  return v;
end;
$$;

-- The gateway switches (no secrets), for the billing edge function.
create or replace function public.platform_billing_gateways_config()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when public.is_system_context() then coalesce((select value from public.platform_settings where key = 'billing_gateways'), '{}'::jsonb) end
$$;

create or replace function public.platform_billing_gateways()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._platform_require('subscriptions', 'view');
  return jsonb_build_object('gateways', coalesce((select value from public.platform_settings where key = 'billing_gateways'), '{}'::jsonb),
    'can_manage', public.platform_can('subscriptions', 'manage') and public.platform_can('settings', 'manage'));
end;
$$;

create or replace function public.platform_billing_gateway_toggle(p_provider text, p_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb;
begin
  perform public._platform_require('subscriptions', 'manage');
  if p_enabled and not coalesce((select (value -> p_provider ->> 'connected')::boolean from public.platform_settings where key = 'billing_gateways'), false) then
    raise exception 'VALIDATION: connect the gateway account first' using errcode = '22023';
  end if;
  update public.platform_settings set value = jsonb_set(value, array[p_provider, 'enabled'], to_jsonb(p_enabled)), updated_by = auth.uid()
  where key = 'billing_gateways' and value ? p_provider returning value into v;
  perform public._platform_log('billing.gateway_' || case when p_enabled then 'enabled' else 'disabled' end, null, 'platform_setting', 'billing_gateways', null, null, v);
  return v;
end;
$$;

-- Audit entry for an action an edge function took for a platform employee (tests, sends).
create or replace function public.platform_record_action(p_actor uuid, p_action text, p_entity_type text, p_entity_id text, p_result text,
  p_metadata jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  insert into public.platform_audit_logs (actor_id, actor_email, action, entity_type, entity_id, result, metadata)
  values (p_actor, (select email from public.platform_staff where user_id = p_actor), p_action, p_entity_type, p_entity_id,
          case when p_result in ('SUCCESS', 'FAILED') then p_result else 'SUCCESS' end, coalesce(p_metadata, '{}'::jsonb));
end;
$$;

-- Usage for the SMS, BD Courier and Usage pages: attempted, refused, done,
-- failed, delivered, free, paid in credits, unmetered, and what it cost the platform.
create or replace function public.platform_usage_report(p_service text, p_from date, p_to date, p_merchant uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_cost numeric := coalesce((select (value ->> 'cost_per_segment')::numeric from public.platform_settings where key = 'sms'), 0);
begin
  if not (public.platform_can(public._usage_module(p_service), 'view', p_merchant) or public.platform_can('usage', 'view', p_merchant)) then
    perform public._platform_require('usage', 'view', p_merchant);
  end if;
  return (with u as (
      select su.*, m.number, m.name from public.service_usage su join public.merchants m on m.id = su.merchant_id
      where su.service = p_service and su.merchant_id in (select public._platform_merchant_ids())
        and (p_merchant is null or su.merchant_id = p_merchant)
        and (su.created_at at time zone 'Asia/Dhaka')::date between p_from and p_to),
    agg as (
      select merchant_id, number, name,
        count(*) filter (where status <> 'DENIED') as attempted,
        count(*) filter (where status = 'DENIED') as denied,
        count(*) filter (where status = 'SUCCEEDED') as succeeded,
        count(*) filter (where status = 'FAILED') as failed,
        count(*) filter (where status = 'RESERVED') as in_progress,
        count(*) filter (where outcome = 'DELIVERED') as delivered,
        count(*) filter (where outcome = 'UNDELIVERED') as undelivered,
        coalesce(sum(units) filter (where status in ('RESERVED', 'SUCCEEDED') and refunded_at is null), 0) as units,
        coalesce(sum(units) filter (where charge = 'FREE' and status in ('RESERVED', 'SUCCEEDED') and refunded_at is null), 0) as free_units,
        coalesce(sum(units) filter (where charge = 'PLAN' and status in ('RESERVED', 'SUCCEEDED') and refunded_at is null), 0) as plan_units,
        coalesce(sum(credits) filter (where charge = 'CREDITS' and refunded_at is null), 0) as credits,
        coalesce(sum(credits) filter (where charge = 'CREDITS' and refunded_at is not null), 0) as credits_refunded,
        coalesce(sum(provider_cost), 0) as provider_cost,
        coalesce(sum(case when provider_cost is null and status in ('RESERVED', 'SUCCEEDED') then units * v_cost end), 0) as estimated_cost
      from u group by merchant_id, number, name)
    select jsonb_build_object(
      'service', p_service,
      'range', jsonb_build_object('from', p_from, 'to', p_to),
      'totals', coalesce((select jsonb_build_object('attempted', sum(attempted), 'denied', sum(denied), 'succeeded', sum(succeeded), 'failed', sum(failed),
          'in_progress', sum(in_progress), 'delivered', sum(delivered), 'undelivered', sum(undelivered), 'units', sum(units), 'free_units', sum(free_units),
          'plan_units', sum(plan_units), 'credits', sum(credits), 'credits_refunded', sum(credits_refunded), 'provider_cost', sum(provider_cost),
          'estimated_cost', sum(estimated_cost), 'merchants', count(*)) from agg), '{}'::jsonb),
      'merchants', coalesce((select jsonb_agg(to_jsonb(a) order by a.attempted desc, a.number) from agg a), '[]'::jsonb),
      'daily', coalesce((select jsonb_agg(d order by d.day) from (
          select (created_at at time zone 'Asia/Dhaka')::date as day, count(*) filter (where status <> 'DENIED') as attempted,
                 count(*) filter (where status = 'SUCCEEDED') as succeeded, count(*) filter (where status = 'FAILED') as failed,
                 count(*) filter (where status = 'DENIED') as denied
          from u group by 1) d), '[]'::jsonb),
      'denied_reasons', coalesce((select jsonb_object_agg(denied_reason, n) from (select denied_reason, count(*) as n from u where status = 'DENIED' group by 1) r), '{}'::jsonb),
      'recent', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'merchant', jsonb_build_object('id', r.merchant_id, 'number', r.number, 'name', r.name),
          'status', r.status, 'charge', r.charge, 'units', r.units, 'credits', r.credits, 'refunded', r.refunded_at is not null, 'outcome', r.outcome,
          'reason', r.denied_reason, 'error', r.error,
          'reference', case when p_service = 'SMS' then (select public._mask_phone(n.recipient) from public.notification_logs n where n.id::text = r.reference) else r.reference end,
          'created_at', r.created_at) order by r.created_at desc)
        from (select * from u order by created_at desc limit 100) r), '[]'::jsonb)));
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. The merchant's own credits
-- -----------------------------------------------------------------------------
create or replace function public.my_credits()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_merchant uuid := public.current_merchant_id();
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and merchant_id = v_merchant and is_active) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'balances', coalesce((select jsonb_agg(jsonb_build_object('code', t.code, 'name', t.name, 'unit', t.unit, 'description', t.description,
        'available', public.credit_available(v_merchant, t.code),
        'expiring', coalesce((select jsonb_agg(jsonb_build_object('amount', remaining, 'expires_at', expires_at) order by expires_at)
          from public.credit_lots where merchant_id = v_merchant and credit_type = t.code and remaining > 0 and expires_at > now()), '[]'::jsonb))
      order by t.sort_order) from public.credit_types t where t.used_by is not null), '[]'::jsonb),
    'packages', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'credit_type', k.credit_type, 'name', k.name, 'credits', k.credits,
        'bonus_credits', k.bonus_credits, 'price', k.price, 'currency', k.currency) order by k.credit_type, k.sort_order, k.price)
      from public.credit_packages k where k.status = 'ACTIVE'), '[]'::jsonb),
    'ledger', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'credit_type', l.credit_type, 'kind', l.kind, 'amount', l.amount,
        'balance_after', l.balance_after, 'reason', l.reason, 'expires_at', l.expires_at, 'created_at', l.created_at) order by l.id desc)
      from (select * from public.credit_ledger where merchant_id = v_merchant order by id desc limit 50) l), '[]'::jsonb),
    'usage', jsonb_build_object('sms', public._usage_state(v_merchant, 'SMS'), 'bd_courier', public._usage_state(v_merchant, 'BD_COURIER')),
    'sms_policy', jsonb_build_object('refund_undelivered', coalesce((public._usage_policy('SMS') ->> 'refund_undelivered')::boolean, false),
      'hold_hours', coalesce((public._usage_policy('SMS') ->> 'hold_hours')::int, 6)),
    'recharges', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'number', i.number, 'total', i.total, 'status', i.status, 'lines', i.lines,
        'created_at', i.created_at, 'paid_at', i.paid_at) order by i.created_at desc)
      from (select * from public.billing_invoices where merchant_id = v_merchant and kind = 'CREDITS' and status <> 'VOID' order by created_at desc limit 20) i), '[]'::jsonb),
    'can_pay', public.billing_can_pay(),
    'gateways', (select coalesce(jsonb_agg(g.key order by g.key), '[]'::jsonb) from public.platform_settings ps, jsonb_each(ps.value) g
                 where ps.key = 'billing_gateways' and (g.value ->> 'enabled')::boolean));
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. Settings that have their own pages are not changed as plain settings
-- -----------------------------------------------------------------------------
create or replace function public.platform_setting_save(p_key text, p_value jsonb, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb;
begin
  if p_key like 'usage.%' then
    -- Validated, permission-checked and versioned there.
    return public.platform_usage_policy_save(upper(substr(p_key, 7)), p_value, coalesce(p_reason, 'Settings change'));
  end if;
  if p_key in ('sms', 'bd_courier', 'billing_gateways') then
    raise exception 'VALIDATION: % is changed on its own page (it holds connection state)', p_key using errcode = '22023';
  end if;
  perform public._platform_require('settings', 'edit');
  if p_key = 'access_rules' then
    perform public._platform_require('subscriptions', 'manage');
    if exists (select 1 from jsonb_each_text(p_value) e where e.value not in ('FULL', 'READ_ONLY', 'BLOCKED')) then
      raise exception 'VALIDATION: each rule is FULL, READ_ONLY or BLOCKED' using errcode = '22023';
    end if;
  end if;
  if p_key = 'credits' then
    perform public._platform_require('credits', 'manage');
    if coalesce((p_value ->> 'approval_threshold')::int, -1) < 0 then
      raise exception 'VALIDATION: the approval threshold is a number of credits (0 or more)' using errcode = '22023';
    end if;
  end if;
  if p_key !~ '^[a-z0-9_.]{2,60}$' or jsonb_typeof(p_value) <> 'object' then
    raise exception 'VALIDATION: bad setting' using errcode = '22023';
  end if;
  select value into v_before from public.platform_settings where key = p_key;
  insert into public.platform_settings (key, value, updated_by) values (p_key, p_value, auth.uid())
  on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by;
  perform public._config_version(case when p_key = 'access_rules' then 'access_rules' else 'platform_setting' end, p_key, p_value, p_reason);
  perform public._platform_log('settings.changed', null, 'platform_setting', p_key, p_reason, v_before, p_value);
  return p_value;
end;
$$;

-- -----------------------------------------------------------------------------
-- 10. The original business's own SMS and courier-history keys become the
--     platform's (they are the company's accounts). Nothing is deleted.
-- -----------------------------------------------------------------------------
do $$
declare
  v_m1 uuid := '00000000-0000-4000-8000-000000000001';
  v_sms jsonb;
  v_value text;
  v_hint text;
  v_sender text;
begin
  if not exists (select 1 from public.merchants where id = v_m1) then
    return;
  end if;
  if not exists (select 1 from public.platform_credentials where key = 'bd_courier' and hint is not null) then
    select ds.decrypted_secret, ic.hint into v_value, v_hint
    from public.integration_credentials ic join vault.decrypted_secrets ds on ds.id = ic.secret_id
    where ic.merchant_id = v_m1 and ic.key = 'fraud.courier_history' and ic.hint is not null;
    if nullif(nullif(v_value, ''), '{}') is not null then
      perform public.platform_secret_store('bd_courier', v_value::jsonb, v_hint, null);
      update public.platform_settings set value = value || jsonb_build_object('connected', true,
        'service', coalesce(v_value::jsonb ->> 'service', 'llcg'), 'hint', v_hint, 'connected_at', now())
      where key = 'bd_courier';
    end if;
  end if;
  select value into v_sms from public.settings where merchant_id = v_m1 and key = 'sms';
  if coalesce((v_sms ->> 'connected')::boolean, false) and v_sms ->> 'provider' is not null and not public._platform_service_connected('SMS') then
    v_value := null;
    select ds.decrypted_secret, ic.hint into v_value, v_hint
    from public.integration_credentials ic join vault.decrypted_secrets ds on ds.id = ic.secret_id
    where ic.merchant_id = v_m1 and ic.key = 'sms.' || (v_sms ->> 'provider') and ic.hint is not null;
    if nullif(nullif(v_value, ''), '{}') is not null then
      v_sender := nullif(trim(coalesce(v_sms ->> 'sender_id', '')), '');
      perform public.platform_secret_store('sms.' || (v_sms ->> 'provider'), v_value::jsonb, v_hint, null);
      update public.platform_settings set value = value || jsonb_build_object('connected', true, 'provider', v_sms ->> 'provider', 'hint', v_hint,
        'sender_id', coalesce(v_sender, ''), 'sender_ids', case when v_sender is null then '[]'::jsonb else jsonb_build_array(v_sender) end,
        'connected_at', now())
      where key = 'sms';
      if v_sender is not null then
        insert into public.merchant_service_overrides (merchant_id, service, sender_id, reason)
        values (v_m1, 'SMS', v_sender, 'Kept from the business''s own SMS settings when SMS moved to the platform')
        on conflict do nothing;
      end if;
    end if;
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 11. Grants, exemptions and ownership
-- -----------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array['platform_credits_overview(text,text,integer)', 'platform_merchant_credits(uuid)',
    'platform_credit_adjust(uuid,text,integer,text,text,timestamp with time zone,uuid)', 'platform_credit_package_save(jsonb)',
    'platform_usage_policy_save(text,jsonb,text)', 'platform_service_override_set(uuid,text,integer,integer,text,text)',
    'platform_service_status(text)', 'platform_sms_settings_save(jsonb,text)', 'platform_billing_gateways()', 'platform_billing_gateway_toggle(text,boolean)',
    'platform_usage_report(text,date,date,uuid)', 'my_credits()', 'credits_start_recharge(uuid)', 'billing_can_pay()']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  -- Called by edge functions with the service role only.
  foreach f in array array['courier_lookup_begin(text,text)', 'courier_lookup_finish(uuid,boolean,text)', 'billing_gateway_payment_create(uuid,text)',
    'billing_gateway_payment_session(uuid,text)', 'billing_gateway_lookup(text,text)', 'billing_gateway_confirm(text,text,text,numeric,boolean,jsonb)',
    'billing_gateway_pending(integer)', 'platform_sms_set_connection(text,text,text,numeric,uuid)', 'platform_sms_set_balance(numeric)',
    'platform_bd_courier_set_connection(text,text,uuid,boolean,text)', 'platform_billing_gateway_set(text,boolean,text,boolean,uuid)',
    'platform_record_action(uuid,text,text,text,text,jsonb)', 'platform_billing_gateways_config()']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  foreach f in array array['credit_available(uuid,text)', '_credit_expire(uuid,text)',
    '_credit_post(uuid,text,integer,text,text,uuid,text,text,text,text,timestamp with time zone,jsonb)', 'credits_expire_all()',
    '_usage_policy(text)', '_usage_state(uuid,text)', '_usage_charge(uuid,text,integer,text,text,boolean)', '_usage_refund(public.service_usage,text)',
    '_usage_finish(uuid,boolean,text,numeric,text)', '_usage_outcome(uuid,text,numeric)', '_sms_reserve(public.notification_logs)',
    '_billing_grant_credits(public.billing_invoices)', '_platform_sms_provider()', '_sms_sender_for(uuid)', '_platform_service_connected(text)']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;

insert into public.tenancy_exempt_functions (name, reason)
select f, 'Credits and metered services: works on one named merchant at a time, or on platform settings and accounts'
from unnest(array['credit_available', '_credit_expire', '_credit_post', 'credits_expire_all', '_usage_policy', '_usage_state', '_usage_charge',
  '_usage_refund', '_usage_finish', '_usage_outcome', '_platform_sms_provider', '_sms_sender_for', '_platform_service_connected', 'sms_dispatch_config',
  '_sms_reserve', '_billing_grant_credits', 'billing_can_pay', 'credits_start_recharge', 'billing_gateway_payment_create', 'billing_gateway_payment_session',
  'billing_gateway_lookup', 'billing_gateway_confirm', 'billing_gateway_pending', 'my_credits',
  'platform_credits_overview', 'platform_merchant_credits', 'platform_credit_adjust', 'platform_credit_package_save', 'platform_usage_policy_save',
  'platform_service_override_set', 'platform_service_status', 'platform_sms_settings_save', 'platform_sms_set_connection', 'platform_sms_set_balance',
  'platform_bd_courier_set_connection', 'platform_billing_gateway_set', 'platform_billing_gateways', 'platform_billing_gateway_toggle', 'platform_record_action', 'platform_billing_gateways_config',
  'platform_usage_report']) f
on conflict (name) do nothing;

-- sms_dispatch_config was owned by app_owner; it now reads platform settings.
alter function public.sms_dispatch_config() owner to postgres;

select public._tenancy_own_functions();
