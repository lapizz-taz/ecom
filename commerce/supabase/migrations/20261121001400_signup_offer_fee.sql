-- New-business offer, part 2: an optional one-time fee, and the offer without a free trial.
--
-- e.g. pay 99 Tk to start (first month), then a one-time 1,000 Tk fee with the first month at
-- the plan's price, then the plan's price. The fee is added once, to the first invoice at the
-- plan's price; it counts as charged only while that invoice is not voided (a replaced
-- invoice puts it on the next one). Without a trial, online sign-up already waits for the
-- first payment before the admin opens; a WhatsApp sign-up the platform team activates is
-- taken as paid for the first period (as for plans without a trial).

create or replace function pg_temp.lf(p text) returns text
language sql immutable as $$ select replace(p, E'\r', '') $$;

alter table public.subscriptions add column if not exists setup_fee numeric(12, 2);
comment on column public.subscriptions.setup_fee is 'One-time fee (new-business offer), added to the first invoice at the plan price';

create or replace function public._signup_offer_for(p_price numeric)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  -- The offer as set (switched off unless Super Admin turned it on).
  o jsonb := jsonb_build_object('enabled', false, 'trial_days', 0, 'first_price', null, 'first_periods', 1, 'setup_fee', null)
    || coalesce((select value from public.platform_settings where key = 'signup_offer'), '{}'::jsonb);
  v_price numeric := nullif(o ->> 'first_price', '')::numeric;
  v_fee numeric := nullif(o ->> 'setup_fee', '')::numeric;
begin
  if coalesce((o ->> 'enabled')::boolean, false) is not true or coalesce(p_price, 0) <= 0 then
    return null;
  end if;
  return jsonb_build_object(
    'trial_days', greatest(coalesce(nullif(o ->> 'trial_days', '')::int, 0), 0),
    -- Only a price below the plan's is an offer.
    'first_price', case when v_price is not null and v_price >= 0 and v_price < p_price then v_price end,
    'first_periods', greatest(coalesce(nullif(o ->> 'first_periods', '')::int, 1), 1),
    'setup_fee', case when v_fee > 0 then v_fee end);
end;
$$;

-- p_prepaid: the platform team activated the business (paid to them), so without a trial the
-- first period runs at once instead of waiting for an invoice.
drop function if exists public._signup_offer_apply(uuid, numeric);
create or replace function public._signup_offer_apply(p_sub_id uuid, p_plan_price numeric, p_prepaid boolean default false)
returns public.subscriptions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o jsonb := public._signup_offer_for(p_plan_price);
  v_days int;
  v_start timestamptz;
  p_sub public.subscriptions;
  s public.subscriptions;
begin
  select * into p_sub from public.subscriptions where id = p_sub_id;
  if o is null or p_sub.id is null or p_sub.status not in ('TRIALING', 'ACTIVE') then
    return p_sub;
  end if;
  v_days := (o ->> 'trial_days')::int;
  v_start := now() + make_interval(days => v_days);
  update public.subscriptions set
    status = case when v_days > 0 then 'TRIALING' else 'ACTIVE' end,
    trial_ends_at = case when v_days > 0 then v_start end,
    current_period_start = now(),
    -- Without a trial the first invoice is due now (like a paid plan without a trial).
    current_period_end = case when v_days > 0 then null
                              when p_prepaid then now() + public._billing_interval(p_sub.billing_interval) else now() end,
    intro_price = (o ->> 'first_price')::numeric,
    intro_until = case when o ->> 'first_price' is not null
                       then v_start + public._billing_interval(p_sub.billing_interval) * (o ->> 'first_periods')::int end,
    setup_fee = (o ->> 'setup_fee')::numeric
  where id = p_sub.id
  returning * into s;
  perform public._subscription_event(s, 'offer.applied', jsonb_build_object('trial_days', v_days, 'first_price', s.intro_price,
    'first_periods', (o ->> 'first_periods')::int, 'intro_until', s.intro_until, 'setup_fee', s.setup_fee, 'prepaid', p_prepaid));
  return s;
end;
$$;

-- WhatsApp sign-up: the team's activation is the first payment.
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.platform_merchant_activate(uuid,text)'::regprocedure));
  v_from text := $a$      s := public._signup_offer_apply(s.id, v_plan.price);$a$;
  v_to text := $b$      s := public._signup_offer_apply(s.id, v_plan.price, true);$b$;
