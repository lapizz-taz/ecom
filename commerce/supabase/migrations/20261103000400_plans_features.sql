-- =============================================================================
-- Plans, subscriptions, billing and feature access.
--
-- * plans: price, billing cycle, trial, limits (stores, staff, products,
--   orders a month with optional overage charge) and the features they include.
-- * subscriptions: one current subscription per merchant; trials, renewals,
--   pause/resume/cancel, grace periods. billing_run() moves them along and
--   raises one invoice per period (never two).
-- * Invoices are paid only by a verified payment: a gateway confirmation, or a
--   manual payment that a second person verifies.
-- * Access rules (Global Settings) say what each account state allows: FULL,
--   READ_ONLY (staff can look, not change; customers can still order) or
--   BLOCKED (no admin, no new orders). The permission checks apply them.
-- * Features: a catalogue switched on/off globally, included or not by plan,
--   and overridden per merchant (exceptions and beta). Backend functions call
--   require_feature()/feature_enabled(), so a switch changes what works.
-- * config_versions: history of plans, features, access rules and platform
--   settings, with rollback for those only (never money or orders).
-- =============================================================================

-- Patches below compare and rewrite existing function text. Line endings are
-- normalized first, so they also apply when this file is pasted into an editor
-- that sends Windows line endings.
create or replace function pg_temp.lf(p text) returns text
language sql immutable as $$ select replace(p, E'\r', '') $$;
create or replace function pg_temp.lf_replace(p text, p_from text, p_to text) returns text
language sql immutable as $$ select replace(pg_temp.lf(p), pg_temp.lf(p_from), pg_temp.lf(p_to)) $$;

-- -----------------------------------------------------------------------------
-- 1. Configuration history
-- -----------------------------------------------------------------------------
create table public.config_versions (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('plan', 'feature', 'merchant_feature', 'access_rules', 'platform_setting', 'automation_rule')),
  ref text not null,
  data jsonb,
  note text,
  changed_by uuid,
  changed_at timestamptz not null default now()
);
create index config_versions_ref_idx on public.config_versions (kind, ref, id desc);
create trigger config_versions_immutable before update or delete on public.config_versions
  for each row execute function public.prevent_mutation();

create or replace function public._config_version(p_kind text, p_ref text, p_data jsonb, p_note text default null)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.config_versions (kind, ref, data, note, changed_by) values (p_kind, p_ref, p_data, p_note, auth.uid())
$$;

-- -----------------------------------------------------------------------------
-- 2. Feature catalogue
-- -----------------------------------------------------------------------------
create table public.features (
  code text primary key check (code ~ '^[a-z][a-z0-9_]{1,40}$'),
  name text not null,
  description text,
  category text not null default 'module',
  -- Core features run the order workflow itself and cannot be switched off.
  is_core boolean not null default false,
  globally_enabled boolean not null default true,
  release_stage text not null default 'GA' check (release_stage in ('GA', 'BETA', 'INTERNAL')),
  -- Which platform integration it depends on (shows "temporarily unavailable" when that fails).
  depends_on text,
  sort_order int not null default 100,
  updated_by uuid,
  updated_at timestamptz not null default now()
);

insert into public.features (code, name, description, category, is_core, depends_on, sort_order) values
  ('orders', 'Order management', 'Orders, statuses, fulfilment', 'core', true, null, 1),
  ('inventory', 'Inventory management', 'Stock, movements, purchases', 'core', true, null, 2),
  ('returns', 'Returns', 'Returns and restocking', 'core', true, null, 3),
  ('fraud_check', 'Fraud checking', 'Risk rules at checkout', 'core', true, null, 4),
  ('shopify', 'Shopify integration', 'Connect Shopify stores and import their orders', 'store', false, 'shopify', 10),
  ('woocommerce', 'WooCommerce integration', 'Connect WooCommerce stores and import their orders', 'store', false, 'woocommerce', 11),
  ('stock_sync', 'Stock synchronization', 'Push stock levels to connected stores', 'store', false, null, 12),
  ('abandoned_carts', 'Abandoned carts', 'Capture unfinished checkouts', 'growth', false, null, 20),
  ('attribution', 'Marketing attribution', 'Record where each order came from', 'growth', false, null, 21),
  ('reports', 'Analytics and reports', 'Reports and profit & loss', 'growth', false, null, 22),
  ('courier_history', 'Courier history checking', 'Customer delivery record before shipping', 'service', false, 'bd_courier', 30),
  ('sms', 'SMS', 'Order messages to customers by SMS', 'service', false, 'sms', 31),
  ('pbx', 'PBX', 'Browser phone and calls', 'service', false, 'pbx', 32),
  ('website_api', 'Website API', 'Sell through a custom-coded website', 'store', false, null, 13);

create table public.merchant_features (
  merchant_id uuid not null references public.merchants(id),
  feature_code text not null references public.features(code),
  -- null: follow the plan; true/false: exception for this merchant (also how beta access is given).
  enabled boolean,
  limit_value numeric,
  reason text,
  expires_at timestamptz,
  set_by uuid,
  set_at timestamptz not null default now(),
  primary key (merchant_id, feature_code)
);

-- -----------------------------------------------------------------------------
-- 3. Plans, add-ons and subscriptions
-- -----------------------------------------------------------------------------
create table public.plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z][A-Z0-9_]{1,30}$'),
  name text not null check (length(trim(name)) between 2 and 60),
  description text,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
  is_public boolean not null default true,
  price numeric(12, 2) not null default 0 check (price >= 0),
  currency text not null default 'BDT',
  billing_interval text not null default 'MONTH' check (billing_interval in ('MONTH', 'YEAR')),
  trial_days int not null default 0 check (trial_days between 0 and 365),
  -- {"stores": 2, "staff": 5, "products": 500, "orders_per_month": 1000}; missing = unlimited.
  limits jsonb not null default '{}'::jsonb,
  -- {"order_price": 2.5}: charged per order over orders_per_month on the next invoice.
  overage jsonb not null default '{}'::jsonb,
  -- {"shopify": true, "sms": false, ...}; missing = not included (core features are always on).
  features jsonb not null default '{}'::jsonb,
  sort_order int not null default 100,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger plans_updated_at before update on public.plans for each row execute function public.set_updated_at();

create table public.plan_addons (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z][A-Z0-9_]{1,30}$'),
  name text not null,
  description text,
  price numeric(12, 2) not null check (price >= 0),
  -- {"stores": 1} adds to the plan's limits while active.
  grants jsonb not null default '{}'::jsonb,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
  created_at timestamptz not null default now()
);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id),
  plan_id uuid not null references public.plans(id),
  status text not null check (status in ('TRIALING', 'ACTIVE', 'PAST_DUE', 'PAUSED', 'CANCELLED', 'EXPIRED')),
  price numeric(12, 2) not null,
  currency text not null default 'BDT',
  billing_interval text not null,
  started_at timestamptz not null default now(),
  trial_ends_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  grace_until timestamptz,
  cancel_at_period_end boolean not null default false,
  paused_at timestamptz,
  cancelled_at timestamptz,
  ended_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index subscriptions_one_current on public.subscriptions (merchant_id) where ended_at is null;
create trigger subscriptions_updated_at before update on public.subscriptions for each row execute function public.set_updated_at();

create table public.subscription_addons (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id),
  subscription_id uuid not null references public.subscriptions(id),
  addon_id uuid not null references public.plan_addons(id),
  quantity int not null default 1 check (quantity between 1 and 1000),
  price numeric(12, 2) not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create table public.subscription_events (
  id bigint generated always as identity primary key,
  merchant_id uuid not null references public.merchants(id),
  subscription_id uuid references public.subscriptions(id),
  event text not null,
  detail jsonb not null default '{}'::jsonb,
  actor_id uuid,
  created_at timestamptz not null default now()
);
create index subscription_events_merchant_idx on public.subscription_events (merchant_id, created_at desc);

