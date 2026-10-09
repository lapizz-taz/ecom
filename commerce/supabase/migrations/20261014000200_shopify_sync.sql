-- =============================================================================
-- Shopify fulfilment and inventory sync.
--
-- Fulfilment: when an order imported from Shopify becomes SHIPPED here, a
-- durable job creates the fulfilment on Shopify (fulfilment-order workflow)
-- with the courier, tracking number and the courier's real tracking link, and
-- asks Shopify to send its own shipping e-mail. The order counts as fulfilled
-- on Shopify only after Shopify confirms. Approve / RTS / Delivered never
-- touch Shopify. Fulfilments made by hand in Shopify are recorded here.
--
-- Inventory: this app's stock is the source of truth. Mapped variants push
-- their available quantity (on hand − reserved) to one Shopify location.
-- Shopify already lowered its own count when a Shopify order was placed and we
-- reserve the same quantity on import, so both sides move once. Unexplained
-- changes made in Shopify are flagged for reconciliation, never silently
-- overwritten (unless the channel says "this app wins").
--
-- Jobs: channel_sync_jobs is a small durable queue (claimed with SKIP LOCKED,
-- retried with exponential back-off, failed jobs kept for manual retry).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Jobs
-- -----------------------------------------------------------------------------
create table if not exists public.channel_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.sales_channels(id),
  kind text not null check (kind in ('FULFILL', 'INVENTORY')),
  ref_id uuid not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'RUNNING', 'DONE', 'FAILED')),
  attempts int not null default 0,
  max_attempts int not null default 8,
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  payload jsonb not null default '{}'::jsonb,
  last_error text,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  done_at timestamptz
);
-- One open job per thing: re-enqueueing just wakes it.
create unique index if not exists channel_sync_jobs_open_uq on public.channel_sync_jobs(channel_id, kind, ref_id)
  where status in ('PENDING', 'RUNNING');
