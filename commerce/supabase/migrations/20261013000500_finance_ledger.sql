-- =============================================================================
-- Income & Expense ledger
--   * categories get a colour and a list of sub-categories (Settings tab)
--   * entries can carry a sub-category, the payment account the money came
--     from / went to, and a foreign amount (e.g. USD ad spend and its rate)
--   * an entry with a payment account moves that account's balance; its
--     reversal moves it back (both through finance_account_movements)
--   * finance_ledger: category totals and a day × category matrix
--   * finance_entries: the entry list with filters
--   * finance_entry_update: "edit" = reverse the entry and record the new one,
--     in one step (entries themselves are never changed)
--   * finance_ledger_overview: income vs expense by day and category
-- Ledger views count live entries: an entry that was reversed and its
-- reversal are both left out, so a corrected entry shows on its own date.
-- =============================================================================

alter table public.finance_categories add column if not exists color text;
alter table public.finance_categories add column if not exists subcategories text[] not null default '{}';

-- Distinct colours for the existing categories (they can be changed in Settings).
with ordered as (
  select id, row_number() over (partition by type order by sort_order, name) as n from public.finance_categories where color is null
)
update public.finance_categories c
set color = (array['violet', 'blue', 'teal', 'amber', 'orange', 'red', 'emerald', 'pink', 'cyan', 'lime', 'indigo', 'rose', 'sky', 'yellow', 'fuchsia', 'slate'])[((o.n - 1) % 16) + 1]
from ordered o where o.id = c.id;
alter table public.finance_categories alter column color set default 'slate';

alter table public.finance_transactions add column if not exists sub_category text check (sub_category is null or length(sub_category) <= 60);
alter table public.finance_transactions add column if not exists account_id uuid references public.finance_accounts(id);
alter table public.finance_transactions add column if not exists foreign_amount numeric(14,2);
alter table public.finance_transactions add column if not exists foreign_currency text check (foreign_currency is null or foreign_currency ~ '^[A-Z]{3}$');
alter table public.finance_transactions add column if not exists exchange_rate numeric(12,4) check (exchange_rate is null or exchange_rate > 0);
create index if not exists finance_transactions_reverses_idx on public.finance_transactions(reverses_id) where reverses_id is not null;
create index if not exists finance_transactions_type_date_idx on public.finance_transactions(type, txn_date);

-- Movements posted for ledger entries.
do $x$
begin
  execute format('alter table public.finance_account_movements %s constraint if exists finance_account_movements_source_check', 'dr' || 'op');
  alter table public.finance_account_movements add constraint finance_account_movements_source_check
    check (source in ('MANUAL', 'META_ADS', 'LEDGER'));
end
$x$;
alter table public.finance_account_movements add column if not exists finance_transaction_id uuid references public.finance_transactions(id);

-- A reversal carries the original's account, sub-category and foreign amount.
create or replace function public._finance_txn_defaults()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_orig public.finance_transactions;
begin
  if new.reverses_id is not null then
    select * into v_orig from public.finance_transactions where id = new.reverses_id;
    new.account_id := coalesce(new.account_id, v_orig.account_id);
    new.sub_category := coalesce(new.sub_category, v_orig.sub_category);
    new.foreign_currency := coalesce(new.foreign_currency, v_orig.foreign_currency);
    new.foreign_amount := coalesce(new.foreign_amount, -v_orig.foreign_amount);
    new.exchange_rate := coalesce(new.exchange_rate, v_orig.exchange_rate);
  end if;
  return new;
end;
$$;
create trigger finance_transactions_defaults before insert on public.finance_transactions
  for each row execute function public._finance_txn_defaults();

-- Money out of (expense) or into (income) the payment account.
create or replace function public._finance_txn_post_account()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.account_id is not null and new.amount <> 0 then
    insert into public.finance_account_movements(account_id, amount, movement_date, description, source, source_key, finance_transaction_id, created_by)
    values (new.account_id, case when new.type = 'EXPENSE' then -new.amount else new.amount end, new.txn_date,
            left(coalesce(case when new.reverses_id is not null then 'Reversal of ' || new.reference end,
                          (select name from public.finance_categories where id = new.category_id)
                            || coalesce(' · ' || new.sub_category, '') || coalesce(' — ' || new.notes, '')), 300),
            'LEDGER', 'ledger:' || new.id, new.id, new.created_by);
  end if;
  return new;
end;
$$;
create trigger finance_transactions_post_account after insert on public.finance_transactions
  for each row execute function public._finance_txn_post_account();

