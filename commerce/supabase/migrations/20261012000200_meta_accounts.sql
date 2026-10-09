-- =============================================================================
-- Meta Ads: several ad accounts, payment accounts
--   * meta_ad_accounts: any number of Meta ad accounts, each with a name, the
--     app id, its own USD → store-currency rate and an optional payment
--     account. The access token and app secret of each live in Vault
--     (integration key "meta.ads.<id without dashes>"), never in a table
--   * finance_accounts: where money sits (cash, bank, bKash, card…). Each
--     movement is an immutable row; the balance is the opening balance plus
--     the movements
--   * a Meta account's spend for a day is withdrawn from its payment account
--     the day after; when Meta later revises that day a correction follows
--   * synced spend rows carry their ad account, so the right rate is used and
--     syncing one account never touches another
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Payment accounts
-- -----------------------------------------------------------------------------
create table if not exists public.finance_accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 2 and 80),
  kind text not null default 'BANK' check (kind in ('CASH', 'BANK', 'MOBILE_WALLET', 'CARD', 'OTHER')),
  opening_balance numeric(14,2) not null default 0,
  is_active boolean not null default true,
  notes text check (notes is null or length(notes) <= 500),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists finance_accounts_name_uq on public.finance_accounts(lower(name));
create trigger finance_accounts_updated_at before update on public.finance_accounts
  for each row execute function public.set_updated_at();

create table if not exists public.finance_account_movements (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.finance_accounts(id),
  amount numeric(14,2) not null check (amount <> 0),
  movement_date date not null,
  description text not null check (length(description) between 2 and 300),
  source text not null default 'MANUAL' check (source in ('MANUAL', 'META_ADS')),
  source_key text unique,
  meta_account_id uuid,
  spend_date date,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
create index if not exists finance_account_movements_account_idx on public.finance_account_movements(account_id, movement_date desc, created_at desc);
create index if not exists finance_account_movements_meta_idx on public.finance_account_movements(meta_account_id, spend_date) where meta_account_id is not null;
create trigger finance_account_movements_immutable before update or delete on public.finance_account_movements
  for each row execute function public.prevent_mutation();

alter table public.finance_accounts enable row level security;
alter table public.finance_account_movements enable row level security;
revoke all on public.finance_accounts, public.finance_account_movements from anon, authenticated;
grant select on public.finance_accounts, public.finance_account_movements to authenticated;
grant all on public.finance_accounts, public.finance_account_movements to service_role;
create policy finance_accounts_read on public.finance_accounts for select to authenticated
  using ((select public.has_permission('finance.view')));
create policy finance_account_movements_read on public.finance_account_movements for select to authenticated
  using ((select public.has_permission('finance.view')));

-- Accounts with their balance. Marketing staff see names only (to pick one).
create or replace function public.finance_accounts_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_full boolean := public.has_permission('finance.view');
begin
  if not v_full and not public.has_permission('marketing.manage') then
    perform public.require_permission('finance.view');
  end if;
  return coalesce((select jsonb_agg(r order by r.is_active desc, r.name) from (
    select a.id, a.name, a.kind, a.is_active, a.notes,
           case when v_full then a.opening_balance end as opening_balance,
           case when v_full then a.opening_balance + coalesce(m.total, 0) end as balance,
           case when v_full then coalesce(m.count, 0) end as movements,
           case when v_full then m.last_at end as last_movement_at,
           (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name)), '[]'::jsonb)
              from public.meta_ad_accounts x where x.payment_account_id = a.id) as meta_accounts
    from public.finance_accounts a
    left join lateral (select sum(amount) as total, count(*) as count, max(created_at) as last_at
                       from public.finance_account_movements where account_id = a.id) m on true) r), '[]'::jsonb);
end;
$$;

create or replace function public.finance_account_save(p jsonb)
returns public.finance_accounts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_old public.finance_accounts;
  v_row public.finance_accounts;
begin
  perform public.require_permission('finance.manage');
  if length(trim(coalesce(p ->> 'name', ''))) < 2 then
    raise exception 'VALIDATION: give the account a name' using errcode = '22023';
  end if;
  if exists (select 1 from public.finance_accounts where lower(name) = lower(trim(p ->> 'name')) and id is distinct from v_id) then
    raise exception 'DUPLICATE: there is already an account called %', trim(p ->> 'name') using errcode = '23505';
  end if;
  if v_id is null then
    insert into public.finance_accounts(name, kind, opening_balance, is_active, notes, created_by)
    values (trim(p ->> 'name'), coalesce(nullif(p ->> 'kind', ''), 'BANK'), coalesce((p ->> 'opening_balance')::numeric, 0),
            coalesce((p ->> 'is_active')::boolean, true), nullif(trim(coalesce(p ->> 'notes', '')), ''), auth.uid())
    returning * into v_row;
  else
    select * into v_old from public.finance_accounts where id = v_id;
    if not found then
      raise exception 'NOT_FOUND: account not found' using errcode = 'P0002';
    end if;
    update public.finance_accounts set name = trim(p ->> 'name'), kind = coalesce(nullif(p ->> 'kind', ''), kind),
      opening_balance = coalesce((p ->> 'opening_balance')::numeric, opening_balance),
      is_active = coalesce((p ->> 'is_active')::boolean, is_active),
      notes = case when p ? 'notes' then nullif(trim(coalesce(p ->> 'notes', '')), '') else notes end
    where id = v_id returning * into v_row;
  end if;
  perform public.log_audit(case when v_id is null then 'finance_account.created' else 'finance_account.updated' end,
    'finance_account', v_row.id::text, to_jsonb(v_old), to_jsonb(v_row), '{}'::jsonb);
  return v_row;
