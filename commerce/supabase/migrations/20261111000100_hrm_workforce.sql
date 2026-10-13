-- =============================================================================
-- HRM: workforce controls
--
--   * Breaks: staff start and end breaks; idle time (no input in the admin for
--     the store's "auto break" minutes) becomes an IDLE break. Net work time is
--     check-in to check-out minus breaks, and worked_minutes now holds the net.
--   * Attendance access: when the store turns it on, staff must be checked in
--     (and, optionally, not on a break) to make changes in operational modules
--     (orders, products, inventory, customers, couriers, purchases, payments,
--     fraud, production, calls). Enforced in has_permission/require_permission,
--     so every function and every row-level write policy follows it. Viewing
--     is not blocked by the database; the admin hides those pages instead.
--     The store owner and staff marked "exempt" are never blocked.
--   * Work schedule: default check-in / check-out times for staff without a
--     shift, late grace, maximum break, holidays (existing table).
--   * Automatic check-out at the scheduled end, with a one-day "keep working"
--     exception; runs every 5 minutes for every merchant.
--   * Per-employee overrides (exempt, own break limit, auto break, auto
--     check-out).
--   * Requests: leave, attendance correction and late excuse, approved by HR.
--   * SOP checklists ticked off by staff each day, with compliance per team.
--   * Live dashboard, timeline and a month review per employee.
-- All writes go through security-definer functions with permission checks.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Tables and columns
-- ---------------------------------------------------------------------------
alter table public.hr_attendance
  add column if not exists break_minutes int not null default 0 check (break_minutes >= 0),
  add column if not exists checkout_source text check (checkout_source in ('SELF', 'AUTO', 'HR')),
  add column if not exists keep_open_today boolean not null default false;

alter table public.hr_employees
  add column if not exists attendance_exempt boolean not null default false,
  add column if not exists max_break_minutes int check (max_break_minutes between 0 and 480),
  add column if not exists auto_break boolean,
  add column if not exists auto_checkout boolean;

alter table public.hr_sops
  add column if not exists kind text not null default 'GUIDE' check (kind in ('GUIDE', 'CHECKLIST'));

create table if not exists public.hr_breaks (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null default public.current_merchant_id() references public.merchants(id),
  attendance_id uuid not null references public.hr_attendance(id) on delete cascade,
  profile_id uuid not null references public.profiles(id),
  kind text not null default 'MANUAL' check (kind in ('MANUAL', 'IDLE')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  ended_by text check (ended_by in ('SELF', 'CHECKOUT', 'AUTO_CHECKOUT', 'HR')),
  created_at timestamptz not null default now(),
  check (ended_at is null or ended_at >= started_at)
);
create index if not exists hr_breaks_attendance_idx on public.hr_breaks (attendance_id, started_at);
create unique index if not exists hr_breaks_one_open_idx on public.hr_breaks (attendance_id) where ended_at is null;
create index if not exists hr_breaks_merchant_idx on public.hr_breaks (merchant_id);

create table if not exists public.hr_requests (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null default public.current_merchant_id() references public.merchants(id),
  profile_id uuid not null references public.profiles(id),
  kind text not null check (kind in ('LEAVE', 'CORRECTION', 'LATE_EXCUSE')),
  from_date date not null,
  to_date date not null,
  check_in time,
  check_out time,
  reason text not null check (length(trim(reason)) between 3 and 500),
  status text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  decided_by uuid references public.profiles(id),
  decided_at timestamptz,
  decision_note text check (decision_note is null or length(decision_note) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (to_date >= from_date and to_date - from_date <= 30)
);
create index if not exists hr_requests_status_idx on public.hr_requests (merchant_id, status, created_at desc);
create index if not exists hr_requests_profile_idx on public.hr_requests (profile_id, created_at desc);
create or replace trigger hr_requests_updated_at before update on public.hr_requests for each row execute function public.set_updated_at();

create table if not exists public.hr_sop_checks (
  merchant_id uuid not null default public.current_merchant_id() references public.merchants(id),
  sop_id uuid not null references public.hr_sops(id) on delete cascade,
  profile_id uuid not null references public.profiles(id),
  work_date date not null,
  done int[] not null default '{}',
  items_total int not null check (items_total >= 0),
  sop_version int not null,
  updated_at timestamptz not null default now(),
  primary key (sop_id, profile_id, work_date)
);
create index if not exists hr_sop_checks_day_idx on public.hr_sop_checks (merchant_id, work_date);

do $$
declare t text;
begin
  foreach t in array array['hr_breaks', 'hr_requests', 'hr_sop_checks'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format($p$create policy tenant_isolation on public.%I as restrictive for all to public
      using (merchant_id = (select public.current_merchant_id()))
      with check (merchant_id = (select public.current_merchant_id()) and not (select public._support_read_only()))$p$, t);
    execute format('create policy app_owner_all on public.%I for all to app_owner using (true) with check (true)', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

create policy hr_breaks_read on public.hr_breaks for select to authenticated
  using (profile_id = (select auth.uid()) or (select public.has_permission('hr.view')));
create policy hr_requests_read on public.hr_requests for select to authenticated
  using (profile_id = (select auth.uid()) or (select public.has_permission('hr.view')));
create policy hr_sop_checks_read on public.hr_sop_checks for select to authenticated
  using (profile_id = (select auth.uid()) or (select public.has_permission('hr.view')));

-- ---------------------------------------------------------------------------
-- Settings and per-person rules
-- ---------------------------------------------------------------------------
-- The store's HR settings with defaults for every key. default_start / default_end
-- stay null until the store sets a work schedule (then staff without a shift are
-- measured against it).
create or replace function public._hr_cfg()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'work_days', '[0,1,2,3,4,6]'::jsonb, 'half_day_minutes', 240, 'allow_self_check_in', true,
    'require_check_in', false, 'block_during_breaks', true, 'auto_checkout', false,
    'default_start', null, 'default_end', null, 'late_grace_minutes', 15, 'max_break_minutes', 60,
    'auto_break', false, 'auto_break_after', 10, 'idle_warning_at', 8)
    || coalesce(public.get_setting('hr'), '{}'::jsonb)
$$;

-- Store settings with the person's overrides on top.
create or replace function public._hr_rules(p_profile uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select c
    || jsonb_build_object('exempt', coalesce(e.attendance_exempt, false))
    || jsonb_strip_nulls(jsonb_build_object('max_break_minutes', e.max_break_minutes, 'auto_break', e.auto_break, 'auto_checkout', e.auto_checkout))
  from (select public._hr_cfg() as c) x
  left join public.hr_employees e on e.profile_id = p_profile
$$;

-- The person's shift; without one, the store's work schedule (when set) as a shift.
create or replace function public._hr_shift_of(p_profile uuid)
returns public.hr_shifts
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v public.hr_shifts;
  c jsonb;
begin
  select s.* into v from public.hr_employees e join public.hr_shifts s on s.id = e.shift_id where e.profile_id = p_profile;
  if v.id is not null then
    return v;
  end if;
  c := public._hr_cfg();
  if nullif(c ->> 'default_start', '') is null or nullif(c ->> 'default_end', '') is null then
    return v;
  end if;
  v.id := '00000000-0000-0000-0000-000000000000';
  v.name := 'Standard hours';
  v.start_time := (c ->> 'default_start')::time;
  v.end_time := (c ->> 'default_end')::time;
  v.grace_minutes := coalesce((c ->> 'late_grace_minutes')::int, 15);
  v.work_days := (select coalesce(array_agg(x::int order by x::int), '{0,1,2,3,4,6}') from jsonb_array_elements_text(c -> 'work_days') x);
  v.is_active := true;
  return v;
end;
$$;

-- The open session (today, or an overnight one from yesterday).
create or replace function public._hr_open_session(p_profile uuid)
returns public.hr_attendance
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select * from public.hr_attendance
  where profile_id = p_profile and check_in_at is not null and check_out_at is null and work_date >= public._hr_today() - 1
  order by work_date desc limit 1
$$;

-- Minutes of all breaks of a session up to a moment (an open break counts until then).
create or replace function public._hr_break_total(p_attendance uuid, p_until timestamptz default now())
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(greatest(0, floor(extract(epoch from least(coalesce(b.ended_at, p_until), p_until) - b.started_at) / 60))), 0)::int
  from public.hr_breaks b where b.attendance_id = p_attendance and b.started_at < p_until
$$;

-- Why the caller may not change things in an operational module right now
-- (null = no reason). Viewing and exporting are never blocked here.
create or replace function public._hr_gate(p_code text)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_cfg jsonb;
  v_role text;
  v_att public.hr_attendance;
begin
  if auth.uid() is null or p_code like '%.view' or p_code like '%.export' then
    return null;
  end if;
  v_cfg := public._hr_cfg();
  if not coalesce((v_cfg ->> 'require_check_in')::boolean, false) then
    return null;
  end if;
  if not exists (select 1 from public.permissions pm where pm.code = p_code
                 and pm.module in ('orders', 'products', 'inventory', 'customers', 'couriers', 'purchases', 'payments', 'fraud', 'production', 'pbx')) then
    return null;
  end if;
  select r.code into v_role from public.profiles p join public.roles r on r.id = p.role_id where p.id = auth.uid();
  if v_role is null or v_role = 'OWNER' then
    return null;
  end if;
  if exists (select 1 from public.hr_employees e where e.profile_id = auth.uid() and e.attendance_exempt) then
    return null;
  end if;
  v_att := public._hr_open_session(auth.uid());
  if v_att.id is null then
    return 'CHECK_IN_REQUIRED';
  end if;
  if coalesce((v_cfg ->> 'block_during_breaks')::boolean, true)
     and exists (select 1 from public.hr_breaks b where b.attendance_id = v_att.id and b.ended_at is null) then
    return 'ON_BREAK';
  end if;
  return null;
end;
$$;

-- The permission check without the attendance rule.
create or replace function public._has_permission_raw(p_code text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (exists (
      select 1
      from public.profiles p
      join public.roles r on r.id = p.role_id
      where p.id = auth.uid()
        and p.merchant_id = public.current_merchant_id()
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
        ))
    and (case public.merchant_access_mode() when 'FULL' then true when 'READ_ONLY' then p_code like '%.view' or p_code like '%.export' else false end))
    or exists (
      select 1 from public.support_sessions s
      where s.id = public._support_session_id()
        and s.merchant_id = public.current_merchant_id()
        and (p_code like '%.view' or (s.mode = 'ASSIST' and p_code = any (s.permissions))))
$$;

-- Staff: role permission and, in operational modules, the attendance rule.
-- Support sessions are not staff attendance and are not held to it.
create or replace function public.has_permission(p_code text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (exists (
      select 1
      from public.profiles p
      join public.roles r on r.id = p.role_id
      where p.id = auth.uid()
        and p.merchant_id = public.current_merchant_id()
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
        ))
    and (case public.merchant_access_mode() when 'FULL' then true when 'READ_ONLY' then p_code like '%.view' or p_code like '%.export' else false end)
    and public._hr_gate(p_code) is null)
    or exists (
      select 1 from public.support_sessions s
      where s.id = public._support_session_id()
        and s.merchant_id = public.current_merchant_id()
        and (p_code like '%.view' or (s.mode = 'ASSIST' and p_code = any (s.permissions))))
$$;

create or replace function public.require_permission(p_code text)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_gate text;
begin
  if public.is_system_context() or public.has_permission(p_code) then
    return;
  end if;
  if public._has_permission_raw(p_code) then
    v_gate := public._hr_gate(p_code);
    if v_gate = 'CHECK_IN_REQUIRED' then
      raise exception 'CHECK_IN_REQUIRED: check in under HRM → Attendance to start work' using errcode = '42501';
    elsif v_gate = 'ON_BREAK' then
      raise exception 'ON_BREAK: end your break to continue working' using errcode = '42501';
    end if;
  end if;
  raise exception 'PERMISSION_DENIED: % is required', p_code using errcode = '42501';
end;
$$;

-- ---------------------------------------------------------------------------
-- Self service
-- ---------------------------------------------------------------------------
create or replace function public.hr_my_day()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_shift public.hr_shifts := public._hr_shift_of(auth.uid());
  v_row public.hr_attendance;
  v_today date := public._hr_today();
  v_rules jsonb := public._hr_rules(auth.uid());
  v_role text;
  v_end timestamptz;
begin
  if not public.is_staff() then
    raise exception 'PERMISSION_DENIED: staff only' using errcode = '42501';
  end if;
  select r.code into v_role from public.profiles p join public.roles r on r.id = p.role_id where p.id = auth.uid();
  -- An open overnight session from yesterday is still "today" for the person.
  v_row := public._hr_open_session(auth.uid());
  if v_row.id is null then
    select * into v_row from public.hr_attendance where profile_id = auth.uid() and work_date = v_today;
  end if;
  if v_row.id is not null and v_shift.id is not null then
    select b.ends_at into v_end from public._hr_shift_bounds(v_shift, v_row.work_date) b;
  end if;
  return jsonb_build_object(
    'date', v_today,
    'tz', public.store_timezone(),
    'now', now(),
    'record', case when v_row.id is null then null else to_jsonb(v_row) end,
    'breaks', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'kind', b.kind, 'started_at', b.started_at, 'ended_at', b.ended_at) order by b.started_at)
      from public.hr_breaks b where b.attendance_id = v_row.id), '[]'::jsonb),
    'break_minutes', case when v_row.id is null then 0 else public._hr_break_total(v_row.id) end,
    'shift', case when v_shift.id is null then null else jsonb_build_object('id', v_shift.id, 'name', v_shift.name,
      'start_time', v_shift.start_time, 'end_time', v_shift.end_time, 'grace_minutes', v_shift.grace_minutes) end,
    'scheduled_end', v_end,
    'work_day', public._hr_is_work_day(v_shift, v_today),
    'self_check_in', coalesce((v_rules ->> 'allow_self_check_in')::boolean, true),
    'rules', jsonb_build_object(
      'require_check_in', coalesce((v_rules ->> 'require_check_in')::boolean, false) and v_role <> 'OWNER' and not (v_rules ->> 'exempt')::boolean,
      'block_during_breaks', coalesce((v_rules ->> 'block_during_breaks')::boolean, true),
      'auto_break', coalesce((v_rules ->> 'auto_break')::boolean, false),
      'auto_break_after', coalesce((v_rules ->> 'auto_break_after')::int, 10),
      'idle_warning_at', coalesce((v_rules ->> 'idle_warning_at')::int, 8),
      'max_break_minutes', coalesce((v_rules ->> 'max_break_minutes')::int, 60),
      'auto_checkout', coalesce((v_rules ->> 'auto_checkout')::boolean, false) and not (v_rules ->> 'exempt')::boolean),
    'gate', public._hr_gate('orders.update'));
