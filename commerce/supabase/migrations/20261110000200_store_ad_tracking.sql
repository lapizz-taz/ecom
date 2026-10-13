-- =============================================================================
-- Ad tracking for the merchant's own Fullfilio store
--   Browser pixels (Meta, TikTok, Google) and server copies (Meta Conversions
--   API, TikTok Events API, GA4 Measurement Protocol), deduplicated with one
--   event id per event. The Purchase goes out when the order is placed,
--   confirmed or delivered (the merchant picks), the same rules as the
--   Fullfilio Connect WooCommerce plugin.
--
--   store_ad_tracking  — the non-secret settings (pixel ids, rules). Written
--                        only by the channels edge function after validation.
--                        API tokens live in Vault (integration secret
--                        'ad_tracking'), never in a table.
--   ad_event_queue     — one row per order and event, queued by a trigger on
--                        orders and sent by the per-minute job run, with
--                        retries and a readable result per platform.
-- =============================================================================

create table if not exists public.store_ad_tracking (
  merchant_id uuid primary key references public.merchants(id),
  config jsonb not null default '{}'::jsonb,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
alter table public.store_ad_tracking enable row level security;
create policy tenant_isolation on public.store_ad_tracking as restrictive for all to public
  using (merchant_id = public.current_merchant_id()) with check (merchant_id = public.current_merchant_id());
create policy app_owner_all on public.store_ad_tracking for all to app_owner using (true) with check (true);
create policy staff_read on public.store_ad_tracking for select to authenticated using ((select public.is_staff()));
revoke all on public.store_ad_tracking from anon;

create table if not exists public.ad_event_queue (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id),
  order_id uuid not null references public.orders(id) on delete cascade,
  event text not null check (event in ('Purchase')),
  event_id text not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'DONE', 'PARTIAL', 'FAILED', 'SKIPPED')),
  attempts int not null default 0,
  next_at timestamptz not null default now(),
  results jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  done_at timestamptz,
  unique (order_id, event)
);
create index if not exists ad_event_queue_due_idx on public.ad_event_queue (merchant_id, status, next_at);
create index if not exists ad_event_queue_recent_idx on public.ad_event_queue (merchant_id, created_at desc);
alter table public.ad_event_queue enable row level security;
create policy tenant_isolation on public.ad_event_queue as restrictive for all to public
  using (merchant_id = public.current_merchant_id()) with check (merchant_id = public.current_merchant_id());
create policy app_owner_all on public.ad_event_queue for all to app_owner using (true) with check (true);
create policy staff_read on public.ad_event_queue for select to authenticated using ((select public.is_staff()));
revoke all on public.ad_event_queue from anon;

-- The browser's own ad ids for an order (Meta _fbp/_fbc, TikTok _ttp, GA client
-- id), sent with the checkout so the server copy matches the visitor.
alter table public.order_attributions add column if not exists browser_ids jsonb;

create or replace function public.order_set_browser_ids(p_order_id uuid, p_ids jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._require_system();
  if jsonb_typeof(p_ids) <> 'object' then
    return;
  end if;
  update public.order_attributions set browser_ids = p_ids
  where order_id = p_order_id and merchant_id = public.current_merchant_id();
end;
$$;

-- What the storefront needs to load the pixels: ids and switches, no tokens.
create or replace function public.storefront_ad_tracking()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when coalesce((t.config ->> 'enabled')::boolean, false) then jsonb_build_object(
      'enabled', true,
      'browser_events', coalesce((t.config ->> 'browser_events')::boolean, true),
      'server_events', coalesce((t.config ->> 'server_events')::boolean, true),
      'advanced_matching', coalesce((t.config ->> 'advanced_matching')::boolean, true),
      'purchase_on', coalesce(t.config ->> 'purchase_on', 'placed'),
      'meta_pixel', nullif(t.config -> 'meta' ->> 'pixel_id', ''),
      'tiktok_pixel', nullif(t.config -> 'tiktok' ->> 'pixel_id', ''),
      'ga4_id', nullif(t.config -> 'google' ->> 'ga4_id', ''),
      'ads_id', nullif(t.config -> 'google' ->> 'ads_id', ''),
      'ads_label', nullif(t.config -> 'google' ->> 'ads_label', ''))
    else jsonb_build_object('enabled', false) end
  from (select (select config from public.store_ad_tracking where merchant_id = public.current_merchant_id()) as config) t
$$;
grant execute on function public.storefront_ad_tracking() to anon, authenticated;

-- Saves the settings (validated by the edge function first). System context only.
create or replace function public.store_ad_tracking_set(p_config jsonb, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_merchant uuid := public.current_merchant_id();
begin
  perform public._require_system();
  if v_merchant is null then
    raise exception 'MERCHANT_REQUIRED' using errcode = '42501';
  end if;
  if jsonb_typeof(p_config) <> 'object' then
    raise exception 'VALIDATION: settings must be an object' using errcode = '22023';
  end if;
  insert into public.store_ad_tracking (merchant_id, config, updated_by, updated_at)
  values (v_merchant, p_config, p_actor, now())
  on conflict (merchant_id) do update set config = excluded.config, updated_by = excluded.updated_by, updated_at = now();
  return p_config;
end;
$$;

-- Queues the Purchase for an order from the store, at the moment the merchant picked.
create or replace function public._queue_ad_purchase()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c jsonb;
  v_on text;
  v_fire boolean;
begin
  if new.source <> 'STOREFRONT' or new.sales_channel_id is not null then
    return new;
  end if;
  select config into c from public.store_ad_tracking where merchant_id = new.merchant_id;
  if c is null or not coalesce((c ->> 'enabled')::boolean, false) or not coalesce((c ->> 'server_events')::boolean, true) then
    return new;
  end if;
  v_on := coalesce(c ->> 'purchase_on', 'placed');
  v_fire := case v_on
    when 'placed' then tg_op = 'INSERT'
    when 'confirmed' then new.status in ('CONFIRMED', 'PRE_ORDER', 'PROCESSING', 'PRODUCTION', 'QUALITY_CHECK', 'PACKING',
                                         'READY_TO_SHIP', 'SHIPPED', 'DELIVERED', 'PARTIALLY_DELIVERED')
    when 'delivered' then new.status in ('DELIVERED', 'PARTIALLY_DELIVERED')
    else false end;
  if v_fire then
    insert into public.ad_event_queue (merchant_id, order_id, event, event_id)
    values (new.merchant_id, new.id, 'Purchase', 'ffs_pu_' || regexp_replace(new.order_number, '[^A-Za-z0-9_-]', '', 'g'))
    on conflict (order_id, event) do nothing;
  end if;
  return new;
end;
$$;
drop trigger if exists orders_ad_purchase on public.orders;
create trigger orders_ad_purchase after insert or update of status on public.orders
  for each row execute function public._queue_ad_purchase();

-- Due events for the job run (this merchant only, through row-level security).
create or replace function public.ad_event_due(p_limit int default 20)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._require_system();
  return coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'order_id', q.order_id, 'event', q.event, 'event_id', q.event_id,
      'attempts', q.attempts) order by q.next_at)
    from (select * from public.ad_event_queue where merchant_id = public.current_merchant_id() and status = 'PENDING' and next_at <= now()
          order by next_at limit greatest(1, least(coalesce(p_limit, 20), 100)) for update skip locked) q), '[]'::jsonb);