create sequence public.billing_invoice_seq;
create table public.billing_invoices (
  id uuid primary key default gen_random_uuid(),
  number text not null unique default ('INV-' || lpad(nextval('public.billing_invoice_seq')::text, 6, '0')),
  merchant_id uuid not null references public.merchants(id),
  subscription_id uuid references public.subscriptions(id),
  kind text not null default 'SUBSCRIPTION' check (kind in ('SUBSCRIPTION', 'CREDITS', 'ADDON', 'OTHER')),
  period_start timestamptz,
  period_end timestamptz,
  lines jsonb not null default '[]'::jsonb,
  total numeric(12, 2) not null check (total >= 0),
  amount_paid numeric(12, 2) not null default 0,
  currency text not null default 'BDT',
  status text not null default 'OPEN' check (status in ('OPEN', 'PAID', 'VOID')),
  due_at timestamptz not null,
  paid_at timestamptz,
  void_reason text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One subscription invoice per period, however often the billing run retries.
create unique index billing_invoices_period_uq on public.billing_invoices (subscription_id, period_start) where kind = 'SUBSCRIPTION' and status <> 'VOID';
create index billing_invoices_merchant_idx on public.billing_invoices (merchant_id, created_at desc);
create trigger billing_invoices_updated_at before update on public.billing_invoices for each row execute function public.set_updated_at();

create table public.billing_payments (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id),
  invoice_id uuid not null references public.billing_invoices(id),
  amount numeric(12, 2) not null check (amount > 0),
  method text not null check (method in ('BKASH', 'NAGAD', 'BANK', 'CASH', 'GATEWAY', 'OTHER')),
  provider text,
  reference text,
  status text not null default 'PENDING' check (status in ('PENDING', 'SUCCEEDED', 'FAILED', 'REJECTED')),
  -- Manual payments are recorded by one person and verified by another.
  recorded_by uuid,
  verified_by uuid,
  verified_at timestamptz,
  note text,
  raw jsonb,
  created_at timestamptz not null default now(),
  check (verified_by is null or recorded_by is null or verified_by <> recorded_by)
);
create unique index billing_payments_reference_uq on public.billing_payments (method, reference) where reference is not null and status <> 'REJECTED';
create index billing_payments_invoice_idx on public.billing_payments (invoice_id);

-- Billing tables carry the merchant: merchant staff may read their own; only
-- platform functions write.
do $$
declare
  t text;
begin
  foreach t in array array['merchant_features', 'subscriptions', 'subscription_addons', 'subscription_events', 'billing_invoices', 'billing_payments'] loop
    execute format('create index if not exists %I on public.%I (merchant_id)', t || '_merchant_idx2', t);
    execute format('alter table public.%I enable row level security', t);
    execute format($p$create policy tenant_isolation on public.%I as restrictive for all to public
      using (merchant_id = (select public.current_merchant_id())) with check (merchant_id = (select public.current_merchant_id()))$p$, t);
    execute format('create policy app_owner_read on public.%I for select to app_owner using (true)', t);
    execute format($p$create policy staff_read on public.%I for select to authenticated using ((select public.is_staff()))$p$, t);
    execute format('revoke insert, update, delete, truncate on public.%I from anon, authenticated', t);
  end loop;
end $$;
alter table public.features enable row level security;
alter table public.plans enable row level security;
alter table public.plan_addons enable row level security;
alter table public.config_versions enable row level security;
create policy features_read on public.features for select to authenticated, app_owner using (true);
create policy plans_read on public.plans for select to authenticated using (status = 'ACTIVE' and is_public);
revoke insert, update, delete, truncate on public.features, public.plans, public.plan_addons from anon, authenticated;
revoke all on public.config_versions from anon, authenticated;

create or replace function public._tenancy_global_tables()
returns text[]
language sql
immutable
as $$
  select array['permissions', 'order_status_transitions', 'pbx_packages', 'pbx_gateway_status',
               'merchants', 'platform_staff', 'support_sessions', 'tenancy_exempt_functions',
               'platform_settings', 'platform_audit_logs', 'platform_credentials',
               'platform_modules', 'platform_roles', 'platform_role_permissions', 'platform_staff_merchants',
               'merchant_notes', 'platform_approvals', 'config_versions', 'features', 'plans', 'plan_addons']
$$;

-- -----------------------------------------------------------------------------
-- 4. Default plans, settings, and the existing merchant's plan
-- -----------------------------------------------------------------------------
insert into public.plans (code, name, description, is_public, price, trial_days, limits, features, sort_order) values
  ('FOUNDER', 'Founder', 'The original business on the platform: everything, no charge.', false, 0, 0, '{}'::jsonb,
   '{"shopify":true,"woocommerce":true,"stock_sync":true,"abandoned_carts":true,"attribution":true,"reports":true,"courier_history":true,"sms":true,"pbx":true,"website_api":true}', 0),
  ('STARTER', 'Starter', 'For a new online shop.', true, 990, 14, '{"stores":1,"staff":3,"products":300,"orders_per_month":500}'::jsonb,
   '{"woocommerce":true,"shopify":true,"reports":true,"courier_history":true,"sms":true}', 10),
  ('GROWTH', 'Growth', 'For a growing team.', true, 2490, 14, '{"stores":3,"staff":10,"products":3000,"orders_per_month":3000}'::jsonb,
   '{"woocommerce":true,"shopify":true,"stock_sync":true,"abandoned_carts":true,"attribution":true,"reports":true,"courier_history":true,"sms":true,"website_api":true}', 20),
  ('PRO', 'Pro', 'For high-volume merchants.', true, 5990, 14, '{"stores":10,"staff":30}'::jsonb,
   '{"woocommerce":true,"shopify":true,"stock_sync":true,"abandoned_carts":true,"attribution":true,"reports":true,"courier_history":true,"sms":true,"pbx":true,"website_api":true}', 30);
-- Prices above are starting points for the Super Admin to set; nothing is charged until a merchant is on a paid plan.

insert into public.platform_settings (key, value, description) values
  ('billing', jsonb_build_object('grace_days', 7, 'invoice_due_days', 7, 'expire_after_days', 30, 'default_plan', 'STARTER', 'currency', 'BDT'),
   'Grace period after an unpaid invoice, when invoices fall due, when an unpaid subscription expires, the plan new merchants start on'),
  ('access_rules', jsonb_build_object(
     'TRIALING', 'FULL', 'ACTIVE', 'FULL', 'PAST_DUE', 'FULL', 'PAST_DUE_AFTER_GRACE', 'READ_ONLY',
     'PAUSED', 'READ_ONLY', 'CANCELLED', 'READ_ONLY', 'EXPIRED', 'BLOCKED', 'NO_SUBSCRIPTION', 'FULL',
     'MERCHANT_SUSPENDED', 'BLOCKED', 'MERCHANT_ONBOARDING', 'FULL'),
   'What each account state allows: FULL, READ_ONLY (look but not change; customers can still order) or BLOCKED (no admin, no new orders)')
on conflict (key) do nothing;

insert into public.subscriptions (merchant_id, plan_id, status, price, billing_interval, started_at, current_period_start)
select m.id, (select id from public.plans where code = 'FOUNDER'), 'ACTIVE', 0, 'MONTH', m.created_at, m.created_at
from public.merchants m where m.number = 1
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 5. Access rules
-- -----------------------------------------------------------------------------
create or replace function public.merchant_access_mode(p_merchant uuid default null)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := coalesce(p_merchant, public.current_merchant_id());
  v_rules jsonb := coalesce((select value from public.platform_settings where key = 'access_rules'), '{}'::jsonb);
  v_status text;
  s public.subscriptions;
  v_sub_key text;
  v_a text;
  v_b text;
begin
  if v_id is null then
    return 'BLOCKED';
  end if;
  select status into v_status from public.merchants where id = v_id;
  if v_status is null or v_status = 'CLOSED' then
    return 'BLOCKED';
  end if;
  v_a := case v_status when 'SUSPENDED' then coalesce(v_rules ->> 'MERCHANT_SUSPENDED', 'BLOCKED')
                       when 'ONBOARDING' then coalesce(v_rules ->> 'MERCHANT_ONBOARDING', 'FULL') else 'FULL' end;
  -- The current subscription; when none, the last one that ended (expired or
  -- cancelled accounts stay restricted). NO_SUBSCRIPTION only if there never was one.
  select * into s from public.subscriptions where merchant_id = v_id
  order by (ended_at is null) desc, ended_at desc nulls last, created_at desc limit 1;
  v_sub_key := case
    when s.id is null then 'NO_SUBSCRIPTION'
    when s.status = 'PAST_DUE' and s.grace_until is not null and s.grace_until < now() then 'PAST_DUE_AFTER_GRACE'
    else s.status end;
  v_b := coalesce(v_rules ->> v_sub_key, 'FULL');
  -- The stricter of the two wins.
  return case when 'BLOCKED' in (v_a, v_b) then 'BLOCKED' when 'READ_ONLY' in (v_a, v_b) then 'READ_ONLY' else 'FULL' end;
end;
$$;

-- Staff checks follow the access mode: read-only keeps only *.view and *.export; blocked keeps nothing.
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (exists (
      select 1 from public.profiles p join public.roles r on r.id = p.role_id
      where p.id = auth.uid() and p.merchant_id = public.current_merchant_id()
        and p.is_active and public._device_ok(p.id, r.code))
    and public.merchant_access_mode() <> 'BLOCKED')
    or exists (
      select 1 from public.support_sessions s
      where s.id = public._support_session_id() and s.merchant_id = public.current_merchant_id())
$$;

