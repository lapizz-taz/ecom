-- =============================================================================
-- System Health, Incident Management, Automation Rules and Notifications
-- (announcements) for the platform team.
--
-- Health: every component says how it was checked. A component with nothing
-- to measure is "idle" or "unknown", never "ok".
-- Incidents: severity, affected merchants, owner, timeline. An incident can
-- mark an integration temporarily unavailable, which the feature system shows
-- merchants (UNAVAILABLE) until it is resolved.
-- Automation: a fixed catalogue of triggers that read source records (logs,
-- tickets, billing, usage) — never notifications, incidents or announcements —
-- so rules cannot trigger each other. Each subject is acted on at most once per
-- cooldown, each run is capped, and runs of one rule never overlap.
-- Announcements: in-app notices to all or chosen merchants, with a preview of
-- who gets them, delivery and read tracking, and merchants' own preferences
-- for optional kinds.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. System health
-- -----------------------------------------------------------------------------
create or replace function public.platform_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb := '[]'::jsonb;
  v_ids uuid[];
  v_n1 bigint;
  v_n2 bigint;
  v_n3 bigint;
  v_at timestamptz;
  v_at2 timestamptz;
  v_cron jsonb;
  v_sms jsonb := coalesce((select value from public.platform_settings where key = 'sms'), '{}'::jsonb);
  v_bd jsonb := coalesce((select value from public.platform_settings where key = 'bd_courier'), '{}'::jsonb);
begin
  perform public._platform_require('health', 'view');
  select coalesce(array_agg(id), '{}') into v_ids from public.merchants where id in (select public._platform_merchant_ids());

  -- Database: it answered this query; connections and size are measured.
  select count(*) into v_n1 from pg_stat_activity where datname = current_database();
  v := v || jsonb_build_object('key', 'database', 'group', 'Platform', 'name', 'Database',
    'status', case when v_n1 > current_setting('max_connections')::int * 0.8 then 'warn' else 'ok' end,
    'detail', format('Responding · %s of %s connections in use · %s', v_n1, current_setting('max_connections'), pg_size_pretty(pg_database_size(current_database()))),
    'check', 'Ran this check against the database and read its connection count', 'at', now());

  -- Scheduled jobs (pg_cron): the latest run of each job.
  if to_regclass('cron.job_run_details') is not null then
    execute $q$
      select jsonb_build_object(
        'jobs', coalesce(jsonb_agg(jsonb_build_object('name', j.jobname, 'schedule', j.schedule, 'active', j.active,
          'last_status', l.status, 'last_end', l.end_time, 'last_message', left(l.return_message, 200),
          'runs_24h', (select count(*) from cron.job_run_details d where d.jobid = j.jobid and d.start_time > now() - interval '24 hours'),
          'failed_24h', (select count(*) from cron.job_run_details d where d.jobid = j.jobid and d.start_time > now() - interval '24 hours' and d.status = 'failed'))
          order by j.jobname), '[]'::jsonb))
      from cron.job j
      left join lateral (select d.status, d.end_time, d.return_message from cron.job_run_details d where d.jobid = j.jobid order by d.start_time desc limit 1) l on true
    $q$ into v_cron;
    v := v || jsonb_build_object('key', 'cron', 'group', 'Background jobs', 'name', 'Scheduled tasks',
      'status', case when jsonb_array_length(v_cron -> 'jobs') = 0 then 'unknown'
                     when exists (select 1 from jsonb_array_elements(v_cron -> 'jobs') x where x ->> 'last_status' = 'failed') then 'warn'
                     when not exists (select 1 from jsonb_array_elements(v_cron -> 'jobs') x where x ->> 'last_end' is not null) then 'idle'
                     else 'ok' end,
      'detail', format('%s job(s) scheduled · %s with a failed latest run', jsonb_array_length(v_cron -> 'jobs'),
        (select count(*) from jsonb_array_elements(v_cron -> 'jobs') x where x ->> 'last_status' = 'failed')),
      'check', 'Latest run of each pg_cron job', 'jobs', v_cron -> 'jobs',
      'at', (select max((x ->> 'last_end')::timestamptz) from jsonb_array_elements(v_cron -> 'jobs') x));
  else
    v := v || jsonb_build_object('key', 'cron', 'group', 'Background jobs', 'name', 'Scheduled tasks', 'status', 'unknown',
      'detail', 'pg_cron is not installed here, so scheduled tasks cannot be checked', 'check', 'Looks for the pg_cron run history', 'at', null);
  end if;

  -- Store sync jobs: failures and jobs waiting longer than they should.
  select count(*) filter (where status = 'FAILED' and updated_at > now() - interval '24 hours'),
         count(*) filter (where status = 'PENDING' and next_attempt_at < now() - interval '15 minutes'),
         max(done_at), min(next_attempt_at) filter (where status = 'PENDING')
    into v_n1, v_n2, v_at, v_at2
  from public.channel_sync_jobs where merchant_id = any (v_ids);
  v := v || jsonb_build_object('key', 'store_sync', 'group', 'Background jobs', 'name', 'Store sync jobs (Shopify / WooCommerce)',
    'status', case when v_n2 > 20 then 'down' when v_n1 > 0 or v_n2 > 0 then 'warn' when v_at is null then 'idle' else 'ok' end,
    'detail', format('%s failed in 24 h · %s waiting over 15 min%s', v_n1, v_n2,
      case when v_at2 < now() - interval '15 minutes' then ' · oldest waiting since ' || to_char(v_at2 at time zone 'Asia/Dhaka', 'DD Mon HH24:MI') else '' end),
    'check', 'Failed and overdue jobs in the store sync queue', 'at', v_at, 'retry', 'store_jobs', 'retryable', v_n1);

  -- Webhooks in: courier status updates and errors logged by webhook handlers.
  select count(*) filter (where result in ('FAILED', 'UNMATCHED') and received_at > now() - interval '24 hours'),
         count(*) filter (where result in ('FAILED', 'UNMATCHED') and attempts < 6 and received_at > now() - interval '7 days'),
         max(received_at)
    into v_n1, v_n2, v_at
  from public.courier_webhook_events where merchant_id = any (v_ids);
  select count(*) into v_n3 from public.system_logs where category = 'WEBHOOK' and level = 'ERROR' and resolved_at is null
    and last_seen_at > now() - interval '24 hours' and (merchant_id is null or merchant_id = any (v_ids));
  v := v || jsonb_build_object('key', 'webhooks', 'group', 'Integrations', 'name', 'Webhooks (couriers, stores)',
    'status', case when v_n1 + v_n3 > 0 then 'warn' when v_at is null then 'idle' else 'ok' end,
    'detail', format('%s courier update(s) failed in 24 h · %s webhook error(s) logged in 24 h', v_n1, v_n3),
    'check', 'Courier webhook results and webhook errors in the system log', 'at', v_at, 'retry', 'courier_webhooks', 'retryable', v_n2);

  -- SMS: queue backlog and sending.
  select count(*) filter (where status = 'QUEUED' and next_attempt_at < now() - interval '15 minutes'),
         count(*) filter (where status = 'FAILED' and created_at > now() - interval '24 hours'),
         max(sent_at)
    into v_n1, v_n2, v_at
  from public.notification_logs where channel = 'SMS' and merchant_id = any (v_ids);
  v := v || jsonb_build_object('key', 'sms_queue', 'group', 'Queues', 'name', 'SMS queue',
    'status', case when v_n1 > 50 then 'down' when v_n1 > 0 or v_n2 > 0 then 'warn' when v_at is null then 'idle' else 'ok' end,
    'detail', format('%s waiting over 15 min · %s failed in 24 h%s', v_n1, v_n2, case when v_at is not null then ' · last sent ' || to_char(v_at at time zone 'Asia/Dhaka', 'DD Mon HH24:MI') else '' end),
    'check', 'Messages waiting past their send time, and failures', 'at', v_at);

  select count(*) filter (where status = 'SUCCEEDED'), count(*) filter (where status = 'FAILED'), max(finished_at) filter (where status = 'SUCCEEDED')
    into v_n1, v_n2, v_at
  from public.service_usage where service = 'SMS' and created_at > now() - interval '24 hours';
  v := v || jsonb_build_object('key', 'sms_provider', 'group', 'Providers', 'name', 'SMS provider',
    'status', case when not coalesce((v_sms ->> 'connected')::boolean, false) then 'down'
                   when v_n1 + v_n2 = 0 then 'idle'
                   when v_n2 > v_n1 then 'down' when v_n2 > 0 then 'warn' else 'ok' end,
    'detail', case when not coalesce((v_sms ->> 'connected')::boolean, false) then 'Not connected — merchants cannot send SMS'
                   else format('%s sent, %s failed in 24 h', v_n1, v_n2) end,
    'check', 'Connection state and the provider''s answers to real messages in the last 24 h', 'at', v_at);

  select count(*) filter (where status = 'SUCCEEDED'), count(*) filter (where status = 'FAILED'), max(finished_at) filter (where status = 'SUCCEEDED')
    into v_n1, v_n2, v_at
  from public.service_usage where service = 'BD_COURIER' and created_at > now() - interval '24 hours';
  v := v || jsonb_build_object('key', 'bd_courier', 'group', 'Providers', 'name', 'BD Courier',
    'status', case when not coalesce((v_bd ->> 'connected')::boolean, false) then 'down'
                   when v_n1 + v_n2 = 0 then case when (v_bd ->> 'last_test_ok')::boolean is false then 'down' else 'idle' end
                   when v_n2 > v_n1 then 'down' when v_n2 > 0 then 'warn' else 'ok' end,
    'detail', case when not coalesce((v_bd ->> 'connected')::boolean, false) then 'Not connected — checkouts use each store''s own history'
                   else format('%s lookups, %s failed in 24 h', v_n1, v_n2) || coalesce(' · last test ' || case when (v_bd ->> 'last_test_ok')::boolean then 'worked' else 'failed' end, '') end,
    'check', 'Connection state and real lookups in the last 24 h', 'at', v_at);

  -- Payment callbacks: gateway payments that never came back, and logged payment errors.
  select count(*) into v_n1 from public.billing_payments where method = 'GATEWAY' and status = 'PENDING' and created_at < now() - interval '30 minutes'
    and merchant_id = any (v_ids);
  select count(*) into v_n2 from public.pbx_bkash_transactions where status = 'PENDING' and payment_id is not null and created_at < now() - interval '30 minutes'
    and merchant_id = any (v_ids);
  select count(*) into v_n3 from public.system_logs where category = 'PAYMENT' and level = 'ERROR' and resolved_at is null
    and last_seen_at > now() - interval '24 hours' and (merchant_id is null or merchant_id = any (v_ids));
  v := v || jsonb_build_object('key', 'payments', 'group', 'Integrations', 'name', 'Payment callbacks',
    'status', case when v_n1 + v_n2 + v_n3 > 0 then 'warn'
                   when not exists (select 1 from public.billing_payments where method = 'GATEWAY') and not exists (select 1 from public.payment_events) then 'idle'
                   else 'ok' end,
    'detail', format('%s platform payment(s) and %s PBX payment(s) without a confirmation after 30 min · %s payment error(s) in 24 h', v_n1, v_n2, v_n3),
    'check', 'Gateway payments still waiting for their callback, and payment errors', 'at', null);

  -- VoiceDrive gateway heartbeat.
  select last_seen_at into v_at from public.pbx_gateway_status;
  v := v || jsonb_build_object('key', 'pbx_gateway', 'group', 'Providers', 'name', 'VoiceDrive PBX gateway',
    'status', case when v_at is null then 'idle' when v_at > now() - interval '2 minutes' then 'ok' else 'down' end,
    'detail', case when v_at is null then 'Has never checked in' else 'Last check-in ' || to_char(v_at at time zone 'Asia/Dhaka', 'DD Mon HH24:MI') end,
    'check', 'The gateway reports in every 30 seconds', 'at', v_at);

  -- Integration outages at merchants.
  select count(*) filter (where status = 'ERROR'), count(*) into v_n1, v_n2 from public.sales_channels where status <> 'DISCONNECTED' and merchant_id = any (v_ids);
  v := v || jsonb_build_object('key', 'stores', 'group', 'Integrations', 'name', 'Merchant store connections',
    'status', case when v_n2 = 0 then 'idle' when v_n1 > 0 then 'warn' else 'ok' end,
    'detail', format('%s of %s connected stores report an error', v_n1, v_n2), 'check', 'Each store''s connection state', 'at', null);

  -- Application and API errors.
  select count(*) filter (where category = 'FUNCTION'), count(*) filter (where category = 'FRONTEND'), count(*), max(last_seen_at)
    into v_n1, v_n2, v_n3, v_at
  from public.system_logs where level = 'ERROR' and resolved_at is null and last_seen_at > now() - interval '24 hours'
    and (merchant_id is null or merchant_id = any (v_ids));
  v := v || jsonb_build_object('key', 'errors', 'group', 'Platform', 'name', 'Application errors',
    'status', case when v_n3 > 50 then 'down' when v_n3 > 0 then 'warn' else 'ok' end,
    'detail', format('%s unresolved in 24 h (%s from server functions, %s from browsers)', v_n3, v_n1, v_n2),
    'check', 'Errors reported to the system log by server functions and browsers', 'at', v_at);

  return jsonb_build_object('checked_at', now(), 'components', v,
    'incidents', (select jsonb_build_object('open', count(*) filter (where status <> 'RESOLVED'),
        'critical', count(*) filter (where status <> 'RESOLVED' and severity = 'CRITICAL')) from public.platform_incidents),
    'can', jsonb_build_object('manage', public.platform_can('health', 'manage')));
