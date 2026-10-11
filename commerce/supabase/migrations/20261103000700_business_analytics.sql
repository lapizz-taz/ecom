-- =============================================================================
-- Usage & Analytics: unified SMS / BD Courier usage, revenue and costs, and
-- merchant health.
--
-- Every figure says what it is:
--   actual      — read from records (payments, usage rows, recorded costs);
--   calculated  — arithmetic on actual records (MRR, churn rate);
--   estimate    — uses an assumption (a cost per SMS part or per lookup), and
--                 the assumptions and anything missing are returned with it.
-- Nothing is invented: a cost that was never recorded or configured is
-- reported as missing, not as zero.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Recorded platform costs and cost assumptions
-- -----------------------------------------------------------------------------
-- What the company actually paid (hosting, SMS provider bills, gateway fees…),
-- entered from invoices. Append-only: a mistake is corrected with a new entry.
create table public.platform_cost_entries (
  id bigint generated always as identity primary key,
  month date not null check (month = date_trunc('month', month)::date),
  category text not null check (category in ('INFRASTRUCTURE', 'SMS_PROVIDER', 'COURIER_API', 'PAYMENT_FEES', 'AI', 'STAFF_TOOLS', 'OTHER')),
  amount numeric(12,2) not null check (amount <> 0),
  currency text not null default 'BDT',
  note text not null check (length(trim(note)) between 3 and 300),
  corrects bigint references public.platform_cost_entries(id),
  recorded_by uuid,
  recorded_by_email text,
  created_at timestamptz not null default now()
);
create index platform_cost_entries_month_idx on public.platform_cost_entries (month);
create trigger platform_cost_entries_immutable before update or delete on public.platform_cost_entries
  for each row execute function public.prevent_mutation();
alter table public.platform_cost_entries enable row level security;
revoke all on public.platform_cost_entries from anon, authenticated;

insert into public.platform_settings (key, value) values ('cost_assumptions', jsonb_build_object(
  -- BDT the BD Courier provider charges per lookup; null = not known.
  'bd_courier_per_lookup', null,
  -- Gateway fee as a percent of money received; null = not known.
  'payment_fee_percent', null))
on conflict (key) do nothing;

create or replace function public._platform_cost_assumptions()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'sms_per_part', nullif((select (value ->> 'cost_per_segment')::numeric from public.platform_settings where key = 'sms'), 0),
    'bd_courier_per_lookup', (select (value ->> 'bd_courier_per_lookup')::numeric from public.platform_settings where key = 'cost_assumptions'),
    'payment_fee_percent', (select (value ->> 'payment_fee_percent')::numeric from public.platform_settings where key = 'cost_assumptions'))
$$;

