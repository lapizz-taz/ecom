-- =============================================================================
-- HRM: departments & SOPs, shifts, staff HR details, attendance, holidays.
--
--   * Staff check in / out themselves (server time, store time zone); late
--     minutes are measured against their shift start + grace.
--   * HR (hr.manage) can correct any day; every change keeps who and when.
--   * Reports count expected work days (shift work days, minus holidays) so
--     a day with no check-in is an absence, not a gap.
-- Reads go through RLS-protected selects or the functions below; all writes
-- go through security-definer functions with permission checks.
-- =============================================================================

insert into public.permissions(code, module, name) values
  ('hr.view', 'hr', 'See the HR dashboard, attendance of all staff and reports'),
  ('hr.manage', 'hr', 'Manage shifts, departments & SOPs, staff HR details and correct attendance')
on conflict (code) do nothing;

insert into public.role_permissions(role_id, permission_id)
select r.id, p.id
from (values ('ADMIN', 'hr.view'), ('ADMIN', 'hr.manage'), ('MANAGER', 'hr.view')) g(role_code, perm)
join public.roles r on r.code = g.role_code
join public.permissions p on p.code = g.perm
on conflict do nothing;

do $$ begin
  create type public.hr_attendance_status as enum ('PRESENT', 'LATE', 'HALF_DAY', 'ABSENT', 'LEAVE', 'HOLIDAY');
exception when duplicate_object then null; end $$;

create table if not exists public.hr_departments (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(trim(name)) between 2 and 80),
  description text,
  color text not null default '#64748b' check (color ~ '^#[0-9a-fA-F]{6}$'),
  head_id uuid references public.profiles(id),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.hr_sops (
  id uuid primary key default gen_random_uuid(),
  department_id uuid references public.hr_departments(id),
  title text not null check (length(trim(title)) between 2 and 160),
  body text not null default '',
  version int not null default 1,
  is_active boolean not null default true,
  updated_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists hr_sops_department_idx on public.hr_sops(department_id);

create table if not exists public.hr_shifts (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(trim(name)) between 2 and 60),
  start_time time not null,
  end_time time not null,
  grace_minutes int not null default 10 check (grace_minutes between 0 and 240),
  work_days int[] not null default '{0,1,2,3,4,6}' check (work_days <@ '{0,1,2,3,4,5,6}'),
  color text not null default '#0ea5e9' check (color ~ '^#[0-9a-fA-F]{6}$'),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.hr_employees (
  profile_id uuid primary key references public.profiles(id),
  department_id uuid references public.hr_departments(id),
  shift_id uuid references public.hr_shifts(id),
  designation text,
  employee_code text unique,
  joined_on date,
  emergency_contact text,
  updated_at timestamptz not null default now()
);

create table if not exists public.hr_attendance (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id),
  work_date date not null,
  check_in_at timestamptz,
  check_out_at timestamptz,
  status public.hr_attendance_status not null,
  late_minutes int not null default 0,
  worked_minutes int,
  note text,
  source text not null default 'SELF' check (source in ('SELF', 'ADMIN')),
  updated_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, work_date),
  check (check_out_at is null or check_in_at is null or check_out_at >= check_in_at)
);
create index if not exists hr_attendance_date_idx on public.hr_attendance(work_date);

