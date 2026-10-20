-- New-business offer, part 3: a paid trial, and "pay to continue" after the offer.
--
-- e.g. pay 99 Tk for a 2-day trial (nothing opens before it is paid), then, to continue, the
-- one-time 1,000 Tk fee with the first month at the plan's price, then the plan's price.
-- The trial price is held like an introductory price (intro_price, until intro_until) with
-- intro_trial set. When the offer's period ends, the first invoice at the plan's price must be
-- paid to continue: the account is TRIAL_ENDED (Blocked by default) until then, not in grace.

-- Text is compared without carriage returns (a script pasted on Windows has CRLF line ends).
create or replace function pg_temp.lf(p text) returns text
language sql immutable as $$ select replace(p, E'\r', '') $$;

alter table public.subscriptions add column if not exists intro_trial boolean not null default false;
comment on column public.subscriptions.intro_trial is 'The introductory price paid for a trial of days (new-business offer), not for month(s)';

create or replace function public._signup_offer_for(p_price numeric)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  -- The offer as set (switched off unless Super Admin turned it on).
  o jsonb := jsonb_build_object('enabled', false, 'trial_days', 0, 'trial_price', null, 'first_price', null, 'first_periods', 1, 'setup_fee', null)
    || coalesce((select value from public.platform_settings where key = 'signup_offer'), '{}'::jsonb);
  v_days int := greatest(coalesce(nullif(o ->> 'trial_days', '')::int, 0), 0);
  v_trial numeric := nullif(o ->> 'trial_price', '')::numeric;
  v_price numeric := nullif(o ->> 'first_price', '')::numeric;
  v_fee numeric := nullif(o ->> 'setup_fee', '')::numeric;
begin
  if coalesce((o ->> 'enabled')::boolean, false) is not true or coalesce(p_price, 0) <= 0 then
    return null;
  end if;
  return jsonb_build_object(
    'trial_days', v_days,
    -- A paid trial: below the plan's price, and only with trial days.
    'trial_price', case when v_days > 0 and v_trial > 0 and v_trial < p_price then v_trial end,
    -- Only a price below the plan's is an offer.
    'first_price', case when v_price is not null and v_price >= 0 and v_price < p_price then v_price end,
    'first_periods', greatest(coalesce(nullif(o ->> 'first_periods', '')::int, 1), 1),
    'setup_fee', case when v_fee > 0 then v_fee end);
end;
$$;

-- p_prepaid: the platform team activated the business (paid to them), so the paid trial, or
-- without a trial the first period, runs at once instead of waiting for an invoice.
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
  if o ->> 'trial_price' is not null then
    -- The trial is paid for: its invoice is due now (the admin opens once it is paid).
    update public.subscriptions set
      status = 'ACTIVE', trial_ends_at = null, current_period_start = now(),
      current_period_end = case when p_prepaid then v_start else now() end,
      intro_price = (o ->> 'trial_price')::numeric, intro_until = v_start, intro_trial = true,
      setup_fee = (o ->> 'setup_fee')::numeric
    where id = p_sub.id
    returning * into s;
  else
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
      intro_trial = false,
      setup_fee = (o ->> 'setup_fee')::numeric
    where id = p_sub.id
    returning * into s;
  end if;
  perform public._subscription_event(s, 'offer.applied', jsonb_build_object('trial_days', v_days, 'trial_price', o -> 'trial_price',
    'first_price', o -> 'first_price', 'first_periods', (o ->> 'first_periods')::int, 'intro_until', s.intro_until,
    'setup_fee', s.setup_fee, 'prepaid', p_prepaid));
  return s;
end;
$$;

-- Sign-up: the first invoice covers the paid trial only (up to the end of the offer's price).
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public._self_onboard_activation(uuid,public.subscriptions,public.plans)'::regprocedure));
  v_from text := pg_temp.lf($a$p_sub.current_period_start, p_sub.current_period_start + public._billing_interval(p_sub.billing_interval));$a$);
  v_to text := pg_temp.lf($b$p_sub.current_period_start,
      least(p_sub.current_period_start + public._billing_interval(p_sub.billing_interval), coalesce(p_sub.intro_until, 'infinity'::timestamptz)));$b$);
begin
  if position('p_sub.intro_until' in v_old) > 0 then
    return;
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'signup paid trial: _self_onboard_activation has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

