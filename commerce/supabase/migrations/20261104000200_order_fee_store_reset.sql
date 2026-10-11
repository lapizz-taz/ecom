-- =============================================================================
-- Order fee and store reset.
--
-- Order fee: the platform charges a fee for each order a store approves
-- (1.50 Tk unless the Super Admin sets another price, for all stores or for one).
-- * It is paid from the store's balance: a credit type kept in poisha
--   (100 = 1 Tk), so every top-up and every charge is one immutable ledger
--   entry. The Super Admin tops a store up (Credits → adjust), or the store
--   buys a balance package through the platform's gateway.
-- * An order is charged once, when it is first approved (confirmed). Approving
--   it again, editing it or cancelling it later neither charges nor refunds it;
--   a refund is a credit adjustment with a reason.
-- * With too little balance the approval is refused (policy BLOCK), or let
--   through and recorded as unpaid (policy ALLOW) for the platform to follow up.
-- * Monthly free orders, plans that are never charged and exempt stores are
--   recorded as such, so the bill can always be explained order by order.
-- * The fee is off until the Super Admin switches it on.
--
-- Store reset: the Super Admin can wipe one store's day-to-day data to start
-- again: either orders and customers (products and stock stay, reservations are
-- released), or everything operational (also products, stock and its history,
-- suppliers and purchases, the store's own income & expense records, synced ad
-- data). It needs the merchants "manage" permission, the store's name typed
-- exactly, a reason, and a full export of the store taken in the last 24 hours.
-- It never touches the account, staff, settings, courier and store connections,
-- subscription, invoices, credit balance and ledger, order fees or any audit log.
-- Records that are otherwise immutable may be deleted only by the reset, only
-- for that store, only for an allow-listed set of operational tables, and only
-- inside the transaction that recorded the reset.
-- =============================================================================

-- Patches below compare and rewrite existing function text. Line endings are
-- normalized first, so they also apply when this file is pasted into an editor
-- that sends Windows line endings.
create or replace function pg_temp.lf(p text) returns text
language sql immutable as $$ select replace(p, E'\r', '') $$;
create or replace function pg_temp.lf_replace(p text, p_from text, p_to text) returns text
language sql immutable as $$ select replace(pg_temp.lf(p), pg_temp.lf(p_from), pg_temp.lf(p_to)) $$;

-- -----------------------------------------------------------------------------
-- 1. Store balance (Tk) and the fee settings
-- -----------------------------------------------------------------------------
insert into public.credit_types (code, name, unit, description, used_by, sort_order) values
  ('BALANCE', 'Account balance', 'poisha', 'Taka balance kept in poisha (100 = 1 Tk). The fee for each approved order is paid from it.',
   'Approved orders', 0)
on conflict (code) do nothing;

insert into public.platform_settings (key, value, description) values
  ('order_fee', jsonb_build_object('enabled', false, 'fee', 1.5, 'on_empty', 'BLOCK', 'free_per_month', 0,
     'unmetered_plans', '[]'::jsonb, 'low_balance_tk', 100),
   'Fee for each approved order, paid from the store balance')
on conflict (key) do nothing;
update public.platform_settings set value = value || '{"balance_approval_threshold_tk": 50000}'::jsonb
where key = 'credits' and not (value ? 'balance_approval_threshold_tk');

create table public.merchant_order_fees (
  merchant_id uuid primary key references public.merchants(id),
  -- null keeps the platform price.
  fee numeric(10, 2) check (fee >= 0 and fee <= 1000),
  exempt boolean not null default false,
  reason text not null check (length(trim(reason)) between 5 and 500),
  set_by uuid,
  set_at timestamptz not null default now()
);

-- One row per approved order while the fee is on. No foreign key to orders:
-- the platform's record of what it charged outlives a store reset.
create table public.order_fee_charges (
  id bigint generated always as identity primary key,
  merchant_id uuid not null references public.merchants(id),
  order_id uuid not null unique,
  order_number text,
  fee numeric(10, 2) not null check (fee >= 0),
  charge text not null check (charge in ('CHARGED', 'FREE', 'EXEMPT', 'UNPAID')),
  ledger_entry_id bigint references public.credit_ledger(id),
  approved_by uuid,
  created_at timestamptz not null default now()
);
create index order_fee_charges_merchant_idx on public.order_fee_charges (merchant_id, created_at desc);
create trigger order_fee_charges_immutable before update or delete on public.order_fee_charges
  for each row execute function public.prevent_mutation();

