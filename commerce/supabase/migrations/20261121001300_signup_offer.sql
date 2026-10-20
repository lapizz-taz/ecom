-- New businesses: a short free trial, then the first month at an introductory price, then the
-- plan's normal price (e.g. 2 days free, 99 Tk for the first month, then 990 Tk a month).
--
-- Super Admin sets it under Subscriptions & Plans (platform setting 'signup_offer'); it applies
-- to businesses that sign up (or are activated after WhatsApp sign-up) while it is on, and only
-- to paid plans. The first invoice after the trial is at the introductory price; later invoices
-- are at the plan price as before. When the trial ends unpaid the account is in the new access
-- state TRIAL_ENDED (Blocked by default: "pay to continue"), until the first invoice is paid.
--
-- Also: the billing settings could be saved with an empty number, and the hourly billing run
-- then failed on it ("invalid input syntax for type integer"). Empty values read as the
-- default now, and the settings are checked when saved.

create or replace function pg_temp.lf(p text) returns text
language sql immutable as $$ select replace(p, E'\r', '') $$;

alter table public.subscriptions
  add column if not exists intro_price numeric(12, 2),
  add column if not exists intro_until timestamptz;
comment on column public.subscriptions.intro_price is 'Introductory price (new-business offer) for invoices of periods starting before intro_until';
comment on column public.subscriptions.intro_until is 'End of the introductory price (the trial end plus the offer''s periods)';

insert into public.platform_settings (key, value, description) values
  ('signup_offer', jsonb_build_object('enabled', false, 'trial_days', 2, 'first_price', 99, 'first_periods', 1),
   'New businesses: free trial days, then the first period(s) at an introductory price, then the plan price')
on conflict (key) do nothing;

update public.platform_settings set value = value || jsonb_build_object('TRIAL_ENDED', 'BLOCKED')
where key = 'access_rules' and not value ? 'TRIAL_ENDED';

-- What a new business on a plan at this price gets (null when the offer is off or the plan is free).
create or replace function public._signup_offer_for(p_price numeric)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  -- The offer as set (switched off unless Super Admin turned it on).
  o jsonb := jsonb_build_object('enabled', false, 'trial_days', 0, 'first_price', null, 'first_periods', 1)
    || coalesce((select value from public.platform_settings where key = 'signup_offer'), '{}'::jsonb);
  v_price numeric := nullif(o ->> 'first_price', '')::numeric;
begin
  if coalesce((o ->> 'enabled')::boolean, false) is not true or coalesce(p_price, 0) <= 0 then
    return null;
  end if;
  return jsonb_build_object(
    'trial_days', greatest(coalesce(nullif(o ->> 'trial_days', '')::int, 0), 0),
    -- Only a price below the plan's is an offer.
    'first_price', case when v_price is not null and v_price >= 0 and v_price < p_price then v_price end,
    'first_periods', greatest(coalesce(nullif(o ->> 'first_periods', '')::int, 1), 1));
end;
$$;

-- Puts a new business's first subscription on the offer: the offer's trial, then the
-- introductory price for the first period(s).
create or replace function public._signup_offer_apply(p_sub_id uuid, p_plan_price numeric)
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
    current_period_end = case when v_days > 0 then null else now() end,
    intro_price = (o ->> 'first_price')::numeric,
    intro_until = case when o ->> 'first_price' is not null
                       then v_start + public._billing_interval(p_sub.billing_interval) * (o ->> 'first_periods')::int end
  where id = p_sub.id
  returning * into s;
  perform public._subscription_event(s, 'offer.applied', jsonb_build_object('trial_days', v_days, 'first_price', s.intro_price,
    'first_periods', (o ->> 'first_periods')::int, 'intro_until', s.intro_until));
  return s;
end;
$$;

-- Sign-up: the offer, before the activation step (which raises the first invoice when there is no trial).
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.merchant_self_onboard(jsonb)'::regprocedure));
  v_from text := $a$  returning * into v_sub;
  insert into public.subscription_events (merchant_id, subscription_id, event, detail, actor_id)$a$;
  v_to text := $b$  returning * into v_sub;
  v_sub := public._signup_offer_apply(v_sub.id, v_plan.price);
  insert into public.subscription_events (merchant_id, subscription_id, event, detail, actor_id)$b$;
