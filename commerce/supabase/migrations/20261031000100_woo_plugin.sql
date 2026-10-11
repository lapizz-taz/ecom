-- WooCommerce plugin (Fullfilio Connect).
--
-- The store still talks to us through WooCommerce's REST API and webhooks
-- (sales_channels, channel_ingest_order …). The plugin adds signed events
-- (POST /channels/plugin/<channel id>): heartbeats with a health report,
-- unfinished checkouts, order nudges and the checkout-time order shield.
--
--   settings.plugin         last report from the plugin (+ last_seen_at)
--   settings.plugin_config  feature switches staff set here; sent back to the plugin
--   channel_plugin_events   what the plugin sent and what we did (debug log)

-- -----------------------------------------------------------------------------
-- Event log (append-only; the newest 200 per store are shown)
-- -----------------------------------------------------------------------------
create table if not exists public.channel_plugin_events (
  id bigint generated always as identity primary key,
  channel_id uuid not null references public.sales_channels(id),
  event_id text,
  type text not null check (length(type) between 1 and 40),
  status text not null check (status in ('OK', 'DUPLICATE', 'FAILED', 'REJECTED')),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists channel_plugin_events_channel_idx on public.channel_plugin_events(channel_id, created_at desc);
alter table public.channel_plugin_events enable row level security;
revoke all on public.channel_plugin_events from anon, authenticated;

-- Feature switches (defaults: everything on except the shield, which can refuse orders).
create or replace function public._plugin_config(p_settings jsonb)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'order_events', true, 'capture_leads', true, 'attribution', true, 'custom_statuses', true,
    'shield', false, 'shield_fail_open', true, 'shield_timeout', 4)
    || coalesce(p_settings -> 'plugin_config', '{}'::jsonb)
$$;

-- -----------------------------------------------------------------------------
-- Called by the channels function (service role)
-- -----------------------------------------------------------------------------

