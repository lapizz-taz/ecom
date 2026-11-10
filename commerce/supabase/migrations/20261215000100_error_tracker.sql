-- =============================================================================
-- Super Admin → Error tracker: every error from the admin, the Super Admin panel, server functions,
-- webhooks and jobs, with what is needed to find its cause and to know it stays fixed.
--
-- Asked for on 10 Nov 2026. Built on the existing system log (system_logs):
--   * Each error has a status: New → Investigating → Fixed, or Ignored, with a note and "fixed in".
--     Fixed and Ignored set resolved_at, so health counts and the old Resolve buttons keep working
--     (resolving from the old System log tab now means Fixed).
--   * A fixed error that happens again is reopened as New and marked "came back" (regressed_at,
--     regressions). An old browser tab that was not reloaded after the fix does not reopen it: such
--     repeats are counted on the fixed error as "from an older app version" (old_version_hits).
--   * An ignored error keeps counting quietly and never comes back as New.
--   * The last 20 occurrences are kept in full (system_log_samples: the steps the person took, the
--     page, the app version, the request id), and a count per day (system_log_daily) for the trend.
--   * The same error in several businesses (same fingerprint) is shown as one entry.
--   * Ids and code file names no longer split one error into many (fingerprint).
--
-- New: system_log_samples, system_log_daily, _system_log_fingerprint(), platform_errors(),
-- platform_error_get(), platform_error_update(). Changed: _log_system_event(), log_client_error()
-- (also for Super Admin staff). Safe to re-run.
-- =============================================================================

-- ---------------------------------------------------------------- status and history on each error
alter table public.system_logs
  add column if not exists status text not null default 'NEW' check (status in ('NEW', 'INVESTIGATING', 'FIXED', 'IGNORED')),
  add column if not exists note text check (length(note) <= 2000),
  add column if not exists fixed_in text check (length(fixed_in) <= 120),
  add column if not exists fixed_release text check (length(fixed_release) <= 60),
  add column if not exists status_changed_at timestamptz,
  add column if not exists status_by uuid,
  add column if not exists regressed_at timestamptz,
  add column if not exists regressions int not null default 0,
  add column if not exists last_release text check (length(last_release) <= 60),
  add column if not exists old_version_hits int not null default 0,
  add column if not exists old_version_seen_at timestamptz;

-- Errors resolved before today were fixed.
update public.system_logs set status = 'FIXED', status_changed_at = resolved_at, status_by = resolved_by
where resolved_at is not null and status = 'NEW';

create index if not exists system_logs_fingerprint_idx on public.system_logs (fingerprint);
create index if not exists system_logs_status_idx on public.system_logs (status, last_seen_at desc);