end;
$$;

create or replace function public.hr_check_out(p_note text default null)
returns public.hr_attendance
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_shift public.hr_shifts := public._hr_shift_of(auth.uid());
  v_row public.hr_attendance;
  v_score record;
  v_breaks int;
begin
  if not public.is_staff() then
    raise exception 'PERMISSION_DENIED: staff only' using errcode = '42501';
  end if;
  select * into v_row from public.hr_attendance
  where profile_id = auth.uid() and check_in_at is not null and check_out_at is null
    and work_date >= public._hr_today() - 1
  order by work_date desc limit 1 for update;
  if v_row.id is null then
    raise exception 'VALIDATION: check in first' using errcode = '22023';
  end if;
  update public.hr_breaks set ended_at = now(), ended_by = 'CHECKOUT' where attendance_id = v_row.id and ended_at is null;
  v_breaks := public._hr_break_total(v_row.id);
  select * into v_score from public._hr_score(v_shift, v_row.work_date, v_row.check_in_at, now() - make_interval(mins => v_breaks));
  update public.hr_attendance set check_out_at = now(), status = v_score.status, late_minutes = v_score.late_minutes,
    worked_minutes = v_score.worked_minutes, break_minutes = v_breaks, checkout_source = 'SELF',
    note = coalesce(nullif(trim(coalesce(p_note, '')), ''), note), updated_by = auth.uid()
  where id = v_row.id returning * into v_row;
  return v_row;
