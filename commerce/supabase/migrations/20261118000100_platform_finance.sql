-- =============================================================================
-- Super Admin → Income & Expenses: Fullfilio's own books.
--
-- Three kinds of rows, read together:
--   * manual income and expenses the team records (salaries, servers, rent…);
--   * daily Meta ad spend from Fullfilio's own ad accounts, synced by the
--     platform-admin function (spend in USD converted at the account's rate);
--   * money merchants paid the platform — subscriptions, credits, add-ons and
--     VoiceDrive packages — and refunds sent back, read straight from billing
--     (never copied, so they cannot drift).
-- Demo merchants are left out, as everywhere else in the business figures.
-- Every function checks the caller's platform permission on module 'finance'.
-- =============================================================================

insert into public.platform_modules (code, name, sort_order, actions) values
  ('finance', 'Income & Expenses', 21, '{view,create,edit,delete,manage,export}')
on conflict (code) do nothing;

-- Billing Manager runs the books; Operations Manager and the read-only Viewer see them.
insert into public.platform_role_permissions (role_id, module, action)
select r.id, 'finance', a
from public.platform_roles r
cross join lateral unnest(case r.code
  when 'BILLING_MANAGER' then array['view', 'create', 'edit', 'delete', 'manage', 'export']
  when 'OPERATIONS_MANAGER' then array['view', 'export']
  when 'VIEWER' then array['view']
  else array[]::text[] end) a
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 1. Tables
-- -----------------------------------------------------------------------------
create table public.platform_finance_categories (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('INCOME', 'EXPENSE')),
  code text not null check (code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  name text not null check (length(trim(name)) between 2 and 60),
  color text not null default 'slate' check (color ~ '^[a-z]{3,10}$'),
  subcategories text[] not null default '{}',
  -- Auto-only categories are filled by billing or the ad sync, never by hand.
  allow_manual boolean not null default true,
  is_system boolean not null default false,
  is_active boolean not null default true,
  sort_order int not null default 100,
  created_at timestamptz not null default now(),
  unique (type, code)
);

insert into public.platform_finance_categories (type, code, name, color, subcategories, allow_manual, is_system, sort_order) values
  ('EXPENSE', 'ADVERTISING', 'Ads', 'blue', '{Meta,Google,TikTok}', true, true, 1),
  ('EXPENSE', 'SALARY', 'Salaries', 'violet', '{}', true, true, 2),
  ('EXPENSE', 'INFRASTRUCTURE', 'Servers & hosting', 'teal', '{Cloudflare,Supabase,Vercel,Domains}', true, true, 3),
  ('EXPENSE', 'SOFTWARE', 'Software & tools', 'indigo', '{}', true, true, 4),
  ('EXPENSE', 'SMS_PROVIDER', 'SMS provider', 'cyan', '{}', true, true, 5),
  ('EXPENSE', 'COURIER_API', 'Courier API', 'amber', '{}', true, true, 6),
  ('EXPENSE', 'PAYMENT_FEES', 'Payment fees', 'orange', '{bKash,PayStation}', true, true, 7),
  ('EXPENSE', 'OFFICE', 'Office & rent', 'lime', '{}', true, true, 8),
  ('EXPENSE', 'MARKETING', 'Marketing (other)', 'pink', '{}', true, true, 9),
  ('EXPENSE', 'MERCHANT_REFUNDS', 'Refunds to merchants', 'red', '{}', false, true, 10),
  ('EXPENSE', 'OTHER_EXPENSE', 'Other expense', 'slate', '{}', true, true, 99),
  ('INCOME', 'SUBSCRIPTIONS', 'Subscriptions', 'emerald', '{}', false, true, 1),
  ('INCOME', 'CREDITS', 'Credit sales', 'teal', '{}', false, true, 2),
  ('INCOME', 'ADDONS', 'Add-ons', 'sky', '{}', false, true, 3),
  ('INCOME', 'PBX', 'VoiceDrive PBX', 'violet', '{}', false, true, 4),
  ('INCOME', 'OTHER_BILLING', 'Other merchant payments', 'cyan', '{}', false, true, 5),
  ('INCOME', 'SERVICES', 'Services & setup', 'amber', '{}', true, true, 6),
  ('INCOME', 'INVESTMENT', 'Investment & loans', 'indigo', '{}', true, true, 7),
  ('INCOME', 'OTHER_INCOME', 'Other income', 'slate', '{}', true, true, 99);

create table public.platform_ad_accounts (
  id uuid primary key default gen_random_uuid(),
  platform text not null default 'META' check (platform = 'META'),
  name text not null check (length(trim(name)) between 2 and 80),
  ad_account_id text not null unique check (ad_account_id ~ '^act_[0-9]{3,32}$'),
  app_id text check (app_id is null or app_id ~ '^[0-9]{5,32}$'),
  -- Taka per unit of the account's currency (1 for a BDT account).
  usd_rate numeric(12, 4) not null check (usd_rate > 0 and usd_rate <= 100000),
  is_active boolean not null default true,
  account_name text,
  currency text,
  timezone text,
  token_hint text,
  has_app_secret boolean not null default false,
  token_expires_at timestamptz,
  status text not null default 'NEW' check (status in ('NEW', 'OK', 'FAILED', 'TOKEN_INVALID', 'NO_ACCESS', 'RATE_LIMITED', 'DISCONNECTED')),
  last_error text,
  last_sync_at timestamptz,
  last_sync_since date,
  last_sync_until date,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger platform_ad_accounts_updated_at before update on public.platform_ad_accounts
  for each row execute function public.set_updated_at();

create sequence public.platform_finance_entry_seq;
create table public.platform_finance_entries (
  id uuid primary key default gen_random_uuid(),
  txn_number text not null unique default ('PF-' || lpad(nextval('public.platform_finance_entry_seq')::text, 6, '0')),
  type text not null check (type in ('INCOME', 'EXPENSE')),
  category_id uuid not null references public.platform_finance_categories(id),
  sub_category text check (sub_category is null or length(sub_category) between 1 and 60),
  txn_date date not null,
  amount numeric(14, 2) not null check (amount > 0 and amount <= 1000000000),
  foreign_amount numeric(14, 2) check (foreign_amount is null or foreign_amount > 0),
  foreign_currency text check (foreign_currency is null or foreign_currency ~ '^[A-Z]{3}$'),
  exchange_rate numeric(12, 4) check (exchange_rate is null or exchange_rate > 0),
  notes text check (notes is null or length(notes) <= 300),
  reference text check (reference is null or length(reference) <= 120),
  -- MANUAL: recorded here. META_ADS: one row per ad account and day, kept up to date by the sync.
  source text not null default 'MANUAL' check (source in ('MANUAL', 'META_ADS')),
  source_key text unique,
  ad_account_id uuid references public.platform_ad_accounts(id),
  created_by uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Deleting keeps the row (who, when, why), it just stops counting.
  voided_at timestamptz,
  voided_by uuid,
  void_reason text,
  check ((source = 'MANUAL') = (source_key is null)),
  check (source <> 'META_ADS' or ad_account_id is not null)
);
create index platform_finance_entries_date_idx on public.platform_finance_entries (txn_date, type);
create index platform_finance_entries_category_idx on public.platform_finance_entries (category_id);
create trigger platform_finance_entries_updated_at before update on public.platform_finance_entries
  for each row execute function public.set_updated_at();

alter table public.platform_finance_categories enable row level security;
alter table public.platform_ad_accounts enable row level security;
alter table public.platform_finance_entries enable row level security;
revoke all on public.platform_finance_categories, public.platform_ad_accounts, public.platform_finance_entries from anon, authenticated;
revoke all on sequence public.platform_finance_entry_seq from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. Every row of the books in a date range (Bangladesh business days)
-- -----------------------------------------------------------------------------
create or replace function public._platform_finance_rows(p_from date, p_to date)
returns table (
  id text, type text, category_id uuid, sub_category text, txn_date date, amount numeric, foreign_amount numeric,
  foreign_currency text, exchange_rate numeric, notes text, reference text, source text, txn_number text,
  created_by text, created_at timestamptz, editable boolean, voided boolean, merchant text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with bounds as (
    select (p_from::timestamp at time zone 'Asia/Dhaka') as t_from, ((p_to + 1)::timestamp at time zone 'Asia/Dhaka') as t_to
  ), cat as (
    select c.type, c.code, c.id from public.platform_finance_categories c
  )
  select e.id::text, e.type, e.category_id, e.sub_category, e.txn_date, e.amount, e.foreign_amount, e.foreign_currency, e.exchange_rate,
         e.notes, e.reference, e.source, e.txn_number, e.created_by_email, e.created_at,
         e.source = 'MANUAL' and e.voided_at is null, e.voided_at is not null, null::text
  from public.platform_finance_entries e
  where e.txn_date between p_from and p_to
  union all
  -- Verified payments from merchants, by what the invoice was for.
  select 'billing:' || p.id, 'INCOME', c.id, null, (coalesce(p.verified_at, p.created_at) at time zone 'Asia/Dhaka')::date, p.amount, null, null, null,
         m.name || ' · ' || i.number, p.reference, 'BILLING', i.number, null, p.created_at, false, false, m.name
  from public.billing_payments p
  join public.billing_invoices i on i.id = p.invoice_id
  join public.merchants m on m.id = p.merchant_id and not m.is_demo
  join cat c on c.type = 'INCOME' and c.code = case i.kind when 'SUBSCRIPTION' then 'SUBSCRIPTIONS' when 'CREDITS' then 'CREDITS'
                                                           when 'ADDON' then 'ADDONS' else 'OTHER_BILLING' end
  cross join bounds b
  where p.status = 'SUCCEEDED' and coalesce(p.verified_at, p.created_at) >= b.t_from and coalesce(p.verified_at, p.created_at) < b.t_to
  union all
  -- VoiceDrive packages and call top-ups paid with bKash.
  select 'pbx:' || t.id, 'INCOME', c.id, initcap(t.type), (t.completed_at at time zone 'Asia/Dhaka')::date, t.amount_tk, null, null, null,
         m.name || ' · ' || case t.type when 'PACKAGE' then 'PBX package' else 'PBX top-up' end, t.trx_id, 'BILLING', t.reference, null, t.created_at,
         false, false, m.name
  from public.pbx_bkash_transactions t
  join public.merchants m on m.id = t.merchant_id and not m.is_demo
  join cat c on c.type = 'INCOME' and c.code = 'PBX'
  cross join bounds b
  where t.status = 'COMPLETED' and t.completed_at >= b.t_from and t.completed_at < b.t_to
  union all
  -- Money sent back to merchants.
  select 'refund:' || r.id, 'EXPENSE', c.id, initcap(r.method), (r.completed_at at time zone 'Asia/Dhaka')::date, r.amount, null, null, null,
         m.name || ' · ' || r.reason, r.provider_refund_id, 'BILLING', i.number, null, r.created_at, false, false, m.name
  from public.billing_refunds r
  join public.billing_payments p on p.id = r.payment_id
  join public.billing_invoices i on i.id = p.invoice_id
  join public.merchants m on m.id = r.merchant_id and not m.is_demo
  join cat c on c.type = 'EXPENSE' and c.code = 'MERCHANT_REFUNDS'
  cross join bounds b
  where r.status = 'SUCCEEDED' and r.completed_at >= b.t_from and r.completed_at < b.t_to
$$;

create or replace function public._platform_finance_range(p_from date, p_to date)
returns void
language plpgsql
immutable
as $$
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 731 then
    raise exception 'VALIDATION: choose a range of up to two years' using errcode = '22023';
  end if;
end;
$$;

create or replace function public._platform_finance_category_json(c public.platform_finance_categories)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object('id', c.id, 'type', c.type, 'code', c.code, 'name', c.name, 'color', c.color, 'subcategories', to_jsonb(c.subcategories),
    'allow_manual', c.allow_manual, 'is_system', c.is_system, 'is_active', c.is_active)
$$;

-- -----------------------------------------------------------------------------
-- 3. Reading the books
-- -----------------------------------------------------------------------------
create or replace function public.platform_finance_categories_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._platform_require('finance', 'view');
  return coalesce((select jsonb_agg(public._platform_finance_category_json(c) order by c.type, c.sort_order, c.name)
                   from public.platform_finance_categories c), '[]'::jsonb);
end;
$$;

-- Days down, categories across (the same shape as a store's Income & Expense matrix).
create or replace function public.platform_finance_ledger(p_type text, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._platform_require('finance', 'view');
  perform public._platform_finance_range(p_from, p_to);
  if p_type not in ('INCOME', 'EXPENSE') then
    raise exception 'VALIDATION: type is INCOME or EXPENSE' using errcode = '22023';
  end if;
  return (
    with r as (
      select * from public._platform_finance_rows(p_from, p_to) x where x.type = p_type and not x.voided
    ), per_cat as (
      select r.category_id, sum(r.amount) as total, count(*) as n from r group by r.category_id
    ), cells as (
      select r.txn_date, r.category_id, sum(r.amount) as amount, count(*) as n,
             sum(r.foreign_amount) filter (where r.foreign_currency = 'USD') as usd
      from r group by r.txn_date, r.category_id
    ), days as (
      select c.txn_date, sum(c.amount) as total,
             jsonb_object_agg(c.category_id, jsonb_build_object('amount', c.amount, 'count', c.n, 'usd', c.usd)) as cells
      from cells c group by c.txn_date
    )
    select jsonb_build_object(
      'total', coalesce((select sum(amount) from r), 0),
      'count', (select count(*) from r),
      'usd_total', (select sum(foreign_amount) from r where foreign_currency = 'USD'),
      'categories', coalesce((
        select jsonb_agg(jsonb_build_object('id', c.id, 'code', c.code, 'name', c.name, 'color', c.color, 'manual', c.allow_manual,
                 'subcategories', to_jsonb(c.subcategories), 'total', coalesce(pc.total, 0), 'count', coalesce(pc.n, 0))
                 order by c.sort_order, c.name)
        from public.platform_finance_categories c left join per_cat pc on pc.category_id = c.id
        where c.type = p_type and (c.is_active or pc.total is not null)), '[]'::jsonb),
      'days', coalesce((select jsonb_agg(jsonb_build_object('date', d.txn_date, 'total', d.total, 'cells', d.cells) order by d.txn_date desc) from days d), '[]'::jsonb))
  );
end;
$$;

create or replace function public.platform_finance_entries(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_from date := coalesce(nullif(p ->> 'from', '')::date, (now() at time zone 'Asia/Dhaka')::date - 29);
  v_to date := coalesce(nullif(p ->> 'to', '')::date, (now() at time zone 'Asia/Dhaka')::date);
  v_type text := nullif(p ->> 'type', '');
  v_cat uuid := nullif(p ->> 'category_id', '')::uuid;
  v_sub text := nullif(p ->> 'sub_category', '');
  v_source text := nullif(p ->> 'source', '');
  v_q text := nullif(trim(coalesce(p ->> 'q', '')), '');
  v_voided boolean := coalesce((p ->> 'show_voided')::boolean, false);
  v_limit int := least(greatest(coalesce((p ->> 'limit')::int, 20), 1), 200);
  v_offset int := greatest(coalesce((p ->> 'offset')::int, 0), 0);
begin
  perform public._platform_require('finance', 'view');
  perform public._platform_finance_range(v_from, v_to);
  return (
    with r as (
      select x.* from public._platform_finance_rows(v_from, v_to) x
      where (v_type is null or x.type = v_type) and (v_cat is null or x.category_id = v_cat)
        and (v_sub is null or x.sub_category = v_sub) and (v_source is null or x.source = v_source)
        and (v_voided or not x.voided)
        and (v_q is null or concat_ws(' ', x.txn_number, x.notes, x.reference, x.sub_category, x.merchant) ilike '%' || v_q || '%')
    ), page as (
      select r.* from r order by r.txn_date desc, r.created_at desc, r.id limit v_limit offset v_offset
    )
    select jsonb_build_object(
      'total', (select count(*) from r),
      'sum', coalesce((select sum(amount) from r where not voided), 0),
      'items', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', pg.id, 'txn_number', pg.txn_number, 'type', pg.type, 'date', pg.txn_date, 'amount', pg.amount,
                 'foreign_amount', pg.foreign_amount, 'foreign_currency', pg.foreign_currency, 'exchange_rate', pg.exchange_rate,
                 'category', jsonb_build_object('id', c.id, 'name', c.name, 'code', c.code, 'color', c.color),
                 'sub_category', pg.sub_category, 'notes', pg.notes, 'reference', pg.reference, 'source', pg.source,
                 'merchant', pg.merchant, 'editable', pg.editable, 'voided', pg.voided, 'created_by', pg.created_by, 'created_at', pg.created_at)
               order by pg.txn_date desc, pg.created_at desc, pg.id)
        from page pg join public.platform_finance_categories c on c.id = pg.category_id), '[]'::jsonb))
  );
end;
$$;

create or replace function public.platform_finance_overview(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._platform_require('finance', 'view');
  perform public._platform_finance_range(p_from, p_to);
  return (
    with r as (
      select * from public._platform_finance_rows(p_from, p_to) x where not x.voided
    )
    select jsonb_build_object(
      'income', coalesce((select sum(amount) from r where type = 'INCOME'), 0),
      'expense', coalesce((select sum(amount) from r where type = 'EXPENSE'), 0),
      'income_count', (select count(*) from r where type = 'INCOME'),
      'expense_count', (select count(*) from r where type = 'EXPENSE'),
      'ads', coalesce((select sum(amount) from r where source = 'META_ADS'), 0),
      'ads_usd', (select sum(foreign_amount) from r where source = 'META_ADS' and foreign_currency = 'USD'),
      'merchant_income', coalesce((select sum(amount) from r where source = 'BILLING' and type = 'INCOME'), 0),
      'series', coalesce((
        select jsonb_agg(jsonb_build_object('date', d::date,
                 'income', coalesce((select sum(amount) from r where r.txn_date = d::date and r.type = 'INCOME'), 0),
                 'expense', coalesce((select sum(amount) from r where r.txn_date = d::date and r.type = 'EXPENSE'), 0)) order by d)
        from generate_series(p_from, p_to, interval '1 day') d), '[]'::jsonb),
      'by_category', coalesce((
        select jsonb_agg(jsonb_build_object('type', x.type, 'name', x.name, 'color', x.color, 'total', x.total) order by x.total desc)
        from (select c.type, c.name, c.color, sum(r.amount) as total from r join public.platform_finance_categories c on c.id = r.category_id
              group by c.type, c.name, c.color) x), '[]'::jsonb),
      'by_month', coalesce((
        select jsonb_agg(jsonb_build_object('month', x.month, 'income', x.income, 'expense', x.expense) order by x.month)
        from (select to_char(date_trunc('month', r.txn_date), 'YYYY-MM') as month,
                     coalesce(sum(r.amount) filter (where r.type = 'INCOME'), 0) as income,
                     coalesce(sum(r.amount) filter (where r.type = 'EXPENSE'), 0) as expense
              from r group by 1) x), '[]'::jsonb),
      'can_manage', public.platform_can('finance', 'manage'),
      'can_create', public.platform_can('finance', 'create'))
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Recording by hand
-- -----------------------------------------------------------------------------
create or replace function public.platform_finance_entry_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_type text := p ->> 'type';
  v_cat public.platform_finance_categories;
  v_date date := nullif(p ->> 'txn_date', '')::date;
  v_foreign numeric := nullif(p ->> 'foreign_amount', '')::numeric;
  v_currency text := upper(nullif(trim(coalesce(p ->> 'foreign_currency', '')), ''));
  v_rate numeric := nullif(p ->> 'exchange_rate', '')::numeric;
  v_amount numeric := nullif(p ->> 'amount', '')::numeric;
  v_before public.platform_finance_entries;
  e public.platform_finance_entries;
begin
  if v_id is null then
    perform public._platform_require('finance', 'create');
  else
    perform public._platform_require('finance', 'edit');
    select * into v_before from public.platform_finance_entries where id = v_id for update;
    if v_before.id is null then
      raise exception 'NOT_FOUND: entry not found' using errcode = 'P0002';
    end if;
    if v_before.source <> 'MANUAL' or v_before.voided_at is not null then
      raise exception 'VALIDATION: only entries recorded by hand, and not deleted, can be edited' using errcode = '22023';
    end if;
    v_type := v_before.type;
  end if;
  if v_type not in ('INCOME', 'EXPENSE') then
    raise exception 'VALIDATION: type is INCOME or EXPENSE' using errcode = '22023';
  end if;
  select * into v_cat from public.platform_finance_categories where id = nullif(p ->> 'category_id', '')::uuid;
  if v_cat.id is null or v_cat.type <> v_type then
    raise exception 'VALIDATION: choose a % category', lower(v_type) using errcode = '22023';
  end if;
  if not v_cat.allow_manual or not v_cat.is_active then
    raise exception 'VALIDATION: % is filled automatically or switched off', v_cat.name using errcode = '22023';
  end if;
  if v_date is null or v_date > (now() at time zone 'Asia/Dhaka')::date or v_date < date '2020-01-01' then
    raise exception 'VALIDATION: choose the date (not in the future)' using errcode = '22023';
  end if;
  -- A foreign amount (e.g. USD ad spend) is converted at the given rate.
  if v_foreign is not null then
    if v_currency is null or v_currency !~ '^[A-Z]{3}$' or v_rate is null or v_rate <= 0 then
      raise exception 'VALIDATION: give the currency and the rate for a foreign amount' using errcode = '22023';
    end if;
    v_amount := round(v_foreign * v_rate, 2);
  else
    v_currency := null;
    v_rate := null;
  end if;
  if v_amount is null or v_amount <= 0 or v_amount > 1000000000 then
    raise exception 'VALIDATION: enter an amount above 0' using errcode = '22023';
  end if;

  if v_id is null then
    insert into public.platform_finance_entries (type, category_id, sub_category, txn_date, amount, foreign_amount, foreign_currency, exchange_rate,
      notes, reference, created_by, created_by_email)
    values (v_type, v_cat.id, nullif(left(trim(coalesce(p ->> 'sub_category', '')), 60), ''), v_date, round(v_amount, 2), v_foreign, v_currency, v_rate,
      nullif(left(trim(coalesce(p ->> 'notes', '')), 300), ''), nullif(left(trim(coalesce(p ->> 'reference', '')), 120), ''),
      auth.uid(), (select email from public.platform_staff where user_id = auth.uid()))
    returning * into e;
    perform public._platform_log('finance.entry_created', null, 'platform_finance_entry', e.id::text, e.notes, null, to_jsonb(e));
  else
    update public.platform_finance_entries set
      category_id = v_cat.id, sub_category = nullif(left(trim(coalesce(p ->> 'sub_category', '')), 60), ''), txn_date = v_date,
      amount = round(v_amount, 2), foreign_amount = v_foreign, foreign_currency = v_currency, exchange_rate = v_rate,
      notes = nullif(left(trim(coalesce(p ->> 'notes', '')), 300), ''), reference = nullif(left(trim(coalesce(p ->> 'reference', '')), 120), '')
    where id = v_id
    returning * into e;
    perform public._platform_log('finance.entry_updated', null, 'platform_finance_entry', e.id::text, nullif(p ->> 'reason', ''), to_jsonb(v_before), to_jsonb(e));
  end if;
  return to_jsonb(e);
end;
$$;

create or replace function public.platform_finance_entry_void(p_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e public.platform_finance_entries;
begin
  perform public._platform_require('finance', 'delete');
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'VALIDATION: say why the entry is deleted' using errcode = '22023';
  end if;
  select * into e from public.platform_finance_entries where id = p_id for update;
  if e.id is null then
    raise exception 'NOT_FOUND: entry not found' using errcode = 'P0002';
  end if;
  if e.source <> 'MANUAL' then
    raise exception 'VALIDATION: ad spend comes from the ad account; disconnect it there instead' using errcode = '22023';
  end if;
  if e.voided_at is not null then
    raise exception 'VALIDATION: this entry is already deleted' using errcode = '22023';
  end if;
  update public.platform_finance_entries set voided_at = now(), voided_by = auth.uid(), void_reason = left(trim(p_reason), 300)
  where id = p_id returning * into e;
  perform public._platform_log('finance.entry_deleted', null, 'platform_finance_entry', e.id::text, e.void_reason, null, to_jsonb(e));
  return to_jsonb(e);
end;
$$;

create or replace function public.platform_finance_category_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_before public.platform_finance_categories;
  c public.platform_finance_categories;
  v_subs text[];
begin
  perform public._platform_require('finance', 'manage');
  if p ? 'subcategories' then
    select coalesce(array_agg(distinct left(trim(s), 60)) filter (where trim(s) <> ''), '{}') into v_subs
    from jsonb_array_elements_text(p -> 'subcategories') s;
    if cardinality(v_subs) > 40 then
      raise exception 'VALIDATION: at most 40 sub categories' using errcode = '22023';
    end if;
  end if;
  if v_id is null then
    if coalesce(p ->> 'type', '') not in ('INCOME', 'EXPENSE') then
      raise exception 'VALIDATION: type is INCOME or EXPENSE' using errcode = '22023';
    end if;
    insert into public.platform_finance_categories (type, code, name, color, subcategories)
    values (p ->> 'type',
            left(coalesce(nullif(regexp_replace(upper(trim(coalesce(p ->> 'name', ''))), '[^A-Z0-9]+', '_', 'g'), ''), 'CATEGORY'), 32)
              || '_' || upper(substr(md5(random()::text), 1, 4)),
            trim(coalesce(p ->> 'name', '')), coalesce(nullif(p ->> 'color', ''), 'slate'), coalesce(v_subs, '{}'))
    returning * into c;
    -- Codes start with a letter.
    if c.code !~ '^[A-Z]' then
      update public.platform_finance_categories set code = 'C_' || left(code, 37) where id = c.id returning * into c;
    end if;
    perform public._platform_log('finance.category_created', null, 'platform_finance_category', c.id::text, null, null, to_jsonb(c));
  else
    select * into v_before from public.platform_finance_categories where id = v_id for update;
    if v_before.id is null then
      raise exception 'NOT_FOUND: category not found' using errcode = 'P0002';
    end if;
    if v_before.is_system and p ? 'is_active' and not (p ->> 'is_active')::boolean then
      raise exception 'VALIDATION: built-in categories stay on' using errcode = '22023';
    end if;
    update public.platform_finance_categories set
      name = coalesce(nullif(trim(p ->> 'name'), ''), name),
      color = coalesce(nullif(p ->> 'color', ''), color),
      subcategories = coalesce(v_subs, subcategories),
      is_active = coalesce((p ->> 'is_active')::boolean, is_active)
    where id = v_id returning * into c;
    perform public._platform_log('finance.category_updated', null, 'platform_finance_category', c.id::text, null, to_jsonb(v_before), to_jsonb(c));
  end if;
  return public._platform_finance_category_json(c);
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Fullfilio's own Meta ad accounts (connected through the platform-admin
--    function; the access token stays in Vault)
-- -----------------------------------------------------------------------------
create or replace function public._platform_ad_account_json(a public.platform_ad_accounts)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object('id', a.id, 'platform', a.platform, 'name', a.name, 'ad_account_id', a.ad_account_id, 'app_id', a.app_id,
    'usd_rate', a.usd_rate, 'is_active', a.is_active, 'account_name', a.account_name, 'currency', a.currency, 'timezone', a.timezone,
    'token_hint', a.token_hint, 'has_app_secret', a.has_app_secret, 'token_expires_at', a.token_expires_at, 'status', a.status,
    'last_error', a.last_error, 'last_sync_at', a.last_sync_at, 'last_sync_since', a.last_sync_since, 'last_sync_until', a.last_sync_until,
    'created_at', a.created_at,
    'spend_30d', coalesce((select sum(e.amount) from public.platform_finance_entries e
                           where e.ad_account_id = a.id and e.txn_date > (now() at time zone 'Asia/Dhaka')::date - 30), 0),
    'spend_30d_foreign', (select sum(e.foreign_amount) from public.platform_finance_entries e
                          where e.ad_account_id = a.id and e.txn_date > (now() at time zone 'Asia/Dhaka')::date - 30),
    'days', (select count(*) from public.platform_finance_entries e where e.ad_account_id = a.id))
$$;

create or replace function public.platform_ad_accounts_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._platform_require('finance', 'view');
  return jsonb_build_object(
    'accounts', coalesce((select jsonb_agg(public._platform_ad_account_json(a) order by a.is_active desc, a.created_at)
                          from public.platform_ad_accounts a), '[]'::jsonb),
    'can_manage', public.platform_can('finance', 'manage'));
end;
$$;

-- System only (the platform-admin function, after checking finance.manage).
create or replace function public.platform_ad_account_save(p jsonb, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_meta jsonb := p -> 'meta';
  a public.platform_ad_accounts;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if exists (select 1 from public.platform_ad_accounts where ad_account_id = p ->> 'ad_account_id' and id is distinct from v_id) then
    raise exception 'VALIDATION: this ad account is already connected' using errcode = '22023';
  end if;
  if v_id is null then
    insert into public.platform_ad_accounts (name, ad_account_id, app_id, usd_rate, is_active, created_by)
    values (trim(p ->> 'name'), p ->> 'ad_account_id', nullif(p ->> 'app_id', ''), (p ->> 'usd_rate')::numeric, coalesce((p ->> 'is_active')::boolean, true), p_actor)
    returning * into a;
  else
    update public.platform_ad_accounts set name = trim(p ->> 'name'), ad_account_id = p ->> 'ad_account_id', app_id = nullif(p ->> 'app_id', ''),
      usd_rate = (p ->> 'usd_rate')::numeric, is_active = coalesce((p ->> 'is_active')::boolean, true)
    where id = v_id returning * into a;
    if a.id is null then
      raise exception 'NOT_FOUND: ad account not found' using errcode = 'P0002';
    end if;
  end if;
  if v_meta is not null then
    update public.platform_ad_accounts set
      account_name = coalesce(v_meta ->> 'name', account_name), currency = coalesce(v_meta ->> 'currency', currency),
      timezone = coalesce(v_meta ->> 'timezone', timezone),
      token_hint = case when v_meta ? 'token_hint' then v_meta ->> 'token_hint' else token_hint end,
      has_app_secret = coalesce((v_meta ->> 'has_app_secret')::boolean, has_app_secret),
      token_expires_at = case when v_meta ? 'token_expires_at' then (v_meta ->> 'token_expires_at')::timestamptz else token_expires_at end,
      status = coalesce(v_meta ->> 'status', status), last_error = v_meta ->> 'error'
    where id = a.id returning * into a;
  end if;
  perform public.platform_record_action(p_actor, case when v_id is null then 'finance.ad_account_connected' else 'finance.ad_account_updated' end,
    'platform_ad_account', a.id::text, 'SUCCESS', jsonb_build_object('ad_account_id', a.ad_account_id, 'name', a.name, 'usd_rate', a.usd_rate));
  return public._platform_ad_account_json(a);
end;
$$;

create or replace function public.platform_ad_accounts_for_sync(p_id uuid default null)
returns setof public.platform_ad_accounts
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query select * from public.platform_ad_accounts a
    where (p_id is null and a.is_active) or a.id = p_id
    order by a.created_at;
end;
$$;

-- One expense per account and day. A day Meta later corrects is updated; a day
-- that drops to nothing is removed (only inside the window just synced).
create or replace function public.platform_ad_spend_apply(p_id uuid, p_since date, p_until date, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a public.platform_ad_accounts;
  v_cat uuid := (select id from public.platform_finance_categories where type = 'EXPENSE' and code = 'ADVERTISING');
  v_bdt boolean;
  r jsonb;
  v_spend numeric;
  v_day date;
  v_days int := 0;
  v_amount numeric := 0;
  v_foreign numeric := 0;
  v_seen date[] := '{}';
  v_kept date[] := '{}';
  v_removed int;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select * into a from public.platform_ad_accounts where id = p_id;
  if a.id is null then
    raise exception 'NOT_FOUND: ad account not found' using errcode = 'P0002';
  end if;
  if p_since is null or p_until is null or p_until < p_since or p_until - p_since > 92 then
    raise exception 'VALIDATION: bad sync window' using errcode = '22023';
  end if;
  v_bdt := upper(coalesce(a.currency, '')) = 'BDT';
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_day := (r ->> 'date')::date;
    v_spend := round(coalesce((r ->> 'spend')::numeric, 0), 2);
    if v_day < p_since or v_day > p_until or v_day = any (v_seen) then
      continue;
    end if;
    v_seen := v_seen || v_day;
    if v_spend <= 0 then
      continue;
    end if;
    insert into public.platform_finance_entries (type, category_id, sub_category, txn_date, amount, foreign_amount, foreign_currency, exchange_rate,
      notes, source, source_key, ad_account_id)
    values ('EXPENSE', v_cat, 'Meta', v_day,
      case when v_bdt then v_spend else round(v_spend * a.usd_rate, 2) end,
      case when v_bdt then null else v_spend end, case when v_bdt then null else coalesce(nullif(upper(a.currency), ''), 'USD') end,
      case when v_bdt then null else a.usd_rate end,
      'Meta ads · ' || a.name, 'META_ADS', 'meta:' || a.ad_account_id || ':' || v_day, a.id)
    on conflict (source_key) do update set
      amount = excluded.amount, foreign_amount = excluded.foreign_amount, foreign_currency = excluded.foreign_currency,
      exchange_rate = excluded.exchange_rate, notes = excluded.notes, ad_account_id = excluded.ad_account_id
    where (platform_finance_entries.amount, platform_finance_entries.foreign_amount, platform_finance_entries.exchange_rate, platform_finance_entries.notes)
      is distinct from (excluded.amount, excluded.foreign_amount, excluded.exchange_rate, excluded.notes);
    v_kept := v_kept || v_day;
    v_days := v_days + 1;
    v_amount := v_amount + case when v_bdt then v_spend else round(v_spend * a.usd_rate, 2) end;
    v_foreign := v_foreign + case when v_bdt then 0 else v_spend end;
  end loop;
  delete from public.platform_finance_entries e
  where e.ad_account_id = a.id and e.source = 'META_ADS' and e.txn_date between p_since and p_until
    and not (e.txn_date = any (v_kept));
  get diagnostics v_removed = row_count;
  return jsonb_build_object('days', v_days, 'amount', v_amount, 'foreign_amount', nullif(v_foreign, 0), 'removed', v_removed);
end;
$$;

create or replace function public.platform_ad_account_record_sync(p_id uuid, p_status text, p_error text, p_since date, p_until date)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.platform_ad_accounts set status = p_status, last_error = left(p_error, 500), last_sync_at = now(),
    last_sync_since = coalesce(p_since, last_sync_since), last_sync_until = coalesce(p_until, last_sync_until)
  where id = p_id;
end;
$$;

-- Stops syncing and forgets the token (the function clears Vault); spend already recorded stays.
create or replace function public.platform_ad_account_disconnect(p_id uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a public.platform_ad_accounts;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.platform_ad_accounts set is_active = false, status = 'DISCONNECTED', token_hint = null, has_app_secret = false,
    token_expires_at = null, last_error = null
  where id = p_id returning * into a;
  if a.id is null then
    raise exception 'NOT_FOUND: ad account not found' using errcode = 'P0002';
  end if;
  perform public.platform_record_action(p_actor, 'finance.ad_account_disconnected', 'platform_ad_account', a.id::text, 'SUCCESS',
    jsonb_build_object('ad_account_id', a.ad_account_id, 'name', a.name));
  return public._platform_ad_account_json(a);
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Grants, global tables, exemptions, schedule
-- -----------------------------------------------------------------------------
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
               'credit_types', 'credit_packages', 'platform_notifications', 'support_ticket_events', 'platform_cost_entries',
               'platform_incidents', 'platform_incident_merchants', 'platform_incident_updates', 'platform_announcements',
               'platform_announcement_deliveries', 'platform_announcement_reads', 'platform_automation_rules', 'platform_automation_runs',
               'platform_data_exports', 'merchant_deletion_requests', 'platform_restore_tests',
               'platform_contact_messages', 'account_removals', 'signup_requests',
               'platform_finance_categories', 'platform_finance_entries', 'platform_ad_accounts']
$$;

do $$
declare
  f text;
begin
  foreach f in array array['platform_finance_categories_list()', 'platform_finance_ledger(text,date,date)', 'platform_finance_entries(jsonb)',
    'platform_finance_overview(date,date)', 'platform_finance_entry_save(jsonb)', 'platform_finance_entry_void(uuid,text)',
    'platform_finance_category_save(jsonb)', 'platform_ad_accounts_list()']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['platform_ad_account_save(jsonb,uuid)', 'platform_ad_accounts_for_sync(uuid)', 'platform_ad_spend_apply(uuid,date,date,jsonb)',
    'platform_ad_account_record_sync(uuid,text,text,date,date)', 'platform_ad_account_disconnect(uuid,uuid)']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  foreach f in array array['_platform_finance_rows(date,date)', '_platform_finance_range(date,date)',
    '_platform_finance_category_json(public.platform_finance_categories)', '_platform_ad_account_json(public.platform_ad_accounts)']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;

insert into public.tenancy_exempt_functions (name, reason)
select f, 'Super Admin Income & Expenses: Fullfilio''s own books and money merchants paid the platform, permission-checked'
from unnest(array['_platform_finance_rows', '_platform_finance_range', '_platform_finance_category_json', '_platform_ad_account_json',
  'platform_finance_categories_list', 'platform_finance_ledger', 'platform_finance_entries', 'platform_finance_overview',
  'platform_finance_entry_save', 'platform_finance_entry_void', 'platform_finance_category_save', 'platform_ad_accounts_list',
  'platform_ad_account_save', 'platform_ad_accounts_for_sync', 'platform_ad_spend_apply', 'platform_ad_account_record_sync',
  'platform_ad_account_disconnect']) f
on conflict (name) do nothing;

-- Fullfilio's ad spend, every three hours (only while an account is connected).
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise notice 'pg_cron or pg_net missing: platform-ads-sync not scheduled';
    return;
  end if;
  perform cron.unschedule(jobid) from cron.job where jobname = 'platform-ads-sync';
  perform cron.schedule('platform-ads-sync', '27 */3 * * *', $job$
  select net.http_post(
    url := 'https://fullfilio.com/functions/v1/platform-admin',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{"action": "ad_spend_cron", "days": 3}'::jsonb,
    timeout_milliseconds := 120000)
  where exists (select 1 from public.platform_ad_accounts where is_active)
$job$);
end $$;

select public._tenancy_own_functions();