end;
$$;

create or replace function public.platform_system_logs(p jsonb default '{}'::jsonb, p_limit int default 50, p_offset int default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_level text := nullif(upper(coalesce(p ->> 'level', '')), '');
  v_category text := nullif(upper(coalesce(p ->> 'category', '')), '');
  v_merchant uuid := nullif(p ->> 'merchant', '')::uuid;
  v_q text := nullif(trim(coalesce(p ->> 'q', '')), '');
  v_open boolean := coalesce((p ->> 'unresolved')::boolean, true);
  v_id bigint := nullif(p ->> 'id', '')::bigint;
begin
  perform public._platform_require('health', 'view');
  return (with f as (
      select l.* from public.system_logs l
      where (l.merchant_id is null or l.merchant_id in (select public._platform_merchant_ids()))
        and (v_id is null or l.id = v_id)
        and (v_level is null or l.level = v_level) and (v_category is null or l.category = v_category)
        and (v_merchant is null or l.merchant_id = v_merchant)
        and (not v_open or v_id is not null or l.resolved_at is null)
        and (v_q is null or l.message ilike '%' || v_q || '%' or l.source ilike '%' || v_q || '%'))
    select jsonb_build_object(
      'total', (select count(*) from f),
      'rows', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'level', x.level, 'category', x.category, 'source', x.source, 'message', x.message,
          'context', x.context, 'occurrences', x.occurrences, 'first_seen_at', x.created_at, 'last_seen_at', x.last_seen_at, 'resolved_at', x.resolved_at,
          'merchant', (select jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name) from public.merchants m where m.id = x.merchant_id))
          order by x.last_seen_at desc), '[]'::jsonb)
        from (select * from f order by last_seen_at desc limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0)) x),
      'by_category', (select coalesce(jsonb_object_agg(category, n), '{}'::jsonb) from (select category, count(*) n from f group by category) c)));
end;
$$;

create or replace function public.platform_system_logs_resolve(p_ids bigint[], p_note text default null)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n int;
begin
  perform public._platform_require('health', 'manage');
  update public.system_logs set resolved_at = now(), resolved_by = auth.uid()
  where id = any (p_ids) and resolved_at is null and (merchant_id is null or merchant_id in (select public._platform_merchant_ids()));
  get diagnostics v_n = row_count;
  perform public._platform_log('health.logs_resolved', null, 'system_log', array_to_string(p_ids[1:20], ','), p_note, null, jsonb_build_object('resolved', v_n));
  return v_n;
end;
$$;

-- Safe bulk retries. p_preview = true only counts what would be retried (and for whom).
create or replace function public.platform_health_retry(p_kind text, p_preview boolean, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n int;
  v_merchants jsonb;
begin
  perform public._platform_require('health', 'manage');
  if p_kind = 'store_jobs' then
    select count(*), coalesce(jsonb_agg(distinct jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name)), '[]'::jsonb) into v_n, v_merchants
    from public.channel_sync_jobs j join public.merchants m on m.id = j.merchant_id
    where j.status = 'FAILED' and j.updated_at > now() - interval '7 days' and j.merchant_id in (select public._platform_merchant_ids())
      and not exists (select 1 from public.channel_sync_jobs o where o.id <> j.id and o.channel_id = j.channel_id and o.kind = j.kind
                      and o.ref_id = j.ref_id and o.status in ('PENDING', 'RUNNING'));
    if not p_preview then
      update public.channel_sync_jobs j set status = 'PENDING', attempts = 0, next_attempt_at = now(), last_error = null, locked_until = null
      where j.status = 'FAILED' and j.updated_at > now() - interval '7 days' and j.merchant_id in (select public._platform_merchant_ids())
        and not exists (select 1 from public.channel_sync_jobs o where o.id <> j.id and o.channel_id = j.channel_id and o.kind = j.kind
                        and o.ref_id = j.ref_id and o.status in ('PENDING', 'RUNNING'));
      get diagnostics v_n = row_count;
    end if;
  elsif p_kind = 'courier_webhooks' then
    -- Handed back to the courier retry job (every 5 minutes); each event is applied once.
    select count(*), coalesce(jsonb_agg(distinct jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name)), '[]'::jsonb) into v_n, v_merchants
    from public.courier_webhook_events e join public.merchants m on m.id = e.merchant_id
    where e.result in ('FAILED', 'UNMATCHED') and e.attempts < 6 and e.received_at > now() - interval '7 days'
      and e.merchant_id in (select public._platform_merchant_ids());
    if not p_preview then
      update public.courier_webhook_events e set next_retry_at = now()
      where e.result in ('FAILED', 'UNMATCHED') and e.attempts < 6 and e.received_at > now() - interval '7 days'
        and e.merchant_id in (select public._platform_merchant_ids());
      get diagnostics v_n = row_count;
    end if;
  else
    raise exception 'VALIDATION: nothing to retry for %', p_kind using errcode = '22023';
  end if;
  if not p_preview then
    perform public._platform_log('health.retry', null, p_kind, null, p_reason, null, jsonb_build_object('count', v_n, 'merchants', v_merchants));
  end if;
  return jsonb_build_object('kind', p_kind, 'count', v_n, 'merchants', v_merchants, 'preview', p_preview);
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. Incidents
-- -----------------------------------------------------------------------------
create table public.platform_incidents (
  id uuid primary key default gen_random_uuid(),
  number bigint generated always as identity unique,
  title text not null check (length(trim(title)) between 3 and 160),
  description text check (length(description) <= 4000),
  severity text not null check (severity in ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')),
  status text not null default 'INVESTIGATING' check (status in ('INVESTIGATING', 'IDENTIFIED', 'MONITORING', 'RESOLVED')),
  -- Which integration is affected; with mark_unavailable it shows as
  -- "temporarily unavailable" to merchants until resolved.
  integration text check (integration in ('shopify', 'woocommerce', 'sms', 'bd_courier', 'pbx', 'payments', 'couriers', 'ads', 'platform')),
  mark_unavailable boolean not null default false,
  scope text not null default 'NONE' check (scope in ('ALL', 'SELECTED', 'NONE')),
  assigned_to uuid references auth.users(id),
  source text not null default 'MANUAL' check (source in ('MANUAL', 'AUTOMATION')),
  rule_id uuid,
  -- One open incident per automation subject.
  dedupe_key text,
  started_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution text check (length(resolution) <= 4000),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'RESOLVED' or (resolved_at is not null and length(trim(coalesce(resolution, ''))) >= 5)),
  check (not mark_unavailable or integration is not null)
);
create unique index platform_incidents_open_dedupe on public.platform_incidents (dedupe_key) where status <> 'RESOLVED' and dedupe_key is not null;
create index platform_incidents_status_idx on public.platform_incidents (status, severity, started_at desc);
create trigger platform_incidents_updated_at before update on public.platform_incidents for each row execute function public.set_updated_at();

create table public.platform_incident_merchants (
  incident_id uuid not null references public.platform_incidents(id) on delete cascade,
  merchant_id uuid not null references public.merchants(id),
  primary key (incident_id, merchant_id)
);

create table public.platform_incident_updates (
  id bigint generated always as identity primary key,
  incident_id uuid not null references public.platform_incidents(id),
  kind text not null check (kind in ('CREATED', 'STATUS', 'SEVERITY', 'ASSIGNED', 'NOTE', 'MERCHANTS', 'UNAVAILABLE')),
  body text check (length(body) <= 4000),
  data jsonb not null default '{}'::jsonb,
  actor_id uuid,
  actor_email text,
  created_at timestamptz not null default now()
);
create index platform_incident_updates_idx on public.platform_incident_updates (incident_id, id);
create trigger platform_incident_updates_immutable before update or delete on public.platform_incident_updates
  for each row execute function public.prevent_mutation();
alter table public.platform_incidents enable row level security;
alter table public.platform_incident_merchants enable row level security;
alter table public.platform_incident_updates enable row level security;
revoke all on public.platform_incidents, public.platform_incident_merchants, public.platform_incident_updates from anon, authenticated;

-- The integrations open incidents mark unavailable; merchant_entitlements() reads this.
-- An incident for all merchants (or no particular ones) affects everyone; one
-- for selected merchants affects only them.
create or replace function public._platform_incident_sync_health()
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.platform_settings (key, value) values ('integration_health', jsonb_build_object(
    'failing', coalesce((select jsonb_agg(distinct integration) from public.platform_incidents
                         where status <> 'RESOLVED' and mark_unavailable and scope <> 'SELECTED'), '[]'::jsonb),
    'by_merchant', coalesce((select jsonb_object_agg(merchant_id, integrations) from (
        select im.merchant_id, jsonb_agg(distinct i.integration) as integrations
        from public.platform_incidents i join public.platform_incident_merchants im on im.incident_id = i.id
        where i.status <> 'RESOLVED' and i.mark_unavailable and i.scope = 'SELECTED' group by im.merchant_id) x), '{}'::jsonb)))
  on conflict (key) do update set value = excluded.value
$$;