end;
$$;

-- Start a break (MANUAL) or record idle time (IDLE, sent by the admin after the store's idle minutes).
create or replace function public.hr_break_start(p_kind text default 'MANUAL')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.hr_attendance;
  v_break public.hr_breaks;
begin
  if not public.is_staff() then
    raise exception 'PERMISSION_DENIED: staff only' using errcode = '42501';
  end if;
  if coalesce(p_kind, '') not in ('MANUAL', 'IDLE') then
    raise exception 'VALIDATION: unknown break type' using errcode = '22023';
  end if;
  select * into v_row from public.hr_attendance
  where profile_id = auth.uid() and check_in_at is not null and check_out_at is null and work_date >= public._hr_today() - 1
  order by work_date desc limit 1 for update;
  if v_row.id is null then
    raise exception 'VALIDATION: check in first' using errcode = '22023';
  end if;
  if exists (select 1 from public.hr_breaks b where b.attendance_id = v_row.id and b.ended_at is null) then
    raise exception 'VALIDATION: you are already on a break' using errcode = '22023';
  end if;
  if p_kind = 'IDLE' and not coalesce((public._hr_rules(auth.uid()) ->> 'auto_break')::boolean, false) then
    raise exception 'VALIDATION: automatic breaks are off' using errcode = '22023';
  end if;
  insert into public.hr_breaks(attendance_id, profile_id, kind) values (v_row.id, auth.uid(), p_kind) returning * into v_break;
  return to_jsonb(v_break);
end;
$$;

create or replace function public.hr_break_end()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_break public.hr_breaks;
  v_total int;
  v_max int := coalesce((public._hr_rules(auth.uid()) ->> 'max_break_minutes')::int, 60);
begin
  if not public.is_staff() then
    raise exception 'PERMISSION_DENIED: staff only' using errcode = '42501';
  end if;
  update public.hr_breaks set ended_at = now(), ended_by = 'SELF'
  where profile_id = auth.uid() and ended_at is null
  returning * into v_break;
  if v_break.id is null then
    raise exception 'VALIDATION: you are not on a break' using errcode = '22023';
  end if;
  v_total := public._hr_break_total(v_break.attendance_id);
  update public.hr_attendance set break_minutes = v_total where id = v_break.attendance_id;
  return jsonb_build_object('break', to_jsonb(v_break),
    'minutes', floor(extract(epoch from v_break.ended_at - v_break.started_at) / 60)::int,
    'total_minutes', v_total, 'max_break_minutes', v_max, 'over_limit', v_total > v_max);
end;
$$;

-- Keep working past the scheduled end today: no automatic check-out for this session.
create or replace function public.hr_keep_working_today()
returns public.hr_attendance
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.hr_attendance;
begin
  if not public.is_staff() then
    raise exception 'PERMISSION_DENIED: staff only' using errcode = '42501';
  end if;
  update public.hr_attendance set keep_open_today = true, updated_by = auth.uid()
  where id = (public._hr_open_session(auth.uid())).id
  returning * into v_row;
  if v_row.id is null then
    raise exception 'VALIDATION: check in first' using errcode = '22023';
  end if;
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- Automatic check-out (scheduled for every merchant)
-- ---------------------------------------------------------------------------
-- Open sessions past their scheduled end are checked out at that end; an open
-- break is closed there too. Nothing is removed: the session keeps its times.
create or replace function public.hr_auto_checkout()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
  v_shift public.hr_shifts;
  v_end timestamptz;
  v_breaks int;
  v_score record;
  v_rules jsonb;
  v_done int := 0;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if not coalesce((public._hr_cfg() ->> 'auto_checkout')::boolean, false)
     and not exists (select 1 from public.hr_employees e where e.auto_checkout) then
    return 0;
  end if;
  for a in
    select * from public.hr_attendance
    where check_in_at is not null and check_out_at is null and not keep_open_today
    order by work_date
    for update skip locked
  loop
    v_rules := public._hr_rules(a.profile_id);
    continue when not coalesce((v_rules ->> 'auto_checkout')::boolean, false) or (v_rules ->> 'exempt')::boolean;
    v_shift := public._hr_shift_of(a.profile_id);
    continue when v_shift.id is null;
    select b.ends_at into v_end from public._hr_shift_bounds(v_shift, a.work_date) b;
    continue when now() < v_end;
    v_end := greatest(v_end, a.check_in_at);
    update public.hr_breaks set ended_at = greatest(started_at, v_end), ended_by = 'AUTO_CHECKOUT'
    where attendance_id = a.id and ended_at is null;
    v_breaks := public._hr_break_total(a.id, v_end);
    select * into v_score from public._hr_score(v_shift, a.work_date, a.check_in_at, v_end - make_interval(mins => v_breaks));
    update public.hr_attendance set check_out_at = v_end, status = v_score.status, late_minutes = v_score.late_minutes,
      worked_minutes = v_score.worked_minutes, break_minutes = v_breaks, checkout_source = 'AUTO'
    where id = a.id;
    v_done := v_done + 1;
  end loop;
  return v_done;
end;
$$;

-- for_each_merchant learns the new job (same body as before, one more name).
create or replace function public.for_each_merchant(p_job text)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  m record;
  v_runs int := 0;
  v_failed int := 0;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_job not in ('retry_courier_webhooks', 'expire_unpaid_advance_orders', 'pbx_sweep', 'hr_auto_checkout') then
    raise exception 'VALIDATION: unknown job %', p_job using errcode = '22023';
  end if;
  for m in select id from public.merchants where status <> 'CLOSED' order by number loop
    perform set_config('app.merchant_id', m.id::text, true);
    v_runs := v_runs + 1;
    -- One merchant's failure is logged for that merchant and does not stop the others.
    begin
      execute format('select public.%I()', p_job);
    exception when others then
      v_failed := v_failed + 1;
      perform public._log_system_event('ERROR', 'JOB', p_job, sqlerrm,
        jsonb_build_object('merchant_id', m.id, 'sqlstate', sqlstate));
    end;
  end loop;
  perform set_config('app.merchant_id', '', true);
  return jsonb_build_object('job', p_job, 'merchants', v_runs, 'failed', v_failed);
end;
$$;
revoke execute on function public.for_each_merchant(text) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('hr-auto-checkout', '*/5 * * * *', $c$select public.for_each_merchant('hr_auto_checkout')$c$);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- HR: corrections keep net time (breaks are subtracted)
-- ---------------------------------------------------------------------------
create or replace function public.hr_attendance_set(p_profile uuid, p_date date, p_status public.hr_attendance_status,
  p_check_in timestamptz default null, p_check_out timestamptz default null, p_note text default null)
returns public.hr_attendance
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_shift public.hr_shifts := public._hr_shift_of(p_profile);
  v_score record;
  v_row public.hr_attendance;
  v_status public.hr_attendance_status := p_status;
  v_breaks int := 0;
  v_existing uuid;
begin
  perform public.require_permission('hr.manage');
  if not exists (select 1 from public.profiles where id = p_profile) then
    raise exception 'NOT_FOUND: staff member not found' using errcode = 'P0002';
  end if;
  if p_date > public._hr_today() then
    raise exception 'VALIDATION: attendance cannot be set for a future day' using errcode = '22023';
  end if;
  if p_check_out is not null and p_check_in is not null and p_check_out < p_check_in then
    raise exception 'VALIDATION: check-out is before check-in' using errcode = '22023';
  end if;
  if p_status in ('PRESENT', 'LATE', 'HALF_DAY') and p_check_in is null then
    raise exception 'VALIDATION: add the check-in time' using errcode = '22023';
  end if;
  select id into v_existing from public.hr_attendance where profile_id = p_profile and work_date = p_date;
  if v_existing is not null and p_check_out is not null then
    update public.hr_breaks set ended_at = greatest(started_at, p_check_out), ended_by = 'HR' where attendance_id = v_existing and ended_at is null;
    v_breaks := public._hr_break_total(v_existing, p_check_out);
  end if;
  select * into v_score from public._hr_score(v_shift, p_date, p_check_in, p_check_out - make_interval(mins => v_breaks));
  -- Times decide present / late / half day; ABSENT, LEAVE and HOLIDAY are taken as chosen.
  if p_status in ('PRESENT', 'LATE', 'HALF_DAY') then
    v_status := v_score.status;
  end if;
  insert into public.hr_attendance(profile_id, work_date, check_in_at, check_out_at, status, late_minutes, worked_minutes, break_minutes,
    checkout_source, note, source, updated_by)
  values (p_profile, p_date, case when v_status in ('ABSENT', 'LEAVE', 'HOLIDAY') then null else p_check_in end,
    case when v_status in ('ABSENT', 'LEAVE', 'HOLIDAY') then null else p_check_out end, v_status,
    case when v_status in ('ABSENT', 'LEAVE', 'HOLIDAY') then 0 else v_score.late_minutes end,
    case when v_status in ('ABSENT', 'LEAVE', 'HOLIDAY') then null else v_score.worked_minutes end,
    case when v_status in ('ABSENT', 'LEAVE', 'HOLIDAY') then 0 else v_breaks end,
    case when p_check_out is not null and v_status not in ('ABSENT', 'LEAVE', 'HOLIDAY') then 'HR' end,
    nullif(trim(coalesce(p_note, '')), ''), 'ADMIN', auth.uid())
  on conflict (profile_id, work_date) do update set
    check_in_at = excluded.check_in_at, check_out_at = excluded.check_out_at, status = excluded.status,
    late_minutes = excluded.late_minutes, worked_minutes = excluded.worked_minutes, break_minutes = excluded.break_minutes,
    checkout_source = excluded.checkout_source, note = excluded.note, source = 'ADMIN', updated_by = auth.uid()
  returning * into v_row;
  perform public.log_audit('hr.attendance_set', 'hr_attendance', v_row.id::text, null,
    jsonb_build_object('profile_id', p_profile, 'date', p_date, 'status', v_status, 'check_in', p_check_in, 'check_out', p_check_out));
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- Live dashboard, timeline, month review
-- ---------------------------------------------------------------------------
-- Everyone's state right now (or on a past day), with their breaks for the timeline,
-- open assigned orders and recent events.
create or replace function public.hr_live_dashboard(p_date date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := public._hr_today();
  v_date date := least(coalesce(p_date, v_today), v_today);
  v_team jsonb;
  v_idle int := 5; -- minutes without a heartbeat while checked in = idle
begin
  perform public.require_permission('hr.view');
  select coalesce(jsonb_agg(t order by t ->> 'sort', t ->> 'name'), '[]'::jsonb) into v_team from (
    select jsonb_build_object(
      'profile_id', p.id, 'name', coalesce(nullif(p.full_name, ''), p.email), 'role', r.name, 'is_owner', r.code = 'OWNER',
      'department', d.name, 'department_color', d.color, 'designation', e.designation,
      'shift', (sx.s).name, 'shift_start', (sx.s).start_time, 'shift_end', (sx.s).end_time,
      'check_in_at', a.check_in_at, 'check_out_at', a.check_out_at, 'checkout_source', a.checkout_source,
      'status', a.status, 'late_minutes', coalesce(a.late_minutes, 0),
      'break_minutes', case when a.id is null then 0 else public._hr_break_total(a.id, coalesce(a.check_out_at, now())) end,
      'worked_minutes', case when a.check_in_at is null then null
        when a.check_out_at is not null then a.worked_minutes
        else greatest(0, floor(extract(epoch from now() - a.check_in_at) / 60)::int - public._hr_break_total(a.id)) end,
      'on_break_since', ob.started_at, 'on_break_kind', ob.kind,
      'last_seen_at', up.last_seen_at,
      'open_orders', (select count(*) from public.orders o where o.assigned_to = p.id and o.confirmed_at is null
                       and o.status not in ('CANCELLED', 'REJECTED_FRAUD')),
      'breaks', coalesce((select jsonb_agg(jsonb_build_object('kind', b.kind, 'started_at', b.started_at, 'ended_at', b.ended_at) order by b.started_at)
                          from public.hr_breaks b where b.attendance_id = a.id), '[]'::jsonb),
      'state', st.state,
      'sort', case st.state when 'WORKING' then 1 when 'IDLE' then 2 when 'ON_BREAK' then 3 when 'LEFT' then 4 when 'NOT_IN' then 5 else 6 end
    ) as t
    from public.profiles p
    join public.roles r on r.id = p.role_id
    left join public.hr_employees e on e.profile_id = p.id
    left join public.hr_departments d on d.id = e.department_id
    cross join lateral (select public._hr_shift_of(p.id) as s) sx
    left join public.hr_attendance a on a.profile_id = p.id and a.work_date = v_date
    left join lateral (select b.started_at, b.kind from public.hr_breaks b where b.attendance_id = a.id and b.ended_at is null limit 1) ob on true
    left join public.user_presence up on up.user_id = p.id and up.area = 'admin'
    cross join lateral (select case
        when a.check_in_at is not null and a.check_out_at is not null then 'LEFT'
        when a.check_in_at is not null and ob.started_at is not null then 'ON_BREAK'
        when a.check_in_at is not null and v_date = v_today
             and (up.last_seen_at is null or up.last_seen_at < now() - make_interval(mins => v_idle)) then 'IDLE'
        when a.check_in_at is not null then 'WORKING'
        when a.status in ('LEAVE', 'HOLIDAY') then a.status::text
        when not public._hr_is_work_day(sx.s, v_date) then 'OFF'
        when v_date < v_today or a.status = 'ABSENT' then 'ABSENT'
        else 'NOT_IN' end as state) st
    where p.is_active
  ) x;
  return jsonb_build_object(
    'date', v_date, 'now', now(), 'tz', public.store_timezone(), 'idle_minutes', v_idle,
    'tiles', (select jsonb_build_object(
        'total', count(*),
        'working', count(*) filter (where x ->> 'state' = 'WORKING'),
        'idle', count(*) filter (where x ->> 'state' = 'IDLE'),
        'on_break', count(*) filter (where x ->> 'state' = 'ON_BREAK'),
        'present', count(*) filter (where x ->> 'state' in ('WORKING', 'IDLE', 'ON_BREAK')),
        'left', count(*) filter (where x ->> 'state' = 'LEFT'),
        'not_in', count(*) filter (where x ->> 'state' in ('NOT_IN', 'ABSENT')),
        'off', count(*) filter (where x ->> 'state' in ('OFF', 'LEAVE', 'HOLIDAY')),
        'late', count(*) filter (where (x ->> 'late_minutes')::int > 0),
        'expected', count(*) filter (where x ->> 'state' not in ('OFF', 'LEAVE', 'HOLIDAY')),
        'open_orders', coalesce(sum((x ->> 'open_orders')::int) filter (where x ->> 'state' in ('WORKING', 'IDLE', 'ON_BREAK')), 0))
      from jsonb_array_elements(v_team) x),
    'team', v_team,
    'events', coalesce((select jsonb_agg(ev order by ev ->> 'at' desc) from (
        select jsonb_build_object('name', coalesce(nullif(p.full_name, ''), p.email), 'kind', k.kind, 'at', k.at) as ev
        from public.hr_attendance a
        join public.profiles p on p.id = a.profile_id
        cross join lateral (
          select 'in' as kind, a.check_in_at as at where a.check_in_at is not null
          union all select case when a.checkout_source = 'AUTO' then 'auto_out' else 'out' end, a.check_out_at where a.check_out_at is not null
          union all select case when b.kind = 'IDLE' then 'idle' else 'break' end, b.started_at from public.hr_breaks b where b.attendance_id = a.id
          union all select 'back', b.ended_at from public.hr_breaks b where b.attendance_id = a.id and b.ended_at is not null and b.ended_by = 'SELF'
        ) k
        where a.work_date = v_date
        order by k.at desc limit 30) e), '[]'::jsonb),
    'pending_requests', (select count(*) from public.hr_requests q where q.status = 'PENDING'));
end;
$$;

-- One person's month: every day with its state, times, breaks and net hours.
create or replace function public.hr_employee_month(p_profile uuid, p_month date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_from date := date_trunc('month', p_month)::date;
  v_to date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  v_today date := public._hr_today();
  v_shift public.hr_shifts;
  v_days jsonb;
begin
  if p_profile is distinct from auth.uid() then
    perform public.require_permission('hr.view');
  elsif not public.is_staff() then
    raise exception 'PERMISSION_DENIED: staff only' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_profile) then
    raise exception 'NOT_FOUND: staff member not found' using errcode = 'P0002';
  end if;
  v_shift := public._hr_shift_of(p_profile);
  select coalesce(jsonb_agg(jsonb_build_object(
      'date', g.d, 'work_day', public._hr_is_work_day(v_shift, g.d), 'holiday', h.name,
      'state', case when a.id is not null then a.status::text
                    when g.d > v_today then 'UPCOMING'
                    when h.name is not null then 'HOLIDAY'
                    when not public._hr_is_work_day(v_shift, g.d) then 'OFF'
                    when g.d = v_today then 'NOT_IN'
                    else 'ABSENT' end,
      'check_in_at', a.check_in_at, 'check_out_at', a.check_out_at, 'checkout_source', a.checkout_source,
      'late_minutes', coalesce(a.late_minutes, 0), 'worked_minutes', a.worked_minutes,
      'break_minutes', case when a.id is null then 0 when a.check_out_at is null then public._hr_break_total(a.id) else a.break_minutes end,
      'breaks', (select count(*) from public.hr_breaks b where b.attendance_id = a.id),
      'note', a.note, 'source', a.source) order by g.d), '[]'::jsonb)
  into v_days
  from (select x::date as d from generate_series(v_from, v_to, interval '1 day') x) g
  left join public.hr_attendance a on a.profile_id = p_profile and a.work_date = g.d
  left join public.hr_holidays h on h.holiday_date = g.d and h.is_active;
  return jsonb_build_object(
    'profile_id', p_profile, 'from', v_from, 'to', v_to,
    'name', (select coalesce(nullif(full_name, ''), email) from public.profiles where id = p_profile),
    'shift', case when v_shift.id is null then null else jsonb_build_object('name', v_shift.name, 'start_time', v_shift.start_time, 'end_time', v_shift.end_time) end,
    'days', v_days,
    'summary', (select jsonb_build_object(
        'work_days', count(*) filter (where (x ->> 'work_day')::boolean and x ->> 'state' <> 'UPCOMING'),
        'present', count(*) filter (where x ->> 'state' in ('PRESENT', 'LATE', 'HALF_DAY')),
        'late', count(*) filter (where x ->> 'state' = 'LATE'),
        'half_day', count(*) filter (where x ->> 'state' = 'HALF_DAY'),
        'absent', count(*) filter (where x ->> 'state' = 'ABSENT'),
        'leave', count(*) filter (where x ->> 'state' = 'LEAVE'),
        'late_minutes', coalesce(sum((x ->> 'late_minutes')::int), 0),
        'worked_minutes', coalesce(sum((x ->> 'worked_minutes')::int), 0),
        'break_minutes', coalesce(sum((x ->> 'break_minutes')::int), 0))
      from jsonb_array_elements(v_days) x));
end;
$$;

-- ---------------------------------------------------------------------------
-- Requests: leave, correction, late excuse
-- ---------------------------------------------------------------------------
create or replace function public.hr_request_submit(p jsonb)
returns public.hr_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.hr_requests;
  v_kind text := p ->> 'kind';
  v_from date := nullif(p ->> 'from_date', '')::date;
  v_to date := coalesce(nullif(p ->> 'to_date', '')::date, nullif(p ->> 'from_date', '')::date);
begin
  if not public.is_staff() then
    raise exception 'PERMISSION_DENIED: staff only' using errcode = '42501';
  end if;
  if v_kind not in ('LEAVE', 'CORRECTION', 'LATE_EXCUSE') then
    raise exception 'VALIDATION: choose a request type' using errcode = '22023';
  end if;
  if v_from is null or v_to < v_from or v_to - v_from > 30 then
    raise exception 'VALIDATION: choose dates (at most 31 days)' using errcode = '22023';
  end if;
  if v_kind <> 'LEAVE' and (v_to <> v_from or v_from > public._hr_today()) then
    raise exception 'VALIDATION: corrections and late excuses are for one past day' using errcode = '22023';
  end if;
  if v_kind = 'CORRECTION' and nullif(p ->> 'check_in', '') is null then
    raise exception 'VALIDATION: add the check-in time' using errcode = '22023';
  end if;
  if length(trim(coalesce(p ->> 'reason', ''))) < 3 then
    raise exception 'VALIDATION: write a short reason' using errcode = '22023';
  end if;
  if exists (select 1 from public.hr_requests q where q.profile_id = auth.uid() and q.status = 'PENDING' and q.kind = v_kind
             and daterange(q.from_date, q.to_date, '[]') && daterange(v_from, v_to, '[]')) then
    raise exception 'VALIDATION: you already have a pending request for these days' using errcode = '22023';
  end if;
  insert into public.hr_requests(profile_id, kind, from_date, to_date, check_in, check_out, reason)
  values (auth.uid(), v_kind, v_from, v_to,
    case when v_kind = 'CORRECTION' then nullif(p ->> 'check_in', '')::time end,
    case when v_kind = 'CORRECTION' then nullif(p ->> 'check_out', '')::time end,
    left(trim(p ->> 'reason'), 500))
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.hr_request_cancel(p_id uuid)
returns public.hr_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.hr_requests;
begin
  update public.hr_requests set status = 'CANCELLED'
  where id = p_id and profile_id = auth.uid() and status = 'PENDING'
  returning * into v_row;
  if v_row.id is null then
    raise exception 'NOT_FOUND: no pending request of yours with this id' using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;

-- Approve (and apply) or reject. Approving leave marks every work day in the range;
-- a correction sets the times of that day; a late excuse clears the late minutes.
create or replace function public.hr_request_decide(p_id uuid, p_approve boolean, p_note text default null)
returns public.hr_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.hr_requests;
  v_shift public.hr_shifts;
  v_d date;
  v_tz text := public.store_timezone();
  v_in timestamptz;
  v_out timestamptz;
begin
  perform public.require_permission('hr.manage');
  select * into v_row from public.hr_requests where id = p_id for update;
  if v_row.id is null then
    raise exception 'NOT_FOUND: request not found' using errcode = 'P0002';
  end if;
  if v_row.status <> 'PENDING' then
    raise exception 'VALIDATION: this request was already %', lower(v_row.status) using errcode = '22023';
  end if;
  if v_row.profile_id = auth.uid() and not public.has_permission('settings.manage') then
    raise exception 'PERMISSION_DENIED: someone else must decide your own request' using errcode = '42501';
  end if;
  if p_approve then
    v_shift := public._hr_shift_of(v_row.profile_id);
    if v_row.kind = 'LEAVE' then
      for v_d in select g::date from generate_series(v_row.from_date, v_row.to_date, interval '1 day') g loop
        continue when not public._hr_is_work_day(v_shift, v_d);
        -- A day already worked stays as worked.
        insert into public.hr_attendance(profile_id, work_date, status, late_minutes, note, source, updated_by)
        values (v_row.profile_id, v_d, 'LEAVE', 0, left('Leave: ' || v_row.reason, 300), 'ADMIN', auth.uid())
        on conflict (profile_id, work_date) do update set status = 'LEAVE', late_minutes = 0, note = excluded.note, source = 'ADMIN', updated_by = auth.uid()
        where public.hr_attendance.check_in_at is null;
      end loop;
    elsif v_row.kind = 'CORRECTION' then
      v_in := (v_row.from_date + v_row.check_in) at time zone v_tz;
      v_out := case when v_row.check_out is null then null
                    else ((v_row.from_date + case when v_row.check_out < v_row.check_in then 1 else 0 end) + v_row.check_out) at time zone v_tz end;
      perform public.hr_attendance_set(v_row.profile_id, v_row.from_date, 'PRESENT', v_in, v_out, left('Correction: ' || v_row.reason, 300));
    else
      update public.hr_attendance set late_minutes = 0,
        status = case when status = 'LATE' then 'PRESENT'::public.hr_attendance_status else status end,
        note = left(coalesce(note || ' · ', '') || 'Late excused: ' || v_row.reason, 300), updated_by = auth.uid()
      where profile_id = v_row.profile_id and work_date = v_row.from_date;
      if not found then
        raise exception 'VALIDATION: there is no attendance on % to excuse', v_row.from_date using errcode = '22023';
      end if;
    end if;
  end if;
  update public.hr_requests set status = case when p_approve then 'APPROVED' else 'REJECTED' end,
    decided_by = auth.uid(), decided_at = now(), decision_note = nullif(left(trim(coalesce(p_note, '')), 300), '')
  where id = p_id returning * into v_row;
  perform public.log_audit('hr.request_' || lower(v_row.status), 'hr_request', v_row.id::text, null,
    jsonb_build_object('profile_id', v_row.profile_id, 'kind', v_row.kind, 'from', v_row.from_date, 'to', v_row.to_date));
  return v_row;
end;
$$;

-- Requests the caller may see: their own, or everyone's with hr.view.
create or replace function public.hr_requests_list(p_status text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_all boolean := public.has_permission('hr.view');
begin
  if not public.is_staff() then
    raise exception 'PERMISSION_DENIED: staff only' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', q.id, 'profile_id', q.profile_id, 'name', coalesce(nullif(p.full_name, ''), p.email), 'kind', q.kind,
      'from_date', q.from_date, 'to_date', q.to_date, 'check_in', q.check_in, 'check_out', q.check_out, 'reason', q.reason,
      'status', q.status, 'decided_by', coalesce(nullif(dp.full_name, ''), dp.email), 'decided_at', q.decided_at,
      'decision_note', q.decision_note, 'created_at', q.created_at, 'mine', q.profile_id = auth.uid())
      order by (q.status = 'PENDING') desc, q.created_at desc)
    from (select * from public.hr_requests r
          where (v_all or r.profile_id = auth.uid()) and (p_status is null or r.status = p_status)
          order by (r.status = 'PENDING') desc, r.created_at desc limit 200) q
    join public.profiles p on p.id = q.profile_id
    left join public.profiles dp on dp.id = q.decided_by), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- SOP checklists
