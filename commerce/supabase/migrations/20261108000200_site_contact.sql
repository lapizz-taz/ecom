-- =============================================================================
-- Contact form on the Fullfilio website. Anyone can send a message (with an
-- e-mail or phone number to reply to); only Super Admin staff with the support
-- module can read and handle them. Messages are platform-wide, not tied to a
-- business, so the table is listed with the other platform tables.
-- =============================================================================

create table public.platform_contact_messages (
  id bigint generated always as identity primary key,
  name text not null check (char_length(name) between 2 and 100),
  email text check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone text check (phone is null or phone ~ '^[+0-9 -]{6,20}$'),
  business text check (business is null or char_length(business) <= 120),
  topic text not null default 'GENERAL' check (topic in ('SALES', 'SUPPORT', 'PARTNERSHIP', 'GENERAL')),
  message text not null check (char_length(message) between 10 and 4000),
  page text check (page is null or char_length(page) <= 200),
  status text not null default 'NEW' check (status in ('NEW', 'REPLIED', 'CLOSED')),
  note text check (note is null or char_length(note) <= 2000),
  handled_by uuid,
  handled_at timestamptz,
  created_at timestamptz not null default now(),
  constraint platform_contact_messages_reply_to check (email is not null or phone is not null)
);
create index platform_contact_messages_created_idx on public.platform_contact_messages (created_at desc);
alter table public.platform_contact_messages enable row level security;
-- No policies: the table is reached only through the functions below.

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
               'platform_contact_messages']
$$;

/** Website contact form: anyone may send; a few messages per address per hour. */
create or replace function public.platform_contact_submit(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text := trim(coalesce(p ->> 'name', ''));
  v_email text := nullif(lower(trim(coalesce(p ->> 'email', ''))), '');
  v_phone text := nullif(trim(coalesce(p ->> 'phone', '')), '');
  v_message text := trim(coalesce(p ->> 'message', ''));
  v_topic text := upper(coalesce(nullif(trim(p ->> 'topic'), ''), 'GENERAL'));
  v_id bigint;
begin
  if char_length(v_name) < 2 then
    raise exception 'VALIDATION: enter your name' using errcode = '22023';
  end if;
  if v_email is null and v_phone is null then
    raise exception 'VALIDATION: enter an e-mail address or a phone number so we can reply' using errcode = '22023';
  end if;
  if v_email is not null and v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'VALIDATION: this e-mail address does not look right' using errcode = '22023';
  end if;
  if v_phone is not null and v_phone !~ '^[+0-9 -]{6,20}$' then
    raise exception 'VALIDATION: this phone number does not look right' using errcode = '22023';
  end if;
  if char_length(v_message) < 10 then
    raise exception 'VALIDATION: tell us a little more (at least 10 characters)' using errcode = '22023';
  end if;
  if v_topic not in ('SALES', 'SUPPORT', 'PARTNERSHIP', 'GENERAL') then v_topic := 'GENERAL'; end if;
  -- Flood protection: per reply address, and overall.
  if (select count(*) from public.platform_contact_messages
      where created_at > now() - interval '1 hour'
        and ((v_email is not null and email = v_email) or (v_phone is not null and phone = v_phone))) >= 3
     or (select count(*) from public.platform_contact_messages where created_at > now() - interval '10 minutes') >= 60 then
    raise exception 'RATE_LIMITED: we already have your message; we will reply soon' using errcode = 'P0001';
  end if;
  insert into public.platform_contact_messages (name, email, phone, business, topic, message, page)
  values (left(v_name, 100), v_email, v_phone, nullif(left(trim(coalesce(p ->> 'business', '')), 120), ''), v_topic,
          left(v_message, 4000), nullif(left(trim(coalesce(p ->> 'page', '')), 200), ''))
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end;
$$;

/** Super Admin: website messages, newest first. */
create or replace function public.platform_contact_messages_list(p_status text default null, p_limit int default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._platform_require('support', 'view');
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(to_jsonb(m) order by m.created_at desc) from (
      select * from public.platform_contact_messages
      where p_status is null or status = p_status
      order by created_at desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) m), '[]'::jsonb),
    'new', (select count(*) from public.platform_contact_messages where status = 'NEW'));
end;
$$;

/** Super Admin: mark a message replied or closed, with an optional note. */
create or replace function public.platform_contact_message_update(p_id bigint, p_status text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  m public.platform_contact_messages;
begin
  perform public._platform_require('support', 'edit');
  if p_status not in ('NEW', 'REPLIED', 'CLOSED') then
    raise exception 'VALIDATION: choose new, replied or closed' using errcode = '22023';
  end if;
  update public.platform_contact_messages
  set status = p_status, note = coalesce(nullif(trim(p_note), ''), note), handled_by = auth.uid(), handled_at = now()
  where id = p_id returning * into m;
  if m.id is null then
    raise exception 'NOT_FOUND: message not found' using errcode = 'P0002';
  end if;
  perform public._platform_log('contact.update', null, 'contact_message', p_id::text, null, null, jsonb_build_object('status', p_status));
  return to_jsonb(m);
end;
$$;

grant execute on function public.platform_contact_submit(jsonb) to anon, authenticated;
grant execute on function public.platform_contact_messages_list(text, int), public.platform_contact_message_update(bigint, text, text) to authenticated;

insert into public.tenancy_exempt_functions (name, reason) values
  ('platform_contact_submit', 'Website contact form: platform-wide messages, not merchant data'),
  ('platform_contact_messages_list', 'Super Admin: website messages'),
  ('platform_contact_message_update', 'Super Admin: website messages')
on conflict (name) do nothing;

select public._tenancy_own_functions();
