-- =============================================================================
-- Settings & Support
--
--   * Device approvals: when switched on, a staff member signing in from a new
--     browser can't see or change anything until an admin approves that
--     device. The check sits in has_permission / is_staff / get_my_access, so
--     RLS, every RPC and the edge functions (which ask get_my_access) all
--     respect it. Approval is tied to the sign-in session (the session_id in
--     the access token) plus a random per-browser token whose hash is kept.
--     Owners are never locked out.
--   * Order sources: the list staff pick "where did this order come from"
--     from is now a table (labels, channel, on/off, order).
--   * Support tickets: bug reports and feedback with replies and status.
--   * Merchant profile (private), integrations overview, system status.
--   * Cloud PBX call log (written by the pbx edge function only).
-- =============================================================================

insert into public.permissions(code, module, name) values
  ('support.manage', 'support', 'See and answer every bug report and feedback'),
  ('devices.manage', 'users', 'Approve or revoke the devices staff sign in from')
on conflict (code) do nothing;

insert into public.role_permissions(role_id, permission_id)
select r.id, p.id
from (values ('ADMIN', 'support.manage'), ('ADMIN', 'devices.manage')) g(role_code, perm)
join public.roles r on r.code = g.role_code
join public.permissions p on p.code = g.perm
on conflict do nothing;

insert into public.settings(key, is_public, description, value) values
  ('device_approval', false, 'Staff sign-ins from new devices need admin approval',
    jsonb_build_object('enabled', false, 'auto_approve_first', true)),
  ('merchant', false, 'Merchant profile: owner, legal details and payout accounts (staff with settings access only)',
    jsonb_build_object('owner_name', '', 'owner_phone', '', 'owner_email', '', 'nid_number', '', 'trade_license', '',
      'tin', '', 'bin', '', 'business_type', '', 'established', '', 'payout_accounts', '[]'::jsonb, 'notes', '')),
  ('pbx', false, 'Cloud PBX: click-to-call and call log (API secret and webhook token live in Vault)',
    jsonb_build_object('enabled', false, 'provider', 'VoiceDrive', 'click_mode', 'tel', 'api_method', 'GET',
      'api_url_template', '', 'api_body_template', '', 'extensions', '[]'::jsonb)),
  ('advanced', false, 'Advanced: automatic sign-out after inactivity',
    jsonb_build_object('idle_logout_minutes', 0))
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Device approvals
-- ---------------------------------------------------------------------------
create table if not exists public.staff_devices (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id),
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  label text check (label is null or length(label) <= 80),
  user_agent text,
  ip text,
  status text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED', 'REVOKED')),
  decided_by uuid references public.profiles(id),
  decided_at timestamptz,
  note text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (profile_id, token_hash)
);
create index if not exists staff_devices_status_idx on public.staff_devices(status, last_seen_at desc);

create table if not exists public.staff_device_sessions (
  session_id uuid primary key,
  device_id uuid not null references public.staff_devices(id),
  created_at timestamptz not null default now()
);
create index if not exists staff_device_sessions_device_idx on public.staff_device_sessions(device_id);

alter table public.staff_devices enable row level security;
alter table public.staff_device_sessions enable row level security;
-- No policies: read through device_list() / get_my_access() only.
revoke all on public.staff_devices, public.staff_device_sessions from anon, authenticated;

/** The sign-in session of the caller's access token (null without one). */
create or replace function public._jwt_session()
returns uuid
language sql
stable
set search_path = public, pg_temp
as $$
  select case when coalesce(auth.jwt() ->> 'session_id', '') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then (auth.jwt() ->> 'session_id')::uuid end
$$;

/** True when this staff member may act from the current session's device. */
create or replace function public._device_ok(p_profile uuid, p_role text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_role = 'OWNER'
    or not coalesce((select (s.value ->> 'enabled')::boolean from public.settings s where s.key = 'device_approval'), false)
    or exists (
      select 1 from public.staff_device_sessions ds
      join public.staff_devices d on d.id = ds.device_id
      where ds.session_id = public._jwt_session() and d.profile_id = p_profile and d.status = 'APPROVED')
$$;

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p join public.roles r on r.id = p.role_id
    where p.id = auth.uid() and p.is_active and public._device_ok(p.id, r.code))
$$;

create or replace function public.has_permission(p_code text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles p
    join public.roles r on r.id = p.role_id
    where p.id = auth.uid()
      and p.is_active
      and public._device_ok(p.id, r.code)
      and (
        r.code = 'OWNER'
        or exists (
          select 1
          from public.role_permissions rp
          join public.permissions pm on pm.id = rp.permission_id
          where rp.role_id = r.id and pm.code = p_code
        )
      )
  )
$$;

create or replace function public.get_my_access()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_p public.profiles;
  v_r public.roles;
  v_ok boolean;
  v_required boolean := coalesce((select (value ->> 'enabled')::boolean from public.settings where key = 'device_approval'), false);
  v_device public.staff_devices;
begin
  select * into v_p from public.profiles where id = auth.uid() and is_active;
  if v_p.id is null then
    return null;
  end if;
  select * into v_r from public.roles where id = v_p.role_id;
  v_ok := public._device_ok(v_p.id, v_r.code);
  select d.* into v_device from public.staff_device_sessions ds join public.staff_devices d on d.id = ds.device_id
  where ds.session_id = public._jwt_session() and d.profile_id = v_p.id;
  return jsonb_build_object(
    'user_id', v_p.id,
    'email', v_p.email,
    'full_name', v_p.full_name,
    'role', v_r.code,
    'role_name', v_r.name,
    'device_blocked', not v_ok,
    'device', jsonb_build_object('required', v_required and v_r.code <> 'OWNER', 'id', v_device.id, 'status', v_device.status),
    'idle_logout_minutes', coalesce((select (value ->> 'idle_logout_minutes')::int from public.settings where key = 'advanced'), 0),
    -- Click-to-call through the PBX: on, in API mode, and this staff member has an extension.
    'pbx_click_to_call', coalesce((select (value ->> 'enabled')::boolean and value ->> 'click_mode' = 'api'
        and exists (select 1 from jsonb_array_elements(coalesce(value -> 'extensions', '[]'::jsonb)) e where e ->> 'profile_id' = v_p.id::text)
      from public.settings where key = 'pbx'), false),
    'permissions', case
      when not v_ok then '[]'::jsonb
      when v_r.code = 'OWNER' then (select coalesce(jsonb_agg(code order by code), '[]'::jsonb) from public.permissions)
      else (select coalesce(jsonb_agg(pm.code order by pm.code), '[]'::jsonb)
            from public.role_permissions rp join public.permissions pm on pm.id = rp.permission_id
            where rp.role_id = v_r.id)
    end);