-- ---------------------------------------------------------------------------
-- The steps of an SOP: its non-empty lines.
create or replace function public._hr_sop_items(p_body text)
returns int
language sql
immutable
as $$ select count(*)::int from regexp_split_to_table(coalesce(p_body, ''), E'\n') l where btrim(l) <> '' $$;

create or replace function public.hr_sop_save(p jsonb)
returns public.hr_sops
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.hr_sops;
  v_id uuid := nullif(p ->> 'id', '')::uuid;
begin
  perform public.require_permission('hr.manage');
  if p ? 'kind' and p ->> 'kind' not in ('GUIDE', 'CHECKLIST') then
    raise exception 'VALIDATION: unknown SOP type' using errcode = '22023';
  end if;
  if v_id is null then
    insert into public.hr_sops(department_id, title, body, kind, is_active, updated_by)
    values (nullif(p ->> 'department_id', '')::uuid, trim(p ->> 'title'), coalesce(p ->> 'body', ''), coalesce(p ->> 'kind', 'GUIDE'),
      coalesce((p ->> 'is_active')::boolean, true), auth.uid())
    returning * into v_row;
  else
    update public.hr_sops set
      department_id = case when p ? 'department_id' then nullif(p ->> 'department_id', '')::uuid else department_id end,
      title = coalesce(trim(p ->> 'title'), title),
      body = coalesce(p ->> 'body', body),
      kind = coalesce(p ->> 'kind', kind),
      version = version + case when coalesce(p ->> 'body', body) is distinct from body or coalesce(trim(p ->> 'title'), title) is distinct from title then 1 else 0 end,
      is_active = coalesce((p ->> 'is_active')::boolean, is_active),
      updated_by = auth.uid()
    where id = v_id returning * into v_row;
    if v_row.id is null then raise exception 'NOT_FOUND: SOP not found' using errcode = 'P0002'; end if;
  end if;
  return v_row;