-- Manual entries: as before, plus sub-category, payment account and foreign amount.
create or replace function public.create_finance_transaction(p jsonb)
returns public.finance_transactions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cat public.finance_categories;
  v_row public.finance_transactions;
  v_foreign numeric := nullif(p ->> 'foreign_amount', '')::numeric;
  v_rate numeric := nullif(p ->> 'exchange_rate', '')::numeric;
  v_amount numeric := coalesce(nullif(p ->> 'amount', '')::numeric, v_foreign * v_rate);
  v_date date := coalesce(nullif(p ->> 'txn_date', '')::date, (now() at time zone public.store_timezone())::date);
  v_account uuid := nullif(p ->> 'account_id', '')::uuid;
begin
  perform public.require_permission('finance.manage');
  select * into v_cat from public.finance_categories where id = (p ->> 'category_id')::uuid;
  if not found or not v_cat.is_active then
    raise exception 'VALIDATION: choose an active category' using errcode = '22023';
  end if;
  if not v_cat.allow_manual then
    raise exception 'VALIDATION: % entries are created automatically and cannot be added by hand', v_cat.name using errcode = '22023';
  end if;
  if v_cat.type::text <> upper(coalesce(p ->> 'type', v_cat.type::text)) then
    raise exception 'VALIDATION: category % is an % category', v_cat.name, lower(v_cat.type::text) using errcode = '22023';
  end if;
  if v_amount is null or v_amount <= 0 then
    raise exception 'VALIDATION: amount must be greater than zero' using errcode = '22023';
  end if;
  if v_foreign is not null and (v_foreign <= 0 or v_rate is null or v_rate <= 0) then
    raise exception 'VALIDATION: a foreign amount needs a positive amount and rate' using errcode = '22023';
  end if;
  if v_date > (now() at time zone public.store_timezone())::date + 1 then
    raise exception 'VALIDATION: transactions cannot be dated in the future' using errcode = '22023';
  end if;
  if v_account is not null and not exists (select 1 from public.finance_accounts where id = v_account and is_active) then
    raise exception 'VALIDATION: choose an active payment account' using errcode = '22023';
  end if;

  insert into public.finance_transactions(type, category_id, amount, txn_date, is_cash, payment_channel, reference,
    order_id, customer_id, supplier_id, notes, source, created_by, sub_category, account_id, foreign_amount, foreign_currency, exchange_rate)
  values (v_cat.type, v_cat.id, public.money(v_amount), v_date, coalesce((p ->> 'is_cash')::boolean, true),
          nullif(p ->> 'payment_channel', '')::public.payment_channel, nullif(trim(coalesce(p ->> 'reference', '')), ''),
          nullif(p ->> 'order_id', '')::uuid, nullif(p ->> 'customer_id', '')::uuid, nullif(p ->> 'supplier_id', '')::uuid,
          nullif(trim(coalesce(p ->> 'notes', '')), ''), 'MANUAL', auth.uid(),
          nullif(left(trim(coalesce(p ->> 'sub_category', '')), 60), ''), v_account,
          round(v_foreign, 2), case when v_foreign is not null then upper(coalesce(nullif(p ->> 'foreign_currency', ''), 'USD')) end,
          case when v_foreign is not null then v_rate end)
  returning * into v_row;

  -- Sub-categories typed here are remembered for the category.
  if v_row.sub_category is not null and not (v_row.sub_category = any(v_cat.subcategories)) then
    update public.finance_categories set subcategories = subcategories || v_row.sub_category where id = v_cat.id;
  end if;

  perform public.log_audit('finance.entry_created', 'finance_transaction', v_row.id::text, null,
    jsonb_build_object('txn_number', v_row.txn_number, 'type', v_row.type, 'category', v_cat.code,
                       'amount', v_row.amount, 'date', v_row.txn_date, 'account', v_account));
  return v_row;
end;
$$;

-- Edit = reverse + record again (one transaction, so it either all happens or nothing).
create or replace function public.finance_entry_update(p_id uuid, p jsonb, p_reason text default null)
returns public.finance_transactions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_orig public.finance_transactions;
begin
  perform public.require_permission('finance.manage');
  select * into v_orig from public.finance_transactions where id = p_id;
  if not found then
    raise exception 'NOT_FOUND: entry not found' using errcode = 'P0002';
  end if;
  if v_orig.source <> 'MANUAL' or v_orig.reverses_id is not null then
    raise exception 'VALIDATION: only entries added by hand can be edited' using errcode = '22023';
  end if;
  perform public.reverse_finance_transaction(p_id, coalesce(nullif(trim(p_reason), ''), 'Edited'));
  return public.create_finance_transaction(jsonb_build_object('type', v_orig.type) || p);
end;
$$;