end;
$$;

/**
 * Called by the admin app on start: records this browser (by the hash of its
 * random token) and links the current sign-in session to it. The first
 * device of a staff member is approved automatically when that option is on.
 */
create or replace function public.device_register(p_token text, p_label text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_hash text;
  v_dev public.staff_devices;
  v_cfg jsonb := coalesce(public.get_setting('device_approval'), '{}'::jsonb);
  v_count int;
  v_first boolean;
  v_session uuid := public._jwt_session();
  v_headers json;
  v_ua text;
  v_ip text;
  v_name text;
begin
  if v_uid is null or not exists (select 1 from public.profiles where id = v_uid and is_active) then
    raise exception 'PERMISSION_DENIED: staff only' using errcode = '42501';
  end if;
  if p_token is null or length(p_token) < 32 or length(p_token) > 200 then
    raise exception 'VALIDATION: invalid device token' using errcode = '22023';
  end if;
  v_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');
  begin
    v_headers := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    v_headers := null;
  end;
  v_ua := left(v_headers ->> 'user-agent', 300);
  v_ip := nullif(left(trim(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1)), 60), '');

  select * into v_dev from public.staff_devices where profile_id = v_uid and token_hash = v_hash;
  if v_dev.id is null then
    select count(*) into v_count from public.staff_devices where profile_id = v_uid;
    if v_count >= 50 then
      raise exception 'VALIDATION: too many devices on this account — ask an admin to clean up the list' using errcode = '22023';
    end if;
    -- Owners are never blocked, so their devices don't wait in the queue either.
    v_first := (v_count = 0 and coalesce((v_cfg ->> 'auto_approve_first')::boolean, true)) or public.current_role_code() = 'OWNER';
    insert into public.staff_devices(profile_id, token_hash, label, user_agent, ip, status, decided_at, note)
    values (v_uid, v_hash, left(nullif(trim(p_label), ''), 80), v_ua, v_ip,
      case when v_first then 'APPROVED' else 'PENDING' end,
      case when v_first then now() end,
      case when v_first then case when public.current_role_code() = 'OWNER' then 'Owner — approved automatically' else 'First device — approved automatically' end end)
    returning * into v_dev;
    if v_dev.status = 'PENDING' and coalesce((v_cfg ->> 'enabled')::boolean, false) then
      select coalesce(nullif(trim(full_name), ''), email) into v_name from public.profiles where id = v_uid;
      perform public._log_system_event('INFO', 'AUTH', 'device-approval',
        format('%s signed in from a new device (%s) — waiting for approval', v_name, coalesce(v_dev.label, 'unknown browser')),
        jsonb_build_object('device_id', v_dev.id, 'user_id', v_uid));
    end if;
  else
    update public.staff_devices set last_seen_at = now(), user_agent = coalesce(v_ua, user_agent), ip = coalesce(v_ip, ip),
      label = coalesce(left(nullif(trim(p_label), ''), 80), label)
    where id = v_dev.id returning * into v_dev;
  end if;
  if v_session is not null then
    insert into public.staff_device_sessions(session_id, device_id) values (v_session, v_dev.id)
    on conflict (session_id) do update set device_id = excluded.device_id;
  end if;
  return jsonb_build_object('id', v_dev.id, 'status', v_dev.status,
    'required', coalesce((v_cfg ->> 'enabled')::boolean, false));
end;
$$;

create or replace function public.device_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_current uuid := (select ds.device_id from public.staff_device_sessions ds where ds.session_id = public._jwt_session());
begin
  perform public.require_permission('devices.manage');
  return jsonb_build_object(
    'settings', coalesce(public.get_setting('device_approval'), '{}'::jsonb),
    'devices', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', d.id, 'profile_id', d.profile_id, 'name', coalesce(nullif(p.full_name, ''), p.email), 'email', p.email,
        'role', r.code, 'role_name', r.name, 'is_active', p.is_active,
        'label', d.label, 'user_agent', d.user_agent, 'ip', d.ip, 'status', d.status, 'note', d.note,
        'decided_by', (select coalesce(nullif(x.full_name, ''), x.email) from public.profiles x where x.id = d.decided_by),
        'decided_at', d.decided_at, 'first_seen_at', d.first_seen_at, 'last_seen_at', d.last_seen_at,
        'sessions', (select count(*) from public.staff_device_sessions s where s.device_id = d.id),
        'is_current', d.id = v_current)
        order by (d.status = 'PENDING') desc, d.last_seen_at desc)
      from public.staff_devices d
      join public.profiles p on p.id = d.profile_id
      join public.roles r on r.id = p.role_id), '[]'::jsonb));
end;
$$;

create or replace function public.device_decide(p_id uuid, p_action text, p_note text default null)
returns public.staff_devices
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old public.staff_devices;
  v_row public.staff_devices;
  v_status text := case upper(coalesce(p_action, '')) when 'APPROVE' then 'APPROVED' when 'REJECT' then 'REJECTED' when 'REVOKE' then 'REVOKED' end;
begin
  perform public.require_permission('devices.manage');
  if v_status is null then
    raise exception 'VALIDATION: choose approve, reject or revoke' using errcode = '22023';
  end if;
  select * into v_old from public.staff_devices where id = p_id for update;
  if v_old.id is null then
    raise exception 'NOT_FOUND: device not found' using errcode = 'P0002';
  end if;
  if v_status <> 'APPROVED' and exists (select 1 from public.staff_device_sessions where session_id = public._jwt_session() and device_id = p_id) then
    raise exception 'VALIDATION: this is the device you are using — sign in elsewhere to block it' using errcode = '22023';
  end if;
  update public.staff_devices set status = v_status, decided_by = auth.uid(), decided_at = now(), note = nullif(trim(coalesce(p_note, '')), '')
  where id = p_id returning * into v_row;
  perform public.log_audit('device.' || lower(v_status), 'staff_device', p_id::text, to_jsonb(v_old) - 'token_hash', to_jsonb(v_row) - 'token_hash');
  return v_row;
