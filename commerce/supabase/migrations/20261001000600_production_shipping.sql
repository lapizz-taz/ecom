-- =============================================================================
-- 0600 · Production / preparation pipeline and courier shipments
-- =============================================================================

create table public.production_orders (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  status public.production_status not null default 'WAITING',
  priority public.production_priority not null default 'NORMAL',
  assigned_to uuid references public.profiles(id) on delete set null,
  deadline date,
  notes text,
  rejection_count int not null default 0,
  started_at timestamptz,
  qc_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index production_orders_one_active on public.production_orders(order_id) where status <> 'CANCELLED';
create index production_orders_status_idx on public.production_orders(status, priority, deadline);
create index production_orders_assigned_idx on public.production_orders(assigned_to);
create trigger production_orders_updated_at before update on public.production_orders
  for each row execute function public.set_updated_at();

create table public.production_items (
  id uuid primary key default gen_random_uuid(),
  production_order_id uuid not null references public.production_orders(id) on delete cascade,
  order_item_id uuid references public.order_items(id) on delete set null,
  product_id uuid not null references public.products(id),
  variant_id uuid references public.product_variants(id),
  product_name text not null,
  variant_title text,
  sku text,
  quantity int not null check (quantity > 0),
  requires_production boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index production_items_order_idx on public.production_items(production_order_id);
create trigger production_items_updated_at before update on public.production_items
  for each row execute function public.set_updated_at();

create table public.production_status_history (
  id uuid primary key default gen_random_uuid(),
  production_order_id uuid not null references public.production_orders(id) on delete cascade,
  from_status public.production_status,
  to_status public.production_status not null,
  action text,
  note text,
  actor_id uuid,
  actor_name text,
  created_at timestamptz not null default now()
);
create index production_status_history_idx on public.production_status_history(production_order_id, created_at);
create trigger production_status_history_immutable before update or delete on public.production_status_history
  for each row execute function public.prevent_mutation();

-- -----------------------------------------------------------------------------
-- Couriers & shipments (provider-agnostic; API credentials live in edge
-- function secrets, never in these tables)
-- -----------------------------------------------------------------------------
create table public.couriers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  provider text not null default 'manual' check (provider ~ '^[a-z0-9_]+$'),
  api_enabled boolean not null default false,
  api_status text not null default 'NOT_CONFIGURED' check (api_status in ('NOT_CONFIGURED', 'CONNECTED', 'ERROR')),
  api_checked_at timestamptz,
  tracking_url_template text,
  phone text,
  notes text,
  config jsonb not null default '{}'::jsonb,
  default_shipping_cost numeric(12,2) check (default_shipping_cost is null or default_shipping_cost >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger couriers_updated_at before update on public.couriers
  for each row execute function public.set_updated_at();
create trigger couriers_audit after insert or update or delete on public.couriers
  for each row execute function public.audit_row_change();

create table public.shipments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  courier_id uuid not null references public.couriers(id),
  tracking_number text,
  consignment_id text,
  status public.shipment_status not null default 'PENDING',
  shipping_cost numeric(12,2) not null default 0 check (shipping_cost >= 0),
  return_charge numeric(12,2) not null default 0 check (return_charge >= 0),
  cod_amount numeric(12,2) not null default 0 check (cod_amount >= 0),
  cod_collected numeric(12,2) not null default 0 check (cod_collected >= 0),
  cod_collected_at timestamptz,
  delivered_amount numeric(12,2),
  delivered_at timestamptz,
  return_status public.return_status not null default 'NONE',
  is_active boolean not null default true,
  provider_payload jsonb not null default '{}'::jsonb,
  notes text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index shipments_one_active on public.shipments(order_id) where is_active;
create index shipments_tracking_idx on public.shipments(tracking_number);
create index shipments_consignment_idx on public.shipments(consignment_id);
create index shipments_courier_idx on public.shipments(courier_id, created_at desc);
create index shipments_status_idx on public.shipments(status);
create index shipments_cod_due_idx on public.shipments(courier_id) where status = 'DELIVERED' and is_active;
create trigger shipments_updated_at before update on public.shipments
  for each row execute function public.set_updated_at();

create table public.shipment_events (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references public.shipments(id) on delete cascade,
  status public.shipment_status not null,
  description text,
  location text,
  source public.data_source not null default 'MANUAL',
  event_key text unique,
  raw jsonb,
  occurred_at timestamptz not null default now(),
  created_by uuid,
  created_at timestamptz not null default now()
);
create index shipment_events_shipment_idx on public.shipment_events(shipment_id, occurred_at);
create trigger shipment_events_immutable before update or delete on public.shipment_events
  for each row execute function public.prevent_mutation();

-- -----------------------------------------------------------------------------
-- Production functions
-- -----------------------------------------------------------------------------
create or replace function public._production_log(
  p_id uuid, p_from public.production_status, p_to public.production_status, p_action text, p_note text
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.production_status_history(production_order_id, from_status, to_status, action, note, actor_id, actor_name)
  values (p_id, p_from, p_to, p_action, p_note, auth.uid(), public.actor_display_name())
$$;

create or replace function public._production_fill_items(p_production_id uuid, p_order_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.production_items(production_order_id, order_item_id, product_id, variant_id, product_name,
                                      variant_title, sku, quantity, requires_production)
  select p_production_id, oi.id, oi.product_id, oi.variant_id, oi.product_name, oi.variant_title, oi.sku,
         oi.quantity, oi.requires_production
  from public.order_items oi where oi.order_id = p_order_id
$$;

create or replace function public._production_create_for_order(p_order_id uuid, p_force boolean default false)
returns public.production_orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mode text := upper(public.setting_text('production', array['auto_create'], 'REQUIRED_ONLY'));
  v_po public.production_orders;
begin
  select * into v_po from public.production_orders where order_id = p_order_id and status <> 'CANCELLED';
  if found then
    return v_po;
  end if;
  if not p_force then
    if not public.setting_bool('production', array['enabled'], true) or v_mode = 'OFF' then
      return null;
    end if;
    if v_mode = 'REQUIRED_ONLY'
       and not exists (select 1 from public.order_items where order_id = p_order_id and requires_production) then
      return null;
    end if;
  end if;

  insert into public.production_orders(order_id, deadline, priority)
  values (p_order_id,
          (now() at time zone public.store_timezone())::date
            + public.setting_numeric('production', array['default_deadline_days'], 3)::int,
          'NORMAL')
  returning * into v_po;
  perform public._production_fill_items(v_po.id, p_order_id);
  perform public._production_log(v_po.id, null, 'WAITING', 'CREATED', 'Added to production queue');
  perform public._order_log(p_order_id, 'PRODUCTION_QUEUED', 'Added to the production queue');
  return v_po;
end;
$$;

create or replace function public._production_refresh_items(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_po public.production_orders;
begin
  select * into v_po from public.production_orders
  where order_id = p_order_id and status not in ('CANCELLED', 'READY');
  if found then
    delete from public.production_items where production_order_id = v_po.id;
    perform public._production_fill_items(v_po.id, p_order_id);
  end if;
end;
$$;

create or replace function public._production_cancel_for_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_po public.production_orders;
begin
  for v_po in select * from public.production_orders where order_id = p_order_id and status <> 'CANCELLED' for update loop
    update public.production_orders set status = 'CANCELLED' where id = v_po.id;
    perform public._production_log(v_po.id, v_po.status, 'CANCELLED', 'CANCEL', 'Order cancelled');
  end loop;
end;
$$;

-- Order status changed directly by staff: keep the production card in step.
create or replace function public._production_sync_from_order(p_order_id uuid, p_order_status public.order_status)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_po public.production_orders;
  v_target public.production_status := case p_order_status
    when 'PRODUCTION' then 'IN_PRODUCTION' when 'QUALITY_CHECK' then 'QUALITY_CHECK'
    when 'PACKING' then 'PACKING' when 'READY_TO_SHIP' then 'READY' end;
begin
  if v_target is null then
    return;
  end if;
  select * into v_po from public.production_orders where order_id = p_order_id and status <> 'CANCELLED' for update;
  if not found then
    if p_order_status = 'PRODUCTION' then
      v_po := public._production_create_for_order(p_order_id, true);
    else
      return;
    end if;
  end if;
  if v_po.status = v_target then
    return;
  end if;
  update public.production_orders set
    status = v_target,
    started_at = case when v_target = 'IN_PRODUCTION' then coalesce(started_at, now()) else started_at end,
    qc_at = case when v_target = 'QUALITY_CHECK' then now() else qc_at end,
    completed_at = case when v_target = 'READY' then now() else completed_at end
  where id = v_po.id;
  perform public._production_log(v_po.id, v_po.status, v_target, 'SYNC', 'Updated from order status');
end;
$$;

-- Moves the order forward to p_target, passing through PROCESSING when the
-- order is still CONFIRMED.
create or replace function public._order_advance_to(p_order_id uuid, p_target public.order_status, p_note text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status public.order_status;
begin
  select status into v_status from public.orders where id = p_order_id;
  if v_status = p_target then
    return;
  end if;
  if v_status = 'CONFIRMED' then
    perform public._transition_order(p_order_id, 'PROCESSING', 'Preparation started', '{}'::jsonb, false);
    v_status := 'PROCESSING';
  end if;
  if v_status = p_target then
    return;
  end if;
  if not exists (select 1 from public.order_status_transitions where from_status = v_status and to_status = p_target) then
    raise exception 'INVALID_TRANSITION: order is % and cannot move to %', v_status, p_target using errcode = 'P0001';
  end if;
  perform public._transition_order(p_order_id, p_target, p_note, '{}'::jsonb, false);
end;
$$;

-- Production floor actions:
--   START, PAUSE, RESUME, SEND_TO_QC, APPROVE, REJECT, MOVE_TO_PACKING, MARK_READY
create or replace function public.production_action(p_production_id uuid, p_action text, p_note text default null)
returns public.production_orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_po public.production_orders;
  v_action text := upper(coalesce(p_action, ''));
  v_to public.production_status;
  v_from public.production_status;
  v_order_target public.order_status;
begin
  perform public.require_permission('production.manage');
  select * into v_po from public.production_orders where id = p_production_id for update;
  if not found then
    raise exception 'NOT_FOUND: production order not found' using errcode = 'P0002';
  end if;
  v_from := v_po.status;

  v_to := case
    when v_action = 'START' and v_po.status in ('WAITING', 'PAUSED') then 'IN_PRODUCTION'
    when v_action = 'RESUME' and v_po.status = 'PAUSED' then 'IN_PRODUCTION'
    when v_action = 'PAUSE' and v_po.status = 'IN_PRODUCTION' then 'PAUSED'
    when v_action = 'SEND_TO_QC' and v_po.status = 'IN_PRODUCTION' then 'QUALITY_CHECK'
    when v_action = 'APPROVE' and v_po.status = 'QUALITY_CHECK' then 'PACKING'
    when v_action = 'REJECT' and v_po.status = 'QUALITY_CHECK' then 'IN_PRODUCTION'
    when v_action = 'MOVE_TO_PACKING' and v_po.status in ('WAITING', 'IN_PRODUCTION') then 'PACKING'
    when v_action = 'MARK_READY' and v_po.status = 'PACKING' then 'READY'
  end::public.production_status;

  if v_to is null then
    raise exception 'INVALID_TRANSITION: cannot % a production order that is %', lower(replace(v_action, '_', ' ')), v_po.status
      using errcode = 'P0001';
  end if;
  if v_action = 'REJECT' and length(trim(coalesce(p_note, ''))) = 0 then
    raise exception 'VALIDATION: a reason is required when rejecting in quality check' using errcode = '22023';
  end if;

  update public.production_orders set
    status = v_to,
    started_at = case when v_to = 'IN_PRODUCTION' then coalesce(started_at, now()) else started_at end,
    qc_at = case when v_to = 'QUALITY_CHECK' then now() else qc_at end,
    completed_at = case when v_to = 'READY' then now() else completed_at end,
    rejection_count = rejection_count + case when v_action = 'REJECT' then 1 else 0 end
  where id = p_production_id
  returning * into v_po;
  perform public._production_log(p_production_id, v_from, v_to, v_action, p_note);

  v_order_target := case v_to
    when 'IN_PRODUCTION' then 'PRODUCTION'
    when 'QUALITY_CHECK' then 'QUALITY_CHECK'
    when 'PACKING' then 'PACKING'
    when 'READY' then 'READY_TO_SHIP'
  end::public.order_status;
  if v_order_target is not null then
    perform public._order_advance_to(v_po.order_id, v_order_target,
      coalesce(p_note, initcap(lower(replace(v_action, '_', ' ')))));
  end if;
  return v_po;
end;
$$;

create or replace function public.production_update(
  p_production_id uuid,
  p_assigned_to uuid,
  p_priority public.production_priority,
  p_deadline date,
  p_notes text
)
returns public.production_orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_po public.production_orders;
begin
  perform public.require_permission('production.manage');
  if p_assigned_to is not null and not exists (select 1 from public.profiles where id = p_assigned_to and is_active) then
    raise exception 'VALIDATION: assignee must be an active staff member' using errcode = '22023';
  end if;
  update public.production_orders set assigned_to = p_assigned_to, priority = coalesce(p_priority, priority),
    deadline = p_deadline, notes = nullif(trim(coalesce(p_notes, '')), '')
  where id = p_production_id returning * into v_po;
  if not found then
    raise exception 'NOT_FOUND: production order not found' using errcode = 'P0002';
  end if;
  return v_po;
end;
$$;

create or replace function public.admin_create_production_order(p_order_id uuid)
returns public.production_orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status public.order_status;
begin
  perform public.require_permission('production.manage');
  select status into v_status from public.orders where id = p_order_id;
  if v_status not in ('CONFIRMED', 'PROCESSING', 'PRODUCTION', 'QUALITY_CHECK', 'PACKING') then
    raise exception 'VALIDATION: only confirmed orders can go to production (order is %)', v_status using errcode = '22023';
  end if;
  return public._production_create_for_order(p_order_id, true);
end;
$$;

-- -----------------------------------------------------------------------------
-- Shipment functions
-- -----------------------------------------------------------------------------
create or replace function public.assign_courier(
  p_order_id uuid,
  p_courier_id uuid,
  p_tracking_number text default null,
  p_shipping_cost numeric default null,
  p_note text default null,
  p_consignment_id text default null,
  p_provider_payload jsonb default null
)
returns public.shipments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_courier public.couriers;
  v_ship public.shipments;
  v_old public.shipments;
begin
  perform public.require_permission('shipments.manage');
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'NOT_FOUND: order not found' using errcode = 'P0002';
  end if;
  if v_order.status in ('CANCELLED', 'REJECTED_FRAUD', 'DELIVERED', 'RETURNED') then
    raise exception 'VALIDATION: cannot assign a courier to a % order', v_order.status using errcode = '22023';
  end if;
  select * into v_courier from public.couriers where id = p_courier_id and is_active;
  if not found then
    raise exception 'NOT_FOUND: courier not found or inactive' using errcode = 'P0002';
  end if;
  if coalesce(p_shipping_cost, 0) < 0 then
    raise exception 'VALIDATION: shipping cost cannot be negative' using errcode = '22023';
  end if;

  select * into v_old from public.shipments where order_id = p_order_id and is_active for update;
  if found and v_old.courier_id = p_courier_id then
    update public.shipments set
      tracking_number = coalesce(nullif(trim(p_tracking_number), ''), tracking_number),
      consignment_id = coalesce(nullif(trim(p_consignment_id), ''), consignment_id),
      shipping_cost = coalesce(p_shipping_cost, shipping_cost),
      status = case when status = 'PENDING' and coalesce(nullif(trim(p_tracking_number), ''), nullif(trim(p_consignment_id), '')) is not null
                    then 'BOOKED' else status end,
      provider_payload = provider_payload || coalesce(p_provider_payload, '{}'::jsonb),
      notes = coalesce(nullif(trim(p_note), ''), notes)
    where id = v_old.id returning * into v_ship;
  else
    if found then
      update public.shipments set is_active = false, status = 'CANCELLED' where id = v_old.id;
      insert into public.shipment_events(shipment_id, status, description, source, created_by)
      values (v_old.id, 'CANCELLED', 'Replaced by another courier', 'MANUAL', auth.uid());
    end if;
    insert into public.shipments(order_id, courier_id, tracking_number, consignment_id, status, shipping_cost,
                                 return_charge, cod_amount, notes, provider_payload, created_by)
    values (p_order_id, p_courier_id, nullif(trim(p_tracking_number), ''), nullif(trim(p_consignment_id), ''),
            case when coalesce(nullif(trim(p_tracking_number), ''), nullif(trim(p_consignment_id), '')) is not null
                 then 'BOOKED' else 'PENDING' end::public.shipment_status,
            coalesce(p_shipping_cost, v_courier.default_shipping_cost, 0), v_order.return_charge,
            v_order.cod_amount, nullif(trim(p_note), ''), coalesce(p_provider_payload, '{}'::jsonb), auth.uid())
    returning * into v_ship;
    insert into public.shipment_events(shipment_id, status, description, source, created_by)
    values (v_ship.id, v_ship.status, 'Courier assigned: ' || v_courier.name,
            case when public.is_system_context() then 'API' else 'MANUAL' end::public.data_source, auth.uid());
  end if;

  perform public._order_log(p_order_id, 'COURIER_ASSIGNED',
    format('Courier %s%s', v_courier.name, coalesce(' · tracking ' || v_ship.tracking_number, '')), null, null,
    jsonb_build_object('shipment_id', v_ship.id, 'courier_id', p_courier_id), v_ship.tracking_number is not null);
  perform public.log_audit('shipment.assigned', 'order', p_order_id::text, null,
    jsonb_build_object('courier', v_courier.name, 'tracking_number', v_ship.tracking_number, 'shipping_cost', v_ship.shipping_cost));
  return v_ship;
end;
$$;

create or replace function public.update_shipment(p_shipment_id uuid, p_changes jsonb)
returns public.shipments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old public.shipments;
  v_ship public.shipments;
begin
  perform public.require_permission('shipments.manage');
  select * into v_old from public.shipments where id = p_shipment_id for update;
  if not found then
    raise exception 'NOT_FOUND: shipment not found' using errcode = 'P0002';
  end if;
  if (p_changes ->> 'shipping_cost')::numeric < 0 or (p_changes ->> 'return_charge')::numeric < 0 then
    raise exception 'VALIDATION: charges cannot be negative' using errcode = '22023';
  end if;
  update public.shipments set
    tracking_number = case when p_changes ? 'tracking_number' then nullif(trim(p_changes ->> 'tracking_number'), '') else tracking_number end,
    consignment_id = case when p_changes ? 'consignment_id' then nullif(trim(p_changes ->> 'consignment_id'), '') else consignment_id end,
    shipping_cost = coalesce((p_changes ->> 'shipping_cost')::numeric, shipping_cost),
    return_charge = coalesce((p_changes ->> 'return_charge')::numeric, return_charge),
    notes = case when p_changes ? 'notes' then nullif(trim(p_changes ->> 'notes'), '') else notes end,
    status = case when status = 'PENDING' and nullif(trim(coalesce(p_changes ->> 'tracking_number', '')), '') is not null
                  then 'BOOKED' else status end
  where id = p_shipment_id returning * into v_ship;
  perform public.log_audit('shipment.updated', 'shipment', p_shipment_id::text,
    jsonb_build_object('tracking_number', v_old.tracking_number, 'shipping_cost', v_old.shipping_cost, 'return_charge', v_old.return_charge),
    jsonb_build_object('tracking_number', v_ship.tracking_number, 'shipping_cost', v_ship.shipping_cost, 'return_charge', v_ship.return_charge));
  return v_ship;
end;
$$;

-- Records a courier status (manual, API poll or webhook) and moves the order.
-- p_event_key makes provider callbacks idempotent.
create or replace function public.apply_shipment_status(
  p_shipment_id uuid,
  p_status public.shipment_status,
  p_description text default null,
  p_location text default null,
  p_occurred_at timestamptz default null,
  p_source public.data_source default 'MANUAL',
  p_raw jsonb default null,
  p_event_key text default null
)
returns public.shipments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ship public.shipments;
  v_order public.orders;
  v_event_id uuid;
begin
  perform public.require_permission('shipments.manage');
  select * into v_ship from public.shipments where id = p_shipment_id for update;
  if not found then
    raise exception 'NOT_FOUND: shipment not found' using errcode = 'P0002';
  end if;

  insert into public.shipment_events(shipment_id, status, description, location, source, event_key, raw, occurred_at, created_by)
  values (p_shipment_id, p_status, p_description, p_location, p_source, p_event_key, p_raw, coalesce(p_occurred_at, now()), auth.uid())
  on conflict (event_key) do nothing
  returning id into v_event_id;
  if v_event_id is null then
    return v_ship; -- duplicate callback
  end if;

  update public.shipments set status = p_status,
    delivered_at = case when p_status in ('DELIVERED', 'PARTIALLY_DELIVERED') then coalesce(delivered_at, coalesce(p_occurred_at, now())) else delivered_at end,
    return_status = case when p_status = 'RETURNING' then 'IN_TRANSIT'
                         when p_status = 'RETURNED' then 'IN_TRANSIT' else return_status end
  where id = p_shipment_id returning * into v_ship;

  if not v_ship.is_active then
    return v_ship;
  end if;
  select * into v_order from public.orders where id = v_ship.order_id for update;

  if p_status in ('PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY') and v_order.status in ('PACKING', 'READY_TO_SHIP', 'PROCESSING') then
    if v_order.status <> 'READY_TO_SHIP' then
      perform public._order_advance_to(v_order.id, 'READY_TO_SHIP', 'Picked up by courier');
    end if;
    perform public._transition_order(v_order.id, 'SHIPPED', coalesce(p_description, 'Picked up by courier'));
  elsif p_status in ('DELIVERED', 'PARTIALLY_DELIVERED') then
    if v_order.status in ('PACKING', 'READY_TO_SHIP', 'PROCESSING') then
      if v_order.status <> 'READY_TO_SHIP' then
        perform public._order_advance_to(v_order.id, 'READY_TO_SHIP', 'Courier update');
      end if;
      perform public._transition_order(v_order.id, 'SHIPPED', 'Courier update');
      v_order.status := 'SHIPPED';
    end if;
    if v_order.status in ('SHIPPED', 'RETURN_REQUESTED', 'FAILED_DELIVERY') then
      if v_order.status = 'FAILED_DELIVERY' then
        perform public._transition_order(v_order.id, 'SHIPPED', 'Re-attempted delivery');
      end if;
      perform public._transition_order(v_order.id, 'DELIVERED',
        coalesce(p_description, case when p_status = 'PARTIALLY_DELIVERED' then 'Partially delivered — check returned items' else 'Delivered by courier' end));
    end if;
  elsif p_status = 'FAILED' and v_order.status = 'SHIPPED' then
    perform public._transition_order(v_order.id, 'FAILED_DELIVERY', coalesce(p_description, 'Delivery failed'));
  elsif p_status in ('RETURNING', 'RETURNED') then
    if v_order.status = 'SHIPPED' then
      perform public._transition_order(v_order.id, 'FAILED_DELIVERY', coalesce(p_description, 'Parcel returning to merchant'));
    elsif v_order.status = 'DELIVERED' then
      perform public._transition_order(v_order.id, 'RETURN_REQUESTED', coalesce(p_description, 'Customer return in transit'));
    end if;
    if p_status = 'RETURNED' then
      perform public._order_log(v_order.id, 'PARCEL_RETURNED',
        'Courier marked the parcel as returned. Receive it to restock or mark damaged.');
    end if;
  end if;
  return v_ship;
end;
$$;

-- Courier paid out the collected COD: record payments for delivered parcels.
create or replace function public.record_cod_settlement(p_shipment_ids uuid[], p_reference text default null, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ship public.shipments;
  v_order public.orders;
  v_due numeric;
  v_count int := 0;
  v_total numeric := 0;
  v_skipped jsonb := '[]'::jsonb;
begin
  perform public.require_permission('payments.record');
  for v_ship in select * from public.shipments where id = any(p_shipment_ids) for update loop
    select * into v_order from public.orders where id = v_ship.order_id;
    v_due := v_order.total_amount - v_order.amount_paid;
    if v_order.delivered_at is null or v_due <= 0 then
      v_skipped := v_skipped || jsonb_build_object('shipment_id', v_ship.id, 'order_number', v_order.order_number,
        'reason', case when v_order.delivered_at is null then 'not delivered' else 'nothing due' end);
      continue;
    end if;
    perform public.record_order_payment(v_order.id, 'COD', 'COURIER_COD', v_due, p_reference,
      coalesce(p_note, 'COD settlement'), 'cod:' || v_ship.id);
    update public.shipments set cod_collected = cod_collected + v_due, cod_collected_at = now() where id = v_ship.id;
    v_count := v_count + 1;
    v_total := v_total + v_due;
  end loop;
  return jsonb_build_object('settled', v_count, 'amount', v_total, 'skipped', v_skipped);
end;
$$;

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table public.production_orders enable row level security;
alter table public.production_items enable row level security;
alter table public.production_status_history enable row level security;
alter table public.couriers enable row level security;
alter table public.shipments enable row level security;
alter table public.shipment_events enable row level security;

create policy production_orders_read on public.production_orders for select to authenticated
  using ((select public.has_permission('production.view')) or (select public.has_permission('orders.view')));
create policy production_items_read on public.production_items for select to authenticated
  using ((select public.has_permission('production.view')) or (select public.has_permission('orders.view')));
create policy production_status_history_read on public.production_status_history for select to authenticated
  using ((select public.has_permission('production.view')) or (select public.has_permission('orders.view')));

create policy couriers_read on public.couriers for select to authenticated
  using ((select public.is_staff()));
create policy couriers_manage on public.couriers for all to authenticated
  using ((select public.has_permission('couriers.manage')))
  with check ((select public.has_permission('couriers.manage')));

create policy shipments_read on public.shipments for select to authenticated
  using ((select public.has_permission('orders.view')) or (select public.has_permission('couriers.view')));
create policy shipment_events_read on public.shipment_events for select to authenticated
  using ((select public.has_permission('orders.view')) or (select public.has_permission('couriers.view')));