create or replace function public.has_permission(p_code text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (exists (
      select 1
      from public.profiles p
      join public.roles r on r.id = p.role_id
      where p.id = auth.uid()
        and p.merchant_id = public.current_merchant_id()
        and p.is_active
        and public._device_ok(p.id, r.code)
        and (
          r.code = 'OWNER'
          or exists (
            select 1
            from public.role_permissions rp
            join public.permissions pm on pm.id = rp.permission_id
            where rp.role_id = r.id and pm.code = p_code
          )
        ))
    and (case public.merchant_access_mode() when 'FULL' then true when 'READ_ONLY' then p_code like '%.view' or p_code like '%.export' else false end))
    or exists (
      select 1 from public.support_sessions s
      where s.id = public._support_session_id()
        and s.merchant_id = public.current_merchant_id()
        and (p_code like '%.view' or (s.mode = 'ASSIST' and p_code = any (s.permissions))))
$$;

-- A blocked account takes no new orders, from any channel.
create or replace function public._orders_access_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.merchant_access_mode(new.merchant_id) = 'BLOCKED' then
    raise exception 'ACCOUNT_RESTRICTED: this store is not taking orders right now' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger orders_access_guard before insert on public.orders for each row execute function public._orders_access_guard();

-- -----------------------------------------------------------------------------
-- 6. Feature checks
-- -----------------------------------------------------------------------------
-- Every feature for a merchant: on or off, and why.
--   ENABLED, CORE, DISABLED_GLOBALLY, DISABLED_FOR_MERCHANT, NOT_IN_PLAN,
--   BETA_NOT_ENROLLED, UNAVAILABLE (allowed, but the integration it needs is failing right now).
-- UNAVAILABLE still counts as enabled: a failing connection is shown, never used
-- to refuse work (an order arriving while a store reports an error is still imported).
create or replace function public.merchant_entitlements(p_merchant uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := coalesce(p_merchant, public.current_merchant_id());
  v_plan public.plans;
  v_out jsonb := '{}'::jsonb;
  f public.features;
  o public.merchant_features;
  v_state text;
  v_limit numeric;
  v_failing text[] := '{}';
begin
  if v_id is null then
    return '{}'::jsonb;
  end if;
  select p.* into v_plan from public.subscriptions s join public.plans p on p.id = s.plan_id where s.merchant_id = v_id and s.ended_at is null;
  -- Integrations reported failing for this merchant right now.
  if exists (select 1 from public.sales_channels where merchant_id = v_id and platform = 'SHOPIFY' and status = 'ERROR') then v_failing := array_append(v_failing, 'shopify'); end if;
  if exists (select 1 from public.sales_channels where merchant_id = v_id and platform = 'WOOCOMMERCE' and status = 'ERROR') then v_failing := array_append(v_failing, 'woocommerce'); end if;
  v_failing := v_failing || coalesce(array(select jsonb_array_elements_text(value -> 'failing') from public.platform_settings where key = 'integration_health'), '{}');
  for f in select * from public.features order by sort_order loop
    select * into o from public.merchant_features where merchant_id = v_id and feature_code = f.code and (expires_at is null or expires_at > now());
    v_limit := coalesce(o.limit_value, nullif(v_plan.limits ->> f.code, '')::numeric);
    v_state := case
      when f.is_core then 'CORE'
      when not f.globally_enabled then 'DISABLED_GLOBALLY'
      when o.enabled is false then 'DISABLED_FOR_MERCHANT'
      when o.enabled is true then 'ENABLED'
      when f.release_stage <> 'GA' then 'BETA_NOT_ENROLLED'
      when coalesce((v_plan.features ->> f.code)::boolean, false) then 'ENABLED'
      else 'NOT_IN_PLAN' end;
    if v_state = 'ENABLED' and f.depends_on = any (v_failing) then
      v_state := 'UNAVAILABLE';
    end if;
    v_out := v_out || jsonb_build_object(f.code, jsonb_build_object('name', f.name, 'state', v_state,
      'enabled', v_state in ('ENABLED', 'CORE', 'UNAVAILABLE'), 'limit', v_limit, 'override', o.enabled, 'override_reason', o.reason));
  end loop;
  return v_out;
end;
$$;

create or replace function public.feature_enabled(p_code text, p_merchant uuid default null)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((public.merchant_entitlements(p_merchant) -> p_code ->> 'enabled')::boolean, false)
$$;

create or replace function public.require_feature(p_code text)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb := public.merchant_entitlements() -> p_code;
begin
  if coalesce((v ->> 'enabled')::boolean, false) then
    return;
  end if;
  raise exception 'FEATURE_OFF: % is %', coalesce(v ->> 'name', p_code),
    case v ->> 'state'
      when 'NOT_IN_PLAN' then 'not included in your plan'
      when 'DISABLED_GLOBALLY' then 'switched off for everyone right now'
      when 'DISABLED_FOR_MERCHANT' then 'switched off for your account'
      when 'BETA_NOT_ENROLLED' then 'in early access and not open to your account yet'
      else 'not available' end
    using errcode = 'P0001';
end;
$$;

-- How much of a plan limit is used now.
create or replace function public.merchant_usage(p_merchant uuid default null)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with m as (select coalesce(p_merchant, public.current_merchant_id()) as id)
  select jsonb_build_object(
    'stores', (select count(*) from public.sales_channels c, m where c.merchant_id = m.id and c.status <> 'DISCONNECTED'),
    'staff', (select count(*) from public.profiles p, m where p.merchant_id = m.id and p.is_active),
    'products', (select count(*) from public.products p, m where p.merchant_id = m.id and p.status <> 'ARCHIVED'),
    'orders_per_month', (select count(*) from public.orders o, m where o.merchant_id = m.id and o.created_at >= date_trunc('month', now())))
$$;

-- Limits from the plan plus active add-ons (missing = unlimited).
create or replace function public.merchant_limits(p_merchant uuid default null)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with m as (select coalesce(p_merchant, public.current_merchant_id()) as id),
  base as (select p.limits from public.subscriptions s join public.plans p on p.id = s.plan_id, m where s.merchant_id = m.id and s.ended_at is null),
  extra as (
    select g.key, sum(g.value::numeric * sa.quantity) as n
    from public.subscription_addons sa join public.plan_addons a on a.id = sa.addon_id, m, jsonb_each_text(a.grants) g
    where sa.merchant_id = m.id and sa.ended_at is null group by g.key)
  select coalesce((select jsonb_object_agg(k, (b.limits ->> k)::numeric + coalesce((select n from extra where extra.key = k), 0))
                   from base b, jsonb_object_keys(b.limits) k), '{}'::jsonb)
$$;

-- Stops a new store, staff member or product beyond the plan's limit.
create or replace function public.require_limit(p_key text)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit numeric := nullif(public.merchant_limits() ->> p_key, '')::numeric;
  v_used numeric := (public.merchant_usage() ->> p_key)::numeric;
begin
  if v_limit is not null and v_used >= v_limit then
    raise exception 'LIMIT_REACHED: your plan allows % %; upgrade the plan or ask for an add-on', v_limit,
      replace(p_key, '_', ' ') using errcode = 'P0001';
  end if;
end;
$$;

-- Enforcement in the functions that do the work.
create or replace function pg_temp.guard(p_fn regprocedure, p_guard text)
returns void
language plpgsql
as $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef(p_fn));
  v_pos int := position(E'\nbegin\n' in v_old);
begin
  if v_pos = 0 then
    raise exception 'features: % has no begin', p_fn;
  end if;
  execute overlay(v_old placing E'\nbegin\n' || pg_temp.lf(p_guard) || E'\n' from v_pos for 7);
end;
$$;

select pg_temp.guard('public.channel_upsert(jsonb,uuid)', $g$  perform public.require_feature(lower(p ->> 'platform'));
  if not exists (select 1 from public.sales_channels where platform = upper(p ->> 'platform') and lower(shop_domain) = lower(trim(p ->> 'shop_domain'))
                 and status <> 'DISCONNECTED') then
    perform public.require_limit('stores');
  end if;$g$);
select pg_temp.guard('public.channel_ingest_order(uuid,jsonb,text)', $g$  -- Switched off: the store's orders are not imported (the store keeps them).
  if not public.feature_enabled(lower((select platform from public.sales_channels where id = p_channel_id))) then
    return jsonb_build_object('status', 'SKIPPED', 'reason', 'FEATURE_OFF');
  end if;$g$);
select pg_temp.guard('public.capture_checkout_lead(jsonb)', $g$  if not public.feature_enabled('abandoned_carts') then
    return null;
  end if;$g$);
select pg_temp.guard('public.storefront_cart_sync(text,text,jsonb,jsonb)', $g$  if not public.feature_enabled('abandoned_carts') then
    return null;
  end if;$g$);
select pg_temp.guard('public.channel_abandoned_upsert(uuid,jsonb,text)', $g$  if not public.feature_enabled('abandoned_carts') then
    return 0;
  end if;$g$);
select pg_temp.guard('public._record_order_attribution(uuid,jsonb)', $g$  if not public.feature_enabled('attribution') then
    return null;
  end if;$g$);
select pg_temp.guard('public.site_api_key_check(text)', $g$  if not public.feature_enabled('website_api') then
    return null;
  end if;$g$);
select pg_temp.guard('public.pbx_issue_my_credential(text,text)', $g$  perform public.require_feature('pbx');$g$);
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.admin_save_product(jsonb)'::regprocedure));
  v_new text;
begin
  v_new := pg_temp.lf_replace(v_old, $o$  perform public.require_permission('products.manage');
$o$, $n$  perform public.require_permission('products.manage');
  if v_id is null then
    perform public.require_limit('products');
  end if;
$n$);
  if v_new = v_old then
    raise exception 'features: admin_save_product has changed';
  end if;
  execute v_new;
end $$;

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname like 'report\_%' and p.proname <> 'report_issue'
  loop
    perform pg_temp.guard(r.sig, $g$  if current_setting('app.core_report', true) is distinct from 'on' then
    perform public.require_feature('reports');
  end if;$g$);
  end loop;
end $$;
-- The dashboard and finance overview (part of every plan) use some reports for
-- their numbers; they mark the call so the reports switch does not apply there.
-- (A request is one transaction, and clients cannot set this setting themselves.)
select pg_temp.guard('public.dashboard_overview(date,date)', $g$  perform set_config('app.core_report', 'on', true);$g$);
select pg_temp.guard('public.dashboard_command_center(date,date)', $g$  perform set_config('app.core_report', 'on', true);$g$);
select pg_temp.guard('public.finance_overview(date,date)', $g$  perform set_config('app.core_report', 'on', true);$g$);

-- New active staff count against the plan's staff limit.
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.admin_set_user_role(uuid,text,boolean)'::regprocedure));
  v_new text;
begin
  -- (PERFORM resets FOUND, so the check reads the profile id instead.)
  v_new := pg_temp.lf_replace(v_old, $o$  select * into v_profile from public.profiles where id = p_user_id for update;
  if not found then$o$, $n$  select * into v_profile from public.profiles where id = p_user_id for update;
  if (v_profile.id is null or not v_profile.is_active) and p_is_active then
    perform public.require_limit('staff');
  end if;
  if v_profile.id is null then$n$);
  if v_new = v_old then
    raise exception 'features: admin_set_user_role has changed';
  end if;
  execute v_new;
end $$;

-- -----------------------------------------------------------------------------
-- 7. Billing
-- -----------------------------------------------------------------------------
create or replace function public._billing_interval(p_interval text)
returns interval
language sql
immutable
as $$
  select case p_interval when 'YEAR' then interval '1 year' else interval '1 month' end
$$;

create or replace function public._subscription_event(p_sub public.subscriptions, p_event text, p_detail jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.subscription_events (merchant_id, subscription_id, event, detail, actor_id)
  values (p_sub.merchant_id, p_sub.id, p_event, coalesce(p_detail, '{}'::jsonb), auth.uid())
$$;

-- The invoice for one period: plan price, active add-ons, and order overage of the period before.
create or replace function public._billing_invoice_for(p_sub public.subscriptions, p_start timestamptz, p_end timestamptz)
returns public.billing_invoices
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan public.plans;
  v_lines jsonb := '[]'::jsonb;
  v_total numeric := 0;
  v_due int := coalesce((select (value ->> 'invoice_due_days')::int from public.platform_settings where key = 'billing'), 7);
  v_inv public.billing_invoices;
  v_over numeric;
  v_orders bigint;
  v_prev_start timestamptz := p_start - public._billing_interval(p_sub.billing_interval);
  a record;
begin
  select * into v_inv from public.billing_invoices where subscription_id = p_sub.id and period_start = p_start and kind = 'SUBSCRIPTION' and status <> 'VOID';
  if v_inv.id is not null then
    return v_inv;
  end if;
  select * into v_plan from public.plans where id = p_sub.plan_id;
  v_lines := v_lines || jsonb_build_object('label', format('%s plan, %s – %s', v_plan.name, to_char(p_start, 'DD Mon YYYY'), to_char(p_end, 'DD Mon YYYY')),
    'amount', p_sub.price, 'kind', 'plan');
  v_total := p_sub.price;
  for a in select pa.name, sa.quantity, sa.price from public.subscription_addons sa join public.plan_addons pa on pa.id = sa.addon_id
           where sa.subscription_id = p_sub.id and sa.ended_at is null loop
    v_lines := v_lines || jsonb_build_object('label', format('%s × %s', a.name, a.quantity), 'amount', a.price * a.quantity, 'kind', 'addon');
    v_total := v_total + a.price * a.quantity;
  end loop;
  -- Orders over the limit in the previous period, at the plan's overage price (actual order count).
  v_over := nullif(v_plan.overage ->> 'order_price', '')::numeric;
  if v_over is not null and (v_plan.limits ->> 'orders_per_month') is not null and v_prev_start >= p_sub.started_at then
    select count(*) into v_orders from public.orders where merchant_id = p_sub.merchant_id and created_at >= v_prev_start and created_at < p_start;
    if v_orders > (v_plan.limits ->> 'orders_per_month')::bigint then
      v_lines := v_lines || jsonb_build_object('label', format('%s orders over the %s included', v_orders - (v_plan.limits ->> 'orders_per_month')::bigint,
        v_plan.limits ->> 'orders_per_month'), 'amount', round((v_orders - (v_plan.limits ->> 'orders_per_month')::bigint) * v_over, 2), 'kind', 'overage');
      v_total := v_total + round((v_orders - (v_plan.limits ->> 'orders_per_month')::bigint) * v_over, 2);
    end if;
  end if;
  insert into public.billing_invoices (merchant_id, subscription_id, kind, period_start, period_end, lines, total, currency, due_at, status, paid_at)
  values (p_sub.merchant_id, p_sub.id, 'SUBSCRIPTION', p_start, p_end, v_lines, v_total, p_sub.currency, now() + make_interval(days => v_due),
          case when v_total = 0 then 'PAID' else 'OPEN' end, case when v_total = 0 then now() end)
  on conflict do nothing
  returning * into v_inv;
  if v_inv.id is null then
    select * into v_inv from public.billing_invoices where subscription_id = p_sub.id and period_start = p_start and kind = 'SUBSCRIPTION' and status <> 'VOID';
  else
    perform public._subscription_event(p_sub, 'invoice.created', jsonb_build_object('invoice', v_inv.number, 'total', v_total));
  end if;
  return v_inv;
end;
$$;

-- A verified payment: the invoice is paid when fully covered, and its subscription period starts.
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
  end if;
  return v_inv;
end;
$$;

-- Hourly: trials end, periods renew, unpaid subscriptions go past due and, after
-- the configured time, expire. Safe to run any number of times.
create or replace function public.billing_run()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cfg jsonb := coalesce((select value from public.platform_settings where key = 'billing'), '{}'::jsonb);
  v_grace int := coalesce((v_cfg ->> 'grace_days')::int, 7);
  v_expire int := coalesce((v_cfg ->> 'expire_after_days')::int, 30);
  s public.subscriptions;
  v_inv public.billing_invoices;
  v_start timestamptz;
  v_end timestamptz;
  v jsonb := jsonb_build_object('renewed', 0, 'past_due', 0, 'expired', 0, 'cancelled', 0, 'trials_ended', 0);
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  for s in select * from public.subscriptions where ended_at is null and status in ('TRIALING', 'ACTIVE', 'PAST_DUE') order by created_at for update skip locked loop
    if s.status = 'TRIALING' and s.trial_ends_at <= now() then
      v_start := s.trial_ends_at;
      v_end := v_start + public._billing_interval(s.billing_interval);
      v_inv := public._billing_invoice_for(s, v_start, v_end);
      if v_inv.status = 'PAID' then
        update public.subscriptions set status = 'ACTIVE', current_period_start = v_start, current_period_end = v_end where id = s.id;
      else
        update public.subscriptions set status = 'PAST_DUE', grace_until = v_start + make_interval(days => v_grace) where id = s.id;
        v := jsonb_set(v, '{past_due}', to_jsonb((v ->> 'past_due')::int + 1));
      end if;
      perform public._subscription_event(s, 'trial.ended', jsonb_build_object('invoice', v_inv.number));
      v := jsonb_set(v, '{trials_ended}', to_jsonb((v ->> 'trials_ended')::int + 1));
    elsif s.status = 'ACTIVE' and s.current_period_end is not null and s.current_period_end <= now() then
      if s.cancel_at_period_end then
        update public.subscriptions set status = 'CANCELLED', cancelled_at = now(), ended_at = now() where id = s.id;
        perform public._subscription_event(s, 'subscription.cancelled', '{"at_period_end": true}');
        v := jsonb_set(v, '{cancelled}', to_jsonb((v ->> 'cancelled')::int + 1));
        continue;
      end if;
      v_start := s.current_period_end;
      v_end := v_start + public._billing_interval(s.billing_interval);
      v_inv := public._billing_invoice_for(s, v_start, v_end);
      if v_inv.status = 'PAID' then
        update public.subscriptions set current_period_start = v_start, current_period_end = v_end where id = s.id;
        v := jsonb_set(v, '{renewed}', to_jsonb((v ->> 'renewed')::int + 1));
      else
        update public.subscriptions set status = 'PAST_DUE', grace_until = v_start + make_interval(days => v_grace) where id = s.id;
        perform public._subscription_event(s, 'subscription.past_due', jsonb_build_object('invoice', v_inv.number));
        v := jsonb_set(v, '{past_due}', to_jsonb((v ->> 'past_due')::int + 1));
      end if;
    elsif s.status = 'PAST_DUE' and s.grace_until is not null and s.grace_until + make_interval(days => greatest(v_expire - v_grace, 0)) <= now() then
      update public.subscriptions set status = 'EXPIRED', ended_at = now() where id = s.id;
      perform public._subscription_event(s, 'subscription.expired');
      v := jsonb_set(v, '{expired}', to_jsonb((v ->> 'expired')::int + 1));
    end if;
  end loop;
  return v;
end;
$$;
revoke execute on function public.billing_run() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('billing-run', '7 * * * *', 'select public.billing_run()');
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 8. Super Admin: plans, features, subscriptions, invoices, payments, settings
-- -----------------------------------------------------------------------------
create or replace function public.platform_plans_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._platform_require('subscriptions', 'view');
  return jsonb_build_object(
    'plans', coalesce((select jsonb_agg(to_jsonb(p) || jsonb_build_object(
        'subscribers', (select count(*) from public.subscriptions s where s.plan_id = p.id and s.ended_at is null),
        'mrr', (select coalesce(sum(case s.billing_interval when 'YEAR' then s.price / 12 else s.price end), 0) from public.subscriptions s
                where s.plan_id = p.id and s.ended_at is null and s.status in ('ACTIVE', 'PAST_DUE')))
      order by p.status, p.sort_order, p.price) from public.plans p), '[]'::jsonb),
    'addons', coalesce((select jsonb_agg(to_jsonb(a) order by a.status, a.name) from public.plan_addons a), '[]'::jsonb),
    'features', coalesce((select jsonb_agg(to_jsonb(f) order by f.sort_order) from public.features f), '[]'::jsonb));
end;
$$;

create or replace function public.platform_plan_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan public.plans;
  v_before jsonb;
  v_id uuid := nullif(p ->> 'id', '')::uuid;
begin
  perform public._platform_require('subscriptions', case when v_id is null then 'create' else 'edit' end);
  if v_id is not null then
    select to_jsonb(x) into v_before from public.plans x where id = v_id;
    if v_before is null then
      raise exception 'NOT_FOUND: plan not found' using errcode = 'P0002';
    end if;
    -- Existing subscriptions keep their price until changed on purpose.
    update public.plans set
      name = coalesce(nullif(trim(p ->> 'name'), ''), name),
      description = case when p ? 'description' then p ->> 'description' else description end,
      is_public = coalesce((p ->> 'is_public')::boolean, is_public),
      price = coalesce((p ->> 'price')::numeric, price),
      billing_interval = coalesce(p ->> 'billing_interval', billing_interval),
      trial_days = coalesce((p ->> 'trial_days')::int, trial_days),
      limits = coalesce(p -> 'limits', limits),
      overage = coalesce(p -> 'overage', overage),
      features = coalesce(p -> 'features', features),
      sort_order = coalesce((p ->> 'sort_order')::int, sort_order)
    where id = v_id returning * into v_plan;
  else
    insert into public.plans (code, name, description, is_public, price, billing_interval, trial_days, limits, overage, features, sort_order, created_by)
    values (upper(regexp_replace(coalesce(nullif(p ->> 'code', ''), p ->> 'name'), '[^A-Za-z0-9]+', '_', 'g')), trim(p ->> 'name'), p ->> 'description',
            coalesce((p ->> 'is_public')::boolean, true), coalesce((p ->> 'price')::numeric, 0), coalesce(p ->> 'billing_interval', 'MONTH'),
            coalesce((p ->> 'trial_days')::int, 0), coalesce(p -> 'limits', '{}'::jsonb), coalesce(p -> 'overage', '{}'::jsonb),
            coalesce(p -> 'features', '{}'::jsonb), coalesce((p ->> 'sort_order')::int, 100), auth.uid())
    returning * into v_plan;
  end if;
  perform public._config_version('plan', v_plan.id::text, to_jsonb(v_plan), p ->> 'note');
  perform public._platform_log(case when v_id is null then 'subscription.plan_created' else 'subscription.plan_updated' end, null, 'plan',
    v_plan.id::text, p ->> 'note', v_before, to_jsonb(v_plan));
  return to_jsonb(v_plan);
end;
$$;

create or replace function public.platform_plan_set_status(p_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan public.plans;
begin
  perform public._platform_require('subscriptions', 'manage');
  update public.plans set status = p_status where id = p_id and p_status in ('ACTIVE', 'ARCHIVED') returning * into v_plan;
  if v_plan.id is null then
    raise exception 'NOT_FOUND: plan not found' using errcode = 'P0002';
  end if;
  perform public._config_version('plan', v_plan.id::text, to_jsonb(v_plan), 'status ' || p_status);
  perform public._platform_log('subscription.plan_' || lower(p_status), null, 'plan', p_id::text, null, null, jsonb_build_object('status', p_status));
end;
$$;

create or replace function public.platform_addon_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.plan_addons;
begin
  perform public._platform_require('subscriptions', 'edit');
  if nullif(p ->> 'id', '') is null then
    insert into public.plan_addons (code, name, description, price, grants)
    values (upper(regexp_replace(coalesce(nullif(p ->> 'code', ''), p ->> 'name'), '[^A-Za-z0-9]+', '_', 'g')), trim(p ->> 'name'), p ->> 'description',
            (p ->> 'price')::numeric, coalesce(p -> 'grants', '{}'::jsonb))
    returning * into v;
  else
    update public.plan_addons set name = coalesce(nullif(trim(p ->> 'name'), ''), name), description = coalesce(p ->> 'description', description),
      price = coalesce((p ->> 'price')::numeric, price), grants = coalesce(p -> 'grants', grants), status = coalesce(p ->> 'status', status)
    where id = (p ->> 'id')::uuid returning * into v;
  end if;
  perform public._platform_log('subscription.addon_saved', null, 'plan_addon', v.id::text, null, null, to_jsonb(v));
  return to_jsonb(v);
end;
$$;

-- Turns a feature on/off for everyone, or changes its release stage.
create or replace function public.platform_feature_save(p_code text, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before public.features;
  v public.features;
begin
  perform public._platform_require('features', 'manage');
  select * into v_before from public.features where code = p_code for update;
  if v_before.code is null then
    raise exception 'NOT_FOUND: feature not found' using errcode = 'P0002';
  end if;
  if v_before.is_core and (p ->> 'globally_enabled')::boolean is false then
    raise exception 'VALIDATION: % runs the order workflow and cannot be switched off', v_before.name using errcode = '22023';
  end if;
  update public.features set globally_enabled = coalesce((p ->> 'globally_enabled')::boolean, globally_enabled),
    release_stage = coalesce(p ->> 'release_stage', release_stage), updated_by = auth.uid(), updated_at = now()
  where code = p_code returning * into v;
  perform public._config_version('feature', p_code, to_jsonb(v), p ->> 'reason');
  perform public._platform_log('features.global_changed', null, 'feature', p_code, p ->> 'reason', to_jsonb(v_before), to_jsonb(v));
  return to_jsonb(v);
end;
$$;

-- An exception for one merchant: on, off, or back to the plan (enabled = null).
create or replace function public.platform_merchant_feature_set(p_merchant uuid, p_code text, p_enabled boolean, p_reason text,
  p_limit numeric default null, p_expires_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb;
begin
  perform public._platform_require('features', 'edit', p_merchant);
  if coalesce(length(trim(p_reason)), 0) < 3 then
    raise exception 'VALIDATION: give a reason' using errcode = '22023';
  end if;
  if (select is_core from public.features where code = p_code) and p_enabled is false then
    raise exception 'VALIDATION: core features cannot be switched off' using errcode = '22023';
  end if;
  select public.merchant_entitlements(p_merchant) -> p_code into v_before;
  if p_enabled is null and p_limit is null then
    delete from public.merchant_features where merchant_id = p_merchant and feature_code = p_code;
  else
    insert into public.merchant_features (merchant_id, feature_code, enabled, limit_value, reason, expires_at, set_by)
    values (p_merchant, p_code, p_enabled, p_limit, p_reason, p_expires_at, auth.uid())
    on conflict (merchant_id, feature_code) do update set enabled = excluded.enabled, limit_value = excluded.limit_value, reason = excluded.reason,
      expires_at = excluded.expires_at, set_by = excluded.set_by, set_at = now();
  end if;
  perform public._config_version('merchant_feature', p_merchant::text || ':' || p_code,
    jsonb_build_object('enabled', p_enabled, 'limit', p_limit, 'expires_at', p_expires_at), p_reason);
  perform public._platform_log('features.merchant_changed', p_merchant, 'feature', p_code, p_reason, v_before,
    public.merchant_entitlements(p_merchant) -> p_code);
  return public.merchant_entitlements(p_merchant) -> p_code;
end;
$$;

-- Previews a feature change for many merchants (bulk), then applies it with the preview's token.
create or replace function public.platform_feature_bulk_preview(p_merchants uuid[], p_code text, p_enabled boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._platform_require('features', 'edit');
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name,
        'now', public.merchant_entitlements(m.id) -> p_code ->> 'state', 'allowed', public.platform_can('features', 'edit', m.id)) order by m.number)
      from public.merchants m where m.id = any (p_merchants)), '[]'::jsonb),
    'token', md5(p_code || ':' || coalesce(p_enabled::text, 'plan') || ':' || array_to_string(array(select unnest(p_merchants)::text order by 1), ',')));
end;
$$;

create or replace function public.platform_feature_bulk_apply(p_merchants uuid[], p_code text, p_enabled boolean, p_reason text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  m uuid;
  v_n int := 0;
begin
  perform public._platform_require('features', 'edit');
  if p_token is distinct from md5(p_code || ':' || coalesce(p_enabled::text, 'plan') || ':' || array_to_string(array(select unnest(p_merchants)::text order by 1), ',')) then
    raise exception 'VALIDATION: review the list of merchants first' using errcode = '22023';
  end if;
  foreach m in array p_merchants loop
    continue when not public.platform_can('features', 'edit', m);
    perform public.platform_merchant_feature_set(m, p_code, p_enabled, p_reason);
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('changed', v_n);
end;
$$;

create or replace function public.platform_merchant_billing(p_merchant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  s public.subscriptions;
begin
  perform public._platform_require('subscriptions', 'view', p_merchant);
  select * into s from public.subscriptions where merchant_id = p_merchant and ended_at is null;
  return jsonb_build_object(
    'subscription', case when s.id is null then null else to_jsonb(s) || jsonb_build_object('plan', (select to_jsonb(p) from public.plans p where p.id = s.plan_id)) end,
    'access_mode', public.merchant_access_mode(p_merchant),
    'limits', public.merchant_limits(p_merchant),
    'usage', public.merchant_usage(p_merchant),
    'entitlements', public.merchant_entitlements(p_merchant),
    'addons', coalesce((select jsonb_agg(jsonb_build_object('id', sa.id, 'name', a.name, 'quantity', sa.quantity, 'price', sa.price, 'grants', a.grants))
               from public.subscription_addons sa join public.plan_addons a on a.id = sa.addon_id where sa.merchant_id = p_merchant and sa.ended_at is null), '[]'::jsonb),
    'invoices', coalesce((select jsonb_agg(to_jsonb(i) order by i.created_at desc) from (select * from public.billing_invoices where merchant_id = p_merchant
               order by created_at desc limit 24) i), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(to_jsonb(x) - 'raw' order by x.created_at desc) from (select * from public.billing_payments where merchant_id = p_merchant
               order by created_at desc limit 24) x), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at desc) from (select * from public.subscription_events where merchant_id = p_merchant
               order by created_at desc limit 30) e), '[]'::jsonb));