create table if not exists public.hr_holidays (
  holiday_date date primary key,
  name text not null check (length(trim(name)) between 2 and 80),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['hr_departments', 'hr_sops', 'hr_shifts', 'hr_employees', 'hr_attendance'] loop
    execute format('create or replace trigger %I_updated_at before update on public.%I for each row execute function public.set_updated_at()', t, t);
  end loop;
end $$;

alter table public.hr_departments enable row level security;
alter table public.hr_sops enable row level security;
alter table public.hr_shifts enable row level security;
alter table public.hr_employees enable row level security;
alter table public.hr_attendance enable row level security;
alter table public.hr_holidays enable row level security;

create policy hr_departments_read on public.hr_departments for select to authenticated using (public.is_staff());
create policy hr_sops_read on public.hr_sops for select to authenticated using (public.is_staff());
create policy hr_shifts_read on public.hr_shifts for select to authenticated using (public.is_staff());
create policy hr_holidays_read on public.hr_holidays for select to authenticated using (public.is_staff());
create policy hr_employees_read on public.hr_employees for select to authenticated
  using (profile_id = auth.uid() or public.has_permission('hr.view'));
create policy hr_attendance_read on public.hr_attendance for select to authenticated
  using (profile_id = auth.uid() or public.has_permission('hr.view'));

revoke all on public.hr_departments, public.hr_sops, public.hr_shifts, public.hr_employees, public.hr_attendance, public.hr_holidays from anon, authenticated;
grant select on public.hr_departments, public.hr_sops, public.hr_shifts, public.hr_employees, public.hr_attendance, public.hr_holidays to authenticated;

insert into public.settings(key, is_public, description, value)
values ('hr', false, 'HRM: work days without a shift, half-day threshold, self check-in',
  jsonb_build_object('work_days', jsonb_build_array(0, 1, 2, 3, 4, 6), 'half_day_minutes', 240, 'allow_self_check_in', true))
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public._hr_today()
returns date
language sql
stable
security definer
set search_path = public, pg_temp
as $$ select (now() at time zone public.store_timezone())::date $$;

-- Is this a work day for this person (their shift's days, else the HR default), not a holiday?
create or replace function public._hr_is_work_day(p_shift public.hr_shifts, p_date date)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select not exists (select 1 from public.hr_holidays h where h.holiday_date = p_date and h.is_active)
    and extract(dow from p_date)::int = any(coalesce(p_shift.work_days,
      (select array_agg(x::int) from jsonb_array_elements_text(coalesce(public.get_setting('hr') -> 'work_days', '[0,1,2,3,4,6]'::jsonb)) x)))
$$;

-- Shift start / end as timestamps on a date (an end before the start means the next day).
create or replace function public._hr_shift_bounds(p_shift public.hr_shifts, p_date date)
returns table(starts_at timestamptz, ends_at timestamptz)
language sql
stable
set search_path = public, pg_temp
as $$
  select (p_date + p_shift.start_time) at time zone public.store_timezone(),
         ((p_date + case when p_shift.end_time <= p_shift.start_time then 1 else 0 end) + p_shift.end_time) at time zone public.store_timezone()
$$;

-- Status and minutes from the times on a day.
create or replace function public._hr_score(p_shift public.hr_shifts, p_date date, p_in timestamptz, p_out timestamptz)
returns table(status public.hr_attendance_status, late_minutes int, worked_minutes int)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_start timestamptz;
  v_late int := 0;
  v_worked int;
  v_half int := coalesce((public.get_setting('hr') ->> 'half_day_minutes')::int, 240);
begin
  if p_in is not null and p_shift.id is not null then
    select b.starts_at into v_start from public._hr_shift_bounds(p_shift, p_date) b;
    if p_in > v_start + make_interval(mins => p_shift.grace_minutes) then
      v_late := floor(extract(epoch from p_in - v_start) / 60)::int;
    end if;
  end if;
  if p_in is not null and p_out is not null then
    v_worked := floor(extract(epoch from p_out - p_in) / 60)::int;
  end if;
  return query select
    (case when p_in is null then 'ABSENT'
          when v_worked is not null and v_worked < v_half then 'HALF_DAY'
          when v_late > 0 then 'LATE'
          else 'PRESENT' end)::public.hr_attendance_status,
    v_late, v_worked;
end;
$$;

create or replace function public._hr_shift_of(p_profile uuid)
returns public.hr_shifts
language sql
stable
set search_path = public, pg_temp
as $$
  select s.* from public.hr_employees e join public.hr_shifts s on s.id = e.shift_id where e.profile_id = p_profile
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
begin
  if not public.is_staff() then
    raise exception 'PERMISSION_DENIED: staff only' using errcode = '42501';
  end if;
  select * into v_row from public.hr_attendance where profile_id = auth.uid() and work_date = v_today;
  return jsonb_build_object(
    'date', v_today,
    'tz', public.store_timezone(),
    'record', case when v_row.id is null then null else to_jsonb(v_row) end,
    'shift', case when v_shift.id is null then null else jsonb_build_object('id', v_shift.id, 'name', v_shift.name,
      'start_time', v_shift.start_time, 'end_time', v_shift.end_time, 'grace_minutes', v_shift.grace_minutes) end,
    'work_day', public._hr_is_work_day(v_shift, v_today),
    'self_check_in', coalesce((public.get_setting('hr') ->> 'allow_self_check_in')::boolean, true));
end;
$$;

create or replace function public.hr_check_in(p_note text default null)
returns public.hr_attendance
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_shift public.hr_shifts := public._hr_shift_of(auth.uid());
  v_today date := public._hr_today();
  v_row public.hr_attendance;
  v_score record;
begin
  if not public.is_staff() then
    raise exception 'PERMISSION_DENIED: staff only' using errcode = '42501';
  end if;
  if not coalesce((public.get_setting('hr') ->> 'allow_self_check_in')::boolean, true) then
    raise exception 'VALIDATION: check-in is done by HR in this store' using errcode = '22023';
  end if;
  select * into v_row from public.hr_attendance where profile_id = auth.uid() and work_date = v_today for update;
  if v_row.check_in_at is not null then
    raise exception 'VALIDATION: you already checked in at %', to_char(v_row.check_in_at at time zone public.store_timezone(), 'HH12:MI AM')
      using errcode = '22023';
  end if;
  select * into v_score from public._hr_score(v_shift, v_today, now(), null);
  insert into public.hr_attendance(profile_id, work_date, check_in_at, status, late_minutes, note, source, updated_by)
  values (auth.uid(), v_today, now(), v_score.status, v_score.late_minutes, nullif(trim(coalesce(p_note, '')), ''), 'SELF', auth.uid())
  on conflict (profile_id, work_date) do update
    set check_in_at = excluded.check_in_at, status = excluded.status, late_minutes = excluded.late_minutes,
        note = coalesce(excluded.note, public.hr_attendance.note), source = 'SELF', updated_by = auth.uid()
  returning * into v_row;
  return v_row;
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
begin
  if not public.is_staff() then
    raise exception 'PERMISSION_DENIED: staff only' using errcode = '42501';
  end if;
  -- Today, or an overnight shift that started yesterday and is still open.
  select * into v_row from public.hr_attendance
  where profile_id = auth.uid() and check_in_at is not null and check_out_at is null
    and work_date >= public._hr_today() - 1
  order by work_date desc limit 1 for update;
  if v_row.id is null then
    raise exception 'VALIDATION: check in first' using errcode = '22023';
  end if;
  select * into v_score from public._hr_score(v_shift, v_row.work_date, v_row.check_in_at, now());
  update public.hr_attendance set check_out_at = now(), status = v_score.status, late_minutes = v_score.late_minutes,
    worked_minutes = v_score.worked_minutes, note = coalesce(nullif(trim(coalesce(p_note, '')), ''), note), updated_by = auth.uid()
  where id = v_row.id returning * into v_row;
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- HR: board, corrections, report, dashboard
-- ---------------------------------------------------------------------------
create or replace function public.hr_attendance_board(p_date date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_date date := coalesce(p_date, public._hr_today());
  v_today date := public._hr_today();
begin
  perform public.require_permission('hr.view');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'profile_id', p.id, 'name', coalesce(nullif(p.full_name, ''), p.email), 'email', p.email, 'role', r.name,
      'department', d.name, 'department_color', d.color, 'designation', e.designation,
      'shift', s.name, 'shift_start', s.start_time, 'shift_end', s.end_time,
      'work_day', public._hr_is_work_day(s, v_date),
      'record', case when a.id is null then null else to_jsonb(a) end,
      'state', case when a.id is not null then a.status::text
                    when not public._hr_is_work_day(s, v_date) then 'OFF'
                    when v_date < v_today then 'ABSENT'
                    when s.id is not null and now() > (select b.ends_at from public._hr_shift_bounds(s, v_date) b) then 'ABSENT'
                    else 'NOT_IN' end)
      order by d.name nulls last, coalesce(nullif(p.full_name, ''), p.email))
    from public.profiles p
    join public.roles r on r.id = p.role_id
    left join public.hr_employees e on e.profile_id = p.id
    left join public.hr_departments d on d.id = e.department_id
    left join public.hr_shifts s on s.id = e.shift_id
    left join public.hr_attendance a on a.profile_id = p.id and a.work_date = v_date
    where p.is_active), '[]'::jsonb);
