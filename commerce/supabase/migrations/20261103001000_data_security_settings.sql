-- =============================================================================
-- Security Center, Data Management and Global Settings.
--
-- Security: platform staff sessions end after a set number of hours (checked
-- on every platform permission check, so it holds for the database and the
-- edge functions alike); a security manager can sign a staff member out
-- everywhere; an access review lists staff, their sign-ins, sessions and
-- second factors, and the platform credentials with their age.
-- Data: exports are recorded; operational logs follow a retention policy
-- (audit logs, ledgers, invoices and orders are kept); merchant data deletion
-- requests need a second person to approve, a cooling-off period, a closed
-- account and a typed confirmation before personal data is erased — financial
-- records are kept. Import errors and restore tests are visible.
-- Settings: every platform setting goes through its own validated function;
-- automation rules can be rolled back like other configuration.
-- =============================================================================

insert into public.platform_settings (key, value, description) values
  ('security', '{"staff_session_hours": 24}'::jsonb, 'Platform staff sign in again after this many hours'),
  ('retention', '{"system_logs_days": 90, "notifications_days": 90, "deletion_cooling_days": 14}'::jsonb,
   'How long resolved system log entries and read staff notifications are kept, and the wait before an approved erasure')
on conflict (key) do nothing;

-- -----------------------------------------------------------------------------
-- 1. Administrative sessions
-- -----------------------------------------------------------------------------
-- Is the caller's sign-in session still allowed to use the panel? A session
-- that was signed out (or revoked here) no longer exists; one older than the
-- limit has expired. Tokens without a session (server code) are not limited.
create or replace function public._platform_session_ok()
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_sid uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  v_hours int := nullif((select value ->> 'staff_session_hours' from public.platform_settings where key = 'security'), '')::int;
  v_started timestamptz;
begin
  if v_sid is null then
    return true;
  end if;
  select created_at into v_started from auth.sessions where id = v_sid;
  if not found then
    return false;
  end if;
  return v_hours is null or v_started > now() - make_interval(hours => v_hours);
end;
$$;

create or replace function public.platform_can(p_module text, p_action text, p_merchant uuid default null)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.platform_staff s
    join public.platform_roles r on r.id = s.role_id
    where s.user_id = auth.uid()
      and s.is_active
      and coalesce(auth.jwt() ->> 'role', '') = 'authenticated'
      and (r.is_super or exists (select 1 from public.platform_role_permissions rp
                                 where rp.role_id = r.id and rp.module = p_module and rp.action = p_action))
      and (p_merchant is null or r.is_super or s.merchant_scope = 'ALL'
           or exists (select 1 from public.platform_staff_merchants sm where sm.user_id = s.user_id and sm.merchant_id = p_merchant))
  ) and public._platform_session_ok()
$$;

create or replace function public._platform_require(p_module text, p_action text, p_merchant uuid default null)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.platform_can(p_module, p_action, p_merchant) then
    if not public._platform_session_ok() and exists (select 1 from public.platform_staff where user_id = auth.uid() and is_active) then
      raise exception 'SESSION_EXPIRED: your Super Admin session has ended — sign in again' using errcode = '42501';
    end if;
    raise exception 'PERMISSION_DENIED: % % is not allowed%', p_module, p_action,
      case when p_merchant is null then '' else ' for this merchant' end using errcode = '42501';
  end if;
end;
$$;

create or replace function public.platform_me()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s public.platform_staff;
  r public.platform_roles;
  v_sid uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  v_started timestamptz;
  v_hours int := nullif((select value ->> 'staff_session_hours' from public.platform_settings where key = 'security'), '')::int;
begin
  select * into s from public.platform_staff where user_id = auth.uid() and is_active;
  if s.user_id is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' then
    return null;
  end if;
  if v_sid is not null then
    select created_at into v_started from auth.sessions where id = v_sid;
  end if;
  -- The panel signs out and explains; nothing else is returned.
  if not public._platform_session_ok() then
    return jsonb_build_object('user_id', s.user_id, 'email', s.email, 'session_expired', true);
  end if;
  select * into r from public.platform_roles where id = s.role_id;
  update public.platform_staff set last_seen_at = now() where user_id = s.user_id and (last_seen_at is null or last_seen_at < now() - interval '5 minutes');
  return jsonb_build_object(
    'user_id', s.user_id, 'email', s.email, 'full_name', s.full_name, 'title', s.title,
    'role', jsonb_build_object('id', r.id, 'code', r.code, 'name', r.name, 'is_super', r.is_super),
    'merchant_scope', case when r.is_super then 'ALL' else s.merchant_scope end,
    'merchant_ids', case when r.is_super or s.merchant_scope = 'ALL' then null
      else (select coalesce(jsonb_agg(merchant_id), '[]'::jsonb) from public.platform_staff_merchants where user_id = s.user_id) end,
    'permissions', case when r.is_super
      then (select jsonb_agg(m.code || '.' || a order by m.sort_order, a) from public.platform_modules m, unnest(m.actions) a)
      else (select coalesce(jsonb_agg(rp.module || '.' || rp.action order by rp.module, rp.action), '[]'::jsonb)
            from public.platform_role_permissions rp where rp.role_id = r.id) end,
    'modules', (select jsonb_agg(jsonb_build_object('code', code, 'name', name, 'actions', actions) order by sort_order) from public.platform_modules),
    'merchant_staff', exists (select 1 from public.profiles p where p.id = s.user_id and p.is_active),
    'pending_approvals', (select count(*) from public.platform_approvals a where a.status = 'PENDING' and a.expires_at > now()
                          and a.requested_by <> s.user_id and public.platform_can(a.module, 'approve', a.merchant_id)),
    'unread_notifications', (select count(*) from public.platform_notifications n where n.user_id = s.user_id and n.read_at is null),
    'support_session', (select public._platform_session_json(ss) from public.support_sessions ss
                        where ss.staff_user_id = s.user_id and ss.ended_at is null and ss.expires_at > now() order by ss.started_at desc limit 1),
    'session', jsonb_build_object('started_at', v_started,
      'expires_at', case when v_started is not null and v_hours is not null then v_started + make_interval(hours => v_hours) end)
  );
end;
$$;

