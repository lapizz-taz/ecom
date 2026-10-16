-- =============================================================================
-- Onboarding methods, verified activation, renewals and expiry reminders
--
-- Super Admin chooses how a new business that signs up gets going
-- (platform setting 'onboarding'):
--   * online_payment: a paid plan without a trial is paid at sign-up with
--     bKash / PayStation. The admin stays closed until the gateway confirms the
--     payment server to server (billing_gateway_confirm → _billing_apply_payment);
--     a success page or anything the browser sends never opens it.
--   * whatsapp: the business sends a prefilled WhatsApp message to the official
--     number and the platform team activates it by hand (Super Admin →
--     Subscriptions → Waiting for activation).
-- Plans with a trial start the trial at once under online_payment, as before.
--
-- Renewals: "Renew now" raises the next period's invoice early; paying it
-- extends the period. Reminders: on the days before the period (or trial) ends
-- that Super Admin sets (default 3 and 1), the merchant's admin shows
-- "Expires in N days" and platform staff get a notification.
-- =============================================================================

insert into public.platform_settings (key, value, description) values
  ('onboarding', jsonb_build_object(
     'method', 'online_payment',
     'whatsapp_number', null,
     'whatsapp_template', E'Hello Fullfilio, I have just signed up and would like my account activated.\nBusiness: {business}\nName: {name}\nMobile: {phone}\nE-mail: {email}\nPlan: {plan} ({price} / {interval})',
     'reminder_days', jsonb_build_array(3, 1)),
   'How new businesses are activated (online payment or WhatsApp) and when expiry reminders go out')
on conflict (key) do nothing;

create or replace function public._onboarding_settings()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object('method', 'online_payment', 'whatsapp_number', null, 'whatsapp_template', '', 'reminder_days', jsonb_build_array(3, 1))
    || coalesce((select value from public.platform_settings where key = 'onboarding'), '{}'::jsonb)
$$;