end;
$$;

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
  select * into v_score from public._hr_score(v_shift, p_date, p_check_in, p_check_out);
  -- Times decide present / late / half day; ABSENT, LEAVE and HOLIDAY are taken as chosen.
  if p_status in ('PRESENT', 'LATE', 'HALF_DAY') then
    v_status := v_score.status;
  end if;
  insert into public.hr_attendance(profile_id, work_date, check_in_at, check_out_at, status, late_minutes, worked_minutes, note, source, updated_by)
  values (p_profile, p_date, case when v_status in ('ABSENT', 'LEAVE', 'HOLIDAY') then null else p_check_in end,
    case when v_status in ('ABSENT', 'LEAVE', 'HOLIDAY') then null else p_check_out end, v_status,
    case when v_status in ('ABSENT', 'LEAVE', 'HOLIDAY') then 0 else v_score.late_minutes end,
    case when v_status in ('ABSENT', 'LEAVE', 'HOLIDAY') then null else v_score.worked_minutes end,
    nullif(trim(coalesce(p_note, '')), ''), 'ADMIN', auth.uid())
  on conflict (profile_id, work_date) do update set
    check_in_at = excluded.check_in_at, check_out_at = excluded.check_out_at, status = excluded.status,
    late_minutes = excluded.late_minutes, worked_minutes = excluded.worked_minutes, note = excluded.note,
    source = 'ADMIN', updated_by = auth.uid()
  returning * into v_row;
  perform public.log_audit('hr.attendance_set', 'hr_attendance', v_row.id::text, null,
    jsonb_build_object('profile_id', p_profile, 'date', p_date, 'status', v_status, 'check_in', p_check_in, 'check_out', p_check_out));
  return v_row;