begin
  if position('_signup_offer_apply' in v_old) > 0 then
    return;
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'signup offer: merchant_self_onboard has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

-- WhatsApp sign-up: the trial starts when the platform team activates the business.
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.platform_merchant_activate(uuid,text)'::regprocedure));
  v_from text := $a$      where id = s.id returning * into s;
    end if;$a$;
  v_to text := $b$      where id = s.id returning * into s;
      s := public._signup_offer_apply(s.id, v_plan.price);
    end if;$b$;
begin
  if position('_signup_offer_apply' in v_old) > 0 then
    return;
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'signup offer: platform_merchant_activate has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

-- The first invoice after the trial is at the introductory price.
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public._billing_invoice_for(public.subscriptions,timestamptz,timestamptz)'::regprocedure));
  v_from text := $a$  v_lines := v_lines || jsonb_build_object('label', format('%s plan, %s – %s', v_plan.name, to_char(p_start, 'DD Mon YYYY'), to_char(p_end, 'DD Mon YYYY')),
    'amount', p_sub.price, 'kind', 'plan');
  v_total := p_sub.price;$a$;
  v_to text := $b$  if p_sub.intro_price is not null and p_sub.intro_until is not null and p_start < p_sub.intro_until then
    v_lines := v_lines || jsonb_build_object('label', format('%s plan, %s – %s (introductory price; then %s)', v_plan.name, to_char(p_start, 'DD Mon YYYY'),
      to_char(p_end, 'DD Mon YYYY'), trim(to_char(p_sub.price, 'FM999,999,990.##')) || ' ' || p_sub.currency),
      'amount', p_sub.intro_price, 'kind', 'plan', 'intro', true, 'regular_price', p_sub.price);
    v_total := p_sub.intro_price;
  else
    v_lines := v_lines || jsonb_build_object('label', format('%s plan, %s – %s', v_plan.name, to_char(p_start, 'DD Mon YYYY'), to_char(p_end, 'DD Mon YYYY')),
      'amount', p_sub.price, 'kind', 'plan');
    v_total := p_sub.price;
  end if;$b$;
begin
  if position('intro_price' in v_old) > 0 then
    return;
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'signup offer: _billing_invoice_for has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

-- Trial over and the first invoice unpaid: its own access state (pay to continue).
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.merchant_access_mode(uuid)'::regprocedure));
  v_from text := $a$    when s.status = 'PAST_DUE' and s.grace_until is not null and s.grace_until < now() then 'PAST_DUE_AFTER_GRACE'$a$;
  v_to text := $b$    when s.status = 'PAST_DUE' and s.intro_until is not null and s.current_period_end is null then 'TRIAL_ENDED'
    when s.status = 'PAST_DUE' and s.grace_until is not null and s.grace_until < now() then 'PAST_DUE_AFTER_GRACE'$b$;
begin
  if position('TRIAL_ENDED' in v_old) > 0 then
    return;
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'signup offer: merchant_access_mode has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

-- With no rule saved for it, a trial that ended unpaid waits for the payment (Blocked).
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.merchant_access_mode(uuid)'::regprocedure));
  v_from text := $a$  v_b := coalesce(v_rules ->> v_sub_key, 'FULL');$a$;
  v_to text := $b$  v_b := coalesce(v_rules ->> v_sub_key, case when v_sub_key = 'TRIAL_ENDED' then 'BLOCKED' else 'FULL' end);$b$;
begin
  if position($c$v_sub_key = 'TRIAL_ENDED'$c$ in v_old) > 0 then
    return;
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'signup offer: merchant_access_mode default has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

-- The plan page: the introductory price and until when.
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.my_plan()'::regprocedure));
  v_from text := $a$      'cancel_at_period_end', s.cancel_at_period_end,$a$;
  v_to text := $b$      'cancel_at_period_end', s.cancel_at_period_end, 'intro_price', s.intro_price, 'intro_until', s.intro_until,$b$;
begin
  if position('intro_price' in v_old) > 0 then
    return;
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'signup offer: my_plan has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