end;
$$;

-- Starts, changes, extends, pauses, resumes or cancels a merchant's subscription.
create or replace function public.platform_subscription_action(p_merchant uuid, p_action text, p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s public.subscriptions;
  v_before jsonb;
  v_plan public.plans;
  v_reason text := nullif(trim(p ->> 'reason'), '');
  v_days int;
begin
  perform public._platform_require('subscriptions', 'manage', p_merchant);
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'VALIDATION: give a reason' using errcode = '22023';
  end if;
  select * into s from public.subscriptions where merchant_id = p_merchant and ended_at is null for update;
  v_before := to_jsonb(s);
  case p_action
    when 'change_plan' then
      select * into v_plan from public.plans where id = (p ->> 'plan_id')::uuid and status = 'ACTIVE';
      if v_plan.id is null then
        raise exception 'VALIDATION: choose an active plan' using errcode = '22023';
      end if;
      if s.id is null then
        insert into public.subscriptions (merchant_id, plan_id, status, price, currency, billing_interval, trial_ends_at, current_period_start, current_period_end, created_by)
        values (p_merchant, v_plan.id,
                case when coalesce((p ->> 'trial')::boolean, v_plan.trial_days > 0) and v_plan.trial_days > 0 then 'TRIALING' else 'ACTIVE' end,
                coalesce((p ->> 'price')::numeric, v_plan.price), v_plan.currency, v_plan.billing_interval,
                case when coalesce((p ->> 'trial')::boolean, v_plan.trial_days > 0) and v_plan.trial_days > 0 then now() + make_interval(days => v_plan.trial_days) end,
                now(), case when not (coalesce((p ->> 'trial')::boolean, v_plan.trial_days > 0) and v_plan.trial_days > 0) then now() end, auth.uid())
        returning * into s;
        -- A paid plan without a trial starts with its first invoice; the period begins when it is paid.
        if s.status = 'ACTIVE' and s.price > 0 then
          update public.subscriptions set status = 'PAST_DUE', current_period_end = null,
            grace_until = now() + make_interval(days => coalesce((select (value ->> 'grace_days')::int from public.platform_settings where key = 'billing'), 7))
          where id = s.id returning * into s;
          perform public._billing_invoice_for(s, now(), now() + public._billing_interval(s.billing_interval));
        elsif s.status = 'ACTIVE' then
          update public.subscriptions set current_period_end = now() + public._billing_interval(billing_interval) where id = s.id returning * into s;
        end if;
        perform public._subscription_event(s, 'subscription.started', jsonb_build_object('plan', v_plan.code, 'reason', v_reason));
      else
        -- The new plan and price apply from the next invoice; nothing already invoiced changes.
        update public.subscriptions set plan_id = v_plan.id, price = coalesce((p ->> 'price')::numeric, v_plan.price), billing_interval = v_plan.billing_interval
        where id = s.id returning * into s;
        perform public._subscription_event(s, 'subscription.plan_changed', jsonb_build_object('plan', v_plan.code, 'reason', v_reason));
      end if;
    when 'extend_trial' then
      v_days := (p ->> 'days')::int;
      if s.id is null or s.status not in ('TRIALING', 'PAST_DUE') or v_days is null or v_days not between 1 and 90 then
        raise exception 'VALIDATION: only a trial (or a trial that just ended unpaid) can be extended, by 1 to 90 days' using errcode = '22023';
      end if;
      update public.subscriptions set status = 'TRIALING', grace_until = null,
        trial_ends_at = greatest(coalesce(trial_ends_at, now()), now()) + make_interval(days => v_days)
      where id = s.id returning * into s;
      perform public._subscription_event(s, 'trial.extended', jsonb_build_object('days', v_days, 'reason', v_reason));
    when 'pause' then
      if s.id is null or s.status not in ('ACTIVE', 'TRIALING', 'PAST_DUE') then
        raise exception 'VALIDATION: nothing to pause' using errcode = '22023';
      end if;
      update public.subscriptions set status = 'PAUSED', paused_at = now() where id = s.id returning * into s;
      perform public._subscription_event(s, 'subscription.paused', jsonb_build_object('reason', v_reason));
    when 'resume' then
      if s.id is null or s.status <> 'PAUSED' then
        raise exception 'VALIDATION: the subscription is not paused' using errcode = '22023';
      end if;
      -- The paused time is added to the current period.
      update public.subscriptions set status = case when trial_ends_at > now() then 'TRIALING' else 'ACTIVE' end,
        current_period_end = current_period_end + (now() - paused_at), paused_at = null
      where id = s.id returning * into s;
      perform public._subscription_event(s, 'subscription.resumed', jsonb_build_object('reason', v_reason));
    when 'cancel' then
      if s.id is null then
        raise exception 'VALIDATION: no subscription' using errcode = '22023';
      end if;
      if coalesce((p ->> 'immediately')::boolean, false) then
        update public.subscriptions set status = 'CANCELLED', cancelled_at = now(), ended_at = now() where id = s.id returning * into s;
      else
        update public.subscriptions set cancel_at_period_end = true where id = s.id returning * into s;
      end if;
      perform public._subscription_event(s, 'subscription.cancel', jsonb_build_object('immediately', coalesce((p ->> 'immediately')::boolean, false), 'reason', v_reason));
    when 'undo_cancel' then
      update public.subscriptions set cancel_at_period_end = false where id = s.id and cancel_at_period_end returning * into s;
      perform public._subscription_event(s, 'subscription.cancel_undone', jsonb_build_object('reason', v_reason));
    when 'add_addon' then
      if s.id is null then
        raise exception 'VALIDATION: start a subscription first' using errcode = '22023';
      end if;
      insert into public.subscription_addons (merchant_id, subscription_id, addon_id, quantity, price)
      select p_merchant, s.id, a.id, coalesce((p ->> 'quantity')::int, 1), a.price from public.plan_addons a where a.id = (p ->> 'addon_id')::uuid and a.status = 'ACTIVE';
      perform public._subscription_event(s, 'addon.added', jsonb_build_object('addon_id', p ->> 'addon_id', 'reason', v_reason));
    when 'remove_addon' then
      update public.subscription_addons set ended_at = now() where id = (p ->> 'subscription_addon_id')::uuid and merchant_id = p_merchant and ended_at is null;
      perform public._subscription_event(s, 'addon.removed', jsonb_build_object('id', p ->> 'subscription_addon_id', 'reason', v_reason));
    else
      raise exception 'VALIDATION: unknown action %', p_action using errcode = '22023';
  end case;
  perform public._platform_log('subscription.' || p_action, p_merchant, 'subscription', s.id::text, v_reason, v_before, to_jsonb(s));
  return public.platform_merchant_billing(p_merchant);
end;
$$;

create or replace function public.platform_invoices_list(p_filters jsonb default '{}'::jsonb, p_limit int default 50, p_offset int default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text := nullif(p_filters ->> 'status', '');
  v_overdue boolean := coalesce((p_filters ->> 'overdue')::boolean, false);
begin
  perform public._platform_require('subscriptions', 'view');
  return (with rows as (
      select i.*, m.name as merchant_name, m.number as merchant_number from public.billing_invoices i join public.merchants m on m.id = i.merchant_id
      where i.merchant_id in (select public._platform_merchant_ids())
        and (v_status is null or i.status = v_status)
        and (not v_overdue or (i.status = 'OPEN' and i.due_at < now())))
    select jsonb_build_object('total', (select count(*) from rows),
      'items', coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at desc) from (select * from rows order by created_at desc limit p_limit offset p_offset) r), '[]'::jsonb),
      'pending_payments', coalesce((select jsonb_agg(to_jsonb(bp) - 'raw' || jsonb_build_object('invoice_number', i.number, 'merchant', m.name, 'can_verify',
            bp.recorded_by is distinct from auth.uid() and public.platform_can('subscriptions', 'approve', bp.merchant_id)) order by bp.created_at)
          from public.billing_payments bp join public.billing_invoices i on i.id = bp.invoice_id join public.merchants m on m.id = bp.merchant_id
          where bp.status = 'PENDING' and bp.merchant_id in (select public._platform_merchant_ids())), '[]'::jsonb)));