create or replace function public.merchant_entitlements(p_merchant uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := coalesce(p_merchant, public.current_merchant_id());
  v_plan public.plans;
  v_out jsonb := '{}'::jsonb;
  f public.features;
  o public.merchant_features;
  v_state text;
  v_limit numeric;
  v_failing text[] := '{}';
begin
  if v_id is null then
    return '{}'::jsonb;
  end if;
  select p.* into v_plan from public.subscriptions s join public.plans p on p.id = s.plan_id where s.merchant_id = v_id and s.ended_at is null;
  -- Integrations reported failing for this merchant right now.
  if exists (select 1 from public.sales_channels where merchant_id = v_id and platform = 'SHOPIFY' and status = 'ERROR') then v_failing := array_append(v_failing, 'shopify'); end if;
  if exists (select 1 from public.sales_channels where merchant_id = v_id and platform = 'WOOCOMMERCE' and status = 'ERROR') then v_failing := array_append(v_failing, 'woocommerce'); end if;
  -- Integrations an open incident marks unavailable, for everyone or for this merchant.
  v_failing := v_failing || coalesce(array(select jsonb_array_elements_text(value -> 'failing') from public.platform_settings where key = 'integration_health'), '{}')
    || coalesce(array(select jsonb_array_elements_text(value -> 'by_merchant' -> v_id::text) from public.platform_settings where key = 'integration_health'), '{}');
  for f in select * from public.features order by sort_order loop
    select * into o from public.merchant_features where merchant_id = v_id and feature_code = f.code and (expires_at is null or expires_at > now());
    v_limit := coalesce(o.limit_value, nullif(v_plan.limits ->> f.code, '')::numeric);
    v_state := case
      when f.is_core then 'CORE'
      when not f.globally_enabled then 'DISABLED_GLOBALLY'
      when o.enabled is false then 'DISABLED_FOR_MERCHANT'
      when o.enabled is true then 'ENABLED'
      when f.release_stage <> 'GA' then 'BETA_NOT_ENROLLED'
      when coalesce((v_plan.features ->> f.code)::boolean, false) then 'ENABLED'
      else 'NOT_IN_PLAN' end;
    if v_state = 'ENABLED' and f.depends_on = any (v_failing) then
      v_state := 'UNAVAILABLE';
    end if;
    v_out := v_out || jsonb_build_object(f.code, jsonb_build_object('name', f.name, 'state', v_state,
      'enabled', v_state in ('ENABLED', 'CORE', 'UNAVAILABLE'), 'limit', v_limit, 'override', o.enabled, 'override_reason', o.reason));
  end loop;
  return v_out;
end;
$$;

create or replace function public._platform_incident_update(p_incident uuid, p_kind text, p_body text, p_data jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.platform_incident_updates (incident_id, kind, body, data, actor_id, actor_email)
  values (p_incident, p_kind, left(p_body, 4000), coalesce(p_data, '{}'::jsonb), auth.uid(), (select email from public.platform_staff where user_id = auth.uid()))
$$;

create or replace function public._platform_incident_json(i public.platform_incidents)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object('id', i.id, 'number', i.number, 'title', i.title, 'description', i.description, 'severity', i.severity, 'status', i.status,
    'integration', i.integration, 'mark_unavailable', i.mark_unavailable, 'scope', i.scope, 'source', i.source,
    'assigned', (select jsonb_build_object('user_id', s.user_id, 'name', coalesce(nullif(trim(s.full_name), ''), s.email), 'email', s.email)
                 from public.platform_staff s where s.user_id = i.assigned_to),
    'merchants', case when i.scope = 'SELECTED' then (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name) order by m.number), '[]'::jsonb)
                  from public.platform_incident_merchants im join public.merchants m on m.id = im.merchant_id where im.incident_id = i.id) end,
    'started_at', i.started_at, 'resolved_at', i.resolved_at, 'resolution', i.resolution, 'created_at', i.created_at, 'updated_at', i.updated_at,
    'minutes_open', round(extract(epoch from coalesce(i.resolved_at, now()) - i.started_at) / 60))
$$;

-- Opens an incident (also used by automation rules, which pass a dedupe key).
create or replace function public._platform_incident_open(p jsonb, p_source text default 'MANUAL', p_rule uuid default null, p_dedupe text default null)
returns public.platform_incidents
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  i public.platform_incidents;
  v_scope text := upper(coalesce(nullif(p ->> 'scope', ''), case when jsonb_array_length(coalesce(p -> 'merchants', '[]'::jsonb)) > 0 then 'SELECTED' else 'NONE' end));
  v_m uuid;
begin
  if p_dedupe is not null then
    select * into i from public.platform_incidents where dedupe_key = p_dedupe and status <> 'RESOLVED';
    if i.id is not null then
      return i;
    end if;
  end if;
  if upper(coalesce(p ->> 'severity', '')) not in ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW') then
    raise exception 'VALIDATION: choose the severity' using errcode = '22023';
  end if;
  if length(trim(coalesce(p ->> 'title', ''))) < 3 then
    raise exception 'VALIDATION: give the incident a title' using errcode = '22023';
  end if;
  if v_scope not in ('ALL', 'SELECTED', 'NONE') then
    raise exception 'VALIDATION: unknown scope' using errcode = '22023';
  end if;
  insert into public.platform_incidents (title, description, severity, integration, mark_unavailable, scope, assigned_to, source, rule_id, dedupe_key, created_by)
  values (left(trim(p ->> 'title'), 160), nullif(trim(coalesce(p ->> 'description', '')), ''), upper(p ->> 'severity'), nullif(p ->> 'integration', ''),
          coalesce((p ->> 'mark_unavailable')::boolean, false), v_scope, nullif(p ->> 'assigned_to', '')::uuid, p_source, p_rule, p_dedupe, auth.uid())
  returning * into i;
  if v_scope = 'SELECTED' then
    for v_m in select (jsonb_array_elements_text(p -> 'merchants'))::uuid loop
      if exists (select 1 from public.merchants where id = v_m) then
        insert into public.platform_incident_merchants (incident_id, merchant_id) values (i.id, v_m) on conflict do nothing;
      end if;
    end loop;
  end if;
  perform public._platform_incident_update(i.id, 'CREATED', i.description, jsonb_build_object('severity', i.severity, 'source', p_source));
  perform public._platform_incident_sync_health();
  if i.severity in ('CRITICAL', 'HIGH') then
    perform public._platform_notify('incidents', 'edit', null, 'incident.opened', case when i.severity = 'CRITICAL' then 'CRITICAL' else 'WARN' end,
      format('%s incident #%s: %s', initcap(i.severity), i.number, i.title), i.description, '/super-admin/incidents?incident=' || i.id, 'incident.opened:' || i.id);
  end if;
  if i.assigned_to is not null then
    perform public._platform_notify('incidents', 'view', null, 'incident.assigned', 'WARN', format('Incident #%s is yours: %s', i.number, i.title), null,
      '/super-admin/incidents?incident=' || i.id, 'incident.assigned:' || i.id || ':' || i.assigned_to, array[i.assigned_to]);
  end if;
  return i;
end;
$$;