do $$
declare
  t text;
begin
  foreach t in array array['merchant_order_fees', 'order_fee_charges'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format($p$create policy tenant_isolation on public.%I as restrictive for all to public
      using (merchant_id = (select public.current_merchant_id())) with check (merchant_id = (select public.current_merchant_id()))$p$, t);
    execute format('create policy app_owner_read on public.%I for select to app_owner using (true)', t);
    execute format($p$create policy staff_read on public.%I for select to authenticated using ((select public.is_staff()))$p$, t);
    execute format('revoke insert, update, delete, truncate on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- Price and rules for one store, today.
create or replace function public._order_fee_terms(p_merchant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_cfg jsonb := coalesce((select value from public.platform_settings where key = 'order_fee'), '{}'::jsonb);
  o public.merchant_order_fees;
  v_plan text;
  v_tz text := coalesce((select timezone from public.merchants where id = p_merchant), 'Asia/Dhaka');
  v_month timestamptz := date_trunc('month', now() at time zone v_tz) at time zone v_tz;
  v_fee numeric;
begin
  select * into o from public.merchant_order_fees where merchant_id = p_merchant;
  select p.code into v_plan from public.subscriptions s join public.plans p on p.id = s.plan_id
  where s.merchant_id = p_merchant and s.ended_at is null;
  v_fee := coalesce(o.fee, nullif(v_cfg ->> 'fee', '')::numeric, 1.5);
  return jsonb_build_object(
    'enabled', coalesce((v_cfg ->> 'enabled')::boolean, false),
    'fee', v_fee,
    'platform_fee', coalesce(nullif(v_cfg ->> 'fee', '')::numeric, 1.5),
    'store_fee', o.fee,
    'exempt', coalesce(o.exempt, false),
    'override_reason', o.reason,
    'plan', v_plan,
    'unmetered', coalesce(v_cfg -> 'unmetered_plans', '[]'::jsonb) ? coalesce(v_plan, ''),
    'on_empty', coalesce(nullif(v_cfg ->> 'on_empty', ''), 'BLOCK'),
    'free_per_month', coalesce(nullif(v_cfg ->> 'free_per_month', '')::int, 0),
    'free_used', (select count(*) from public.order_fee_charges where merchant_id = p_merchant and charge = 'FREE' and created_at >= v_month),
    'low_balance_tk', coalesce(nullif(v_cfg ->> 'low_balance_tk', '')::numeric, 100),
    'month_start', v_month);
end;
$$;

-- What the store sees: price, balance, this month.
create or replace function public._order_fee_state(p_merchant uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t || jsonb_build_object(
    'balance_tk', round(public.credit_available(p_merchant, 'BALANCE') / 100.0, 2),
    'orders_left', case when (t ->> 'fee')::numeric > 0
      then floor(public.credit_available(p_merchant, 'BALANCE') / ((t ->> 'fee')::numeric * 100)) end,
    'low_balance', (t ->> 'enabled')::boolean and not (t ->> 'exempt')::boolean and not (t ->> 'unmetered')::boolean
      and public.credit_available(p_merchant, 'BALANCE') / 100.0 < (t ->> 'low_balance_tk')::numeric,
    'month', (select jsonb_build_object(
        'approved', count(*),
        'charged', count(*) filter (where c.charge = 'CHARGED'),
        'free', count(*) filter (where c.charge = 'FREE'),
        'unpaid', count(*) filter (where c.charge = 'UNPAID'),
        'amount_tk', coalesce(sum(c.fee) filter (where c.charge = 'CHARGED'), 0))
      from public.order_fee_charges c where c.merchant_id = p_merchant and c.created_at >= (t ->> 'month_start')::timestamptz))
  from (select public._order_fee_terms(p_merchant) as t) x
$$;

-- -----------------------------------------------------------------------------
-- 2. Charging an approved order
-- -----------------------------------------------------------------------------
create or replace function public._order_fee_charge(p_order uuid, p_merchant uuid, p_number text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_t jsonb := public._order_fee_terms(p_merchant);
  v_fee numeric := (v_t ->> 'fee')::numeric;
  v_poisha int := round((v_t ->> 'fee')::numeric * 100)::int;
  v_balance int;
  e public.credit_ledger;
begin
  if not (v_t ->> 'enabled')::boolean then
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('order-fee:' || p_merchant, 0));
  if exists (select 1 from public.order_fee_charges where order_id = p_order) then
    return;
  end if;
  if (v_t ->> 'exempt')::boolean or (v_t ->> 'unmetered')::boolean then
    insert into public.order_fee_charges (merchant_id, order_id, order_number, fee, charge, approved_by)
    values (p_merchant, p_order, p_number, 0, 'EXEMPT', auth.uid());
    return;
  end if;
  if v_poisha <= 0 or (v_t ->> 'free_used')::int < (v_t ->> 'free_per_month')::int then
    insert into public.order_fee_charges (merchant_id, order_id, order_number, fee, charge, approved_by)
    values (p_merchant, p_order, p_number, 0, 'FREE', auth.uid());
    return;
  end if;
  v_balance := public.credit_available(p_merchant, 'BALANCE');
  if v_balance >= v_poisha then
    e := public._credit_post(p_merchant, 'BALANCE', -v_poisha, 'USAGE', format('Order %s approved', p_number), auth.uid(), 'SYSTEM',
      'order', p_order::text, 'order-fee:' || p_order, null, jsonb_build_object('fee_tk', v_fee));
    insert into public.order_fee_charges (merchant_id, order_id, order_number, fee, charge, ledger_entry_id, approved_by)
    values (p_merchant, p_order, p_number, v_fee, 'CHARGED', e.id, auth.uid());
  elsif v_t ->> 'on_empty' = 'ALLOW' then
    insert into public.order_fee_charges (merchant_id, order_id, order_number, fee, charge, approved_by)
    values (p_merchant, p_order, p_number, v_fee, 'UNPAID', auth.uid());
  else
    raise exception 'LIMIT_REACHED: approving an order costs % Tk and the balance is % Tk. Recharge the balance to keep approving orders',
      to_char(v_fee, 'FM999990.00'), to_char(v_balance / 100.0, 'FM9999999990.00') using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public._order_fee_on_approve()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._order_fee_charge(new.id, new.merchant_id, new.order_number);
  return new;
end;
$$;

create trigger orders_order_fee_insert after insert on public.orders
  for each row when (new.confirmed_at is not null) execute function public._order_fee_on_approve();
create trigger orders_order_fee_approve after update of confirmed_at on public.orders
  for each row when (old.confirmed_at is null and new.confirmed_at is not null) execute function public._order_fee_on_approve();

-- -----------------------------------------------------------------------------
-- 3. Super Admin: price, per-store price or exemption, overview
-- -----------------------------------------------------------------------------
create or replace function public.platform_order_fee_settings_save(p jsonb, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb := coalesce((select value from public.platform_settings where key = 'order_fee'), '{}'::jsonb);
  v_after jsonb;
  v_fee numeric;
begin
  perform public._platform_require('credits', 'manage');
  if coalesce(length(trim(p_reason)), 0) < 5 then
    raise exception 'VALIDATION: give a reason (at least 5 characters)' using errcode = '22023';
  end if;
  begin
    v_fee := (p ->> 'fee')::numeric;
  exception when others then
    raise exception 'VALIDATION: enter the fee in Tk, for example 1.50' using errcode = '22023';
  end;
  if v_fee is null or v_fee < 0 or v_fee > 1000 or v_fee <> round(v_fee, 2) then
    raise exception 'VALIDATION: the fee must be between 0 and 1000 Tk, with at most 2 decimals' using errcode = '22023';
  end if;
  if coalesce(p ->> 'on_empty', 'BLOCK') not in ('BLOCK', 'ALLOW') then
    raise exception 'VALIDATION: with an empty balance, either refuse approvals (BLOCK) or let them through as unpaid (ALLOW)' using errcode = '22023';
  end if;
  if coalesce(nullif(p ->> 'free_per_month', '')::int, 0) not between 0 and 100000
     or coalesce(nullif(p ->> 'low_balance_tk', '')::numeric, 0) not between 0 and 1000000 then
    raise exception 'VALIDATION: free orders and the low-balance warning must be zero or more' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p -> 'unmetered_plans', '[]'::jsonb)) <> 'array' then
    raise exception 'VALIDATION: plans that are never charged must be a list of plan codes' using errcode = '22023';
  end if;
  v_after := jsonb_build_object(
    'enabled', coalesce((p ->> 'enabled')::boolean, false),
    'fee', v_fee,
    'on_empty', coalesce(p ->> 'on_empty', 'BLOCK'),
    'free_per_month', coalesce(nullif(p ->> 'free_per_month', '')::int, 0),
    'unmetered_plans', coalesce((select jsonb_agg(distinct upper(x)) from jsonb_array_elements_text(p -> 'unmetered_plans') x
                                 where exists (select 1 from public.plans where code = upper(x))), '[]'::jsonb),
    'low_balance_tk', coalesce(nullif(p ->> 'low_balance_tk', '')::numeric, 100));
  insert into public.platform_settings (key, value, description, updated_at)
  values ('order_fee', v_after, 'Fee for each approved order, paid from the store balance', now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
  perform public._config_version('platform_setting', 'order_fee', v_after, trim(p_reason));
  perform public._platform_log('settings.order_fee', null, 'platform_setting', 'order_fee', trim(p_reason), v_before, v_after);
  return v_after;
end;
$$;

create or replace function public.platform_order_fee_override_set(p_merchant uuid, p_fee numeric, p_exempt boolean, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb := (select to_jsonb(o) from public.merchant_order_fees o where merchant_id = p_merchant);
begin
  perform public._platform_require('credits', 'manage', p_merchant);
  if not exists (select 1 from public.merchants where id = p_merchant) then
    raise exception 'NOT_FOUND: merchant not found' using errcode = 'P0002';
  end if;
  if coalesce(length(trim(p_reason)), 0) < 5 then
    raise exception 'VALIDATION: give a reason (at least 5 characters)' using errcode = '22023';
  end if;
  if p_fee is not null and (p_fee < 0 or p_fee > 1000 or p_fee <> round(p_fee, 2)) then
    raise exception 'VALIDATION: the fee must be between 0 and 1000 Tk, with at most 2 decimals' using errcode = '22023';
  end if;
  if p_fee is null and not coalesce(p_exempt, false) then
    delete from public.merchant_order_fees where merchant_id = p_merchant;
  else
    insert into public.merchant_order_fees (merchant_id, fee, exempt, reason, set_by)
    values (p_merchant, p_fee, coalesce(p_exempt, false), trim(p_reason), auth.uid())
    on conflict (merchant_id) do update set fee = excluded.fee, exempt = excluded.exempt, reason = excluded.reason,
      set_by = excluded.set_by, set_at = now();
  end if;
  perform public._platform_log('credits.order_fee_override', p_merchant, 'merchant', p_merchant::text, trim(p_reason), v_before,
    (select to_jsonb(o) from public.merchant_order_fees o where merchant_id = p_merchant));
  return public._order_fee_state(p_merchant);
end;
$$;

create or replace function public.platform_order_fee_overview(p_q text default null, p_limit int default 200)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._platform_require('credits', 'view');
  return jsonb_build_object(
    'settings', coalesce((select value from public.platform_settings where key = 'order_fee'), '{}'::jsonb),
    'plans', coalesce((select jsonb_agg(jsonb_build_object('code', code, 'name', name) order by sort_order, code) from public.plans), '[]'::jsonb),
    'totals', (select jsonb_build_object(
        'month_charged_tk', coalesce(sum(fee) filter (where charge = 'CHARGED' and created_at >= date_trunc('month', now())), 0),
        'month_orders', count(*) filter (where created_at >= date_trunc('month', now())),
        'unpaid_orders', count(*) filter (where charge = 'UNPAID'),
        'unpaid_tk', coalesce(sum(fee) filter (where charge = 'UNPAID'), 0))
      from public.order_fee_charges),
    'stores', coalesce((select jsonb_agg(x order by x ->> 'name') from (
      select jsonb_build_object('merchant_id', m.id, 'number', m.number, 'name', m.name, 'status', m.status)
        || public._order_fee_state(m.id) as x
      from public.merchants m
      where public.platform_can('credits', 'view', m.id)
        and (coalesce(trim(p_q), '') = '' or m.name ilike '%' || trim(p_q) || '%' or m.number::text = trim(p_q))
      order by m.name limit greatest(least(coalesce(p_limit, 200), 500), 1)) s), '[]'::jsonb));
end;
$$;

create or replace function public.platform_order_fee_charges(p_merchant uuid, p_limit int default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._platform_require('credits', 'view', p_merchant);
  return coalesce((select jsonb_agg(to_jsonb(c) order by c.id desc) from (
    select id, order_id, order_number, fee, charge, created_at from public.order_fee_charges
    where merchant_id = p_merchant order by id desc limit greatest(least(coalesce(p_limit, 100), 500), 1)) c), '[]'::jsonb);
end;
$$;

-- The store's own view (merchant staff).
create or replace function public.my_order_fee()
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
  return public._order_fee_state(v_merchant) || jsonb_build_object(
    'recent', coalesce((select jsonb_agg(to_jsonb(c) order by c.id desc) from (
      select id, order_number, fee, charge, created_at from public.order_fee_charges where merchant_id = v_merchant order by id desc limit 30) c), '[]'::jsonb));
end;
$$;

-- Balance top-ups are in poisha: allow larger amounts, and set the two-person
-- threshold for them in Tk.
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.platform_credit_adjust(uuid,text,integer,text,text,timestamp with time zone,uuid)'::regprocedure));
  v_new text;
begin
  v_new := pg_temp.lf_replace(v_old, $o$  if p_amount is null or p_amount = 0 or abs(p_amount) > 1000000 then$o$,
    $n$  if p_amount is null or p_amount = 0 or abs(p_amount) > (case when p_type = 'BALANCE' then 100000000 else 1000000 end) then$n$);
  v_new := pg_temp.lf_replace(v_new, $o$  if abs(p_amount) > v_threshold then$o$,
    $n$  if abs(p_amount) > (case when p_type = 'BALANCE'
       then coalesce((select (value ->> 'balance_approval_threshold_tk')::numeric from public.platform_settings where key = 'credits'), 50000) * 100
       else v_threshold end) then$n$);
  if (length(v_new) - length(replace(v_new, 'BALANCE', ''))) / length('BALANCE') <> 2 then
    raise exception 'order fee: platform_credit_adjust has changed';
  end if;
  execute v_new;
end $$;

-- The store's credits page shows the order fee too.
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.my_credits()'::regprocedure));
  v_new text;
begin
  v_new := pg_temp.lf_replace(v_old, $o$    'can_pay', public.billing_can_pay(),$o$,
    $n$    'order_fee', public._order_fee_state(v_merchant),
    'can_pay', public.billing_can_pay(),$n$);
  if v_new = v_old then
    raise exception 'order fee: my_credits has changed';
  end if;
  execute v_new;
end $$;

-- -----------------------------------------------------------------------------
-- 4. Store reset
-- -----------------------------------------------------------------------------
create table public.store_resets (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id),
  scope text not null check (scope in ('ORDERS', 'EVERYTHING')),
  reason text not null check (length(trim(reason)) between 10 and 2000),
  export_id bigint,
  requested_by uuid,
  requested_by_email text,
  status text not null default 'RUNNING' check (status in ('RUNNING', 'DONE')),
  txid bigint not null,
  counts jsonb,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index store_resets_merchant_idx on public.store_resets (merchant_id, created_at desc);
alter table public.store_resets enable row level security;
create policy tenant_isolation on public.store_resets as restrictive for all to public
  using (merchant_id = (select public.current_merchant_id())) with check (merchant_id = (select public.current_merchant_id()));
revoke all on public.store_resets from anon, authenticated;

-- Operational tables whose rows are otherwise immutable but go with a reset.
create or replace function public._store_reset_tables()
returns text[]
language sql
immutable
as $$
  select array['inventory_movements', 'order_status_history', 'order_payments', 'order_merges', 'shipment_events',
               'shipment_charges', 'parcel_scans', 'fraud_reviews', 'fraud_checks', 'production_status_history',
               'finance_transactions', 'finance_account_movements']
$$;

-- Is a reset of this merchant running in this very transaction?
create or replace function public._store_reset_active(p_merchant text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(current_setting('app.store_reset', true), '') = '' or p_merchant is null then
    return false;
  end if;
  return exists (select 1 from public.store_resets r
                 where r.id::text = current_setting('app.store_reset', true) and r.merchant_id::text = p_merchant
                   and r.status = 'RUNNING' and r.txid = txid_current());
end;
$$;

do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.prevent_mutation()'::regprocedure));
  v_new text;
begin
  v_new := pg_temp.lf_replace(v_old, $o$  raise exception 'IMMUTABLE_RECORD: % rows cannot be %d; record a correcting entry instead',$o$,
    $n$  if tg_op = 'DELETE' and tg_table_name = any (public._store_reset_tables())
     and public._store_reset_active(to_jsonb(old) ->> 'merchant_id') then
    return old;
  end if;
  raise exception 'IMMUTABLE_RECORD: % rows cannot be %d; record a correcting entry instead',$n$);
  if v_new = v_old then
    raise exception 'store reset: prevent_mutation has changed';
  end if;
  execute v_new;
end $$;

do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.fraud_checks_guard()'::regprocedure));
  v_new text;
begin
  v_new := pg_temp.lf_replace(v_old, $o$  if tg_op = 'DELETE' then
    raise exception 'IMMUTABLE_RECORD: fraud checks cannot be deleted' using errcode = 'P0001';$o$,
    $n$  if tg_op = 'DELETE' and public._store_reset_active(old.merchant_id::text) then
    return old;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'IMMUTABLE_RECORD: fraud checks cannot be deleted' using errcode = 'P0001';$n$);
  if v_new = v_old then
    raise exception 'store reset: fraud_checks_guard has changed';
  end if;
  execute v_new;
end $$;

-- A reset records itself once; row-by-row change logs would only bury that entry.
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.audit_row_change()'::regprocedure));
  v_new text;
begin
  v_new := pg_temp.lf_replace(v_old, $o$begin
  if tg_op = 'INSERT' then
    v_new := to_jsonb(new);$o$, $n$begin
  if tg_op = 'DELETE' and public._store_reset_active(to_jsonb(old) ->> 'merchant_id') then
    return old;
  end if;
  if tg_op = 'INSERT' then
    v_new := to_jsonb(new);$n$);
  if v_new = v_old then
    raise exception 'store reset: audit_row_change has changed';
  end if;
  execute v_new;
end $$;

create or replace function public.platform_store_reset(p_merchant uuid, p_scope text, p_confirm_name text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  m public.merchants;
  r public.store_resets;
  v_export bigint;
  v jsonb := '{}'::jsonb;
  n int;
  inv record;
begin
  perform public._platform_require('merchants', 'manage', p_merchant);
  select * into m from public.merchants where id = p_merchant;
  if not found then
    raise exception 'NOT_FOUND: merchant not found' using errcode = 'P0002';
  end if;
  if coalesce(p_scope, '') not in ('ORDERS', 'EVERYTHING') then
    raise exception 'VALIDATION: choose what to reset: orders and customers, or everything' using errcode = '22023';
  end if;
  if coalesce(length(trim(p_reason)), 0) < 10 then
    raise exception 'VALIDATION: explain why (at least 10 characters)' using errcode = '22023';
  end if;
  if lower(trim(coalesce(p_confirm_name, ''))) <> lower(trim(m.name)) then
    raise exception 'VALIDATION: type the store name exactly as shown to confirm' using errcode = '22023';
  end if;
  select id into v_export from public.platform_data_exports
  where merchant_id = p_merchant and kind = 'MERCHANT_DATA' and created_at > now() - interval '24 hours'
  order by created_at desc limit 1;
  if v_export is null then
    raise exception 'VALIDATION: download a full export of this store first (Data Management → Export), then reset within 24 hours'
      using errcode = '22023';
  end if;
  if exists (select 1 from public.merchant_deletion_requests where merchant_id = p_merchant and status = 'APPROVED') then
    raise exception 'VALIDATION: this store has an approved data deletion request; finish or cancel it first' using errcode = '22023';
  end if;

  insert into public.store_resets (merchant_id, scope, reason, export_id, requested_by, requested_by_email, txid)
  values (p_merchant, p_scope, trim(p_reason), v_export, auth.uid(), (select email from public.platform_staff where user_id = auth.uid()), txid_current())
  returning * into r;
  perform set_config('app.store_reset', r.id::text, true);
  perform public._platform_in_merchant(p_merchant);
  set local lock_timeout = '20s';

  -- Links from records that stay (calls are billed) to records that go.
  update public.pbx_calls set order_id = null, customer_id = null where merchant_id = p_merchant and (order_id is not null or customer_id is not null);

  -- Store sync records about orders.
  delete from public.channel_status_pushes where merchant_id = p_merchant;
  delete from public.channel_order_sync where merchant_id = p_merchant;
  delete from public.channel_fulfillments where merchant_id = p_merchant;
  delete from public.channel_order_imports where merchant_id = p_merchant;
  get diagnostics n = row_count; v := v || jsonb_build_object('store_imports', n);
  delete from public.channel_sync_jobs where merchant_id = p_merchant;
  delete from public.channel_webhook_deliveries where merchant_id = p_merchant;
  delete from public.channel_plugin_events where merchant_id = p_merchant;

  -- Parcels and courier records.
  delete from public.parcel_scans where merchant_id = p_merchant;
  delete from public.parcel_calls where merchant_id = p_merchant;
  delete from public.courier_webhook_events where merchant_id = p_merchant;
  delete from public.shipment_charges where merchant_id = p_merchant;
  delete from public.courier_invoice_lines where merchant_id = p_merchant;
  delete from public.courier_invoices where merchant_id = p_merchant;
  get diagnostics n = row_count; v := v || jsonb_build_object('courier_invoices', n);

  -- Income & expense records tied to orders or customers (and their corrections).
  with recursive s as (
    select id from public.finance_transactions where merchant_id = p_merchant and (order_id is not null or customer_id is not null)
    union
    select f.id from public.finance_transactions f join s on f.reverses_id = s.id
  )
  delete from public.finance_account_movements where merchant_id = p_merchant and finance_transaction_id in (select id from s);
  with recursive s as (
    select id from public.finance_transactions where merchant_id = p_merchant and (order_id is not null or customer_id is not null)
    union
    select f.id from public.finance_transactions f join s on f.reverses_id = s.id
  )
  delete from public.finance_transactions where id in (select id from s);
  get diagnostics n = row_count; v := v || jsonb_build_object('order_finance_records', n);

  -- Fraud, payments, leads, messages. Orders and fraud checks point at each other.
  update public.orders set fraud_check_id = null where merchant_id = p_merchant and fraud_check_id is not null;
  delete from public.fraud_reviews where merchant_id = p_merchant;
  delete from public.fraud_checks where merchant_id = p_merchant;
  delete from public.order_merges where merchant_id = p_merchant;
  delete from public.order_payments where merchant_id = p_merchant;
  delete from public.payment_events where merchant_id = p_merchant;
  delete from public.payments where merchant_id = p_merchant;
  delete from public.coupon_usage where merchant_id = p_merchant;
  delete from public.order_blocks where merchant_id = p_merchant;
  delete from public.store_carts where merchant_id = p_merchant;
  delete from public.checkout_leads where merchant_id = p_merchant;
  get diagnostics n = row_count; v := v || jsonb_build_object('incomplete_orders', n);
  delete from public.shopify_abandoned_checkouts where merchant_id = p_merchant;
  delete from public.notification_logs where merchant_id = p_merchant;
  delete from public.contact_messages where merchant_id = p_merchant;
  delete from public.storefront_events where merchant_id = p_merchant;

  -- Orders (with their items, history, notes, reservations, shipments, production) and customers.
  delete from public.orders where merchant_id = p_merchant;
  get diagnostics n = row_count; v := v || jsonb_build_object('orders', n);
  delete from public.customers where merchant_id = p_merchant;
  get diagnostics n = row_count; v := v || jsonb_build_object('customers', n);
  update public.sales_channels set orders_imported = 0, last_order_at = null where merchant_id = p_merchant;

  if p_scope = 'ORDERS' then
    -- Products stay; what was held for orders is free again.
    for inv in select variant_id, reserved from public.inventory where merchant_id = p_merchant and reserved <> 0 loop
      perform public._apply_inventory_movement(inv.variant_id, 'RELEASE', 0, -inv.reserved, 0, 'ADJUSTMENT', r.id,
        'Store reset', 'Reservations cleared: the store''s orders were reset', null, true);
    end loop;
  else
    delete from public.marketing_spend where merchant_id = p_merchant;
    delete from public.meta_ad_insights where merchant_id = p_merchant;
    delete from public.meta_ads where merchant_id = p_merchant;
    delete from public.meta_adsets where merchant_id = p_merchant;
    delete from public.meta_campaigns where merchant_id = p_merchant;
    delete from public.ad_platform_stats where merchant_id = p_merchant;
    delete from public.marketing_campaigns where merchant_id = p_merchant;
    delete from public.finance_account_movements where merchant_id = p_merchant;
    delete from public.finance_transactions where merchant_id = p_merchant;
    get diagnostics n = row_count; v := v || jsonb_build_object('finance_records', n);
    delete from public.purchase_orders where merchant_id = p_merchant;
    get diagnostics n = row_count; v := v || jsonb_build_object('purchase_orders', n);
    delete from public.suppliers where merchant_id = p_merchant;
    delete from public.sales_channel_variants where merchant_id = p_merchant;
    delete from public.channel_catalog_items where merchant_id = p_merchant;
    update public.sales_channels set first_sync_at = null, catalog_imported_at = null,
      settings = settings || '{"inventory_sync": false}'::jsonb
    where merchant_id = p_merchant;
    delete from public.inventory_movements where merchant_id = p_merchant;
    delete from public.stock_reservations where merchant_id = p_merchant;
    delete from public.products where merchant_id = p_merchant;
    get diagnostics n = row_count; v := v || jsonb_build_object('products', n);
    delete from public.categories where merchant_id = p_merchant;
    delete from public.coupons where merchant_id = p_merchant;
  end if;

  update public.store_resets set status = 'DONE', counts = v, finished_at = now() where id = r.id;
  perform set_config('app.store_reset', '', true);
  perform public.log_audit('store.reset', 'merchant', p_merchant::text, null,
    jsonb_build_object('scope', p_scope, 'counts', v), jsonb_build_object('reason', trim(p_reason), 'reset_id', r.id));
  perform public._platform_log('merchants.reset', p_merchant, 'merchant', p_merchant::text, trim(p_reason), null,
    jsonb_build_object('scope', p_scope, 'counts', v, 'export_id', v_export, 'reset_id', r.id));
  return jsonb_build_object('reset_id', r.id, 'scope', p_scope, 'counts', v);
end;
$$;

create or replace function public.platform_store_resets(p_merchant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._platform_require('merchants', 'view', p_merchant);
  return jsonb_build_object(
    'resets', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'scope', r.scope, 'reason', r.reason, 'status', r.status,
        'requested_by_email', r.requested_by_email, 'counts', r.counts, 'created_at', r.created_at, 'finished_at', r.finished_at)
      order by r.created_at desc) from public.store_resets r where r.merchant_id = p_merchant), '[]'::jsonb),
    'last_export_at', (select max(created_at) from public.platform_data_exports
                       where merchant_id = p_merchant and kind = 'MERCHANT_DATA'),
    'export_valid_until', (select max(created_at) + interval '24 hours' from public.platform_data_exports
                           where merchant_id = p_merchant and kind = 'MERCHANT_DATA' and created_at > now() - interval '24 hours'));
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Grants, exemptions and ownership
-- -----------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array['platform_order_fee_settings_save(jsonb,text)', 'platform_order_fee_override_set(uuid,numeric,boolean,text)',
    'platform_order_fee_overview(text,integer)', 'platform_order_fee_charges(uuid,integer)', 'my_order_fee()',
    'platform_store_reset(uuid,text,text,text)', 'platform_store_resets(uuid)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  -- _store_reset_active stays callable: the immutability and audit triggers ask it on every change.
  foreach f in array array['_order_fee_terms(uuid)', '_order_fee_state(uuid)', '_order_fee_charge(uuid,uuid,text)', '_order_fee_on_approve()']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;

insert into public.tenancy_exempt_functions (name, reason)
select f, 'Order fee and store reset: work on one named merchant at a time, or on platform settings; permission-checked'
from unnest(array['_order_fee_terms', '_order_fee_state', '_order_fee_charge', '_order_fee_on_approve', 'platform_order_fee_settings_save',
  'platform_order_fee_override_set', 'platform_order_fee_overview', 'platform_order_fee_charges', 'my_order_fee',
  '_store_reset_active', 'platform_store_reset', 'platform_store_resets']) f
on conflict (name) do nothing;

select public._tenancy_own_functions();
