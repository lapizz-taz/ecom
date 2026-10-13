-- Super Admin: who is using Fullfilio right now, and how much order traffic the system is carrying.
--
-- The admin and Super Admin apps send a heartbeat once a minute while a tab is open and visible
-- (presence_ping). Only the latest beat per person and app is kept: one small row each.

create table if not exists public.user_presence (
  user_id uuid not null references auth.users(id) on delete cascade,
  area text not null check (area in ('admin', 'super-admin')),
  merchant_id uuid references public.merchants(id) on delete cascade,
  path text check (path is null or length(path) <= 120),
  device text check (device is null or length(device) <= 80),
  last_seen_at timestamptz not null default now(),
  primary key (user_id, area)
);
create index if not exists user_presence_seen_idx on public.user_presence (last_seen_at desc);

-- Same rules as every merchant table; nobody reads it directly (no grants), only the functions below.
alter table public.user_presence enable row level security;
drop policy if exists tenant_isolation on public.user_presence;
create policy tenant_isolation on public.user_presence as restrictive for all
  using (merchant_id = (select public.current_merchant_id())) with check (merchant_id = (select public.current_merchant_id()));
drop policy if exists app_owner_all on public.user_presence;
create policy app_owner_all on public.user_presence for all to app_owner using (true) with check (true);
revoke all on public.user_presence from public, anon, authenticated;

-- The caller's heartbeat. Ids in the path are blanked: only the section is kept.
create or replace function public.presence_ping(p_area text, p_path text default null, p_device text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_merchant uuid;
begin
  if v_user is null then
    return;
  end if;
  if p_area = 'admin' then
    v_merchant := public.current_merchant_id();
    if v_merchant is null or not public.is_staff() then
      return;
    end if;
  elsif p_area = 'super-admin' then
    if not public.is_platform_staff() then
      return;
    end if;
  else
    raise exception 'VALIDATION: unknown app' using errcode = '22023';
  end if;
  insert into public.user_presence (user_id, area, merchant_id, path, device, last_seen_at)
  values (v_user, p_area, v_merchant,
    nullif(left(regexp_replace(coalesce(p_path, ''), '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', ':id', 'gi'), 120), ''),
    nullif(left(coalesce(p_device, ''), 80), ''), now())
  on conflict (user_id, area) do update
    set merchant_id = excluded.merchant_id, path = excluded.path, device = excluded.device, last_seen_at = now();
end;
$$;

-- Who is online (beat in the last 2 minutes), who was recently, and store visitors now.
create or replace function public.platform_live_users()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
begin
  perform public._platform_require('merchants', 'view');
  select coalesce(array_agg(id), '{}') into v_ids from public._platform_merchant_ids() id;
  return jsonb_build_object(
    'at', now(),
    'online_now', (select count(distinct p.user_id) from public.user_presence p
                   where p.last_seen_at > now() - interval '2 minutes' and (p.merchant_id is null or p.merchant_id = any (v_ids))),
    'last_15_min', (select count(distinct p.user_id) from public.user_presence p
                    where p.last_seen_at > now() - interval '15 minutes' and (p.merchant_id is null or p.merchant_id = any (v_ids))),
    'last_24h', (select count(distinct p.user_id) from public.user_presence p
                 where p.last_seen_at > now() - interval '24 hours' and (p.merchant_id is null or p.merchant_id = any (v_ids))),
    'stores_online', (select count(distinct p.merchant_id) from public.user_presence p
                      where p.area = 'admin' and p.last_seen_at > now() - interval '2 minutes' and p.merchant_id = any (v_ids)),
    'people', coalesce((
      select jsonb_agg(x order by x.last_seen_at desc) from (
        select p.user_id, p.area, p.path, p.device, p.last_seen_at,
          p.last_seen_at > now() - interval '2 minutes' as online,
          coalesce(pr.full_name, ps.full_name, u.raw_user_meta_data ->> 'full_name') as name,
          coalesce(pr.email, ps.email, u.email) as email,
          (select r.name from public.roles r where r.id = pr.role_id) as role,
          case when m.id is null then null else jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name) end as merchant
        from public.user_presence p
        join auth.users u on u.id = p.user_id
        left join public.profiles pr on pr.id = p.user_id and p.area = 'admin'
        left join public.platform_staff ps on ps.user_id = p.user_id and p.area = 'super-admin'
        left join public.merchants m on m.id = p.merchant_id
        where p.last_seen_at > now() - interval '24 hours' and (p.merchant_id is null or p.merchant_id = any (v_ids))
        order by p.last_seen_at desc
        limit 200) x), '[]'::jsonb),
    'visitors', coalesce((
      select jsonb_agg(jsonb_build_object('merchant', jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name), 'visitors', v.n) order by v.n desc)
      from (select e.merchant_id, count(distinct coalesce(e.visitor_id, e.session_id)) as n from public.storefront_events e
            where e.created_at > now() - interval '5 minutes' and e.merchant_id = any (v_ids) group by e.merchant_id) v
      join public.merchants m on m.id = v.merchant_id), '[]'::jsonb));