create or replace function public.platform_incident_create(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  i public.platform_incidents;
begin
  perform public._platform_require('incidents', 'create');
  if coalesce((p ->> 'mark_unavailable')::boolean, false) then
    perform public._platform_require('incidents', 'manage');
  end if;
  if nullif(p ->> 'assigned_to', '') is not null and not public._platform_staff_can((p ->> 'assigned_to')::uuid, 'incidents', 'edit') then
    raise exception 'VALIDATION: that person cannot work on incidents' using errcode = '22023';
  end if;
  i := public._platform_incident_open(p, 'MANUAL');
  perform public._platform_log('incident.opened', null, 'platform_incident', i.id::text, null, null, public._platform_incident_json(i));
  return public._platform_incident_json(i);
end;
$$;

create or replace function public.platform_incident_update(p_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  i public.platform_incidents;
  v_row public.platform_incidents;
  v_status text := nullif(upper(coalesce(p ->> 'status', '')), '');
  v_severity text := nullif(upper(coalesce(p ->> 'severity', '')), '');
  v_assign uuid := nullif(p ->> 'assigned_to', '')::uuid;
  v_m uuid;
begin
  perform public._platform_require('incidents', 'edit');
  select * into i from public.platform_incidents where id = p_id for update;
  if i.id is null then
    raise exception 'NOT_FOUND: incident not found' using errcode = 'P0002';
  end if;
  if i.status = 'RESOLVED' and coalesce(v_status, 'RESOLVED') = 'RESOLVED' and (p ? 'severity' or p ? 'assigned_to' or p ? 'mark_unavailable') then
    raise exception 'VALIDATION: reopen the incident first' using errcode = '22023';
  end if;
  if v_status is not null and v_status not in ('INVESTIGATING', 'IDENTIFIED', 'MONITORING', 'RESOLVED') then
    raise exception 'VALIDATION: unknown status' using errcode = '22023';
  end if;
  if v_severity is not null and v_severity not in ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW') then
    raise exception 'VALIDATION: unknown severity' using errcode = '22023';
  end if;
  if v_status = 'RESOLVED' and i.status <> 'RESOLVED' and length(trim(coalesce(p ->> 'resolution', ''))) < 5 then
    raise exception 'VALIDATION: write what fixed it (the resolution notes)' using errcode = '22023';
  end if;
  if p ? 'mark_unavailable' and (p ->> 'mark_unavailable')::boolean is distinct from i.mark_unavailable then
    perform public._platform_require('incidents', 'manage');
    if (p ->> 'mark_unavailable')::boolean and coalesce(nullif(p ->> 'integration', ''), i.integration) is null then
      raise exception 'VALIDATION: say which integration is unavailable' using errcode = '22023';
    end if;
  end if;
  if v_assign is not null and not public._platform_staff_can(v_assign, 'incidents', 'edit') then
    raise exception 'VALIDATION: that person cannot work on incidents' using errcode = '22023';
  end if;
  update public.platform_incidents set
    status = coalesce(v_status, status),
    severity = coalesce(v_severity, severity),
    assigned_to = case when p ? 'assigned_to' then v_assign else assigned_to end,
    integration = case when p ? 'integration' then nullif(p ->> 'integration', '') else integration end,
    mark_unavailable = coalesce((p ->> 'mark_unavailable')::boolean, mark_unavailable),
    resolved_at = case when coalesce(v_status, status) = 'RESOLVED' then coalesce(resolved_at, now()) else null end,
    resolution = case when v_status = 'RESOLVED' then trim(p ->> 'resolution') when v_status is not null then null else resolution end,
    scope = coalesce(nullif(upper(coalesce(p ->> 'scope', '')), ''), scope)
  where id = i.id returning * into v_row;
  if p ? 'merchants' then
    delete from public.platform_incident_merchants where incident_id = i.id;
    for v_m in select (jsonb_array_elements_text(p -> 'merchants'))::uuid loop
      insert into public.platform_incident_merchants (incident_id, merchant_id) values (i.id, v_m) on conflict do nothing;
    end loop;
    perform public._platform_incident_update(i.id, 'MERCHANTS', null, jsonb_build_object('count', jsonb_array_length(p -> 'merchants')));
  end if;
  if v_row.status is distinct from i.status then
    perform public._platform_incident_update(i.id, 'STATUS', case when v_row.status = 'RESOLVED' then v_row.resolution else nullif(trim(coalesce(p ->> 'note', '')), '') end,
      jsonb_build_object('from', i.status, 'to', v_row.status));
  end if;
  if v_row.severity is distinct from i.severity then
    perform public._platform_incident_update(i.id, 'SEVERITY', null, jsonb_build_object('from', i.severity, 'to', v_row.severity));
  end if;
  if v_row.assigned_to is distinct from i.assigned_to then
    perform public._platform_incident_update(i.id, 'ASSIGNED', null, jsonb_build_object('to_email', (select email from public.platform_staff where user_id = v_row.assigned_to)));
    if v_row.assigned_to is not null and v_row.assigned_to <> auth.uid() then
      perform public._platform_notify('incidents', 'view', null, 'incident.assigned', 'WARN', format('Incident #%s is yours: %s', v_row.number, v_row.title), null,
        '/super-admin/incidents?incident=' || v_row.id, 'incident.assigned:' || v_row.id || ':' || v_row.assigned_to || ':' || extract(epoch from now())::bigint, array[v_row.assigned_to]);
    end if;
  end if;
  if v_row.mark_unavailable is distinct from i.mark_unavailable then
    perform public._platform_incident_update(i.id, 'UNAVAILABLE', null, jsonb_build_object('integration', v_row.integration, 'unavailable', v_row.mark_unavailable));
  end if;
  perform public._platform_incident_sync_health();
  perform public._platform_log('incident.updated', null, 'platform_incident', i.id::text, nullif(trim(coalesce(p ->> 'note', '')), ''),
    jsonb_build_object('status', i.status, 'severity', i.severity, 'assigned_to', i.assigned_to, 'mark_unavailable', i.mark_unavailable),
    jsonb_build_object('status', v_row.status, 'severity', v_row.severity, 'assigned_to', v_row.assigned_to, 'mark_unavailable', v_row.mark_unavailable));
  return public._platform_incident_json(v_row);
end;
$$;

create or replace function public.platform_incident_note(p_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  i public.platform_incidents;
begin
  perform public._platform_require('incidents', 'edit');
  select * into i from public.platform_incidents where id = p_id;
  if i.id is null then
    raise exception 'NOT_FOUND: incident not found' using errcode = 'P0002';
  end if;
  if length(trim(coalesce(p_body, ''))) < 2 then
    raise exception 'VALIDATION: write the update' using errcode = '22023';
  end if;
  perform public._platform_incident_update(i.id, 'NOTE', trim(p_body));
  return public._platform_incident_json(i);
end;
$$;

create or replace function public.platform_incidents_list(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_view text := coalesce(nullif(p ->> 'view', ''), 'open');
begin
  perform public._platform_require('incidents', 'view');
  return jsonb_build_object(
    'rows', (select coalesce(jsonb_agg(public._platform_incident_json(i) order by (i.status = 'RESOLVED'),
        case i.severity when 'CRITICAL' then 0 when 'HIGH' then 1 when 'MEDIUM' then 2 else 3 end, i.started_at desc), '[]'::jsonb)
      from (select * from public.platform_incidents x where case v_view when 'open' then x.status <> 'RESOLVED'
              when 'resolved' then x.status = 'RESOLVED' else true end order by x.started_at desc limit 200) i),
    'summary', (select jsonb_build_object('open', count(*) filter (where status <> 'RESOLVED'),
        'critical', count(*) filter (where status <> 'RESOLVED' and severity = 'CRITICAL'),
        'unavailable', (select coalesce(jsonb_agg(distinct integration), '[]'::jsonb) from public.platform_incidents where status <> 'RESOLVED' and mark_unavailable),
        'resolved_30d', count(*) filter (where resolved_at > now() - interval '30 days'),
        'avg_minutes_30d', round(avg(extract(epoch from resolved_at - started_at) / 60) filter (where resolved_at > now() - interval '30 days')))
      from public.platform_incidents),
    'staff', (select coalesce(jsonb_agg(jsonb_build_object('user_id', s.user_id, 'name', coalesce(nullif(trim(s.full_name), ''), s.email))
        order by s.full_name), '[]'::jsonb) from public.platform_staff s where s.is_active and public._platform_staff_can(s.user_id, 'incidents', 'edit')),
    'can', jsonb_build_object('create', public.platform_can('incidents', 'create'), 'edit', public.platform_can('incidents', 'edit'),
      'manage', public.platform_can('incidents', 'manage')));
end;
$$;

create or replace function public.platform_incident_get(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  i public.platform_incidents;
begin
  perform public._platform_require('incidents', 'view');
  select * into i from public.platform_incidents where id = p_id;
  if i.id is null then
    raise exception 'NOT_FOUND: incident not found' using errcode = 'P0002';
  end if;
  return public._platform_incident_json(i) || jsonb_build_object(
    'updates', (select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'kind', u.kind, 'body', u.body, 'data', u.data, 'actor', u.actor_email, 'created_at', u.created_at)
        order by u.id), '[]'::jsonb) from public.platform_incident_updates u where u.incident_id = i.id),
    'rule', (select jsonb_build_object('id', r.id, 'name', r.name) from public.platform_automation_rules r where r.id = i.rule_id));
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Announcements to merchants (in-app), with delivery and read tracking
-- -----------------------------------------------------------------------------
create table public.platform_announcements (
  id uuid primary key default gen_random_uuid(),
  number bigint generated always as identity unique,
  kind text not null check (kind in ('MAINTENANCE', 'FEATURE', 'SUBSCRIPTION', 'INTEGRATION', 'USAGE', 'RECHARGE', 'GENERAL')),
  severity text not null default 'INFO' check (severity in ('INFO', 'WARN', 'CRITICAL')),
  title text not null check (length(trim(title)) between 3 and 140),
  body text not null check (length(trim(body)) between 3 and 4000),
  link text check (link ~ '^(/admin|https://)'),
  -- {"type": "ALL" | "PLANS" | "STATUSES" | "MERCHANTS", "plans": [...], "statuses": [...], "merchants": [...], "include_demo": bool}
  audience jsonb not null default '{"type": "ALL"}'::jsonb,
  status text not null default 'DRAFT' check (status in ('DRAFT', 'SCHEDULED', 'SENT', 'CANCELLED')),
  publish_at timestamptz,
  expires_at timestamptz,
  sent_at timestamptz,
  recipients int,
  source text not null default 'MANUAL' check (source in ('MANUAL', 'AUTOMATION', 'INCIDENT')),
  incident_id uuid references public.platform_incidents(id),
  rule_id uuid,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expires_at is null or publish_at is null or expires_at > publish_at)
);
create trigger platform_announcements_updated_at before update on public.platform_announcements for each row execute function public.set_updated_at();

create table public.platform_announcement_deliveries (
  announcement_id uuid not null references public.platform_announcements(id),
  merchant_id uuid not null references public.merchants(id),
  -- MUTED: the merchant turned this optional kind off.
  status text not null check (status in ('DELIVERED', 'MUTED')),
  delivered_at timestamptz not null default now(),
  first_read_at timestamptz,
  readers int not null default 0,
  primary key (announcement_id, merchant_id)
);
create index platform_announcement_deliveries_merchant_idx on public.platform_announcement_deliveries (merchant_id, delivered_at desc);

create table public.platform_announcement_reads (
  announcement_id uuid not null references public.platform_announcements(id),
  profile_id uuid not null,
  merchant_id uuid not null references public.merchants(id),
  read_at timestamptz not null default now(),
  primary key (announcement_id, profile_id)
);
alter table public.platform_announcements enable row level security;
alter table public.platform_announcement_deliveries enable row level security;
alter table public.platform_announcement_reads enable row level security;
revoke all on public.platform_announcements, public.platform_announcement_deliveries, public.platform_announcement_reads from anon, authenticated;

-- Kinds a merchant may turn off; service notices (maintenance, billing,
-- integration problems, usage limits) always reach them.
create or replace function public._announcement_optional_kinds()
returns text[]
language sql
immutable
as $$
  select array['FEATURE', 'GENERAL', 'RECHARGE']
$$;

create or replace function public._platform_announcement_audience(p_audience jsonb)
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.id from public.merchants m
  where m.status in ('ONBOARDING', 'ACTIVE', 'SUSPENDED')
    and (coalesce((p_audience ->> 'include_demo')::boolean, false) or not m.is_demo or p_audience ->> 'type' = 'MERCHANTS')
    and case coalesce(p_audience ->> 'type', 'ALL')
      when 'ALL' then true
      when 'MERCHANTS' then m.id::text in (select jsonb_array_elements_text(coalesce(p_audience -> 'merchants', '[]'::jsonb)))
      when 'STATUSES' then m.status in (select jsonb_array_elements_text(coalesce(p_audience -> 'statuses', '[]'::jsonb)))
        or exists (select 1 from public.subscriptions s where s.merchant_id = m.id and s.ended_at is null
                   and s.status in (select jsonb_array_elements_text(coalesce(p_audience -> 'statuses', '[]'::jsonb))))
      when 'PLANS' then exists (select 1 from public.subscriptions s join public.plans p on p.id = s.plan_id
                                where s.merchant_id = m.id and s.ended_at is null and p.code in (select jsonb_array_elements_text(coalesce(p_audience -> 'plans', '[]'::jsonb))))
      else false end
$$;

create or replace function public._platform_announcement_validate(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_type text := upper(coalesce(p #>> '{audience,type}', 'ALL'));
begin
  if upper(coalesce(p ->> 'kind', '')) not in ('MAINTENANCE', 'FEATURE', 'SUBSCRIPTION', 'INTEGRATION', 'USAGE', 'RECHARGE', 'GENERAL') then
    raise exception 'VALIDATION: choose what kind of announcement it is' using errcode = '22023';
  end if;
  if upper(coalesce(p ->> 'severity', 'INFO')) not in ('INFO', 'WARN', 'CRITICAL') then
    raise exception 'VALIDATION: unknown importance' using errcode = '22023';
  end if;
  if length(trim(coalesce(p ->> 'title', ''))) < 3 or length(trim(coalesce(p ->> 'body', ''))) < 3 then
    raise exception 'VALIDATION: write a title and a message' using errcode = '22023';
  end if;
  if v_type not in ('ALL', 'PLANS', 'STATUSES', 'MERCHANTS') then
    raise exception 'VALIDATION: choose who gets it' using errcode = '22023';
  end if;
  if v_type <> 'ALL' and jsonb_array_length(coalesce(p -> 'audience' -> lower(v_type), '[]'::jsonb)) = 0 then
    raise exception 'VALIDATION: choose at least one %', lower(rtrim(v_type, 'S')) using errcode = '22023';
  end if;
  if nullif(p ->> 'link', '') is not null and p ->> 'link' !~ '^(/admin|https://)' then
    raise exception 'VALIDATION: links go to a page in the app (/admin/…) or an https:// address' using errcode = '22023';
  end if;
  return jsonb_build_object('type', v_type, 'plans', coalesce(p #> '{audience,plans}', '[]'::jsonb), 'statuses', coalesce(p #> '{audience,statuses}', '[]'::jsonb),
    'merchants', coalesce(p #> '{audience,merchants}', '[]'::jsonb), 'include_demo', coalesce((p #>> '{audience,include_demo}')::boolean, false));
end;
$$;

-- Who would get it (count and a sample), before anything is sent.
create or replace function public.platform_announcement_preview(p_audience jsonb, p_kind text default 'GENERAL')
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._platform_require('notifications', 'view');
  return (with a as (select id from public._platform_announcement_audience(p_audience) id),
    x as (select m.id, m.number, m.name,
            upper(p_kind) = any (public._announcement_optional_kinds())
            and upper(p_kind) in (select jsonb_array_elements_text(coalesce((select s.value -> 'muted' from public.settings s
                                    where s.merchant_id = m.id and s.key = 'announcements'), '[]'::jsonb))) as muted
          from public.merchants m join a on a.id = m.id)
    select jsonb_build_object('count', (select count(*) from x), 'muted', (select count(*) from x where muted),
      'sample', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'number', number, 'name', name, 'muted', muted) order by number), '[]'::jsonb)
                 from (select * from x order by number limit 50) s)));
end;
$$;

create or replace function public._platform_announcement_deliver(a public.platform_announcements)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n int;
begin
  insert into public.platform_announcement_deliveries (announcement_id, merchant_id, status)
  select a.id, m.id,
    case when a.kind = any (public._announcement_optional_kinds())
          and a.kind in (select jsonb_array_elements_text(coalesce((select s.value -> 'muted' from public.settings s
                           where s.merchant_id = m.id and s.key = 'announcements'), '[]'::jsonb)))
         then 'MUTED' else 'DELIVERED' end
  from public._platform_announcement_audience(a.audience) m(id)
  on conflict do nothing;
  get diagnostics v_n = row_count;
  update public.platform_announcements set status = 'SENT', sent_at = now(),
    recipients = (select count(*) from public.platform_announcement_deliveries where announcement_id = a.id and status = 'DELIVERED')
  where id = a.id;
  return v_n;
end;
$$;

create or replace function public.platform_announcement_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_aud jsonb;
  a public.platform_announcements;
begin
  perform public._platform_require('notifications', 'create');
  v_aud := public._platform_announcement_validate(p);
  if nullif(p ->> 'id', '') is null then
    insert into public.platform_announcements (kind, severity, title, body, link, audience, publish_at, expires_at, incident_id, created_by)
    values (upper(p ->> 'kind'), upper(coalesce(p ->> 'severity', 'INFO')), trim(p ->> 'title'), trim(p ->> 'body'), nullif(p ->> 'link', ''), v_aud,
            nullif(p ->> 'publish_at', '')::timestamptz, nullif(p ->> 'expires_at', '')::timestamptz, nullif(p ->> 'incident_id', '')::uuid, auth.uid())
    returning * into a;
  else
    update public.platform_announcements set kind = upper(p ->> 'kind'), severity = upper(coalesce(p ->> 'severity', 'INFO')), title = trim(p ->> 'title'),
      body = trim(p ->> 'body'), link = nullif(p ->> 'link', ''), audience = v_aud, publish_at = nullif(p ->> 'publish_at', '')::timestamptz,
      expires_at = nullif(p ->> 'expires_at', '')::timestamptz
    where id = (p ->> 'id')::uuid and status = 'DRAFT' returning * into a;
    if a.id is null then
      raise exception 'VALIDATION: only drafts can be changed' using errcode = '22023';
    end if;
  end if;
  return to_jsonb(a);
end;
$$;

-- Sends (or schedules) a draft. p_expected is the audience size the sender
-- saw in the preview; if it changed, they must look again.
create or replace function public.platform_announcement_send(p_id uuid, p_expected int, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a public.platform_announcements;
  v_count int;
  v_n int := 0;
begin
  perform public._platform_require('notifications', 'manage');
  select * into a from public.platform_announcements where id = p_id for update;
  if a.id is null or a.status <> 'DRAFT' then
    raise exception 'VALIDATION: only a draft can be sent' using errcode = '22023';
  end if;
  select count(*) into v_count from public._platform_announcement_audience(a.audience);
  if v_count <> coalesce(p_expected, -1) then
    raise exception 'VALIDATION: the audience is now % merchant(s), not % — preview it again before sending', v_count, coalesce(p_expected, 0) using errcode = '22023';
  end if;
  if v_count = 0 then
    raise exception 'VALIDATION: nobody matches this audience' using errcode = '22023';
  end if;
  if a.publish_at is not null and a.publish_at > now() + interval '1 minute' then
    update public.platform_announcements set status = 'SCHEDULED' where id = a.id returning * into a;
  else
    v_n := public._platform_announcement_deliver(a);
    select * into a from public.platform_announcements where id = p_id;
  end if;
  perform public._platform_log('notifications.announcement_sent', null, 'platform_announcement', a.id::text, p_reason, null,
    jsonb_build_object('title', a.title, 'kind', a.kind, 'audience', a.audience, 'merchants', v_count, 'status', a.status, 'publish_at', a.publish_at));
  return to_jsonb(a) || jsonb_build_object('delivered', v_n);
end;
$$;

create or replace function public.platform_announcement_cancel(p_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a public.platform_announcements;
begin
  perform public._platform_require('notifications', 'manage');
  if length(trim(coalesce(p_reason, ''))) < 5 then
    raise exception 'VALIDATION: say why it is withdrawn' using errcode = '22023';
  end if;
  update public.platform_announcements set status = 'CANCELLED' where id = p_id and status <> 'CANCELLED' returning * into a;
  if a.id is null then
    raise exception 'NOT_FOUND: announcement not found' using errcode = 'P0002';
  end if;
  perform public._platform_log('notifications.announcement_withdrawn', null, 'platform_announcement', a.id::text, trim(p_reason), null, jsonb_build_object('title', a.title));
  return to_jsonb(a);
end;
$$;

create or replace function public.platform_announcements_list(p_limit int default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._platform_require('notifications', 'view');
  return jsonb_build_object(
    'rows', (select coalesce(jsonb_agg(to_jsonb(a) || jsonb_build_object(
        'delivered', (select count(*) from public.platform_announcement_deliveries d where d.announcement_id = a.id and d.status = 'DELIVERED'),
        'muted', (select count(*) from public.platform_announcement_deliveries d where d.announcement_id = a.id and d.status = 'MUTED'),
        'read_merchants', (select count(*) from public.platform_announcement_deliveries d where d.announcement_id = a.id and d.first_read_at is not null),
        'readers', (select count(*) from public.platform_announcement_reads r where r.announcement_id = a.id),
        'created_by_email', (select email from public.platform_staff where user_id = a.created_by)) order by a.created_at desc), '[]'::jsonb)
      from (select * from public.platform_announcements order by created_at desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) a),
    'plans', (select coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name) order by sort_order), '[]'::jsonb) from public.plans where status = 'ACTIVE'),
    'optional_kinds', to_jsonb(public._announcement_optional_kinds()),
    'can', jsonb_build_object('create', public.platform_can('notifications', 'create'), 'manage', public.platform_can('notifications', 'manage')));
end;
$$;

create or replace function public.platform_announcement_get(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._platform_require('notifications', 'view');
  return (select to_jsonb(a) || jsonb_build_object(
      'deliveries', (select coalesce(jsonb_agg(jsonb_build_object('merchant', jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name),
          'status', d.status, 'delivered_at', d.delivered_at, 'first_read_at', d.first_read_at, 'readers', d.readers) order by d.first_read_at nulls last, m.number), '[]'::jsonb)
        from public.platform_announcement_deliveries d join public.merchants m on m.id = d.merchant_id where d.announcement_id = a.id))
    from public.platform_announcements a where a.id = p_id);
end;
$$;

-- The merchant side: what the platform sent this business, and preferences.
create or replace function public.my_announcements()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_merchant uuid := public.current_merchant_id();
begin
  if not public.is_staff() then
    raise exception 'PERMISSION_DENIED: staff only' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'items', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'kind', a.kind, 'severity', a.severity, 'title', a.title, 'body', a.body, 'link', a.link,
        'sent_at', coalesce(a.sent_at, d.delivered_at), 'expires_at', a.expires_at,
        'read', exists (select 1 from public.platform_announcement_reads r where r.announcement_id = a.id and r.profile_id = auth.uid()))
        order by coalesce(a.sent_at, d.delivered_at) desc), '[]'::jsonb)
      from public.platform_announcement_deliveries d join public.platform_announcements a on a.id = d.announcement_id
      where d.merchant_id = v_merchant and d.status = 'DELIVERED' and a.status = 'SENT' and (a.expires_at is null or a.expires_at > now())
        and coalesce(a.sent_at, d.delivered_at) > now() - interval '90 days'),
    'muted', coalesce((select value -> 'muted' from public.settings where merchant_id = v_merchant and key = 'announcements'), '[]'::jsonb),
    'optional_kinds', to_jsonb(public._announcement_optional_kinds()));