-- Signs a staff member out on every device: their sessions are removed, so
-- their tokens stop working for the panel at once.
create or replace function public.platform_staff_sign_out(p_user uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_staff public.platform_staff;
  v_n int;
begin
  perform public._platform_require('security', 'manage');
  if length(trim(coalesce(p_reason, ''))) < 5 then
    raise exception 'VALIDATION: say why (at least 5 characters)' using errcode = '22023';
  end if;
  select * into v_staff from public.platform_staff where user_id = p_user;
  if v_staff.user_id is null then
    raise exception 'NOT_FOUND: not a platform employee' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.platform_roles r where r.id = v_staff.role_id and r.is_super) and not public._platform_is_super() then
    raise exception 'PERMISSION_DENIED: only a Super Admin can sign out a Super Admin' using errcode = '42501';
  end if;
  delete from auth.sessions where user_id = p_user;
  get diagnostics v_n = row_count;
  perform public._platform_log('security.staff_signed_out', null, 'platform_staff', p_user::text, trim(p_reason), null,
    jsonb_build_object('sessions', v_n, 'email', v_staff.email));
  return jsonb_build_object('sessions_ended', v_n);
end;
$$;

-- What the Security Center shows: who has access and how they sign in, the
-- platform's own credentials (hints and age only), and recent sensitive actions.
create or replace function public.platform_security_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._platform_require('security', 'view');
  return jsonb_build_object(
    'settings', coalesce((select value from public.platform_settings where key = 'security'), '{}'::jsonb),
    'staff', (select coalesce(jsonb_agg(jsonb_build_object(
        'user_id', s.user_id, 'email', s.email, 'name', coalesce(nullif(trim(s.full_name), ''), s.email), 'active', s.is_active,
        'role', jsonb_build_object('code', r.code, 'name', r.name, 'is_super', r.is_super),
        'scope', case when r.is_super then 'ALL' else s.merchant_scope end,
        'privileged', r.is_super or exists (select 1 from public.platform_role_permissions rp where rp.role_id = r.id
          and (rp.module, rp.action) in (('employees', 'manage'), ('security', 'manage'), ('data', 'manage'), ('credits', 'manage'), ('settings', 'manage'))),
        'last_sign_in_at', u.last_sign_in_at, 'last_seen_at', s.last_seen_at,
        'sessions', (select count(*) from auth.sessions x where x.user_id = s.user_id and (x.not_after is null or x.not_after > now())),
        'oldest_session_at', (select min(x.created_at) from auth.sessions x where x.user_id = s.user_id and (x.not_after is null or x.not_after > now())),
        'second_factors', (select count(*) from auth.mfa_factors f where f.user_id = s.user_id and f.status = 'verified'),
        'last_action_at', (select max(a.created_at) from public.platform_audit_logs a where a.actor_id = s.user_id),
        'denied_7d', (select count(*) from public.platform_audit_logs a where a.actor_id = s.user_id and a.result = 'DENIED' and a.created_at > now() - interval '7 days'))
        order by r.is_super desc, s.is_active desc, s.email), '[]'::jsonb)
      from public.platform_staff s join public.platform_roles r on r.id = s.role_id left join auth.users u on u.id = s.user_id),
    'credentials', (select coalesce(jsonb_agg(jsonb_build_object('key', c.key, 'hint', c.hint, 'updated_at', c.updated_at,
        'age_days', extract(day from now() - c.updated_at)::int,
        'updated_by', (select coalesce(nullif(trim(p.full_name), ''), p.email) from public.platform_staff p where p.user_id = c.updated_by)) order by c.key), '[]'::jsonb)
      from public.platform_credentials c),
    'counts', jsonb_build_object(
      'denied_24h', (select count(*) from public.platform_audit_logs where result = 'DENIED' and created_at > now() - interval '24 hours'),
      'pending_approvals', (select count(*) from public.platform_approvals where status = 'PENDING' and expires_at > now()),
      'support_sessions_open', (select count(*) from public.support_sessions where ended_at is null and expires_at > now())),
    'sensitive', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'action', a.action, 'actor', a.actor_email, 'reason', a.reason,
        'result', a.result, 'created_at', a.created_at,
        'merchant', (select jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name) from public.merchants m where m.id = a.merchant_id))
        order by a.created_at desc), '[]'::jsonb)
      from (select * from public.platform_audit_logs
            where action ~ '^(employees\.|roles?\.|settings\.|security\.|data\.|credits\.adjust|sms\.(connect|disconnect)|bd_courier\.(connect|disconnect)|billing\.gateway|pbx\.(trunk|turn|gateway)|support\.session)'
            order by created_at desc limit 30) a),
    'can', jsonb_build_object('manage', public.platform_can('security', 'manage')));
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. Settings: each one through its own validated function
-- -----------------------------------------------------------------------------
create or replace function public.platform_setting_save(p_key text, p_value jsonb, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb;
  k text;
begin
  if p_key like 'usage.%' then
    -- Validated, permission-checked and versioned there.
    return public.platform_usage_policy_save(upper(substr(p_key, 7)), p_value, coalesce(p_reason, 'Settings change'));
  end if;
  if p_key = 'support' then
    return public.platform_support_settings_save(p_value, p_reason);
  end if;
  if p_key = 'cost_assumptions' then
    return public.platform_cost_assumptions_save(p_value, p_reason);
  end if;
  if p_key = 'voicedrive' then
    return public.platform_pbx_settings_save(p_value, p_reason);
  end if;
  if p_key in ('sms', 'bd_courier', 'billing_gateways') then
    raise exception 'VALIDATION: % is changed on its own page (it holds connection state)', p_key using errcode = '22023';
  end if;
  if p_key in ('integration_health', 'retention_state', 'storefront') then
    raise exception 'VALIDATION: % is kept by the platform itself', p_key using errcode = '22023';
  end if;
  perform public._platform_require('settings', 'edit');
  if p_key = 'access_rules' then
    perform public._platform_require('subscriptions', 'manage');
    if exists (select 1 from jsonb_each_text(p_value) e where e.value not in ('FULL', 'READ_ONLY', 'BLOCKED')) then
      raise exception 'VALIDATION: each rule is FULL, READ_ONLY or BLOCKED' using errcode = '22023';
    end if;
  end if;
  if p_key = 'credits' then
    perform public._platform_require('credits', 'manage');
    if coalesce((p_value ->> 'approval_threshold')::int, -1) < 0 then
      raise exception 'VALIDATION: the approval threshold is a number of credits (0 or more)' using errcode = '22023';
    end if;
  end if;
  if p_key = 'security' then
    perform public._platform_require('security', 'manage');
    if jsonb_typeof(p_value -> 'staff_session_hours') not in ('null', 'number')
       or coalesce((p_value ->> 'staff_session_hours')::numeric, 1) not between 1 and 720 then
      raise exception 'VALIDATION: staff sessions last 1 to 720 hours (or leave it empty for no limit)' using errcode = '22023';
    end if;
    p_value := jsonb_build_object('staff_session_hours', (p_value ->> 'staff_session_hours')::int);
  end if;
  if p_key = 'retention' then
    perform public._platform_require('data', 'manage');
    foreach k in array array['system_logs_days', 'notifications_days'] loop
      if coalesce((p_value ->> k)::int, 0) not between 7 and 3650 then
        raise exception 'VALIDATION: % is 7 to 3650 days', replace(k, '_', ' ') using errcode = '22023';
      end if;
    end loop;
    if coalesce((p_value ->> 'deletion_cooling_days')::int, -1) not between 1 and 90 then
      raise exception 'VALIDATION: the wait before erasing is 1 to 90 days' using errcode = '22023';
    end if;
    p_value := jsonb_build_object('system_logs_days', (p_value ->> 'system_logs_days')::int, 'notifications_days', (p_value ->> 'notifications_days')::int,
      'deletion_cooling_days', (p_value ->> 'deletion_cooling_days')::int);
  end if;
  if p_key !~ '^[a-z0-9_.]{2,60}$' or jsonb_typeof(p_value) <> 'object' then
    raise exception 'VALIDATION: bad setting' using errcode = '22023';
  end if;
  select value into v_before from public.platform_settings where key = p_key;
  insert into public.platform_settings (key, value, updated_by) values (p_key, p_value, auth.uid())
  on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by;
  perform public._config_version(case when p_key = 'access_rules' then 'access_rules' else 'platform_setting' end, p_key, p_value, p_reason);
  perform public._platform_log('settings.changed', null, 'platform_setting', p_key, p_reason, v_before, p_value);
  return p_value;
end;
$$;

-- Rollback now covers automation rules too (as configuration, through their own checks).
create or replace function public.platform_config_rollback(p_version bigint, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.config_versions;
  m uuid;
  c text;
begin
  select * into v from public.config_versions where id = p_version;
  if v.id is null then
    raise exception 'NOT_FOUND: version not found' using errcode = 'P0002';
  end if;
  if coalesce(length(trim(p_reason)), 0) < 5 then
    raise exception 'VALIDATION: give a reason' using errcode = '22023';
  end if;
  case v.kind
    when 'plan' then
      -- Limits, features and prices for future invoices; subscriptions and invoices already made are not touched.
      perform public.platform_plan_save(jsonb_build_object('id', v.ref, 'name', v.data ->> 'name', 'description', v.data ->> 'description',
        'is_public', v.data -> 'is_public', 'price', v.data -> 'price', 'billing_interval', v.data ->> 'billing_interval',
        'trial_days', v.data -> 'trial_days', 'limits', v.data -> 'limits', 'overage', v.data -> 'overage', 'features', v.data -> 'features',
        'note', 'Rolled back to version ' || v.id || ': ' || p_reason));
    when 'feature' then
      perform public.platform_feature_save(v.ref, jsonb_build_object('globally_enabled', v.data -> 'globally_enabled', 'release_stage', v.data ->> 'release_stage',
        'reason', 'Rolled back to version ' || v.id || ': ' || p_reason));
    when 'merchant_feature' then
      m := split_part(v.ref, ':', 1)::uuid;
      c := split_part(v.ref, ':', 2);
      perform public.platform_merchant_feature_set(m, c, (v.data ->> 'enabled')::boolean, 'Rolled back to version ' || v.id || ': ' || p_reason,
        (v.data ->> 'limit')::numeric, (v.data ->> 'expires_at')::timestamptz);
    when 'access_rules', 'platform_setting' then
      perform public.platform_setting_save(v.ref, v.data, 'Rolled back to version ' || v.id || ': ' || p_reason);
    when 'automation_rule' then
      perform public.platform_automation_rule_save(v.data || jsonb_build_object('id', v.ref), 'Rolled back to version ' || v.id || ': ' || p_reason);
    else
      raise exception 'VALIDATION: % changes cannot be rolled back here', v.kind using errcode = '22023';
  end case;
  return jsonb_build_object('rolled_back_to', v.id);
end;
$$;

-- Everything on the Global Settings page: each setting, when and by whom it
-- last changed, and the release stage of features that are not out for everyone.
create or replace function public.platform_global_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._platform_require('settings', 'view');
  return jsonb_build_object(
    'settings', (select coalesce(jsonb_object_agg(s.key, jsonb_build_object('value', s.value, 'description', s.description, 'updated_at', s.updated_at,
        'last_change', (select jsonb_build_object('id', v.id, 'at', v.changed_at, 'note', v.note,
            'by', (select coalesce(nullif(trim(p.full_name), ''), p.email) from public.platform_staff p where p.user_id = v.changed_by))
          from public.config_versions v where v.kind in ('platform_setting', 'access_rules') and v.ref = s.key order by v.id desc limit 1))), '{}'::jsonb)
      from public.platform_settings s),
    'releases', (select coalesce(jsonb_agg(jsonb_build_object('code', f.code, 'name', f.name, 'stage', f.release_stage, 'globally_enabled', f.globally_enabled,
        'enrolled', (select count(*) from public.merchant_features mf where mf.feature_code = f.code and mf.enabled and (mf.expires_at is null or mf.expires_at > now())),
        'enrolled_demo', (select count(*) from public.merchant_features mf join public.merchants m on m.id = mf.merchant_id
                          where mf.feature_code = f.code and mf.enabled and m.is_demo and (mf.expires_at is null or mf.expires_at > now())))
        order by f.release_stage, f.sort_order), '[]'::jsonb)
      from public.features f where f.release_stage <> 'GA' or not f.globally_enabled),
    'demo_merchants', (select count(*) from public.merchants where is_demo and status <> 'CLOSED'),
    'can', jsonb_build_object('edit', public.platform_can('settings', 'edit'), 'security', public.platform_can('security', 'manage'),
      'data', public.platform_can('data', 'manage')));
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Retention of operational logs
-- -----------------------------------------------------------------------------
-- Only resolved system log entries and read staff notifications are removed.
-- Audit logs, ledgers, invoices, payments and orders are never touched.
create or replace function public._platform_retention_run()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb := coalesce((select value from public.platform_settings where key = 'retention'), '{}'::jsonb);
  v_logs int;
  v_notes int;
  v_out jsonb;
begin
  delete from public.system_logs where resolved_at is not null
    and resolved_at < now() - make_interval(days => greatest(7, coalesce((v ->> 'system_logs_days')::int, 90)));
  get diagnostics v_logs = row_count;
  delete from public.platform_notifications where read_at is not null
    and read_at < now() - make_interval(days => greatest(7, coalesce((v ->> 'notifications_days')::int, 90)));
  get diagnostics v_notes = row_count;
  v_out := jsonb_build_object('last_run_at', now(), 'system_logs_removed', v_logs, 'notifications_removed', v_notes);
  insert into public.platform_settings (key, value, description) values ('retention_state', v_out, 'The last retention run')
  on conflict (key) do update set value = excluded.value;
  return v_out;
end;
$$;

create or replace function public.platform_retention_run_now(p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_out jsonb;
begin
  perform public._platform_require('data', 'manage');
  v_out := public._platform_retention_run();
  perform public._platform_log('data.retention_run', null, 'platform_setting', 'retention', p_reason, null, v_out);
  return v_out;
end;
$$;

create or replace function public.platform_ops_run()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a public.platform_announcements;
  v_published int := 0;
  v_sessions int;
  v_auto jsonb;
  v_retention jsonb;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  v_sessions := public._platform_support_expire();
  for a in select * from public.platform_announcements where status = 'SCHEDULED' and publish_at <= now() for update skip locked loop
    perform public._platform_announcement_deliver(a);
    v_published := v_published + 1;
  end loop;
  v_auto := public.platform_automation_run(null);
  -- Once a day.
  if coalesce((select (value ->> 'last_run_at')::timestamptz from public.platform_settings where key = 'retention_state'), '-infinity'::timestamptz)
     < now() - interval '23 hours' then
    v_retention := public._platform_retention_run();
  end if;
  return jsonb_build_object('support_sessions_closed', v_sessions, 'announcements_published', v_published, 'automation', v_auto, 'retention', v_retention);
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Data exports (recorded) and a merchant's own data as one file
-- -----------------------------------------------------------------------------
create table public.platform_data_exports (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('MERCHANT_DATA', 'MERCHANTS', 'AUDIT', 'USAGE', 'REVENUE')),
  merchant_id uuid references public.merchants(id),
  actor_id uuid,
  actor_email text,
  reason text check (length(reason) <= 500),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index platform_data_exports_idx on public.platform_data_exports (created_at desc);
create trigger platform_data_exports_immutable before update or delete on public.platform_data_exports
  for each row execute function public.prevent_mutation();
alter table public.platform_data_exports enable row level security;
revoke all on public.platform_data_exports from anon, authenticated;

-- Downloads made in the browser (lists, audit log, usage) are recorded here.
create or replace function public.platform_export_record(p_kind text, p_detail jsonb default '{}'::jsonb, p_merchant uuid default null)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id bigint;
begin
  case p_kind
    when 'MERCHANTS' then perform public._platform_require('merchants', 'export');
    when 'AUDIT' then perform public._platform_require('audit', 'export');
    when 'USAGE', 'REVENUE' then perform public._platform_require('usage', 'export');
    else raise exception 'VALIDATION: unknown export' using errcode = '22023';
  end case;
  insert into public.platform_data_exports (kind, merchant_id, actor_id, actor_email, detail)
  values (p_kind, p_merchant, auth.uid(), (select email from public.platform_staff where user_id = auth.uid()), coalesce(p_detail, '{}'::jsonb))
  returning id into v_id;
  perform public._platform_log('data.export', p_merchant, 'export', v_id::text, null, null, jsonb_build_object('kind', p_kind) || coalesce(p_detail, '{}'::jsonb));
  return v_id;
end;
$$;

-- Everything the merchant's business holds, as JSON (for portability, or
-- before erasure). Credentials are never included.
create or replace function public.platform_merchant_export(p_merchant uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cap constant int := 50000;
  v_data jsonb;
  v_counts jsonb;
  v_id bigint;
begin
  perform public._platform_require('data', 'export', p_merchant);
  if length(trim(coalesce(p_reason, ''))) < 5 then
    raise exception 'VALIDATION: say why the data is exported (at least 5 characters)' using errcode = '22023';
  end if;
  if not exists (select 1 from public.merchants where id = p_merchant) then
    raise exception 'NOT_FOUND: merchant not found' using errcode = 'P0002';
  end if;
  v_data := jsonb_build_object(
    'merchant', (select to_jsonb(m) from public.merchants m where m.id = p_merchant),
    'subscription', (select to_jsonb(s) from public.subscriptions s where s.merchant_id = p_merchant and s.ended_at is null),
    'customers', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (select * from public.customers where merchant_id = p_merchant order by created_at limit v_cap) x),
    'customer_addresses', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (select * from public.customer_addresses where merchant_id = p_merchant limit v_cap) x),
    'products', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (select * from public.products where merchant_id = p_merchant order by created_at limit v_cap) x),
    'product_variants', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (select * from public.product_variants where merchant_id = p_merchant limit v_cap) x),
    'orders', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (select * from public.orders where merchant_id = p_merchant order by created_at limit v_cap) x),
    'order_items', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (select * from public.order_items where merchant_id = p_merchant limit v_cap) x),
    'order_payments', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (select * from public.order_payments where merchant_id = p_merchant limit v_cap) x),
    'shipments', (select coalesce(jsonb_agg(to_jsonb(x) - 'provider_payload'), '[]'::jsonb) from (select * from public.shipments where merchant_id = p_merchant limit v_cap) x),
    'invoices', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (select * from public.billing_invoices where merchant_id = p_merchant order by created_at) x),
    'platform_payments', (select coalesce(jsonb_agg(to_jsonb(x) - 'raw'), '[]'::jsonb) from (select * from public.billing_payments where merchant_id = p_merchant order by created_at) x),
    'credit_ledger', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (select * from public.credit_ledger where merchant_id = p_merchant order by created_at limit v_cap) x));
  v_counts := (select jsonb_object_agg(key, case when jsonb_typeof(value) = 'array' then jsonb_array_length(value) else 1 end) from jsonb_each(v_data));
  insert into public.platform_data_exports (kind, merchant_id, actor_id, actor_email, reason, detail)
  values ('MERCHANT_DATA', p_merchant, auth.uid(), (select email from public.platform_staff where user_id = auth.uid()), trim(p_reason),
          jsonb_build_object('rows', v_counts, 'capped_at', v_cap))
  returning id into v_id;
  perform public._platform_log('data.merchant_export', p_merchant, 'export', v_id::text, trim(p_reason), null, jsonb_build_object('rows', v_counts));
  return jsonb_build_object('exported_at', now(), 'export_id', v_id, 'rows', v_counts, 'capped_at', v_cap, 'data', v_data);
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Merchant data deletion requests (two people, a wait, then erasure)
-- -----------------------------------------------------------------------------
create table public.merchant_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  number bigint generated always as identity unique,
  merchant_id uuid not null references public.merchants(id),
  source text not null check (source in ('MERCHANT', 'PLATFORM')),
  reason text not null check (length(trim(reason)) between 5 and 2000),
  status text not null default 'REQUESTED' check (status in ('REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED', 'COMPLETED')),
  requested_by uuid,
  requested_by_email text,
  decided_by uuid,
  decided_at timestamptz,
  decision_note text check (length(decision_note) <= 2000),
  erase_after timestamptz,
  completed_by uuid,
  completed_at timestamptz,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Whoever asked does not approve; whoever approved does not erase.
  check (decided_by is null or decided_by is distinct from requested_by),
  check (completed_by is null or completed_by is distinct from decided_by)
);
create unique index merchant_deletion_requests_open on public.merchant_deletion_requests (merchant_id) where status in ('REQUESTED', 'APPROVED');
create trigger merchant_deletion_requests_updated_at before update on public.merchant_deletion_requests for each row execute function public.set_updated_at();
alter table public.merchant_deletion_requests enable row level security;
revoke all on public.merchant_deletion_requests from anon, authenticated;

