-- =============================================================================
-- 1600 · System log: failures from server functions, integrations (couriers,
-- payments, SMS, Meta), webhooks and the admin app, visible in the admin.
-- Nothing is silently swallowed: every unhandled error lands here (and in
-- Sentry when a DSN is configured).
-- =============================================================================

create table public.system_logs (
  id bigint generated always as identity primary key,
  level text not null check (level in ('INFO', 'WARN', 'ERROR')),
  category text not null check (category in (
    'FRONTEND', 'FUNCTION', 'WEBHOOK', 'PAYMENT', 'COURIER', 'SMS', 'META', 'AUTH', 'FRAUD', 'JOB', 'OTHER')),
  source text not null check (length(source) between 1 and 80),
  message text not null check (length(message) between 1 and 2000),
  context jsonb not null default '{}'::jsonb,
  fingerprint text,
  occurrences int not null default 1 check (occurrences > 0),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid,
  created_at timestamptz not null default now()
);
create index system_logs_created_idx on public.system_logs(created_at desc);
create index system_logs_open_idx on public.system_logs(level, last_seen_at desc) where resolved_at is null;
create unique index system_logs_open_fingerprint_idx on public.system_logs(fingerprint)
  where resolved_at is null and fingerprint is not null;

alter table public.system_logs enable row level security;
create policy system_logs_read on public.system_logs for select to authenticated
  using ((select public.has_permission('audit.view')));
revoke all on public.system_logs from anon, authenticated;
grant select on public.system_logs to authenticated;
grant all on public.system_logs to service_role;

-- Writes a log row. Repeats of the same open problem (same fingerprint) are
-- counted on one row instead of flooding the log. Internal: callers check access.
create or replace function public._log_system_event(
  p_level text, p_category text, p_source text, p_message text, p_context jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fingerprint text := md5(p_category || '|' || p_source || '|' || left(regexp_replace(p_message, '[0-9]+', '#', 'g'), 200));
  v_id bigint;
begin
  insert into public.system_logs(level, category, source, message, context, fingerprint)
  values (upper(p_level), upper(p_category), left(p_source, 80), left(p_message, 2000), coalesce(p_context, '{}'::jsonb), v_fingerprint)
  on conflict (fingerprint) where resolved_at is null and fingerprint is not null
  do update set occurrences = public.system_logs.occurrences + 1, last_seen_at = now(), context = excluded.context,
    level = case when excluded.level = 'ERROR' then 'ERROR' else public.system_logs.level end
  returning id into v_id;
  return v_id;
end;
$$;

-- Server functions (service role) report here.
create or replace function public.log_system_event(
  p_level text, p_category text, p_source text, p_message text, p_context jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return public._log_system_event(p_level, p_category, p_source, p_message, p_context);
end;
$$;

-- Admin app errors from signed-in staff (the storefront reports to Sentry only).
create or replace function public.log_client_error(p_message text, p_context jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_staff() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  perform public._log_system_event('ERROR', 'FRONTEND', 'admin-app', left(coalesce(p_message, 'Unknown error'), 2000),
    jsonb_strip_nulls(coalesce(p_context, '{}'::jsonb)) || jsonb_build_object('user_id', auth.uid()));
end;
$$;

create or replace function public.admin_resolve_system_logs(p_ids bigint[])
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int;
begin
  perform public.require_permission('audit.view');
  update public.system_logs set resolved_at = now(), resolved_by = auth.uid()
  where id = any(p_ids) and resolved_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public._log_system_event(text, text, text, text, jsonb) from public, anon, authenticated, service_role;
revoke execute on function public.log_system_event(text, text, text, text, jsonb), public.log_client_error(text, jsonb),
  public.admin_resolve_system_logs(bigint[]) from public, anon, authenticated;
grant execute on function public.log_system_event(text, text, text, text, jsonb), public.log_client_error(text, jsonb),
  public.admin_resolve_system_logs(bigint[]) to service_role;
grant execute on function public.log_client_error(text, jsonb), public.admin_resolve_system_logs(bigint[]) to authenticated;