end;
$$;

create or replace function public.announcement_mark_read(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_merchant uuid := public.current_merchant_id();
begin
  -- Support viewers only look; reading on the merchant's behalf is not recorded.
  if not public.is_staff() or public._support_session_id() is not null then
    return;
  end if;
  if not exists (select 1 from public.platform_announcement_deliveries where announcement_id = p_id and merchant_id = v_merchant and status = 'DELIVERED') then
    raise exception 'NOT_FOUND: announcement not found' using errcode = 'P0002';
  end if;
  insert into public.platform_announcement_reads (announcement_id, profile_id, merchant_id) values (p_id, auth.uid(), v_merchant)
  on conflict do nothing;
  if found then
    update public.platform_announcement_deliveries set first_read_at = coalesce(first_read_at, now()), readers = readers + 1
    where announcement_id = p_id and merchant_id = v_merchant;
  end if;
end;
$$;

create or replace function public.announcement_preferences_save(p_muted text[])
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_merchant uuid := public.current_merchant_id();
  v jsonb;
begin
  perform public.require_permission('settings.manage');
  if exists (select 1 from unnest(coalesce(p_muted, '{}')) k where k <> all (public._announcement_optional_kinds())) then
    raise exception 'VALIDATION: maintenance, billing, integration and usage notices cannot be turned off' using errcode = '22023';
  end if;
  v := jsonb_build_object('muted', to_jsonb(coalesce(p_muted, '{}')));
  insert into public.settings (merchant_id, key, value, is_public, description, updated_by) values (v_merchant, 'announcements', v, false, 'Platform announcements this business turned off', auth.uid())
  on conflict (merchant_id, key) do update set value = excluded.value, updated_by = auth.uid();
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Automation rules
-- -----------------------------------------------------------------------------
create table public.platform_automation_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 3 and 100),
  description text check (length(description) <= 500),
  trigger text not null check (trigger in ('integration_failures', 'payment_problems', 'onboarding_incomplete', 'usage_limit', 'ticket_overdue',
                                           'credentials_expiring', 'service_down')),
  conditions jsonb not null default '{}'::jsonb,
  actions jsonb not null default '[]'::jsonb check (jsonb_typeof(actions) = 'array'),
  enabled boolean not null default false,
  -- A subject (a merchant, a ticket…) is acted on at most once per cooldown.
  cooldown_minutes int not null default 1440 check (cooldown_minutes between 10 and 43200),
  max_actions_per_run int not null default 25 check (max_actions_per_run between 1 and 200),
  archived_at timestamptz,
  last_run_at timestamptz,
  last_result jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_by uuid,
  updated_at timestamptz not null default now()
);
create trigger platform_automation_rules_updated_at before update on public.platform_automation_rules for each row execute function public.set_updated_at();