-- Erasure may correct records that are otherwise immutable: only from this
-- database code (never a signed-in user), only for the merchant of an approved
-- request whose wait is over, while that erasure runs.
create or replace function public._erasure_active(p_merchant uuid)
returns boolean
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  if current_user <> 'postgres' or coalesce(current_setting('app.erasure_request', true), '') = '' then
    return false;
  end if;
  return exists (select 1 from public.merchant_deletion_requests r where r.id = current_setting('app.erasure_request', true)::uuid
                 and r.merchant_id = p_merchant and r.status = 'APPROVED' and r.erase_after <= now());
end;
$$;

create or replace function public.prevent_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and tg_table_name = 'shipment_events' then
    if public._erasure_active(new.merchant_id) then
      return new;
    end if;
  end if;
  raise exception 'IMMUTABLE_RECORD: % rows cannot be %d; record a correcting entry instead',
    tg_table_name, lower(tg_op)
    using errcode = 'P0001';
end;
$$;

create or replace function public.fraud_checks_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'IMMUTABLE_RECORD: fraud checks cannot be deleted' using errcode = 'P0001';
  end if;
  if public._erasure_active(new.merchant_id) then
    return new;
  end if;
  if old.order_id is null and new.order_id is not null
     and (to_jsonb(new) - 'order_id' - 'customer_id') = (to_jsonb(old) - 'order_id' - 'customer_id') then
    return new;
  end if;
  raise exception 'IMMUTABLE_RECORD: fraud checks cannot be modified' using errcode = 'P0001';