-- Heartbeat: keep the report, answer with the switches.
create or replace function public.channel_plugin_seen(p_channel_id uuid, p_report jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings jsonb;
begin
  perform public._require_system();
  update public.sales_channels
  set settings = settings || jsonb_build_object('plugin',
    (case when length(coalesce(p_report, '{}'::jsonb)::text) > 30000 then jsonb_build_object('truncated', true) else coalesce(p_report, '{}'::jsonb) end)
    || jsonb_build_object('last_seen_at', now()))
  where id = p_channel_id and platform = 'WOOCOMMERCE'
  returning settings into v_settings;
  if v_settings is null then
    raise exception 'NOT_FOUND: WooCommerce store not found' using errcode = 'P0002';
  end if;
  return public._plugin_config(v_settings);
end;
$$;

-- The outcome of connecting the plugin (after the WooCommerce keys arrive).
create or replace function public.channel_plugin_paired(p_channel_id uuid, p_ok boolean, p_detail text default null, p_report jsonb default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._require_system();
  update public.sales_channels
  set settings = settings
    || jsonb_build_object('plugin_pair', jsonb_build_object('ok', p_ok, 'at', now(), 'detail', left(p_detail, 300)))
    || case when p_ok and p_report is not null then jsonb_build_object('plugin', p_report || jsonb_build_object('last_seen_at', now())) else '{}'::jsonb end
  where id = p_channel_id;
end;
$$;

create or replace function public.channel_plugin_log(p_channel_id uuid, p_event_id text, p_type text, p_status text, p_detail jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._require_system();
  insert into public.channel_plugin_events(channel_id, event_id, type, status, detail)
  values (p_channel_id, left(p_event_id, 80), left(coalesce(nullif(p_type, ''), 'unknown'), 40), p_status,
    case when length(coalesce(p_detail, '{}'::jsonb)::text) > 4000 then jsonb_build_object('truncated', true) else coalesce(p_detail, '{}'::jsonb) end);
end;
$$;

-- An unfinished checkout that turned into an order.
create or replace function public.channel_abandoned_complete(p_channel_id uuid, p_external_id text, p_completed_at timestamptz default now())
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._require_system();
  update public.shopify_abandoned_checkouts
  set completed_at = coalesce(completed_at, p_completed_at, now()), status = 'RECOVERED', synced_at = now()
  where channel_id = p_channel_id and external_id = p_external_id;
  return found;
end;
$$;

/**
 * The order shield's answer at the store's checkout: block | advance | allow.
 * The same rules as this store's own checkout: the block list first, then the
 * customer's courier record (decision of the fraud check made for this phone).
 * Without a check, or when the check failed, the order is allowed.
 */
create or replace function public.channel_checkout_decision(p_channel_id uuid, p_phone text, p_ip text default null, p_address text default null, p_check_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_block jsonb;
  v_check public.fraud_checks;
  v_message text;
begin
  perform public._require_system();
  v_block := public.order_block_match(p_phone, p_ip, p_address);
  if v_block is not null then
    return jsonb_build_object('decision', 'block', 'reason', 'BLOCK_LIST',
      'message', public.setting_text('fraud', array['messages', 'blocked'], 'We are unable to accept this order online. Please contact us to complete your purchase.'));
  end if;
  if p_check_id is null then
    return jsonb_build_object('decision', 'allow', 'reason', 'NO_CHECK');
  end if;
  select * into v_check from public.fraud_checks where id = p_check_id;
  if v_check.id is null or v_check.status = 'ERROR' then
    return jsonb_build_object('decision', 'allow', 'reason', 'CHECK_UNAVAILABLE');
  end if;
  if v_check.decision = 'BLOCK' then
    return jsonb_build_object('decision', 'block', 'reason', 'RULE',
      'message', public.setting_text('fraud', array['messages', 'blocked'], 'We are unable to accept this order online. Please contact us to complete your purchase.'));
  end if;
  if v_check.decision = 'ADVANCE_REQUIRED' then
    v_message := coalesce(nullif(public.get_setting('fraud') #>> '{receive_rate,message}', ''),
      'To confirm this order, please pay {amount} in advance.');
    return jsonb_build_object('decision', 'advance', 'reason', 'ADVANCE', 'advance_amount', v_check.advance_amount,
      'message', replace(v_message, '{amount}', coalesce(public.money(v_check.advance_amount)::text || ' tk', 'the delivery charge')));
  end if;
  return jsonb_build_object('decision', 'allow', 'reason', coalesce(v_check.decision::text, 'ALLOW'));
end;
$$;

-- -----------------------------------------------------------------------------
-- Staff
-- -----------------------------------------------------------------------------

-- Feature switches for a store's plugin.
create or replace function public.channel_plugin_config_save(p_channel_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clean jsonb := '{}'::jsonb;
  v_key text;
  v_settings jsonb;
begin
  perform public.require_permission('settings.manage');
  foreach v_key in array array['order_events', 'capture_leads', 'attribution', 'custom_statuses', 'shield', 'shield_fail_open'] loop
    if p ? v_key then
      if jsonb_typeof(p -> v_key) <> 'boolean' then
        raise exception 'VALIDATION: % must be on or off', v_key using errcode = '22023';
      end if;
      v_clean := v_clean || jsonb_build_object(v_key, p -> v_key);
    end if;
  end loop;
  if p ? 'shield_timeout' then
    v_clean := v_clean || jsonb_build_object('shield_timeout', greatest(2, least(10, (p ->> 'shield_timeout')::int)));
  end if;
  update public.sales_channels
  set settings = settings || jsonb_build_object('plugin_config', coalesce(settings -> 'plugin_config', '{}'::jsonb) || v_clean)
  where id = p_channel_id and platform = 'WOOCOMMERCE'
  returning settings into v_settings;
  if v_settings is null then
    raise exception 'NOT_FOUND: WooCommerce store not found' using errcode = 'P0002';
  end if;
  perform public.log_audit('channel.plugin_config', 'sales_channel', p_channel_id::text, null, v_clean);
  return public._plugin_config(v_settings);
end;
$$;

-- Everything the store's plugin tab shows.
create or replace function public.channel_plugin_overview(p_channel_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  c public.sales_channels;
begin
  perform public.require_permission('settings.manage');
  select * into c from public.sales_channels where id = p_channel_id and platform = 'WOOCOMMERCE';
  if c.id is null then
    raise exception 'NOT_FOUND: WooCommerce store not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'channel', jsonb_build_object('id', c.id, 'name', c.name, 'shop_domain', c.shop_domain, 'status', c.status, 'last_sync_at', c.last_sync_at,
      'last_error', c.last_error, 'webhooks', c.webhooks, 'last_test', c.last_test),
    'plugin', c.settings -> 'plugin',
    'pair', c.settings -> 'plugin_pair',
    'online', coalesce((c.settings #>> '{plugin,last_seen_at}')::timestamptz > now() - interval '40 minutes', false),
    'config', public._plugin_config(c.settings),
    'events', coalesce((select jsonb_agg(to_jsonb(e) - 'channel_id' order by e.id desc)
      from (select * from public.channel_plugin_events where channel_id = c.id order by id desc limit 100) e), '[]'::jsonb),
    'counts', (select jsonb_build_object(
        'events_24h', count(*) filter (where created_at > now() - interval '24 hours'),
        'failed_24h', count(*) filter (where created_at > now() - interval '24 hours' and status in ('FAILED', 'REJECTED')),
        'leads_7d', (select count(*) from public.shopify_abandoned_checkouts a where a.channel_id = c.id and a.created_at > now() - interval '7 days'),
        'leads_recovered_7d', (select count(*) from public.shopify_abandoned_checkouts a where a.channel_id = c.id and a.status = 'RECOVERED' and a.completed_at > now() - interval '7 days'),
        'orders_7d', (select count(*) from public.channel_order_imports i where i.channel_id = c.id and i.created_at > now() - interval '7 days' and i.status = 'IMPORTED'))
      from public.channel_plugin_events where channel_id = c.id));
end;
$$;

-- Abandoned checkouts: Shopify's and the WooCommerce plugin's unfinished checkouts, side by side.
create or replace function public.admin_shopify_abandoned(p_view text default 'open', p_search text default null, p_limit int default 50, p_offset int default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_q text := nullif(trim(coalesce(p_search, '')), '');
  v_digits text := regexp_replace(coalesce(p_search, ''), '\D', '', 'g');
begin
  perform public.require_permission('orders.view');
  return (
    with filtered as (
      select a.*, c.name as store_name, c.shop_domain, c.platform from public.shopify_abandoned_checkouts a
      join public.sales_channels c on c.id = a.channel_id
      where case coalesce(p_view, 'open')
          when 'open' then a.status = 'OPEN' and a.follow_up <> 'DISMISSED'
          when 'recovered' then a.status = 'RECOVERED'
          when 'dismissed' then a.follow_up = 'DISMISSED' and a.status = 'OPEN'
          else true end
        and (v_q is null or a.customer_name ilike '%' || v_q || '%' or a.email ilike '%' || v_q || '%' or a.name ilike '%' || v_q || '%'
             or a.items::text ilike '%' || v_q || '%' or a.country ilike '%' || v_q || '%' or a.legacy_id like '%' || v_q || '%'
             or (length(v_digits) >= 4 and a.phone like '%' || v_digits || '%'))
    )
    select jsonb_build_object(
      'total', (select count(*) from filtered),
      'items', coalesce((select jsonb_agg(to_jsonb(f) order by f.shop_created_at desc nulls last)
        from (select * from filtered order by shop_created_at desc nulls last limit least(greatest(p_limit, 1), 200) offset greatest(p_offset, 0)) f), '[]'::jsonb),
      'stats', (select jsonb_build_object(
          'open', count(*) filter (where status = 'OPEN' and follow_up <> 'DISMISSED'),
          'open_value', coalesce(sum(total) filter (where status = 'OPEN' and follow_up <> 'DISMISSED'), 0),
          'recovered_30d', count(*) filter (where status = 'RECOVERED' and completed_at > now() - interval '30 days'),
          'recovered_value_30d', coalesce(sum(total) filter (where status = 'RECOVERED' and completed_at > now() - interval '30 days'), 0),
          'with_contact', count(*) filter (where status = 'OPEN' and (phone is not null or email is not null)),
          'all_30d', count(*) filter (where shop_created_at > now() - interval '30 days'))
        from public.shopify_abandoned_checkouts),
      'channels', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'shop_domain', c.shop_domain, 'status', c.status,
          'platform', c.platform,
          'synced_at', case when c.platform = 'WOOCOMMERCE' then c.settings #>> '{plugin,last_seen_at}' else c.settings ->> 'abandoned_synced_at' end,
          'error', case when c.platform = 'WOOCOMMERCE' then case when c.settings #>> '{plugin,last_seen_at}' is null
              then 'Install the Fullfilio Connect plugin on this store to capture unfinished checkouts' end
            else c.settings ->> 'abandoned_error' end) order by c.created_at)
        from public.sales_channels c where c.platform in ('SHOPIFY', 'WOOCOMMERCE') and c.status <> 'DISCONNECTED'), '[]'::jsonb)));
end;
$$;

revoke all on function public.channel_plugin_seen(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.channel_plugin_paired(uuid, boolean, text, jsonb) from public, anon, authenticated;
revoke all on function public.channel_plugin_log(uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.channel_abandoned_complete(uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.channel_checkout_decision(uuid, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.channel_plugin_seen(uuid, jsonb) to service_role;
grant execute on function public.channel_plugin_paired(uuid, boolean, text, jsonb) to service_role;
grant execute on function public.channel_plugin_log(uuid, text, text, text, jsonb) to service_role;
grant execute on function public.channel_abandoned_complete(uuid, text, timestamptz) to service_role;
grant execute on function public.channel_checkout_decision(uuid, text, text, text, uuid) to service_role;
revoke all on function public.channel_plugin_config_save(uuid, jsonb) from public, anon;
revoke all on function public.channel_plugin_overview(uuid) from public, anon;
grant execute on function public.channel_plugin_config_save(uuid, jsonb) to authenticated, service_role;
grant execute on function public.channel_plugin_overview(uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Delivered / Returned on the WooCommerce order
-- -----------------------------------------------------------------------------
-- When the courier delivers or returns an order that came from a WooCommerce
-- store with the plugin's statuses switched on, the store's order is set to
-- "Delivered" / "Returned" once (unique per order and status). Sent by the
-- per-minute job run; failures are retried with a growing wait and shown on
-- the store's page.
create table if not exists public.channel_status_pushes (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.sales_channels(id),
  order_id uuid not null references public.orders(id),
  external_order_id text not null,
  target text not null check (target in ('delivered', 'returned')),
  status text not null default 'PENDING' check (status in ('PENDING', 'DONE', 'FAILED', 'SKIPPED')),
  attempts int not null default 0,
  next_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  done_at timestamptz,
  unique (order_id, target)
);
create index if not exists channel_status_pushes_due_idx on public.channel_status_pushes(status, next_at);
alter table public.channel_status_pushes enable row level security;
revoke all on public.channel_status_pushes from anon, authenticated;

create or replace function public._queue_woo_status_push()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c public.sales_channels;
begin
  select * into c from public.sales_channels where id = new.sales_channel_id;
  if c.id is null or c.platform <> 'WOOCOMMERCE' or c.status = 'DISCONNECTED' or new.external_order_id is null
     or not coalesce((public._plugin_config(c.settings) ->> 'custom_statuses')::boolean, false) then
    return new;
  end if;
  insert into public.channel_status_pushes(channel_id, order_id, external_order_id, target)
  values (c.id, new.id, new.external_order_id, case new.status when 'DELIVERED' then 'delivered' else 'returned' end)
  on conflict (order_id, target) do nothing;
  return new;
end;
$$;
create or replace trigger orders_woo_status_push after update of status on public.orders
  for each row when (new.status in ('DELIVERED', 'RETURNED') and old.status is distinct from new.status and new.sales_channel_id is not null)
  execute function public._queue_woo_status_push();

create or replace function public.channel_status_push_due(p_limit int default 20)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._require_system();
  return coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'channel_id', p.channel_id, 'order_id', p.order_id,
      'external_order_id', p.external_order_id, 'target', p.target, 'attempts', p.attempts) order by p.next_at)
    from (select * from public.channel_status_pushes where status = 'PENDING' and next_at <= now()
          order by next_at limit greatest(1, least(coalesce(p_limit, 20), 100)) for update skip locked) p), '[]'::jsonb);
end;
$$;

create or replace function public.channel_status_push_result(p_id uuid, p_ok boolean, p_error text default null, p_retry boolean default true)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.channel_status_pushes;
  v_store text;
begin
  perform public._require_system();
  update public.channel_status_pushes set
    attempts = attempts + 1,
    status = case when p_ok then 'DONE' when not p_retry or attempts + 1 >= 8 then 'FAILED' else 'PENDING' end,
    next_at = now() + make_interval(mins => least(360, (5 * power(2, attempts))::int)),
    last_error = case when p_ok then null else left(p_error, 300) end,
    done_at = case when p_ok then now() else done_at end
  where id = p_id returning * into r;
  if r.id is null then return; end if;
  select name into v_store from public.sales_channels where id = r.channel_id;
  if p_ok then
    perform public._order_log(r.order_id, 'CHANNEL_STATUS', format('Marked %s on %s', initcap(r.target), coalesce(v_store, 'WooCommerce')));
  elsif r.status = 'FAILED' then
    perform public._order_log(r.order_id, 'CHANNEL_STATUS', format('Could not mark %s on %s: %s', initcap(r.target), coalesce(v_store, 'WooCommerce'), coalesce(p_error, 'unknown error')));
  end if;
end;
$$;

revoke all on function public.channel_status_push_due(int) from public, anon, authenticated;
revoke all on function public.channel_status_push_result(uuid, boolean, text, boolean) from public, anon, authenticated;
grant execute on function public.channel_status_push_due(int) to service_role;
grant execute on function public.channel_status_push_result(uuid, boolean, text, boolean) to service_role;