create table public.platform_automation_runs (
  id bigint generated always as identity primary key,
  rule_id uuid not null references public.platform_automation_rules(id),
  subject_key text not null,
  merchant_id uuid references public.merchants(id),
  title text,
  status text not null check (status in ('ACTED', 'FAILED')),
  actions jsonb not null default '[]'::jsonb,
  error text,
  manual boolean not null default false,
  actor_id uuid,
  created_at timestamptz not null default now()
);
create index platform_automation_runs_rule_idx on public.platform_automation_runs (rule_id, subject_key, created_at desc);
create trigger platform_automation_runs_immutable before update or delete on public.platform_automation_runs
  for each row execute function public.prevent_mutation();
alter table public.platform_automation_rules enable row level security;
alter table public.platform_automation_runs enable row level security;
revoke all on public.platform_automation_rules, public.platform_automation_runs from anon, authenticated;

-- What each trigger means, its settings and which actions fit it.
create or replace function public._platform_automation_catalog()
returns jsonb
language sql
immutable
as $$
  select $c${
    "integration_failures": {"name": "Repeated integration failures", "subject": "merchant",
      "help": "A merchant's store connection is failing, or their server-side errors (webhooks, couriers, payments, jobs) reach the threshold.",
      "conditions": {"min_errors": 5, "hours": 24},
      "actions": ["notify_staff", "notify_account_manager", "create_incident", "notify_merchant"]},
    "payment_problems": {"name": "Payment problems", "subject": "merchant",
      "help": "A subscription is past due, or a payment failed or was rejected in the last hours.",
      "conditions": {"hours": 24},
      "actions": ["notify_staff", "notify_account_manager", "notify_merchant"]},
    "onboarding_incomplete": {"name": "Onboarding not finished", "subject": "merchant",
      "help": "A merchant created more than the given days ago has onboarding steps left.",
      "conditions": {"days": 3},
      "actions": ["notify_staff", "notify_account_manager", "notify_merchant"]},
    "usage_limit": {"name": "Usage limit reached", "subject": "merchant",
      "help": "SMS or BD Courier requests were refused for a merchant (no credits, monthly cap, free allowance used) in the last hours.",
      "conditions": {"hours": 24, "min_refused": 1},
      "actions": ["notify_staff", "notify_account_manager", "notify_merchant"]},
    "ticket_overdue": {"name": "Support ticket overdue", "subject": "ticket",
      "help": "An open ticket is past its due time (escalated tickets wait the cooldown before the next step).",
      "conditions": {"max_level": 3},
      "actions": ["escalate_ticket", "notify_staff"]},
    "credentials_expiring": {"name": "Credentials expiring", "subject": "credential",
      "help": "A merchant's connected account token (Meta Ads) expires within the given days.",
      "conditions": {"days": 7},
      "actions": ["notify_staff", "notify_account_manager", "notify_merchant"]},
    "service_down": {"name": "Platform service down", "subject": "service",
      "help": "The connected platform SMS or BD Courier account fails more often than it works (at least 3 attempts in the window), or the PBX gateway stopped checking in. An account that was never connected is a setup task shown under System Health, not an outage.",
      "conditions": {"minutes": 10},
      "actions": ["create_incident", "notify_staff"]}
  }$c$::jsonb
$$;

-- Subjects a rule matches right now (read-only).
create or replace function public._platform_automation_subjects(r public.platform_automation_rules)
returns table (subject_key text, merchant_id uuid, title text, detail text, ref jsonb)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  c jsonb := (public._platform_automation_catalog() -> r.trigger -> 'conditions') || coalesce(r.conditions, '{}'::jsonb);
  v_hours interval;
begin
  if r.trigger = 'integration_failures' then
    v_hours := make_interval(hours => greatest(1, (c ->> 'hours')::int));
    return query
      select 'merchant:' || m.id, m.id, format('Integration failures: #%s %s', m.number, m.name),
        concat_ws(' · ',
          case when x.stores > 0 then format('%s store connection(s) in error', x.stores) end,
          case when x.errors >= (c ->> 'min_errors')::int then format('%s errors in %s h', x.errors, c ->> 'hours') end),
        jsonb_build_object('stores', x.stores, 'errors', x.errors)
      from public.merchants m
      cross join lateral (select
          (select count(*) from public.sales_channels s where s.merchant_id = m.id and s.status = 'ERROR') as stores,
          (select coalesce(sum(l.occurrences), 0) from public.system_logs l where l.merchant_id = m.id and l.level = 'ERROR' and l.resolved_at is null
             and l.category in ('WEBHOOK', 'FUNCTION', 'COURIER', 'PAYMENT', 'JOB') and l.last_seen_at > now() - v_hours) as errors) x
      where m.status in ('ONBOARDING', 'ACTIVE') and (x.stores > 0 or x.errors >= (c ->> 'min_errors')::int);
  elsif r.trigger = 'payment_problems' then
    v_hours := make_interval(hours => greatest(1, (c ->> 'hours')::int));
    return query
      select 'merchant:' || m.id, m.id, format('Payment problem: #%s %s', m.number, m.name),
        concat_ws(' · ',
          case when s.status = 'PAST_DUE' then 'subscription past due' end,
          case when f.failed > 0 then format('%s failed payment(s) in %s h', f.failed, c ->> 'hours') end),
        jsonb_build_object('past_due', s.status = 'PAST_DUE', 'failed', f.failed)
      from public.merchants m
      left join public.subscriptions s on s.merchant_id = m.id and s.ended_at is null
      cross join lateral (select count(*) as failed from public.billing_payments p where p.merchant_id = m.id and p.status in ('FAILED', 'REJECTED')
                          and p.created_at > now() - v_hours) f
      where m.status <> 'CLOSED' and not m.is_demo and (s.status = 'PAST_DUE' or f.failed > 0);
  elsif r.trigger = 'onboarding_incomplete' then
    return query
      select 'merchant:' || m.id, m.id, format('Onboarding not finished: #%s %s', m.number, m.name),
        format('%s of %s steps done after %s days', o ->> 'done', o ->> 'total', extract(day from now() - m.created_at)::int), o
      from public.merchants m cross join lateral public._merchant_onboarding(m.id) o
      where m.status in ('ONBOARDING', 'ACTIVE') and not m.is_demo and m.created_at < now() - make_interval(days => greatest(1, (c ->> 'days')::int))
        and (o ->> 'done')::int < (o ->> 'total')::int;
  elsif r.trigger = 'usage_limit' then
    v_hours := make_interval(hours => greatest(1, (c ->> 'hours')::int));
    return query
      select 'merchant:' || m.id, m.id, format('Usage limit reached: #%s %s', m.number, m.name),
        (select string_agg(format('%s %s refused (%s)', n, replace(lower(service), '_', ' '), lower(replace(reason, '_', ' '))), ' · ')
           from (select u.service, u.denied_reason as reason, count(*) n from public.service_usage u where u.merchant_id = m.id and u.status = 'DENIED'
                   and u.denied_reason in ('NO_CREDITS', 'LIMIT_REACHED', 'FREE_LIMIT_REACHED') and u.created_at > now() - v_hours group by 1, 2) d),
        jsonb_build_object('refused', x.n)
      from public.merchants m
      cross join lateral (select count(*) as n from public.service_usage u where u.merchant_id = m.id and u.status = 'DENIED'
                          and u.denied_reason in ('NO_CREDITS', 'LIMIT_REACHED', 'FREE_LIMIT_REACHED') and u.created_at > now() - v_hours) x
      where m.status <> 'CLOSED' and x.n >= greatest(1, (c ->> 'min_refused')::int);
  elsif r.trigger = 'ticket_overdue' then
    -- The subject includes the level, so each escalation step happens once.
    return query
      select 'ticket:' || t.id || ':' || t.escalation_level, t.merchant_id, format('Ticket #%s overdue: %s', t.number, t.subject),
        format('%s priority, due %s', lower(t.priority), to_char(t.due_at at time zone 'Asia/Dhaka', 'DD Mon HH24:MI')),
        jsonb_build_object('ticket_id', t.id, 'level', t.escalation_level)
      from public.support_tickets t
      where t.status in ('OPEN', 'IN_PROGRESS') and t.due_at < now() and t.escalation_level < least(5, greatest(1, (c ->> 'max_level')::int))
        and (t.escalated_at is null or t.escalated_at < now() - make_interval(mins => r.cooldown_minutes));
  elsif r.trigger = 'credentials_expiring' then
    return query
      select 'meta:' || a.id, a.merchant_id, format('Meta Ads access expiring: #%s %s', m.number, m.name),
        format('%s expires %s', coalesce(a.meta_name, a.name), to_char(a.token_expires_at at time zone 'Asia/Dhaka', 'DD Mon')),
        jsonb_build_object('account', a.id, 'expires_at', a.token_expires_at)
      from public.meta_ad_accounts a join public.merchants m on m.id = a.merchant_id
      where a.is_active and a.token_hint is not null and a.token_expires_at is not null
        and a.token_expires_at < now() + make_interval(days => greatest(1, (c ->> 'days')::int)) and m.status <> 'CLOSED';
  elsif r.trigger = 'service_down' then
    return query
      select 'service:sms', null::uuid, 'Platform SMS is failing',
        format('%s of %s messages failed in the last %s minutes', x.failed, x.total, c ->> 'minutes'), jsonb_build_object('failed', x.failed, 'total', x.total)
      from public.platform_settings s
      cross join lateral (select count(*) filter (where u.status = 'FAILED') as failed, count(*) filter (where u.status in ('FAILED', 'SUCCEEDED')) as total
                          from public.service_usage u where u.service = 'SMS' and u.created_at > now() - make_interval(mins => (c ->> 'minutes')::int)) x
      where s.key = 'sms' and coalesce((s.value ->> 'connected')::boolean, false) and x.total >= 3 and x.failed * 2 > x.total
      union all
      select 'service:bd_courier', null::uuid, 'Platform BD Courier is failing',
        format('%s of %s lookups failed in the last %s minutes', x.failed, x.total, c ->> 'minutes'), jsonb_build_object('failed', x.failed, 'total', x.total)
      from public.platform_settings s
      cross join lateral (select count(*) filter (where u.status = 'FAILED') as failed, count(*) filter (where u.status in ('FAILED', 'SUCCEEDED')) as total
                          from public.service_usage u where u.service = 'BD_COURIER' and u.created_at > now() - make_interval(mins => (c ->> 'minutes')::int)) x
      where s.key = 'bd_courier' and coalesce((s.value ->> 'connected')::boolean, false) and x.total >= 3 and x.failed * 2 > x.total
      union all
      select 'service:pbx_gateway', null::uuid, 'VoiceDrive PBX gateway stopped checking in',
        'Last check-in ' || to_char(g.last_seen_at at time zone 'Asia/Dhaka', 'DD Mon HH24:MI'), '{}'::jsonb
      from public.pbx_gateway_status g
      where g.last_seen_at is not null and g.last_seen_at < now() - make_interval(mins => (c ->> 'minutes')::int)
        and exists (select 1 from public.pbx_businesses b where b.pbx_enabled);
  end if;
end;
$$;

