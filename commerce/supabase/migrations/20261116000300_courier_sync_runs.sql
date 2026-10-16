-- =============================================================================
-- Courier automation: force status checks, a schedule, and a log of every run
--
--   * Settings → Advanced → Courier automation: check parcels with the
--     couriers on a schedule (settings key 'courier_sync': auto, every_minutes)
--     and force a check now for all parcels or only shipped ones, per courier.
--   * Every check (scheduled or forced) is logged in courier_sync_runs with
--     what was checked, what changed and what failed (and why).
--   * Webhooks that failed can be retried from the same place.
-- =============================================================================

create table if not exists public.courier_sync_runs (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null default public.current_merchant_id() references public.merchants(id),
  trigger text not null check (trigger in ('MANUAL', 'SCHEDULED')),
  scope text not null default 'all' check (scope in ('all', 'shipped')),
  courier_id uuid references public.couriers(id) on delete set null,
  started_by uuid references public.profiles(id) on delete set null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  total int not null default 0,
  checked int not null default 0,
  changed int not null default 0,
  failed int not null default 0,
  -- The last failures (order number and courier's answer), newest last; at most 50.
  errors jsonb not null default '[]'::jsonb
);
create index if not exists courier_sync_runs_recent_idx on public.courier_sync_runs (merchant_id, started_at desc);

alter table public.courier_sync_runs enable row level security;
create policy tenant_isolation on public.courier_sync_runs as restrictive for all to public
  using (merchant_id = (select public.current_merchant_id()))
  with check (merchant_id = (select public.current_merchant_id()) and not (select public._support_read_only()));
create policy app_owner_all on public.courier_sync_runs for all to app_owner using (true) with check (true);
revoke all on public.courier_sync_runs from anon, authenticated;
grant select on public.courier_sync_runs to authenticated;
create policy courier_sync_runs_read on public.courier_sync_runs for select to authenticated
  using ((select public.has_permission('couriers.view')) or (select public.has_permission('shipments.manage')));

-- Statuses a parcel can still move from; 'shipped' is the part already with the courier.
create or replace function public._courier_sync_statuses(p_scope text)
returns public.shipment_status[]
language sql
immutable
as $$
  select case when p_scope = 'shipped'
    then array['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'ON_HOLD', 'RETURNING']::public.shipment_status[]
    else array['BOOKED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'ON_HOLD', 'RETURNING']::public.shipment_status[] end
$$;

-- Starts a logged run (the courier function, as staff or as the scheduler).
create or replace function public.courier_sync_run_start(p_trigger text, p_scope text, p_courier_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run public.courier_sync_runs;
begin
  if not (public.is_system_context() or public.has_permission('shipments.manage')) then
    raise exception 'PERMISSION_DENIED: shipments.manage is required' using errcode = '42501';
  end if;
  if p_trigger = 'SCHEDULED' and not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  insert into public.courier_sync_runs (trigger, scope, courier_id, started_by, total)
  values (p_trigger, coalesce(p_scope, 'all'), p_courier_id, auth.uid(),
    (select count(*) from public.shipments s join public.couriers c on c.id = s.courier_id
     where s.is_active and c.api_enabled and s.status = any(public._courier_sync_statuses(p_scope))
       and (p_courier_id is null or s.courier_id = p_courier_id)))
  returning * into v_run;
  return to_jsonb(v_run);
end;
$$;

-- Adds one batch's outcome to a run; p_done closes it.
create or replace function public.courier_sync_run_progress(p_run_id uuid, p_checked int, p_changed int, p_errors jsonb, p_done boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run public.courier_sync_runs;
begin
  if not (public.is_system_context() or public.has_permission('shipments.manage')) then
    raise exception 'PERMISSION_DENIED: shipments.manage is required' using errcode = '42501';
  end if;
  update public.courier_sync_runs r set
    checked = r.checked + greatest(coalesce(p_checked, 0), 0),
    changed = r.changed + greatest(coalesce(p_changed, 0), 0),
    failed = r.failed + coalesce(jsonb_array_length(p_errors), 0),
    errors = (select coalesce(jsonb_agg(e order by n), '[]'::jsonb) from (
                select e, n from jsonb_array_elements(r.errors || coalesce(p_errors, '[]'::jsonb)) with ordinality x(e, n)
                order by n desc limit 50) t),
    finished_at = case when p_done then now() else r.finished_at end
  where r.id = p_run_id and r.finished_at is null
  returning * into v_run;
  if v_run.id is null then
    raise exception 'NOT_FOUND: this check has already finished' using errcode = 'P0002';
  end if;
  return to_jsonb(v_run);
end;
$$;

-- Whether the scheduled check is on and due for the current store.
create or replace function public.courier_sync_due()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((public.get_setting('courier_sync') ->> 'auto')::boolean, false)
    and exists (select 1 from public.couriers where api_enabled)
    and not exists (
      select 1 from public.courier_sync_runs r
      where r.trigger = 'SCHEDULED'
        and r.started_at > now() - make_interval(mins => greatest(coalesce((public.get_setting('courier_sync') ->> 'every_minutes')::int, 60), 30) - 2))
$$;

-- Staff: retry every failed or unmatched courier webhook of this store now.
create or replace function public.retry_failed_courier_webhooks()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_out jsonb;
  v_counts jsonb := '{}'::jsonb;
begin
  perform public.require_permission('shipments.manage');
  for v_id in
    select id from public.courier_webhook_events
    where result in ('FAILED', 'UNMATCHED') and attempts < 10
    order by received_at limit 200
  loop
    v_out := public._process_courier_webhook(v_id);
    v_counts := v_counts || jsonb_build_object(v_out ->> 'status', coalesce((v_counts ->> (v_out ->> 'status'))::int, 0) + 1);
  end loop;
  return v_counts;
end;
$$;

-- Courier automation at a glance: webhook health per courier and the last runs.
create or replace function public.courier_automation_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not (public.has_permission('couriers.view') or public.has_permission('shipments.manage')) then
    raise exception 'PERMISSION_DENIED: couriers.view is required' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'settings', coalesce(public.get_setting('courier_sync'), '{}'::jsonb),
    'couriers', coalesce((select jsonb_agg(jsonb_build_object(
        'id', c.id, 'name', c.name, 'provider', c.provider,
        'active_parcels', (select count(*) from public.shipments s where s.courier_id = c.id and s.is_active
                           and s.status = any(public._courier_sync_statuses('all'))),
        'shipped_parcels', (select count(*) from public.shipments s where s.courier_id = c.id and s.is_active
                            and s.status = any(public._courier_sync_statuses('shipped'))),
        'last_webhook_at', (select max(w.received_at) from public.courier_webhook_events w where w.courier_id = c.id),
        'webhooks_today', (select count(*) from public.courier_webhook_events w where w.courier_id = c.id and w.received_at > now() - interval '1 day'),
        'webhooks_failed', (select count(*) from public.courier_webhook_events w where w.courier_id = c.id and w.result in ('FAILED', 'UNMATCHED'))
      ) order by c.name) from public.couriers c where c.api_enabled), '[]'::jsonb),
    'runs', coalesce((select jsonb_agg(to_jsonb(r) || jsonb_build_object(
        'courier', (select name from public.couriers where id = r.courier_id),
        'started_by_name', (select coalesce(nullif(p.full_name, ''), p.email) from public.profiles p where p.id = r.started_by))
        order by r.started_at desc)
      from (select * from public.courier_sync_runs order by started_at desc limit 10) r), '[]'::jsonb));
end;
$$;

-- Saves the automatic check (Settings → Advanced → Courier automation).
create or replace function public.courier_sync_save(p_auto boolean, p_every_minutes int)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_value jsonb;
begin
  perform public.require_permission('settings.manage');
  if p_every_minutes not in (30, 60, 120, 360, 720, 1440) then
    raise exception 'VALIDATION: choose how often: 30 minutes to once a day' using errcode = '22023';
  end if;
  v_value := jsonb_build_object('auto', coalesce(p_auto, false), 'every_minutes', p_every_minutes);
  insert into public.settings (key, is_public, description, value, updated_by)
  values ('courier_sync', false, 'Check parcel status with the couriers on a schedule', v_value, auth.uid())
  on conflict (merchant_id, key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now();
  perform public.log_audit('courier_sync.updated', 'settings', 'courier_sync', null, v_value, '{}'::jsonb);
  return v_value;
end;
$$;

revoke all on function public._courier_sync_statuses(text) from public, anon, authenticated;
revoke all on function public.courier_sync_save(boolean, int) from public, anon;
grant execute on function public.courier_sync_save(boolean, int) to authenticated;
revoke all on function public.courier_sync_run_start(text, text, uuid), public.courier_sync_run_progress(uuid, int, int, jsonb, boolean),
  public.courier_sync_due(), public.retry_failed_courier_webhooks(), public.courier_automation_overview() from public, anon;
grant execute on function public.courier_sync_run_start(text, text, uuid), public.courier_sync_run_progress(uuid, int, int, jsonb, boolean),
  public.retry_failed_courier_webhooks(), public.courier_automation_overview() to authenticated;
grant execute on function public.courier_sync_due() to service_role;

select public._tenancy_own_functions();

alter function public.courier_sync_run_start(text, text, uuid) owner to app_owner;
alter function public.courier_sync_run_progress(uuid, int, int, jsonb, boolean) owner to app_owner;
alter function public.courier_sync_due() owner to app_owner;
alter function public.retry_failed_courier_webhooks() owner to app_owner;
alter function public.courier_automation_overview() owner to app_owner;
alter function public.courier_sync_save(boolean, int) owner to app_owner;
