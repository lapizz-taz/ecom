-- =============================================================================
-- Two ways to join, each switched on or off in Super Admin → Global settings
-- (platform setting 'signup'):
--   * enabled           — normal sign-up: the visitor creates their own login
--                         and opens the business at once (as before).
--   * whatsapp.enabled  — sign-up by WhatsApp: the visitor only fills in the
--                         business details; nothing is created. The details
--                         are kept as a sign-up request and the visitor sends
--                         them to the official WhatsApp number (Super Admin →
--                         Subscriptions → Onboarding) in a prefilled message.
--                         The platform team then creates the business from the
--                         request (Merchants → New, prefilled).
-- Requests are platform data (no merchant yet): only platform staff with the
-- merchants module read or change them, and only through these functions.
-- =============================================================================

create table if not exists public.signup_requests (
  id uuid primary key default gen_random_uuid(),
  business_name text not null check (length(business_name) between 2 and 120),
  full_name text not null check (length(full_name) between 2 and 100),
  phone text not null check (phone ~ '^01[3-9][0-9]{8}$'),
  whatsapp text check (whatsapp is null or whatsapp ~ '^\+?[0-9]{8,15}$'),
  email text check (email is null or (length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  business_type text check (business_type is null or length(business_type) <= 60),
  website text check (website is null or length(website) <= 200),
  sells_on text[] not null default '{}' check (cardinality(sells_on) <= 10),
  orders_per_month text check (orders_per_month is null or length(orders_per_month) <= 30),
  plan_code text check (plan_code is null or length(plan_code) <= 60),
  message text not null,
  status text not null default 'NEW' check (status in ('NEW', 'CONTACTED', 'CONVERTED', 'DECLINED')),
  merchant_id uuid references public.merchants(id) on delete set null,
  note text check (note is null or length(note) <= 1000),
  handled_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists signup_requests_created_idx on public.signup_requests (created_at desc);
create index if not exists signup_requests_phone_idx on public.signup_requests (phone, created_at desc);
alter table public.signup_requests enable row level security;
revoke all on public.signup_requests from anon, authenticated;

-- A platform table (no merchant yet), like platform_contact_messages.
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
               'platform_contact_messages', 'account_removals', 'signup_requests']
$$;

-- The 'signup' setting keeps its old shape ({enabled}) and gains the WhatsApp switch and message.
create or replace function public._platform_signup_settings()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'enabled', coalesce(s ->> 'enabled', 'true') <> 'false',
    'whatsapp', jsonb_build_object(
      'enabled', coalesce(s #>> '{whatsapp,enabled}', 'false') = 'true',
      'template', coalesce(nullif(s #>> '{whatsapp,template}', ''),
        E'Hello Fullfilio, I would like to open an account.\nBusiness: {business}\nName: {name}\nMobile: {phone}\nWhatsApp: {whatsapp}\nE-mail: {email}\nBusiness type: {type}\nSells on: {sells_on}\nOrders per month: {orders}\nPlan: {plan}\nRequest: {ref}')))
  from (select coalesce((select value from public.platform_settings where key = 'signup'), '{}'::jsonb) as s) x
$$;

-- The official WhatsApp number (set with the onboarding method), digits only.
create or replace function public._platform_signup_whatsapp()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select nullif(regexp_replace(coalesce(public._onboarding_settings() ->> 'whatsapp_number', ''), '[^0-9]', '', 'g'), '')
$$;

-- Super Admin: both switches and the WhatsApp message (through platform_setting_save('signup', …)).
create or replace function public.platform_signup_settings_save(p_value jsonb, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb := public._platform_signup_settings();
  v_enabled boolean := coalesce((p_value ->> 'enabled')::boolean, (v_before ->> 'enabled')::boolean);
  v_wa boolean := coalesce((p_value #>> '{whatsapp,enabled}')::boolean, (v_before #>> '{whatsapp,enabled}')::boolean);
  v_template text := left(coalesce(p_value #>> '{whatsapp,template}', v_before #>> '{whatsapp,template}', ''), 1000);
  v_value jsonb;
begin
  perform public._platform_require('settings', 'edit');
  if v_wa and public._platform_signup_whatsapp() is null then
    raise exception 'VALIDATION: set the official WhatsApp number first (Subscriptions → Onboarding)' using errcode = '22023';
  end if;
  v_value := jsonb_build_object('enabled', v_enabled, 'whatsapp', jsonb_build_object('enabled', v_wa, 'template', v_template));
  insert into public.platform_settings (key, value, updated_by) values ('signup', v_value, auth.uid())
  on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by;
  perform public._config_version('platform_setting', 'signup', v_value, p_reason);
  perform public._platform_log('settings.changed', null, 'platform_setting', 'signup', p_reason, v_before, v_value);
  return v_value;
end;
$$;

-- The generic settings save sends 'signup' to the function above.
do $$
declare
  v_old text := replace(pg_get_functiondef('public.platform_setting_save(text, jsonb, text)'::regprocedure), E'\r', '');
  v_from text := $a$  if p_key = 'voicedrive' then$a$;
  v_to text := $b$  if p_key = 'signup' then
    return public.platform_signup_settings_save(p_value, p_reason);
  end if;
  if p_key = 'voicedrive' then$b$;
begin
  if position('platform_signup_settings_save' in v_old) > 0 then
    return;
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'signup requests: platform_setting_save has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

-- The public page learns whether each way is open (and the number, so the visitor knows where the message goes).
do $$
declare
  v_old text := replace(pg_get_functiondef('public.public_signup_options()'::regprocedure), E'\r', '');
  v_from text := $a$    'enabled', coalesce((select value ->> 'enabled' from public.platform_settings where key = 'signup'), 'true') <> 'false',$a$;
  v_to text := $b$    'enabled', coalesce((select value ->> 'enabled' from public.platform_settings where key = 'signup'), 'true') <> 'false',
    'whatsapp_signup', jsonb_build_object(
      'enabled', (public._platform_signup_settings() #>> '{whatsapp,enabled}') = 'true' and public._platform_signup_whatsapp() is not null,
      'number', public._platform_signup_whatsapp()),$b$;
begin
  if position('whatsapp_signup' in v_old) > 0 then
    return;
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'signup requests: public_signup_options has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

-- Public: keeps a sign-up request and returns the WhatsApp message to send.
-- No login is created. The same mobile within 30 minutes updates its request
-- instead of adding another; at most 60 new requests an hour in all.
create or replace function public.public_signup_request(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cfg jsonb := public._platform_signup_settings();
  v_number text := public._platform_signup_whatsapp();
  v_name text := left(trim(coalesce(p ->> 'business_name', '')), 120);
  v_person text := left(trim(coalesce(p ->> 'full_name', '')), 100);
  v_phone text := public.normalize_phone(nullif(trim(coalesce(p ->> 'phone', '')), ''));
  v_wa text := nullif(regexp_replace(coalesce(p ->> 'whatsapp', ''), '[^0-9+]', '', 'g'), '');
  v_email text := nullif(lower(trim(coalesce(p ->> 'email', ''))), '');
  v_type text := nullif(left(trim(coalesce(p ->> 'business_type', '')), 60), '');
  v_site text := nullif(left(trim(coalesce(p ->> 'website', '')), 200), '');
  v_orders text := nullif(left(trim(coalesce(p ->> 'orders_per_month', '')), 30), '');
  v_plan public.plans;
  v_sells text[];
  v_id uuid;
  v_msg text;
begin
  if not ((v_cfg #>> '{whatsapp,enabled}') = 'true' and v_number is not null) then
    raise exception 'VALIDATION: sign-up by WhatsApp is not open right now' using errcode = '22023';
  end if;
  if length(v_name) < 2 then raise exception 'VALIDATION: enter the business name' using errcode = '22023'; end if;
  if length(v_person) < 2 then raise exception 'VALIDATION: enter your name' using errcode = '22023'; end if;
  if v_phone is null or v_phone !~ '^01[3-9][0-9]{8}$' then
    raise exception 'VALIDATION: enter a Bangladeshi mobile number (01XXXXXXXXX)' using errcode = '22023';
  end if;
  if v_wa is not null and v_wa !~ '^\+?[0-9]{8,15}$' then
    raise exception 'VALIDATION: enter the WhatsApp number with its country code, or leave it empty' using errcode = '22023';
  end if;
  if v_email is not null and (length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    raise exception 'VALIDATION: enter a valid e-mail address, or leave it empty' using errcode = '22023';
  end if;
  select coalesce(array_agg(left(trim(x), 40)), '{}') into v_sells
  from (select x from jsonb_array_elements_text(case when jsonb_typeof(p -> 'sells_on') = 'array' then p -> 'sells_on' else '[]'::jsonb end) x
        where trim(x) <> '' limit 10) s;
  select * into v_plan from public.plans where code = nullif(p ->> 'plan_code', '') and status = 'ACTIVE' and is_public;

  select id into v_id from public.signup_requests
  where phone = v_phone and status = 'NEW' and created_at > now() - interval '30 minutes'
  order by created_at desc limit 1 for update;
  if v_id is null and (select count(*) from public.signup_requests where created_at > now() - interval '1 hour') >= 60 then
    raise exception 'RATE_LIMITED: too many sign-up requests right now; please try again in a few minutes' using errcode = 'P0001';
  end if;
  v_id := coalesce(v_id, gen_random_uuid());

  v_msg := left(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(v_cfg #>> '{whatsapp,template}',
    '{business}', v_name), '{name}', v_person), '{phone}', v_phone), '{whatsapp}', coalesce(v_wa, v_phone)),
    '{email}', coalesce(v_email, '—')), '{type}', coalesce(v_type, '—')), '{sells_on}', coalesce(nullif(array_to_string(v_sells, ', '), ''), '—')),
    '{orders}', coalesce(v_orders, '—')),
    '{plan}', coalesce(v_plan.name || case when v_plan.price > 0 then format(' (%s %s / %s)', trim(to_char(v_plan.price, 'FM999999990.##')), v_plan.currency, lower(v_plan.billing_interval)) else '' end, '—')),
    '{ref}', upper(left(replace(v_id::text, '-', ''), 8))), 1500);

  insert into public.signup_requests (id, business_name, full_name, phone, whatsapp, email, business_type, website, sells_on, orders_per_month, plan_code, message)
  values (v_id, v_name, v_person, v_phone, v_wa, v_email, v_type, v_site, v_sells, v_orders, v_plan.code, v_msg)
  on conflict (id) do update set business_name = excluded.business_name, full_name = excluded.full_name, whatsapp = excluded.whatsapp,
    email = excluded.email, business_type = excluded.business_type, website = excluded.website, sells_on = excluded.sells_on,
    orders_per_month = excluded.orders_per_month, plan_code = excluded.plan_code, message = excluded.message, updated_at = now();

  perform public._platform_notify('merchants', 'view', null, 'signup.request', 'INFO',
    format('Sign-up request: %s', v_name), format('%s · %s. They were sent to WhatsApp to message the official number.', v_person, v_phone),
    '/super-admin/subscriptions', 'signup-request:' || v_id);
  return jsonb_build_object('id', v_id, 'reference', upper(left(replace(v_id::text, '-', ''), 8)), 'whatsapp_number', v_number, 'message', v_msg);
end;
$$;

-- Super Admin: the requests, newest first.
create or replace function public.platform_signup_requests(p_status text default null, p_limit int default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._platform_require('merchants', 'view');
  return coalesce((select jsonb_agg(to_jsonb(r) - 'handled_by' || jsonb_build_object(
      'reference', upper(left(replace(r.id::text, '-', ''), 8)),
      'merchant_name', (select m.name from public.merchants m where m.id = r.merchant_id)) order by r.created_at desc)
    from (select * from public.signup_requests
          where p_status is null or status = p_status
          order by created_at desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) r), '[]'::jsonb);
end;
$$;

-- Super Admin: mark a request (contacted, declined, or opened as a business).
create or replace function public.platform_signup_request_update(p_id uuid, p_status text, p_merchant uuid default null, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.signup_requests;
begin
  perform public._platform_require('merchants', case when p_status = 'CONVERTED' then 'create' else 'edit' end);
  if p_status not in ('NEW', 'CONTACTED', 'CONVERTED', 'DECLINED') then
    raise exception 'VALIDATION: unknown status' using errcode = '22023';
  end if;
  if p_status = 'CONVERTED' and (p_merchant is null or not exists (select 1 from public.merchants where id = p_merchant)) then
    raise exception 'VALIDATION: choose the business that was opened for this request' using errcode = '22023';
  end if;
  update public.signup_requests set status = p_status, merchant_id = case when p_status = 'CONVERTED' then p_merchant else merchant_id end,
    note = coalesce(nullif(left(trim(coalesce(p_note, '')), 1000), ''), note), handled_by = auth.uid(), updated_at = now()
  where id = p_id returning * into r;
  if r.id is null then
    raise exception 'NOT_FOUND: request not found' using errcode = 'P0002';
  end if;
  perform public._platform_log('signup_request.' || lower(p_status), p_merchant, 'signup_request', p_id::text, p_note, null,
    jsonb_build_object('status', p_status, 'business', r.business_name));
  return to_jsonb(r) - 'handled_by';
end;
$$;

revoke all on function public._platform_signup_settings(), public._platform_signup_whatsapp() from public, anon, authenticated;
revoke all on function public.platform_signup_settings_save(jsonb, text), public.platform_signup_requests(text, int),
  public.platform_signup_request_update(uuid, text, uuid, text), public.public_signup_request(jsonb) from public, anon;
grant execute on function public.platform_signup_settings_save(jsonb, text), public.platform_signup_requests(text, int),
  public.platform_signup_request_update(uuid, text, uuid, text) to authenticated;
grant execute on function public.public_signup_request(jsonb) to anon, authenticated;

insert into public.tenancy_exempt_functions (name, reason) values
  ('_platform_signup_settings', 'Reads the platform sign-up setting (platform table, no merchant data)'),
  ('_platform_signup_whatsapp', 'Reads the official WhatsApp number from the platform onboarding setting'),
  ('platform_signup_settings_save', 'Super Admin: platform-wide sign-up switches (no merchant data)'),
  ('public_signup_request', 'Public sign-up by WhatsApp: keeps a request (no merchant yet) and returns the message to send'),
  ('platform_signup_requests', 'Super Admin: sign-up requests (platform data, before any merchant exists)'),
  ('platform_signup_request_update', 'Super Admin: marks a sign-up request; links the business opened for it')
on conflict (name) do nothing;
