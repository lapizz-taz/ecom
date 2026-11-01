-- =============================================================================
-- Push notifications for new orders, on the phone (the installed app) or a computer.
--
--   * A staff member who can see orders turns notifications on for a device (My account, or the
--     prompt in the app). The browser's push subscription is kept in push_subscriptions.
--   * Every new order of a business with at least one such device is queued in push_outbox.
--   * pg_cron calls the push function every 15 seconds while something waits (each minute where
--     pg_cron cannot run sub-minute jobs). It claims the queue (push_claim), sends one message per
--     device ("New order 1051" or "3 new orders") and reports back (push_done): devices the push
--     service says are gone are dropped. The person who made an order is not told about it.
--   * The keys push services check our messages against (VAPID) are made by the push function the
--     first time they are needed and kept in Vault (platform_push_keys). Nobody handles them.
--
-- Only these push services are accepted, so the function never posts anywhere else: Google (Chrome,
-- Edge on Android, Samsung Internet, Opera, Brave), Mozilla (Firefox), Apple (Safari, iPhone and
-- iPad apps on the home screen) and Microsoft (Edge on Windows).
-- =============================================================================

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null default public.current_merchant_id() references public.merchants(id),
  user_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null check (length(endpoint) <= 1000
    and endpoint ~ '^https://(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)/'),
  p256dh text not null check (p256dh ~ '^[A-Za-z0-9_-]{80,100}$'),
  auth text not null check (auth ~ '^[A-Za-z0-9_-]{16,32}$'),
  device text check (length(device) <= 120),
  created_at timestamptz not null default now(),
  last_sent_at timestamptz,
  failures int not null default 0,
  unique (merchant_id, endpoint)
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (merchant_id, user_id);

create table if not exists public.push_outbox (
  id bigint generated always as identity primary key,
  merchant_id uuid not null default public.current_merchant_id() references public.merchants(id),
  order_id uuid not null references public.orders(id) on delete cascade,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists push_outbox_pending_idx on public.push_outbox (merchant_id, id) where sent_at is null;

do $$
declare t text;
begin
  foreach t in array array['push_subscriptions', 'push_outbox'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format($p$create policy tenant_isolation on public.%I as restrictive for all to public
      using (merchant_id = (select public.current_merchant_id()))
      with check (merchant_id = (select public.current_merchant_id()) and not (select public._support_read_only()))$p$, t);
    execute format('drop policy if exists app_owner_all on public.%I', t);
    execute format('create policy app_owner_all on public.%I for all to app_owner using (true) with check (true)', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- new orders
-- Queued only where someone listens. A problem here must never stop an order from being saved.
create or replace function public._push_new_order()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from public.push_subscriptions s where s.merchant_id = new.merchant_id) then
    insert into public.push_outbox (merchant_id, order_id) values (new.merchant_id, new.id);
  end if;
  return null;
exception when others then
  raise warning 'push: new order % not queued: %', new.id, sqlerrm;
  return null;
end;
$$;
drop trigger if exists orders_push_new on public.orders;
create trigger orders_push_new after insert on public.orders for each row execute function public._push_new_order();

-- ---------------------------------------------------------------- devices (signed-in staff)
-- Turns notifications on for this device, for the person signed in on it now.
create or replace function public.push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_device text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_endpoint text := trim(coalesce(p_endpoint, ''));
  v_p256dh text := rtrim(trim(coalesce(p_p256dh, '')), '=');
  v_auth text := rtrim(trim(coalesce(p_auth, '')), '=');
begin
  perform public.require_permission('orders.view');
  if v_endpoint !~ '^https://(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)/'
     or length(v_endpoint) > 1000 then
    raise exception 'VALIDATION: this browser''s notification service is not supported' using errcode = '22023';
  end if;
  if v_p256dh !~ '^[A-Za-z0-9_-]{80,100}$' or v_auth !~ '^[A-Za-z0-9_-]{16,32}$' then
    raise exception 'VALIDATION: the browser sent incomplete notification keys' using errcode = '22023';
  end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, device, created_at)
  values (v_user, v_endpoint, v_p256dh, v_auth, nullif(left(trim(coalesce(p_device, '')), 120), ''), clock_timestamp())
  on conflict (merchant_id, endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device,
        failures = 0, created_at = excluded.created_at;
  -- Ten devices per person: the oldest go first (never this one).
  delete from public.push_subscriptions
  where user_id = v_user and endpoint <> v_endpoint and id in (
    select id from public.push_subscriptions where user_id = v_user order by created_at desc offset 10);
  return public.push_my_devices(v_endpoint);
end;
$$;

-- Turns notifications off for this device (any signed-in person may, whatever their role now).
create or replace function public.push_unsubscribe(p_endpoint text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  delete from public.push_subscriptions where endpoint = trim(coalesce(p_endpoint, '')) and user_id = auth.uid();
  return public.push_my_devices(p_endpoint);
end;
$$;

-- How many of my devices get notifications, and whether this one does.
create or replace function public.push_my_devices(p_endpoint text default null)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'devices', count(*),
    'this_device', coalesce(bool_or(s.endpoint = trim(coalesce(p_endpoint, ''))), false))
  from public.push_subscriptions s
  where s.user_id = auth.uid() and auth.uid() is not null
$$;

-- ---------------------------------------------------------------- sending (the push function)
-- Claims this business's queued orders and says which devices hear about them: those of active
-- staff who can see orders. Each device's own orders (made by its person) are left out by the caller.
create or replace function public.push_claim(p_limit int default 200)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_orders jsonb;
  v_devices jsonb;
begin
  with claimed as (
    update public.push_outbox b set sent_at = now()
    where b.sent_at is null and b.id in (
      select id from public.push_outbox where sent_at is null order by id limit greatest(1, least(coalesce(p_limit, 200), 500)))
    returning b.order_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', o.id, 'number', o.order_number, 'customer', o.customer_name, 'total', o.total_amount,
      'created_by', o.created_by, 'source', o.source::text,
      'channel', (select c.platform from public.sales_channels c where c.id = o.sales_channel_id))
    order by o.created_at), '[]'::jsonb)
  into v_orders
  from claimed c join public.orders o on o.id = c.order_id
  where o.merged_into is null;

  if jsonb_array_length(v_orders) = 0 or public.merchant_access_mode() = 'BLOCKED' then
    return jsonb_build_object('orders', '[]'::jsonb, 'devices', '[]'::jsonb);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'user_id', s.user_id, 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]'::jsonb)
  into v_devices
  from public.push_subscriptions s
  join public.profiles p on p.id = s.user_id and p.merchant_id = s.merchant_id and p.is_active
  join public.roles r on r.id = p.role_id
  where r.code = 'OWNER' or exists (
    select 1 from public.role_permissions rp join public.permissions pm on pm.id = rp.permission_id
    where rp.role_id = r.id and pm.code = 'orders.view');

  return jsonb_build_object('orders', v_orders, 'devices', v_devices);