end;
$$;

-- Removes the personal data of the merchant's customers and contacts.
-- Amounts, items, statuses, dates, invoices and ledgers stay (accounting);
-- district and city stay for totals. Returns how many rows were changed.
create or replace function public._merchant_erase_personal_data(p_merchant uuid, p_request uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb := '{}'::jsonb;
  n int;
begin
  perform set_config('app.erasure_request', p_request::text, true);
  -- Act inside the merchant, so its own change log records the erasure.
  perform public._platform_in_merchant(p_merchant);

  -- Phone numbers stay digits and unique per merchant: 0000 followed by a running number (never a real number).
  update public.customers c set full_name = 'Erased customer', phone = '0000' || lpad(x.rn::text, 9, '0'), email = null, address = null, area = null, notes = null
  from (select id, row_number() over (order by created_at, id) as rn from public.customers where merchant_id = p_merchant) x
  where c.id = x.id;
  get diagnostics n = row_count; v := v || jsonb_build_object('customers', n);
  update public.customer_addresses set recipient_name = 'Erased', phone = 'erased', address_line = 'Erased', area = null, postal_code = null
  where merchant_id = p_merchant;
  get diagnostics n = row_count; v := v || jsonb_build_object('customer_addresses', n);
  update public.orders set customer_name = 'Erased customer', customer_phone = 'erased-' || left(id::text, 8), customer_email = null,
    shipping_address = 'Erased', shipping_area = null, shipping_postal_code = null, customer_note = null, client_ip = null, user_agent = null
  where merchant_id = p_merchant;
  get diagnostics n = row_count; v := v || jsonb_build_object('orders', n);
  update public.checkout_leads set phone = '0000000000', customer_name = null, address = null, area = null, notes = null where merchant_id = p_merchant;
  get diagnostics n = row_count; v := v || jsonb_build_object('checkout_leads', n);
  update public.store_carts set phone = null, customer_name = null, notes = null where merchant_id = p_merchant;
  get diagnostics n = row_count; v := v || jsonb_build_object('store_carts', n);
  update public.shopify_abandoned_checkouts set customer_name = null, email = null, phone = null, address = null, notes = null where merchant_id = p_merchant;
  get diagnostics n = row_count; v := v || jsonb_build_object('abandoned_checkouts', n);
  update public.contact_messages set name = 'Erased', phone = null, email = null, message = 'Erased' where merchant_id = p_merchant;
  get diagnostics n = row_count; v := v || jsonb_build_object('contact_messages', n);
  update public.coupon_usage set phone = 'erased' where merchant_id = p_merchant;
  get diagnostics n = row_count; v := v || jsonb_build_object('coupon_usage', n);
  update public.payments set payer_phone = null where merchant_id = p_merchant and payer_phone is not null;
  get diagnostics n = row_count; v := v || jsonb_build_object('payments', n);
  update public.notification_logs set recipient = 'erased', body = 'Erased' where merchant_id = p_merchant;
  get diagnostics n = row_count; v := v || jsonb_build_object('messages', n);
  update public.fraud_checks set phone = 'erased', provider_response = null where merchant_id = p_merchant;
  get diagnostics n = row_count; v := v || jsonb_build_object('fraud_checks', n);
  update public.pbx_call_records set customer_phone = null, normalized_customer_phone = null, outcome_note = null where merchant_id = p_merchant;
  get diagnostics n = row_count; v := v || jsonb_build_object('call_records', n);
  update public.pbx_calls set customer_phone = null, raw = '{}'::jsonb where merchant_id = p_merchant;
  get diagnostics n = row_count; v := v || jsonb_build_object('calls', n);
  -- Raw payloads from stores, couriers and gateways carry names, phones and addresses.
  update public.channel_order_imports set payload = jsonb_build_object('lines', payload -> 'lines') where merchant_id = p_merchant;
  get diagnostics n = row_count; v := v || jsonb_build_object('store_imports', n);
  update public.courier_webhook_events set payload = '{}'::jsonb where merchant_id = p_merchant;
  get diagnostics n = row_count; v := v || jsonb_build_object('courier_updates', n);
  update public.shipments set provider_payload = '{}'::jsonb where merchant_id = p_merchant and provider_payload <> '{}'::jsonb;
  get diagnostics n = row_count; v := v || jsonb_build_object('shipments', n);
  update public.shipment_events set raw = null where merchant_id = p_merchant and raw is not null;
  get diagnostics n = row_count; v := v || jsonb_build_object('shipment_events', n);
  update public.payment_events set payload = '{}'::jsonb where merchant_id = p_merchant;
  get diagnostics n = row_count; v := v || jsonb_build_object('payment_events', n);
  -- The merchant's own staff can no longer sign in to this business.
  update public.profiles set is_active = false where merchant_id = p_merchant and is_active;
  get diagnostics n = row_count; v := v || jsonb_build_object('staff_deactivated', n);

  perform set_config('app.erasure_request', '', true);
  return v;
end;
$$;

create or replace function public._deletion_request_json(r public.merchant_deletion_requests)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select to_jsonb(r) || jsonb_build_object(
    'merchant', (select jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name, 'status', m.status) from public.merchants m where m.id = r.merchant_id),
    'decided_by_name', (select coalesce(nullif(trim(p.full_name), ''), p.email) from public.platform_staff p where p.user_id = r.decided_by),
    'completed_by_name', (select coalesce(nullif(trim(p.full_name), ''), p.email) from public.platform_staff p where p.user_id = r.completed_by),
    'exports', (select count(*) from public.platform_data_exports e where e.merchant_id = r.merchant_id and e.kind = 'MERCHANT_DATA' and e.created_at > r.created_at),
    'ready', r.status = 'APPROVED' and r.erase_after <= now())