-- The sign-up page: each plan's trial and introductory price under the offer.
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.public_signup_options()'::regprocedure));
  v_from text := $a$        'billing_interval', pl.billing_interval, 'trial_days', pl.trial_days, 'limits', pl.limits,$a$;
  v_to text := $b$        'billing_interval', pl.billing_interval, 'trial_days', coalesce((public._signup_offer_for(pl.price) ->> 'trial_days')::int, pl.trial_days),
        'offer', public._signup_offer_for(pl.price), 'limits', pl.limits,$b$;
begin
  if position('_signup_offer_for' in v_old) > 0 then
    return;
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'signup offer: public_signup_options has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

-- Super Admin: the offer, checked.
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
  v_value := jsonb_build_object('enabled', coalesce((p_value ->> 'enabled')::boolean, false), 'trial_days', v_days::int,
    'first_price', v_price::numeric, 'first_periods', v_periods::int);
  insert into public.platform_settings (key, value, updated_by) values ('signup_offer', v_value, auth.uid())
  on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now();
  perform public._config_version('platform_setting', 'signup_offer', v_value, p_reason);
  perform public._platform_log('settings.signup_offer', null, 'platform_setting', 'signup_offer', p_reason, v_before, v_value);
  return v_value;
end;
$$;

-- Settings: the offer through its own checks; billing numbers checked (an empty one broke the billing run).
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.platform_setting_save(text,jsonb,text)'::regprocedure));
  v_from text := $a$  if p_key = 'signup' then
    return public.platform_signup_settings_save(p_value, p_reason);
  end if;$a$;
  v_to text := $b$  if p_key = 'signup' then
    return public.platform_signup_settings_save(p_value, p_reason);
  end if;
  if p_key = 'signup_offer' then
    return public.platform_signup_offer_save(p_value, p_reason);
  end if;
  if p_key = 'billing' then
    foreach k in array array['grace_days', 'invoice_due_days', 'expire_after_days'] loop
      if coalesce(p_value ->> k, '') !~ '^[0-9]{1,3}$' then
        raise exception 'VALIDATION: % is a number of days', replace(k, '_', ' ') using errcode = '22023';
      end if;
      p_value := jsonb_set(p_value, array[k], to_jsonb((p_value ->> k)::int));
    end loop;
    if (p_value ->> 'expire_after_days')::int < 1 then
      raise exception 'VALIDATION: expire unpaid after at least 1 day' using errcode = '22023';
    end if;
  end if;$b$;
begin
  if position('platform_signup_offer_save' in v_old) > 0 then
    return;
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'signup offer: platform_setting_save has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

-- An empty billing number reads as its default everywhere it is read.
do $$
declare
  r record;
  v_old text;
  v_new text;
  k text;
begin
  for r in
    select p.oid::regprocedure as sig from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
      and p.prosrc ~ '->> ''(grace_days|invoice_due_days|expire_after_days)''\)::int'
  loop
    v_old := pg_temp.lf(pg_get_functiondef(r.sig));
    v_new := v_old;
    foreach k in array array['grace_days', 'invoice_due_days', 'expire_after_days'] loop
      v_new := replace(v_new, format('(value ->> %L)::int', k), format('nullif(value ->> %L, '''')::int', k));
      v_new := replace(v_new, format('(v_cfg ->> %L)::int', k), format('nullif(v_cfg ->> %L, '''')::int', k));
    end loop;
    if v_new <> v_old then
      execute v_new;
    end if;
  end loop;
end $$;

-- The values saved empty go back to their defaults.
update public.platform_settings
set value = (select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) from jsonb_each(value) e where e.value <> '""'::jsonb)
where key = 'billing' and exists (select 1 from jsonb_each(value) e where e.value = '""'::jsonb);

revoke all on function public._signup_offer_for(numeric), public._signup_offer_apply(uuid, numeric)
  from public, anon, authenticated;
revoke all on function public.platform_signup_offer_save(jsonb, text) from public, anon;
grant execute on function public.platform_signup_offer_save(jsonb, text) to authenticated;

insert into public.tenancy_exempt_functions (name, reason) values
  ('_signup_offer_for', 'Reads the platform new-business offer for one plan (platform tables, no merchant data)'),
  ('_signup_offer_apply', 'Sign-up / activation: puts the new business''s first subscription on the offer; called with that row by trusted functions only'),
  ('platform_signup_offer_save', 'Super Admin: platform-wide new-business offer (no merchant data)')
on conflict (name) do nothing;

select public._tenancy_own_functions();