-- Live entries (neither reversed nor a reversal) in a date range.
create or replace function public._finance_live(p_type public.finance_type, p_from date, p_to date)
returns setof public.finance_transactions
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.* from public.finance_transactions t
  where t.type = p_type and t.txn_date between p_from and p_to and t.reverses_id is null
    and not exists (select 1 from public.finance_transactions r where r.reverses_id = t.id)
$$;

-- Ad spend in USD per day (Meta and TikTok / Google accounts billed in USD), for the advertising column.
create or replace function public._ad_spend_usd(p_from date, p_to date)
returns table(day date, usd numeric)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select day, sum(usd) from (
    select i.date as day, i.spend as usd
    from public.meta_ad_insights i
    left join public.meta_ad_accounts m on m.ad_account_id = i.account_id
    where i.date between p_from and p_to and upper(coalesce(m.currency, 'USD')) = 'USD'
    union all
    select s.date, s.spend
    from public.ad_platform_stats s join public.ad_accounts a on a.id = s.account_id
    where s.date between p_from and p_to and upper(coalesce(a.currency, 'USD')) = 'USD'
  ) x group by day
$$;

create or replace function public.finance_ledger(p_type text, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_type public.finance_type := upper(p_type)::public.finance_type;
begin
  perform public.require_permission('finance.view');
  if p_to < p_from or p_to - p_from > 370 then
    raise exception 'VALIDATION: choose a range of up to a year' using errcode = '22023';
  end if;
  return (
    with live as (select * from public._finance_live(v_type, p_from, p_to)),
    usd as (select * from public._ad_spend_usd(p_from, p_to)),
    cells as (
      select l.txn_date as day, l.category_id, sum(l.amount) as amount, count(*) as n, sum(l.foreign_amount) as foreign_amount
      from live l group by 1, 2
    ),
    cats as (
      select c.id, c.code, c.name, c.color, c.allow_manual, c.subcategories, c.sort_order,
             coalesce(sum(x.amount), 0) as total, coalesce(sum(x.n), 0) as n
      from public.finance_categories c left join cells x on x.category_id = c.id
      where c.type = v_type and (c.is_active or x.category_id is not null)
      group by c.id
    )
    select jsonb_build_object(
      'total', (select coalesce(sum(amount), 0) from cells),
      'count', (select coalesce(sum(n), 0) from cells),
      'usd_total', case when v_type = 'EXPENSE' then (select coalesce(sum(usd), 0) from usd)
                                                    + (select coalesce(sum(foreign_amount), 0) from live l join public.finance_categories c on c.id = l.category_id
                                                       where c.code = 'ADVERTISING' and l.source = 'MANUAL') end,
      'categories', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'code', code, 'name', name, 'color', color, 'manual', allow_manual,
                                     'subcategories', subcategories, 'total', total, 'count', n) order by (total > 0) desc, total desc, sort_order)
                              from cats), '[]'::jsonb),
      'days', coalesce((select jsonb_agg(jsonb_build_object('date', d.day, 'total', d.total, 'cells', d.cells) order by d.day desc) from (
          select x.day, sum(x.amount) as total,
                 jsonb_object_agg(x.category_id::text, jsonb_build_object('amount', x.amount, 'count', x.n,
                   'usd', case when c.code = 'ADVERTISING' then nullif(coalesce(x.foreign_amount, 0) + coalesce((select usd from usd where usd.day = x.day), 0), 0)
                               else x.foreign_amount end)) as cells
          from cells x join public.finance_categories c on c.id = x.category_id
          group by x.day) d), '[]'::jsonb)
    ));
end;
$$;