$$;

-- The merchant's owner asks for the business to be closed and its data erased.
create or replace function public.merchant_data_deletion_request(p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_merchant uuid := public.current_merchant_id();
  r public.merchant_deletion_requests;
begin
  if public.current_role_code() is distinct from 'OWNER' or public._support_session_id() is not null then
    raise exception 'PERMISSION_DENIED: only the account owner can ask for the data to be erased' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then
    raise exception 'VALIDATION: tell us why (at least 5 characters)' using errcode = '22023';
  end if;
  if exists (select 1 from public.merchant_deletion_requests where merchant_id = v_merchant and status in ('REQUESTED', 'APPROVED')) then
    raise exception 'VALIDATION: a request is already open' using errcode = '22023';
  end if;
  insert into public.merchant_deletion_requests (merchant_id, source, reason, requested_by, requested_by_email)
  values (v_merchant, 'MERCHANT', trim(p_reason), auth.uid(), (select email from public.profiles where id = auth.uid()))
  returning * into r;
  perform public._platform_notify('data', 'approve', v_merchant, 'data.deletion_requested', 'WARN',
    format('Data erasure requested: #%s %s', (select number from public.merchants where id = v_merchant), (select name from public.merchants where id = v_merchant)),
    trim(p_reason), '/super-admin/data?tab=deletion', 'deletion:' || r.id);
  insert into public.audit_logs (merchant_id, actor_id, actor_email, action, entity_type, entity_id, metadata)
  values (v_merchant, auth.uid(), (select email from public.profiles where id = auth.uid()), 'data.deletion_requested', 'merchant', v_merchant::text,
          jsonb_build_object('request', r.number));
  return jsonb_build_object('id', r.id, 'number', r.number, 'status', r.status, 'created_at', r.created_at);
end;
$$;

create or replace function public.my_data_deletion_request()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_staff() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return (select jsonb_build_object('id', r.id, 'number', r.number, 'status', r.status, 'reason', r.reason, 'created_at', r.created_at,
      'erase_after', r.erase_after, 'decision_note', r.decision_note, 'is_owner', public.current_role_code() = 'OWNER')
    from public.merchant_deletion_requests r where r.merchant_id = public.current_merchant_id() order by r.created_at desc limit 1);
end;
$$;

create or replace function public.merchant_data_deletion_cancel()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.current_role_code() is distinct from 'OWNER' or public._support_session_id() is not null then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.merchant_deletion_requests set status = 'CANCELLED', decision_note = 'Withdrawn by the account owner'
  where merchant_id = public.current_merchant_id() and status in ('REQUESTED', 'APPROVED');
  if not found then
    raise exception 'NOT_FOUND: no open request' using errcode = 'P0002';
  end if;
end;
$$;

-- Platform staff record a request received another way (email, phone).
create or replace function public.platform_deletion_request_create(p_merchant uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.merchant_deletion_requests;
begin
  perform public._platform_require('data', 'manage', p_merchant);
  if length(trim(coalesce(p_reason, ''))) < 5 then
    raise exception 'VALIDATION: say who asked and how (at least 5 characters)' using errcode = '22023';
  end if;
  if exists (select 1 from public.merchant_deletion_requests where merchant_id = p_merchant and status in ('REQUESTED', 'APPROVED')) then
    raise exception 'VALIDATION: a request is already open for this merchant' using errcode = '22023';
  end if;
  insert into public.merchant_deletion_requests (merchant_id, source, reason, requested_by, requested_by_email)
  values (p_merchant, 'PLATFORM', trim(p_reason), auth.uid(), (select email from public.platform_staff where user_id = auth.uid()))
  returning * into r;
  perform public._platform_log('data.deletion_requested', p_merchant, 'deletion_request', r.id::text, trim(p_reason), null, jsonb_build_object('number', r.number));
  return public._deletion_request_json(r);
end;
$$;

create or replace function public.platform_deletion_request_decide(p_id uuid, p_approve boolean, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.merchant_deletion_requests;
  v_days int := coalesce((select (value ->> 'deletion_cooling_days')::int from public.platform_settings where key = 'retention'), 14);
begin
  select * into r from public.merchant_deletion_requests where id = p_id for update;
  if r.id is null then
    raise exception 'NOT_FOUND: request not found' using errcode = 'P0002';
  end if;
  perform public._platform_require('data', 'approve', r.merchant_id);
  if r.status <> 'REQUESTED' then
    raise exception 'VALIDATION: this request was already decided' using errcode = '22023';
  end if;
  if r.requested_by = auth.uid() then
    raise exception 'VALIDATION: someone other than the person who recorded it must decide' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_note, ''))) < 5 then
    raise exception 'VALIDATION: note how the request was verified (at least 5 characters)' using errcode = '22023';
  end if;
  update public.merchant_deletion_requests set status = case when p_approve then 'APPROVED' else 'REJECTED' end, decided_by = auth.uid(), decided_at = now(),
    decision_note = trim(p_note), erase_after = case when p_approve then now() + make_interval(days => v_days) end
  where id = p_id returning * into r;
  perform public._platform_log(case when p_approve then 'data.deletion_approved' else 'data.deletion_rejected' end, r.merchant_id, 'deletion_request', r.id::text,
    trim(p_note), null, jsonb_build_object('erase_after', r.erase_after));
  return public._deletion_request_json(r);