create or replace function public.platform_cost_assumptions_save(p jsonb, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb := coalesce((select value from public.platform_settings where key = 'cost_assumptions'), '{}'::jsonb);
  v_after jsonb;
  k text;
begin
  perform public._platform_require('subscriptions', 'manage');
  v_after := v_before || coalesce(p, '{}'::jsonb);
  foreach k in array array['bd_courier_per_lookup', 'payment_fee_percent'] loop
    if jsonb_typeof(v_after -> k) not in ('null', 'number') or coalesce((v_after ->> k)::numeric, 0) < 0
       or (k = 'payment_fee_percent' and coalesce((v_after ->> k)::numeric, 0) > 20) then
      raise exception 'VALIDATION: % must be empty (unknown) or a positive number', replace(k, '_', ' ') using errcode = '22023';
    end if;
  end loop;
  v_after := jsonb_build_object('bd_courier_per_lookup', v_after -> 'bd_courier_per_lookup', 'payment_fee_percent', v_after -> 'payment_fee_percent');
  insert into public.platform_settings (key, value, updated_by) values ('cost_assumptions', v_after, auth.uid())
  on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by;
  perform public._config_version('platform_setting', 'cost_assumptions', v_after, p_reason);
  perform public._platform_log('analytics.cost_assumptions_changed', null, 'platform_setting', 'cost_assumptions', p_reason, v_before, v_after);
  return v_after;
end;
$$;

create or replace function public.platform_cost_entry_add(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_month date := date_trunc('month', nullif(p ->> 'month', '')::date)::date;
  v_amount numeric := nullif(p ->> 'amount', '')::numeric;
  v_corrects bigint := nullif(p ->> 'corrects', '')::bigint;
  e public.platform_cost_entries;
begin
  perform public._platform_require('subscriptions', 'manage');
  if v_month is null or v_month > date_trunc('month', now())::date or v_month < date '2020-01-01' then
    raise exception 'VALIDATION: choose the month the cost is for (not in the future)' using errcode = '22023';
  end if;
  if v_amount is null or v_amount = 0 or abs(v_amount) > 100000000 then
    raise exception 'VALIDATION: enter the amount (negative only to correct an earlier entry)' using errcode = '22023';
  end if;
  if v_amount < 0 and v_corrects is null then
    raise exception 'VALIDATION: a negative amount must say which entry it corrects' using errcode = '22023';
  end if;
  if v_corrects is not null and not exists (select 1 from public.platform_cost_entries where id = v_corrects) then
    raise exception 'VALIDATION: the entry being corrected does not exist' using errcode = '22023';
  end if;
  insert into public.platform_cost_entries (month, category, amount, note, corrects, recorded_by, recorded_by_email)
  values (v_month, upper(coalesce(p ->> 'category', '')), round(v_amount, 2), trim(coalesce(p ->> 'note', '')), v_corrects, auth.uid(),
          (select email from public.platform_staff where user_id = auth.uid()))
  returning * into e;
  perform public._platform_log('analytics.cost_recorded', null, 'platform_cost_entry', e.id::text, e.note, null, to_jsonb(e));
  return to_jsonb(e);
end;
$$;

create or replace function public.platform_cost_entries_list(p_from date default null, p_to date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._platform_require('subscriptions', 'view');
  return jsonb_build_object(
    'entries', coalesce((select jsonb_agg(to_jsonb(e) order by e.month desc, e.id desc) from public.platform_cost_entries e
                         where (p_from is null or e.month >= date_trunc('month', p_from)) and (p_to is null or e.month <= p_to)), '[]'::jsonb),
    'assumptions', public._platform_cost_assumptions(),
    'can_manage', public.platform_can('subscriptions', 'manage'));
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. Revenue, costs and margin
-- -----------------------------------------------------------------------------
create or replace function public.platform_business_report(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_from timestamptz := (p_from::timestamp at time zone 'Asia/Dhaka');
  v_to timestamptz := ((p_to + 1)::timestamp at time zone 'Asia/Dhaka');
  v_assume jsonb := public._platform_cost_assumptions();
  v_real uuid[];
  v_paid jsonb;
  v_revenue numeric;
  v_sms jsonb;
  v_bd jsonb;
  v_costs jsonb;
  v_recorded numeric;
  v_known_provider numeric;
  v_estimated numeric;
  v_fee numeric;
  v_missing text[] := '{}';
  v_assumptions text[] := '{}';
  v_paying_start int;
  v_churned int;
begin
  perform public._platform_require('subscriptions', 'view');
  if p_to < p_from or p_to - p_from > 731 then
    raise exception 'VALIDATION: choose a range of up to two years' using errcode = '22023';
  end if;
  -- Real merchants only: demo and test merchants are left out of every business figure.
  select coalesce(array_agg(id), '{}') into v_real from public.merchants where not is_demo and id in (select public._platform_merchant_ids());

  -- Money actually received (verified payments), by what it paid for.
  select jsonb_build_object(
      'total', coalesce(sum(p.amount), 0),
      'subscriptions', coalesce(sum(p.amount) filter (where i.kind = 'SUBSCRIPTION'), 0),
      'credits', coalesce(sum(p.amount) filter (where i.kind = 'CREDITS'), 0),
      'addons', coalesce(sum(p.amount) filter (where i.kind = 'ADDON'), 0),
      'other', coalesce(sum(p.amount) filter (where i.kind = 'OTHER'), 0),
      'payments', count(*))
    into v_paid
  from public.billing_payments p join public.billing_invoices i on i.id = p.invoice_id
  where p.status = 'SUCCEEDED' and coalesce(p.verified_at, p.created_at) >= v_from and coalesce(p.verified_at, p.created_at) < v_to
    and p.merchant_id = any (v_real);
  v_revenue := (v_paid ->> 'total')::numeric;

  -- SMS: credit sales vs what sending cost.
  select jsonb_build_object(
      'credit_sales', coalesce((select sum((l ->> 'amount')::numeric) from public.billing_invoices i, jsonb_array_elements(i.lines) l
                               where i.kind = 'CREDITS' and i.status = 'PAID' and i.paid_at >= v_from and i.paid_at < v_to and i.merchant_id = any (v_real)
                                 and l ->> 'kind' = 'credits' and l ->> 'credit_type' = 'SMS'), 0),
      'units', coalesce(sum(u.units) filter (where u.status = 'SUCCEEDED' and u.refunded_at is null), 0),
      'free_units', coalesce(sum(u.units) filter (where u.status = 'SUCCEEDED' and u.refunded_at is null and u.charge = 'FREE'), 0),
      'credits_used', coalesce(sum(u.credits) filter (where u.charge = 'CREDITS' and u.refunded_at is null and u.status <> 'DENIED'), 0),
      'provider_cost_reported', coalesce(sum(u.provider_cost), 0),
      'units_without_cost', coalesce(sum(u.units) filter (where u.status = 'SUCCEEDED' and u.provider_cost is null), 0))
    into v_sms
  from public.service_usage u
  where u.service = 'SMS' and u.created_at >= v_from and u.created_at < v_to and u.merchant_id = any (v_real);
  v_sms := v_sms || jsonb_build_object('provider_cost_estimated',
    case when (v_sms ->> 'units_without_cost')::numeric = 0 then 0
         when v_assume ->> 'sms_per_part' is null then null
         else round((v_sms ->> 'units_without_cost')::numeric * (v_assume ->> 'sms_per_part')::numeric, 2) end);

  select jsonb_build_object(
      'credit_sales', coalesce((select sum((l ->> 'amount')::numeric) from public.billing_invoices i, jsonb_array_elements(i.lines) l
                               where i.kind = 'CREDITS' and i.status = 'PAID' and i.paid_at >= v_from and i.paid_at < v_to and i.merchant_id = any (v_real)
                                 and l ->> 'kind' = 'credits' and l ->> 'credit_type' = 'COURIER'), 0),
      'lookups', count(*) filter (where u.status = 'SUCCEEDED'),
      'free_lookups', count(*) filter (where u.status = 'SUCCEEDED' and u.charge = 'FREE'),
      'failed', count(*) filter (where u.status = 'FAILED'),
      'credits_used', coalesce(sum(u.credits) filter (where u.charge = 'CREDITS' and u.refunded_at is null and u.status <> 'DENIED'), 0))
    into v_bd
  from public.service_usage u
  where u.service = 'BD_COURIER' and u.created_at >= v_from and u.created_at < v_to and u.merchant_id = any (v_real);
  v_bd := v_bd || jsonb_build_object('cost_estimated',
    case when (v_bd ->> 'lookups')::int = 0 then 0
         when v_assume ->> 'bd_courier_per_lookup' is null then null
         else round((v_bd ->> 'lookups')::numeric * (v_assume ->> 'bd_courier_per_lookup')::numeric, 2) end);

  -- Costs the company recorded for the months in the range (actual).
  select jsonb_build_object(
      'by_category', coalesce((select jsonb_object_agg(category, total) from (select category, sum(amount) as total from public.platform_cost_entries
                               where month >= date_trunc('month', p_from) and month <= p_to group by category) c), '{}'::jsonb),
      'total', coalesce((select sum(amount) from public.platform_cost_entries where month >= date_trunc('month', p_from) and month <= p_to), 0),
      'months_with_entries', (select count(distinct month) from public.platform_cost_entries where month >= date_trunc('month', p_from) and month <= p_to),
      'months_in_range', (select count(*) from generate_series(date_trunc('month', p_from), date_trunc('month', p_to::timestamp), interval '1 month')))
    into v_costs;
  v_recorded := (v_costs ->> 'total')::numeric;

  -- The SMS provider bill, if recorded, already contains what usage rows report: count one of them.
  if coalesce((v_costs #>> '{by_category,SMS_PROVIDER}')::numeric, 0) <> 0 then
    v_known_provider := 0;
    v_assumptions := array_append(v_assumptions, 'SMS provider cost is taken from the recorded provider bills, not from per-message costs');
  else
    v_known_provider := (v_sms ->> 'provider_cost_reported')::numeric;
    if (v_sms ->> 'units_without_cost')::numeric > 0 then
      if v_sms ->> 'provider_cost_estimated' is null then
        v_missing := array_append(v_missing, format('%s SMS parts have no reported cost and no cost per part is set (SMS Management)', v_sms ->> 'units_without_cost'));
      else
        v_assumptions := array_append(v_assumptions, format('SMS parts without a reported cost are estimated at %s BDT each', v_assume ->> 'sms_per_part'));
      end if;
    end if;
  end if;
  if coalesce((v_costs #>> '{by_category,COURIER_API}')::numeric, 0) = 0 and (v_bd ->> 'lookups')::int > 0 then
    if v_bd ->> 'cost_estimated' is null then
      v_missing := array_append(v_missing, format('%s BD Courier lookups have no cost per lookup set', v_bd ->> 'lookups'));
    else
      v_assumptions := array_append(v_assumptions, format('BD Courier lookups are estimated at %s BDT each', v_assume ->> 'bd_courier_per_lookup'));
    end if;
  end if;
  v_fee := case when v_assume ->> 'payment_fee_percent' is null or coalesce((v_costs #>> '{by_category,PAYMENT_FEES}')::numeric, 0) <> 0 then null
                else round(v_revenue * (v_assume ->> 'payment_fee_percent')::numeric / 100, 2) end;
  if v_fee is not null then
    v_assumptions := array_append(v_assumptions, format('Payment gateway fees estimated at %s%% of money received', v_assume ->> 'payment_fee_percent'));
  elsif coalesce((v_costs #>> '{by_category,PAYMENT_FEES}')::numeric, 0) = 0 and v_revenue > 0 then
    v_missing := array_append(v_missing, 'Payment gateway fees: not recorded and no fee percent set');
  end if;
  if (v_costs ->> 'months_with_entries')::int < (v_costs ->> 'months_in_range')::int then
    v_missing := array_append(v_missing, format('Recorded costs cover %s of %s months in the range (hosting, staff tools and other bills)',
      v_costs ->> 'months_with_entries', v_costs ->> 'months_in_range'));
  end if;
  v_estimated := coalesce((case when coalesce((v_costs #>> '{by_category,SMS_PROVIDER}')::numeric, 0) <> 0 then 0 else (v_sms ->> 'provider_cost_estimated')::numeric end), 0)
               + coalesce((case when coalesce((v_costs #>> '{by_category,COURIER_API}')::numeric, 0) <> 0 then 0 else (v_bd ->> 'cost_estimated')::numeric end), 0)
               + coalesce(v_fee, 0);
  v_assumptions := array_append(v_assumptions, 'Revenue is money received and verified in the range; credits bought are counted when paid, not when used');

  -- Churn: paying subscriptions at the start of the range that ended in it.
  select count(*) into v_paying_start from public.subscriptions s
  where s.merchant_id = any (v_real) and s.price > 0 and s.started_at < v_from and (s.ended_at is null or s.ended_at >= v_from)
    and coalesce(s.trial_ends_at, s.started_at) < v_from;
  select count(*) into v_churned from public.subscriptions s
  where s.merchant_id = any (v_real) and s.price > 0 and s.status in ('CANCELLED', 'EXPIRED') and s.ended_at >= v_from and s.ended_at < v_to;

  return jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to),
    'mrr', (select jsonb_build_object(
        'mrr', coalesce(sum(case s.billing_interval when 'YEAR' then s.price / 12 else s.price end) filter (where s.status in ('ACTIVE', 'PAST_DUE')), 0),
        'arr', coalesce(sum(case s.billing_interval when 'YEAR' then s.price / 12 else s.price end) filter (where s.status in ('ACTIVE', 'PAST_DUE')), 0) * 12,
        'at_risk', coalesce(sum(case s.billing_interval when 'YEAR' then s.price / 12 else s.price end) filter (where s.status = 'PAST_DUE' or s.cancel_at_period_end), 0),
        'trialing', coalesce(sum(case s.billing_interval when 'YEAR' then s.price / 12 else s.price end) filter (where s.status = 'TRIALING'), 0),
        'paying', count(*) filter (where s.status in ('ACTIVE', 'PAST_DUE') and s.price > 0))
      from public.subscriptions s where s.ended_at is null and s.merchant_id = any (v_real)),
    'mrr_by_plan', (select coalesce(jsonb_agg(x order by x.mrr desc), '[]'::jsonb) from (
        select pl.code, pl.name, count(*) filter (where s.status in ('ACTIVE', 'PAST_DUE')) as active, count(*) filter (where s.status = 'TRIALING') as trialing,
               coalesce(sum(case s.billing_interval when 'YEAR' then s.price / 12 else s.price end) filter (where s.status in ('ACTIVE', 'PAST_DUE')), 0) as mrr
        from public.subscriptions s join public.plans pl on pl.id = s.plan_id
        where s.ended_at is null and s.merchant_id = any (v_real) group by pl.code, pl.name) x),
    'revenue', v_paid || jsonb_build_object(
      'by_plan', (select coalesce(jsonb_agg(x order by x.amount desc), '[]'::jsonb) from (
          select pl.code, pl.name, sum(p.amount) as amount from public.billing_payments p
          join public.billing_invoices i on i.id = p.invoice_id join public.subscriptions s on s.id = i.subscription_id join public.plans pl on pl.id = s.plan_id
          where p.status = 'SUCCEEDED' and i.kind = 'SUBSCRIPTION' and coalesce(p.verified_at, p.created_at) >= v_from and coalesce(p.verified_at, p.created_at) < v_to
            and p.merchant_id = any (v_real) group by pl.code, pl.name) x),
      'refunds', 0, 'refunds_note', 'The billing system has no refund flow; none are recorded'),
    'merchants', jsonb_build_object(
      'new', (select count(*) from public.merchants where id = any (v_real) and created_at >= v_from and created_at < v_to),
      'active', (select count(distinct o.merchant_id) from public.orders o where o.merchant_id = any (v_real) and o.created_at >= v_from and o.created_at < v_to),
      'total', coalesce(array_length(v_real, 1), 0)),
    'subscriptions', jsonb_build_object(
      'renewals', (select count(*) from public.billing_invoices i join public.subscriptions s on s.id = i.subscription_id
                   where i.kind = 'SUBSCRIPTION' and i.status = 'PAID' and i.paid_at >= v_from and i.paid_at < v_to and i.merchant_id = any (v_real)
                     and i.period_start > coalesce(s.trial_ends_at, s.started_at) + interval '1 day'),
      'cancelled', (select count(*) from public.subscription_events e where e.merchant_id = any (v_real) and e.event in ('subscription.cancel', 'subscription.cancelled')
                    and e.created_at >= v_from and e.created_at < v_to),
      'expired', (select count(*) from public.subscription_events e where e.merchant_id = any (v_real) and e.event = 'subscription.expired'
                  and e.created_at >= v_from and e.created_at < v_to),
      'paying_at_start', v_paying_start,
      'churned', v_churned,
      'churn_rate', case when v_paying_start > 0 then round(v_churned::numeric * 100 / v_paying_start, 1) end),
    'payments', jsonb_build_object(
      'failed', (select count(*) from public.billing_payments p where p.status in ('FAILED', 'REJECTED') and p.created_at >= v_from and p.created_at < v_to
                 and p.merchant_id = any (v_real)),
      'failed_amount', (select coalesce(sum(p.amount), 0) from public.billing_payments p where p.status in ('FAILED', 'REJECTED')
                        and p.created_at >= v_from and p.created_at < v_to and p.merchant_id = any (v_real)),
      'awaiting_verification', (select count(*) from public.billing_payments p where p.status = 'PENDING' and p.merchant_id = any (v_real)),
      'overdue_invoices', (select count(*) from public.billing_invoices i where i.status = 'OPEN' and i.due_at < now() and i.merchant_id = any (v_real)),
      'overdue_amount', (select coalesce(sum(i.total - i.amount_paid), 0) from public.billing_invoices i where i.status = 'OPEN' and i.due_at < now()
                         and i.merchant_id = any (v_real))),
    'sms', v_sms,
    'bd_courier', v_bd,
    'ai', jsonb_build_object('metered', false, 'note', 'No AI feature records usage yet, so there is nothing to report or charge'),
    'costs', v_costs || jsonb_build_object('provider_reported', v_known_provider, 'estimated', v_estimated, 'payment_fees_estimated', v_fee),
    'margin', jsonb_build_object(
      'revenue', v_revenue,
      'known_costs', v_recorded + v_known_provider,
      'estimated_costs', v_estimated,
      'contribution', v_revenue - v_recorded - v_known_provider - v_estimated,
      -- Only a complete picture gets a margin percent.
      'complete', cardinality(v_missing) = 0,
      'assumptions', to_jsonb(v_assumptions),
      'missing', to_jsonb(v_missing)),
    'by_merchant', (select coalesce(jsonb_agg(x order by x.revenue desc, x.number), '[]'::jsonb) from (
        select m.id, m.number, m.name,
          coalesce((select sum(p.amount) from public.billing_payments p where p.merchant_id = m.id and p.status = 'SUCCEEDED'
                    and coalesce(p.verified_at, p.created_at) >= v_from and coalesce(p.verified_at, p.created_at) < v_to), 0) as revenue,
          coalesce((select sum(coalesce(u.provider_cost, case when u.status = 'SUCCEEDED' then u.units * (v_assume ->> 'sms_per_part')::numeric end))
                    from public.service_usage u where u.merchant_id = m.id and u.service = 'SMS' and u.created_at >= v_from and u.created_at < v_to), 0) as sms_cost,
          (select count(*) from public.service_usage u where u.merchant_id = m.id and u.service = 'BD_COURIER' and u.status = 'SUCCEEDED'
             and u.created_at >= v_from and u.created_at < v_to) * (v_assume ->> 'bd_courier_per_lookup')::numeric as bd_cost,
          (select count(*) from public.service_usage u where u.merchant_id = m.id and u.service = 'BD_COURIER' and u.status = 'SUCCEEDED'
             and u.created_at >= v_from and u.created_at < v_to) as bd_lookups
        from public.merchants m where m.id = any (v_real)) x
      where x.revenue > 0 or x.sms_cost > 0 or x.bd_lookups > 0),
    'monthly', (select coalesce(jsonb_agg(jsonb_build_object('month', mo::date,
        'subscriptions', (select coalesce(sum(p.amount), 0) from public.billing_payments p join public.billing_invoices i on i.id = p.invoice_id
                          where p.status = 'SUCCEEDED' and i.kind = 'SUBSCRIPTION' and p.merchant_id = any (v_real)
                            and coalesce(p.verified_at, p.created_at) >= mo and coalesce(p.verified_at, p.created_at) < mo + interval '1 month'),
        'credits', (select coalesce(sum(p.amount), 0) from public.billing_payments p join public.billing_invoices i on i.id = p.invoice_id
                    where p.status = 'SUCCEEDED' and i.kind <> 'SUBSCRIPTION' and p.merchant_id = any (v_real)
                      and coalesce(p.verified_at, p.created_at) >= mo and coalesce(p.verified_at, p.created_at) < mo + interval '1 month'),
        'costs', (select coalesce(sum(amount), 0) from public.platform_cost_entries where month = mo::date),
        'new_merchants', (select count(*) from public.merchants where id = any (v_real) and created_at >= mo and created_at < mo + interval '1 month'),
        'churned', (select count(*) from public.subscriptions s where s.merchant_id = any (v_real) and s.price > 0 and s.status in ('CANCELLED', 'EXPIRED')
                    and s.ended_at >= mo and s.ended_at < mo + interval '1 month')) order by mo), '[]'::jsonb)
      from generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') mo),
    'assumptions', v_assume);
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Unified usage: SMS and BD Courier per merchant, with what is left
-- -----------------------------------------------------------------------------
create or replace function public.platform_usage_overview(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_from timestamptz := (p_from::timestamp at time zone 'Asia/Dhaka');
  v_to timestamptz := ((p_to + 1)::timestamp at time zone 'Asia/Dhaka');
begin
  perform public._platform_require('usage', 'view');
  if p_to < p_from or p_to - p_from > 366 then
    raise exception 'VALIDATION: choose a range of up to a year' using errcode = '22023';
  end if;
  return (with u as (
      select su.* from public.service_usage su
      where su.merchant_id in (select public._platform_merchant_ids()) and su.created_at >= v_from and su.created_at < v_to),
    per as (
      select m.id, m.number, m.name, m.is_demo,
        count(*) filter (where u.service = 'SMS' and u.status <> 'DENIED') as sms_attempted,
        count(*) filter (where u.service = 'SMS' and u.status = 'SUCCEEDED') as sms_sent,
        count(*) filter (where u.service = 'SMS' and u.outcome = 'DELIVERED') as sms_delivered,
        count(*) filter (where u.service = 'SMS' and (u.status = 'FAILED' or u.outcome = 'UNDELIVERED')) as sms_failed,
        count(*) filter (where u.service = 'SMS' and u.status = 'DENIED') as sms_refused,
        coalesce(sum(u.units) filter (where u.service = 'SMS' and u.charge in ('CREDITS', 'PLAN') and u.status in ('RESERVED', 'SUCCEEDED') and u.refunded_at is null), 0) as sms_billable,
        coalesce(sum(u.units) filter (where u.service = 'SMS' and u.charge = 'FREE' and u.status in ('RESERVED', 'SUCCEEDED') and u.refunded_at is null), 0) as sms_free,
        coalesce(sum(u.credits) filter (where u.service = 'SMS' and u.charge = 'CREDITS' and u.refunded_at is null and u.status <> 'DENIED'), 0) as sms_credits,
        count(*) filter (where u.service = 'BD_COURIER' and u.status <> 'DENIED') as bd_attempted,
        count(*) filter (where u.service = 'BD_COURIER' and u.status = 'SUCCEEDED') as bd_succeeded,
        count(*) filter (where u.service = 'BD_COURIER' and u.status = 'FAILED') as bd_failed,
        count(*) filter (where u.service = 'BD_COURIER' and u.status = 'DENIED') as bd_refused,
        count(*) filter (where u.service = 'BD_COURIER' and u.charge in ('CREDITS', 'PLAN') and u.status = 'SUCCEEDED') as bd_billable,
        coalesce(sum(u.credits) filter (where u.service = 'BD_COURIER' and u.charge = 'CREDITS' and u.refunded_at is null and u.status <> 'DENIED'), 0) as bd_credits
      from public.merchants m left join u on u.merchant_id = m.id
      where m.id in (select public._platform_merchant_ids()) and m.status <> 'CLOSED'
      group by m.id, m.number, m.name, m.is_demo)
    select jsonb_build_object(
      'range', jsonb_build_object('from', p_from, 'to', p_to),
      'totals', (select jsonb_build_object(
          'sms_attempted', sum(sms_attempted), 'sms_sent', sum(sms_sent), 'sms_delivered', sum(sms_delivered), 'sms_failed', sum(sms_failed),
          'sms_refused', sum(sms_refused), 'sms_billable', sum(sms_billable), 'sms_free', sum(sms_free), 'sms_credits', sum(sms_credits),
          'bd_attempted', sum(bd_attempted), 'bd_succeeded', sum(bd_succeeded), 'bd_failed', sum(bd_failed), 'bd_refused', sum(bd_refused),
          'bd_billable', sum(bd_billable), 'bd_credits', sum(bd_credits),
          'sms_credits_outstanding', (select coalesce(sum(balance), 0) from public.credit_balances where credit_type = 'SMS'
                                      and merchant_id in (select public._platform_merchant_ids())),
          'courier_credits_outstanding', (select coalesce(sum(balance), 0) from public.credit_balances where credit_type = 'COURIER'
                                          and merchant_id in (select public._platform_merchant_ids())))
        from per),
      'merchants', (select coalesce(jsonb_agg(to_jsonb(per) || jsonb_build_object(
            'sms_state', (select jsonb_build_object('free_remaining', s -> 'free' -> 'remaining', 'credits', s -> 'credits_available', 'unmetered', s -> 'unmetered')
                          from public._usage_state(per.id, 'SMS') s),
            'bd_state', (select jsonb_build_object('free_remaining', s -> 'free' -> 'remaining', 'credits', s -> 'credits_available', 'unmetered', s -> 'unmetered',
                                                   'month_used', s -> 'month_used', 'monthly_cap', s -> 'monthly_cap')
                         from public._usage_state(per.id, 'BD_COURIER') s))
          order by (per.sms_attempted + per.bd_attempted) desc, per.number), '[]'::jsonb) from per),
      'daily', (select coalesce(jsonb_agg(d order by d.day), '[]'::jsonb) from (
          select (created_at at time zone 'Asia/Dhaka')::date as day,
                 count(*) filter (where service = 'SMS' and status = 'SUCCEEDED') as sms,
                 count(*) filter (where service = 'SMS' and (status = 'FAILED' or outcome = 'UNDELIVERED')) as sms_failed,
                 count(*) filter (where service = 'BD_COURIER' and status = 'SUCCEEDED') as bd,
                 count(*) filter (where service = 'BD_COURIER' and status = 'FAILED') as bd_failed
          from u group by 1) d)));
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Merchant health: signals that may need attention, each explained
-- -----------------------------------------------------------------------------
create or replace function public._platform_merchant_signals(p_merchant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  m public.merchants;
  s public.subscriptions;
  v_signals jsonb := '[]'::jsonb;
  v_onb jsonb;
  v_recent int;
  v_prior int;
  v_ever boolean;
  v_errors int;
  v_store_errors int;
  v_open int;
  v_overdue int;
  v_sms_now int;
  v_sms_before int;
  v_add jsonb;
begin
  select * into m from public.merchants where id = p_merchant;
  select * into s from public.subscriptions where merchant_id = p_merchant and ended_at is null order by created_at desc limit 1;
  v_onb := public._merchant_onboarding(p_merchant);
  select count(*) filter (where created_at > now() - interval '14 days'), count(*) filter (where created_at <= now() - interval '14 days' and created_at > now() - interval '28 days'),
         count(*) > 0
    into v_recent, v_prior, v_ever
  from public.orders where merchant_id = p_merchant and created_at > now() - interval '365 days';
  select count(*) into v_errors from public.system_logs where merchant_id = p_merchant and level = 'ERROR' and resolved_at is null and last_seen_at > now() - interval '7 days';
  select count(*) into v_store_errors from public.sales_channels where merchant_id = p_merchant and status = 'ERROR';
  select count(*) filter (where status in ('OPEN', 'IN_PROGRESS')), count(*) filter (where status in ('OPEN', 'IN_PROGRESS') and due_at < now())
    into v_open, v_overdue from public.support_tickets where merchant_id = p_merchant and not internal;
  select count(*) filter (where created_at > now() - interval '30 days'), count(*) filter (where created_at <= now() - interval '30 days')
    into v_sms_now, v_sms_before
  from public.service_usage where merchant_id = p_merchant and service = 'SMS' and status = 'SUCCEEDED' and created_at > now() - interval '60 days';

  -- Each signal: what was seen, how much it weighs (points off 100) and which kind of help it suggests.
  if (v_onb ->> 'done')::int < (v_onb ->> 'total')::int and m.created_at < now() - interval '7 days' then
    v_signals := v_signals || jsonb_build_object('key', 'onboarding', 'need', 'onboarding', 'points', least(25, 5 * ((v_onb ->> 'total')::int - (v_onb ->> 'done')::int)),
      'label', 'Onboarding not finished',
      'detail', format('%s of %s steps done after %s days: %s', v_onb ->> 'done', v_onb ->> 'total', extract(day from now() - m.created_at)::int,
        (select string_agg(e ->> 'label', ', ') from jsonb_array_elements(v_onb -> 'steps') e where not (e ->> 'done')::boolean)));
  end if;
  if v_store_errors > 0 then
    v_signals := v_signals || jsonb_build_object('key', 'store_error', 'need', 'technical', 'points', 20, 'label', 'Store connection failing',
      'detail', format('%s connected store(s) report an error', v_store_errors));
  end if;
  if v_errors > 0 then
    v_signals := v_signals || jsonb_build_object('key', 'errors', 'need', 'technical', 'points', case when v_errors >= 5 then 15 else 5 end,
      'label', 'Integration errors', 'detail', format('%s unresolved error(s) in the last 7 days', v_errors));
  end if;
  if v_ever and v_recent = 0 and m.status = 'ACTIVE' then
    v_signals := v_signals || jsonb_build_object('key', 'no_orders', 'need', 'activity', 'points', 20, 'label', 'No orders for 14 days',
      'detail', format('Had orders before (%s in the 14 days prior)', v_prior));
  elsif v_prior >= 10 and v_recent < v_prior / 2 then
    v_signals := v_signals || jsonb_build_object('key', 'order_drop', 'need', 'activity', 'points', 10, 'label', 'Orders dropped',
      'detail', format('%s orders in the last 14 days, %s in the 14 days before', v_recent, v_prior));
  end if;
  if s.status = 'PAST_DUE' then
    v_signals := v_signals || jsonb_build_object('key', 'past_due', 'need', 'billing', 'points', 20, 'label', 'Payment overdue',
      'detail', format('Subscription past due%s', case when s.grace_until is not null then ' — grace until ' || to_char(s.grace_until at time zone 'Asia/Dhaka', 'DD Mon') else '' end));
  elsif s.status = 'TRIALING' and s.trial_ends_at < now() + interval '7 days' then
    v_signals := v_signals || jsonb_build_object('key', 'trial_ending', 'need', 'billing', 'points', 5, 'label', 'Trial ending',
      'detail', format('Trial ends %s', to_char(s.trial_ends_at at time zone 'Asia/Dhaka', 'DD Mon')));
  elsif s.status = 'PAUSED' then
    v_signals := v_signals || jsonb_build_object('key', 'paused', 'need', 'billing', 'points', 10, 'label', 'Subscription paused', 'detail', 'Paused by the platform or on request');
  end if;
  if s.cancel_at_period_end then
    v_signals := v_signals || jsonb_build_object('key', 'cancelling', 'need', 'billing', 'points', 15, 'label', 'Cancellation scheduled',
      'detail', format('Ends %s unless undone', to_char(s.current_period_end at time zone 'Asia/Dhaka', 'DD Mon')));
  end if;
  if s.id is null and m.status = 'ACTIVE' then
    v_signals := v_signals || jsonb_build_object('key', 'no_subscription', 'need', 'billing', 'points', 10, 'label', 'No subscription', 'detail', 'Active account without a current plan');
  end if;
  if v_overdue > 0 then
    v_signals := v_signals || jsonb_build_object('key', 'tickets_overdue', 'need', 'technical', 'points', 10, 'label', 'Support tickets overdue',
      'detail', format('%s of %s open ticket(s) past their due time', v_overdue, v_open));
  elsif v_open > 0 then
    v_signals := v_signals || jsonb_build_object('key', 'tickets_open', 'need', 'technical', 'points', 3, 'label', 'Open support tickets', 'detail', format('%s open', v_open));
  end if;
  if v_sms_before >= 50 and v_sms_now < v_sms_before / 2 then
    v_signals := v_signals || jsonb_build_object('key', 'usage_drop', 'need', 'activity', 'points', 5, 'label', 'SMS use dropped',
      'detail', format('%s messages in the last 30 days, %s in the 30 days before', v_sms_now, v_sms_before));
  end if;

  return jsonb_build_object(
    'score', greatest(0, 100 - coalesce((select sum((x ->> 'points')::int) from jsonb_array_elements(v_signals) x), 0)),
    'signals', v_signals,
    'needs', coalesce((select jsonb_agg(distinct x ->> 'need') from jsonb_array_elements(v_signals) x), '[]'::jsonb),
    'facts', jsonb_build_object('orders_14d', v_recent, 'orders_prior_14d', v_prior, 'errors_7d', v_errors, 'open_tickets', v_open,
      'onboarding', jsonb_build_object('done', v_onb -> 'done', 'total', v_onb -> 'total'),
      'subscription', case when s.id is null then null else jsonb_build_object('status', s.status, 'trial_ends_at', s.trial_ends_at,
        'cancel_at_period_end', s.cancel_at_period_end, 'plan', (select code from public.plans where id = s.plan_id)) end));
end;
$$;

create or replace function public.platform_merchant_health(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_need text := nullif(p ->> 'need', '');
  v_band text := nullif(upper(coalesce(p ->> 'band', '')), '');
  v_q text := nullif(trim(coalesce(p ->> 'q', '')), '');
  v_demo boolean := coalesce((p ->> 'include_demo')::boolean, false);
begin
  perform public._platform_require('merchants', 'view');
  return (with h as (
      select m.id, m.number, m.name, m.status, m.is_demo, m.created_at,
        (select coalesce(nullif(trim(ps.full_name), ''), ps.email) from public.platform_staff ps where ps.user_id = m.account_manager_id) as account_manager,
        public._platform_merchant_signals(m.id) as x
      from public.merchants m
      where m.id in (select public._platform_merchant_ids()) and m.status in ('ONBOARDING', 'ACTIVE', 'SUSPENDED') and (v_demo or not m.is_demo)
        and (v_q is null or m.name ilike '%' || v_q || '%' or m.number::text = ltrim(v_q, '#'))),
    r as (
      select h.*, (h.x ->> 'score')::int as score,
        case when (h.x ->> 'score')::int >= 80 then 'HEALTHY' when (h.x ->> 'score')::int >= 60 then 'WATCH' else 'AT_RISK' end as band
      from h)
    select jsonb_build_object(
      'summary', (select jsonb_build_object('total', count(*), 'healthy', count(*) filter (where band = 'HEALTHY'),
          'watch', count(*) filter (where band = 'WATCH'), 'at_risk', count(*) filter (where band = 'AT_RISK'),
          'onboarding', count(*) filter (where x -> 'needs' ? 'onboarding'), 'technical', count(*) filter (where x -> 'needs' ? 'technical'),
          'billing', count(*) filter (where x -> 'needs' ? 'billing'), 'activity', count(*) filter (where x -> 'needs' ? 'activity')) from r),
      'rows', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'number', r.number, 'name', r.name, 'status', r.status, 'is_demo', r.is_demo,
            'account_manager', r.account_manager, 'created_at', r.created_at, 'score', r.score, 'band', r.band) || (r.x - 'score')
          order by r.score, r.number), '[]'::jsonb)
        from r where (v_band is null or r.band = v_band) and (v_need is null or r.x -> 'needs' ? v_need)),
      'method', 'Each merchant starts at 100; every signal found takes off the points shown next to it. 80 and above: healthy, 60–79: watch, below 60: at risk. '
        || 'This is an estimate from these signals to decide who to contact — not a churn decision.'));
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Overview: subscriptions, credits, metered usage and costs
-- -----------------------------------------------------------------------------
create or replace function public.platform_overview_business(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_from timestamptz := (p_from::timestamp at time zone 'Asia/Dhaka');
  v_to timestamptz := ((p_to + 1)::timestamp at time zone 'Asia/Dhaka');
  v_real uuid[];
  v_billing boolean := public.platform_can('subscriptions', 'view');
  v_cost numeric := nullif((select (value ->> 'cost_per_segment')::numeric from public.platform_settings where key = 'sms'), 0);
  v_bd_cost numeric := (select (value ->> 'bd_courier_per_lookup')::numeric from public.platform_settings where key = 'cost_assumptions');
begin
  perform public._platform_require('overview', 'view');
  select coalesce(array_agg(id), '{}') into v_real from public.merchants where not is_demo and id in (select public._platform_merchant_ids());
  return jsonb_build_object(
    -- Billing figures only for employees allowed to see billing.
    'billing', case when v_billing then (select jsonb_build_object(
        'mrr', coalesce(sum(case s.billing_interval when 'YEAR' then s.price / 12 else s.price end) filter (where s.status in ('ACTIVE', 'PAST_DUE')), 0),
        'active', count(*) filter (where s.status = 'ACTIVE'),
        'trialing', count(*) filter (where s.status = 'TRIALING'),
        'past_due', count(*) filter (where s.status = 'PAST_DUE'),
        'paused', count(*) filter (where s.status = 'PAUSED'),
        'trials_ending_7d', count(*) filter (where s.status = 'TRIALING' and s.trial_ends_at < now() + interval '7 days'),
        'cancelling', count(*) filter (where s.cancel_at_period_end),
        'cancelled_in_range', (select count(*) from public.subscriptions x where x.merchant_id = any (v_real) and x.status in ('CANCELLED', 'EXPIRED')
                               and x.ended_at >= v_from and x.ended_at < v_to),
        'revenue_in_range', (select coalesce(sum(p.amount), 0) from public.billing_payments p where p.status = 'SUCCEEDED' and p.merchant_id = any (v_real)
                             and coalesce(p.verified_at, p.created_at) >= v_from and coalesce(p.verified_at, p.created_at) < v_to),
        'subscription_revenue_in_range', (select coalesce(sum(p.amount), 0) from public.billing_payments p join public.billing_invoices i on i.id = p.invoice_id
                             where p.status = 'SUCCEEDED' and i.kind = 'SUBSCRIPTION' and p.merchant_id = any (v_real)
                               and coalesce(p.verified_at, p.created_at) >= v_from and coalesce(p.verified_at, p.created_at) < v_to),
        'overdue_invoices', (select count(*) from public.billing_invoices i where i.status = 'OPEN' and i.due_at < now() and i.merchant_id = any (v_real)),
        'failed_payments', (select count(*) from public.billing_payments p where p.status in ('FAILED', 'REJECTED') and p.merchant_id = any (v_real)
                            and p.created_at >= v_from and p.created_at < v_to))
      from public.subscriptions s where s.ended_at is null and s.merchant_id = any (v_real)) end,
    'credits', jsonb_build_object(
      'sms_outstanding', (select coalesce(sum(balance), 0) from public.credit_balances where credit_type = 'SMS' and merchant_id in (select public._platform_merchant_ids())),
      'courier_outstanding', (select coalesce(sum(balance), 0) from public.credit_balances where credit_type = 'COURIER' and merchant_id in (select public._platform_merchant_ids()))),
    'metered', (select jsonb_build_object(
        'sms_units', coalesce(sum(units) filter (where service = 'SMS' and status = 'SUCCEEDED' and refunded_at is null), 0),
        'sms_free_units', coalesce(sum(units) filter (where service = 'SMS' and status = 'SUCCEEDED' and refunded_at is null and charge = 'FREE'), 0),
        'bd_lookups', count(*) filter (where service = 'BD_COURIER' and status = 'SUCCEEDED'),
        'bd_failed', count(*) filter (where service = 'BD_COURIER' and status = 'FAILED'),
        'bd_refused', count(*) filter (where service = 'BD_COURIER' and status = 'DENIED'),
        'provider_cost_reported', coalesce(sum(provider_cost), 0),
        'provider_cost_estimated', case
          when v_cost is null and coalesce(sum(units) filter (where service = 'SMS' and status = 'SUCCEEDED' and provider_cost is null), 0) > 0 then null
          when v_bd_cost is null and count(*) filter (where service = 'BD_COURIER' and status = 'SUCCEEDED') > 0 then null
          else coalesce(sum(units) filter (where service = 'SMS' and status = 'SUCCEEDED' and provider_cost is null), 0) * coalesce(v_cost, 0)
             + count(*) filter (where service = 'BD_COURIER' and status = 'SUCCEEDED') * coalesce(v_bd_cost, 0) end)
      from public.service_usage where merchant_id in (select public._platform_merchant_ids()) and created_at >= v_from and created_at < v_to),
    'services', jsonb_build_object('sms_connected', public._platform_service_connected('SMS'), 'bd_courier_connected', public._platform_service_connected('BD_COURIER')),
    'support', jsonb_build_object(
      'open', (select count(*) from public.support_tickets where status in ('OPEN', 'IN_PROGRESS') and merchant_id in (select public._platform_merchant_ids())),
      'overdue', (select count(*) from public.support_tickets where status in ('OPEN', 'IN_PROGRESS') and due_at < now() and merchant_id in (select public._platform_merchant_ids())),
      'urgent', (select count(*) from public.support_tickets where status in ('OPEN', 'IN_PROGRESS') and priority = 'URGENT' and merchant_id in (select public._platform_merchant_ids()))),
    'growth', (select coalesce(jsonb_agg(jsonb_build_object('month', mo::date,
        'new', (select count(*) from public.merchants where id = any (v_real) and created_at >= mo and created_at < mo + interval '1 month'),
        'churned', (select count(*) from public.subscriptions s where s.merchant_id = any (v_real) and s.price > 0 and s.status in ('CANCELLED', 'EXPIRED')
                    and s.ended_at >= mo and s.ended_at < mo + interval '1 month'),
        'active', (select count(distinct o.merchant_id) from public.orders o where o.merchant_id = any (v_real) and o.created_at >= mo and o.created_at < mo + interval '1 month'))
        order by mo), '[]'::jsonb)
      from generate_series(date_trunc('month', now()) - interval '5 months', date_trunc('month', now()), interval '1 month') mo));
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Grants, global tables, exemptions
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
               'credit_types', 'credit_packages', 'platform_notifications', 'support_ticket_events', 'platform_cost_entries']
$$;

do $$
declare
  f text;
begin
  foreach f in array array['platform_cost_assumptions_save(jsonb,text)', 'platform_cost_entry_add(jsonb)', 'platform_cost_entries_list(date,date)',
    'platform_business_report(date,date)', 'platform_usage_overview(date,date)', 'platform_merchant_health(jsonb)', 'platform_overview_business(date,date)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['_platform_cost_assumptions()', '_platform_merchant_signals(uuid)'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;

insert into public.tenancy_exempt_functions (name, reason)
select f, 'Usage & Analytics: platform-wide figures for platform staff, permission-checked'
from unnest(array['_platform_cost_assumptions', 'platform_cost_assumptions_save', 'platform_cost_entry_add', 'platform_cost_entries_list',
  'platform_business_report', 'platform_usage_overview', '_platform_merchant_signals', 'platform_merchant_health', 'platform_overview_business']) f
on conflict (name) do nothing;

select public._tenancy_own_functions();