end;
$$;

create or replace function public.hr_attendance_report(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_to date := least(p_to, public._hr_today());
begin
  perform public.require_permission('hr.view');
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'VALIDATION: choose a valid date range' using errcode = '22023';
  end if;
  if p_to - p_from > 366 then
    raise exception 'VALIDATION: choose at most one year' using errcode = '22023';
  end if;
  return jsonb_build_object('from', p_from, 'to', p_to, 'staff', coalesce((
    select jsonb_agg(x order by x ->> 'name') from (
      select jsonb_build_object(
        'profile_id', p.id, 'name', coalesce(nullif(p.full_name, ''), p.email), 'department', d.name, 'shift', s.name,
        'work_days', count(*) filter (where days.work_day),
        'present', count(*) filter (where a.status = 'PRESENT'),
        'late', count(*) filter (where a.status = 'LATE'),
        'half_day', count(*) filter (where a.status = 'HALF_DAY'),
        'leave', count(*) filter (where a.status = 'LEAVE'),
        'holiday', count(*) filter (where a.status = 'HOLIDAY'),
        'absent', count(*) filter (where a.status = 'ABSENT' or (a.id is null and days.work_day and days.d < public._hr_today())),
        'late_minutes', coalesce(sum(a.late_minutes), 0),
        'worked_minutes', coalesce(sum(a.worked_minutes), 0),
        'rate', case when count(*) filter (where days.work_day and days.d < public._hr_today() or a.id is not null) > 0
          then round(100.0 * count(*) filter (where a.status in ('PRESENT', 'LATE', 'HALF_DAY'))
            / nullif(count(*) filter (where days.work_day and (days.d < public._hr_today() or a.id is not null)), 0), 1) end
      ) as x
      from public.profiles p
      left join public.hr_employees e on e.profile_id = p.id
      left join public.hr_departments d on d.id = e.department_id
      left join public.hr_shifts s on s.id = e.shift_id
      cross join lateral (select g::date as d, public._hr_is_work_day(s, g::date) as work_day
                          from generate_series(p_from, v_to, interval '1 day') g) days
      left join public.hr_attendance a on a.profile_id = p.id and a.work_date = days.d
      where p.is_active
      group by p.id, p.full_name, p.email, d.name, s.name
    ) t), '[]'::jsonb),
    'days', coalesce((select jsonb_agg(jsonb_build_object('profile_id', a.profile_id, 'date', a.work_date, 'status', a.status,
        'check_in_at', a.check_in_at, 'check_out_at', a.check_out_at, 'late_minutes', a.late_minutes, 'worked_minutes', a.worked_minutes,
        'note', a.note, 'source', a.source) order by a.work_date)
      from public.hr_attendance a where a.work_date between p_from and v_to), '[]'::jsonb));
end;
$$;

create or replace function public.hr_dashboard()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_board jsonb;
  v_today date := public._hr_today();
begin
  perform public.require_permission('hr.view');
  v_board := public.hr_attendance_board(v_today);
  return jsonb_build_object(
    'date', v_today,
    'today', (select jsonb_build_object(
        'staff', count(*),
        'present', count(*) filter (where x ->> 'state' = 'PRESENT'),
        'late', count(*) filter (where x ->> 'state' = 'LATE'),
        'half_day', count(*) filter (where x ->> 'state' = 'HALF_DAY'),
        'leave', count(*) filter (where x ->> 'state' in ('LEAVE', 'HOLIDAY')),
        'absent', count(*) filter (where x ->> 'state' = 'ABSENT'),
        'not_in', count(*) filter (where x ->> 'state' = 'NOT_IN'),
        'off', count(*) filter (where x ->> 'state' = 'OFF'),
        'checked_out', count(*) filter (where x -> 'record' ->> 'check_out_at' is not null))
      from jsonb_array_elements(v_board) x),
    'departments', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'color', d.color,
        'staff', (select count(*) from public.hr_employees e join public.profiles p on p.id = e.profile_id and p.is_active where e.department_id = d.id),
        'sops', (select count(*) from public.hr_sops s where s.department_id = d.id and s.is_active)) order by d.name)
      from public.hr_departments d where d.is_active), '[]'::jsonb),
    'trend', coalesce((select jsonb_agg(jsonb_build_object('date', g::date,
        'present', (select count(*) from public.hr_attendance a where a.work_date = g::date and a.status in ('PRESENT', 'HALF_DAY')),
        'late', (select count(*) from public.hr_attendance a where a.work_date = g::date and a.status = 'LATE'),
        'absent', (select count(*) from public.hr_attendance a where a.work_date = g::date and a.status = 'ABSENT'),
        'leave', (select count(*) from public.hr_attendance a where a.work_date = g::date and a.status in ('LEAVE', 'HOLIDAY'))) order by g)
      from generate_series(v_today - 13, v_today, interval '1 day') g), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(r order by r ->> 'at' desc) from (
        select jsonb_build_object('name', coalesce(nullif(p.full_name, ''), p.email), 'at', greatest(a.check_in_at, coalesce(a.check_out_at, a.check_in_at)),
          'kind', case when a.check_out_at is not null then 'out' else 'in' end, 'status', a.status, 'late_minutes', a.late_minutes) as r
        from public.hr_attendance a join public.profiles p on p.id = a.profile_id
        where a.work_date = v_today and a.check_in_at is not null
        order by greatest(a.check_in_at, coalesce(a.check_out_at, a.check_in_at)) desc limit 10) t), '[]'::jsonb),
    'unassigned', (select count(*) from public.profiles p left join public.hr_employees e on e.profile_id = p.id
                   where p.is_active and (e.profile_id is null or e.department_id is null or e.shift_id is null)),
    'board', v_board);