end;
$$;

-- Today's checklists for the caller: their department's and the general ones.
create or replace function public.hr_my_checklists()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := public._hr_today();
  v_dept uuid;
begin
  if not public.is_staff() then
    raise exception 'PERMISSION_DENIED: staff only' using errcode = '42501';
  end if;
  select department_id into v_dept from public.hr_employees where profile_id = auth.uid();
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', s.id, 'title', s.title, 'body', s.body, 'version', s.version, 'department_id', s.department_id,
      'items_total', public._hr_sop_items(s.body),
      'done', case when c.sop_version = s.version then to_jsonb(c.done) else '[]'::jsonb end) order by s.title)
    from public.hr_sops s
    left join public.hr_sop_checks c on c.sop_id = s.id and c.profile_id = auth.uid() and c.work_date = v_today
    where s.is_active and s.kind = 'CHECKLIST' and (s.department_id is null or s.department_id = v_dept)), '[]'::jsonb);
end;
$$;

-- Tick or untick step p_item (0-based) of a checklist for today.
create or replace function public.hr_checklist_tick(p_sop uuid, p_item int, p_done boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sop public.hr_sops;
  v_today date := public._hr_today();
  v_total int;
  v_dept uuid;
  v_done int[];
begin
  if not public.is_staff() then
    raise exception 'PERMISSION_DENIED: staff only' using errcode = '42501';
  end if;
  select * into v_sop from public.hr_sops where id = p_sop and is_active and kind = 'CHECKLIST';
  if v_sop.id is null then
    raise exception 'NOT_FOUND: checklist not found' using errcode = 'P0002';
  end if;
  select department_id into v_dept from public.hr_employees where profile_id = auth.uid();
  if v_sop.department_id is not null and v_sop.department_id is distinct from v_dept then
    raise exception 'PERMISSION_DENIED: this checklist belongs to another department' using errcode = '42501';
  end if;
  v_total := public._hr_sop_items(v_sop.body);
  if p_item is null or p_item < 0 or p_item >= v_total then
    raise exception 'VALIDATION: no such step' using errcode = '22023';
  end if;
  insert into public.hr_sop_checks(sop_id, profile_id, work_date, done, items_total, sop_version)
  values (p_sop, auth.uid(), v_today, '{}', v_total, v_sop.version)
  on conflict (sop_id, profile_id, work_date) do update
    set done = case when public.hr_sop_checks.sop_version = excluded.sop_version then public.hr_sop_checks.done else '{}' end,
        items_total = excluded.items_total, sop_version = excluded.sop_version;
  update public.hr_sop_checks set
    done = (select coalesce(array_agg(distinct x order by x), '{}') from unnest(
              case when p_done then array_append(done, p_item) else array_remove(done, p_item) end) x),
    updated_at = now()
  where sop_id = p_sop and profile_id = auth.uid() and work_date = v_today
  returning done into v_done;
  return jsonb_build_object('sop_id', p_sop, 'done', to_jsonb(v_done), 'items_total', v_total, 'complete', cardinality(v_done) = v_total);
end;
$$;

-- Checklist completion per checklist and per person on a day.
create or replace function public.hr_checklist_compliance(p_date date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_date date := coalesce(p_date, public._hr_today());
begin
  perform public.require_permission('hr.view');
  return coalesce((select jsonb_agg(jsonb_build_object(
      'sop_id', s.id, 'title', s.title, 'department_id', s.department_id, 'department', d.name, 'items_total', public._hr_sop_items(s.body),
      'people', coalesce((select jsonb_agg(jsonb_build_object('profile_id', p.id, 'name', coalesce(nullif(p.full_name, ''), p.email),
            'done', coalesce(cardinality(c.done), 0) * (case when c.sop_version = s.version then 1 else 0 end))
          order by coalesce(nullif(p.full_name, ''), p.email))
        from public.profiles p
        left join public.hr_employees e on e.profile_id = p.id
        left join public.hr_sop_checks c on c.sop_id = s.id and c.profile_id = p.id and c.work_date = v_date
        where p.is_active and (s.department_id is null or e.department_id = s.department_id)), '[]'::jsonb))
      order by d.name nulls first, s.title)
    from public.hr_sops s
    left join public.hr_departments d on d.id = s.department_id
    where s.is_active and s.kind = 'CHECKLIST'), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Departments: members and overrides
-- ---------------------------------------------------------------------------
-- Exactly these people in the department (others leave it).
create or replace function public.hr_department_members_set(p_department uuid, p_profiles uuid[])
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int;
begin
  perform public.require_permission('hr.manage');
  if not exists (select 1 from public.hr_departments where id = p_department) then
    raise exception 'NOT_FOUND: department not found' using errcode = 'P0002';
  end if;
  if exists (select 1 from unnest(coalesce(p_profiles, '{}')) x where not exists (select 1 from public.profiles p where p.id = x)) then
    raise exception 'NOT_FOUND: staff member not found' using errcode = 'P0002';
  end if;
  insert into public.hr_employees(profile_id) select x from unnest(coalesce(p_profiles, '{}')) x on conflict (profile_id) do nothing;
  update public.hr_employees set department_id = null where department_id = p_department and not (profile_id = any (coalesce(p_profiles, '{}')));
  update public.hr_employees set department_id = p_department where profile_id = any (coalesce(p_profiles, '{}'));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.hr_employee_save(p_profile uuid, p jsonb)
returns public.hr_employees
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.hr_employees;
begin
  perform public.require_permission('hr.manage');
  if not exists (select 1 from public.profiles where id = p_profile) then
    raise exception 'NOT_FOUND: staff member not found' using errcode = 'P0002';
  end if;
  if p ? 'max_break_minutes' and nullif(p ->> 'max_break_minutes', '') is not null
     and (p ->> 'max_break_minutes')::int not between 0 and 480 then
    raise exception 'VALIDATION: break limit must be 0–480 minutes' using errcode = '22023';
  end if;
  insert into public.hr_employees(profile_id) values (p_profile) on conflict (profile_id) do nothing;
  update public.hr_employees set
    department_id = case when p ? 'department_id' then nullif(p ->> 'department_id', '')::uuid else department_id end,
    shift_id = case when p ? 'shift_id' then nullif(p ->> 'shift_id', '')::uuid else shift_id end,
    designation = case when p ? 'designation' then nullif(trim(coalesce(p ->> 'designation', '')), '') else designation end,
    employee_code = case when p ? 'employee_code' then nullif(trim(coalesce(p ->> 'employee_code', '')), '') else employee_code end,
    joined_on = case when p ? 'joined_on' then nullif(p ->> 'joined_on', '')::date else joined_on end,
    emergency_contact = case when p ? 'emergency_contact' then nullif(trim(coalesce(p ->> 'emergency_contact', '')), '') else emergency_contact end,
    attendance_exempt = case when p ? 'attendance_exempt' then coalesce((p ->> 'attendance_exempt')::boolean, false) else attendance_exempt end,
    max_break_minutes = case when p ? 'max_break_minutes' then nullif(p ->> 'max_break_minutes', '')::int else max_break_minutes end,
    auto_break = case when p ? 'auto_break' then nullif(p ->> 'auto_break', '')::boolean else auto_break end,
    auto_checkout = case when p ? 'auto_checkout' then nullif(p ->> 'auto_checkout', '')::boolean else auto_checkout end
  where profile_id = p_profile returning * into v_row;
  if p ?| array['attendance_exempt', 'max_break_minutes', 'auto_break', 'auto_checkout'] then
    perform public.log_audit('hr.employee_override', 'hr_employee', p_profile::text, null,
      jsonb_build_object('attendance_exempt', v_row.attendance_exempt, 'max_break_minutes', v_row.max_break_minutes,
        'auto_break', v_row.auto_break, 'auto_checkout', v_row.auto_checkout));
  end if;
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
create or replace function public.hr_settings_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb := coalesce(public.get_setting('hr'), '{}'::jsonb);
  k text;
  n int;
  c jsonb;
begin
  perform public.require_permission('hr.manage');
  if p ? 'work_days' then
    if jsonb_typeof(p -> 'work_days') <> 'array' or jsonb_array_length(p -> 'work_days') = 0
       or exists (select 1 from jsonb_array_elements_text(p -> 'work_days') x where x !~ '^[0-6]$') then
      raise exception 'VALIDATION: choose at least one work day' using errcode = '22023';
    end if;
    v := v || jsonb_build_object('work_days', p -> 'work_days');
  end if;
  if p ? 'half_day_minutes' then
    v := v || jsonb_build_object('half_day_minutes', least(greatest((p ->> 'half_day_minutes')::int, 30), 720));
  end if;
  foreach k in array array['allow_self_check_in', 'require_check_in', 'block_during_breaks', 'auto_checkout', 'auto_break'] loop
    if p ? k then
      v := v || jsonb_build_object(k, coalesce((p ->> k)::boolean, false));
    end if;
  end loop;
  foreach k in array array['default_start', 'default_end'] loop
    if p ? k then
      if nullif(p ->> k, '') is not null and (p ->> k) !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:00)?$' then
        raise exception 'VALIDATION: % must be a time like 09:00', replace(k, '_', ' ') using errcode = '22023';
      end if;
      v := v || jsonb_build_object(k, nullif(left(p ->> k, 5), ''));
    end if;
  end loop;
  if (v ->> 'default_start') is null <> ((v ->> 'default_end') is null) then
    raise exception 'VALIDATION: set both the check-in and check-out time' using errcode = '22023';
  end if;
  if p ? 'late_grace_minutes' then
    n := (p ->> 'late_grace_minutes')::int;
    if n not between 0 and 120 then raise exception 'VALIDATION: grace period must be 0–120 minutes' using errcode = '22023'; end if;
    v := v || jsonb_build_object('late_grace_minutes', n);
  end if;
  if p ? 'max_break_minutes' then
    n := (p ->> 'max_break_minutes')::int;
    if n not between 0 and 480 then raise exception 'VALIDATION: maximum break must be 0–480 minutes' using errcode = '22023'; end if;
    v := v || jsonb_build_object('max_break_minutes', n);
  end if;
  if p ? 'auto_break_after' then
    n := (p ->> 'auto_break_after')::int;
    if n not between 1 and 60 then raise exception 'VALIDATION: auto break must start after 1–60 minutes' using errcode = '22023'; end if;
    v := v || jsonb_build_object('auto_break_after', n);
  end if;
  if p ? 'idle_warning_at' then
    n := (p ->> 'idle_warning_at')::int;
    if n < 1 then raise exception 'VALIDATION: the warning needs at least 1 minute' using errcode = '22023'; end if;
    v := v || jsonb_build_object('idle_warning_at', n);
  end if;
  c := jsonb_build_object('auto_break_after', 10, 'idle_warning_at', 8) || v;
  if (c ->> 'idle_warning_at')::int >= (c ->> 'auto_break_after')::int then
    raise exception 'VALIDATION: the warning must come before the automatic break' using errcode = '22023';
  end if;
  update public.settings set value = v where key = 'hr';
  if not found then
    insert into public.settings(key, is_public, description, value) values ('hr', false, 'HRM settings', v);
  end if;
  perform public.log_audit('hr.settings', 'settings', 'hr', null, v);
  return public._hr_cfg();
end;
$$;

-- The store's HR settings with defaults, for HR (the settings table itself needs settings.view).
create or replace function public.hr_settings_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('hr.view');
  return public._hr_cfg();
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function public._hr_cfg(), public._hr_rules(uuid), public._hr_open_session(uuid), public._hr_break_total(uuid, timestamptz),
  public._hr_gate(text), public._has_permission_raw(text), public._hr_sop_items(text), public.hr_auto_checkout() from public, anon, authenticated;
revoke all on function public._hr_shift_of(uuid) from public, anon, authenticated;
revoke all on function public.hr_break_start(text), public.hr_break_end(), public.hr_keep_working_today(), public.hr_live_dashboard(date),
  public.hr_employee_month(uuid, date), public.hr_request_submit(jsonb), public.hr_request_cancel(uuid), public.hr_request_decide(uuid, boolean, text),
  public.hr_requests_list(text), public.hr_my_checklists(), public.hr_checklist_tick(uuid, int, boolean), public.hr_checklist_compliance(date),
  public.hr_department_members_set(uuid, uuid[]), public.hr_settings_get() from public, anon;
grant execute on function public.hr_break_start(text), public.hr_break_end(), public.hr_keep_working_today(), public.hr_live_dashboard(date),
  public.hr_employee_month(uuid, date), public.hr_request_submit(jsonb), public.hr_request_cancel(uuid), public.hr_request_decide(uuid, boolean, text),
  public.hr_requests_list(text), public.hr_my_checklists(), public.hr_checklist_tick(uuid, int, boolean), public.hr_checklist_compliance(date),
  public.hr_department_members_set(uuid, uuid[]), public.hr_settings_get() to authenticated;

select public._tenancy_own_functions();