end;
$$;

-- Order traffic now and at its busiest, orders in each status, and database headroom.
create or replace function public.platform_capacity()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
  v_conn int;
  v_max int;
  v_size bigint;
begin
  perform public._platform_require('health', 'view');
  select coalesce(array_agg(id), '{}') into v_ids from public._platform_merchant_ids() id;
  begin
    select count(*) into v_conn from pg_stat_activity where datname = current_database();
    v_max := current_setting('max_connections')::int;
    v_size := pg_database_size(current_database());
  exception when others then
    v_conn := null; v_max := null; v_size := null;
  end;
  return jsonb_build_object(
    'at', now(),
    'orders', jsonb_build_object(
      'last_hour', (select count(*) from public.orders where merchant_id = any (v_ids) and created_at > now() - interval '1 hour'),
      'last_24h', (select count(*) from public.orders where merchant_id = any (v_ids) and created_at > now() - interval '24 hours'),
      'last_7d', (select count(*) from public.orders where merchant_id = any (v_ids) and created_at > now() - interval '7 days'),
      'peak_minute_24h', (select coalesce(max(n), 0) from (select count(*) as n from public.orders
                           where merchant_id = any (v_ids) and created_at > now() - interval '24 hours' group by date_trunc('minute', created_at)) x),
      'peak_hour_7d', (select coalesce(max(n), 0) from (select count(*) as n from public.orders
                        where merchant_id = any (v_ids) and created_at > now() - interval '7 days' group by date_trunc('hour', created_at)) x)),
    'status_changes', jsonb_build_object(
      'last_hour', (select count(*) from public.order_status_history where merchant_id = any (v_ids) and created_at > now() - interval '1 hour'),
      'last_24h', (select count(*) from public.order_status_history where merchant_id = any (v_ids) and created_at > now() - interval '24 hours')),
    'by_status', coalesce((select jsonb_object_agg(s, n) from (select status::text as s, count(*) as n from public.orders
                  where merchant_id = any (v_ids) and merged_into is null group by status) t), '{}'::jsonb),
    'stores_with_orders_24h', (select count(distinct merchant_id) from public.orders where merchant_id = any (v_ids) and created_at > now() - interval '24 hours'),
    'database', jsonb_build_object('connections', v_conn, 'max_connections', v_max, 'size_bytes', v_size));
end;
$$;

revoke execute on function public.presence_ping(text, text, text), public.platform_live_users(), public.platform_capacity() from public, anon;
grant execute on function public.presence_ping(text, text, text), public.platform_live_users(), public.platform_capacity() to authenticated;

insert into public.tenancy_exempt_functions (name, reason) values
  ('presence_ping', 'Records the caller''s own heartbeat; platform staff have no merchant'),
  ('platform_live_users', 'Super Admin: people online across the merchants the employee may see'),
  ('platform_capacity', 'Super Admin: order traffic across the merchants the employee may see')
on conflict (name) do nothing;

select public._tenancy_own_functions();