end;
$$;

-- ---------------------------------------------------------------------------
-- HR: set-up
-- ---------------------------------------------------------------------------
create or replace function public.hr_department_save(p jsonb)
returns public.hr_departments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.hr_departments;
  v_id uuid := nullif(p ->> 'id', '')::uuid;
begin
  perform public.require_permission('hr.manage');
  if v_id is null then
    insert into public.hr_departments(name, description, color, head_id, is_active)
    values (trim(p ->> 'name'), nullif(trim(coalesce(p ->> 'description', '')), ''), coalesce(nullif(p ->> 'color', ''), '#64748b'),
      nullif(p ->> 'head_id', '')::uuid, coalesce((p ->> 'is_active')::boolean, true))
    returning * into v_row;
  else
    update public.hr_departments set
      name = coalesce(trim(p ->> 'name'), name),
      description = case when p ? 'description' then nullif(trim(coalesce(p ->> 'description', '')), '') else description end,
      color = coalesce(nullif(p ->> 'color', ''), color),
      head_id = case when p ? 'head_id' then nullif(p ->> 'head_id', '')::uuid else head_id end,
      is_active = coalesce((p ->> 'is_active')::boolean, is_active)
    where id = v_id returning * into v_row;
    if v_row.id is null then raise exception 'NOT_FOUND: department not found' using errcode = 'P0002'; end if;
  end if;
  return v_row;