end;
$$;

-- Money in (positive) or out (negative) by hand: a top-up, a transfer, a fee.
create or replace function public.finance_account_move(p_account_id uuid, p_amount numeric, p_date date, p_description text)
returns public.finance_account_movements
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.finance_account_movements;
begin
  perform public.require_permission('finance.manage');
  if not exists (select 1 from public.finance_accounts where id = p_account_id) then
    raise exception 'NOT_FOUND: account not found' using errcode = 'P0002';
  end if;
  if coalesce(p_amount, 0) = 0 then
    raise exception 'VALIDATION: enter an amount' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_description, ''))) < 2 then
    raise exception 'VALIDATION: say what the money was for' using errcode = '22023';
  end if;
  insert into public.finance_account_movements(account_id, amount, movement_date, description, source, created_by)
  values (p_account_id, round(p_amount, 2), coalesce(p_date, public._local_date(now())), trim(p_description), 'MANUAL', auth.uid())
  returning * into v_row;
  perform public.log_audit('finance_account.movement', 'finance_account', p_account_id::text, null, to_jsonb(v_row), '{}'::jsonb);
  return v_row;
end;
$$;

create or replace function public.finance_account_movements_list(p_account_id uuid, p_limit int default 50, p_offset int default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('finance.view');
  return jsonb_build_object(
    'total', (select count(*) from public.finance_account_movements where account_id = p_account_id),
    'items', coalesce((select jsonb_agg(r order by r.movement_date desc, r.created_at desc) from (
      select m.id, m.amount, m.movement_date, m.description, m.source, m.spend_date, m.created_at,
             (select coalesce(nullif(full_name, ''), email) from public.profiles where id = m.created_by) as created_by_name,
             (select name from public.meta_ad_accounts where id = m.meta_account_id) as meta_account_name
      from public.finance_account_movements m where m.account_id = p_account_id
      order by m.movement_date desc, m.created_at desc
      limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0)) r), '[]'::jsonb));
end;
$$;

-- -----------------------------------------------------------------------------
-- Meta ad accounts
-- -----------------------------------------------------------------------------
create table if not exists public.meta_ad_accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 2 and 80),
  app_id text check (app_id is null or app_id ~ '^[0-9]{5,32}$'),
  ad_account_id text not null unique check (ad_account_id ~ '^[0-9]{3,32}$'),
  usd_rate numeric(12,4) not null default 110 check (usd_rate > 0 and usd_rate <= 100000),
  payment_account_id uuid references public.finance_accounts(id),
  payments_from date,
  is_active boolean not null default true,
  meta_name text,
  currency text,
  timezone text,
  token_hint text,
  has_app_secret boolean not null default false,
  token_expires_at timestamptz,
  connection_status text not null default 'UNTESTED' check (connection_status in ('UNTESTED', 'OK', 'FAILED', 'DISCONNECTED')),
  connection_error text,
  tested_at timestamptz,
  last_sync_at timestamptz,
  last_sync_status text,
  last_sync_error text,
  last_sync_since date,
  last_sync_until date,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists meta_ad_accounts_name_uq on public.meta_ad_accounts(lower(name));
create trigger meta_ad_accounts_updated_at before update on public.meta_ad_accounts
  for each row execute function public.set_updated_at();
alter table public.meta_ad_accounts enable row level security;
revoke all on public.meta_ad_accounts from anon, authenticated;
grant select on public.meta_ad_accounts to authenticated;
grant all on public.meta_ad_accounts to service_role;
create policy meta_ad_accounts_read on public.meta_ad_accounts for select to authenticated
  using ((select public.has_permission('marketing.view')));

alter table public.finance_account_movements
  add constraint finance_account_movements_meta_fk foreign key (meta_account_id) references public.meta_ad_accounts(id);

-- Which ad account each synced row belongs to (digits, no "act_").
alter table public.meta_ad_insights add column if not exists account_id text;
create index if not exists meta_ad_insights_account_idx on public.meta_ad_insights(account_id, date);
update public.meta_campaigns set account_id = regexp_replace(account_id, '^act_', '') where account_id like 'act\_%';
update public.meta_ad_insights i set account_id = c.account_id
from public.meta_campaigns c where c.id = i.campaign_id and i.account_id is null and c.account_id is not null;

-- 1 unit of the ad account's currency in the store currency.
create or replace function public._meta_rate(p_account text)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select case when upper(coalesce(a.currency, 'USD')) = upper(public.setting_text('store', array['currency'], 'BDT')) then 1 else a.usd_rate end
     from public.meta_ad_accounts a where a.ad_account_id = regexp_replace(coalesce(p_account, ''), '^act_', '')),
    nullif(public.setting_numeric('meta_ads', array['exchange_rate'], 1), 0), 1)
$$;

create or replace function public._meta_cost(p_spend numeric, p_account text)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select round(coalesce(p_spend, 0) * public._meta_rate(p_account)
    * (1 + greatest(public.setting_numeric('meta_ads', array['tax_percent'], 0), 0) / 100), 2)
$$;

-- Withdraws each finished day's spend from the account's payment account (the
-- day after), and posts the difference when Meta revises a day later.
create or replace function public._meta_settle_payments(p_account text, p_since date, p_until date)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_acc public.meta_ad_accounts;
  v_today date := public._local_date(now());
  v_day record;
  v_count int := 0;