end;
$$;

create or replace function public.platform_deletion_request_cancel(p_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.merchant_deletion_requests;
begin
  select * into r from public.merchant_deletion_requests where id = p_id for update;
  if r.id is null then
    raise exception 'NOT_FOUND: request not found' using errcode = 'P0002';
  end if;
  perform public._platform_require('data', 'manage', r.merchant_id);
  if r.status not in ('REQUESTED', 'APPROVED') or length(trim(coalesce(p_reason, ''))) < 5 then
    raise exception 'VALIDATION: only an open request can be cancelled, with a reason' using errcode = '22023';
  end if;
  update public.merchant_deletion_requests set status = 'CANCELLED', decision_note = trim(p_reason) where id = p_id returning * into r;
  perform public._platform_log('data.deletion_cancelled', r.merchant_id, 'deletion_request', r.id::text, trim(p_reason), null, null);
  return public._deletion_request_json(r);
end;
$$;

-- Erases once: approved by someone else, after the wait, the account closed,
-- and the merchant's name typed to confirm.
create or replace function public.platform_deletion_request_execute(p_id uuid, p_confirm text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.merchant_deletion_requests;
  m public.merchants;
  v_result jsonb;
begin
  select * into r from public.merchant_deletion_requests where id = p_id for update;
  if r.id is null then
    raise exception 'NOT_FOUND: request not found' using errcode = 'P0002';
  end if;
  perform public._platform_require('data', 'manage', r.merchant_id);
  select * into m from public.merchants where id = r.merchant_id;
  if r.status <> 'APPROVED' then
    raise exception 'VALIDATION: only an approved request can be carried out' using errcode = '22023';
  end if;
  if r.erase_after > now() then
    raise exception 'VALIDATION: the waiting period ends %', to_char(r.erase_after at time zone 'Asia/Dhaka', 'DD Mon YYYY HH24:MI') using errcode = '22023';
  end if;
  if r.decided_by = auth.uid() then
    raise exception 'VALIDATION: the person who approved it cannot also erase the data' using errcode = '22023';
  end if;
  if m.status <> 'CLOSED' then
    raise exception 'VALIDATION: close the merchant''s account first (Merchants → status)' using errcode = '22023';
  end if;
  if p_confirm is distinct from m.name then
    raise exception 'VALIDATION: type the merchant''s name exactly to confirm' using errcode = '22023';
  end if;
  v_result := public._merchant_erase_personal_data(m.id, r.id);
  update public.merchant_deletion_requests set status = 'COMPLETED', completed_by = auth.uid(), completed_at = now(), result = v_result
  where id = p_id returning * into r;
  perform public._platform_log('data.erased', m.id, 'deletion_request', r.id::text, r.reason, null, v_result);
  return public._deletion_request_json(r);
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Restore tests and the Data Management overview
-- -----------------------------------------------------------------------------
create table public.platform_restore_tests (
  id bigint generated always as identity primary key,
  tested_at timestamptz not null,
  backup_taken_at timestamptz,
  environment text not null check (length(trim(environment)) between 2 and 120),
  result text not null check (result in ('PASSED', 'PARTIAL', 'FAILED')),
  duration_minutes int check (duration_minutes between 0 and 10080),
  checks jsonb not null default '{}'::jsonb,
  notes text check (length(notes) <= 4000),
  recorded_by uuid,
  recorded_by_email text,
  created_at timestamptz not null default now()
);
create trigger platform_restore_tests_immutable before update or delete on public.platform_restore_tests
  for each row execute function public.prevent_mutation();
alter table public.platform_restore_tests enable row level security;
revoke all on public.platform_restore_tests from anon, authenticated;

create or replace function public.platform_restore_test_record(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  t public.platform_restore_tests;
begin
  perform public._platform_require('data', 'manage');
  if upper(coalesce(p ->> 'result', '')) not in ('PASSED', 'PARTIAL', 'FAILED') then
    raise exception 'VALIDATION: choose the result' using errcode = '22023';
  end if;
  if nullif(p ->> 'tested_at', '') is null or (p ->> 'tested_at')::timestamptz > now() + interval '1 hour' then
    raise exception 'VALIDATION: when was it tested?' using errcode = '22023';
  end if;
  if length(trim(coalesce(p ->> 'environment', ''))) < 2 then
    raise exception 'VALIDATION: say where it was restored (e.g. a staging project)' using errcode = '22023';
  end if;
  insert into public.platform_restore_tests (tested_at, backup_taken_at, environment, result, duration_minutes, checks, notes, recorded_by, recorded_by_email)
  values ((p ->> 'tested_at')::timestamptz, nullif(p ->> 'backup_taken_at', '')::timestamptz, trim(p ->> 'environment'), upper(p ->> 'result'),
          nullif(p ->> 'duration_minutes', '')::int, coalesce(p -> 'checks', '{}'::jsonb), nullif(trim(coalesce(p ->> 'notes', '')), ''),
          auth.uid(), (select email from public.platform_staff where user_id = auth.uid()))
  returning * into t;
  perform public._platform_log('data.restore_test_recorded', null, 'restore_test', t.id::text, null, null, to_jsonb(t));
  return to_jsonb(t);
end;
$$;

-- Row counts of the main tables (to compare a restored copy with production).
create or replace function public._platform_table_counts()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'merchants', (select count(*) from public.merchants), 'orders', (select count(*) from public.orders),
    'order_items', (select count(*) from public.order_items), 'customers', (select count(*) from public.customers),
    'products', (select count(*) from public.products), 'shipments', (select count(*) from public.shipments),
    'invoices', (select count(*) from public.billing_invoices), 'platform_payments', (select count(*) from public.billing_payments),
    'credit_ledger', (select count(*) from public.credit_ledger), 'audit_logs', (select count(*) from public.platform_audit_logs))
$$;

create or replace function public.platform_data_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._platform_require('data', 'view');
  return jsonb_build_object(
    'database', jsonb_build_object('size', pg_size_pretty(pg_database_size(current_database())), 'tables', public._platform_table_counts(), 'at', now()),
    'retention', jsonb_build_object('policy', coalesce((select value from public.platform_settings where key = 'retention'), '{}'::jsonb),
      'last_run', (select value from public.platform_settings where key = 'retention_state'),
      'due', jsonb_build_object(
        'system_logs', (select count(*) from public.system_logs where resolved_at is not null
          and resolved_at < now() - make_interval(days => coalesce((select (value ->> 'system_logs_days')::int from public.platform_settings where key = 'retention'), 90))),
        'notifications', (select count(*) from public.platform_notifications where read_at is not null
          and read_at < now() - make_interval(days => coalesce((select (value ->> 'notifications_days')::int from public.platform_settings where key = 'retention'), 90))))),
    'exports', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'actor', e.actor_email, 'reason', e.reason, 'detail', e.detail, 'created_at', e.created_at,
        'merchant', (select jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name) from public.merchants m where m.id = e.merchant_id)) order by e.id desc), '[]'::jsonb)
      from (select * from public.platform_data_exports where merchant_id is null or merchant_id in (select public._platform_merchant_ids()) order by id desc limit 50) e),
    'deletion_requests', (select coalesce(jsonb_agg(public._deletion_request_json(r) order by (r.status in ('REQUESTED', 'APPROVED')) desc, r.created_at desc), '[]'::jsonb)
      from public.merchant_deletion_requests r where r.merchant_id in (select public._platform_merchant_ids())),
    'restore_tests', (select coalesce(jsonb_agg(to_jsonb(t) order by t.tested_at desc), '[]'::jsonb)
      from (select * from public.platform_restore_tests order by tested_at desc limit 20) t),
    'imports', jsonb_build_object(
      'failed_30d', (select count(*) from public.channel_order_imports i where i.status = 'FAILED' and i.updated_at > now() - interval '30 days'
        and i.merchant_id in (select public._platform_merchant_ids())),
      'rows', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'external_number', coalesce(i.external_number, i.external_id), 'error', i.error,
          'warnings', i.warnings, 'attempts', i.attempts, 'received_via', i.received_via, 'updated_at', i.updated_at,
          'channel', jsonb_build_object('id', c.id, 'name', c.name, 'platform', c.platform),
          'merchant', jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name)) order by i.updated_at desc), '[]'::jsonb)
        from (select * from public.channel_order_imports where status = 'FAILED' and updated_at > now() - interval '30 days'
                and merchant_id in (select public._platform_merchant_ids()) order by updated_at desc limit 100) i
        join public.sales_channels c on c.id = i.channel_id join public.merchants m on m.id = i.merchant_id)),
    'can', jsonb_build_object('export', public.platform_can('data', 'export'), 'manage', public.platform_can('data', 'manage'),
      'approve', public.platform_can('data', 'approve')));
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. Grants, global tables, exemptions
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
               'credit_types', 'credit_packages', 'platform_notifications', 'support_ticket_events', 'platform_cost_entries',
               'platform_incidents', 'platform_incident_merchants', 'platform_incident_updates', 'platform_announcements',
               'platform_announcement_deliveries', 'platform_announcement_reads', 'platform_automation_rules', 'platform_automation_runs',
               'platform_data_exports', 'merchant_deletion_requests', 'platform_restore_tests']
