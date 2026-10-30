-- =============================================================================
-- Profit on approval: the dashboard's profit counts an order from the day it is approved.
--
-- Asked for on 30 Oct 2026: approved orders were left out of the profit until they were delivered,
-- while the ad spend of the same days was in, so the dashboard showed a loss in a good week. Now:
--   * An approved order counts at once: its sale, less its product cost and courier charge.
--   * Delivered: what it was delivered for (less goods sent back and refunds).
--   * Returned: no sale and no product cost (the goods come back). The courier's delivery and return
--     charges are the cost, less what the customer paid towards them (an advance): a paid return
--     charge is no loss, an unpaid one is. An advance the business chose to keep counts in full;
--     one not settled yet counts up to the courier charges (it may still be refunded).
--   * Cancelled before it went out: nothing, unless the courier charged or the advance was kept.
--   * Lost: the cost of the goods (a courier claim comes in as other income).
--   * Ads, other income and other expenses by their own date, as in the books.
-- Courier charges are the ones the courier reported, else the booking's estimate; before a parcel
-- is booked the order's delivery charge stands in for it. The books (Finance → Profit & loss and
-- Order financials) still count a sale on delivery.
--
-- Functions that change in a line are patched in place (CREATE OR REPLACE keeps each one's owner and
-- grants). Safe to re-run.
-- =============================================================================

-- 1. What each approved order of the period adds ----------------------------------------------------