-- Days before the end of a period (or trial) on which a reminder goes out, largest first.
create or replace function public._reminder_days()
returns int[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(d order by d desc), array[3, 1]) from (
    select distinct (e #>> '{}')::int as d
    from jsonb_array_elements(case when jsonb_typeof(public._onboarding_settings() -> 'reminder_days') = 'array'
                                   then public._onboarding_settings() -> 'reminder_days' else '[]'::jsonb end) e
    where (e #>> '{}') ~ '^[0-9]{1,2}$' and (e #>> '{}')::int between 1 and 30) x
$$;

-- The WhatsApp message for a business, from the Super Admin's template.
create or replace function public._onboarding_message(p_merchant uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tpl text := coalesce(nullif(public._onboarding_settings() ->> 'whatsapp_template', ''),
                         E'Hello Fullfilio, please activate my account.\nBusiness: {business}\nMobile: {phone}');
  m record;
begin
  select mm.name as business, coalesce(nullif(p.full_name, ''), mm.name) as person, mm.phone, mm.owner_email as email,
         pl.name as plan, s.price, s.currency, s.billing_interval
    into m
  from public.merchants mm
  left join public.profiles p on p.merchant_id = mm.id and p.id = mm.created_by
  left join public.subscriptions s on s.merchant_id = mm.id and s.ended_at is null
  left join public.plans pl on pl.id = s.plan_id
  where mm.id = p_merchant;
  return left(replace(replace(replace(replace(replace(replace(replace(v_tpl,
    '{business}', coalesce(m.business, '')), '{name}', coalesce(m.person, '')), '{phone}', coalesce(m.phone, '')),
    '{email}', coalesce(m.email, '')), '{plan}', coalesce(m.plan, '')),
    '{price}', coalesce(trim(to_char(m.price, 'FM999999990.##')) || ' ' || coalesce(m.currency, 'BDT'), '')),
    '{interval}', lower(coalesce(m.billing_interval, 'month'))), 1500);
end;
$$;

-- What a business still needs before its admin opens (null when nothing).
create or replace function public._merchant_activation(p_merchant uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case m.onboarding ->> 'activation'
    when 'awaiting_payment' then jsonb_build_object('state', 'awaiting_payment',
      'invoice_id', (select i.id from public.billing_invoices i where i.merchant_id = m.id and i.kind = 'SUBSCRIPTION' and i.status = 'OPEN'
                     order by i.created_at desc limit 1))
    when 'awaiting_whatsapp' then jsonb_build_object('state', 'awaiting_whatsapp',
      'whatsapp_number', public._onboarding_settings() ->> 'whatsapp_number', 'whatsapp_message', public._onboarding_message(m.id))
    end
  from public.merchants m where m.id = p_merchant
$$;

-- Opens a business that was waiting (after a verified payment, or by Super Admin).
create or replace function public._activation_complete(p_merchant uuid, p_via text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.merchants
  set onboarding = (onboarding - 'activation') || jsonb_build_object('activated_at', now(), 'activated_via', p_via),
      status = case when status = 'ONBOARDING' then 'ACTIVE' else status end
  where id = p_merchant and onboarding ? 'activation';
  return found;
end;
$$;

-- Sign-up: puts the new business on the chosen onboarding method.
create or replace function public._self_onboard_activation(p_merchant uuid, p_sub public.subscriptions, p_plan public.plans)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_method text := coalesce(public._onboarding_settings() ->> 'method', 'online_payment');
  v_inv public.billing_invoices;
begin
  if v_method = 'whatsapp' then
    -- Nothing runs or bills until the platform team activates it.
    update public.subscriptions set status = 'PAUSED', current_period_end = null, trial_ends_at = null where id = p_sub.id;
    update public.merchants set onboarding = onboarding || jsonb_build_object('activation', 'awaiting_whatsapp', 'method', 'whatsapp') where id = p_merchant;
    return public._merchant_activation(p_merchant);
  end if;
  if p_plan.price > 0 and p_sub.status <> 'TRIALING' then
    v_inv := public._billing_invoice_for(p_sub, p_sub.current_period_start, p_sub.current_period_start + public._billing_interval(p_sub.billing_interval));
    if v_inv.status = 'OPEN' then
      update public.merchants set onboarding = onboarding || jsonb_build_object('activation', 'awaiting_payment', 'method', 'online_payment') where id = p_merchant;
      return jsonb_build_object('state', 'awaiting_payment', 'invoice_id', v_inv.id);
    end if;
  end if;
  return null;
end;
$$;

do $$
declare
  v_old text := replace(pg_get_functiondef('public.merchant_self_onboard(jsonb)'::regprocedure), E'\r', '');
  v_from text := $a$  return jsonb_build_object('merchant_id', v_id, 'plan', v_plan.code, 'status', v_sub.status, 'trial_ends_at', v_sub.trial_ends_at);$a$;
  v_to text := $b$  return jsonb_build_object('merchant_id', v_id, 'plan', v_plan.code, 'status', v_sub.status, 'trial_ends_at', v_sub.trial_ends_at,
    'activation', public._self_onboard_activation(v_id, v_sub, v_plan));$b$;
begin
  if position('_self_onboard_activation' in v_old) > 0 then
    return;
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'onboarding methods: merchant_self_onboard has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

-- A business waiting for activation sees only the activation screen.
do $$
declare
  v_old text := replace(pg_get_functiondef('public.merchant_access_mode(uuid)'::regprocedure), E'\r', '');
  v_from text := $a$  if v_status is null or v_status = 'CLOSED' then
    return 'BLOCKED';
  end if;$a$;
  v_to text := $b$  if v_status is null or v_status = 'CLOSED' then
    return 'BLOCKED';
  end if;
  if (select onboarding ->> 'activation' from public.merchants where id = v_id) in ('awaiting_payment', 'awaiting_whatsapp') then
    return 'BLOCKED';
  end if;$b$;
begin
  if position('awaiting_payment' in v_old) > 0 then
    return;
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'onboarding methods: merchant_access_mode has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

-- A gateway-verified subscription payment opens a business that was waiting for it.
do $$
declare
  v_old text := replace(pg_get_functiondef('public._billing_apply_payment(public.billing_payments)'::regprocedure), E'\r', '');
  v_from text := $a$      perform public._subscription_event(s, 'invoice.paid', jsonb_build_object('invoice', v_inv.number));$a$;
  v_to text := $b$      perform public._subscription_event(s, 'invoice.paid', jsonb_build_object('invoice', v_inv.number));
      if public._activation_complete(v_inv.merchant_id, 'payment') then
        perform public._subscription_event(s, 'subscription.activated', jsonb_build_object('via', 'payment', 'invoice', v_inv.number));
      end if;$b$;
begin
  if position('_activation_complete' in v_old) > 0 then
    return;
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'onboarding methods: _billing_apply_payment has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

-- The plan page tells the merchant what activation is waiting for, and when to renew.
do $$
declare
  v_old text := replace(pg_get_functiondef('public.my_plan()'::regprocedure), E'\r', '');
  v_from text := $a$    'merchant', (select jsonb_build_object('name', name, 'status', status, 'status_reason', status_reason) from public.merchants where id = v_merchant),$a$;
  v_to text := $b$    'merchant', (select jsonb_build_object('name', name, 'status', status, 'status_reason', status_reason) from public.merchants where id = v_merchant),
    'activation', public._merchant_activation(v_merchant),
    'reminder_days', to_jsonb(public._reminder_days()),$b$;
begin
  if position('_merchant_activation' in v_old) > 0 then
    return;
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'onboarding methods: my_plan has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

-- Reminders before a period or trial ends: once per day-mark, to platform staff (the
-- merchant's admin shows its own banner from my_plan).
create or replace function public._billing_reminders()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_days int[] := public._reminder_days();
  v_max int := coalesce(v_days[1], 3);
  r record;
  v_left int;
  v_n int := 0;
begin
  for r in
    select s.*, m.name as merchant_name,
      case when s.status = 'TRIALING' then s.trial_ends_at else s.current_period_end end as ends_at
    from public.subscriptions s join public.merchants m on m.id = s.merchant_id
    where s.ended_at is null and s.status in ('ACTIVE', 'TRIALING') and not s.cancel_at_period_end
      and case when s.status = 'TRIALING' then s.trial_ends_at else s.current_period_end end
          between now() and now() + make_interval(days => v_max)
  loop
    v_left := greatest(ceil(extract(epoch from (r.ends_at - now())) / 86400)::int, 1);
    continue when not (v_left = any(v_days));
    continue when exists (select 1 from public.subscription_events e where e.subscription_id = r.id and e.event = 'reminder.sent'
                          and e.detail ->> 'days' = v_left::text and (e.detail ->> 'ends_at')::timestamptz = r.ends_at);
    insert into public.subscription_events (merchant_id, subscription_id, event, detail)
    values (r.merchant_id, r.id, 'reminder.sent', jsonb_build_object('days', v_left, 'ends_at', r.ends_at, 'trial', r.status = 'TRIALING'));
    perform public._platform_notify('subscriptions', 'view', r.merchant_id, 'subscription.expiring', 'INFO',
      format('%s: %s in %s day%s', r.merchant_name, case when r.status = 'TRIALING' then 'trial ends' else 'plan expires' end, v_left, case when v_left = 1 then '' else 's' end),
      format('Ends %s. The merchant sees a renewal reminder in their admin.', to_char(r.ends_at, 'DD Mon YYYY HH24:MI')),
      '/super-admin/subscriptions', format('expiring:%s:%s:%s', r.id, r.ends_at, v_left));
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

do $$
declare
  v_old text := replace(pg_get_functiondef('public.billing_run()'::regprocedure), E'\r', '');
  v_from text := $a$  return v;
end;$a$;
  v_to text := $b$  v := v || jsonb_build_object('reminders', public._billing_reminders());
  return v;
end;$b$;
begin
  if position('_billing_reminders' in v_old) > 0 then
    return;
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'onboarding methods: billing_run has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

-- "Renew now": the invoice for the next period (or the open one when overdue).
create or replace function public.billing_renew_now()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_merchant uuid := public.current_merchant_id();
  s public.subscriptions;
  v_inv public.billing_invoices;
  v_start timestamptz;
begin
  if not public.billing_can_pay() then
    raise exception 'PERMISSION_DENIED: only the owner or staff who manage settings can pay for the business' using errcode = '42501';
  end if;
  select * into s from public.subscriptions where merchant_id = v_merchant and ended_at is null for update;
  if s.id is null or s.status not in ('ACTIVE', 'TRIALING', 'PAST_DUE') then
    raise exception 'VALIDATION: there is no running plan to renew; choose a plan in Plan & Billing' using errcode = '22023';
  end if;
  select * into v_inv from public.billing_invoices
  where subscription_id = s.id and kind = 'SUBSCRIPTION' and status = 'OPEN' order by period_start desc limit 1;
  if v_inv.id is null then
    if s.price <= 0 then
      raise exception 'VALIDATION: this plan is free; nothing to pay' using errcode = '22023';
    end if;
    v_start := case when s.status = 'TRIALING' then coalesce(s.trial_ends_at, now()) else coalesce(s.current_period_end, now()) end;
    v_inv := public._billing_invoice_for(s, v_start, v_start + public._billing_interval(s.billing_interval));
  end if;
  return jsonb_build_object('id', v_inv.id, 'number', v_inv.number, 'total', v_inv.total, 'amount_paid', v_inv.amount_paid,
    'currency', v_inv.currency, 'period_start', v_inv.period_start, 'period_end', v_inv.period_end, 'status', v_inv.status);
end;
$$;

-- Super Admin: the onboarding method, WhatsApp number and message, reminder days.
create or replace function public.platform_onboarding_save(p_value jsonb, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb := public._onboarding_settings();
  v_method text := coalesce(p_value ->> 'method', 'online_payment');
  v_number text := nullif(regexp_replace(coalesce(p_value ->> 'whatsapp_number', ''), '[^0-9+]', '', 'g'), '');
  v_template text := left(coalesce(p_value ->> 'whatsapp_template', ''), 1000);
  v_days jsonb;
  v_value jsonb;
begin
  perform public._platform_require('subscriptions', 'manage');
  if v_method not in ('online_payment', 'whatsapp') then
    raise exception 'VALIDATION: choose online payment or WhatsApp' using errcode = '22023';
  end if;
  if v_number is not null and v_number !~ '^\+?[0-9]{8,15}$' then
    raise exception 'VALIDATION: the WhatsApp number is the full number with country code, e.g. 8801712345678' using errcode = '22023';
  end if;
  if v_method = 'whatsapp' and v_number is null then
    raise exception 'VALIDATION: WhatsApp onboarding needs the official WhatsApp number' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(to_jsonb(d) order by d desc), '[]'::jsonb) into v_days from (
    select distinct (e #>> '{}')::int as d from jsonb_array_elements(coalesce(p_value -> 'reminder_days', '[]'::jsonb)) e
    where (e #>> '{}') ~ '^[0-9]{1,2}$' and (e #>> '{}')::int between 1 and 30) x;
  if jsonb_array_length(v_days) = 0 then
    raise exception 'VALIDATION: give at least one reminder day between 1 and 30' using errcode = '22023';
  end if;
  v_value := jsonb_build_object('method', v_method, 'whatsapp_number', ltrim(v_number, '+'), 'whatsapp_template', v_template, 'reminder_days', v_days);
  insert into public.platform_settings (key, value, updated_by) values ('onboarding', v_value, auth.uid())
  on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now();
  perform public._platform_log('settings.onboarding', null, 'platform_setting', 'onboarding', p_reason, v_before, v_value);
  return v_value;
end;
$$;

-- Super Admin: businesses waiting for activation.
create or replace function public.platform_pending_activations()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._platform_require('subscriptions', 'view');
  return coalesce((select jsonb_agg(jsonb_build_object(
      'merchant_id', m.id, 'name', m.name, 'owner_email', m.owner_email, 'phone', m.phone,
      'whatsapp', m.onboarding ->> 'whatsapp', 'state', m.onboarding ->> 'activation', 'created_at', m.created_at,
      'plan', (select jsonb_build_object('name', pl.name, 'price', s.price, 'currency', s.currency, 'interval', s.billing_interval, 'trial_days', pl.trial_days)
               from public.subscriptions s join public.plans pl on pl.id = s.plan_id where s.merchant_id = m.id and s.ended_at is null))
    order by m.created_at desc)
    from public.merchants m
    where m.id in (select public._platform_merchant_ids()) and m.onboarding ->> 'activation' in ('awaiting_payment', 'awaiting_whatsapp')), '[]'::jsonb);
end;
$$;

-- Super Admin: activate a business by hand (WhatsApp onboarding, or a payment taken another way).
create or replace function public.platform_merchant_activate(p_merchant uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s public.subscriptions;
  v_plan public.plans;
begin
  perform public._platform_require('subscriptions', 'manage', p_merchant);
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'VALIDATION: say why (for example: paid by bKash to the office number, TrxID …)' using errcode = '22023';
  end if;
  if not exists (select 1 from public.merchants where id = p_merchant and onboarding ->> 'activation' in ('awaiting_payment', 'awaiting_whatsapp')) then
    raise exception 'VALIDATION: this business is not waiting for activation' using errcode = '22023';
  end if;
  perform set_config('app.merchant_id', p_merchant::text, true);
  select * into s from public.subscriptions where merchant_id = p_merchant and ended_at is null for update;
  if s.id is not null then
    select * into v_plan from public.plans where id = s.plan_id;
    if s.status = 'PAUSED' then
      update public.subscriptions set
        status = case when v_plan.trial_days > 0 then 'TRIALING' else 'ACTIVE' end,
        trial_ends_at = case when v_plan.trial_days > 0 then now() + make_interval(days => v_plan.trial_days) end,
        current_period_start = now(),
        current_period_end = case when v_plan.trial_days > 0 then null else now() + public._billing_interval(s.billing_interval) end,
        grace_until = null
      where id = s.id returning * into s;
    end if;
    perform public._subscription_event(s, 'subscription.activated', jsonb_build_object('via', 'super_admin', 'reason', p_reason));
  end if;
  perform public._activation_complete(p_merchant, 'super_admin');
  perform public._platform_log('merchant.activated', p_merchant, 'merchant', p_merchant::text, p_reason, null,
    jsonb_build_object('subscription', s.status));
  perform set_config('app.merchant_id', '', true);
  return jsonb_build_object('merchant_id', p_merchant, 'subscription', s.status);
end;
$$;

-- What the public sign-up page needs to know about onboarding (the official number is public anyway).
do $$
declare
  v_old text := replace(pg_get_functiondef('public.public_signup_options()'::regprocedure), E'\r', '');
  v_from text := $a$    'default_plan', (select value ->> 'default_plan' from public.platform_settings where key = 'billing'),$a$;
  v_to text := $b$    'default_plan', (select value ->> 'default_plan' from public.platform_settings where key = 'billing'),
    'onboarding', (select jsonb_build_object('method', o ->> 'method', 'whatsapp_number', o ->> 'whatsapp_number') from (select public._onboarding_settings() as o) x),$b$;
begin
  if position('_onboarding_settings' in v_old) > 0 then
    return;
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'onboarding methods: public_signup_options has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

revoke all on function public._onboarding_settings(), public._reminder_days(), public._onboarding_message(uuid), public._merchant_activation(uuid),
  public._activation_complete(uuid, text), public._self_onboard_activation(uuid, public.subscriptions, public.plans), public._billing_reminders()
  from public, anon, authenticated;
revoke all on function public.billing_renew_now(), public.platform_onboarding_save(jsonb, text), public.platform_pending_activations(),
  public.platform_merchant_activate(uuid, text) from public, anon;
grant execute on function public.billing_renew_now(), public.platform_onboarding_save(jsonb, text), public.platform_pending_activations(),
  public.platform_merchant_activate(uuid, text) to authenticated;

insert into public.tenancy_exempt_functions (name, reason) values
  ('_onboarding_settings', 'Reads the platform onboarding setting (platform table, no merchant data)'),
  ('_reminder_days', 'Reads the platform reminder days'),
  ('_onboarding_message', 'Builds one business''s WhatsApp message; called with a merchant id by trusted functions only'),
  ('_merchant_activation', 'What one business still needs before activation; called with a merchant id by trusted functions only'),
  ('_activation_complete', 'Opens one waiting business after a verified payment or a Super Admin activation; not callable by users'),
  ('_self_onboard_activation', 'Sign-up: marks the new business as waiting for payment or WhatsApp activation'),
  ('_billing_reminders', 'Scheduled: expiry reminders across all subscriptions (part of billing_run)'),
  ('billing_renew_now', 'The caller''s own business only (current merchant, billing_can_pay): raises the next invoice'),
  ('platform_onboarding_save', 'Super Admin: platform-wide onboarding setting (no merchant data)'),
  ('platform_pending_activations', 'Super Admin: businesses waiting for activation, limited to the staff member''s merchants'),
  ('platform_merchant_activate', 'Super Admin: activates one business by hand, with a reason, logged')
on conflict (name) do nothing;

select public._tenancy_own_functions();
