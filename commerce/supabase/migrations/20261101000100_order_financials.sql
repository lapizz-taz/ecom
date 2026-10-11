-- Order financials: the profit & loss of orders, by channel and product, read from the ledger.
--
-- Every amount comes from finance_transactions, the same ledger the profit & loss statement
-- reads, so with the "delivered" basis the totals equal report_profit_loss for the same dates.
-- Nothing here guesses a number: an item sold without a product cost shows as missing (not as
-- zero cost), courier charges say whether the courier confirmed them, and ad spend is only what
-- a connected ad account (or a manual entry) put in the ledger.
--
-- Two staff actions, both append-only:
--   finance_recalculate_orders  posts the delivery entries a delivered order is missing
--                               (idempotent: every entry has a unique source key).
--   finance_rebuild_cost        fills product costs that were missing when an order was
--                               delivered with today's cost, and posts the difference as new
--                               COGS entries. Existing costs and ledger rows are never changed.

-- -----------------------------------------------------------------------------
-- Ledger rows of a period, with the line of the report each belongs to.
-- basis: delivered = ledger date (accrual, like the statement); approved / created = order-linked
-- rows of orders approved / created in the period, plus rows without an order dated in it.
-- -----------------------------------------------------------------------------
create or replace function public._fin_line(p_code text, p_group text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_group = 'REVENUE' then 'product_sales'
    when p_group = 'DELIVERY_INCOME' then 'delivery_income'
    when p_code = 'RETAINED_ADVANCES' then 'return_charges'
    when p_group = 'OTHER_INCOME' then 'other_income'
    when p_group = 'CONTRA_REVENUE' then 'refunds'
    when p_group = 'COGS' then 'product_cost'
    when p_code in ('COURIER', 'COD_FEES', 'RETURNS') then 'delivery_cost'
    when p_code = 'ADVERTISING' then 'ads'
    when p_group = 'OPERATING_EXPENSE' then 'other_expense'
  end
$$;

create or replace function public._fin_rows(p_from date, p_to date, p_basis text)
returns table (id uuid, order_id uuid, code text, name text, grp text, line text, amount numeric, day date)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select ft.id, ft.order_id, c.code, c.name, c.pnl_group::text, public._fin_line(c.code, c.pnl_group::text), ft.amount,
         case when p_basis = 'delivered' or ft.order_id is null then ft.txn_date
              when p_basis = 'approved' then (o.confirmed_at at time zone public.store_timezone())::date
              else (o.created_at at time zone public.store_timezone())::date end
  from public.finance_transactions ft
  join public.finance_categories c on c.id = ft.category_id
  left join public.orders o on o.id = ft.order_id
  where c.pnl_group <> 'NONE'
    and case
      when p_basis = 'delivered' or ft.order_id is null then ft.txn_date between p_from and p_to
      when p_basis = 'approved' then (o.confirmed_at at time zone public.store_timezone())::date between p_from and p_to
      else (o.created_at at time zone public.store_timezone())::date between p_from and p_to
    end
$$;
revoke all on function public._fin_rows(date, date, text) from public, anon, authenticated;

create or replace function public._fin_check_args(p_from date, p_to date, p_basis text)
returns void
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'VALIDATION: choose a valid date range' using errcode = '22023';
  end if;
  if p_to - p_from > 1100 then
    raise exception 'VALIDATION: choose at most three years' using errcode = '22023';
  end if;
  if coalesce(p_basis, '') not in ('delivered', 'approved', 'created') then
    raise exception 'VALIDATION: basis must be delivered, approved or created' using errcode = '22023';
  end if;
end;
$$;

-- Channel of an order: the connected store it came from, else how it was placed.
create or replace function public._fin_channel(p_channel_id uuid, p_source text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when p_channel_id is not null then (
      select jsonb_build_object('key', sc.id::text, 'name', coalesce(nullif(sc.name, ''), initcap(sc.platform::text)), 'platform', sc.platform::text, 'synced', true)
      from public.sales_channels sc where sc.id = p_channel_id)
    else jsonb_build_object('key', 'source:' || coalesce(p_source, 'ADMIN'),
      'name', case p_source when 'STOREFRONT' then 'Website' when 'API' then 'Custom website (API)' when 'IMPORT' then 'Imported'
                            else 'Manual / phone' end,
      'platform', 'OWN', 'synced', false)
  end
$$;
revoke all on function public._fin_channel(uuid, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- The report
-- -----------------------------------------------------------------------------
create or replace function public.report_order_financials(p_from date, p_to date, p_basis text default 'delivered')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_totals jsonb;
  v_counts jsonb;
  v_stats jsonb;
  v_quality jsonb;
  v_channels jsonb;
  v_unallocated jsonb;
  v_products jsonb;
  v_categories jsonb;
  v_daily jsonb;
  v_sold uuid[];
begin
  perform public.require_permission('finance.view');
  perform public._fin_check_args(p_from, p_to, p_basis);

  if to_regclass('pg_temp._fin') is null then
    create temporary table _fin on commit drop as select * from public._fin_rows(p_from, p_to, p_basis) limit 0;
  else
    truncate _fin;
  end if;
  insert into _fin select * from public._fin_rows(p_from, p_to, p_basis);

  -- Orders whose sale is recognised in the period.
  select coalesce(array_agg(order_id), '{}') into v_sold from (
    select order_id from _fin where line = 'product_sales' and order_id is not null group by order_id having sum(amount) > 0) s;

  -- Totals and what each line is made of (orders, plus entries without an order).
  with l as (
    select line, sum(amount) as amount,
           -- orders, plus entries that belong to no order (rent, a courier claim …)
           count(distinct order_id) + count(*) filter (where order_id is null) as orders
    from _fin where line is not null group by line
  ), t as (
    select coalesce(jsonb_object_agg(line, amount), '{}'::jsonb) as a, coalesce(jsonb_object_agg(line, orders), '{}'::jsonb) as n from l
  )
  select t.a, t.n into v_totals, v_counts from t;

  v_totals := (select jsonb_build_object(
      'product_sales', ps, 'delivery_income', di, 'sales', ps + di,
      'return_charges', rc, 'other_income', oi, 'refunds', rf,
      'product_cost', pc, 'delivery_cost', dc, 'ads', ad, 'other_expense', oe,
      'total_expense', rf + pc + dc + ad + oe,
      'profit', ps + di + rc + oi - rf - pc - dc - ad - oe,
      'margin_pct', case when ps + di - rf > 0 then round(100 * (ps + di + rc + oi - rf - pc - dc - ad - oe) / (ps + di - rf), 2) end,
      'orders', cardinality(v_sold),
      'profit_per_order', case when cardinality(v_sold) > 0 then round((ps + di + rc + oi - rf - pc - dc - ad - oe) / cardinality(v_sold), 2) end,
      'sales_per_order', case when cardinality(v_sold) > 0 then round((ps + di) / cardinality(v_sold), 2) end)
    from (select coalesce((v_totals ->> 'product_sales')::numeric, 0) ps, coalesce((v_totals ->> 'delivery_income')::numeric, 0) di,
                 coalesce((v_totals ->> 'return_charges')::numeric, 0) rc, coalesce((v_totals ->> 'other_income')::numeric, 0) oi,
                 coalesce((v_totals ->> 'refunds')::numeric, 0) rf, coalesce((v_totals ->> 'product_cost')::numeric, 0) pc,
                 coalesce((v_totals ->> 'delivery_cost')::numeric, 0) dc, coalesce((v_totals ->> 'ads')::numeric, 0) ad,
                 coalesce((v_totals ->> 'other_expense')::numeric, 0) oe) x);

  -- Order pipeline of the period (approved date, or created date for the "created" basis).
  select jsonb_build_object(
      'basis', case when p_basis = 'created' then 'created' else 'approved' end,
      'total', count(*),
      'delivered', count(*) filter (where o.status in ('DELIVERED', 'PARTIALLY_DELIVERED')),
      'returned', count(*) filter (where o.status in ('RETURN_REQUESTED', 'RETURNING', 'RETURNED', 'FAILED_DELIVERY', 'LOST')),
      'cancelled', count(*) filter (where o.status in ('CANCELLED', 'REJECTED_FRAUD', 'PENDING_CANCEL')),
      'pending', count(*) filter (where o.status not in ('DELIVERED', 'PARTIALLY_DELIVERED', 'RETURN_REQUESTED', 'RETURNING', 'RETURNED',
                                                         'FAILED_DELIVERY', 'LOST', 'CANCELLED', 'REJECTED_FRAUD', 'PENDING_CANCEL')),
      'delivered_pct', case when count(*) filter (where o.status not in ('CANCELLED', 'REJECTED_FRAUD', 'PENDING_CANCEL')) > 0
        then round(100.0 * count(*) filter (where o.status in ('DELIVERED', 'PARTIALLY_DELIVERED'))
                   / count(*) filter (where o.status not in ('CANCELLED', 'REJECTED_FRAUD', 'PENDING_CANCEL')), 1) end)
  into v_stats
  from public.orders o
  where case when p_basis = 'created' then (o.created_at at time zone public.store_timezone())::date
             else (o.confirmed_at at time zone public.store_timezone())::date end between p_from and p_to;

  -- How sure each number is.
  select jsonb_build_object(
      'missing_cost_orders', (select count(distinct oi.order_id) from public.order_items oi
                              where oi.order_id = any(v_sold) and oi.quantity > 0 and coalesce(oi.unit_cost, 0) = 0),
      'missing_cost_items', (select count(*) from public.order_items oi
                             where oi.order_id = any(v_sold) and oi.quantity > 0 and coalesce(oi.unit_cost, 0) = 0),
      'missing_cost_fixable', (select count(*) from public.order_items oi
                               where oi.order_id = any(v_sold) and oi.quantity > 0 and coalesce(oi.unit_cost, 0) = 0
                                 and oi.variant_id is not null and public.variant_cost(oi.variant_id) > 0),
      'delivery_cost_estimated', coalesce((select sum(f.amount) from _fin f join public.shipment_charges sc on sc.finance_transaction_id = f.id
                                           where f.line = 'delivery_cost' and sc.source = 'ESTIMATE'), 0),
      'delivery_cost_confirmed', coalesce((select sum(f.amount) from _fin f
                                           where f.line = 'delivery_cost' and not exists (select 1 from public.shipment_charges sc
                                             where sc.finance_transaction_id = f.id and sc.source = 'ESTIMATE')), 0),
      -- Delivered in the period but never posted to the ledger: "Recalculate" posts them.
      'unposted_delivered', (select count(*) from public.orders o
                             where o.status in ('DELIVERED', 'PARTIALLY_DELIVERED') and o.delivered_at is not null
                               and (o.delivered_at at time zone public.store_timezone())::date between p_from and p_to
                               and not exists (select 1 from public.finance_transactions ft where ft.source_key = 'order:' || o.id || ':product_revenue')),
      'sold_without_delivery_cost', (select count(*) from unnest(v_sold) s(id)
                                     where not exists (select 1 from _fin f where f.order_id = s.id and f.line = 'delivery_cost')),
      'synced_sales', coalesce((select sum(f.amount) from _fin f join public.orders o on o.id = f.order_id
                                where f.line in ('product_sales', 'delivery_income') and o.sales_channel_id is not null), 0),
      'synced_orders', (select count(*) from public.orders o where o.id = any(v_sold) and o.sales_channel_id is not null),
      'ads', jsonb_build_object(
        'accounts', (select count(*) from public.meta_ad_accounts where is_active)
                    + (select count(*) from public.ad_accounts where is_selected),
        'last_sync_at', greatest((select max(last_sync_at) from public.meta_ad_accounts where is_active),
                                 (select max(last_sync_at) from public.ad_accounts where is_selected)),
        'entries', (select count(*) from _fin where line = 'ads'),
        'status', case
          when (select count(*) from public.meta_ad_accounts where is_active) + (select count(*) from public.ad_accounts where is_selected) > 0 then 'synced'
          when exists (select 1 from _fin where line = 'ads') then 'manual'
          else 'unavailable' end))
  into v_quality;

  -- Profit by channel (order-linked lines; ads and overheads are shown apart, not spread).
  with o as (
    select f.order_id, public._fin_channel(ord.sales_channel_id, ord.source::text) as ch,
           sum(f.amount) filter (where f.line in ('product_sales', 'delivery_income')) as sales,
           sum(f.amount) filter (where f.line = 'return_charges') as return_charges,
           sum(f.amount) filter (where f.line = 'other_income') as other_income,
           sum(f.amount) filter (where f.line = 'refunds') as refunds,
           sum(f.amount) filter (where f.line = 'product_cost') as product_cost,
           sum(f.amount) filter (where f.line = 'delivery_cost') as delivery_cost,
           sum(f.amount) filter (where f.line in ('ads', 'other_expense')) as other_cost
    from _fin f join public.orders ord on ord.id = f.order_id
    where f.line is not null
    group by f.order_id, ord.sales_channel_id, ord.source
  ), c as (
    select ch ->> 'key' as key, min(ch ->> 'name') as name, min(ch ->> 'platform') as platform, bool_or((ch ->> 'synced')::boolean) as synced,
           count(*) filter (where order_id = any(v_sold)) as orders,
           coalesce(sum(sales), 0) as sales, coalesce(sum(return_charges), 0) + coalesce(sum(other_income), 0) as other_income,
           coalesce(sum(refunds), 0) as refunds, coalesce(sum(product_cost), 0) as product_cost,
           coalesce(sum(delivery_cost), 0) as delivery_cost, coalesce(sum(other_cost), 0) as other_cost,
           count(*) filter (where order_id = any(v_sold) and exists (select 1 from public.order_items oi
                            where oi.order_id = o.order_id and oi.quantity > 0 and coalesce(oi.unit_cost, 0) = 0)) as missing_cost_orders
    from o group by ch ->> 'key'
  )
  select coalesce(jsonb_agg(jsonb_build_object('key', key, 'name', name, 'platform', platform, 'synced', synced, 'orders', orders,
      'sales', sales, 'other_income', other_income, 'refunds', refunds, 'product_cost', product_cost, 'delivery_cost', delivery_cost,
      'other_cost', other_cost, 'profit', sales + other_income - refunds - product_cost - delivery_cost - other_cost,
      'margin_pct', case when sales - refunds > 0 then round(100 * (sales + other_income - refunds - product_cost - delivery_cost - other_cost) / (sales - refunds), 2) end,
      'missing_cost_orders', missing_cost_orders) order by sales desc), '[]'::jsonb)
  into v_channels from c;

  select jsonb_build_object(
      'ads', coalesce(sum(amount) filter (where line = 'ads'), 0),
      'other_expense', coalesce(sum(amount) filter (where line = 'other_expense'), 0),
      'other_income', coalesce(sum(amount) filter (where line in ('other_income', 'return_charges')), 0),
      'refunds', coalesce(sum(amount) filter (where line = 'refunds'), 0))
  into v_unallocated from _fin where order_id is null;

  -- Products of the orders sold in the period (net of returned units).
  with i as (
    select oi.product_id, min(oi.product_name) as name,
           sum(oi.quantity - coalesce(oi.returned_quantity, 0)) as quantity,
           sum(round(oi.line_total * (oi.quantity - coalesce(oi.returned_quantity, 0)) / nullif(oi.quantity, 0), 2)) as sales,
           sum(coalesce(oi.unit_cost, 0) * (oi.quantity - coalesce(oi.returned_quantity, 0))) as cost,
           count(*) filter (where coalesce(oi.unit_cost, 0) = 0) as missing_cost_lines
    from public.order_items oi
    where oi.order_id = any(v_sold) and oi.quantity > 0
    group by oi.product_id, case when oi.product_id is null then oi.product_name end
  )
  select jsonb_build_object('count', count(*), 'rows', coalesce(jsonb_agg(jsonb_build_object('product_id', product_id, 'name', name,
      'quantity', quantity, 'sales', sales, 'cost', cost, 'profit', sales - cost, 'missing_cost', missing_cost_lines > 0)
      order by sales desc) filter (where rn <= 50), '[]'::jsonb))
  into v_products
  from (select *, row_number() over (order by sales desc) rn from i) x;

  select coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'group', grp, 'line', line, 'amount', amount, 'orders', orders)
      order by line, amount desc), '[]'::jsonb)
  into v_categories
  from (select code, min(name) as name, min(grp) as grp, min(line) as line, sum(amount) as amount, count(distinct order_id) as orders
        from _fin where line is not null group by code) x;

  select coalesce(jsonb_agg(jsonb_build_object('day', day, 'sales', sales, 'income', income, 'product_cost', pc, 'delivery_cost', dc,
      'ads', ad, 'other_expense', oe, 'refunds', rf, 'profit', sales + income - rf - pc - dc - ad - oe, 'orders', orders) order by day), '[]'::jsonb)
  into v_daily
  from (select day,
          coalesce(sum(amount) filter (where line in ('product_sales', 'delivery_income')), 0) as sales,
          coalesce(sum(amount) filter (where line in ('return_charges', 'other_income')), 0) as income,
          coalesce(sum(amount) filter (where line = 'refunds'), 0) as rf,
          coalesce(sum(amount) filter (where line = 'product_cost'), 0) as pc,
          coalesce(sum(amount) filter (where line = 'delivery_cost'), 0) as dc,
          coalesce(sum(amount) filter (where line = 'ads'), 0) as ad,
          coalesce(sum(amount) filter (where line = 'other_expense'), 0) as oe,
          count(distinct order_id) filter (where line = 'product_sales') as orders
        from _fin where line is not null group by day) d;

  return jsonb_build_object('from', p_from, 'to', p_to, 'basis', p_basis, 'totals', v_totals, 'counts', v_counts, 'stats', v_stats,
    'quality', v_quality, 'channels', v_channels, 'unallocated', v_unallocated, 'products', v_products,
    'categories', v_categories, 'daily', v_daily);