$$;

do $$
declare
  f text;
begin
  foreach f in array array['platform_staff_sign_out(uuid,text)', 'platform_security_overview()', 'platform_global_settings()',
    'platform_retention_run_now(text)', 'platform_export_record(text,jsonb,uuid)', 'platform_merchant_export(uuid,text)',
    'merchant_data_deletion_request(text)', 'my_data_deletion_request()', 'merchant_data_deletion_cancel()',
    'platform_deletion_request_create(uuid,text)', 'platform_deletion_request_decide(uuid,boolean,text)', 'platform_deletion_request_cancel(uuid,text)',
    'platform_deletion_request_execute(uuid,text)', 'platform_restore_test_record(jsonb)', 'platform_data_overview()']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['_platform_session_ok()', '_platform_retention_run()', '_erasure_active(uuid)',
    '_merchant_erase_personal_data(uuid,uuid)', '_deletion_request_json(public.merchant_deletion_requests)', '_platform_table_counts()']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;
-- Trigger functions run as the writer; they must be able to call this check.
grant execute on function public._erasure_active(uuid) to authenticated, service_role, app_owner;

insert into public.tenancy_exempt_functions (name, reason)
select f, 'Platform security, data management and settings: across merchants, permission-checked'
from unnest(array['_platform_session_ok', 'platform_staff_sign_out', 'platform_security_overview', 'platform_global_settings',
  '_platform_retention_run', 'platform_retention_run_now', 'platform_export_record', 'platform_merchant_export',
  'platform_deletion_request_create', 'platform_deletion_request_decide', 'platform_deletion_request_cancel', 'platform_deletion_request_execute',
  'platform_restore_test_record', '_platform_table_counts', 'platform_data_overview']) f
on conflict (name) do nothing;
insert into public.tenancy_exempt_functions (name, reason) values
  ('_merchant_erase_personal_data', 'Erases one merchant''s personal data after an approved deletion request (called only by platform_deletion_request_execute)'),
  ('_deletion_request_json', 'Shapes a deletion request for the platform panel'),
  ('merchant_data_deletion_request', 'The signed-in owner asks for their own business''s data to be erased (current_merchant_id())'),
  ('my_data_deletion_request', 'The signed-in staff member''s own business''s deletion request (current_merchant_id())'),
  ('merchant_data_deletion_cancel', 'The signed-in owner withdraws their own business''s deletion request (current_merchant_id())')
on conflict (name) do nothing;

select public._tenancy_own_functions();