-- Status and resolved_at always agree, whichever button changed them.
create or replace function public._system_logs_status()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Resolved with the older buttons (System log tab, a store's own log): that is "fixed".
  if old.resolved_at is null and new.resolved_at is not null and new.status = old.status and new.status not in ('FIXED', 'IGNORED') then
    new.status := 'FIXED';
  end if;
  if new.status in ('FIXED', 'IGNORED') and new.resolved_at is null then
    new.resolved_at := now();
    new.resolved_by := coalesce(new.resolved_by, auth.uid());
  elsif new.status in ('NEW', 'INVESTIGATING') and new.resolved_at is not null then
    new.resolved_at := null;
    new.resolved_by := null;
  end if;
  if new.status is distinct from old.status then
    new.status_changed_at := now();
    -- A fixed error that happened again was reopened by the log, not by the person who hit it.
    new.status_by := case when new.regressed_at is distinct from old.regressed_at then null else auth.uid() end;
  end if;
  return new;
end;
$$;
revoke all on function public._system_logs_status() from public, anon, authenticated;

drop trigger if exists system_logs_status on public.system_logs;
create trigger system_logs_status before update on public.system_logs
  for each row execute function public._system_logs_status();

-- ---------------------------------------------------------------- the last occurrences, and a count per day
create table if not exists public.system_log_samples (
  id bigint generated always as identity primary key,
  log_id bigint not null references public.system_logs(id) on delete cascade,
  -- Null for platform-level errors, like the error itself.
  merchant_id uuid default public.current_merchant_id(),
  at timestamptz not null default now(),
  message text not null check (length(message) <= 2000),
  release text check (length(release) <= 60),
  -- From an app version older than the fix (a tab that was not reloaded).
  old_version boolean not null default false,
  context jsonb not null default '{}'::jsonb
);
create index if not exists system_log_samples_log_idx on public.system_log_samples (log_id, id desc);
create index if not exists system_log_samples_merchant_idx on public.system_log_samples (merchant_id);
create index if not exists system_log_samples_request_idx on public.system_log_samples ((context ->> 'request_id')) where context ? 'request_id';
create index if not exists system_log_samples_user_idx on public.system_log_samples ((context ->> 'user_id'), at) where context ? 'user_id';

create table if not exists public.system_log_daily (
  log_id bigint not null references public.system_logs(id) on delete cascade,
  -- Bangladesh time.
  day date not null,
  n int not null default 0 check (n >= 0),
  merchant_id uuid default public.current_merchant_id(),
  primary key (log_id, day)
);
create index if not exists system_log_daily_merchant_idx on public.system_log_daily (merchant_id);

do $$
declare
  t text;
begin
  foreach t in array array['system_log_samples', 'system_log_daily'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format($p$create policy tenant_isolation on public.%I as restrictive for all to public
      using (merchant_id is not distinct from (select public.current_merchant_id()))
      with check (merchant_id is not distinct from (select public.current_merchant_id()))$p$, t);
    execute format('drop policy if exists app_owner_all on public.%I', t);
    execute format('create policy app_owner_all on public.%I for all to app_owner using (true) with check (true)', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- one error, however its details vary
-- Numbers, ids and the names of built code files (they change with every release) are left out,
-- so "order 1016 not found" and "order 1017 not found" are one error.
create or replace function public._system_log_fingerprint(p_category text, p_source text, p_message text)
returns text
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select md5(upper(coalesce(p_category, '')) || '|' || left(coalesce(p_source, ''), 80) || '|' || left(
    regexp_replace(
      regexp_replace(
        regexp_replace(left(coalesce(p_message, ''), 2000), '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '<id>', 'gi'),
        '/assets/[A-Za-z0-9._-]+', '/assets/<file>', 'g'),
      '[0-9]+', '#', 'g'), 200))
$$;
revoke all on function public._system_log_fingerprint(text, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------- writing an error
-- Repeats of an open error are counted on it. A fixed one is reopened ("came back") unless the repeat
-- comes from an app version older than the fix. An ignored one keeps counting quietly. Every
-- occurrence keeps its details (the last 20) and adds to today's count. Internal: callers check access.
create or replace function public._log_system_event(
  p_level text, p_category text, p_source text, p_message text, p_context jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_level text := upper(coalesce(p_level, 'ERROR'));
  v_category text := upper(coalesce(p_category, 'OTHER'));
  v_source text := left(coalesce(nullif(p_source, ''), 'unknown'), 80);
  v_message text := left(coalesce(nullif(p_message, ''), 'Unknown error'), 2000);
  v_context jsonb := coalesce(p_context, '{}'::jsonb);
  v_merchant uuid := public.current_merchant_id();
  v_fp text;
  v_release text;
  v_old public.system_logs;
  v_id bigint;
  v_old_version boolean := false;
  v_cut bigint;
begin
  if jsonb_typeof(v_context) <> 'object' then
    v_context := jsonb_build_object('value', v_context);
  end if;
  -- Details stay small: the steps go first, then everything but the stack.
  if length(v_context::text) > 16000 then
    v_context := (v_context - 'trail') || jsonb_build_object('trimmed', true);
    if length(v_context::text) > 16000 then
      v_context := jsonb_build_object('trimmed', true, 'stack', left(v_context ->> 'stack', 4000), 'release', v_context ->> 'release',
        'request_id', v_context ->> 'request_id', 'user_id', v_context ->> 'user_id', 'path', left(v_context ->> 'path', 300));
      v_context := jsonb_strip_nulls(v_context);
    end if;
  end if;
  v_release := nullif(left(v_context ->> 'release', 60), '');
  v_fp := public._system_log_fingerprint(v_category, v_source, v_message);

  -- The open one if there is one, else the one closed last.
  select * into v_old from public.system_logs l
  where l.fingerprint = v_fp and l.merchant_id is not distinct from v_merchant
  order by (l.resolved_at is null) desc, l.resolved_at desc nulls last, l.id desc
  limit 1;

  if v_old.id is not null and v_old.resolved_at is not null then
    if v_old.status = 'IGNORED' then
      -- Still happening: keep it (old resolved errors are cleared after a while), quietly.
      update public.system_logs set occurrences = occurrences + 1, last_seen_at = now(), resolved_at = now(), context = v_context,
        last_release = coalesce(v_release, last_release)
      where id = v_old.id
      returning id into v_id;
    elsif v_release ~ '^\d{4}-\d\d-\d\dT' and v_old.fixed_release ~ '^\d{4}-\d\d-\d\dT' and v_release < v_old.fixed_release then
      -- From a tab still running the version before the fix.
      update public.system_logs set occurrences = occurrences + 1, old_version_hits = old_version_hits + 1, old_version_seen_at = now()
      where id = v_old.id
      returning id into v_id;
      v_old_version := true;
    else
      -- It came back.
      begin
        update public.system_logs set status = 'NEW', resolved_at = null, resolved_by = null, regressed_at = now(), regressions = regressions + 1,
          occurrences = occurrences + 1, last_seen_at = now(), message = v_message, context = v_context,
          level = case when v_level = 'ERROR' then 'ERROR' else level end, last_release = coalesce(v_release, last_release)
        where id = v_old.id and resolved_at is not null
        returning id into v_id;
      exception when unique_violation then
        v_id := null; -- opened again at the same moment by another request: counted below
      end;
    end if;
  end if;

  if v_id is null then
    insert into public.system_logs(merchant_id, level, category, source, message, context, fingerprint, last_release)
    values (v_merchant, v_level, v_category, v_source, v_message, v_context, v_fp, v_release)
    on conflict (merchant_id, fingerprint) where resolved_at is null and fingerprint is not null
    do update set occurrences = public.system_logs.occurrences + 1, last_seen_at = now(), context = excluded.context,
      level = case when excluded.level = 'ERROR' then 'ERROR' else public.system_logs.level end,
      last_release = coalesce(excluded.last_release, public.system_logs.last_release)
    returning id into v_id;
  end if;

  -- Its details and today's count never stop the error itself from being written.
  begin
    insert into public.system_log_samples (log_id, merchant_id, message, release, old_version, context)
    values (v_id, v_merchant, v_message, v_release, v_old_version, v_context);
    select s.id into v_cut from public.system_log_samples s where s.log_id = v_id order by s.id desc offset 20 limit 1;
    if v_cut is not null then
      delete from public.system_log_samples where log_id = v_id and id <= v_cut;
    end if;
    insert into public.system_log_daily (log_id, day, n, merchant_id)
    values (v_id, (now() at time zone 'Asia/Dhaka')::date, 1, v_merchant)
    on conflict (log_id, day) do update set n = public.system_log_daily.n + 1;
  exception when others then
    raise warning 'system log details not saved: %', sqlerrm;
  end;
  return v_id;
end;
$$;
revoke execute on function public._log_system_event(text, text, text, text, jsonb) from public, anon, authenticated, service_role;

-- Browser errors from signed-in staff, and now also from the Super Admin panel (platform-level).
create or replace function public.log_client_error(p_message text, p_context jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_context jsonb := jsonb_strip_nulls(case when jsonb_typeof(p_context) = 'object' then p_context else '{}'::jsonb end);
begin
  if not (public.is_staff() or public.is_platform_staff()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  perform public._log_system_event('ERROR', 'FRONTEND', case when v_context ->> 'app' = 'super-admin' then 'super-admin' else 'admin-app' end,
    left(coalesce(nullif(p_message, ''), 'Unknown error'), 2000), v_context || jsonb_build_object('user_id', auth.uid()));
end;
$$;

-- ---------------------------------------------------------------- Super Admin: the list
-- One entry per error (the same error in several businesses is one entry), newest first.
-- p: status open|new|investigating|came_back|fixed|ignored|all, level, category, merchant, q,
-- period 24h|7d|30d|90d, sort recent|frequent|newest|businesses.
create or replace function public.platform_errors(p jsonb default '{}'::jsonb, p_limit int default 50, p_offset int default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text := lower(coalesce(nullif(p ->> 'status', ''), 'open'));
  v_level text := nullif(upper(coalesce(p ->> 'level', '')), '');
  v_category text := nullif(upper(coalesce(p ->> 'category', '')), '');
  v_merchant uuid := nullif(p ->> 'merchant', '')::uuid;
  v_q text := nullif(trim(coalesce(p ->> 'q', '')), '');
  v_qid bigint := case when v_q ~ '^#?[0-9]{1,18}$' then ltrim(v_q, '#')::bigint end;
  v_since timestamptz := case lower(coalesce(p ->> 'period', ''))
    when '24h' then now() - interval '24 hours' when '7d' then now() - interval '7 days'
    when '30d' then now() - interval '30 days' when '90d' then now() - interval '90 days' end;
  v_sort text := lower(coalesce(nullif(p ->> 'sort', ''), 'recent'));
  v_today date := (now() at time zone 'Asia/Dhaka')::date;
begin
  perform public._platform_require('health', 'view');
  if v_status not in ('open', 'new', 'investigating', 'came_back', 'fixed', 'ignored', 'all') then
    raise exception 'VALIDATION: unknown status %', v_status;
  end if;
  return (with scoped as (
      select l.*, coalesce(l.fingerprint, 'id:' || l.id) as gkey from public.system_logs l
      where l.merchant_id is null or l.merchant_id in (select public._platform_merchant_ids())),
    f as (
      select s.* from scoped s
      where (v_status = 'all'
             or (v_status = 'open' and s.status in ('NEW', 'INVESTIGATING'))
             or (v_status = 'came_back' and s.status in ('NEW', 'INVESTIGATING') and s.regressed_at is not null)
             or s.status = upper(v_status))
        and (v_level is null or s.level = v_level)
        and (v_category is null or s.category = v_category)
        and (v_merchant is null or s.merchant_id = v_merchant)
        and (v_since is null or s.last_seen_at >= v_since)
        and (v_q is null or s.message ilike '%' || v_q || '%' or s.source ilike '%' || v_q || '%' or s.fingerprint = v_q
             or s.id = v_qid)),
    g as (
      select f.gkey, array_agg(f.id order by f.last_seen_at desc, f.id desc) as ids,
        sum(f.occurrences)::bigint as occurrences, min(f.created_at) as first_seen_at, max(f.last_seen_at) as last_seen_at,
        count(distinct f.merchant_id)::int as businesses, bool_or(f.merchant_id is null) as platform, max(f.regressed_at) as regressed_at,
        sum(f.old_version_hits)::int as old_version_hits
      from f group by f.gkey),
    page as (
      select g.*, g.ids[1] as id, row_number() over (order by
          case when v_sort = 'frequent' then g.occurrences end desc nulls last,
          case when v_sort = 'businesses' then g.businesses end desc nulls last,
          case when v_sort = 'newest' then g.first_seen_at end desc nulls last,
          g.last_seen_at desc, g.gkey) as ord
      from g)
    select jsonb_build_object(
      'total', (select count(*) from g),
      'rows', (select coalesce(jsonb_agg(jsonb_build_object(
          'id', l.id, 'ids', to_jsonb(pg.ids), 'level', l.level, 'category', l.category, 'source', l.source, 'message', l.message,
          'status', l.status, 'occurrences', pg.occurrences, 'first_seen_at', pg.first_seen_at, 'last_seen_at', pg.last_seen_at,
          'regressed_at', pg.regressed_at, 'regressions', l.regressions, 'note', l.note, 'fixed_in', l.fixed_in,
          'last_release', l.last_release, 'businesses', pg.businesses, 'platform', pg.platform, 'old_version_hits', pg.old_version_hits,
          'merchant', (select jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name) from public.merchants m where m.id = l.merchant_id),
          'trend', (select jsonb_agg((select coalesce(sum(d.n), 0) from public.system_log_daily d where d.log_id = any (pg.ids) and d.day = v_today - 13 + i) order by i)
                    from generate_series(0, 13) i))
          order by pg.ord), '[]'::jsonb)
        from (select * from page order by ord limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0)) pg
        join public.system_logs l on l.id = pg.id),
      'stats', (select jsonb_build_object(
          'open', count(distinct s.gkey) filter (where s.status in ('NEW', 'INVESTIGATING')),
          'new_24h', count(distinct s.gkey) filter (where s.status = 'NEW' and s.created_at > now() - interval '24 hours'),
          'came_back', count(distinct s.gkey) filter (where s.status in ('NEW', 'INVESTIGATING') and s.regressed_at is not null),
          'investigating', count(distinct s.gkey) filter (where s.status = 'INVESTIGATING'),
          'fixed_7d', count(distinct s.gkey) filter (where s.status = 'FIXED' and s.status_changed_at > now() - interval '7 days'),
          'businesses', count(distinct s.merchant_id) filter (where s.status in ('NEW', 'INVESTIGATING')),
          'today', (select coalesce(sum(d.n), 0) from public.system_log_daily d join scoped s2 on s2.id = d.log_id where d.day = v_today))
        from scoped s),
      'by_category', (select coalesce(jsonb_object_agg(c.category, c.n), '{}'::jsonb)
        from (select f.category, count(distinct f.gkey) as n from f group by f.category) c),
      'can', jsonb_build_object('manage', public.platform_can('health', 'manage'))));
end;
$$;

-- ---------------------------------------------------------------- Super Admin: one error in full
-- The error (and the same error in other businesses), its last occurrences with the steps before
-- each, its count per day, errors that shared a request with it (the server side of a browser
-- error, or the other way round), other errors the same person hit within 2 minutes, and who
-- changed what.
create or replace function public.platform_error_get(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v public.system_logs;
  v_ids bigint[];
  v_today date := (now() at time zone 'Asia/Dhaka')::date;
begin
  perform public._platform_require('health', 'view');
  select * into v from public.system_logs l
  where l.id = p_id and (l.merchant_id is null or l.merchant_id in (select public._platform_merchant_ids()));
  if v.id is null then
    raise exception 'NOT_FOUND: that error is not in the log (it may have been cleared)';
  end if;
  select array_agg(l.id order by l.last_seen_at desc) into v_ids from public.system_logs l
  where l.fingerprint = v.fingerprint and (l.merchant_id is null or l.merchant_id in (select public._platform_merchant_ids()));
  v_ids := coalesce(v_ids, array[v.id]);

  return jsonb_build_object(
    'error', to_jsonb(v) - 'merchant_id' || jsonb_build_object(
      'first_seen_at', v.created_at,
      'merchant', (select jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name) from public.merchants m where m.id = v.merchant_id),
      'status_by_email', (select ps.email from public.platform_staff ps where ps.user_id = v.status_by)),
    'siblings', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'status', l.status, 'occurrences', l.occurrences,
        'first_seen_at', l.created_at, 'last_seen_at', l.last_seen_at, 'regressed_at', l.regressed_at, 'last_release', l.last_release,
        'merchant', (select jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name) from public.merchants m where m.id = l.merchant_id))
        order by l.last_seen_at desc), '[]'::jsonb)
      from (select * from public.system_logs where id = any (v_ids) order by last_seen_at desc limit 100) l),
    'samples', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'log_id', s.log_id, 'at', s.at, 'message', s.message,
        'release', s.release, 'old_version', s.old_version, 'context', s.context,
        'merchant', (select jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name) from public.merchants m where m.id = s.merchant_id),
        'user', (select jsonb_build_object('id', pr.id, 'name', nullif(pr.full_name, '')) from public.profiles pr
                 where s.context ->> 'user_id' ~ '^[0-9a-f-]{36}$' and pr.id = (s.context ->> 'user_id')::uuid))
        order by s.id desc), '[]'::jsonb)
      from (select * from public.system_log_samples where log_id = any (v_ids) order by id desc limit 20) s),
    'daily', (select jsonb_agg(jsonb_build_object('day', v_today - 29 + i,
        'n', (select coalesce(sum(d.n), 0) from public.system_log_daily d where d.log_id = any (v_ids) and d.day = v_today - 29 + i)) order by i)
      from generate_series(0, 29) i),
    'linked', (select coalesce(jsonb_agg(x.j order by x.at desc), '[]'::jsonb) from (
        select distinct on (l2.id) l2.id, s2.at, jsonb_build_object('id', l2.id, 'category', l2.category, 'source', l2.source, 'message', l2.message,
          'status', l2.status, 'at', s2.at, 'request_id', s2.context ->> 'request_id', 'context', s2.context) as j
        from (select * from public.system_log_samples where log_id = any (v_ids) and context ? 'request_id' order by id desc limit 20) s1
        join public.system_log_samples s2 on s2.context ? 'request_id' and s2.context ->> 'request_id' = s1.context ->> 'request_id' and s2.log_id <> all (v_ids)
        join public.system_logs l2 on l2.id = s2.log_id
        where l2.merchant_id is null or l2.merchant_id in (select public._platform_merchant_ids())
        order by l2.id, s2.at desc
        limit 20) x),
    'nearby', (select coalesce(jsonb_agg(x.j order by x.apart), '[]'::jsonb) from (
        select l2.id, min(abs(extract(epoch from s2.at - s1.at)))::int as apart,
          jsonb_build_object('id', l2.id, 'category', l2.category, 'source', l2.source, 'message', l2.message, 'status', l2.status,
            'seconds_apart', min(abs(extract(epoch from s2.at - s1.at)))::int, 'before', bool_or(s2.at < s1.at)) as j
        from (select * from public.system_log_samples where log_id = any (v_ids) and context ? 'user_id' order by id desc limit 10) s1
        join public.system_log_samples s2 on s2.context ? 'user_id' and s2.context ->> 'user_id' = s1.context ->> 'user_id'
          and s2.at between s1.at - interval '2 minutes' and s1.at + interval '2 minutes' and s2.log_id <> all (v_ids)
        join public.system_logs l2 on l2.id = s2.log_id
        where l2.merchant_id is null or l2.merchant_id in (select public._platform_merchant_ids())
        group by l2.id
        order by apart
        limit 10) x),
    'history', (select coalesce(jsonb_agg(jsonb_build_object('at', a.created_at, 'by', a.actor_email, 'action', a.action, 'note', a.reason,
        'before', a.before, 'after', a.after) order by a.created_at desc), '[]'::jsonb)
      from (select * from public.platform_audit_logs where entity_type = 'system_log' and entity_id = any (select unnest(v_ids)::text)
            order by created_at desc limit 30) a),
    'can', jsonb_build_object('manage', public.platform_can('health', 'manage')));