create index if not exists channel_sync_jobs_due_idx on public.channel_sync_jobs(next_attempt_at) where status = 'PENDING';
create index if not exists channel_sync_jobs_recent_idx on public.channel_sync_jobs(created_at desc);
create or replace trigger channel_sync_jobs_updated_at before update on public.channel_sync_jobs
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Fulfilments (ours and ones made in Shopify)
-- -----------------------------------------------------------------------------
create table if not exists public.channel_fulfillments (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.sales_channels(id),
  order_id uuid not null references public.orders(id),
  external_order_id text not null,
  source text not null default 'APP' check (source in ('APP', 'SHOPIFY')),
  status text not null default 'PENDING'
    check (status in ('PENDING', 'NEEDS_TRACKING', 'PROCESSING', 'FULFILLED', 'FAILED', 'SKIPPED')),
  fulfillment_id text,
  fulfillment_order_ids text[] not null default '{}',
  line_items jsonb not null default '[]'::jsonb,
  courier text,
  tracking_number text,
  tracking_url text,
  shipped_at timestamptz,
  shopify_status text,
  notify_requested boolean not null default false,
  notification_status text check (notification_status in ('REQUESTED', 'NO_EMAIL', 'DISABLED')),
  notification_note text,
  attempts int not null default 0,
  last_error text,
  fulfilled_at timestamptz,
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists channel_fulfillments_app_uq on public.channel_fulfillments(order_id) where source = 'APP';
create unique index if not exists channel_fulfillments_gid_uq on public.channel_fulfillments(fulfillment_id) where fulfillment_id is not null;
create index if not exists channel_fulfillments_channel_idx on public.channel_fulfillments(channel_id, created_at desc);
create or replace trigger channel_fulfillments_updated_at before update on public.channel_fulfillments
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Catalog and inventory mapping
-- -----------------------------------------------------------------------------
alter table public.sales_channel_variants add column if not exists inventory_item_id text;
alter table public.sales_channel_variants add column if not exists sku text;
alter table public.sales_channel_variants add column if not exists shopify_available int;
alter table public.sales_channel_variants add column if not exists last_pushed_qty int;
alter table public.sales_channel_variants add column if not exists sync_status text not null default 'NEW'
  check (sync_status in ('NEW', 'OK', 'PENDING', 'MISMATCH', 'FAILED', 'UNTRACKED'));
alter table public.sales_channel_variants add column if not exists last_error text;
alter table public.sales_channel_variants add column if not exists synced_at timestamptz;
alter table public.sales_channel_variants add column if not exists mismatch_since timestamptz;
create index if not exists sales_channel_variants_variant_idx on public.sales_channel_variants(variant_id);
create index if not exists sales_channel_variants_item_idx on public.sales_channel_variants(channel_id, inventory_item_id);

-- What the store sells, as last imported (to link by SKU and to review).
create table if not exists public.channel_catalog_items (
  channel_id uuid not null references public.sales_channels(id),
  external_variant_id text not null,
  external_product_id text,
  inventory_item_id text,
  sku text,
  barcode text,
  product_title text,
  variant_title text,
  product_status text,
  tracked boolean not null default true,
  levels jsonb not null default '[]'::jsonb,
  imported_at timestamptz not null default now(),
  primary key (channel_id, external_variant_id)
);
create index if not exists channel_catalog_items_sku_idx on public.channel_catalog_items(channel_id, lower(sku));

alter table public.sales_channels add column if not exists locations jsonb not null default '[]'::jsonb;
alter table public.sales_channels add column if not exists catalog_imported_at timestamptz;

alter table public.channel_sync_jobs enable row level security;
alter table public.channel_fulfillments enable row level security;
alter table public.channel_catalog_items enable row level security;
revoke all on public.channel_sync_jobs, public.channel_fulfillments, public.channel_catalog_items from anon, authenticated;
grant all on public.channel_sync_jobs, public.channel_fulfillments, public.channel_catalog_items to service_role;

-- Channel options (kept with the other channel settings).
create or replace function public._channel_opt(p_channel public.sales_channels, p_key text, p_default boolean)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$ select coalesce((p_channel.settings ->> p_key)::boolean, p_default) $$;

-- -----------------------------------------------------------------------------
-- Queue
-- -----------------------------------------------------------------------------
create or replace function public.channel_job_enqueue(p_channel_id uuid, p_kind text, p_ref_id uuid, p_payload jsonb default '{}'::jsonb, p_delay_seconds int default 0)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into public.channel_sync_jobs(channel_id, kind, ref_id, payload, next_attempt_at)
  values (p_channel_id, p_kind, p_ref_id, coalesce(p_payload, '{}'::jsonb), now() + make_interval(secs => greatest(p_delay_seconds, 0)))
  on conflict (channel_id, kind, ref_id) where status in ('PENDING', 'RUNNING') do update
    set payload = channel_sync_jobs.payload || excluded.payload,
        next_attempt_at = least(channel_sync_jobs.next_attempt_at, excluded.next_attempt_at)
  returning id into v_id;
  return v_id;
end;
$$;

-- Worker: take due jobs (a RUNNING job whose worker vanished is taken again).
create or replace function public.channel_jobs_claim(p_limit int default 20)
returns setof public.channel_sync_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._require_system();
  return query
  update public.channel_sync_jobs j set status = 'RUNNING', attempts = j.attempts + 1, locked_until = now() + interval '3 minutes'
  where j.id in (
    select id from public.channel_sync_jobs
    where (status = 'PENDING' and next_attempt_at <= now()) or (status = 'RUNNING' and locked_until < now())
    order by next_attempt_at
    limit least(greatest(p_limit, 1), 100)
    for update skip locked)
  returning j.*;
end;
$$;

-- p_outcome: DONE | RETRY (back off and try again) | FAILED (needs a person)
create or replace function public.channel_job_finish(p_id uuid, p_outcome text, p_error text default null, p_result jsonb default null, p_delay_seconds int default null)
returns public.channel_sync_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.channel_sync_jobs;
begin
  perform public._require_system();
  select * into v_job from public.channel_sync_jobs where id = p_id for update;
  if not found then
    raise exception 'NOT_FOUND: job not found' using errcode = 'P0002';
  end if;
  if p_outcome = 'DONE' then
    update public.channel_sync_jobs set status = 'DONE', done_at = now(), last_error = null, result = p_result, locked_until = null
    where id = p_id returning * into v_job;
  elsif p_outcome = 'RETRY' and v_job.attempts < v_job.max_attempts then
    update public.channel_sync_jobs set status = 'PENDING', locked_until = null, last_error = left(p_error, 1000), result = p_result,
      next_attempt_at = now() + make_interval(secs => coalesce(p_delay_seconds, least(30 * power(2, v_job.attempts - 1), 21600)::int))
    where id = p_id returning * into v_job;
  else
    update public.channel_sync_jobs set status = 'FAILED', locked_until = null, last_error = left(coalesce(p_error, 'Failed'), 1000), result = p_result
    where id = p_id returning * into v_job;
  end if;
  return v_job;
end;
$$;

-- -----------------------------------------------------------------------------
-- Fulfilment: queued when a Shopify order is shipped here
-- -----------------------------------------------------------------------------
create or replace function public._queue_channel_fulfillment(p_order_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_channel public.sales_channels;
  v_f public.channel_fulfillments;
begin
  select * into v_order from public.orders where id = p_order_id;
  if v_order.sales_channel_id is null or v_order.external_order_id is null then
    return null;
  end if;
  select * into v_channel from public.sales_channels where id = v_order.sales_channel_id;
  if v_channel.platform <> 'SHOPIFY' or not public._channel_opt(v_channel, 'fulfill_on_ship', true) then
    return null;
  end if;
  insert into public.channel_fulfillments(channel_id, order_id, external_order_id, status)
  values (v_channel.id, v_order.id, v_order.external_order_id, 'PENDING')
  on conflict (order_id) where source = 'APP' do update
    set status = case when channel_fulfillments.status in ('FULFILLED', 'PROCESSING') then channel_fulfillments.status else 'PENDING' end
  returning * into v_f;
  if v_f.status = 'PENDING' then
    perform public.channel_job_enqueue(v_channel.id, 'FULFILL', v_order.id);
  end if;
  return v_f.id;
end;
$$;

create or replace function public._orders_channel_ship_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'SHIPPED' and old.status is distinct from 'SHIPPED' and new.sales_channel_id is not null then
    perform public._queue_channel_fulfillment(new.id);
  end if;
  return new;
end;
$$;
create or replace trigger orders_channel_ship after update of status on public.orders
  for each row when (new.status = 'SHIPPED' and old.status is distinct from new.status and new.sales_channel_id is not null)
  execute function public._orders_channel_ship_trigger();

-- A tracking number added after the order shipped wakes the waiting fulfilment.
create or replace function public._shipments_tracking_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_f public.channel_fulfillments;
begin
  if coalesce(new.consignment_id, new.tracking_number) is not null
     and (old.consignment_id is distinct from new.consignment_id or old.tracking_number is distinct from new.tracking_number) then
    update public.channel_fulfillments set status = 'PENDING', last_error = null
    where order_id = new.order_id and source = 'APP' and status = 'NEEDS_TRACKING'
    returning * into v_f;
    if found then
      perform public.channel_job_enqueue(v_f.channel_id, 'FULFILL', v_f.order_id);
    end if;
  end if;
  return new;
end;
$$;
create or replace trigger shipments_channel_tracking after update of consignment_id, tracking_number on public.shipments
  for each row execute function public._shipments_tracking_trigger();

-- Everything the worker needs to fulfil one order (system only).
create or replace function public.channel_fulfillment_context(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_f public.channel_fulfillments;
  v_ship record;
begin
  perform public._require_system();
  select * into v_order from public.orders where id = p_order_id;
  select * into v_f from public.channel_fulfillments where order_id = p_order_id and source = 'APP';
  select s.consignment_id, s.tracking_number, s.created_at, s.status, c.name as courier_name, c.provider, c.tracking_url_template
  into v_ship from public.shipments s join public.couriers c on c.id = s.courier_id
  where s.order_id = p_order_id and s.is_active order by s.created_at desc limit 1;
  return jsonb_build_object(
    'order', jsonb_build_object('id', v_order.id, 'order_number', v_order.order_number, 'status', v_order.status,
      'external_order_id', v_order.external_order_id, 'customer_email', v_order.customer_email, 'shipped_at', v_order.shipped_at),
    'fulfillment', to_jsonb(v_f),
    'shipment', case when v_ship is null then null else jsonb_build_object(
      'courier', v_ship.courier_name, 'provider', v_ship.provider,
      'tracking', coalesce(v_ship.consignment_id, v_ship.tracking_number),
      'tracking_url', case when v_ship.tracking_url_template is not null and coalesce(v_ship.consignment_id, v_ship.tracking_number) is not null
        then replace(v_ship.tracking_url_template, '{tracking}', coalesce(v_ship.consignment_id, v_ship.tracking_number)) end,
      'shipped_at', v_ship.created_at) end,
    -- Our lines with the Shopify variant each came from.
    'lines', coalesce((select jsonb_agg(jsonb_build_object('variant_id', i.variant_id, 'sku', i.sku,
        'quantity', i.quantity - i.returned_quantity,
        'external_variant_id', (select m.external_variant_id from public.sales_channel_variants m
                                where m.channel_id = v_order.sales_channel_id and m.variant_id = i.variant_id limit 1)))
      from public.order_items i where i.order_id = p_order_id), '[]'::jsonb)
  );
end;
$$;

-- Worker writes the outcome of one attempt. FULFILLED only with Shopify's id.
create or replace function public.channel_fulfillment_update(p_order_id uuid, p jsonb)
returns public.channel_fulfillments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old public.channel_fulfillments;
  v_row public.channel_fulfillments;
  v_status text := p ->> 'status';
begin
  perform public._require_system();
  select * into v_old from public.channel_fulfillments where order_id = p_order_id and source = 'APP' for update;
  if not found then
    raise exception 'NOT_FOUND: no fulfilment for this order' using errcode = 'P0002';
  end if;
  if v_status = 'FULFILLED' and nullif(p ->> 'fulfillment_id', '') is null then
    raise exception 'VALIDATION: a fulfilment is only recorded with Shopify''s fulfilment id' using errcode = '22023';
  end if;
  update public.channel_fulfillments set
    status = coalesce(v_status, status),
    fulfillment_id = coalesce(nullif(p ->> 'fulfillment_id', ''), fulfillment_id),
    fulfillment_order_ids = coalesce((select array_agg(x) from jsonb_array_elements_text(p -> 'fulfillment_order_ids') x), fulfillment_order_ids),
    line_items = coalesce(p -> 'line_items', line_items),
    courier = coalesce(p ->> 'courier', courier),
    tracking_number = coalesce(p ->> 'tracking_number', tracking_number),
    tracking_url = coalesce(p ->> 'tracking_url', tracking_url),
    shipped_at = coalesce((p ->> 'shipped_at')::timestamptz, shipped_at),
    shopify_status = coalesce(p ->> 'shopify_status', shopify_status),
    notify_requested = coalesce((p ->> 'notify_requested')::boolean, notify_requested),
    notification_status = coalesce(p ->> 'notification_status', notification_status),
    notification_note = coalesce(p ->> 'notification_note', notification_note),
    attempts = attempts + case when (p ->> 'attempted')::boolean then 1 else 0 end,
    last_error = case when p ? 'error' then nullif(p ->> 'error', '') else last_error end,
    fulfilled_at = case when v_status = 'FULFILLED' and v_old.status <> 'FULFILLED' then now() else fulfilled_at end,
    synced_at = now()
  where id = v_old.id returning * into v_row;

  if v_row.status is distinct from v_old.status then
    perform public._order_log(p_order_id, 'CHANNEL_FULFILLMENT',
      case v_row.status
        when 'FULFILLED' then format('Fulfilled on Shopify%s%s', coalesce(' · ' || v_row.courier, ''), coalesce(' ' || v_row.tracking_number, ''))
          || case v_row.notification_status when 'REQUESTED' then ' — Shopify asked to e-mail the customer'
               when 'NO_EMAIL' then ' — no customer e-mail on the order, so no shipping e-mail' else '' end
        when 'NEEDS_TRACKING' then 'Shopify not fulfilled yet: add the courier tracking number'
        when 'FAILED' then format('Shopify fulfilment failed: %s', coalesce(v_row.last_error, 'unknown error'))
        when 'SKIPPED' then format('Shopify fulfilment skipped: %s', coalesce(v_row.last_error, ''))
        else format('Shopify fulfilment %s', lower(v_row.status)) end,
      null, null, jsonb_build_object('fulfillment_id', v_row.fulfillment_id, 'status', v_row.status));
  end if;
  return v_row;
end;
$$;

-- Fulfilments Shopify reports for an order (webhook or sync). Ours are matched
-- by id or tracking number; others (made in Shopify) are recorded once.
create or replace function public.channel_fulfillments_seen(p_channel_id uuid, p_external_order_id text, p_fulfillments jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_f jsonb;
  v_app public.channel_fulfillments;
  v_new int := 0;
begin
  perform public._require_system();
  select * into v_order from public.orders where sales_channel_id = p_channel_id and external_order_id = p_external_order_id;
  if not found then
    return jsonb_build_object('status', 'UNKNOWN_ORDER');
  end if;
  select * into v_app from public.channel_fulfillments where order_id = v_order.id and source = 'APP' for update;
  for v_f in select * from jsonb_array_elements(coalesce(p_fulfillments, '[]'::jsonb)) loop
    continue when nullif(v_f ->> 'id', '') is null or v_f ->> 'status' in ('CANCELLED', 'ERROR', 'FAILURE');
    if exists (select 1 from public.channel_fulfillments where fulfillment_id = v_f ->> 'id') then
      update public.channel_fulfillments set shopify_status = coalesce(v_f ->> 'display_status', v_f ->> 'status'), synced_at = now()
      where fulfillment_id = v_f ->> 'id';
      continue;
    end if;
    -- Our own request that succeeded but whose answer we never got.
    if v_app.id is not null and v_app.status <> 'FULFILLED' and v_app.tracking_number is not null
       and v_app.tracking_number = v_f ->> 'tracking_number' then
      update public.channel_fulfillments set status = 'FULFILLED', fulfillment_id = v_f ->> 'id', fulfilled_at = now(), synced_at = now(),
        shopify_status = coalesce(v_f ->> 'display_status', v_f ->> 'status'), last_error = null
      where id = v_app.id;
      perform public._order_log(v_order.id, 'CHANNEL_FULFILLMENT', 'Fulfilled on Shopify (confirmed by Shopify)', null, null,
        jsonb_build_object('fulfillment_id', v_f ->> 'id'));
      continue;
    end if;
    insert into public.channel_fulfillments(channel_id, order_id, external_order_id, source, status, fulfillment_id,
      courier, tracking_number, tracking_url, shopify_status, fulfilled_at, synced_at, shipped_at)
    values (p_channel_id, v_order.id, p_external_order_id, 'SHOPIFY', 'FULFILLED', v_f ->> 'id',
      nullif(v_f ->> 'tracking_company', ''), nullif(v_f ->> 'tracking_number', ''), nullif(v_f ->> 'tracking_url', ''),
      coalesce(v_f ->> 'display_status', v_f ->> 'status'), coalesce((v_f ->> 'created_at')::timestamptz, now()), now(),
      (v_f ->> 'created_at')::timestamptz)
    on conflict do nothing;
    v_new := v_new + 1;
    perform public._order_log(v_order.id, 'CHANNEL_FULFILLMENT',
      format('Fulfilled by hand in Shopify%s%s', coalesce(' · ' || nullif(v_f ->> 'tracking_company', ''), ''), coalesce(' ' || nullif(v_f ->> 'tracking_number', ''), '')),
      null, null, jsonb_build_object('fulfillment_id', v_f ->> 'id'));
    -- Fulfilled in Shopify before we shipped it: our own request is no longer needed.
    if v_app.id is not null and v_app.status in ('PENDING', 'NEEDS_TRACKING', 'FAILED') and (v_f ->> 'all_fulfilled')::boolean then
      update public.channel_fulfillments set status = 'SKIPPED', last_error = 'Already fulfilled in Shopify' where id = v_app.id;
    end if;
  end loop;
  return jsonb_build_object('status', 'OK', 'recorded', v_new);
end;
$$;

-- Staff: try a failed / waiting fulfilment again now.
create or replace function public.channel_fulfillment_retry(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_f public.channel_fulfillments;
  v_order public.orders;
begin
  perform public.require_permission('orders.update');
  select * into v_order from public.orders where id = p_order_id;
  if not found then
    raise exception 'NOT_FOUND: order not found' using errcode = 'P0002';
  end if;
  if v_order.status not in ('SHIPPED', 'DELIVERED', 'PARTIALLY_DELIVERED') then
    raise exception 'VALIDATION: only shipped orders are fulfilled on Shopify' using errcode = '22023';
  end if;
  perform public._queue_channel_fulfillment(p_order_id);
  update public.channel_fulfillments set status = 'PENDING', last_error = null
  where order_id = p_order_id and source = 'APP' and status in ('FAILED', 'NEEDS_TRACKING', 'SKIPPED')
  returning * into v_f;
  select * into v_f from public.channel_fulfillments where order_id = p_order_id and source = 'APP';
  if v_f.status = 'PENDING' then
    perform public.channel_job_enqueue(v_f.channel_id, 'FULFILL', p_order_id);
    update public.channel_sync_jobs set status = 'PENDING', attempts = 0, next_attempt_at = now()
    where kind = 'FULFILL' and ref_id = p_order_id and status = 'FAILED'
      and not exists (select 1 from public.channel_sync_jobs o where o.kind = 'FULFILL' and o.ref_id = p_order_id and o.status in ('PENDING', 'RUNNING'));
  end if;
  perform public.log_audit('channel.fulfillment_retry', 'order', p_order_id::text, null, jsonb_build_object('status', v_f.status));
  return jsonb_build_object('status', v_f.status);
end;
$$;

-- Order page: Shopify reference, fulfilments and their state.
create or replace function public.order_channel_info(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
begin
  perform public.require_permission('orders.view');
  select * into v_order from public.orders where id = p_order_id;
  if v_order.sales_channel_id is null then
    return null;
  end if;
  return jsonb_build_object(
    'channel', (select jsonb_build_object('id', c.id, 'name', c.name, 'platform', c.platform, 'shop_domain', c.shop_domain,
      'fulfill_on_ship', public._channel_opt(c, 'fulfill_on_ship', true), 'notify_customer', public._channel_opt(c, 'notify_customer', true))
      from public.sales_channels c where c.id = v_order.sales_channel_id),
    'external_order_id', v_order.external_order_id, 'external_order_number', v_order.external_order_number,
    'fulfillments', coalesce((select jsonb_agg(jsonb_build_object(
        'id', f.id, 'source', f.source, 'status', f.status, 'fulfillment_id', f.fulfillment_id, 'courier', f.courier,
        'tracking_number', f.tracking_number, 'tracking_url', f.tracking_url, 'shopify_status', f.shopify_status,
        'notification_status', f.notification_status, 'notification_note', f.notification_note, 'line_items', f.line_items,
        'attempts', f.attempts, 'last_error', f.last_error, 'fulfilled_at', f.fulfilled_at, 'synced_at', f.synced_at, 'created_at', f.created_at)
      order by f.created_at) from public.channel_fulfillments f where f.order_id = p_order_id), '[]'::jsonb),
    'job', (select jsonb_build_object('status', j.status, 'attempts', j.attempts, 'next_attempt_at', j.next_attempt_at, 'last_error', j.last_error)
      from public.channel_sync_jobs j where j.kind = 'FULFILL' and j.ref_id = p_order_id order by j.created_at desc limit 1)
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Inventory
-- -----------------------------------------------------------------------------
-- Stock changed here → queue a push for every connected store selling it.
create or replace function public._inventory_channel_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_m record;
begin
  if new.available is not distinct from old.available then
    return new;
  end if;
  for v_m in
    select m.channel_id, m.variant_id from public.sales_channel_variants m
    join public.sales_channels c on c.id = m.channel_id
    where m.variant_id = new.variant_id and m.inventory_item_id is not null and c.status = 'CONNECTED'
      and public._channel_opt(c, 'inventory_sync', false) and nullif(c.settings ->> 'location_id', '') is not null
  loop
    update public.sales_channel_variants set sync_status = 'PENDING'
    where channel_id = v_m.channel_id and variant_id = v_m.variant_id and sync_status in ('OK', 'NEW', 'FAILED');
    perform public.channel_job_enqueue(v_m.channel_id, 'INVENTORY', v_m.variant_id);
  end loop;
  return new;
end;
$$;
create or replace trigger inventory_channel_sync after update of on_hand, reserved on public.inventory
  for each row execute function public._inventory_channel_trigger();

-- Worker: what to set for one mapped variant.
create or replace function public.channel_inventory_context(p_channel_id uuid, p_variant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._require_system();
  return (
    select jsonb_build_object(
      'variant_id', m.variant_id, 'external_variant_id', m.external_variant_id, 'inventory_item_id', m.inventory_item_id,
      'location_id', c.settings ->> 'location_id', 'policy', coalesce(c.settings ->> 'external_changes', 'FLAG'),
      'sync_on', public._channel_opt(c, 'inventory_sync', false),
      'desired', greatest(coalesce(i.available, 0), 0), 'track_inventory', p.track_inventory,
      'last_pushed_qty', m.last_pushed_qty, 'shopify_available', m.shopify_available, 'mismatch_since', m.mismatch_since,
      'sku', v.sku)
    from public.sales_channel_variants m
    join public.sales_channels c on c.id = m.channel_id
    join public.product_variants v on v.id = m.variant_id
    join public.products p on p.id = v.product_id
    left join public.inventory i on i.variant_id = m.variant_id
    where m.channel_id = p_channel_id and m.variant_id = p_variant_id
    limit 1);
end;
$$;

create or replace function public.channel_inventory_update(p_channel_id uuid, p_variant_id uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._require_system();
  update public.sales_channel_variants set
    shopify_available = case when p ? 'shopify_available' then (p ->> 'shopify_available')::int else shopify_available end,
    last_pushed_qty = case when p ? 'last_pushed_qty' then (p ->> 'last_pushed_qty')::int else last_pushed_qty end,
    sync_status = coalesce(p ->> 'sync_status', sync_status),
    last_error = case when p ? 'error' then nullif(p ->> 'error', '') else last_error end,
    mismatch_since = case when p ->> 'sync_status' = 'MISMATCH' then coalesce(mismatch_since, now())
                          when p ? 'sync_status' then null else mismatch_since end,
    synced_at = now()
  where channel_id = p_channel_id and variant_id = p_variant_id;
end;
$$;

-- Shopify told us a level changed (webhook). Our own pushes come back with the
-- quantity we set and are ignored; anything else is checked by a job.
create or replace function public.channel_inventory_seen(p_channel_id uuid, p_inventory_item_id text, p_location_id text, p_available int)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_c public.sales_channels;
  v_m public.sales_channel_variants;
  v_queued int := 0;
begin
  perform public._require_system();
  select * into v_c from public.sales_channels where id = p_channel_id;
  if coalesce(v_c.settings ->> 'location_id', '') <> p_location_id then
    return jsonb_build_object('status', 'OTHER_LOCATION');
  end if;
  for v_m in select * from public.sales_channel_variants where channel_id = p_channel_id and inventory_item_id = p_inventory_item_id for update loop
    update public.sales_channel_variants set shopify_available = p_available, synced_at = now() where channel_id = v_m.channel_id and external_variant_id = v_m.external_variant_id;
    if p_available is distinct from v_m.last_pushed_qty and public._channel_opt(v_c, 'inventory_sync', false) then
      -- Give a Shopify order a moment to arrive and reserve stock here first.
      perform public.channel_job_enqueue(p_channel_id, 'INVENTORY', v_m.variant_id, '{"reason":"shopify_changed"}'::jsonb, 90);
      v_queued := v_queued + 1;
    end if;
  end loop;
  return jsonb_build_object('status', 'OK', 'queued', v_queued);
end;
$$;

-- Catalog import: what Shopify sells, at which locations. Links variants to
-- ours by SKU where that is unambiguous; everything else is listed for staff.
create or replace function public.channel_catalog_import(p_channel_id uuid, p_items jsonb, p_locations jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_loc text;
  v_linked int := 0;
begin
  perform public._require_system();
  select settings ->> 'location_id' into v_loc from public.sales_channels where id = p_channel_id;
  update public.sales_channels set locations = coalesce(p_locations, '[]'::jsonb), catalog_imported_at = now() where id = p_channel_id;
  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    insert into public.channel_catalog_items(channel_id, external_variant_id, external_product_id, inventory_item_id, sku, barcode,
      product_title, variant_title, product_status, tracked, levels, imported_at)
    values (p_channel_id, v_item ->> 'external_variant_id', v_item ->> 'external_product_id', v_item ->> 'inventory_item_id',
      nullif(trim(v_item ->> 'sku'), ''), nullif(trim(v_item ->> 'barcode'), ''), v_item ->> 'product_title', v_item ->> 'variant_title',
      v_item ->> 'product_status', coalesce((v_item ->> 'tracked')::boolean, true), coalesce(v_item -> 'levels', '[]'::jsonb), now())
    on conflict (channel_id, external_variant_id) do update set
      external_product_id = excluded.external_product_id, inventory_item_id = excluded.inventory_item_id, sku = excluded.sku,
      barcode = excluded.barcode, product_title = excluded.product_title, variant_title = excluded.variant_title,
      product_status = excluded.product_status, tracked = excluded.tracked, levels = excluded.levels, imported_at = now();
  end loop;

  -- Existing links (from imported orders) get the inventory item and SKU.
  update public.sales_channel_variants m set inventory_item_id = ci.inventory_item_id, sku = ci.sku,
    sync_status = case when not ci.tracked then 'UNTRACKED' when m.sync_status = 'UNTRACKED' then 'NEW' else m.sync_status end,
    shopify_available = (select (l ->> 'available')::int from jsonb_array_elements(ci.levels) l where l ->> 'location_id' = v_loc limit 1)
  from public.channel_catalog_items ci
  where ci.channel_id = p_channel_id and m.channel_id = p_channel_id and m.external_variant_id = ci.external_variant_id;

  -- New links: one Shopify SKU ↔ exactly one active variant of ours.
  insert into public.sales_channel_variants(channel_id, external_variant_id, external_product_id, variant_id, inventory_item_id, sku,
    shopify_available, sync_status)
  select ci.channel_id, ci.external_variant_id, ci.external_product_id, v.id, ci.inventory_item_id, ci.sku,
    (select (l ->> 'available')::int from jsonb_array_elements(ci.levels) l where l ->> 'location_id' = v_loc limit 1),
    case when ci.tracked then 'NEW' else 'UNTRACKED' end
  from public.channel_catalog_items ci
  join public.product_variants v on lower(v.sku) = lower(ci.sku) and v.is_active
  where ci.channel_id = p_channel_id and ci.sku is not null
    and not exists (select 1 from public.sales_channel_variants m where m.channel_id = ci.channel_id and m.external_variant_id = ci.external_variant_id)
    and (select count(*) from public.product_variants v2 where lower(v2.sku) = lower(ci.sku) and v2.is_active) = 1
    and (select count(*) from public.channel_catalog_items c2 where c2.channel_id = ci.channel_id and lower(c2.sku) = lower(ci.sku)) = 1
  on conflict do nothing;
  get diagnostics v_linked = row_count;

  return jsonb_build_object('items', jsonb_array_length(coalesce(p_items, '[]'::jsonb)), 'linked', v_linked,
    'mapped', (select count(*) from public.sales_channel_variants where channel_id = p_channel_id and inventory_item_id is not null));
end;
$$;

-- Staff screen: mapping, differences, unmapped and duplicate SKUs, jobs.
create or replace function public.channel_inventory_overview(p_channel_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_c public.sales_channels;
begin
  perform public.require_permission('inventory.view');
  select * into v_c from public.sales_channels where id = p_channel_id;
  if not found then
    raise exception 'NOT_FOUND: sales channel not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'channel', jsonb_build_object('id', v_c.id, 'name', v_c.name, 'status', v_c.status, 'locations', v_c.locations,
      'catalog_imported_at', v_c.catalog_imported_at, 'scopes', to_jsonb(v_c.scopes),
      'settings', jsonb_build_object(
        'inventory_sync', public._channel_opt(v_c, 'inventory_sync', false), 'location_id', v_c.settings ->> 'location_id',
        'external_changes', coalesce(v_c.settings ->> 'external_changes', 'FLAG'),
        'fulfill_on_ship', public._channel_opt(v_c, 'fulfill_on_ship', true), 'notify_customer', public._channel_opt(v_c, 'notify_customer', true),
        'fulfill_without_tracking', public._channel_opt(v_c, 'fulfill_without_tracking', false))),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'variant_id', m.variant_id, 'external_variant_id', m.external_variant_id, 'inventory_item_id', m.inventory_item_id,
        'sku', v.sku, 'product', p.name, 'variant', v.title, 'shopify_title', concat_ws(' — ', ci.product_title, nullif(ci.variant_title, 'Default Title')),
        'on_hand', coalesce(i.on_hand, 0), 'reserved', coalesce(i.reserved, 0), 'available', greatest(coalesce(i.available, 0), 0),
        'shopify', m.shopify_available, 'last_pushed', m.last_pushed_qty, 'status', m.sync_status, 'error', m.last_error,
        'synced_at', m.synced_at, 'track_inventory', p.track_inventory,
        'difference', case when m.shopify_available is null then null else m.shopify_available - greatest(coalesce(i.available, 0), 0) end)
      order by (m.shopify_available is distinct from greatest(coalesce(i.available, 0), 0)) desc, p.name, v.title)
      from public.sales_channel_variants m
      join public.product_variants v on v.id = m.variant_id
      join public.products p on p.id = v.product_id
      left join public.inventory i on i.variant_id = m.variant_id
      left join public.channel_catalog_items ci on ci.channel_id = m.channel_id and ci.external_variant_id = m.external_variant_id
      where m.channel_id = p_channel_id), '[]'::jsonb),
    'unmapped', coalesce((select jsonb_agg(jsonb_build_object('external_variant_id', ci.external_variant_id, 'sku', ci.sku,
        'title', concat_ws(' — ', ci.product_title, nullif(ci.variant_title, 'Default Title')), 'status', ci.product_status,
        'available', (select (l ->> 'available')::int from jsonb_array_elements(ci.levels) l where l ->> 'location_id' = v_c.settings ->> 'location_id' limit 1),
        'reason', case when ci.sku is null then 'NO_SKU'
                       when (select count(*) from public.channel_catalog_items c2 where c2.channel_id = ci.channel_id and lower(c2.sku) = lower(ci.sku)) > 1 then 'DUPLICATE_SKU_SHOPIFY'
                       when (select count(*) from public.product_variants v2 where lower(v2.sku) = lower(ci.sku) and v2.is_active) > 1 then 'DUPLICATE_SKU_HERE'
                       else 'NO_MATCH' end) order by ci.product_title, ci.variant_title)
      from public.channel_catalog_items ci
      where ci.channel_id = p_channel_id
        and not exists (select 1 from public.sales_channel_variants m where m.channel_id = ci.channel_id and m.external_variant_id = ci.external_variant_id)), '[]'::jsonb),
    'jobs', jsonb_build_object(
      'pending', (select count(*) from public.channel_sync_jobs where channel_id = p_channel_id and status in ('PENDING', 'RUNNING')),
      'failed', (select count(*) from public.channel_sync_jobs where channel_id = p_channel_id and status = 'FAILED')),
    'recent_jobs', coalesce((select jsonb_agg(jsonb_build_object('id', j.id, 'kind', j.kind, 'status', j.status, 'attempts', j.attempts,
        'last_error', j.last_error, 'updated_at', j.updated_at, 'ref_id', j.ref_id,
        'label', case when j.kind = 'FULFILL' then (select order_number from public.orders where id = j.ref_id)
                      else (select coalesce(pv.sku, pv.title) from public.product_variants pv where pv.id = j.ref_id) end)
        order by j.updated_at desc)
      from (select * from public.channel_sync_jobs where channel_id = p_channel_id order by updated_at desc limit 30) j), '[]'::jsonb),
    'fulfillments', coalesce((select jsonb_agg(x order by x ->> 'created_at' desc) from (
        select jsonb_build_object('order_id', f.order_id, 'order_number', o.order_number, 'status', f.status, 'source', f.source,
          'courier', f.courier, 'tracking_number', f.tracking_number, 'tracking_url', f.tracking_url, 'notification_status', f.notification_status,
          'last_error', f.last_error, 'created_at', f.created_at, 'fulfilled_at', f.fulfilled_at) as x
        from public.channel_fulfillments f join public.orders o on o.id = f.order_id
        where f.channel_id = p_channel_id order by f.created_at desc limit 30) q), '[]'::jsonb)
  );
end;
$$;

-- p: inventory_sync, location_id, external_changes (FLAG | SAAS_WINS), fulfill_on_ship,
--    notify_customer, fulfill_without_tracking
create or replace function public.channel_sync_settings_save(p_channel_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old public.sales_channels;
  v_new jsonb;
  v_loc text;
begin
  perform public.require_permission('settings.manage');
  select * into v_old from public.sales_channels where id = p_channel_id for update;
  if not found then
    raise exception 'NOT_FOUND: sales channel not found' using errcode = 'P0002';
  end if;
  v_loc := coalesce(nullif(p ->> 'location_id', ''), v_old.settings ->> 'location_id');
  if v_loc is not null and not exists (select 1 from jsonb_array_elements(v_old.locations) l where l ->> 'id' = v_loc) then
    raise exception 'VALIDATION: choose one of the store''s locations (import the catalog first)' using errcode = '22023';
  end if;
  if coalesce((p ->> 'inventory_sync')::boolean, false) and v_loc is null then
    raise exception 'VALIDATION: choose the Shopify location to keep in step before turning stock sync on' using errcode = '22023';
  end if;
  if p ? 'external_changes' and p ->> 'external_changes' not in ('FLAG', 'SAAS_WINS') then
    raise exception 'VALIDATION: unknown policy' using errcode = '22023';
  end if;
  v_new := v_old.settings || jsonb_strip_nulls(jsonb_build_object(
    'inventory_sync', (p ->> 'inventory_sync')::boolean, 'location_id', v_loc, 'external_changes', p ->> 'external_changes',
    'fulfill_on_ship', (p ->> 'fulfill_on_ship')::boolean, 'notify_customer', (p ->> 'notify_customer')::boolean,
    'fulfill_without_tracking', (p ->> 'fulfill_without_tracking')::boolean));
  update public.sales_channels set settings = v_new where id = p_channel_id;

  -- Turning sync on (or moving location): today's Shopify numbers are the
  -- baseline; nothing is overwritten until staff review the differences.
  if (coalesce((v_new ->> 'inventory_sync')::boolean, false) and not public._channel_opt(v_old, 'inventory_sync', false))
     or v_loc is distinct from v_old.settings ->> 'location_id' then
    update public.sales_channel_variants m set last_pushed_qty = m.shopify_available,
      sync_status = case when m.inventory_item_id is null then m.sync_status
                         when m.shopify_available is null then 'NEW'
                         when m.shopify_available = (select greatest(coalesce(i.available, 0), 0) from public.inventory i where i.variant_id = m.variant_id) then 'OK'
                         else 'MISMATCH' end
    where m.channel_id = p_channel_id and m.sync_status <> 'UNTRACKED';
  end if;
  perform public.log_audit('channel.sync_settings', 'sales_channel', p_channel_id::text,
    jsonb_build_object('settings', v_old.settings), jsonb_build_object('settings', v_new));
  return v_new;
end;
$$;

-- Staff: link (or unlink with null) a Shopify variant to one of ours.
create or replace function public.channel_variant_link(p_channel_id uuid, p_external_variant_id text, p_variant_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ci public.channel_catalog_items;
begin
  perform public.require_permission('inventory.adjust');
  select * into v_ci from public.channel_catalog_items where channel_id = p_channel_id and external_variant_id = p_external_variant_id;
  if p_variant_id is null then
    update public.sales_channel_variants set inventory_item_id = null, sync_status = 'NEW'
    where channel_id = p_channel_id and external_variant_id = p_external_variant_id;
  else
    if not found then
      raise exception 'NOT_FOUND: import the store''s catalog first' using errcode = 'P0002';
    end if;
    insert into public.sales_channel_variants(channel_id, external_variant_id, external_product_id, variant_id, inventory_item_id, sku, sync_status)
    values (p_channel_id, p_external_variant_id, v_ci.external_product_id, p_variant_id, v_ci.inventory_item_id, v_ci.sku,
      case when v_ci.tracked then 'NEW' else 'UNTRACKED' end)
    on conflict (channel_id, external_variant_id) do update
      set variant_id = excluded.variant_id, inventory_item_id = excluded.inventory_item_id, sku = excluded.sku, sync_status = excluded.sync_status;
  end if;
  perform public.log_audit('channel.variant_link', 'sales_channel', p_channel_id::text, null,
    jsonb_build_object('external_variant_id', p_external_variant_id, 'variant_id', p_variant_id));
end;
$$;

-- Reconciliation. p_items: [{variant_id, action: 'PUSH' | 'ADOPT'}].
--   PUSH  → set Shopify to our available quantity (a job does it).
--   ADOPT → change our stock so available equals Shopify's (a recorded
--           inventory correction), then mark in step.
-- With p_apply = false nothing changes: the plan is returned.
create or replace function public.channel_inventory_reconcile(p_channel_id uuid, p_items jsonb, p_apply boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_m record;
  v_plan jsonb := '[]'::jsonb;
  v_delta int;
begin
  perform public.require_permission('inventory.adjust');
  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    select m.*, greatest(coalesce(i.available, 0), 0) as ours, coalesce(i.on_hand, 0) as on_hand, v.sku as our_sku
    into v_m from public.sales_channel_variants m
    join public.product_variants v on v.id = m.variant_id
    left join public.inventory i on i.variant_id = m.variant_id
    where m.channel_id = p_channel_id and m.variant_id = (v_item ->> 'variant_id')::uuid for update of m;
    continue when not found or v_m.inventory_item_id is null;
    if v_item ->> 'action' = 'PUSH' then
      v_plan := v_plan || jsonb_build_object('variant_id', v_m.variant_id, 'sku', v_m.our_sku, 'action', 'PUSH',
        'from', v_m.shopify_available, 'to', v_m.ours);
      if p_apply then
        update public.sales_channel_variants set last_pushed_qty = shopify_available, sync_status = 'PENDING', mismatch_since = null
        where channel_id = p_channel_id and variant_id = v_m.variant_id;
        perform public.channel_job_enqueue(p_channel_id, 'INVENTORY', v_m.variant_id, '{"force":true}'::jsonb);
      end if;
    elsif v_item ->> 'action' = 'ADOPT' and v_m.shopify_available is not null then
      v_delta := v_m.shopify_available - v_m.ours;
      v_plan := v_plan || jsonb_build_object('variant_id', v_m.variant_id, 'sku', v_m.our_sku, 'action', 'ADOPT',
        'from', v_m.ours, 'to', v_m.shopify_available, 'on_hand_change', v_delta);
      if p_apply and v_delta <> 0 then
        perform public._apply_inventory_movement(v_m.variant_id, 'ADJUSTMENT', v_delta, 0, 0, 'CHANNEL', p_channel_id,
          'Shopify reconciliation', format('Shopify reconciliation: matched Shopify''s %s', v_m.shopify_available), null, false);
      end if;
      if p_apply then
        update public.sales_channel_variants set last_pushed_qty = shopify_available, sync_status = 'OK', mismatch_since = null, last_error = null
        where channel_id = p_channel_id and variant_id = v_m.variant_id;
      end if;
    end if;
  end loop;
  if p_apply then
    perform public.log_audit('channel.inventory_reconcile', 'sales_channel', p_channel_id::text, null, jsonb_build_object('plan', v_plan));
  end if;
  return jsonb_build_object('applied', p_apply, 'plan', v_plan);
end;
$$;

-- Staff: retry a failed job now.
create or replace function public.channel_job_retry(p_job_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('settings.manage');
  update public.channel_sync_jobs set status = 'PENDING', attempts = 0, next_attempt_at = now(), last_error = null
  where id = p_job_id and status = 'FAILED'
    and not exists (select 1 from public.channel_sync_jobs o where o.id <> p_job_id and o.channel_id = channel_sync_jobs.channel_id
                    and o.kind = channel_sync_jobs.kind and o.ref_id = channel_sync_jobs.ref_id and o.status in ('PENDING', 'RUNNING'));
  if not found then
    raise exception 'NOT_FOUND: no failed job to retry (it may already be running)' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public._channel_opt(public.sales_channels, text, boolean), public.channel_job_enqueue(uuid, text, uuid, jsonb, int),
  public.channel_jobs_claim(int), public.channel_job_finish(uuid, text, text, jsonb, int), public._queue_channel_fulfillment(uuid),
  public._orders_channel_ship_trigger(), public._shipments_tracking_trigger(), public.channel_fulfillment_context(uuid),
  public.channel_fulfillment_update(uuid, jsonb), public.channel_fulfillments_seen(uuid, text, jsonb), public.channel_fulfillment_retry(uuid),
  public.order_channel_info(uuid), public._inventory_channel_trigger(), public.channel_inventory_context(uuid, uuid),
  public.channel_inventory_update(uuid, uuid, jsonb), public.channel_inventory_seen(uuid, text, text, int),
  public.channel_catalog_import(uuid, jsonb, jsonb), public.channel_inventory_overview(uuid), public.channel_sync_settings_save(uuid, jsonb),
  public.channel_variant_link(uuid, text, uuid), public.channel_inventory_reconcile(uuid, jsonb, boolean), public.channel_job_retry(uuid)
from public, anon, authenticated;
grant execute on function public.channel_job_enqueue(uuid, text, uuid, jsonb, int), public.channel_jobs_claim(int),
  public.channel_job_finish(uuid, text, text, jsonb, int), public.channel_fulfillment_context(uuid), public.channel_fulfillment_update(uuid, jsonb),
  public.channel_fulfillments_seen(uuid, text, jsonb), public.channel_inventory_context(uuid, uuid), public.channel_inventory_update(uuid, uuid, jsonb),
  public.channel_inventory_seen(uuid, text, text, int), public.channel_catalog_import(uuid, jsonb, jsonb)
to service_role;
grant execute on function public.channel_fulfillment_retry(uuid), public.order_channel_info(uuid), public.channel_inventory_overview(uuid),
  public.channel_sync_settings_save(uuid, jsonb), public.channel_variant_link(uuid, text, uuid), public.channel_inventory_reconcile(uuid, jsonb, boolean),
  public.channel_job_retry(uuid)
to authenticated;

-- A Shopify order lowered Shopify's own count when it was placed. When we
-- import it (the order gets its store link in the same transaction that
-- created it and reserved the stock), Shopify is already where it should be:
-- move our "last pushed" marker down too, so this is not mistaken for a change
-- made in Shopify and nothing is pushed twice.
create or replace function public._orders_channel_import_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.source = 'API' and new.created_at = now() then
    update public.sales_channel_variants m set last_pushed_qty = m.last_pushed_qty - r.qty
    from (select variant_id, sum(quantity)::int as qty from public.stock_reservations
          where order_id = new.id and status = 'ACTIVE' group by variant_id) r
    where m.channel_id = new.sales_channel_id and m.variant_id = r.variant_id and m.last_pushed_qty is not null;
  end if;
  return new;
end;
$$;
create or replace trigger orders_channel_import after update of sales_channel_id on public.orders
  for each row when (old.sales_channel_id is null and new.sales_channel_id is not null)
  execute function public._orders_channel_import_trigger();
revoke all on function public._orders_channel_import_trigger() from public, anon, authenticated;