end;
$$;

-- A payment received outside a gateway (bank, cash, Send Money). It counts only
-- after a second person verifies it against the statement.
create or replace function public.platform_payment_record(p_invoice uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inv public.billing_invoices;
  v public.billing_payments;
begin
  select * into v_inv from public.billing_invoices where id = p_invoice;
  if v_inv.id is null then
    raise exception 'NOT_FOUND: invoice not found' using errcode = 'P0002';
  end if;
  perform public._platform_require('subscriptions', 'manage', v_inv.merchant_id);
  if v_inv.status <> 'OPEN' then
    raise exception 'VALIDATION: the invoice is %', lower(v_inv.status) using errcode = '22023';
  end if;
  if nullif(trim(p ->> 'reference'), '') is null then
    raise exception 'VALIDATION: enter the transaction or receipt reference' using errcode = '22023';
  end if;
  insert into public.billing_payments (merchant_id, invoice_id, amount, method, reference, status, recorded_by, note)
  values (v_inv.merchant_id, v_inv.id, (p ->> 'amount')::numeric, coalesce(p ->> 'method', 'BANK'), trim(p ->> 'reference'), 'PENDING', auth.uid(), p ->> 'note')
  returning * into v;
  perform public._platform_log('billing.payment_recorded', v_inv.merchant_id, 'billing_payment', v.id::text, p ->> 'note', null,
    jsonb_build_object('invoice', v_inv.number, 'amount', v.amount, 'method', v.method, 'reference', v.reference), 'REQUESTED');
  return to_jsonb(v) - 'raw';
end;
$$;

create or replace function public.platform_payment_verify(p_payment uuid, p_approve boolean, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.billing_payments;
  v_inv public.billing_invoices;
begin
  select * into v from public.billing_payments where id = p_payment for update;
  if v.id is null then
    raise exception 'NOT_FOUND: payment not found' using errcode = 'P0002';
  end if;
  perform public._platform_require('subscriptions', 'approve', v.merchant_id);
  if v.status <> 'PENDING' then
    raise exception 'VALIDATION: this payment is already %', lower(v.status) using errcode = '22023';
  end if;
  if v.recorded_by = auth.uid() then
    raise exception 'PERMISSION_DENIED: a second person must verify a payment you recorded' using errcode = '42501';
  end if;
  update public.billing_payments set status = case when p_approve then 'SUCCEEDED' else 'REJECTED' end, verified_by = auth.uid(), verified_at = now(),
    note = coalesce(note || ' · ', '') || coalesce(p_note, '')
  where id = v.id returning * into v;
  if p_approve then
    v_inv := public._billing_apply_payment(v);
  end if;
  perform public._platform_log(case when p_approve then 'billing.payment_verified' else 'billing.payment_rejected' end, v.merchant_id, 'billing_payment',
    v.id::text, p_note, null, jsonb_build_object('amount', v.amount, 'invoice_status', v_inv.status));
  return jsonb_build_object('payment', to_jsonb(v) - 'raw', 'invoice', to_jsonb(v_inv));
end;
$$;

create or replace function public.platform_invoice_void(p_invoice uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inv public.billing_invoices;
begin
  select * into v_inv from public.billing_invoices where id = p_invoice for update;
  if v_inv.id is null then
    raise exception 'NOT_FOUND: invoice not found' using errcode = 'P0002';
  end if;
  perform public._platform_require('subscriptions', 'manage', v_inv.merchant_id);
  if v_inv.status <> 'OPEN' or v_inv.amount_paid > 0 then
    raise exception 'VALIDATION: only an unpaid open invoice can be voided' using errcode = '22023';
  end if;
  if coalesce(length(trim(p_reason)), 0) < 5 then
    raise exception 'VALIDATION: give a reason' using errcode = '22023';
  end if;
  update public.billing_invoices set status = 'VOID', void_reason = p_reason where id = v_inv.id;
  perform public._platform_log('billing.invoice_voided', v_inv.merchant_id, 'billing_invoice', v_inv.id::text, p_reason, to_jsonb(v_inv), null);
end;
$$;

-- Global settings that live in platform_settings, with history.
create or replace function public.platform_setting_save(p_key text, p_value jsonb, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb;
begin
  perform public._platform_require('settings', 'edit');
  if p_key = 'access_rules' then
    perform public._platform_require('subscriptions', 'manage');
    if exists (select 1 from jsonb_each_text(p_value) e where e.value not in ('FULL', 'READ_ONLY', 'BLOCKED')) then
      raise exception 'VALIDATION: each rule is FULL, READ_ONLY or BLOCKED' using errcode = '22023';
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

create or replace function public.platform_settings_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._platform_require('settings', 'view');
  return coalesce((select jsonb_object_agg(key, jsonb_build_object('value', value, 'description', description, 'updated_at', updated_at))
                   from public.platform_settings), '{}'::jsonb);
end;
$$;

-- Configuration history and rollback (configuration only — never money or orders).
create or replace function public.platform_config_history(p_kind text default null, p_ref text default null, p_limit int default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._platform_require('settings', 'view');
  return coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'kind', v.kind, 'ref', v.ref, 'data', v.data, 'note', v.note,
      'changed_at', v.changed_at, 'changed_by', (select coalesce(nullif(s.full_name, ''), s.email) from public.platform_staff s where s.user_id = v.changed_by))
      order by v.id desc)
    from (select * from public.config_versions where (p_kind is null or kind = p_kind) and (p_ref is null or ref = p_ref)
          order by id desc limit greatest(1, least(p_limit, 500))) v), '[]'::jsonb);
end;
$$;

create or replace function public.platform_config_rollback(p_version bigint, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.config_versions;
  m uuid;
  c text;
begin
  select * into v from public.config_versions where id = p_version;
  if v.id is null then
    raise exception 'NOT_FOUND: version not found' using errcode = 'P0002';
  end if;
  if coalesce(length(trim(p_reason)), 0) < 5 then
    raise exception 'VALIDATION: give a reason' using errcode = '22023';
  end if;
  case v.kind
    when 'plan' then
      -- Limits, features and prices for future invoices; subscriptions and invoices already made are not touched.
      perform public.platform_plan_save(jsonb_build_object('id', v.ref, 'name', v.data ->> 'name', 'description', v.data ->> 'description',
        'is_public', v.data -> 'is_public', 'price', v.data -> 'price', 'billing_interval', v.data ->> 'billing_interval',
        'trial_days', v.data -> 'trial_days', 'limits', v.data -> 'limits', 'overage', v.data -> 'overage', 'features', v.data -> 'features',
        'note', 'Rolled back to version ' || v.id || ': ' || p_reason));
    when 'feature' then
      perform public.platform_feature_save(v.ref, jsonb_build_object('globally_enabled', v.data -> 'globally_enabled', 'release_stage', v.data ->> 'release_stage',
        'reason', 'Rolled back to version ' || v.id || ': ' || p_reason));
    when 'merchant_feature' then
      m := split_part(v.ref, ':', 1)::uuid;
      c := split_part(v.ref, ':', 2);
      perform public.platform_merchant_feature_set(m, c, (v.data ->> 'enabled')::boolean, 'Rolled back to version ' || v.id || ': ' || p_reason,
        (v.data ->> 'limit')::numeric, (v.data ->> 'expires_at')::timestamptz);
    when 'access_rules', 'platform_setting' then
      perform public.platform_setting_save(v.ref, v.data, 'Rolled back to version ' || v.id || ': ' || p_reason);
    else
      raise exception 'VALIDATION: % changes cannot be rolled back here', v.kind using errcode = '22023';
  end case;
  return jsonb_build_object('rolled_back_to', v.id);
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. The merchant's own view of plan, limits, features and invoices
-- -----------------------------------------------------------------------------
create or replace function public.my_plan()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_merchant uuid := public.current_merchant_id();
  s public.subscriptions;
begin
  -- Any active staff member of the merchant, even when the account is blocked (so they can see why and pay).
  if not exists (select 1 from public.profiles where id = auth.uid() and merchant_id = v_merchant and is_active) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select * into s from public.subscriptions where merchant_id = v_merchant and ended_at is null;
  return jsonb_build_object(
    'merchant', (select jsonb_build_object('name', name, 'status', status, 'status_reason', status_reason) from public.merchants where id = v_merchant),
    'access_mode', public.merchant_access_mode(v_merchant),
    'subscription', case when s.id is null then null else jsonb_build_object('status', s.status, 'price', s.price, 'currency', s.currency,
      'billing_interval', s.billing_interval, 'trial_ends_at', s.trial_ends_at, 'current_period_end', s.current_period_end, 'grace_until', s.grace_until,
      'cancel_at_period_end', s.cancel_at_period_end,
      'plan', (select jsonb_build_object('name', p.name, 'code', p.code, 'description', p.description) from public.plans p where p.id = s.plan_id)) end,
    'limits', public.merchant_limits(v_merchant),
    'usage', public.merchant_usage(v_merchant),
    'features', public.merchant_entitlements(v_merchant),
    'invoices', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'number', i.number, 'total', i.total, 'amount_paid', i.amount_paid, 'currency', i.currency,
        'status', i.status, 'due_at', i.due_at, 'paid_at', i.paid_at, 'period_start', i.period_start, 'period_end', i.period_end, 'lines', i.lines) order by i.created_at desc)
      from (select * from public.billing_invoices where merchant_id = v_merchant and status <> 'VOID' order by created_at desc limit 24) i), '[]'::jsonb));