end;
$$;

-- Everything the server copy needs about one order.
create or replace function public.ad_event_order(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  o public.orders;
  a public.order_attributions;
  v_tier text;
begin
  perform public._require_system();
  select * into o from public.orders where id = p_order_id and merchant_id = public.current_merchant_id();
  if o.id is null then
    return null;
  end if;
  select * into a from public.order_attributions where order_id = o.id;
  select fc.metrics ->> 'receive_rate_tier' into v_tier from public.fraud_checks fc where fc.id = o.fraud_check_id;
  return jsonb_build_object(
    'order_number', o.order_number, 'status', o.status, 'total', o.total_amount,
    'currency', coalesce(nullif(public.get_setting('store') ->> 'currency', ''), 'BDT'),
    'customer_name', o.customer_name, 'customer_phone', o.customer_phone, 'customer_email', o.customer_email,
    'city', coalesce(o.shipping_city, o.shipping_area), 'district', o.shipping_district,
    'client_ip', o.client_ip, 'user_agent', o.user_agent, 'created_at', o.created_at,
    'merged_into', o.merged_into, 'duplicate_of', o.duplicate_of, 'receive_rate_tier', v_tier,
    'visitor_id', a.visitor_id, 'click_id', a.click_id, 'click_id_type', a.click_id_type, 'landing_page', a.landing_page,
    'browser_ids', a.browser_ids,
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', i.product_id, 'name', i.product_name, 'quantity', i.quantity, 'price', i.unit_price)
                        order by i.created_at) from public.order_items i where i.order_id = o.id), '[]'::jsonb));
end;
$$;

-- Records the outcome. DONE / PARTIAL (some platforms failed) / SKIPPED are
-- final; a failure is retried with a growing wait, then marked FAILED.
create or replace function public.ad_event_result(p_id uuid, p_status text, p_results jsonb, p_error text default null, p_retry boolean default false)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_attempts int;
begin
  perform public._require_system();
  if p_status not in ('DONE', 'PARTIAL', 'FAILED', 'SKIPPED') then
    raise exception 'VALIDATION: bad status' using errcode = '22023';
  end if;
  update public.ad_event_queue set attempts = attempts + 1 where id = p_id and merchant_id = public.current_merchant_id()
  returning attempts into v_attempts;
  if v_attempts is null then
    return;
  end if;
  if p_status = 'FAILED' and p_retry and v_attempts < 6 then
    update public.ad_event_queue set status = 'PENDING', next_at = now() + make_interval(mins => power(2, v_attempts)::int),
      results = p_results, last_error = left(p_error, 300)
    where id = p_id;
  else
    update public.ad_event_queue set status = p_status, results = p_results, last_error = left(p_error, 300), done_at = now()
    where id = p_id;
  end if;
end;
$$;

revoke execute on function public.order_set_browser_ids(uuid, jsonb), public.store_ad_tracking_set(jsonb, uuid),
  public.ad_event_due(int), public.ad_event_order(uuid), public.ad_event_result(uuid, text, jsonb, text, boolean)
  from public, anon, authenticated;
grant execute on function public.order_set_browser_ids(uuid, jsonb), public.store_ad_tracking_set(jsonb, uuid),
  public.ad_event_due(int), public.ad_event_order(uuid), public.ad_event_result(uuid, text, jsonb, text, boolean)
  to service_role, app_owner;

select public._tenancy_own_functions();