end;
$$;

/** Approves every waiting device seen in the last p_days days (for switching the check on). */
create or replace function public.device_approve_recent(p_days int default 30)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int;
begin
  perform public.require_permission('devices.manage');
  update public.staff_devices d set status = 'APPROVED', decided_by = auth.uid(), decided_at = now(),
    note = 'Approved in bulk when device approval was switched on'
  from public.profiles p
  where p.id = d.profile_id and p.is_active and d.status = 'PENDING'
    and d.last_seen_at > now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 365));
  get diagnostics v_count = row_count;
  perform public.log_audit('device.approve_recent', 'staff_device', 'bulk', null, jsonb_build_object('days', p_days, 'approved', v_count));
  return v_count;
end;
$$;

create or replace function public.device_settings_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb := coalesce(public.get_setting('device_approval'), '{}'::jsonb);
  v_role text := public.current_role_code();
begin
  perform public.require_permission('devices.manage');
  if p ? 'enabled' then
    if (p ->> 'enabled')::boolean and v_role <> 'OWNER' and not exists (
      select 1 from public.staff_device_sessions ds join public.staff_devices d on d.id = ds.device_id
      where ds.session_id = public._jwt_session() and d.profile_id = auth.uid() and d.status = 'APPROVED') then
      raise exception 'VALIDATION: approve the device you are using first, or you will lock yourself out' using errcode = '22023';
    end if;
    v := v || jsonb_build_object('enabled', (p ->> 'enabled')::boolean);
  end if;
  if p ? 'auto_approve_first' then
    v := v || jsonb_build_object('auto_approve_first', (p ->> 'auto_approve_first')::boolean);
  end if;
  update public.settings set value = v, updated_by = auth.uid() where key = 'device_approval';
  perform public.log_audit('device.settings', 'settings', 'device_approval', null, v);
  return v;
end;
$$;

-- Settings with their own screens and validation are not writable through
-- the generic setter.
create or replace function public.admin_update_setting(p_key text, p_value jsonb)
returns public.settings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.settings;
  v_medium numeric;
  v_high numeric;
  v_critical numeric;