end;
$$;

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
  if v_id is null then
    insert into public.hr_sops(department_id, title, body, is_active, updated_by)
    values (nullif(p ->> 'department_id', '')::uuid, trim(p ->> 'title'), coalesce(p ->> 'body', ''), coalesce((p ->> 'is_active')::boolean, true), auth.uid())
    returning * into v_row;
  else
    update public.hr_sops set
      department_id = case when p ? 'department_id' then nullif(p ->> 'department_id', '')::uuid else department_id end,
      title = coalesce(trim(p ->> 'title'), title),
      body = coalesce(p ->> 'body', body),
      version = version + case when coalesce(p ->> 'body', body) is distinct from body or coalesce(trim(p ->> 'title'), title) is distinct from title then 1 else 0 end,
      is_active = coalesce((p ->> 'is_active')::boolean, is_active),
      updated_by = auth.uid()
    where id = v_id returning * into v_row;
    if v_row.id is null then raise exception 'NOT_FOUND: SOP not found' using errcode = 'P0002'; end if;
  end if;
  return v_row;
end;
$$;

create or replace function public.hr_shift_save(p jsonb)
returns public.hr_shifts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.hr_shifts;
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_days int[] := case when p ? 'work_days' then (select coalesce(array_agg(x::int order by x::int), '{}') from jsonb_array_elements_text(p -> 'work_days') x) end;
begin
  perform public.require_permission('hr.manage');
  if v_days is not null and cardinality(v_days) = 0 then
    raise exception 'VALIDATION: choose at least one work day' using errcode = '22023';
  end if;
  if v_id is null then
    insert into public.hr_shifts(name, start_time, end_time, grace_minutes, work_days, color, is_active)
    values (trim(p ->> 'name'), (p ->> 'start_time')::time, (p ->> 'end_time')::time, coalesce((p ->> 'grace_minutes')::int, 10),
      coalesce(v_days, '{0,1,2,3,4,6}'), coalesce(nullif(p ->> 'color', ''), '#0ea5e9'), coalesce((p ->> 'is_active')::boolean, true))
    returning * into v_row;
  else
    update public.hr_shifts set
      name = coalesce(trim(p ->> 'name'), name),
      start_time = coalesce((p ->> 'start_time')::time, start_time),
      end_time = coalesce((p ->> 'end_time')::time, end_time),
      grace_minutes = coalesce((p ->> 'grace_minutes')::int, grace_minutes),
      work_days = coalesce(v_days, work_days),
      color = coalesce(nullif(p ->> 'color', ''), color),
      is_active = coalesce((p ->> 'is_active')::boolean, is_active)
    where id = v_id returning * into v_row;
    if v_row.id is null then raise exception 'NOT_FOUND: shift not found' using errcode = 'P0002'; end if;
  end if;
  return v_row;
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
  insert into public.hr_employees(profile_id) values (p_profile) on conflict (profile_id) do nothing;
  update public.hr_employees set
    department_id = case when p ? 'department_id' then nullif(p ->> 'department_id', '')::uuid else department_id end,
    shift_id = case when p ? 'shift_id' then nullif(p ->> 'shift_id', '')::uuid else shift_id end,
    designation = case when p ? 'designation' then nullif(trim(coalesce(p ->> 'designation', '')), '') else designation end,
    employee_code = case when p ? 'employee_code' then nullif(trim(coalesce(p ->> 'employee_code', '')), '') else employee_code end,
    joined_on = case when p ? 'joined_on' then nullif(p ->> 'joined_on', '')::date else joined_on end,
    emergency_contact = case when p ? 'emergency_contact' then nullif(trim(coalesce(p ->> 'emergency_contact', '')), '') else emergency_contact end
  where profile_id = p_profile returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.hr_holiday_save(p_date date, p_name text, p_active boolean default true)