begin
  select * into v_acc from public.meta_ad_accounts where ad_account_id = regexp_replace(coalesce(p_account, ''), '^act_', '');
  if not found or v_acc.payment_account_id is null then
    return 0;
  end if;
  for v_day in
    select d::date as day,
           coalesce((select sum(i.cost) from public.meta_ad_insights i where i.account_id = v_acc.ad_account_id and i.date = d::date), 0) as cost,
           coalesce((select -sum(m.amount) from public.finance_account_movements m where m.meta_account_id = v_acc.id and m.spend_date = d::date), 0) as paid
    from generate_series(greatest(p_since, coalesce(v_acc.payments_from, p_since)), least(p_until, v_today - 1), interval '1 day') d
  loop
    continue when v_day.cost = v_day.paid;
    insert into public.finance_account_movements(account_id, amount, movement_date, description, source, source_key, meta_account_id, spend_date)
    values (v_acc.payment_account_id, -(v_day.cost - v_day.paid),
            case when v_day.paid = 0 then v_day.day + 1 else v_today end,
            left(case when v_day.paid = 0 then 'Meta Ads · ' || v_acc.name || ' · spend on ' || to_char(v_day.day, 'DD Mon YYYY')
                      else 'Meta Ads · ' || v_acc.name || ' · Meta revised ' || to_char(v_day.day, 'DD Mon YYYY') end, 300),
            'META_ADS', 'meta:' || v_acc.id || ':' || v_day.day || ':' || gen_random_uuid(), v_acc.id, v_day.day);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Saved by the meta-ads edge function after the credentials were tested
