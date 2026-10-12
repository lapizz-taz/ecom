-- =============================================================================
-- One store at a time.
--
-- Only the store picked under "Where do customers buy?" syncs: Shopify stores
-- when it is Shopify, WooCommerce stores when it is WooCommerce, none for "Our
-- store" or "No website". The other connections stay (keys, imported orders,
-- links) but are paused: their orders are not imported, their webhooks are
-- dropped by the function, the hourly sync skips them, and their store jobs
-- (fulfilment, stock, status) wait and run once the store is picked again.
-- The scheduled jobs only call the server when a store in use has work.
-- =============================================================================

create or replace function pg_temp.lf(p text) returns text
language sql immutable as $$ select replace(p, E'\r', '') $$;

-- Not security definer: inside the app's functions it reads the current
-- merchant's setting; from the schedulers (database owner) every merchant's.
create or replace function public._channel_in_use(p_merchant uuid, p_platform text)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce((select s.value ->> 'mode' from public.settings s where s.merchant_id = p_merchant and s.key = 'storefront'), 'OWN') = p_platform
$$;

-- For the channels function (system only).
create or replace function public.channel_in_use(p_channel_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._require_system();
  return coalesce((select public._channel_in_use(c.merchant_id, c.platform) from public.sales_channels c where c.id = p_channel_id), false);
end;
$$;
revoke execute on function public.channel_in_use(uuid) from public, anon, authenticated;
grant execute on function public.channel_in_use(uuid) to service_role;

-- What the schedulers check before calling the channels function.
create or replace function public.channel_jobs_due()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.channel_sync_jobs j join public.sales_channels c on c.id = j.channel_id
    where ((j.status = 'PENDING' and j.next_attempt_at <= now()) or (j.status = 'RUNNING' and j.locked_until < now()))
      and public._channel_in_use(c.merchant_id, c.platform))
$$;

create or replace function public.channels_sync_due()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.sales_channels c where c.status = 'CONNECTED' and public._channel_in_use(c.merchant_id, c.platform))
$$;
revoke execute on function public.channel_jobs_due() from public, anon, authenticated;
revoke execute on function public.channels_sync_due() from public, anon, authenticated;

-- 1. Store jobs of a paused store wait
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.channel_jobs_claim(integer)'::regprocedure));
  v_from text := $a$    where (status = 'PENDING' and next_attempt_at <= now()) or (status = 'RUNNING' and locked_until < now())
    order by next_attempt_at$a$;
  v_to text := $b$    where ((status = 'PENDING' and next_attempt_at <= now()) or (status = 'RUNNING' and locked_until < now()))
      and exists (select 1 from public.sales_channels c where c.id = channel_sync_jobs.channel_id and public._channel_in_use(c.merchant_id, c.platform))
    order by next_attempt_at$b$;
begin
  if position(v_to in v_old) > 0 then return; end if;
  if position(v_from in v_old) = 0 then raise exception 'one store: channel_jobs_claim has changed'; end if;
  execute replace(v_old, v_from, v_to);
end $$;

do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.channel_status_push_due(integer)'::regprocedure));
  v_from text := $a$from public.channel_status_pushes where status = 'PENDING' and next_at <= now()$a$;
  v_to text := $b$from public.channel_status_pushes where status = 'PENDING' and next_at <= now()
            and exists (select 1 from public.sales_channels c where c.id = channel_status_pushes.channel_id and public._channel_in_use(c.merchant_id, c.platform))$b$;
begin
  if position(v_to in v_old) > 0 then return; end if;
  if position(v_from in v_old) = 0 then raise exception 'one store: channel_status_push_due has changed'; end if;
  execute replace(v_old, v_from, v_to);
end $$;

-- 2. A paused store's orders are not imported
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.channel_ingest_order(uuid,jsonb,text)'::regprocedure));
  v_from text := $a$    raise exception 'NOT_FOUND: sales channel not found' using errcode = 'P0002';
  end if;
  if v_ext is null then$a$;
  v_to text := $b$    raise exception 'NOT_FOUND: sales channel not found' using errcode = 'P0002';
  end if;
  -- Paused: the merchant sells on another store (Sales channels → Where do customers buy?).
  if not public._channel_in_use(v_channel.merchant_id, v_channel.platform) then
    return jsonb_build_object('status', 'SKIPPED', 'reason', 'PAUSED');
  end if;
  if v_ext is null then$b$;
begin
  if position(v_to in v_old) > 0 then return; end if;
  if position(v_from in v_old) = 0 then raise exception 'one store: channel_ingest_order has changed'; end if;
  execute replace(v_old, v_from, v_to);
end $$;

-- 3. The store list says which store is in use
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.sales_channels_list()'::regprocedure));
  v_from text := $a$'shop_domain', c.shop_domain, 'status', c.status,$a$;
  v_to text := $b$'shop_domain', c.shop_domain, 'status', c.status,
      'in_use', public._channel_in_use(c.merchant_id, c.platform),$b$;
begin
  if position(v_to in v_old) > 0 then return; end if;
  if position(v_from in v_old) = 0 then raise exception 'one store: sales_channels_list has changed'; end if;
  execute replace(v_old, v_from, v_to);
end $$;

-- 4. The schedulers (set up as in the README) only call the server for a store in use.
do $$
declare
  r record;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    return;
  end if;
  for r in
    select jobid, jobname, command from cron.job where jobname in ('channel-sync-jobs', 'channels-sync')
  loop
    if r.jobname = 'channel-sync-jobs' and r.command not like '%channel_jobs_due()%' then
      perform cron.alter_job(r.jobid, command := regexp_replace(r.command, 'where exists \(select 1 from public\.channel_sync_jobs.*$', 'where public.channel_jobs_due()'));
    elsif r.jobname = 'channels-sync' and r.command not like '%channels_sync_due()%' then
      perform cron.alter_job(r.jobid, command := regexp_replace(r.command, 'where exists \(select 1 from public\.sales_channels where status = ''CONNECTED''\)', 'where public.channels_sync_due()'));
    end if;
  end loop;
end $$;

select public._tenancy_own_functions();