returns public.hr_holidays
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.hr_holidays;
begin
  perform public.require_permission('hr.manage');
  insert into public.hr_holidays(holiday_date, name, is_active) values (p_date, trim(p_name), coalesce(p_active, true))
  on conflict (holiday_date) do update set name = excluded.name, is_active = excluded.is_active
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.hr_settings_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb := coalesce(public.get_setting('hr'), '{}'::jsonb);
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
  if p ? 'allow_self_check_in' then
    v := v || jsonb_build_object('allow_self_check_in', (p ->> 'allow_self_check_in')::boolean);
  end if;
  update public.settings set value = v where key = 'hr';
  perform public.log_audit('hr.settings', 'settings', 'hr', null, v);
  return v;
end;
$$;

grant execute on function public._hr_today() to authenticated;
revoke all on function public._hr_is_work_day(public.hr_shifts, date), public._hr_shift_bounds(public.hr_shifts, date),
  public._hr_score(public.hr_shifts, date, timestamptz, timestamptz), public._hr_shift_of(uuid) from public, anon, authenticated;
revoke all on function public.hr_my_day(), public.hr_check_in(text), public.hr_check_out(text), public.hr_attendance_board(date),
  public.hr_attendance_set(uuid, date, public.hr_attendance_status, timestamptz, timestamptz, text), public.hr_attendance_report(date, date),
  public.hr_dashboard(), public.hr_department_save(jsonb), public.hr_sop_save(jsonb), public.hr_shift_save(jsonb),
  public.hr_employee_save(uuid, jsonb), public.hr_holiday_save(date, text, boolean), public.hr_settings_save(jsonb) from public, anon;
grant execute on function public.hr_my_day(), public.hr_check_in(text), public.hr_check_out(text), public.hr_attendance_board(date),
  public.hr_attendance_set(uuid, date, public.hr_attendance_status, timestamptz, timestamptz, text), public.hr_attendance_report(date, date),
  public.hr_dashboard(), public.hr_department_save(jsonb), public.hr_sop_save(jsonb), public.hr_shift_save(jsonb),
  public.hr_employee_save(uuid, jsonb), public.hr_holiday_save(date, text, boolean), public.hr_settings_save(jsonb) to authenticated;