end;
$$;

-- ---------------------------------------------------------------- Super Admin: change status, note, fixed in
-- p: status NEW|INVESTIGATING|FIXED|IGNORED (optional), note, fixed_in, release (the panel's own app
-- version: repeats from older versions than this do not reopen a fixed error).
create or replace function public.platform_error_update(p_ids bigint[], p jsonb)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text := nullif(upper(coalesce(p ->> 'status', '')), '');
  v_release text := nullif(left(coalesce(p ->> 'release', ''), 60), '');
  r public.system_logs;
  v_open bigint;
  v_n int := 0;
begin
  perform public._platform_require('health', 'manage');
  if p_ids is null or cardinality(p_ids) = 0 then
    return 0;
  end if;
  if cardinality(p_ids) > 500 then
    raise exception 'VALIDATION: change at most 500 errors at once';
  end if;
  if v_status is not null and v_status not in ('NEW', 'INVESTIGATING', 'FIXED', 'IGNORED') then
    raise exception 'VALIDATION: unknown status %', v_status;
  end if;
  if p ? 'note' and length(coalesce(p ->> 'note', '')) > 2000 then
    raise exception 'VALIDATION: the note is too long (2000 characters at most)';
  end if;
  if p ? 'fixed_in' and length(coalesce(p ->> 'fixed_in', '')) > 120 then
    raise exception 'VALIDATION: "fixed in" is too long (120 characters at most)';
  end if;

  for r in
    select * from public.system_logs l
    where l.id = any (p_ids) and (l.merchant_id is null or l.merchant_id in (select public._platform_merchant_ids()))
    order by l.id
    for update
  loop
    if v_status in ('NEW', 'INVESTIGATING') and r.resolved_at is not null then
      select l.id into v_open from public.system_logs l
      where l.fingerprint = r.fingerprint and l.merchant_id is not distinct from r.merchant_id and l.resolved_at is null and l.id <> r.id
      limit 1;
      if v_open is not null then
        raise exception 'CONFLICT: error #% is already open again as #%. Change that one instead.', r.id, v_open;
      end if;
    end if;
    update public.system_logs set
      status = coalesce(v_status, status),
      note = case when p ? 'note' then nullif(left(trim(p ->> 'note'), 2000), '') else note end,
      fixed_in = case when p ? 'fixed_in' then nullif(left(trim(p ->> 'fixed_in'), 120), '') else fixed_in end,
      fixed_release = case when v_status = 'FIXED' and r.status <> 'FIXED' then v_release
                           when v_status is not null and v_status <> 'FIXED' then null else fixed_release end,
      old_version_hits = case when v_status = 'FIXED' and r.status <> 'FIXED' then 0 else old_version_hits end
    where id = r.id;
    perform public._platform_log('health.error_updated', r.merchant_id, 'system_log', r.id::text, nullif(trim(p ->> 'note'), ''),
      jsonb_build_object('status', r.status, 'note', r.note, 'fixed_in', r.fixed_in),
      jsonb_build_object('status', coalesce(v_status, r.status),
        'note', case when p ? 'note' then nullif(trim(p ->> 'note'), '') else r.note end,
        'fixed_in', case when p ? 'fixed_in' then nullif(trim(p ->> 'fixed_in'), '') else r.fixed_in end));
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------- access
revoke execute on function public.platform_errors(jsonb, integer, integer), public.platform_error_get(bigint),
  public.platform_error_update(bigint[], jsonb) from public, anon;
grant execute on function public.platform_errors(jsonb, integer, integer), public.platform_error_get(bigint),
  public.platform_error_update(bigint[], jsonb) to authenticated;

insert into public.tenancy_exempt_functions (name, reason)
select f, 'Platform operations: the error tracker across merchants, permission-checked (health)'
from unnest(array['platform_errors', 'platform_error_get', 'platform_error_update']) f
on conflict (name) do nothing;

select public._tenancy_own_functions();