-- Does what the rule says for one subject. Returns what was done.
create or replace function public._platform_automation_act(r public.platform_automation_rules, s jsonb, p_run bigint)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key text := s ->> 'subject_key';
  v_merchant uuid := nullif(s ->> 'merchant_id', '')::uuid;
  v_title text := s ->> 'title';
  v_detail text := s ->> 'detail';
  v_ref jsonb := coalesce(s -> 'ref', '{}'::jsonb);
  a jsonb;
  v_done jsonb := '[]'::jsonb;
  v_n int;
  v_link text := case when nullif(s ->> 'merchant_id', '') is not null then '/super-admin/merchants/' || (s ->> 'merchant_id') else '/super-admin/health' end;
  v_mgr uuid;
  t public.support_tickets;
  i public.platform_incidents;
  ann public.platform_announcements;
begin
  for a in select * from jsonb_array_elements(r.actions) loop
    case a ->> 'type'
      when 'notify_staff' then
        v_n := public._platform_notify(coalesce(a ->> 'module', 'health'), coalesce(a ->> 'action', 'view'), v_merchant, 'automation.' || r.trigger,
          coalesce(a ->> 'severity', 'WARN'), v_title, v_detail,
          case when v_ref ? 'ticket_id' then '/super-admin/support?ticket=' || (v_ref ->> 'ticket_id') else v_link end,
          format('auto:%s:%s:%s', r.id, v_key, p_run));
        v_done := v_done || jsonb_build_object('type', 'notify_staff', 'notified', v_n);
      when 'notify_account_manager' then
        select account_manager_id into v_mgr from public.merchants where id = v_merchant;
        v_n := case when v_mgr is null then 0 else public._platform_notify('merchants', 'view', v_merchant, 'automation.' || r.trigger, coalesce(a ->> 'severity', 'WARN'),
          v_title, v_detail, v_link, format('auto:%s:%s:%s:am', r.id, v_key, p_run), array[v_mgr]) end;
        v_done := v_done || jsonb_build_object('type', 'notify_account_manager', 'notified', v_n);
      when 'escalate_ticket' then
        select * into t from public.support_tickets where id = (v_ref ->> 'ticket_id')::uuid;
        if t.id is not null and t.status in ('OPEN', 'IN_PROGRESS') then
          t := public._platform_ticket_escalate(t, 'Overdue — escalated by the rule "' || r.name || '"', true);
          v_done := v_done || jsonb_build_object('type', 'escalate_ticket', 'level', t.escalation_level, 'priority', t.priority);
        end if;
      when 'create_incident' then
        i := public._platform_incident_open(jsonb_build_object('title', v_title, 'description', v_detail || E'\nOpened by the automation rule "' || r.name || '".',
               'severity', coalesce(a ->> 'severity', 'HIGH'), 'integration', case when v_key like 'service:%' then
                 case split_part(v_key, ':', 2) when 'pbx_gateway' then 'pbx' else split_part(v_key, ':', 2) end end,
               'scope', case when v_merchant is null then 'ALL' else 'SELECTED' end,
               'merchants', case when v_merchant is null then '[]'::jsonb else jsonb_build_array(v_merchant) end),
             'AUTOMATION', r.id, format('auto:%s:%s', r.id, v_key));
        v_done := v_done || jsonb_build_object('type', 'create_incident', 'incident', i.number);
      when 'notify_merchant' then
        if v_merchant is not null then
          insert into public.platform_announcements (kind, severity, title, body, link, audience, source, rule_id)
          values (coalesce(a ->> 'kind', case r.trigger when 'usage_limit' then 'USAGE' when 'payment_problems' then 'SUBSCRIPTION'
                    when 'onboarding_incomplete' then 'GENERAL' else 'INTEGRATION' end),
                  coalesce(a ->> 'severity', 'WARN'), left(coalesce(nullif(a ->> 'title', ''), v_title), 140),
                  left(coalesce(nullif(a ->> 'body', ''), v_detail, v_title), 4000), nullif(a ->> 'link', ''),
                  jsonb_build_object('type', 'MERCHANTS', 'merchants', jsonb_build_array(v_merchant), 'include_demo', true), 'AUTOMATION', r.id)
          returning * into ann;
          v_n := public._platform_announcement_deliver(ann);
          v_done := v_done || jsonb_build_object('type', 'notify_merchant', 'announcement', ann.number, 'delivered', v_n);
        end if;
      else
        raise exception 'unknown action %', a ->> 'type';
    end case;
  end loop;
  return v_done;
end;
$$;