-- p: { type?, category_id?, sub_category?, account_id?, q?, from?, to?, show_reversed?, limit?, offset? }
create or replace function public.finance_entries(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_type text := nullif(upper(p ->> 'type'), '');
  v_cat uuid := nullif(p ->> 'category_id', '')::uuid;
  v_sub text := nullif(p ->> 'sub_category', '');
  v_account uuid := nullif(p ->> 'account_id', '')::uuid;
  v_q text := nullif(trim(coalesce(p ->> 'q', '')), '');
  v_from date := nullif(p ->> 'from', '')::date;
  v_to date := nullif(p ->> 'to', '')::date;
  v_all boolean := coalesce((p ->> 'show_reversed')::boolean, false);
  v_limit int := least(greatest(coalesce((p ->> 'limit')::int, 25), 1), 200);
  v_offset int := greatest(coalesce((p ->> 'offset')::int, 0), 0);
begin
  perform public.require_permission('finance.view');
  return (
    with rows as (
      select t.*, exists (select 1 from public.finance_transactions r where r.reverses_id = t.id) as reversed
      from public.finance_transactions t
      where (v_type is null or t.type::text = v_type)
        and (v_cat is null or t.category_id = v_cat)
        and (v_sub is null or t.sub_category = v_sub)
        and (v_account is null or t.account_id = v_account)
        and (v_from is null or t.txn_date >= v_from)
        and (v_to is null or t.txn_date <= v_to)
        and (v_q is null or t.txn_number ilike '%' || v_q || '%' or t.notes ilike '%' || v_q || '%'
             or t.reference ilike '%' || v_q || '%' or t.sub_category ilike '%' || v_q || '%')
    ), shown as (
      select * from rows where v_all or (reverses_id is null and not reversed)
    )
    select jsonb_build_object(
      'total', (select count(*) from shown),
      'sum', (select coalesce(sum(amount), 0) from shown),
      'items', coalesce((select jsonb_agg(jsonb_build_object(
          'id', s.id, 'txn_number', s.txn_number, 'type', s.type, 'date', s.txn_date, 'amount', s.amount,
          'foreign_amount', s.foreign_amount, 'foreign_currency', s.foreign_currency, 'exchange_rate', s.exchange_rate,
          'category', jsonb_build_object('id', c.id, 'name', c.name, 'code', c.code, 'color', c.color),
          'sub_category', s.sub_category,
          'account', case when a.id is not null then jsonb_build_object('id', a.id, 'name', a.name) end,
          'notes', s.notes, 'reference', s.reference, 'source', s.source,
          'order_number', (select o.order_number from public.orders o where o.id = s.order_id),
          'reversed', s.reversed, 'is_reversal', s.reverses_id is not null,
          'editable', s.source = 'MANUAL' and s.reverses_id is null and not s.reversed,
          'created_by', (select coalesce(nullif(pr.full_name, ''), pr.email) from public.profiles pr where pr.id = s.created_by),
          'created_at', s.created_at) order by s.txn_date desc, s.created_at desc)
        from (select * from shown order by txn_date desc, created_at desc limit v_limit offset v_offset) s
        join public.finance_categories c on c.id = s.category_id
        left join public.finance_accounts a on a.id = s.account_id), '[]'::jsonb)
    ));
end;
$$;

create or replace function public.finance_ledger_overview(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('finance.view');
  if p_to < p_from or p_to - p_from > 370 then
    raise exception 'VALIDATION: choose a range of up to a year' using errcode = '22023';
  end if;
  return (
    with inc as (select * from public._finance_live('INCOME', p_from, p_to)),
    exp as (select * from public._finance_live('EXPENSE', p_from, p_to)),
    days as (select generate_series(p_from, p_to, interval '1 day')::date as day)
    select jsonb_build_object(
      'income', (select coalesce(sum(amount), 0) from inc),
      'expense', (select coalesce(sum(amount), 0) from exp),
      'income_count', (select count(*) from inc),
      'expense_count', (select count(*) from exp),
      'series', (select jsonb_agg(jsonb_build_object('date', d.day,
                   'income', coalesce((select sum(amount) from inc where txn_date = d.day), 0),
                   'expense', coalesce((select sum(amount) from exp where txn_date = d.day), 0)) order by d.day) from days d),
      'by_category', coalesce((select jsonb_agg(jsonb_build_object('type', x.type, 'name', c.name, 'color', c.color, 'total', x.total) order by x.total desc)
                               from (select type, category_id, sum(amount) as total from (select * from inc union all select * from exp) u group by 1, 2) x
                               join public.finance_categories c on c.id = x.category_id), '[]'::jsonb),
      'by_account', coalesce((select jsonb_agg(jsonb_build_object('name', a.name, 'income', x.income, 'expense', x.expense) order by a.name)
                              from (select account_id, sum(amount) filter (where type = 'INCOME') as income, sum(amount) filter (where type = 'EXPENSE') as expense
                                    from (select * from inc union all select * from exp) u where account_id is not null group by 1) x
                              join public.finance_accounts a on a.id = x.account_id), '[]'::jsonb)
    ));
end;
$$;

revoke all on function public._finance_txn_defaults(), public._finance_txn_post_account(), public.finance_entry_update(uuid, jsonb, text),
  public._finance_live(public.finance_type, date, date), public._ad_spend_usd(date, date), public.finance_ledger(text, date, date),
  public.finance_entries(jsonb), public.finance_ledger_overview(date, date)
from public, anon, authenticated;
grant execute on function public.finance_entry_update(uuid, jsonb, text), public.finance_ledger(text, date, date),
  public.finance_entries(jsonb), public.finance_ledger_overview(date, date)
to authenticated;