begin
  perform public.require_permission('settings.manage');
  if p_value is null or jsonb_typeof(p_value) <> 'object' then
    raise exception 'VALIDATION: setting value must be a JSON object' using errcode = '22023';
  end if;
  if p_key in ('device_approval', 'hr', 'pbx') then
    raise exception 'VALIDATION: change this setting on its own screen' using errcode = '22023';
  end if;
  if p_key = 'fraud' then
    v_medium := (p_value #>> '{thresholds,medium}')::numeric;
    v_high := (p_value #>> '{thresholds,high}')::numeric;
    v_critical := (p_value #>> '{thresholds,critical}')::numeric;
    if v_medium is null or v_high is null or v_critical is null
       or not (0 <= v_medium and v_medium < v_high and v_high < v_critical and v_critical <= 100) then
      raise exception 'VALIDATION: fraud thresholds must satisfy 0 <= medium < high < critical <= 100'
        using errcode = '22023';
    end if;
  end if;
  if p_key = 'store' and coalesce(p_value ->> 'order_prefix', '') !~ '^[A-Z0-9]{1,8}$' then
    raise exception 'VALIDATION: order prefix must be 1-8 uppercase letters or digits' using errcode = '22023';
  end if;
  if p_key = 'advanced' and coalesce((p_value ->> 'idle_logout_minutes')::int, 0) not between 0 and 1440 then
    raise exception 'VALIDATION: automatic sign-out must be between 0 (off) and 1440 minutes' using errcode = '22023';
  end if;
  if p_key = 'merchant' and jsonb_typeof(coalesce(p_value -> 'payout_accounts', '[]'::jsonb)) <> 'array' then
    raise exception 'VALIDATION: payout accounts must be a list' using errcode = '22023';
  end if;

  update public.settings set value = p_value, updated_by = auth.uid()
  where key = p_key returning * into v_row;
  if not found then
    raise exception 'NOT_FOUND: unknown setting %', p_key using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- Order sources
-- ---------------------------------------------------------------------------
create table if not exists public.order_sources (
  code text primary key check (code ~ '^[A-Z0-9_]{2,30}$'),
  label text not null check (length(trim(label)) between 2 and 40),
  channel text not null check (channel in ('messaging', 'phone', 'organic_social', 'offline', 'referral', 'direct', 'other')),
  is_active boolean not null default true,
  sort_order int not null default 100,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create or replace trigger order_sources_updated_at before update on public.order_sources
  for each row execute function public.set_updated_at();

insert into public.order_sources(code, label, channel, sort_order, is_system) values
  ('MESSENGER', 'Messenger', 'messaging', 10, true),
  ('WHATSAPP', 'WhatsApp', 'messaging', 20, true),
  ('PHONE', 'Phone call', 'phone', 30, true),
  ('FACEBOOK_COMMENT', 'Facebook', 'organic_social', 40, true),
  ('INSTAGRAM_DM', 'Instagram', 'messaging', 50, true),
  ('WALK_IN', 'Walk-in', 'offline', 60, true),
  ('REFERRAL', 'Referral', 'referral', 70, true),
  ('REPEAT_CUSTOMER', 'Repeat customer', 'direct', 80, true),
  ('OTHER', 'Other', 'other', 90, true)
on conflict (code) do nothing;

alter table public.order_sources enable row level security;
create policy order_sources_staff_read on public.order_sources for select to authenticated
  using ((select public.is_staff()));
revoke all on public.order_sources from anon, authenticated;
grant select on public.order_sources to authenticated;

create or replace function public.order_source_save(p jsonb)
returns public.order_sources
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code text := upper(trim(coalesce(p ->> 'code', '')));
  v_row public.order_sources;
  v_old public.order_sources;
begin
  perform public.require_permission('settings.manage');
  select * into v_old from public.order_sources where code = v_code;
  if v_old.code is null then
    if v_code = '' then
      v_code := upper(regexp_replace(trim(coalesce(p ->> 'label', '')), '[^A-Za-z0-9]+', '_', 'g'));
      v_code := trim(both '_' from left(v_code, 30));
    end if;
    if v_code !~ '^[A-Z0-9_]{2,30}$' then
      raise exception 'VALIDATION: give the source a name of at least 2 letters' using errcode = '22023';
    end if;
    if exists (select 1 from public.order_sources where code = v_code) then
      raise exception 'VALIDATION: a source with this name already exists' using errcode = '23505';
    end if;
    insert into public.order_sources(code, label, channel, is_active, sort_order)
    values (v_code, trim(p ->> 'label'), coalesce(nullif(p ->> 'channel', ''), 'other'), coalesce((p ->> 'is_active')::boolean, true),
      coalesce((p ->> 'sort_order')::int, (select coalesce(max(sort_order), 0) + 10 from public.order_sources)))
    returning * into v_row;
  else
    update public.order_sources set
      label = coalesce(nullif(trim(p ->> 'label'), ''), label),
      channel = coalesce(nullif(p ->> 'channel', ''), channel),
      is_active = coalesce((p ->> 'is_active')::boolean, is_active),
      sort_order = coalesce((p ->> 'sort_order')::int, sort_order)
    where code = v_code returning * into v_row;
  end if;
  perform public.log_audit('order_source.save', 'order_source', v_row.code, to_jsonb(v_old), to_jsonb(v_row));
  return v_row;
end;
$$;

create or replace function public.admin_set_order_source(p_order_id uuid, p_source text, p_note text default null)
returns public.order_attributions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.order_attributions;
  v_channel text;
  v_label text;
  v_old jsonb;
begin
  perform public.require_permission('orders.update');
  select channel, label into v_channel, v_label from public.order_sources
  where code = upper(trim(coalesce(p_source, ''))) and is_active;
  if v_channel is null then
    raise exception 'VALIDATION: choose where this order came from' using errcode = '22023';
  end if;
  select to_jsonb(a) into v_old from public.order_attributions a where order_id = p_order_id;
  if v_old is not null and v_old ->> 'recorded_by' = 'STOREFRONT' and v_old ->> 'channel' not in ('unknown', 'direct') then
    raise exception 'VALIDATION: this order already has tracked source data (%)', v_old ->> 'source' using errcode = '22023';
  end if;
  insert into public.order_attributions(order_id, channel, source, medium, is_paid, recorded_by, note, first_channel, first_source)
  values (p_order_id, v_channel, v_label, 'Manual', false, 'STAFF', left(p_note, 300), v_channel, v_label)
  on conflict (order_id) do update set channel = excluded.channel, source = excluded.source, medium = excluded.medium,
    is_paid = excluded.is_paid, recorded_by = 'STAFF', note = excluded.note, attributed_at = now()
  returning * into v_row;
  perform public._order_log(p_order_id, 'SOURCE_SET', format('Order source set to %s', v_label), null, null,
    jsonb_build_object('source', v_label, 'note', p_note));
  perform public.log_audit('order.source_set', 'order', p_order_id::text, v_old, to_jsonb(v_row));
  return v_row;
end;
$$;

/** Orders per source over the last p_days days (0 = all time): manual sources, tracked channels and unattributed. */
create or replace function public.order_source_stats(p_days int default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('orders.view');
  return coalesce((
    select jsonb_agg(x order by (x ->> 'orders')::int desc) from (
      select jsonb_build_object(
        'kind', g.kind, 'label', g.label, 'channel', g.channel,
        'orders', count(*),
        'delivered', count(*) filter (where o.status in ('DELIVERED', 'PARTIALLY_DELIVERED')),
        'returned', count(*) filter (where o.status in ('RETURNED', 'RETURNING', 'FAILED_DELIVERY')),
        'cancelled', count(*) filter (where o.status in ('CANCELLED', 'REJECTED_FRAUD', 'PENDING_CANCEL')),
        'delivered_value', coalesce(sum(o.total_amount) filter (where o.status in ('DELIVERED', 'PARTIALLY_DELIVERED')), 0)) as x
      from public.orders o
      left join public.order_attributions a on a.order_id = o.id
      cross join lateral (select
        case when a.order_id is null then 'none' when a.recorded_by = 'STAFF' then 'manual' else 'tracked' end as kind,
        case when a.order_id is null then 'Unattributed' else coalesce(nullif(a.source, ''), 'Unknown') end as label,
        coalesce(a.channel, 'unknown') as channel) g
      where o.merged_into is null
        and (coalesce(p_days, 0) <= 0 or o.created_at > now() - make_interval(days => p_days))
      group by g.kind, g.label, g.channel) t), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Support tickets: bug reports and feedback
-- ---------------------------------------------------------------------------
create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  number bigint generated always as identity (start with 1001) unique,
  kind text not null check (kind in ('BUG', 'FEEDBACK')),
  category text not null default 'GENERAL' check (category ~ '^[A-Z_]{2,30}$'),
  subject text not null check (length(trim(subject)) between 3 and 140),
  body text not null check (length(trim(body)) between 5 and 4000),
  rating int check (rating between 1 and 5),
  status text not null default 'OPEN' check (status in ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED')),
  priority text not null default 'NORMAL' check (priority in ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  context jsonb not null default '{}'::jsonb,
  created_by uuid not null references public.profiles(id),
  replies int not null default 0,
  last_reply_at timestamptz,
  last_reply_by uuid references public.profiles(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists support_tickets_creator_idx on public.support_tickets(created_by, created_at desc);
create index if not exists support_tickets_status_idx on public.support_tickets(status, created_at desc);
create or replace trigger support_tickets_updated_at before update on public.support_tickets
  for each row execute function public.set_updated_at();

create table if not exists public.support_ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets(id),
  author_id uuid not null references public.profiles(id),
  body text not null check (length(trim(body)) between 1 and 4000),
  is_support boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists support_ticket_messages_ticket_idx on public.support_ticket_messages(ticket_id, created_at);

alter table public.support_tickets enable row level security;
alter table public.support_ticket_messages enable row level security;
create policy support_tickets_read on public.support_tickets for select to authenticated
  using (created_by = auth.uid() or (select public.has_permission('support.manage')));
create policy support_ticket_messages_read on public.support_ticket_messages for select to authenticated
  using (exists (select 1 from public.support_tickets t where t.id = ticket_id
                 and (t.created_by = auth.uid() or (select public.has_permission('support.manage')))));
revoke all on public.support_tickets, public.support_ticket_messages from anon, authenticated;
grant select on public.support_tickets, public.support_ticket_messages to authenticated;

create or replace function public.support_ticket_create(p jsonb)
returns public.support_tickets
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.support_tickets;
  v_kind text := upper(coalesce(p ->> 'kind', ''));
  v_name text;
begin
  if not public.is_staff() then
    raise exception 'PERMISSION_DENIED: staff only' using errcode = '42501';
  end if;
  if v_kind not in ('BUG', 'FEEDBACK') then
    raise exception 'VALIDATION: choose bug report or feedback' using errcode = '22023';
  end if;
  if length(trim(coalesce(p ->> 'subject', ''))) < 3 then
    raise exception 'VALIDATION: add a short title' using errcode = '22023';
  end if;
  if length(trim(coalesce(p ->> 'body', ''))) < 5 then
    raise exception 'VALIDATION: describe it in a few words' using errcode = '22023';
  end if;
  if (select count(*) from public.support_tickets where created_by = auth.uid() and created_at > now() - interval '1 hour') >= 20 then
    raise exception 'VALIDATION: too many reports in the last hour — try again later' using errcode = '22023';
  end if;
  insert into public.support_tickets(kind, category, subject, body, rating, priority, context, created_by)
  values (v_kind, upper(coalesce(nullif(p ->> 'category', ''), 'GENERAL')), left(trim(p ->> 'subject'), 140), left(trim(p ->> 'body'), 4000),
    case when v_kind = 'FEEDBACK' then nullif(p ->> 'rating', '')::int end,
    case when v_kind = 'BUG' and upper(coalesce(p ->> 'priority', '')) in ('LOW', 'NORMAL', 'HIGH', 'URGENT') then upper(p ->> 'priority') else 'NORMAL' end,
    jsonb_strip_nulls(jsonb_build_object('page', left(p #>> '{context,page}', 300), 'browser', left(p #>> '{context,browser}', 300),
      'screen', left(p #>> '{context,screen}', 40), 'version', left(p #>> '{context,version}', 60))),
    auth.uid())
  returning * into v_row;
  if v_kind = 'BUG' then
    select coalesce(nullif(trim(full_name), ''), email) into v_name from public.profiles where id = auth.uid();
    perform public._log_system_event('WARN', 'OTHER', 'staff-report',
      left(format('Bug #%s by %s: %s', v_row.number, coalesce(v_name, 'staff'), v_row.subject), 2000),
      jsonb_build_object('ticket_id', v_row.id, 'page', v_row.context ->> 'page', 'user_id', auth.uid()));
  end if;
  return v_row;
end;
$$;

create or replace function public.support_ticket_reply(p_id uuid, p_body text)
returns public.support_ticket_messages
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_t public.support_tickets;
  v_support boolean := public.has_permission('support.manage');
  v_row public.support_ticket_messages;
begin
  select * into v_t from public.support_tickets where id = p_id for update;
  if v_t.id is null or not (v_t.created_by = auth.uid() or v_support) or not public.is_staff() then
    raise exception 'NOT_FOUND: ticket not found' using errcode = 'P0002';
  end if;
  if length(trim(coalesce(p_body, ''))) < 1 then
    raise exception 'VALIDATION: write a reply' using errcode = '22023';
  end if;
  insert into public.support_ticket_messages(ticket_id, author_id, body, is_support)
  values (p_id, auth.uid(), left(trim(p_body), 4000), v_support and v_t.created_by <> auth.uid())
  returning * into v_row;
  update public.support_tickets set replies = replies + 1, last_reply_at = now(), last_reply_by = auth.uid(),
    -- The reporter writing again reopens a resolved ticket.
    status = case when v_t.created_by = auth.uid() and status in ('RESOLVED', 'CLOSED') then 'OPEN' else status end,
    resolved_at = case when v_t.created_by = auth.uid() and status in ('RESOLVED', 'CLOSED') then null else resolved_at end
  where id = p_id;
  return v_row;
end;
$$;

create or replace function public.support_ticket_update(p_id uuid, p jsonb)
returns public.support_tickets
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_t public.support_tickets;
  v_support boolean := public.has_permission('support.manage');
  v_status text := upper(nullif(p ->> 'status', ''));
  v_priority text := upper(nullif(p ->> 'priority', ''));
  v_row public.support_tickets;
begin
  select * into v_t from public.support_tickets where id = p_id for update;
  if v_t.id is null or not (v_t.created_by = auth.uid() or v_support) or not public.is_staff() then
    raise exception 'NOT_FOUND: ticket not found' using errcode = 'P0002';
  end if;
  if v_status is not null and v_status not in ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED') then
    raise exception 'VALIDATION: unknown status' using errcode = '22023';
  end if;
  if v_priority is not null and v_priority not in ('LOW', 'NORMAL', 'HIGH', 'URGENT') then
    raise exception 'VALIDATION: unknown priority' using errcode = '22023';
  end if;
  -- The reporter can only close or reopen their own ticket.
  if not v_support and (v_priority is not null or (v_status is not null and v_status not in ('CLOSED', 'OPEN'))) then
    raise exception 'PERMISSION_DENIED: support.manage is required' using errcode = '42501';
  end if;
  update public.support_tickets set
    status = coalesce(v_status, status),
    priority = coalesce(v_priority, priority),
    resolved_at = case when coalesce(v_status, status) in ('RESOLVED', 'CLOSED') then coalesce(resolved_at, now()) else null end
  where id = p_id returning * into v_row;
  perform public.log_audit('support.update', 'support_ticket', p_id::text,
    jsonb_build_object('status', v_t.status, 'priority', v_t.priority), jsonb_build_object('status', v_row.status, 'priority', v_row.priority));
  return v_row;
end;
$$;

-- Report Issue (header menu) now also opens a bug ticket the reporter can follow.
create or replace function public.report_issue(p_message text, p_context jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_msg text := trim(coalesce(p_message, ''));
  v_t public.support_tickets;
begin
  if not public.is_staff() then
    raise exception 'PERMISSION_DENIED: staff only' using errcode = '42501';
  end if;
  if length(v_msg) < 5 then
    raise exception 'VALIDATION: Describe the problem in a few words' using errcode = '22023';
  end if;
  v_t := public.support_ticket_create(jsonb_build_object('kind', 'BUG', 'subject',
    case when length(v_msg) > 80 then left(v_msg, 77) || '…' else v_msg end, 'body', v_msg, 'context', coalesce(p_context, '{}'::jsonb)));
  return v_t.number;
end;
$$;

-- ---------------------------------------------------------------------------
-- Cloud PBX call log
-- ---------------------------------------------------------------------------
create table if not exists public.pbx_calls (
  id uuid primary key default gen_random_uuid(),
  call_id text not null unique check (length(call_id) between 1 and 200),
  direction text not null default 'UNKNOWN' check (direction in ('INBOUND', 'OUTBOUND', 'INTERNAL', 'UNKNOWN')),
  from_number text,
  to_number text,
  customer_phone text,
  extension text,
  profile_id uuid references public.profiles(id),
  customer_id uuid references public.customers(id),
  order_id uuid references public.orders(id),
  status text not null default 'UNKNOWN' check (status in ('RINGING', 'ANSWERED', 'NO_ANSWER', 'BUSY', 'FAILED', 'UNKNOWN')),
  duration_seconds int check (duration_seconds is null or duration_seconds >= 0),
  recording_url text,
  started_at timestamptz,
  ended_at timestamptz,
  events int not null default 1,
  raw jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists pbx_calls_started_idx on public.pbx_calls(coalesce(started_at, received_at) desc);
create index if not exists pbx_calls_customer_idx on public.pbx_calls(customer_phone);

alter table public.pbx_calls enable row level security;
create policy pbx_calls_staff_read on public.pbx_calls for select to authenticated
  using ((select public.has_permission('orders.view')));
revoke all on public.pbx_calls from anon, authenticated;
grant select on public.pbx_calls to authenticated;

/**
 * Records one PBX call event (the pbx edge function maps the provider's
 * fields first). Idempotent per call_id: a repeated or later event for the
 * same call updates it; it never creates a second row.
 */
create or replace function public.pbx_record_call(p jsonb)
returns public.pbx_calls
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.pbx_calls;
  v_dir text := upper(coalesce(nullif(p ->> 'direction', ''), 'UNKNOWN'));
  v_from text := left(nullif(trim(p ->> 'from'), ''), 40);
  v_to text := left(nullif(trim(p ->> 'to'), ''), 40);
  v_ext text := left(nullif(trim(p ->> 'extension'), ''), 20);
  v_status text := upper(coalesce(nullif(p ->> 'status', ''), 'UNKNOWN'));
  v_customer text;
  v_cust uuid;
  v_order uuid;
  v_profile uuid;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if coalesce(p ->> 'call_id', '') = '' then
    raise exception 'VALIDATION: call id missing' using errcode = '22023';
  end if;
  if v_dir not in ('INBOUND', 'OUTBOUND', 'INTERNAL', 'UNKNOWN') then v_dir := 'UNKNOWN'; end if;
  if v_status not in ('RINGING', 'ANSWERED', 'NO_ANSWER', 'BUSY', 'FAILED', 'UNKNOWN') then v_status := 'UNKNOWN'; end if;
  -- The customer is the outside party: the caller for inbound, the callee for outbound.
  v_customer := public.normalize_phone(case when v_dir = 'OUTBOUND' then v_to else v_from end);
  if v_customer is not null then
    select id into v_cust from public.customers where phone = v_customer limit 1;
    select id into v_order from public.orders where customer_phone = v_customer and merged_into is null order by created_at desc limit 1;
  end if;
  if v_ext is not null then
    select (e ->> 'profile_id')::uuid into v_profile
    from jsonb_array_elements(coalesce(public.get_setting('pbx') -> 'extensions', '[]'::jsonb)) e
    where e ->> 'extension' = v_ext and coalesce(e ->> 'profile_id', '') ~ '^[0-9a-f-]{36}$' limit 1;
  end if;
  insert into public.pbx_calls(call_id, direction, from_number, to_number, customer_phone, extension, profile_id, customer_id, order_id,
    status, duration_seconds, recording_url, started_at, ended_at, raw)
  values (left(p ->> 'call_id', 200), v_dir, v_from, v_to, v_customer, v_ext, v_profile, v_cust, v_order, v_status,
    nullif(p ->> 'duration', '')::int, left(nullif(p ->> 'recording_url', ''), 500),
    nullif(p ->> 'started_at', '')::timestamptz, nullif(p ->> 'ended_at', '')::timestamptz, coalesce(p -> 'raw', '{}'::jsonb))
  on conflict (call_id) do update set
    direction = case when excluded.direction <> 'UNKNOWN' then excluded.direction else pbx_calls.direction end,
    from_number = coalesce(excluded.from_number, pbx_calls.from_number),
    to_number = coalesce(excluded.to_number, pbx_calls.to_number),
    customer_phone = coalesce(excluded.customer_phone, pbx_calls.customer_phone),
    extension = coalesce(excluded.extension, pbx_calls.extension),
    profile_id = coalesce(excluded.profile_id, pbx_calls.profile_id),
    customer_id = coalesce(excluded.customer_id, pbx_calls.customer_id),
    order_id = coalesce(excluded.order_id, pbx_calls.order_id),
    status = case when excluded.status not in ('UNKNOWN', 'RINGING') or pbx_calls.status in ('UNKNOWN', 'RINGING') then excluded.status else pbx_calls.status end,
    duration_seconds = coalesce(excluded.duration_seconds, pbx_calls.duration_seconds),
    recording_url = coalesce(excluded.recording_url, pbx_calls.recording_url),
    started_at = coalesce(pbx_calls.started_at, excluded.started_at),
    ended_at = coalesce(excluded.ended_at, pbx_calls.ended_at),
    raw = excluded.raw,
    events = pbx_calls.events + 1,
    updated_at = now()
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.pbx_settings_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb := coalesce(public.get_setting('pbx'), '{}'::jsonb);
  v_url text;
begin
  perform public.require_permission('settings.manage');
  if p ? 'enabled' then v := v || jsonb_build_object('enabled', (p ->> 'enabled')::boolean); end if;
  if p ? 'provider' then v := v || jsonb_build_object('provider', left(coalesce(nullif(trim(p ->> 'provider'), ''), 'PBX'), 40)); end if;
  if p ? 'click_mode' then
    if p ->> 'click_mode' not in ('tel', 'api') then
      raise exception 'VALIDATION: choose phone link or PBX API' using errcode = '22023';
    end if;
    v := v || jsonb_build_object('click_mode', p ->> 'click_mode');
  end if;
  if p ? 'api_method' then
    if upper(p ->> 'api_method') not in ('GET', 'POST') then
      raise exception 'VALIDATION: method must be GET or POST' using errcode = '22023';
    end if;
    v := v || jsonb_build_object('api_method', upper(p ->> 'api_method'));
  end if;
  if p ? 'api_url_template' then
    v_url := trim(coalesce(p ->> 'api_url_template', ''));
    if v_url <> '' and (v_url !~ '^https://[^/\s]+' or position('{number}' in v_url) = 0 and position('{number}' in coalesce(p ->> 'api_body_template', v ->> 'api_body_template', '')) = 0) then
      raise exception 'VALIDATION: the API address must start with https:// and contain {number} (in the address or the body)' using errcode = '22023';
    end if;
    v := v || jsonb_build_object('api_url_template', left(v_url, 500));
  end if;
  if p ? 'api_body_template' then v := v || jsonb_build_object('api_body_template', left(coalesce(p ->> 'api_body_template', ''), 2000)); end if;
  if p ? 'extensions' then
    if jsonb_typeof(p -> 'extensions') <> 'array' or exists (
      select 1 from jsonb_array_elements(p -> 'extensions') e
      where coalesce(e ->> 'extension', '') !~ '^[0-9A-Za-z*#+]{1,20}$'
         or not exists (select 1 from public.profiles pr where pr.id::text = e ->> 'profile_id')) then
      raise exception 'VALIDATION: each extension needs a staff member and a number' using errcode = '22023';
    end if;
    if (select count(*) from jsonb_array_elements(p -> 'extensions') e) <> (select count(distinct e ->> 'extension') from jsonb_array_elements(p -> 'extensions') e) then
      raise exception 'VALIDATION: an extension can belong to one staff member only' using errcode = '22023';
    end if;
    v := v || jsonb_build_object('extensions', p -> 'extensions');
  end if;
  update public.settings set value = v, updated_by = auth.uid() where key = 'pbx';
  perform public.log_audit('pbx.settings', 'settings', 'pbx', null, v);
  return v;
end;
$$;

-- ---------------------------------------------------------------------------
-- Integrations overview and system status (no secrets, only state)
-- ---------------------------------------------------------------------------
create or replace function public.integrations_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_creds jsonb;
begin
  perform public.require_permission('settings.view');
  select coalesce(jsonb_object_agg(key, jsonb_build_object('hint', hint, 'at', connected_at)), '{}'::jsonb) into v_creds
  from public.integration_credentials where hint is not null;
  return jsonb_build_object(
    'channels', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'platform', platform, 'status', status, 'domain', shop_domain,
        'last_sync_at', last_sync_at, 'last_order_at', last_order_at, 'last_error', last_error, 'orders', orders_imported) order by created_at)
      from public.sales_channels where status <> 'DISCONNECTED'), '[]'::jsonb),
    'couriers', coalesce((select jsonb_agg(jsonb_build_object('name', c.name, 'provider', cc.provider, 'hint', cc.hint, 'at', cc.connected_at,
        'last_event_at', (select max(e.received_at) from public.courier_webhook_events e where e.provider = cc.provider)) order by c.name)
      from public.courier_credentials cc join public.couriers c on c.id = cc.courier_id where cc.hint is not null), '[]'::jsonb),
    'ads', coalesce((select jsonb_agg(jsonb_build_object('platform', platform, 'name', coalesce(display_name, external_user), 'status', status,
        'last_error', last_error, 'at', connected_at) order by platform) from public.ad_connections), '[]'::jsonb)
      || coalesce((select jsonb_agg(jsonb_build_object('platform', 'META', 'name', coalesce(meta_name, name),
        'status', case when connection_status = 'ERROR' or last_sync_status = 'ERROR' then 'ERROR' else connection_status end,
        'last_error', coalesce(connection_error, last_sync_error), 'at', created_at) order by name)
      from public.meta_ad_accounts where is_active and token_hint is not null), '[]'::jsonb),
    'credentials', v_creds,
    'sms', (select jsonb_build_object('provider', value ->> 'provider', 'enabled', value -> 'enabled') from public.settings where key = 'sms'),
    'site_keys', (select count(*) from public.site_api_keys where revoked_at is null),
    'domains', coalesce((select jsonb_agg(jsonb_build_object('domain', domain, 'status', status)) from public.store_domains), '[]'::jsonb),
    'pbx', (select jsonb_build_object('enabled', value -> 'enabled', 'provider', value ->> 'provider', 'mode', value ->> 'click_mode',
        'calls_7d', (select count(*) from public.pbx_calls where received_at > now() - interval '7 days'),
        'last_call_at', (select max(received_at) from public.pbx_calls))
      from public.settings where key = 'pbx'));
end;
$$;

create or replace function public.system_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb := '[]'::jsonb;
  v_n1 bigint;
  v_n2 bigint;
  v_at timestamptz;
  v_cron jsonb;
begin
  perform public.require_permission('settings.view');

  v := v || jsonb_build_object('key', 'database', 'name', 'Database', 'status', 'ok', 'detail', 'Responding', 'at', now());

  select count(*) filter (where status = 'FAILED' and updated_at > now() - interval '24 hours'),
         count(*) filter (where status = 'PENDING' and next_attempt_at < now() - interval '15 minutes'),
         max(done_at)
    into v_n1, v_n2, v_at from public.channel_sync_jobs;
  v := v || jsonb_build_object('key', 'store_sync', 'name', 'Store sync jobs',
    'status', case when v_n2 > 0 then 'warn' when v_n1 > 0 then 'warn' else 'ok' end,
    'detail', case when v_n2 > 0 then format('%s job(s) overdue', v_n2) when v_n1 > 0 then format('%s failed in 24 h', v_n1) else 'Running normally' end,
    'at', v_at);

  select count(*) filter (where status in ('ERROR')), max(last_sync_at) into v_n1, v_at
  from public.sales_channels where status <> 'DISCONNECTED';
  v := v || jsonb_build_object('key', 'channels', 'name', 'Connected stores',
    'status', case when v_n1 > 0 then 'down' when v_at is null then 'idle' else 'ok' end,
    'detail', case when v_n1 > 0 then format('%s store(s) with errors', v_n1) when v_at is null then 'No store connected' else 'Connected' end,
    'at', v_at);

  select count(*) filter (where result = 'FAILED' and received_at > now() - interval '24 hours'), max(received_at) into v_n1, v_at
  from public.courier_webhook_events;
  v := v || jsonb_build_object('key', 'courier_webhooks', 'name', 'Courier webhooks',
    'status', case when v_n1 > 0 then 'warn' when v_at is null then 'idle' else 'ok' end,
    'detail', case when v_n1 > 0 then format('%s failed in 24 h', v_n1) when v_at is null then 'Nothing received yet' else 'Receiving updates' end,
    'at', v_at);

  select count(*) filter (where status = 'FAILED' and created_at > now() - interval '24 hours'),
         count(*) filter (where status = 'QUEUED' and next_attempt_at < now() - interval '15 minutes'),
         max(sent_at)
    into v_n1, v_n2, v_at from public.notification_logs;
  v := v || jsonb_build_object('key', 'messages', 'name', 'SMS & notifications',
    'status', case when v_n2 > 0 then 'warn' when v_n1 > 0 then 'warn' when v_at is null then 'idle' else 'ok' end,
    'detail', case when v_n2 > 0 then format('%s message(s) waiting too long', v_n2) when v_n1 > 0 then format('%s failed in 24 h', v_n1)
      when v_at is null then 'Nothing sent yet' else 'Sending' end,
    'at', v_at);

  select count(*) filter (where created_at > now() - interval '24 hours'), max(created_at) into v_n1, v_at from public.payment_events;
  v := v || jsonb_build_object('key', 'payments', 'name', 'Payment gateways',
    'status', case when v_at is null then 'idle' else 'ok' end,
    'detail', case when v_at is null then 'No gateway events yet' else format('%s event(s) in 24 h', v_n1) end, 'at', v_at);

  select count(*) filter (where level = 'ERROR' and resolved_at is null and last_seen_at > now() - interval '24 hours'),
         max(last_seen_at) filter (where level = 'ERROR')
    into v_n1, v_at from public.system_logs;
  v := v || jsonb_build_object('key', 'errors', 'name', 'Application errors',
    'status', case when v_n1 > 0 then 'warn' else 'ok' end,
    'detail', case when v_n1 > 0 then format('%s unresolved error(s) in 24 h', v_n1) else 'No unresolved errors in 24 h' end, 'at', v_at);

  if to_regclass('cron.job_run_details') is not null then
    -- A rare "job startup timeout" is retried by the next run; warn only when
    -- a job's latest run failed or failures are more than 1 in 20.
    begin
      execute $q$
        select jsonb_build_object(
          'failed', count(*) filter (where status = 'failed'), 'runs', count(*), 'last', max(end_time),
          'latest_failed', (select count(*) from (select distinct on (jobid) status from cron.job_run_details
                                                   where start_time > now() - interval '24 hours' order by jobid, start_time desc) x
                            where x.status = 'failed'))
        from cron.job_run_details where start_time > now() - interval '24 hours'
      $q$ into v_cron;
      v := v || jsonb_build_object('key', 'cron', 'name', 'Scheduled tasks',
        'status', case when (v_cron ->> 'latest_failed')::int > 0 or (v_cron ->> 'failed')::int * 20 > (v_cron ->> 'runs')::int then 'warn'
          when v_cron ->> 'last' is null then 'idle' else 'ok' end,
        'detail', case when v_cron ->> 'last' is null then 'No runs in 24 h'
          when (v_cron ->> 'failed')::int > 0 then format('%s of %s runs failed in 24 h — each was retried on its next run', v_cron ->> 'failed', v_cron ->> 'runs')
          else format('%s runs in 24 h, all on schedule', v_cron ->> 'runs') end,
        'at', v_cron ->> 'last');
    exception when insufficient_privilege then
      null;
    end;
  end if;

  return jsonb_build_object('checked_at', now(), 'components', v);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function public._jwt_session(), public._device_ok(uuid, text) from public, anon;
grant execute on function public._jwt_session(), public._device_ok(uuid, text) to authenticated;
revoke all on function public.pbx_record_call(jsonb) from public, anon, authenticated;
revoke all on function public.device_register(text, text), public.device_list(), public.device_decide(uuid, text, text),
  public.device_approve_recent(int), public.device_settings_save(jsonb), public.order_source_save(jsonb), public.order_source_stats(int),
  public.support_ticket_create(jsonb), public.support_ticket_reply(uuid, text), public.support_ticket_update(uuid, jsonb),
  public.pbx_settings_save(jsonb), public.integrations_overview(), public.system_status() from public, anon;
grant execute on function public.device_register(text, text), public.device_list(), public.device_decide(uuid, text, text),
  public.device_approve_recent(int), public.device_settings_save(jsonb), public.order_source_save(jsonb), public.order_source_stats(int),
  public.support_ticket_create(jsonb), public.support_ticket_reply(uuid, text), public.support_ticket_update(uuid, jsonb),
  public.pbx_settings_save(jsonb), public.integrations_overview(), public.system_status() to authenticated;