-- The invoice line says "trial" for a paid trial.
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public._billing_invoice_for(public.subscriptions,timestamptz,timestamptz)'::regprocedure));
  v_from text := pg_temp.lf($a$format('%s plan, %s – %s (introductory price; then %s)', v_plan.name, to_char(p_start, 'DD Mon YYYY'),
      to_char(p_end, 'DD Mon YYYY'), trim($a$);
  v_to text := pg_temp.lf($b$format('%s plan, %s – %s (%s; then %s)', v_plan.name, to_char(p_start, 'DD Mon YYYY'),
      to_char(p_end, 'DD Mon YYYY'), case when p_sub.intro_trial then 'trial' else 'introductory price' end, trim($b$);
begin
  if position('p_sub.intro_trial' in v_old) > 0 then
    return;
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'signup paid trial: _billing_invoice_for has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

-- After the offer, the first invoice at the plan's price is paid to continue (no grace period).
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.merchant_access_mode(uuid)'::regprocedure));
  v_from text := pg_temp.lf($a$when s.status = 'PAST_DUE' and s.intro_until is not null and s.current_period_end is null then 'TRIAL_ENDED'$a$);
  v_to text := pg_temp.lf($b$when s.status = 'PAST_DUE' and s.intro_until is not null
         and (s.current_period_end is null or s.current_period_end <= s.intro_until) then 'TRIAL_ENDED'$b$);
begin
  if position('s.current_period_end <= s.intro_until' in v_old) > 0 then
    return;
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'signup paid trial: merchant_access_mode has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

-- The plan page: whether the introductory price is a paid trial.
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.my_plan()'::regprocedure));
  v_from text := pg_temp.lf($a$'intro_price', s.intro_price, 'intro_until', s.intro_until,$a$);
  v_to text := pg_temp.lf($b$'intro_price', s.intro_price, 'intro_until', s.intro_until, 'intro_trial', s.intro_trial,$b$);
begin
  if position('intro_trial' in v_old) > 0 then
    return;
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'signup paid trial: my_plan has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

-- Super Admin: the offer, checked (now with the trial price).
create or replace function public.platform_signup_offer_save(p_value jsonb, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb := (select value from public.platform_settings where key = 'signup_offer');
  v_days text := nullif(trim(coalesce(p_value ->> 'trial_days', '')), '');
  v_trial text := nullif(trim(coalesce(p_value ->> 'trial_price', '')), '');
  v_price text := nullif(trim(coalesce(p_value ->> 'first_price', '')), '');
  v_periods text := nullif(trim(coalesce(p_value ->> 'first_periods', '')), '');
  v_fee text := nullif(trim(coalesce(p_value ->> 'setup_fee', '')), '');
  v_value jsonb;
begin
  perform public._platform_require('subscriptions', 'manage');
  if v_days is null or v_days !~ '^[0-9]{1,3}$' or v_days::int > 90 then
    raise exception 'VALIDATION: the trial is 0 to 90 days' using errcode = '22023';
  end if;
  if v_trial is not null and (v_trial !~ '^[0-9]{1,7}(\.[0-9]{1,2})?$') then
    raise exception 'VALIDATION: the trial price is an amount in Tk (or leave it empty for a free trial)' using errcode = '22023';
  end if;
  if nullif(v_trial::numeric, 0) is not null and v_days::int = 0 then
    raise exception 'VALIDATION: a trial price needs trial days' using errcode = '22023';
  end if;
  if v_price is not null and (v_price !~ '^[0-9]{1,7}(\.[0-9]{1,2})?$') then
    raise exception 'VALIDATION: the first month price is an amount in Tk (or leave it empty for the plan price)' using errcode = '22023';
  end if;
  if nullif(v_trial::numeric, 0) is not null and v_price is not null then
    raise exception 'VALIDATION: set a trial price or a first month price, not both' using errcode = '22023';
  end if;
  if v_periods is null or v_periods !~ '^[0-9]{1,2}$' or v_periods::int not between 1 and 12 then
    raise exception 'VALIDATION: the introductory price lasts 1 to 12 months' using errcode = '22023';
  end if;
  if v_fee is not null and (v_fee !~ '^[0-9]{1,7}(\.[0-9]{1,2})?$') then
    raise exception 'VALIDATION: the one-time fee is an amount in Tk (or leave it empty for none)' using errcode = '22023';
  end if;
  v_value := jsonb_build_object('enabled', coalesce((p_value ->> 'enabled')::boolean, false), 'trial_days', v_days::int,
    'trial_price', nullif(v_trial::numeric, 0), 'first_price', v_price::numeric, 'first_periods', v_periods::int,
    'setup_fee', nullif(v_fee::numeric, 0));
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