end;
$$;

-- What the push services said: delivered, gone for good (the person turned notifications off or
-- the browser dropped them: the device is removed) or failed (removed after 20 failures in a row).
create or replace function public.push_done(p_sent uuid[] default '{}', p_gone uuid[] default '{}', p_failed uuid[] default '{}')
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.push_subscriptions set last_sent_at = now(), failures = 0 where id = any (coalesce(p_sent, '{}'));
  delete from public.push_subscriptions where id = any (coalesce(p_gone, '{}'));
  update public.push_subscriptions set failures = failures + 1 where id = any (coalesce(p_failed, '{}'));
  delete from public.push_subscriptions where id = any (coalesce(p_failed, '{}')) and failures >= 20;
end;
$$;

-- Something waits to be sent: the schedule's check, run as the scheduler (every business), so not
-- SECURITY DEFINER (that would see one business only).
create or replace function public.push_due()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.push_outbox where sent_at is null)
$$;

-- The VAPID key pair, kept in Vault (platform credential "web_push"). The push function makes one
-- the first time and stores it here; if two were made at once, the first stored is the one used.
create or replace function public.platform_push_keys(p_new jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  begin
    perform pg_advisory_xact_lock(hashtext('platform_push_keys'));
  exception when undefined_function then
    null; -- a database without advisory locks: one Worker writes at a time anyway
  end;
  v := public.platform_secret_get('web_push');
  if v is null and p_new is not null then
    if coalesce(p_new ->> 'public_key', '') !~ '^[A-Za-z0-9_-]{80,100}$' or jsonb_typeof(p_new -> 'private_jwk') <> 'object' then
      raise exception 'VALIDATION: bad push keys' using errcode = '22023';
    end if;
    perform public.platform_secret_store('web_push', jsonb_build_object('public_key', p_new ->> 'public_key', 'private_jwk', p_new -> 'private_jwk'),
      'Made automatically', null);
    v := public.platform_secret_get('web_push');
  end if;
  return v;
end;
$$;

insert into public.tenancy_exempt_functions (name, reason)
values ('platform_push_keys', 'Vault; the platform''s push notification keys (service role only)')
on conflict (name) do nothing;

revoke all on function public._push_new_order() from public, anon, authenticated;
revoke all on function public.push_subscribe(text, text, text, text), public.push_unsubscribe(text), public.push_my_devices(text) from public, anon;
grant execute on function public.push_subscribe(text, text, text, text), public.push_unsubscribe(text), public.push_my_devices(text) to authenticated, service_role;
revoke all on function public.push_claim(int), public.push_done(uuid[], uuid[], uuid[]), public.push_due(), public.platform_push_keys(jsonb)
  from public, anon, authenticated;
grant execute on function public.push_claim(int), public.push_done(uuid[], uuid[], uuid[]), public.push_due(), public.platform_push_keys(jsonb) to service_role;

-- ---------------------------------------------------------------- schedule
-- Every 15 seconds while something waits (each minute where pg_cron has no sub-minute jobs).
do $$
declare
  v_cmd text := $job$
  select net.http_post(
    url := 'https://fullfilio.com/functions/v1/push',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{"action": "dispatch"}'::jsonb,
    timeout_milliseconds := 60000)
  where public.push_due()
$job$;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') or not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise notice 'pg_cron or pg_net missing: push-dispatch not scheduled';
    return;
  end if;
  perform cron.unschedule(jobid) from cron.job where jobname = 'push-dispatch';
  begin
    perform cron.schedule('push-dispatch', '15 seconds', v_cmd);
  exception when others then
    perform cron.schedule('push-dispatch', '* * * * *', v_cmd);
  end;
end $$;

select public._tenancy_own_functions();
