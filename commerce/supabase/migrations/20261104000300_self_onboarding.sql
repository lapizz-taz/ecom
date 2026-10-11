-- =============================================================================
-- Self-service sign-up.
--
-- A new business opens its own account from the public "Start" page:
-- 1. it signs up with e-mail and password (Supabase Auth sends the
--    confirmation e-mail when the project asks for one);
-- 2. once the e-mail is confirmed, merchant_self_onboard() creates the
--    business with its defaults, makes the person its Owner and starts the
--    chosen public plan (its trial when the plan has one).
-- It runs once per person: someone who already belongs to a business (or is
-- platform staff) cannot open another one this way. The Super Admin can close
-- public sign-up (platform setting "signup"); new businesses appear in the
-- panel as onboarding, like ones created there.
-- =============================================================================

insert into public.platform_settings (key, value, description) values
  ('signup', jsonb_build_object('enabled', true),
   'Public sign-up: new businesses can open their own account and start a plan')
on conflict (key) do nothing;

-- What the public page shows: whether sign-up is open, and the plans to choose from.
create or replace function public.public_signup_options()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'enabled', coalesce((select value ->> 'enabled' from public.platform_settings where key = 'signup'), 'true') <> 'false',
    'default_plan', (select value ->> 'default_plan' from public.platform_settings where key = 'billing'),
    'order_fee', (select case when coalesce(value ->> 'enabled', 'false') = 'true'
                    then jsonb_build_object('fee', (value ->> 'fee')::numeric, 'free_per_month', coalesce((value ->> 'free_per_month')::int, 0)) end
                  from public.platform_settings where key = 'order_fee'),
    'plans', coalesce((select jsonb_agg(jsonb_build_object(
        'code', pl.code, 'name', pl.name, 'description', pl.description, 'price', pl.price, 'currency', pl.currency,
        'billing_interval', pl.billing_interval, 'trial_days', pl.trial_days, 'limits', pl.limits,
        'features', coalesce((select jsonb_agg(f.name order by f.sort_order, f.name) from public.features f
                              where not f.is_core and f.globally_enabled and coalesce((pl.features ->> f.code)::boolean, false)), '[]'::jsonb))
      order by pl.sort_order, pl.price)
      from public.plans pl where pl.status = 'ACTIVE' and pl.is_public), '[]'::jsonb))
$$;