-- Runs one rule or every enabled rule. Called every 10 minutes by the ops job,
-- or by an employee with automation manage access ("Run now").
create or replace function public.platform_automation_run(p_rule uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.platform_automation_rules;
  s record;
  v_out jsonb := '[]'::jsonb;
  v_acted int;
  v_failed int;
  v_skipped int;
  v_run bigint;
  v_done jsonb;
  v_manual boolean := not public.is_system_context();
begin
  if v_manual then
    perform public._platform_require('automation', 'manage');
  end if;
  for r in select * from public.platform_automation_rules x
           where x.archived_at is null and (p_rule is null and x.enabled or x.id = p_rule) order by x.created_at loop
    -- Two runs of one rule never overlap.
    if not pg_try_advisory_xact_lock(hashtextextended('automation:' || r.id, 0)) then
      v_out := v_out || jsonb_build_object('rule', r.id, 'skipped', 'already running');
      continue;
    end if;
    v_acted := 0; v_failed := 0; v_skipped := 0;
    for s in select * from public._platform_automation_subjects(r) loop
      -- Once per subject per cooldown, whatever happened last time.
      if exists (select 1 from public.platform_automation_runs x where x.rule_id = r.id and x.subject_key = s.subject_key
                 and x.created_at > now() - make_interval(mins => r.cooldown_minutes)) then
        v_skipped := v_skipped + 1;
        continue;
      end if;
      if v_acted + v_failed >= r.max_actions_per_run then
        v_skipped := v_skipped + 1;
        continue;
      end if;
      select coalesce(max(id), 0) + 1 into v_run from public.platform_automation_runs;
      begin
        v_done := public._platform_automation_act(r, to_jsonb(s), v_run);
        insert into public.platform_automation_runs (rule_id, subject_key, merchant_id, title, status, actions, manual, actor_id)
        values (r.id, s.subject_key, s.merchant_id, s.title, 'ACTED', v_done, v_manual, auth.uid());
        v_acted := v_acted + 1;
      exception when others then
        insert into public.platform_automation_runs (rule_id, subject_key, merchant_id, title, status, error, manual, actor_id)
        values (r.id, s.subject_key, s.merchant_id, s.title, 'FAILED', left(sqlerrm, 1000), v_manual, auth.uid());
        v_failed := v_failed + 1;
      end;
    end loop;
    update public.platform_automation_rules set last_run_at = now(),
      last_result = jsonb_build_object('acted', v_acted, 'failed', v_failed, 'skipped', v_skipped, 'manual', v_manual)
    where id = r.id;
    v_out := v_out || jsonb_build_object('rule', r.id, 'name', r.name, 'acted', v_acted, 'failed', v_failed, 'skipped', v_skipped);
  end loop;
  if v_manual then
    perform public._platform_log('automation.run', null, 'automation_rule', p_rule::text, null, null, jsonb_build_object('results', v_out));
  end if;
  return v_out;
end;
$$;

create or replace function public._platform_automation_validate(p jsonb)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_cat jsonb := public._platform_automation_catalog() -> (p ->> 'trigger');
  a jsonb;
  k text;
begin
  if v_cat is null then
    raise exception 'VALIDATION: choose what the rule watches' using errcode = '22023';
  end if;
  if length(trim(coalesce(p ->> 'name', ''))) < 3 then
    raise exception 'VALIDATION: give the rule a name' using errcode = '22023';
  end if;
  for k in select jsonb_object_keys(coalesce(p -> 'conditions', '{}'::jsonb)) loop
    if not (v_cat -> 'conditions' ? k) or jsonb_typeof(p -> 'conditions' -> k) <> 'number' or (p -> 'conditions' ->> k)::numeric < 0 then
      raise exception 'VALIDATION: % is not a setting of this rule (or not a number)', k using errcode = '22023';
    end if;
  end loop;
  if jsonb_typeof(coalesce(p -> 'actions', '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p -> 'actions', '[]'::jsonb)) = 0 then
    raise exception 'VALIDATION: add at least one action' using errcode = '22023';
  end if;
  for a in select * from jsonb_array_elements(p -> 'actions') loop
    if not (v_cat -> 'actions' ? (a ->> 'type')) then
      raise exception 'VALIDATION: "%" does not fit this rule', a ->> 'type' using errcode = '22023';
    end if;
    if a ->> 'type' = 'notify_staff' and not exists (select 1 from public.platform_modules m where m.code = coalesce(a ->> 'module', 'health')
         and coalesce(a ->> 'action', 'view') = any (m.actions)) then
      raise exception 'VALIDATION: choose who is notified (a section and access level that exist)' using errcode = '22023';
    end if;
    if coalesce(a ->> 'severity', 'WARN') not in ('INFO', 'WARN', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW') then
      raise exception 'VALIDATION: unknown importance' using errcode = '22023';
    end if;
  end loop;
  if coalesce((p ->> 'cooldown_minutes')::int, 1440) not between 10 and 43200 or coalesce((p ->> 'max_actions_per_run')::int, 25) not between 1 and 200 then
    raise exception 'VALIDATION: the cooldown is 10 minutes to 30 days, and a run acts on 1–200 subjects' using errcode = '22023';
  end if;
end;
$$;

create or replace function public.platform_automation_rule_save(p jsonb, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.platform_automation_rules;
  v_before jsonb;
  v_id uuid := nullif(p ->> 'id', '')::uuid;
begin
  perform public._platform_require('automation', case when v_id is null then 'create' else 'edit' end);
  perform public._platform_automation_validate(p);
  -- Rules that act on their own need manage access to switch on.
  if coalesce((p ->> 'enabled')::boolean, false) then
    perform public._platform_require('automation', 'manage');
  end if;
  if v_id is null then
    insert into public.platform_automation_rules (name, description, trigger, conditions, actions, enabled, cooldown_minutes, max_actions_per_run, created_by, updated_by)
    values (trim(p ->> 'name'), nullif(trim(coalesce(p ->> 'description', '')), ''), p ->> 'trigger', coalesce(p -> 'conditions', '{}'::jsonb), p -> 'actions',
            coalesce((p ->> 'enabled')::boolean, false), coalesce((p ->> 'cooldown_minutes')::int, 1440), coalesce((p ->> 'max_actions_per_run')::int, 25), auth.uid(), auth.uid())
    returning * into r;
  else
    select to_jsonb(x) into v_before from public.platform_automation_rules x where id = v_id and archived_at is null;
    if v_before is null then
      raise exception 'NOT_FOUND: rule not found' using errcode = 'P0002';
    end if;
    if (v_before ->> 'enabled')::boolean and not coalesce((p ->> 'enabled')::boolean, false) then
      perform public._platform_require('automation', 'manage');
    end if;
    update public.platform_automation_rules set name = trim(p ->> 'name'), description = nullif(trim(coalesce(p ->> 'description', '')), ''), trigger = p ->> 'trigger',
      conditions = coalesce(p -> 'conditions', '{}'::jsonb), actions = p -> 'actions', enabled = coalesce((p ->> 'enabled')::boolean, false),
      cooldown_minutes = coalesce((p ->> 'cooldown_minutes')::int, cooldown_minutes), max_actions_per_run = coalesce((p ->> 'max_actions_per_run')::int, max_actions_per_run),
      updated_by = auth.uid()
    where id = v_id returning * into r;
  end if;
  perform public._config_version('automation_rule', r.id::text, to_jsonb(r) - 'last_run_at' - 'last_result', p_reason);
  perform public._platform_log(case when v_id is null then 'automation.rule_created' else 'automation.rule_changed' end, null, 'automation_rule', r.id::text, p_reason,
    v_before - 'last_run_at' - 'last_result', to_jsonb(r) - 'last_run_at' - 'last_result');
  return to_jsonb(r);
end;
$$;

create or replace function public.platform_automation_rule_archive(p_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.platform_automation_rules;
begin
  perform public._platform_require('automation', 'delete');
  if length(trim(coalesce(p_reason, ''))) < 5 then
    raise exception 'VALIDATION: say why the rule is removed' using errcode = '22023';
  end if;
  -- Kept (switched off) so its run log stays readable.
  update public.platform_automation_rules set archived_at = now(), enabled = false, updated_by = auth.uid()
  where id = p_id and archived_at is null returning * into r;
  if r.id is null then
    raise exception 'NOT_FOUND: rule not found' using errcode = 'P0002';
  end if;
  perform public._platform_log('automation.rule_removed', null, 'automation_rule', r.id::text, trim(p_reason), null, jsonb_build_object('name', r.name));
  return to_jsonb(r);
end;
$$;

-- A dry run: what the rule (saved or a draft) would act on now. Changes nothing.
create or replace function public.platform_automation_test(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  r public.platform_automation_rules;
begin
  perform public._platform_require('automation', 'view');
  if nullif(p ->> 'id', '') is not null and p ->> 'trigger' is null then
    select * into r from public.platform_automation_rules where id = (p ->> 'id')::uuid;
  else
    perform public._platform_automation_validate(p);
    r := jsonb_populate_record(null::public.platform_automation_rules, jsonb_build_object('id', coalesce(nullif(p ->> 'id', '')::uuid, gen_random_uuid()),
      'name', p ->> 'name', 'trigger', p ->> 'trigger', 'conditions', coalesce(p -> 'conditions', '{}'::jsonb), 'actions', p -> 'actions',
      'cooldown_minutes', coalesce((p ->> 'cooldown_minutes')::int, 1440), 'max_actions_per_run', coalesce((p ->> 'max_actions_per_run')::int, 25)));
  end if;
  if r.trigger is null then
    raise exception 'NOT_FOUND: rule not found' using errcode = 'P0002';
  end if;
  return (with s as (select * from public._platform_automation_subjects(r))
    select jsonb_build_object(
      'matches', (select count(*) from s),
      'would_act', (select count(*) from (select 1 from s where not exists (select 1 from public.platform_automation_runs x where x.rule_id = r.id
                      and x.subject_key = s.subject_key and x.created_at > now() - make_interval(mins => r.cooldown_minutes)) limit r.max_actions_per_run) q),
      'subjects', (select coalesce(jsonb_agg(jsonb_build_object('key', s.subject_key, 'title', s.title, 'detail', s.detail,
          'in_cooldown', exists (select 1 from public.platform_automation_runs x where x.rule_id = r.id and x.subject_key = s.subject_key
                                 and x.created_at > now() - make_interval(mins => r.cooldown_minutes)))), '[]'::jsonb)
        from (select * from s limit 50) s),
      'actions', r.actions));
end;
$$;

create or replace function public.platform_automation_rules_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._platform_require('automation', 'view');
  return jsonb_build_object(
    'rules', (select coalesce(jsonb_agg(to_jsonb(r) || jsonb_build_object(
        'runs_7d', (select count(*) from public.platform_automation_runs x where x.rule_id = r.id and x.created_at > now() - interval '7 days'),
        'failed_7d', (select count(*) from public.platform_automation_runs x where x.rule_id = r.id and x.status = 'FAILED' and x.created_at > now() - interval '7 days'))
        order by r.created_at), '[]'::jsonb)
      from public.platform_automation_rules r where r.archived_at is null),
    'catalog', public._platform_automation_catalog(),
    'modules', (select jsonb_agg(jsonb_build_object('code', code, 'name', name, 'actions', actions) order by sort_order) from public.platform_modules),
    'can', jsonb_build_object('create', public.platform_can('automation', 'create'), 'edit', public.platform_can('automation', 'edit'),
      'delete', public.platform_can('automation', 'delete'), 'manage', public.platform_can('automation', 'manage')));
end;
$$;

create or replace function public.platform_automation_runs_list(p_rule uuid default null, p_limit int default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._platform_require('automation', 'view');
  return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'rule', jsonb_build_object('id', r.id, 'name', r.name), 'subject', x.subject_key, 'title', x.title,
      'merchant', (select jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name) from public.merchants m where m.id = x.merchant_id),
      'status', x.status, 'actions', x.actions, 'error', x.error, 'manual', x.manual, 'created_at', x.created_at) order by x.id desc)
    from (select * from public.platform_automation_runs where p_rule is null or rule_id = p_rule order by id desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) x
    join public.platform_automation_rules r on r.id = x.rule_id), '[]'::jsonb);
end;
$$;

-- Starting rules. Rules that message merchants start switched off.
insert into public.platform_automation_rules (name, description, trigger, conditions, actions, enabled, cooldown_minutes) values
  ('Escalate overdue tickets', 'Raise an overdue ticket one step and tell the support managers.', 'ticket_overdue', '{"max_level": 3}',
   '[{"type": "escalate_ticket"}]', true, 240),
  ('Repeated integration failures → technical support', 'Tell technical support when a merchant''s integrations keep failing.', 'integration_failures',
   '{"min_errors": 5, "hours": 24}', '[{"type": "notify_staff", "module": "integrations", "action": "edit", "severity": "WARN"}, {"type": "notify_account_manager"}]', true, 1440),
  ('Payment problems → billing', 'Tell billing staff about past-due subscriptions and failed payments.', 'payment_problems', '{"hours": 24}',
   '[{"type": "notify_staff", "module": "subscriptions", "action": "manage", "severity": "WARN"}]', true, 1440),
  ('Onboarding reminder', 'Remind merchants who have not finished setting up (in-app).', 'onboarding_incomplete', '{"days": 3}',
   '[{"type": "notify_merchant", "kind": "GENERAL", "severity": "INFO", "title": "Finish setting up your store", "body": "A few setup steps are still open. Finish them to start taking orders smoothly — or reply to our support team if you need help.", "link": "/admin"}, {"type": "notify_account_manager", "severity": "INFO"}]',
   false, 4320),
  ('Usage limit reached', 'Tell the merchant (in-app) and their account manager when SMS or BD Courier requests are refused.', 'usage_limit', '{"hours": 24, "min_refused": 1}',
   '[{"type": "notify_merchant", "kind": "USAGE", "severity": "WARN", "title": "A usage limit was reached", "body": "Some SMS or courier history checks could not run because a limit or your credits ran out. Recharge or check your plan under Plan & Billing.", "link": "/admin/settings/billing"}, {"type": "notify_account_manager", "severity": "INFO"}]',
   false, 1440),
  ('Credentials expiring', 'Tell the merchant''s account manager and marketing support when a connected Meta account is about to expire.', 'credentials_expiring', '{"days": 7}',
   '[{"type": "notify_staff", "module": "integrations", "action": "edit", "severity": "WARN"}, {"type": "notify_account_manager"}]', true, 1440),
  ('Platform service down → incident', 'Open an incident when the platform SMS, BD Courier or PBX gateway stops working.', 'service_down', '{"minutes": 10}',
   '[{"type": "create_incident", "severity": "HIGH"}, {"type": "notify_staff", "module": "health", "action": "manage", "severity": "CRITICAL"}]', true, 60);

-- -----------------------------------------------------------------------------
-- 5. The operations job (every 10 minutes)
-- -----------------------------------------------------------------------------
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
  return jsonb_build_object('support_sessions_closed', v_sessions, 'announcements_published', v_published, 'automation', v_auto);
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('platform-ops', '*/10 * * * *', 'select public.platform_ops_run()');
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 6. Grants, global tables, exemptions
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
               'platform_announcement_deliveries', 'platform_announcement_reads', 'platform_automation_rules', 'platform_automation_runs']
$$;

do $$
declare
  f text;
begin
  foreach f in array array['platform_health()', 'platform_system_logs(jsonb,integer,integer)', 'platform_system_logs_resolve(bigint[],text)',
    'platform_health_retry(text,boolean,text)', 'platform_incident_create(jsonb)', 'platform_incident_update(uuid,jsonb)', 'platform_incident_note(uuid,text)',
    'platform_incidents_list(jsonb)', 'platform_incident_get(uuid)', 'platform_announcement_preview(jsonb,text)', 'platform_announcement_save(jsonb)',
    'platform_announcement_send(uuid,integer,text)', 'platform_announcement_cancel(uuid,text)', 'platform_announcements_list(integer)',
    'platform_announcement_get(uuid)', 'my_announcements()', 'announcement_mark_read(uuid)', 'announcement_preferences_save(text[])',
    'platform_automation_run(uuid)', 'platform_automation_rule_save(jsonb,text)', 'platform_automation_rule_archive(uuid,text)',
    'platform_automation_test(jsonb)', 'platform_automation_rules_list()', 'platform_automation_runs_list(uuid,integer)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['_platform_incident_sync_health()', '_platform_incident_update(uuid,text,text,jsonb)', '_platform_incident_json(public.platform_incidents)',
    '_platform_incident_open(jsonb,text,uuid,text)', '_platform_announcement_audience(jsonb)', '_platform_announcement_validate(jsonb)',
    '_platform_announcement_deliver(public.platform_announcements)', '_platform_automation_subjects(public.platform_automation_rules)',
    '_platform_automation_act(public.platform_automation_rules,jsonb,bigint)', '_platform_automation_validate(jsonb)', 'platform_ops_run()']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;

insert into public.tenancy_exempt_functions (name, reason)
select f, 'Platform operations: health, incidents, automation and announcements across merchants, permission-checked'
from unnest(array['platform_health', 'platform_system_logs', 'platform_system_logs_resolve', 'platform_health_retry', '_platform_incident_sync_health',
  '_platform_incident_update', '_platform_incident_json', '_platform_incident_open', 'platform_incident_create', 'platform_incident_update', 'platform_incident_note',
  'platform_incidents_list', 'platform_incident_get', '_platform_announcement_audience', '_platform_announcement_validate', 'platform_announcement_preview',
  '_platform_announcement_deliver', 'platform_announcement_save', 'platform_announcement_send', 'platform_announcement_cancel', 'platform_announcements_list',
  'platform_announcement_get', '_platform_automation_subjects', '_platform_automation_act', 'platform_automation_run', '_platform_automation_validate',
  'platform_automation_rule_save', 'platform_automation_rule_archive', 'platform_automation_test', 'platform_automation_rules_list',
  'platform_automation_runs_list', 'platform_ops_run']) f
on conflict (name) do nothing;
insert into public.tenancy_exempt_functions (name, reason) values
  ('my_announcements', 'Platform announcements delivered to the signed-in staff member''s business (filters by current_merchant_id())'),
  ('announcement_mark_read', 'Records that the signed-in staff member read a platform announcement of their own business'),
  ('announcement_preferences_save', 'Writes the signed-in business''s announcement preferences (current_merchant_id())')
on conflict (name) do nothing;

select public._tenancy_own_functions();