end;
$$;

-- One row per order sold in the period.
create or replace function public.report_order_financials_orders(
  p_from date, p_to date, p_basis text default 'delivered', p_search text default null,
  p_missing_cost boolean default false, p_limit int default 50, p_offset int default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb;
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
begin
  perform public.require_permission('finance.view');
  perform public._fin_check_args(p_from, p_to, p_basis);
  with f as (
    select * from public._fin_rows(p_from, p_to, p_basis) where order_id is not null and line is not null
  ), o as (
    select f.order_id,
           sum(f.amount) filter (where f.line in ('product_sales', 'delivery_income')) as sales,
           sum(f.amount) filter (where f.line in ('return_charges', 'other_income')) as income,
           sum(f.amount) filter (where f.line = 'refunds') as refunds,
           sum(f.amount) filter (where f.line = 'product_cost') as product_cost,
           sum(f.amount) filter (where f.line = 'delivery_cost') as delivery_cost,
           sum(f.amount) filter (where f.line in ('ads', 'other_expense')) as other_cost,
           bool_or(f.line = 'delivery_cost' and exists (select 1 from public.shipment_charges sc where sc.finance_transaction_id = f.id and sc.source = 'ESTIMATE')) as estimated,
           min(f.day) filter (where f.line = 'product_sales') as day
    from f group by f.order_id
    having coalesce(sum(f.amount) filter (where f.line = 'product_sales'), 0) > 0
  ), r as (
    select o.*, ord.order_number, ord.status, ord.customer_name, ord.customer_phone,
           public._fin_channel(ord.sales_channel_id, ord.source::text) as ch,
           exists (select 1 from public.order_items oi where oi.order_id = o.order_id and oi.quantity > 0 and coalesce(oi.unit_cost, 0) = 0) as missing_cost
    from o join public.orders ord on ord.id = o.order_id
    where (v_search is null or ord.order_number ilike '%' || v_search || '%' or ord.customer_phone ilike '%' || v_search || '%'
           or ord.customer_name ilike '%' || v_search || '%')
  )
  select jsonb_build_object(
    'total', (select count(*) from r where not p_missing_cost or missing_cost),
    'rows', coalesce((select jsonb_agg(jsonb_build_object('order_id', order_id, 'order_number', order_number, 'status', status, 'day', day,
        'customer', customer_name, 'phone', customer_phone, 'channel', ch ->> 'name', 'platform', ch ->> 'platform',
        'sales', coalesce(sales, 0), 'income', coalesce(income, 0), 'refunds', coalesce(refunds, 0),
        'product_cost', coalesce(product_cost, 0), 'delivery_cost', coalesce(delivery_cost, 0), 'other_cost', coalesce(other_cost, 0),
        'delivery_estimated', coalesce(estimated, false), 'missing_cost', missing_cost,
        'profit', coalesce(sales, 0) + coalesce(income, 0) - coalesce(refunds, 0) - coalesce(product_cost, 0) - coalesce(delivery_cost, 0) - coalesce(other_cost, 0))
        order by day desc, order_number desc)
      from (select * from r where not p_missing_cost or missing_cost order by day desc, order_number desc
            limit greatest(1, least(coalesce(p_limit, 50), 200)) offset greatest(coalesce(p_offset, 0), 0)) page), '[]'::jsonb))
  into v;
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- Staff actions
-- -----------------------------------------------------------------------------

-- Posts the revenue / cost entries a delivered order is missing (for example an order delivered
-- before a setting was on, or one whose posting failed). Entries already there are left alone.
create or replace function public.finance_recalculate_orders(p_from date, p_to date)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before int;
  v_after int;
  v_orders int := 0;
  r record;
begin
  perform public.require_permission('finance.manage');
  perform public._fin_check_args(p_from, p_to, 'delivered');
  select count(*) into v_before from public.finance_transactions;
  for r in
    select o.id from public.orders o
    where o.status in ('DELIVERED', 'PARTIALLY_DELIVERED') and o.delivered_at is not null
      and (o.delivered_at at time zone public.store_timezone())::date between p_from and p_to
      and not exists (select 1 from public.finance_transactions ft where ft.source_key = 'order:' || o.id || ':product_revenue')
    order by o.delivered_at
    for update of o
  loop
    perform public._post_order_delivery_finance(r.id);
    v_orders := v_orders + 1;
  end loop;
  select count(*) into v_after from public.finance_transactions;
  perform public.log_audit('finance.recalculate_orders', 'finance', null, null,
    jsonb_build_object('from', p_from, 'to', p_to, 'orders', v_orders, 'entries', v_after - v_before));
  return jsonb_build_object('orders', v_orders, 'entries', v_after - v_before);
end;
$$;

-- Product cost that was missing (0) when an order was delivered, filled from today's cost.
-- p_apply = false only previews. Applying sets the item's cost and posts the difference as a
-- COGS entry dated on the delivery day, one per item (its source key makes a second run a no-op).
create or replace function public.finance_rebuild_cost(p_from date, p_to date, p_apply boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows jsonb;
  v_items int;
  v_orders int;
  v_amount numeric;
  v_unknown int;
  v_posted int := 0;
  v_txn public.finance_transactions;
  r record;
begin
  perform public.require_permission(case when p_apply then 'finance.manage' else 'finance.view' end);
  perform public._fin_check_args(p_from, p_to, 'delivered');

  if to_regclass('pg_temp._rebuild') is null then
    create temporary table _rebuild (item_id uuid, order_id uuid, order_number text, product text, quantity int,
      new_cost numeric, amount numeric, day date) on commit drop;
  else
    truncate _rebuild;
  end if;
  insert into _rebuild
  select oi.id, o.id, o.order_number, oi.product_name || coalesce(' - ' || nullif(oi.variant_title, 'Default Title'), ''), oi.quantity,
         public.variant_cost(oi.variant_id), public.money(public.variant_cost(oi.variant_id) * oi.quantity),
         (o.delivered_at at time zone public.store_timezone())::date
  from public.order_items oi join public.orders o on o.id = oi.order_id
  where o.status in ('DELIVERED', 'PARTIALLY_DELIVERED') and o.delivered_at is not null
    and (o.delivered_at at time zone public.store_timezone())::date between p_from and p_to
    and oi.quantity > 0 and coalesce(oi.unit_cost, 0) = 0
    and oi.variant_id is not null and public.variant_cost(oi.variant_id) > 0
    and exists (select 1 from public.finance_transactions ft where ft.source_key = 'order:' || o.id || ':product_revenue');

  select count(*), count(distinct order_id), coalesce(sum(amount), 0) into v_items, v_orders, v_amount from _rebuild;
  select count(*) into v_unknown
  from public.order_items oi join public.orders o on o.id = oi.order_id
  where o.status in ('DELIVERED', 'PARTIALLY_DELIVERED') and o.delivered_at is not null
    and (o.delivered_at at time zone public.store_timezone())::date between p_from and p_to
    and oi.quantity > 0 and coalesce(oi.unit_cost, 0) = 0
    and (oi.variant_id is null or public.variant_cost(oi.variant_id) = 0)
    and exists (select 1 from public.finance_transactions ft where ft.source_key = 'order:' || o.id || ':product_revenue');

  select coalesce(jsonb_agg(jsonb_build_object('order_id', order_id, 'order_number', order_number, 'product', product, 'quantity', quantity,
      'unit_cost', new_cost, 'amount', amount, 'day', day) order by day, order_number), '[]'::jsonb)
  into v_rows from (select * from _rebuild order by day, order_number limit 100) x;

  if p_apply then
    for r in
      select rb.*, o.customer_id from _rebuild rb join public.orders o on o.id = rb.order_id
      join public.order_items oi on oi.id = rb.item_id
      order by rb.day
      for update of oi
    loop
      -- Still missing? (another run may have filled it meanwhile)
      continue when (select coalesce(unit_cost, 0) from public.order_items where id = r.item_id) <> 0;
      update public.order_items set unit_cost = r.new_cost where id = r.item_id;
      v_txn := public._post_finance('EXPENSE', 'COGS', r.amount, r.day, false, r.order_id, r.customer_id, null, r.order_number,
        'Product cost added later (was missing at delivery)', 'order_item:' || r.item_id || ':cost_rebuild', null);
      if v_txn.id is not null then
        v_posted := v_posted + 1;
      end if;
    end loop;
    update public.orders o set cost_total = public.money((select coalesce(sum(unit_cost * quantity), 0) from public.order_items where order_id = o.id))
    where o.id in (select order_id from _rebuild);
    perform public.log_audit('finance.rebuild_cost', 'finance', null, null,
      jsonb_build_object('from', p_from, 'to', p_to, 'items', v_items, 'orders', v_orders, 'amount', v_amount, 'posted', v_posted));
  end if;

  return jsonb_build_object('applied', p_apply, 'items', v_items, 'orders', v_orders, 'amount', v_amount, 'posted', v_posted,
    'unknown_items', v_unknown, 'rows', v_rows);
end;
$$;

revoke all on function public._fin_line(text, text) from public, anon;
revoke all on function public._fin_check_args(date, date, text) from public, anon;
revoke all on function public.report_order_financials(date, date, text) from public, anon;
revoke all on function public.report_order_financials_orders(date, date, text, text, boolean, int, int) from public, anon;
revoke all on function public.finance_recalculate_orders(date, date) from public, anon;
revoke all on function public.finance_rebuild_cost(date, date, boolean) from public, anon;
grant execute on function public.report_order_financials(date, date, text) to authenticated, service_role;
grant execute on function public.report_order_financials_orders(date, date, text, text, boolean, int, int) to authenticated, service_role;
grant execute on function public.finance_recalculate_orders(date, date) to authenticated, service_role;
grant execute on function public.finance_rebuild_cost(date, date, boolean) to authenticated, service_role;