create or replace function public.merchant_self_onboard(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_user record;
  -- Open unless the Super Admin set it to false.
  v_open boolean := coalesce((select value ->> 'enabled' from public.platform_settings where key = 'signup'), 'true') <> 'false';
  v_plan public.plans;
  v_name text := trim(coalesce(p ->> 'business_name', ''));
  v_full_name text := nullif(trim(coalesce(p ->> 'full_name', '')), '');
  v_phone text := public.normalize_phone(nullif(trim(coalesce(p ->> 'phone', '')), ''));
  v_website text := nullif(trim(coalesce(p ->> 'website', '')), '');
  v_id uuid;
  v_role uuid;
  v_sub public.subscriptions;
begin
  if v_uid is null then
    raise exception 'PERMISSION_DENIED: sign in first' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('self-onboard:' || v_uid, 0));
  -- Already done (a second tab, a retry): the same business, nothing new.
  select merchant_id into v_id from public.profiles where id = v_uid;
  if v_id is not null then
    return jsonb_build_object('merchant_id', v_id, 'already', true);
  end if;
  if not v_open then
    raise exception 'VALIDATION: new sign-ups are closed at the moment; contact us to open an account' using errcode = '22023';
  end if;
  select id, email, email_confirmed_at, raw_user_meta_data into v_user from auth.users where id = v_uid;
  if v_user.email_confirmed_at is null then
    raise exception 'VALIDATION: confirm your e-mail address first; the link is in your inbox' using errcode = '22023';
  end if;
  if exists (select 1 from public.platform_staff where user_id = v_uid) then
    raise exception 'VALIDATION: platform staff accounts cannot open a business; use another e-mail' using errcode = '22023';
  end if;
  if length(v_name) < 2 or length(v_name) > 120 then
    raise exception 'VALIDATION: enter your business name (2 to 120 characters)' using errcode = '22023';
  end if;
  if v_phone is null or v_phone !~ '^01[3-9][0-9]{8}$' then
    raise exception 'VALIDATION: enter a Bangladesh mobile number (01XXXXXXXXX)' using errcode = '22023';
  end if;
  if v_website is not null and v_website !~* '^(https?://)?[a-z0-9.-]+\.[a-z]{2,}(/.*)?$' then
    raise exception 'VALIDATION: the website address does not look right' using errcode = '22023';
  end if;
  select * into v_plan from public.plans
  where code = upper(coalesce(nullif(p ->> 'plan_code', ''), (select value ->> 'default_plan' from public.platform_settings where key = 'billing')))
    and status = 'ACTIVE' and is_public;
  if v_plan.id is null then
    raise exception 'VALIDATION: choose one of the plans shown' using errcode = '22023';
  end if;

  insert into public.merchants (name, status, owner_email, phone, business_type, website, created_by, onboarding)
  values (v_name, 'ONBOARDING', lower(v_user.email), v_phone, nullif(left(trim(coalesce(p ->> 'business_type', '')), 60), ''), v_website, v_uid,
          jsonb_build_object('started_at', now(), 'by', v_uid, 'self_signup', true,
            'sells_on', coalesce(p -> 'sells_on', '[]'::jsonb), 'orders_per_month', nullif(p ->> 'orders_per_month', '')))
  returning id into v_id;

  -- The Owner role and profile come first: from then on the person belongs to
  -- the new business, so its defaults are seeded in its own context.
  insert into public.roles (merchant_id, code, name, description, is_system, rank)
  values (v_id, 'OWNER', 'Owner', 'Full access to everything', true, 100)
  returning id into v_role;
  insert into public.profiles (id, merchant_id, email, full_name, phone, role_id, is_active)
  values (v_uid, v_id, v_user.email, coalesce(v_full_name, v_user.raw_user_meta_data ->> 'full_name', ''), v_phone, v_role, true);
  perform public._merchant_seed_defaults(v_id);
  update public.settings set value = value || jsonb_build_object('name', v_name, 'phone', v_phone, 'email', lower(v_user.email))
  where merchant_id = v_id and key = 'store';

  insert into public.subscriptions (merchant_id, plan_id, status, price, currency, billing_interval, trial_ends_at,
                                    current_period_start, current_period_end, created_by)
  values (v_id, v_plan.id, case when v_plan.trial_days > 0 then 'TRIALING' else 'ACTIVE' end, v_plan.price, v_plan.currency, v_plan.billing_interval,
          case when v_plan.trial_days > 0 then now() + make_interval(days => v_plan.trial_days) end, now(),
          -- Free plans run a full period; a paid plan without a trial is due now (its first invoice is raised at once).
          case when v_plan.trial_days > 0 then null when v_plan.price = 0 then now() + public._billing_interval(v_plan.billing_interval) else now() end,
          v_uid)
  returning * into v_sub;
  insert into public.subscription_events (merchant_id, subscription_id, event, detail, actor_id)
  values (v_id, v_sub.id, 'subscription.started', jsonb_build_object('plan', v_plan.code, 'trial', v_sub.status = 'TRIALING', 'reason', 'Self sign-up'), v_uid);
  perform public.log_audit('merchant.self_signup', 'merchant', v_id::text, null, jsonb_build_object('name', v_name, 'plan', v_plan.code));
  perform public._platform_log('merchant.self_signup', v_id, 'merchant', v_id::text, null, null,
    jsonb_build_object('name', v_name, 'plan', v_plan.code, 'email', lower(v_user.email)));
  return jsonb_build_object('merchant_id', v_id, 'plan', v_plan.code, 'status', v_sub.status, 'trial_ends_at', v_sub.trial_ends_at);
end;
$$;

revoke execute on function public.public_signup_options() from public;
grant execute on function public.public_signup_options() to anon, authenticated;
revoke execute on function public.merchant_self_onboard(jsonb) from public, anon;
grant execute on function public.merchant_self_onboard(jsonb) to authenticated;

insert into public.tenancy_exempt_functions (name, reason) values
  ('public_signup_options', 'Public sign-up page: whether sign-up is open and the public plans (no merchant data)'),
  ('merchant_self_onboard', 'The signed-in person opens their own business once: creates the merchant, its defaults, their Owner profile and the plan')
on conflict (name) do nothing;

select public._tenancy_own_functions();