begin
  if position('_signup_offer_apply(s.id, v_plan.price, true)' in v_old) > 0 then
    return;
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'signup offer fee: platform_merchant_activate has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

-- The one-time fee on the first invoice at the plan's price.
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public._billing_invoice_for(public.subscriptions,timestamptz,timestamptz)'::regprocedure));
  v_from text := $a$      'amount', p_sub.price, 'kind', 'plan');
    v_total := p_sub.price;
  end if;$a$;
  v_to text := $b$      'amount', p_sub.price, 'kind', 'plan');
    v_total := p_sub.price;
    if coalesce(p_sub.setup_fee, 0) > 0 and not exists (
         select 1 from public.billing_invoices i where i.subscription_id = p_sub.id and i.status <> 'VOID'
           and i.lines @> '[{"kind": "setup_fee"}]'::jsonb) then
      v_lines := v_lines || jsonb_build_object('label', 'One-time setup fee', 'amount', p_sub.setup_fee, 'kind', 'setup_fee');
      v_total := v_total + p_sub.setup_fee;
    end if;
  end if;$b$;
begin
  if position('setup_fee' in v_old) > 0 then
    return;
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'signup offer fee: _billing_invoice_for has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

-- The plan page: the one-time fee still to come.
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.my_plan()'::regprocedure));
  v_from text := $a$'intro_price', s.intro_price, 'intro_until', s.intro_until,$a$;
  v_to text := $b$'intro_price', s.intro_price, 'intro_until', s.intro_until,
      'setup_fee_pending', case when coalesce(s.setup_fee, 0) > 0 and not exists (
        select 1 from public.billing_invoices i where i.subscription_id = s.id and i.status <> 'VOID'
          and i.lines @> '[{"kind": "setup_fee"}]'::jsonb) then s.setup_fee end,$b$;
begin
  if position('setup_fee_pending' in v_old) > 0 then
    return;
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'signup offer fee: my_plan has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

-- Super Admin: the offer, checked (now with the one-time fee).
create or replace function public.platform_signup_offer_save(p_value jsonb, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb := (select value from public.platform_settings where key = 'signup_offer');
  v_days text := nullif(trim(coalesce(p_value ->> 'trial_days', '')), '');
  v_price text := nullif(trim(coalesce(p_value ->> 'first_price', '')), '');
  v_periods text := nullif(trim(coalesce(p_value ->> 'first_periods', '')), '');
  v_fee text := nullif(trim(coalesce(p_value ->> 'setup_fee', '')), '');
  v_value jsonb;
begin
  perform public._platform_require('subscriptions', 'manage');
  if v_days is null or v_days !~ '^[0-9]{1,3}$' or v_days::int > 90 then
    raise exception 'VALIDATION: the free trial is 0 to 90 days' using errcode = '22023';
  end if;
  if v_price is not null and (v_price !~ '^[0-9]{1,7}(\.[0-9]{1,2})?$') then
    raise exception 'VALIDATION: the first month price is an amount in Tk (or leave it empty for the plan price)' using errcode = '22023';
  end if;
  if v_periods is null or v_periods !~ '^[0-9]{1,2}$' or v_periods::int not between 1 and 12 then
    raise exception 'VALIDATION: the introductory price lasts 1 to 12 months' using errcode = '22023';
  end if;
  if v_fee is not null and (v_fee !~ '^[0-9]{1,7}(\.[0-9]{1,2})?$') then
    raise exception 'VALIDATION: the one-time fee is an amount in Tk (or leave it empty for none)' using errcode = '22023';
  end if;
  v_value := jsonb_build_object('enabled', coalesce((p_value ->> 'enabled')::boolean, false), 'trial_days', v_days::int,
    'first_price', v_price::numeric, 'first_periods', v_periods::int, 'setup_fee', nullif(v_fee::numeric, 0));
  insert into public.platform_settings (key, value, updated_by) values ('signup_offer', v_value, auth.uid())
  on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now();
  perform public._config_version('platform_setting', 'signup_offer', v_value, p_reason);
  perform public._platform_log('settings.signup_offer', null, 'platform_setting', 'signup_offer', p_reason, v_before, v_value);
  return v_value;
end;
$$;

revoke all on function public._signup_offer_for(numeric), public._signup_offer_apply(uuid, numeric, boolean)
  from public, anon, authenticated;

select public._tenancy_own_functions();