end;
$$;
grant execute on function public.my_plan() to authenticated;

-- get_my_access tells the app what the account allows right now.
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.get_my_access()'::regprocedure));
  v_new text;
begin
  v_new := pg_temp.lf_replace(v_old, $o$    'merchant_id', v_p.merchant_id,$o$, $n$    'merchant_id', v_p.merchant_id,
    'access_mode', public.merchant_access_mode(v_p.merchant_id),$n$);
  if v_new = v_old then
    raise exception 'features: get_my_access() has changed';
  end if;
  execute v_new;
end $$;

-- -----------------------------------------------------------------------------
-- 10. New merchants start on the default plan (trial when it has one)
-- -----------------------------------------------------------------------------
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.platform_merchant_create(jsonb)'::regprocedure));
  v_new text;
begin
  v_new := pg_temp.lf_replace(v_old, $o$  perform set_config('app.merchant_id', '', true);
  perform public._platform_log('merchant.created',$o$, $n$  perform set_config('app.merchant_id', '', true);
  -- The chosen plan (or the default), as a trial when the plan has one. Choosing
  -- a plan other than the default is a subscription decision.
  if nullif(p ->> 'plan_code', '') is distinct from null
     and p ->> 'plan_code' is distinct from (select value ->> 'default_plan' from public.platform_settings where key = 'billing') then
    perform public._platform_require('subscriptions', 'manage');
  end if;
  insert into public.subscriptions (merchant_id, plan_id, status, price, currency, billing_interval, trial_ends_at, current_period_start, current_period_end, created_by)
  select v_id, pl.id, case when pl.trial_days > 0 then 'TRIALING' else 'ACTIVE' end, pl.price, pl.currency, pl.billing_interval,
         case when pl.trial_days > 0 then now() + make_interval(days => pl.trial_days) end, now(),
         case when pl.trial_days = 0 and pl.price = 0 then now() + public._billing_interval(pl.billing_interval) end, auth.uid()
  from public.plans pl
  where pl.status = 'ACTIVE'
    and pl.code = coalesce(nullif(p ->> 'plan_code', ''), (select value ->> 'default_plan' from public.platform_settings where key = 'billing'))
    and (pl.trial_days > 0 or pl.price = 0);
  insert into public.subscription_events (merchant_id, subscription_id, event, detail, actor_id)
  select s.merchant_id, s.id, 'subscription.started', jsonb_build_object('plan', pl.code, 'trial', s.status = 'TRIALING', 'reason', 'New merchant'), auth.uid()
  from public.subscriptions s join public.plans pl on pl.id = s.plan_id where s.merchant_id = v_id and s.ended_at is null;
  perform public._platform_log('merchant.created',$n$);
  if v_new = v_old then
    raise exception 'features: platform_merchant_create has changed';
  end if;
  execute v_new;
end $$;

-- -----------------------------------------------------------------------------
-- 11. Grants, exemptions and ownership
-- -----------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array['platform_plans_list()', 'platform_plan_save(jsonb)', 'platform_plan_set_status(uuid,text)', 'platform_addon_save(jsonb)',
    'platform_feature_save(text,jsonb)', 'platform_merchant_feature_set(uuid,text,boolean,text,numeric,timestamp with time zone)',
    'platform_feature_bulk_preview(uuid[],text,boolean)', 'platform_feature_bulk_apply(uuid[],text,boolean,text,text)', 'platform_merchant_billing(uuid)',
    'platform_subscription_action(uuid,text,jsonb)', 'platform_invoices_list(jsonb,integer,integer)', 'platform_payment_record(uuid,jsonb)',
    'platform_payment_verify(uuid,boolean,text)', 'platform_invoice_void(uuid,text)', 'platform_setting_save(text,jsonb,text)', 'platform_settings_get()',
    'platform_config_history(text,text,integer)', 'platform_config_rollback(bigint,text)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['_config_version(text,text,jsonb,text)', '_billing_invoice_for(public.subscriptions,timestamp with time zone,timestamp with time zone)',
    '_billing_apply_payment(public.billing_payments)', '_subscription_event(public.subscriptions,text,jsonb)']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;

insert into public.tenancy_exempt_functions (name, reason)
select f, 'Super Admin and billing: reads plans, subscriptions and settings for any merchant and checks platform permissions itself'
from unnest(array['_config_version', 'merchant_access_mode', 'merchant_entitlements', 'feature_enabled', 'require_feature', 'merchant_usage', 'merchant_limits',
  'require_limit', '_orders_access_guard', '_billing_invoice_for', '_billing_apply_payment', '_subscription_event', 'billing_run',
  'platform_plans_list', 'platform_plan_save', 'platform_plan_set_status', 'platform_addon_save', 'platform_feature_save', 'platform_merchant_feature_set',
  'platform_feature_bulk_preview', 'platform_feature_bulk_apply', 'platform_merchant_billing', 'platform_subscription_action', 'platform_invoices_list',
  'platform_payment_record', 'platform_payment_verify', 'platform_invoice_void', 'platform_setting_save', 'platform_settings_get', 'platform_config_history',
  'platform_config_rollback', 'my_plan']) f
on conflict (name) do nothing;

select public._tenancy_own_functions();