create or replace function public._order_profit_rows(p_from date, p_to date)
returns table (order_id uuid, day date, state text, sales numeric, product_cost numeric, courier_cost numeric,
               return_paid numeric, courier_estimated boolean, missing_cost boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with o as (
    select o.id, o.total_amount, o.delivery_charge, o.return_charge, o.cod_amount, o.delivered_at,
           coalesce(o.partial_return_amount, 0) as partial_return,
           greatest(o.amount_paid, 0) as kept, -- paid less refunded
           o.amount_refunded, o.advance_resolution,
           public._local_date(o.confirmed_at) as day,
           case when o.status in ('DELIVERED', 'PARTIALLY_DELIVERED') then 'delivered'
                when o.status in ('RETURN_REQUESTED', 'RETURNING', 'RETURNED', 'FAILED_DELIVERY') then 'returned'
                when o.status = 'LOST' then 'lost'
                when o.status in ('CANCELLED', 'REJECTED_FRAUD', 'PENDING_CANCEL') then 'cancelled'
                else 'open' end as state
    from public.orders o
    where o.confirmed_at >= public._ts_from(p_from) and o.confirmed_at < public._ts_from(p_to + 1)
      and o.merged_into is null
  ), i as (
    -- Product cost: the cost kept on the order, else the product's cost today.
    select x.order_id, sum(x.cost * x.quantity) as cost_all, sum(x.cost * (x.quantity - x.returned)) as cost_kept,
           bool_or(x.cost = 0) as missing
    from (select oi.order_id, oi.quantity, coalesce(oi.returned_quantity, 0) as returned,
                 coalesce(nullif(oi.unit_cost, 0), public.variant_cost(oi.variant_id), 0) as cost
          from public.order_items oi join o on o.id = oi.order_id
          where oi.quantity > 0) x
    group by x.order_id
  ), ch as (
    -- Courier charges recorded so far (each entry is a change, so the sum is the charge).
    select c.order_id, sum(c.amount) as recorded,
           bool_or(c.kind = 'DELIVERY') as has_delivery, bool_or(c.kind = 'RETURN') as has_return,
           bool_or(c.kind = 'COD_FEE') as has_cod
    from public.shipment_charges c join o on o.id = c.order_id
    group by c.order_id
  ), s as (
    select s.order_id, s.courier_id, s.shipping_cost, s.return_charge
    from public.shipments s join o on o.id = s.order_id
    where s.is_active
  ), c as (
    -- What is not recorded yet, estimated the way the books post it on delivery or return.
    select o.*, coalesce(ch.recorded, 0) as recorded,
           case when (o.state in ('open', 'delivered') or (o.state = 'returned' and o.delivered_at is null and s.order_id is not null))
                     and not coalesce(ch.has_delivery, false)
                then coalesce(nullif(s.shipping_cost, 0), o.delivery_charge) else 0 end
           + case when o.state in ('open', 'delivered') and s.courier_id is not null and not coalesce(ch.has_cod, false)
                  then coalesce(public._courier_cod_fee(s.courier_id, o.cod_amount), 0) else 0 end
           + case when o.state = 'returned' and s.order_id is not null and not coalesce(ch.has_return, false)
                  then coalesce(nullif(s.return_charge, 0), o.return_charge) else 0 end as estimated,
           coalesce(i.cost_all, 0) as cost_all, coalesce(i.cost_kept, 0) as cost_kept, coalesce(i.missing, false) as missing
    from o left join ch on ch.order_id = o.id left join s on s.order_id = o.id left join i on i.order_id = o.id
  )
  select c.id, c.day, c.state,
         case c.state when 'open' then c.total_amount
                      when 'delivered' then greatest(c.total_amount - c.partial_return - c.amount_refunded, 0)
                      else 0 end,
         case c.state when 'open' then c.cost_all when 'delivered' then c.cost_kept when 'lost' then c.cost_all else 0 end,
         c.recorded + c.estimated,
         case when c.state not in ('returned', 'cancelled') then 0
              when c.advance_resolution = 'RETAINED' then c.kept
              else least(c.kept, greatest(c.recorded + c.estimated, 0)) end,
         c.estimated > 0,
         c.missing and c.state in ('open', 'delivered', 'lost')
  from c
$$;
revoke all on function public._order_profit_rows(date, date) from public, anon, authenticated;

-- 2. The report: approved orders of the period, plus ads, other income and expenses of its days ------

create or replace function public.report_estimated_profit(p_from date, p_to date)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_out jsonb;
begin
  if current_setting('app.core_report', true) is distinct from 'on' then
    perform public.require_feature('reports');
  end if;
  perform public.require_permission('finance.view');
  perform public._fin_check_args(p_from, p_to, 'delivered');

  with r as (
    select * from public._order_profit_rows(p_from, p_to)
  ), l as (
    -- From the books, by date: ads, other income and expenses, and costs that belong to no order.
    select f.day, f.line, f.amount from public._fin_rows(p_from, p_to, 'delivered') f
    where f.line in ('other_income', 'ads', 'other_expense')
       or (f.line in ('product_cost', 'delivery_cost') and f.order_id is null)
  ), t as (
    select coalesce((select sum(r.sales) from r), 0) as sales,
           coalesce((select sum(r.return_paid) from r), 0) as return_paid,
           coalesce((select sum(r.product_cost) from r), 0) + coalesce((select sum(l.amount) from l where l.line = 'product_cost'), 0) as product_cost,
           coalesce((select sum(r.courier_cost) from r), 0) + coalesce((select sum(l.amount) from l where l.line = 'delivery_cost'), 0) as courier_cost,
           coalesce((select sum(l.amount) from l where l.line = 'other_income'), 0) as other_income,
           coalesce((select sum(l.amount) from l where l.line = 'ads'), 0) as ads,
           coalesce((select sum(l.amount) from l where l.line = 'other_expense'), 0) as other_expense
  ), dr as (
    select r.day, sum(r.sales) as sales, sum(r.sales + r.return_paid - r.product_cost - r.courier_cost) as profit
    from r group by r.day
  ), dl as (
    select l.day, sum(case when l.line = 'other_income' then l.amount else -l.amount end) as profit
    from l group by l.day
  ), d as (
    select p_from + g.n as day, coalesce(dr.sales, 0) as sales, coalesce(dr.profit, 0) + coalesce(dl.profit, 0) as profit
    from generate_series(0, p_to - p_from) as g(n)
    left join dr on dr.day = p_from + g.n
    left join dl on dl.day = p_from + g.n
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to,
    'totals', jsonb_build_object(
      'sales', t.sales, 'other_income', t.other_income, 'return_charges', t.return_paid,
      'product_cost', t.product_cost, 'courier_cost', t.courier_cost, 'ads', t.ads, 'other_expense', t.other_expense,
      'profit', t.sales + t.other_income + t.return_paid - t.product_cost - t.courier_cost - t.ads - t.other_expense),
    'orders', (select jsonb_build_object(
      'approved', count(*), 'open', count(*) filter (where r.state = 'open'),
      'delivered', count(*) filter (where r.state = 'delivered'), 'returned', count(*) filter (where r.state = 'returned'),
      'cancelled', count(*) filter (where r.state = 'cancelled'), 'lost', count(*) filter (where r.state = 'lost')) from r),
    'returns', (select jsonb_build_object(
      'orders', count(*), 'courier_cost', coalesce(sum(r.courier_cost), 0), 'paid', coalesce(sum(r.return_paid), 0),
      'loss', coalesce(sum(r.courier_cost - r.return_paid), 0)) from r where r.state = 'returned'),
    'quality', (select jsonb_build_object(
      'courier_estimated', count(*) filter (where r.courier_estimated),
      'missing_cost', count(*) filter (where r.missing_cost)) from r),
    'daily', (select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'sales', d.sales, 'profit', d.profit) order by d.day), '[]'::jsonb) from d))
  into v_out
  from t;
  return v_out;
end;
$$;
revoke all on function public.report_estimated_profit(date, date) from public, anon;
grant execute on function public.report_estimated_profit(date, date) to authenticated, service_role;

-- 3. The dashboard shows it (for the period and for today) ---------------------------------------------

create or replace function pg_temp.patch_fn(p_fn text, p_from text, p_to text)
returns void
language plpgsql as $$
declare
  v_old text := replace(pg_get_functiondef(p_fn::regprocedure), E'\r', '');
  v_hits int;
begin
  if position(p_to in v_old) > 0 then
    return; -- already patched
  end if;
  v_hits := (length(v_old) - length(replace(v_old, p_from, ''))) / length(p_from);
  if v_hits <> 1 then
    raise exception 'profit on approval: % has changed (% matches for "%")', p_fn, v_hits, left(p_from, 60);
  end if;
  execute replace(v_old, p_from, p_to);
end $$;

select pg_temp.patch_fn('public.dashboard_command_center(date,date)',
  $a$'today_profit', v_fin_today -> 'net_profit'));$a$,
  $b$'today_profit', v_fin_today -> 'net_profit', 'estimate', case when p_to - p_from <= 1100 then public.report_estimated_profit(p_from, p_to) end, 'today_estimate', public.report_estimated_profit(v_today, v_today) -> 'totals'));$b$);

select public._tenancy_own_functions();