-- (secrets go to Vault separately). A new rate re-costs that account's days;
-- a new payment account starts withdrawing from today's spend on.
create or replace function public.meta_account_save(p jsonb, p_actor uuid)
returns public.meta_ad_accounts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_old public.meta_ad_accounts;
  v_row public.meta_ad_accounts;
  v_act text := regexp_replace(trim(coalesce(p ->> 'ad_account_id', '')), '^act_', '');
  v_pay uuid := nullif(p ->> 'payment_account_id', '')::uuid;
  v_range record;
  v_ids text[];
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if length(trim(coalesce(p ->> 'name', ''))) < 2 then
    raise exception 'VALIDATION: give the account a name' using errcode = '22023';
  end if;
  if v_act !~ '^[0-9]{3,32}$' then
    raise exception 'VALIDATION: the ad account ID is the number without act_' using errcode = '22023';
  end if;
  if coalesce((p ->> 'usd_rate')::numeric, 110) <= 0 then
    raise exception 'VALIDATION: the USD rate must be more than 0' using errcode = '22023';
  end if;
  if v_pay is not null and not exists (select 1 from public.finance_accounts where id = v_pay and is_active) then
    raise exception 'VALIDATION: choose an active payment account' using errcode = '22023';
  end if;
  if exists (select 1 from public.meta_ad_accounts where ad_account_id = v_act and id is distinct from v_id) then
    raise exception 'DUPLICATE: ad account % is already connected', v_act using errcode = '23505';
  end if;
  if exists (select 1 from public.meta_ad_accounts where lower(name) = lower(trim(p ->> 'name')) and id is distinct from v_id) then
    raise exception 'DUPLICATE: there is already an account called %', trim(p ->> 'name') using errcode = '23505';
  end if;

  if v_id is null then
    insert into public.meta_ad_accounts(name, app_id, ad_account_id, usd_rate, payment_account_id, payments_from, is_active, created_by)
    values (trim(p ->> 'name'), nullif(trim(coalesce(p ->> 'app_id', '')), ''), v_act, coalesce((p ->> 'usd_rate')::numeric, 110),
            v_pay, case when v_pay is not null then public._local_date(now()) end, coalesce((p ->> 'is_active')::boolean, true), p_actor)
    returning * into v_row;
  else
    select * into v_old from public.meta_ad_accounts where id = v_id for update;
    if not found then
      raise exception 'NOT_FOUND: Meta account not found' using errcode = 'P0002';
    end if;
    update public.meta_ad_accounts set name = trim(p ->> 'name'), app_id = nullif(trim(coalesce(p ->> 'app_id', '')), ''),
      ad_account_id = v_act, usd_rate = coalesce((p ->> 'usd_rate')::numeric, usd_rate), payment_account_id = v_pay,
      payments_from = case when v_pay is null then null when v_pay is distinct from v_old.payment_account_id and v_old.payment_account_id is null
                           then public._local_date(now()) else payments_from end,
      is_active = coalesce((p ->> 'is_active')::boolean, is_active)
    where id = v_id returning * into v_row;
  end if;

  -- What the connection test found.
  if p ? 'meta' then
    update public.meta_ad_accounts set meta_name = p #>> '{meta,name}', currency = p #>> '{meta,currency}', timezone = p #>> '{meta,timezone}',
      token_hint = coalesce(p #>> '{meta,token_hint}', token_hint), has_app_secret = coalesce((p #>> '{meta,has_app_secret}')::boolean, has_app_secret),
      token_expires_at = nullif(p #>> '{meta,token_expires_at}', '')::timestamptz,
      connection_status = coalesce(p #>> '{meta,status}', 'OK'), connection_error = p #>> '{meta,error}', tested_at = now()
    where id = v_row.id returning * into v_row;
  end if;

  if v_old.id is not null and v_old.usd_rate is distinct from v_row.usd_rate then
    update public.meta_ad_insights set cost = public._meta_cost(spend, account_id)
    where account_id = v_row.ad_account_id and cost is distinct from public._meta_cost(spend, account_id);
    select min(date) as since, max(date) as until into v_range from public.meta_ad_insights where account_id = v_row.ad_account_id;
    select array_agg(distinct campaign_id) into v_ids from public.meta_ad_insights where account_id = v_row.ad_account_id and campaign_id is not null;
    if v_range.since is not null then
      perform public._meta_refresh_marketing_spend(coalesce(v_ids, '{}'), v_range.since, v_range.until);
      perform public._meta_settle_payments(v_row.ad_account_id, v_range.since, v_range.until);
    end if;
  end if;

  insert into public.audit_logs(actor_id, actor_email, action, entity_type, entity_id, old_values, new_values)
  values (p_actor, (select email from public.profiles where id = p_actor),
          case when v_old.id is null then 'meta_account.created' else 'meta_account.updated' end, 'meta_account', v_row.id::text,
          to_jsonb(v_old), to_jsonb(v_row));
  return v_row;
end;
$$;

-- Stops syncing an account (its token is cleared by the edge function). The
-- spend already synced stays in reports, Finance and the payment account.
create or replace function public.meta_account_disconnect(p_id uuid, p_actor uuid)
returns public.meta_ad_accounts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.meta_ad_accounts;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.meta_ad_accounts set is_active = false, connection_status = 'DISCONNECTED', token_hint = null, has_app_secret = false
  where id = p_id returning * into v_row;
  if not found then
    raise exception 'NOT_FOUND: Meta account not found' using errcode = 'P0002';
  end if;
  insert into public.audit_logs(actor_id, actor_email, action, entity_type, entity_id, new_values)
  values (p_actor, (select email from public.profiles where id = p_actor), 'meta_account.disconnected', 'meta_account', p_id::text, to_jsonb(v_row));
  return v_row;
end;
$$;

create or replace function public.meta_account_record_sync(p_id uuid, p_status text, p_error text, p_since date, p_until date)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.meta_ad_accounts set last_sync_at = now(), last_sync_status = p_status, last_sync_error = left(p_error, 500),
    last_sync_since = p_since, last_sync_until = p_until,
    connection_status = case when p_status = 'TOKEN_INVALID' then 'FAILED' when p_status = 'OK' then 'OK' else connection_status end,
    connection_error = case when p_status = 'OK' then null when p_status = 'TOKEN_INVALID' then left(p_error, 500) else connection_error end
  where id = p_id;
  -- The Marketing overview keeps showing the latest sync of any account.
  update public.settings set value = value || jsonb_build_object('connected', true, 'last_sync_at', now(), 'last_sync_status', p_status,
    'last_sync_error', left(p_error, 500), 'last_sync_since', p_since, 'last_sync_until', p_until)
  where key = 'meta_ads';
end;
$$;

-- Accounts the sync job should run (system only).
create or replace function public.meta_accounts_for_sync(p_id uuid default null)
returns setof public.meta_ad_accounts
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query select * from public.meta_ad_accounts
    where (p_id is null and is_active and connection_status <> 'DISCONNECTED') or id = p_id
    order by created_at;
end;
$$;

-- Accounts for the Marketing page: settings, health and the last 30 days' spend.
create or replace function public.meta_accounts_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_from date := public._local_date(now()) - 29;
begin
  perform public.require_permission('marketing.view');
  return jsonb_build_object(
    'tax_percent', public.setting_numeric('meta_ads', array['tax_percent'], 0),
    'store_currency', public.setting_text('store', array['currency'], 'BDT'),
    'accounts', coalesce((select jsonb_agg(r order by r.is_active desc, r.name) from (
      select a.id, a.name, a.app_id, a.ad_account_id, a.usd_rate, a.payment_account_id, f.name as payment_account_name, a.payments_from,
             a.is_active, a.meta_name, a.currency, a.timezone, a.token_hint, a.has_app_secret, a.token_expires_at, a.connection_status,
             a.connection_error, a.tested_at, a.last_sync_at, a.last_sync_status, a.last_sync_error, a.last_sync_since, a.last_sync_until,
             a.created_at,
             coalesce((select sum(i.cost) from public.meta_ad_insights i where i.account_id = a.ad_account_id and i.date >= v_from), 0) as cost_30d,
             coalesce((select sum(i.spend) from public.meta_ad_insights i where i.account_id = a.ad_account_id and i.date >= v_from), 0) as spend_30d,
             coalesce((select -sum(m.amount) from public.finance_account_movements m where m.meta_account_id = a.id), 0) as paid_total
      from public.meta_ad_accounts a
      left join public.finance_accounts f on f.id = a.payment_account_id) r), '[]'::jsonb));
end;
$$;

-- VAT / fees % on ad spend (all accounts). Re-costs every synced day.
create or replace function public.meta_ads_set_tax(p_tax_percent numeric)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('marketing.manage');
  return public.meta_ads_update_settings(null, p_tax_percent);
end;
$$;

-- -----------------------------------------------------------------------------
-- Sync, Marketing and Finance use each account's own rate
-- -----------------------------------------------------------------------------
create or replace function public._meta_refresh_marketing_spend(p_campaign_ids text[], p_since date, p_until date)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int := 0;
begin
  -- Each Meta campaign has a marketing campaign (platform META, external id).
  insert into public.marketing_campaigns(platform, name, external_id, utm_campaign, status, start_date, end_date, source)
  select 'META', left(mc.name, 200), mc.id, left(mc.name, 200),
         case when coalesce(mc.effective_status, mc.status) = 'ACTIVE' then 'ACTIVE'
              when coalesce(mc.effective_status, mc.status) in ('PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED') then 'PAUSED'
              else 'ENDED' end::public.campaign_status,
         (mc.start_time at time zone public.store_timezone())::date,
         (mc.stop_time at time zone public.store_timezone())::date,
         'API'
  from public.meta_campaigns mc
  where mc.id = any(p_campaign_ids)
  on conflict (platform, external_id) do update set
    name = excluded.name, utm_campaign = excluded.utm_campaign, status = excluded.status,
    start_date = excluded.start_date, end_date = excluded.end_date, updated_at = now();

  update public.meta_campaigns mc set marketing_campaign_id = c.id
  from public.marketing_campaigns c
  where c.platform = 'META' and c.external_id = mc.id and mc.id = any(p_campaign_ids)
    and mc.marketing_campaign_id is distinct from c.id;

  with agg as (
    select c.id as campaign_uuid, i.date,
           sum(i.cost) as cost, sum(i.impressions) as impressions, sum(i.link_clicks) as clicks,
           sum(i.purchases) as purchases, round(sum(i.purchase_value * public._meta_rate(i.account_id)), 2) as revenue
    from public.meta_ad_insights i
    join public.marketing_campaigns c on c.platform = 'META' and c.external_id = i.campaign_id
    where i.campaign_id = any(p_campaign_ids) and i.date between p_since and p_until
    group by c.id, i.date
  ), up as (
    insert into public.marketing_spend(campaign_id, spend_date, spend, impressions, clicks, orders, revenue, source, external_ref, notes)
    select campaign_uuid, date, cost, least(impressions, 2147483647)::int, least(clicks, 2147483647)::int, purchases, revenue,
           'API', 'meta', 'Synced from Meta Ads'
    from agg
    on conflict (campaign_id, spend_date) do update set
      spend = excluded.spend, impressions = excluded.impressions, clicks = excluded.clicks,
      orders = excluded.orders, revenue = excluded.revenue, source = 'API', external_ref = 'meta'
    where (marketing_spend.spend, marketing_spend.impressions, marketing_spend.clicks, marketing_spend.orders, marketing_spend.revenue)
      is distinct from (excluded.spend, excluded.impressions, excluded.clicks, excluded.orders, excluded.revenue)
    returning 1
  )
  select count(*) into v_count from up;

  -- Synced days that no longer have any spend in Meta.
  update public.marketing_spend s set spend = 0, impressions = 0, clicks = 0, orders = 0, revenue = 0
  from public.marketing_campaigns c
  where c.id = s.campaign_id and c.platform = 'META' and c.external_id = any(p_campaign_ids)
    and s.source = 'API' and s.spend_date between p_since and p_until and s.spend > 0
    and not exists (select 1 from public.meta_ad_insights i
                    where i.campaign_id = c.external_id and i.date = s.spend_date and i.cost > 0);
  return v_count;
end;
$$;

create or replace function public.meta_ads_apply_sync(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_since date := (p ->> 'since')::date;
  v_until date := (p ->> 'until')::date;
  v_account text := nullif(regexp_replace(coalesce(p ->> 'account_id', ''), '^act_', ''), '');
  v_paid int := 0;
  v_campaigns int;
  v_adsets int;
  v_ads int;
  v_insights int;
  v_zeroed int := 0;
  v_ids text[];
  v_spend_rows int;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if v_since is null or v_until is null or v_until < v_since or v_until - v_since > 120 then
    raise exception 'VALIDATION: sync window must be 1 to 120 days' using errcode = '22023';
  end if;

  insert into public.meta_campaigns(id, account_id, name, status, effective_status, objective, daily_budget, lifetime_budget,
    start_time, stop_time, created_time, updated_time, synced_at)
  select c ->> 'id', v_account, left(coalesce(nullif(c ->> 'name', ''), 'Campaign ' || (c ->> 'id')), 300),
         c ->> 'status', c ->> 'effective_status', c ->> 'objective',
         nullif(c ->> 'daily_budget', '')::numeric / 100, nullif(c ->> 'lifetime_budget', '')::numeric / 100,
         nullif(c ->> 'start_time', '')::timestamptz, nullif(c ->> 'stop_time', '')::timestamptz,
         nullif(c ->> 'created_time', '')::timestamptz, nullif(c ->> 'updated_time', '')::timestamptz, now()
  from jsonb_array_elements(coalesce(p -> 'campaigns', '[]'::jsonb)) c
  where c ->> 'id' ~ '^[0-9]{1,32}$'
  on conflict (id) do update set
    account_id = coalesce(excluded.account_id, meta_campaigns.account_id), name = excluded.name, status = excluded.status,
    effective_status = excluded.effective_status, objective = excluded.objective, daily_budget = excluded.daily_budget,
    lifetime_budget = excluded.lifetime_budget, start_time = excluded.start_time, stop_time = excluded.stop_time,
    created_time = excluded.created_time, updated_time = excluded.updated_time, synced_at = now();
  get diagnostics v_campaigns = row_count;

  insert into public.meta_adsets(id, campaign_id, name, status, effective_status, daily_budget, lifetime_budget, start_time, end_time, synced_at)
  select s ->> 'id', s ->> 'campaign_id', left(coalesce(nullif(s ->> 'name', ''), 'Ad set ' || (s ->> 'id')), 300),
         s ->> 'status', s ->> 'effective_status',
         nullif(s ->> 'daily_budget', '')::numeric / 100, nullif(s ->> 'lifetime_budget', '')::numeric / 100,
         nullif(s ->> 'start_time', '')::timestamptz, nullif(s ->> 'end_time', '')::timestamptz, now()
  from jsonb_array_elements(coalesce(p -> 'adsets', '[]'::jsonb)) s
  where s ->> 'id' ~ '^[0-9]{1,32}$'
  on conflict (id) do update set
    campaign_id = excluded.campaign_id, name = excluded.name, status = excluded.status, effective_status = excluded.effective_status,
    daily_budget = excluded.daily_budget, lifetime_budget = excluded.lifetime_budget, start_time = excluded.start_time,
    end_time = excluded.end_time, synced_at = now();
  get diagnostics v_adsets = row_count;

  insert into public.meta_ads(id, adset_id, campaign_id, name, status, effective_status, creative_id, creative_name,
    thumbnail_url, title, body, synced_at)
  select a ->> 'id', a ->> 'adset_id', a ->> 'campaign_id', left(coalesce(nullif(a ->> 'name', ''), 'Ad ' || (a ->> 'id')), 300),
         a ->> 'status', a ->> 'effective_status', a #>> '{creative,id}', left(a #>> '{creative,name}', 300),
         case when a #>> '{creative,thumbnail_url}' ~ '^https://' then left(a #>> '{creative,thumbnail_url}', 2000) end,
         left(a #>> '{creative,title}', 300), left(a #>> '{creative,body}', 2000), now()
  from jsonb_array_elements(coalesce(p -> 'ads', '[]'::jsonb)) a
  where a ->> 'id' ~ '^[0-9]{1,32}$'
  on conflict (id) do update set
    adset_id = excluded.adset_id, campaign_id = excluded.campaign_id, name = excluded.name, status = excluded.status,
    effective_status = excluded.effective_status, creative_id = excluded.creative_id, creative_name = excluded.creative_name,
    thumbnail_url = excluded.thumbnail_url, title = excluded.title, body = excluded.body, synced_at = now();
  get diagnostics v_ads = row_count;

  -- Archived or removed items only appear in insights: keep their names.
  insert into public.meta_campaigns(id, account_id, name)
  select distinct on (i ->> 'campaign_id') i ->> 'campaign_id', v_account,
         left(coalesce(nullif(i ->> 'campaign_name', ''), 'Campaign ' || (i ->> 'campaign_id')), 300)
  from jsonb_array_elements(coalesce(p -> 'insights', '[]'::jsonb)) i
  where i ->> 'campaign_id' ~ '^[0-9]{1,32}$'
  on conflict (id) do nothing;
  insert into public.meta_adsets(id, campaign_id, name)
  select distinct on (i ->> 'adset_id') i ->> 'adset_id', i ->> 'campaign_id',
         left(coalesce(nullif(i ->> 'adset_name', ''), 'Ad set ' || (i ->> 'adset_id')), 300)
  from jsonb_array_elements(coalesce(p -> 'insights', '[]'::jsonb)) i
  where i ->> 'adset_id' ~ '^[0-9]{1,32}$'
  on conflict (id) do nothing;
  insert into public.meta_ads(id, adset_id, campaign_id, name)
  select distinct on (i ->> 'ad_id') i ->> 'ad_id', i ->> 'adset_id', i ->> 'campaign_id',
         left(coalesce(nullif(i ->> 'ad_name', ''), 'Ad ' || (i ->> 'ad_id')), 300)
  from jsonb_array_elements(coalesce(p -> 'insights', '[]'::jsonb)) i
  where i ->> 'ad_id' ~ '^[0-9]{1,32}$'
  on conflict (id) do nothing;

  with rows as (
    select i ->> 'ad_id' as ad_id, (i ->> 'date')::date as date,
           case when i ->> 'platform' in ('facebook', 'instagram', 'messenger', 'audience_network') then i ->> 'platform' else 'unknown' end as platform,
           i ->> 'campaign_id' as campaign_id, i ->> 'adset_id' as adset_id,
           greatest(coalesce(nullif(i ->> 'spend', '')::numeric, 0), 0) as spend,
           coalesce(nullif(i ->> 'impressions', '')::bigint, 0) as impressions,
           coalesce(nullif(i ->> 'clicks', '')::bigint, 0) as clicks,
           coalesce(nullif(i ->> 'link_clicks', '')::bigint, 0) as link_clicks,
           coalesce(nullif(i ->> 'purchases', '')::numeric, 0)::int as purchases,
           coalesce(nullif(i ->> 'purchase_value', '')::numeric, 0) as purchase_value
    from jsonb_array_elements(coalesce(p -> 'insights', '[]'::jsonb)) i
    where i ->> 'ad_id' ~ '^[0-9]{1,32}$' and (i ->> 'date')::date between v_since and v_until
  ), merged as (
    -- Meta can split one day into several rows; add them up.
    select ad_id, date, platform, max(campaign_id) as campaign_id, max(adset_id) as adset_id, sum(spend) as spend,
           sum(impressions) as impressions, sum(clicks) as clicks, sum(link_clicks) as link_clicks,
           sum(purchases) as purchases, sum(purchase_value) as purchase_value
    from rows group by ad_id, date, platform
  )
  insert into public.meta_ad_insights(ad_id, date, platform, account_id, campaign_id, adset_id, spend, cost, impressions, clicks, link_clicks,
    purchases, purchase_value, synced_at)
  select ad_id, date, platform, v_account, campaign_id, adset_id, round(spend, 2), public._meta_cost(spend, v_account), impressions, clicks, link_clicks,
         purchases, round(purchase_value, 2), now()
  from merged
  on conflict (ad_id, date, platform) do update set
    account_id = coalesce(excluded.account_id, meta_ad_insights.account_id),
    campaign_id = excluded.campaign_id, adset_id = excluded.adset_id, spend = excluded.spend, cost = excluded.cost,
    impressions = excluded.impressions, clicks = excluded.clicks, link_clicks = excluded.link_clicks,
    purchases = excluded.purchases, purchase_value = excluded.purchase_value, synced_at = now();
  get diagnostics v_insights = row_count;

  if coalesce((p ->> 'complete')::boolean, false) then
    with keep as (
      select distinct x ->> 'ad_id' as ad_id, (x ->> 'date')::date as date,
             case when x ->> 'platform' in ('facebook', 'instagram', 'messenger', 'audience_network') then x ->> 'platform' else 'unknown' end as platform
      from jsonb_array_elements(coalesce(p -> 'insights', '[]'::jsonb)) x
    )
    update public.meta_ad_insights i set spend = 0, cost = 0, impressions = 0, clicks = 0, link_clicks = 0, purchases = 0,
      purchase_value = 0, synced_at = now()
    where i.date between v_since and v_until and (i.spend > 0 or i.impressions > 0)
      and i.account_id is not distinct from v_account
      and not exists (select 1 from keep k where k.ad_id = i.ad_id and k.date = i.date and k.platform = i.platform);
    get diagnostics v_zeroed = row_count;
  end if;

  select array_agg(distinct campaign_id) into v_ids from (
    select campaign_id from public.meta_ad_insights where date between v_since and v_until and campaign_id is not null
      and account_id is not distinct from v_account
    union select c ->> 'id' from jsonb_array_elements(coalesce(p -> 'campaigns', '[]'::jsonb)) c where c ->> 'id' ~ '^[0-9]{1,32}$'
  ) x;
  v_spend_rows := public._meta_refresh_marketing_spend(coalesce(v_ids, '{}'), v_since, v_until);
  v_paid := public._meta_settle_payments(v_account, v_since, v_until);

  return jsonb_build_object('campaigns', v_campaigns, 'adsets', v_adsets, 'ads', v_ads, 'insights', v_insights,
    'zeroed', v_zeroed, 'spend_days_changed', v_spend_rows, 'payments', v_paid,
    'cost', (select coalesce(sum(cost), 0) from public.meta_ad_insights
             where date between v_since and v_until and account_id is not distinct from v_account));
end;
$$;

create or replace function public.meta_ads_update_settings(p_exchange_rate numeric default null, p_tax_percent numeric default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_value jsonb;
  v_ids text[];
  v_range record;
begin
  perform public.require_permission('marketing.manage');
  if p_exchange_rate is not null and (p_exchange_rate <= 0 or p_exchange_rate > 100000) then
    raise exception 'VALIDATION: the exchange rate must be more than 0' using errcode = '22023';
  end if;
  if p_tax_percent is not null and (p_tax_percent < 0 or p_tax_percent > 100) then
    raise exception 'VALIDATION: VAT and fees must be between 0 and 100%%' using errcode = '22023';
  end if;
  update public.settings set value = value
    || case when p_exchange_rate is null then '{}'::jsonb else jsonb_build_object('exchange_rate', p_exchange_rate) end
    || case when p_tax_percent is null then '{}'::jsonb else jsonb_build_object('tax_percent', p_tax_percent) end,
    updated_by = auth.uid()
  where key = 'meta_ads' returning value into v_value;

  update public.meta_ad_insights set cost = public._meta_cost(spend, account_id) where cost is distinct from public._meta_cost(spend, account_id);
  select min(date) as since, max(date) as until into v_range from public.meta_ad_insights;
  select array_agg(distinct campaign_id) into v_ids from public.meta_ad_insights where campaign_id is not null;
  if v_range.since is not null then
    perform public._meta_refresh_marketing_spend(coalesce(v_ids, '{}'), v_range.since, v_range.until);
    perform public._meta_settle_payments(a.ad_account_id, v_range.since, v_range.until) from public.meta_ad_accounts a;
  end if;
  perform public.log_audit('meta_ads.settings_changed', 'settings', 'meta_ads', null,
    jsonb_build_object('exchange_rate', p_exchange_rate, 'tax_percent', p_tax_percent));
  return v_value;
end;
$$;

create or replace function public.report_meta_ads(p_from date, p_to date, p_level text default 'campaign', p_parent text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz text := public.store_timezone();
begin
  perform public.require_permission('marketing.view');
  if p_level not in ('campaign', 'adset', 'ad') then
    raise exception 'VALIDATION: unknown level %', p_level using errcode = '22023';
  end if;
  return coalesce((
    with ins as (
      select case p_level when 'campaign' then i.campaign_id when 'adset' then i.adset_id else i.ad_id end as id,
             sum(i.cost) as spend, sum(i.spend) as spend_account, sum(i.impressions) as impressions, sum(i.clicks) as clicks,
             sum(i.link_clicks) as link_clicks, sum(i.purchases) as purchases, round(sum(i.purchase_value * public._meta_rate(i.account_id)), 2) as purchase_value
      from public.meta_ad_insights i
      where i.date between p_from and p_to
        and (p_parent is null or (p_level = 'adset' and i.campaign_id = p_parent) or (p_level = 'ad' and i.adset_id = p_parent))
      group by 1
    ), ord as (
      select case p_level when 'campaign' then f.campaign_key when 'adset' then f.adset_key else f.ad_key end as id,
             count(*) as orders,
             count(*) filter (where f.status in ('DELIVERED', 'PARTIALLY_DELIVERED')) as delivered,
             count(*) filter (where f.status in ('CANCELLED', 'REJECTED_FRAUD')) as cancelled,
             count(*) filter (where f.status in ('RETURN_REQUESTED', 'RETURNING', 'RETURNED')) as returned,
             coalesce(sum(f.total_amount) filter (where f.status in ('DELIVERED', 'PARTIALLY_DELIVERED')), 0) as revenue
      from public.order_attribution_facts f
      where (f.created_at at time zone v_tz)::date between p_from and p_to
        and (p_parent is null
             or (p_level = 'adset' and f.campaign_key = p_parent)
             or (p_level = 'ad' and f.adset_key = p_parent))
      group by 1
    ), items as (
      select x.id, x.name, x.status, x.effective_status, x.parent, x.thumbnail_url, x.title, x.daily_budget
      from (
        select c.id, c.name, c.status, c.effective_status, null::text as parent, null::text as thumbnail_url, null::text as title, c.daily_budget
        from public.meta_campaigns c where p_level = 'campaign'
        union all
        select s.id, s.name, s.status, s.effective_status, s.campaign_id, null, null, s.daily_budget
        from public.meta_adsets s where p_level = 'adset' and (p_parent is null or s.campaign_id = p_parent)
        union all
        select a.id, a.name, a.status, a.effective_status, a.adset_id, a.thumbnail_url, a.title, null
        from public.meta_ads a where p_level = 'ad' and (p_parent is null or a.adset_id = p_parent)
      ) x
    )
    select jsonb_agg(jsonb_build_object(
      'id', it.id, 'name', it.name, 'status', it.status, 'effective_status', it.effective_status, 'parent', it.parent,
      'thumbnail_url', it.thumbnail_url, 'title', it.title, 'daily_budget', it.daily_budget,
      'spend', coalesce(ins.spend, 0), 'spend_account', coalesce(ins.spend_account, 0),
      'impressions', coalesce(ins.impressions, 0), 'clicks', coalesce(ins.link_clicks, 0),
      'ctr', case when ins.impressions > 0 then round(100.0 * ins.link_clicks / ins.impressions, 2) end,
      'cpc', case when ins.link_clicks > 0 then round(ins.spend / ins.link_clicks, 2) end,
      'cpm', case when ins.impressions > 0 then round(1000 * ins.spend / ins.impressions, 2) end,
      'meta_purchases', coalesce(ins.purchases, 0), 'meta_purchase_value', coalesce(ins.purchase_value, 0),
      'orders', coalesce(ord.orders, 0), 'delivered', coalesce(ord.delivered, 0), 'cancelled', coalesce(ord.cancelled, 0),
      'returned', coalesce(ord.returned, 0), 'revenue', coalesce(ord.revenue, 0),
      'cost_per_order', case when ord.orders > 0 and ins.spend > 0 then round(ins.spend / ord.orders, 2) end,
      'roas', case when ins.spend > 0 then round(coalesce(ord.revenue, 0) / ins.spend, 2) end)
      order by coalesce(ins.spend, 0) desc, coalesce(ord.orders, 0) desc, it.name)
    from items it
    left join ins on ins.id = it.id
    left join ord on ord.id = it.id
    where ins.id is not null or ord.id is not null
       or coalesce(it.effective_status, it.status) in ('ACTIVE', 'IN_PROCESS', 'WITH_ISSUES')
  ), '[]'::jsonb);
end;
$$;

-- -----------------------------------------------------------------------------
-- The single account connected before becomes the first of the list
-- -----------------------------------------------------------------------------
do $$
declare
  v_cfg jsonb := public.get_setting('meta_ads');
  v_secret jsonb;
  v_id uuid;
begin
  if coalesce((v_cfg ->> 'connected')::boolean, false) and coalesce(v_cfg ->> 'ad_account_id', '') <> ''
     and not exists (select 1 from public.meta_ad_accounts) then
    insert into public.meta_ad_accounts(name, ad_account_id, usd_rate, meta_name, currency, timezone, token_hint, connection_status, tested_at,
      last_sync_at, last_sync_status, last_sync_error, last_sync_since, last_sync_until)
    values (left(coalesce(nullif(v_cfg ->> 'ad_account_name', ''), 'Meta Ads'), 80), regexp_replace(v_cfg ->> 'ad_account_id', '^act_', ''),
      coalesce(nullif((v_cfg ->> 'exchange_rate')::numeric, 0), 110), v_cfg ->> 'ad_account_name', v_cfg ->> 'account_currency',
      v_cfg ->> 'account_timezone', v_cfg ->> 'hint', 'OK', nullif(v_cfg ->> 'connected_at', '')::timestamptz,
      nullif(v_cfg ->> 'last_sync_at', '')::timestamptz, v_cfg ->> 'last_sync_status', v_cfg ->> 'last_sync_error',
      nullif(v_cfg ->> 'last_sync_since', '')::date, nullif(v_cfg ->> 'last_sync_until', '')::date)
    returning id into v_id;
    v_secret := public.integration_secret_get('meta.ads');
    if v_secret ? 'access_token' then
      perform public.integration_secret_store('meta.ads.' || replace(v_id::text, '-', ''), v_secret, v_cfg ->> 'hint', null);
    end if;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Access
-- -----------------------------------------------------------------------------
revoke all on function public.finance_accounts_list(), public.finance_account_save(jsonb),
  public.finance_account_move(uuid, numeric, date, text), public.finance_account_movements_list(uuid, int, int),
  public._meta_rate(text), public._meta_cost(numeric, text), public._meta_settle_payments(text, date, date),
  public.meta_account_save(jsonb, uuid), public.meta_account_disconnect(uuid, uuid),
  public.meta_account_record_sync(uuid, text, text, date, date), public.meta_accounts_for_sync(uuid),
  public.meta_accounts_list(), public.meta_ads_set_tax(numeric)
from public, anon, authenticated;
grant execute on function public.finance_accounts_list(), public.finance_account_save(jsonb),
  public.finance_account_move(uuid, numeric, date, text), public.finance_account_movements_list(uuid, int, int),
  public.meta_accounts_list(), public.meta_ads_set_tax(numeric)
to authenticated;
grant execute on function public.meta_account_save(jsonb, uuid), public.meta_account_disconnect(uuid, uuid),
  public.meta_account_record_sync(uuid, text, text, date, date), public.meta_accounts_for_sync(uuid)
to service_role;
