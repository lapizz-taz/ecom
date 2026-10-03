-- =============================================================================
-- Courier operations
--   * courier_webhook_events: every courier callback, with its result; processed
--     once per event key, unmatched / failed ones retried by a scheduled job
--   * shipment_charges: delivery fee, return charge, COD fee and other fees per
--     parcel. Estimates first; what the courier reports (webhook, invoice)
--     replaces them through a correcting entry. Each entry posts to finance
--     exactly once.
--   * courier_invoices: uploaded courier statements matched line by line
--     against our shipments, with the expected payout and the difference
--   * courier_metrics(): shipped / delivered / returned, rates and cost
-- =============================================================================

create type public.shipment_charge_kind as enum ('DELIVERY', 'RETURN', 'COD_FEE', 'OTHER');
create type public.charge_source as enum ('ESTIMATE', 'COURIER_API', 'WEBHOOK', 'INVOICE', 'MANUAL');
create type public.courier_invoice_status as enum ('NEEDS_REVIEW', 'DISCREPANCY', 'VERIFIED', 'PAID');

insert into public.finance_categories(code, name, type, pnl_group, is_system, allow_manual, sort_order, description)
values ('COD_FEES', 'COD fees', 'EXPENSE', 'OPERATING_EXPENSE', true, true, 145, 'Courier fee for collecting cash on delivery')
on conflict (code) do nothing;

-- COD fee the courier takes, as a percentage of the cash it collects (Couriers → edit).
alter table public.couriers add constraint couriers_cod_fee_percent check (
  config ->> 'cod_fee_percent' is null or (config ->> 'cod_fee_percent')::numeric between 0 and 10);

-- -----------------------------------------------------------------------------
-- Courier invoices / statements
-- -----------------------------------------------------------------------------
create table public.courier_invoices (
  id uuid primary key default gen_random_uuid(),
  courier_id uuid not null references public.couriers(id),
  invoice_number text check (invoice_number is null or length(invoice_number) between 1 and 80),
  invoice_date date,
  period_start date,
  period_end date,
  file_path text,
  file_name text,
  status public.courier_invoice_status not null default 'NEEDS_REVIEW',
  line_count int not null default 0,
  matched_count int not null default 0,
  mismatch_count int not null default 0,
  unmatched_count int not null default 0,
  duplicate_count int not null default 0,
  -- What the courier's statement says
  cod_collected numeric(12,2) not null default 0,
  delivery_fees numeric(12,2) not null default 0,
  return_fees numeric(12,2) not null default 0,
  cod_fees numeric(12,2) not null default 0,
  other_fees numeric(12,2) not null default 0,
  payout_reported numeric(12,2) not null default 0,
  -- What our records say it should be
  expected_cod_collected numeric(12,2) not null default 0,
  expected_delivery_fees numeric(12,2) not null default 0,
  expected_return_fees numeric(12,2) not null default 0,
  expected_cod_fees numeric(12,2) not null default 0,
  payout_expected numeric(12,2) not null default 0,
  difference numeric(12,2) generated always as (payout_reported - payout_expected) stored,
  amount_paid numeric(12,2) not null default 0 check (amount_paid >= 0),
  paid_at timestamptz,
  paid_reference text,
  charges_applied_at timestamptz,
  notes text,
  uploaded_by uuid default auth.uid(),
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index courier_invoices_number_uq on public.courier_invoices(courier_id, lower(invoice_number)) where invoice_number is not null;
create index courier_invoices_courier_idx on public.courier_invoices(courier_id, created_at desc);
create trigger courier_invoices_updated_at before update on public.courier_invoices
  for each row execute function public.set_updated_at();
create trigger courier_invoices_audit after insert or update or delete on public.courier_invoices
  for each row execute function public.audit_row_change();

create table public.courier_invoice_lines (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.courier_invoices(id) on delete cascade,
  line_no int not null,
  consignment_id text,
  order_ref text,
  courier_status text,
  cod_collected numeric(12,2),
  delivery_fee numeric(12,2),
  return_fee numeric(12,2),
  cod_fee numeric(12,2),
  other_fee numeric(12,2),
  payout numeric(12,2),
  shipment_id uuid references public.shipments(id) on delete set null,
  order_id uuid references public.orders(id) on delete set null,
  expected_cod numeric(12,2),
  expected_delivery_fee numeric(12,2),
  expected_return_fee numeric(12,2),
  expected_cod_fee numeric(12,2),
  match_status text not null check (match_status in ('MATCHED', 'MISMATCH', 'UNMATCHED', 'DUPLICATE')),
  issues text[] not null default '{}',
  settled_at timestamptz,
  unique (invoice_id, line_no)
);
create index courier_invoice_lines_shipment_idx on public.courier_invoice_lines(shipment_id);

-- -----------------------------------------------------------------------------
-- Courier charges per parcel
-- -----------------------------------------------------------------------------
create table public.shipment_charges (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references public.shipments(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  courier_id uuid not null references public.couriers(id),
  kind public.shipment_charge_kind not null,
  -- The change this entry makes; total_after is the charge after it.
  amount numeric(12,2) not null check (amount <> 0),
  total_after numeric(12,2) not null check (total_after >= 0),
  source public.charge_source not null,
  source_key text not null unique,
  note text,
  invoice_id uuid references public.courier_invoices(id) on delete set null,
  finance_transaction_id uuid references public.finance_transactions(id),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index shipment_charges_shipment_idx on public.shipment_charges(shipment_id, kind);
create index shipment_charges_courier_idx on public.shipment_charges(courier_id, created_at);
create trigger shipment_charges_immutable before update or delete on public.shipment_charges
  for each row execute function public.prevent_mutation();

create or replace function public._charge_category(p_kind public.shipment_charge_kind)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case p_kind when 'RETURN' then 'RETURNS' when 'COD_FEE' then 'COD_FEES' else 'COURIER' end
$$;

create or replace function public._courier_cod_fee(p_courier_id uuid, p_cod numeric)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(round(greatest(coalesce(p_cod, 0), 0) * (c.config ->> 'cod_fee_percent')::numeric / 100, 2), 0)
  from public.couriers c where c.id = p_courier_id
$$;

-- Sets a parcel's charge of one kind to p_total. Writes only the difference to
-- what is already recorded, and only once per p_key: the same courier event
-- received again changes nothing.
create or replace function public._set_shipment_charge(
  p_shipment_id uuid,
  p_kind public.shipment_charge_kind,
  p_total numeric,
  p_source public.charge_source,
  p_key text,
  p_note text default null,
  p_invoice_id uuid default null,
  p_date date default null
)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ship public.shipments;
  v_order public.orders;
  v_current numeric;
  v_delta numeric;
  v_id uuid := gen_random_uuid();
  v_txn public.finance_transactions;
  v_label text := case p_kind when 'DELIVERY' then 'Courier delivery fee' when 'RETURN' then 'Courier return charge'
                    when 'COD_FEE' then 'Courier COD fee' else 'Other courier fee' end;
begin
  if p_total is null or p_total < 0 or p_key is null then
    return 0;
  end if;
  select * into v_ship from public.shipments where id = p_shipment_id for update;
  if not found then
    raise exception 'NOT_FOUND: shipment not found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.shipment_charges where source_key = p_key) then
    return 0;
  end if;
  select coalesce(sum(amount), 0) into v_current from public.shipment_charges
  where shipment_id = p_shipment_id and kind = p_kind;
  v_delta := public.money(p_total) - v_current;
  if v_delta = 0 then
    return 0;
  end if;
  select * into v_order from public.orders where id = v_ship.order_id;
  v_txn := public._post_finance('EXPENSE', public._charge_category(p_kind), v_delta, p_date, true, v_ship.order_id, null, null,
    v_order.order_number,
    coalesce(p_note, v_label) || case when v_current <> 0 then format(' (was %s)', v_current) else '' end,
    'shipment_charge:' || v_id, 'COURIER_COD');
  insert into public.shipment_charges(id, shipment_id, order_id, courier_id, kind, amount, total_after, source, source_key,
                                      note, invoice_id, finance_transaction_id)
  values (v_id, v_ship.id, v_ship.order_id, v_ship.courier_id, p_kind, v_delta, public.money(p_total), p_source, p_key,
          coalesce(p_note, v_label), p_invoice_id, v_txn.id);
  if p_kind = 'DELIVERY' then
    update public.shipments set shipping_cost = public.money(p_total) where id = v_ship.id;
  elsif p_kind = 'RETURN' then
    update public.shipments set return_charge = public.money(p_total) where id = v_ship.id;
  end if;
  return v_delta;
end;
$$;

-- An estimate is written only while nothing of that kind is recorded yet.
create or replace function public._estimate_shipment_charge(
  p_shipment_id uuid,
  p_kind public.shipment_charge_kind,
  p_amount numeric,
  p_key text,
  p_note text,
  p_date date default null
)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from public.shipment_charges where shipment_id = p_shipment_id and kind = p_kind) then
    return 0;
  end if;
  return public._set_shipment_charge(p_shipment_id, p_kind, p_amount, 'ESTIMATE', p_key, p_note, null, p_date);
end;
$$;

-- Courier costs already in finance become the first entries of the ledger.
insert into public.shipment_charges(shipment_id, order_id, courier_id, kind, amount, total_after, source, source_key, note,
                                    finance_transaction_id, created_by, created_at)
select s.id, s.order_id, s.courier_id,
       case when ft.source_key like '%:return_charge' then 'RETURN' else 'DELIVERY' end::public.shipment_charge_kind,
       ft.amount, greatest(ft.amount, 0), 'ESTIMATE', ft.source_key, ft.notes, ft.id, ft.created_by, ft.created_at
from public.finance_transactions ft
join public.shipments s on s.id = substring(ft.source_key from '^shipment:([0-9a-f-]{36}):')::uuid
where ft.source_key ~ '^shipment:[0-9a-f-]{36}:(shipping_cost|return_charge)$'
on conflict (source_key) do nothing;

-- Delivered: revenue, COGS and courier cost estimates (courier-reported fees replace them).
create or replace function public._post_order_delivery_finance(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_ship public.shipments;
  v_date date;
begin
  select * into v_order from public.orders where id = p_order_id;
  v_date := (coalesce(v_order.delivered_at, now()) at time zone public.store_timezone())::date;

  perform public._post_finance('INCOME', 'PRODUCT_SALES', v_order.subtotal - v_order.discount_total, v_date, false,
    p_order_id, v_order.customer_id, null, v_order.order_number, 'Product revenue (delivered)',
    'order:' || p_order_id || ':product_revenue', null);
  perform public._post_finance('INCOME', 'DELIVERY_CHARGES', v_order.delivery_charge - v_order.delivery_discount, v_date, false,
    p_order_id, v_order.customer_id, null, v_order.order_number, 'Delivery charge (delivered)',
    'order:' || p_order_id || ':delivery_revenue', null);
  perform public._post_finance('EXPENSE', 'COGS', v_order.cost_total, v_date, false,
    p_order_id, v_order.customer_id, null, v_order.order_number, 'Cost of goods sold',
    'order:' || p_order_id || ':cogs', null);

  -- Courier costs as estimates; a fee the courier reports later replaces them.
  select * into v_ship from public.shipments where order_id = p_order_id and is_active;
  if found and public.setting_bool('finance', array['record_courier_cost_on_delivery'], true) then
    perform public._estimate_shipment_charge(v_ship.id, 'DELIVERY', v_ship.shipping_cost,
      'shipment:' || v_ship.id || ':shipping_cost', 'Courier charge', v_date);
    perform public._estimate_shipment_charge(v_ship.id, 'COD_FEE', public._courier_cod_fee(v_ship.courier_id, v_order.cod_amount),
      'shipment:' || v_ship.id || ':cod_fee', 'Courier COD fee', v_date);
  end if;

  if public.setting_bool('finance', array['auto_collect_cod_on_delivery'], false) then
    select * into v_order from public.orders where id = p_order_id;
    if v_order.cod_amount > 0 then
      insert into public.order_payments(order_id, kind, channel, amount, note, idempotency_key)
      values (p_order_id, 'COD', 'COURIER_COD', v_order.cod_amount, 'Collected on delivery',
              'cod:delivered:' || p_order_id)
      on conflict (idempotency_key) do nothing;
      if found then
        perform public._post_finance('INCOME', 'COD_COLLECTIONS', v_order.cod_amount, v_date, true,
          p_order_id, v_order.customer_id, null, v_order.order_number, 'COD collected on delivery',
          'order:' || p_order_id || ':cod_on_delivery', 'COURIER_COD');
        perform public.recalculate_order_totals(p_order_id);
      end if;
    end if;
  end if;
end;
$$;

-- Costs of a parcel that came back: delivery fee (if never delivered) and the
-- courier's return charge, unless the courier already reported them.
create or replace function public._post_order_return_finance(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_ship public.shipments;
  v_date date := (now() at time zone public.store_timezone())::date;
begin
  select * into v_order from public.orders where id = p_order_id;
  select * into v_ship from public.shipments where order_id = p_order_id and is_active;
  if not found then
    return;
  end if;
  if v_order.delivered_at is null then
    perform public._estimate_shipment_charge(v_ship.id, 'DELIVERY', v_ship.shipping_cost,
      'shipment:' || v_ship.id || ':shipping_cost', 'Courier charge (failed delivery)', v_date);
  end if;
  perform public._estimate_shipment_charge(v_ship.id, 'RETURN', v_ship.return_charge,
    'shipment:' || v_ship.id || ':return_charge', 'Courier return charge', v_date);
end;
$$;

-- -----------------------------------------------------------------------------
-- Courier webhook / event log
-- -----------------------------------------------------------------------------
create table public.courier_webhook_events (
  id uuid primary key default gen_random_uuid(),
  courier_id uuid references public.couriers(id) on delete set null,
  provider text not null check (provider ~ '^[a-z0-9_]+$'),
  event_key text not null unique check (length(event_key) between 3 and 300),
  event_type text not null,
  consignment_id text,
  order_ref text,
  provider_status text,
  new_status public.shipment_status,
  previous_status public.shipment_status,
  occurred_at timestamptz,
  charges jsonb not null default '{}'::jsonb,
  shipment_id uuid references public.shipments(id) on delete set null,
  order_id uuid references public.orders(id) on delete set null,
  result text not null default 'RECEIVED' check (result in ('RECEIVED', 'PROCESSED', 'IGNORED', 'UNMATCHED', 'FAILED')),
  note text,
  error text,
  attempts int not null default 0,
  duplicates int not null default 0,
  next_retry_at timestamptz,
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
create index courier_webhook_events_received_idx on public.courier_webhook_events(received_at desc);
create index courier_webhook_events_retry_idx on public.courier_webhook_events(next_retry_at) where result in ('FAILED', 'UNMATCHED');
create index courier_webhook_events_shipment_idx on public.courier_webhook_events(shipment_id);

-- Late or out-of-order courier updates must not move a parcel backwards.
create or replace function public._shipment_status_regresses(p_from public.shipment_status, p_to public.shipment_status)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select (p_from in ('DELIVERED', 'PARTIALLY_DELIVERED', 'RETURNING', 'RETURNED', 'CANCELLED')
          and p_to in ('PENDING', 'BOOKED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'ON_HOLD'))
      or (p_from = 'RETURNED' and p_to in ('RETURNING', 'FAILED'))
      or (p_from in ('DELIVERED', 'PARTIALLY_DELIVERED') and p_to = 'FAILED')
$$;

-- Applies one logged event: finds the parcel, moves it (and the order) to the
-- new status, records fees the courier reported. Failures are kept on the event
-- with a retry time; nothing half-applied survives.
create or replace function public._process_courier_webhook(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e public.courier_webhook_events;
  v_ship public.shipments;
  v_prev public.shipment_status;
  v_applied boolean := false;
  v_charged numeric := 0;
  v_key text;
  v_date date;
  v_err text;
  v_result text;
  v_note text;
begin
  update public.courier_webhook_events set attempts = attempts + 1 where id = p_event_id returning * into e;
  if not found then
    raise exception 'NOT_FOUND: webhook event not found' using errcode = 'P0002';
  end if;

  select s.* into v_ship
  from public.shipments s
  join public.couriers c on c.id = s.courier_id
  join public.orders o on o.id = s.order_id
  where (case when e.courier_id is not null then s.courier_id = e.courier_id else c.provider = e.provider end)
    and ((e.consignment_id is not null and (s.consignment_id = e.consignment_id or s.tracking_number = e.consignment_id))
      or (e.order_ref is not null and upper(o.order_number) = upper(e.order_ref)))
  order by (e.consignment_id is not null and (s.consignment_id = e.consignment_id or s.tracking_number = e.consignment_id)) desc,
           s.is_active desc, s.created_at desc
  limit 1;
  if not found then
    update public.courier_webhook_events set result = 'UNMATCHED',
      error = format('No %s parcel with consignment %s or order %s', e.provider, coalesce(e.consignment_id, '-'), coalesce(e.order_ref, '-')),
      next_retry_at = case when attempts < 6 then now() + make_interval(mins => least(power(2, attempts)::int, 120)) end,
      processed_at = now()
    where id = p_event_id;
    return jsonb_build_object('status', 'unmatched', 'event_id', p_event_id);
  end if;

  v_prev := v_ship.status;
  v_date := (coalesce(e.occurred_at, now()) at time zone public.store_timezone())::date;
  begin
    if e.new_status is not null and e.new_status <> v_ship.status
       and not public._shipment_status_regresses(v_ship.status, e.new_status) then
      perform public.apply_shipment_status(v_ship.id, e.new_status,
        coalesce(nullif(e.payload ->> 'reason', ''), format('%s: %s', initcap(e.provider), coalesce(e.provider_status, e.event_type))),
        null, e.occurred_at, 'WEBHOOK', e.payload, 'webhook:' || e.event_key);
      v_applied := true;
    end if;

    -- Fees reported with the event (a parcel not yet picked up costs nothing).
    if coalesce(e.new_status, v_ship.status) not in ('PENDING', 'BOOKED', 'CANCELLED') then
      v_key := 'webhook:' || e.event_key;
      v_charged := abs(public._set_shipment_charge(v_ship.id, 'DELIVERY', (e.charges ->> 'delivery_fee')::numeric, 'WEBHOOK',
                     v_key || ':delivery', 'Delivery fee reported by courier', null, v_date))
                 + abs(public._set_shipment_charge(v_ship.id, 'RETURN', (e.charges ->> 'return_fee')::numeric, 'WEBHOOK',
                     v_key || ':return', 'Return charge reported by courier', null, v_date))
                 + abs(public._set_shipment_charge(v_ship.id, 'COD_FEE', (e.charges ->> 'cod_fee')::numeric, 'WEBHOOK',
                     v_key || ':cod_fee', 'COD fee reported by courier', null, v_date));
    end if;
    -- Returned without a fee in the message: the expected return charge stands in until the statement arrives.
    if e.new_status = 'RETURNED' and e.charges ->> 'return_fee' is null then
      v_charged := v_charged + abs(public._estimate_shipment_charge(v_ship.id, 'RETURN', v_ship.return_charge,
        'shipment:' || v_ship.id || ':return_charge', 'Courier return charge', v_date));
    end if;

    v_result := case when v_applied or v_charged <> 0 then 'PROCESSED' else 'IGNORED' end;
    v_note := case
      when v_applied then null
      when e.new_status is null and v_charged = 0 then 'No status change in this event' || coalesce(' (' || e.provider_status || ')', '')
      when e.new_status is not null and e.new_status = v_prev then 'Parcel already ' || replace(lower(v_prev::text), '_', ' ')
      when e.new_status is not null then format('Not applied: parcel is already %s', replace(lower(v_prev::text), '_', ' '))
    end;
    update public.courier_webhook_events set result = v_result, note = v_note, error = null,
      shipment_id = v_ship.id, order_id = v_ship.order_id, previous_status = v_prev, next_retry_at = null, processed_at = now()
    where id = p_event_id;
    return jsonb_build_object('status', lower(v_result), 'event_id', p_event_id, 'shipment_id', v_ship.id);
  exception when others then
    get stacked diagnostics v_err = message_text;
    update public.courier_webhook_events set result = 'FAILED', error = left(v_err, 500),
      shipment_id = v_ship.id, order_id = v_ship.order_id, previous_status = v_prev,
      next_retry_at = case when attempts < 6 then now() + make_interval(mins => least(power(2, attempts)::int, 120)) end,
      processed_at = now()
    where id = p_event_id;
    return jsonb_build_object('status', 'failed', 'event_id', p_event_id, 'error', left(v_err, 500));
  end;
end;
$$;

-- Entry point for courier-webhook (service role). The same event key arriving
-- again is counted, not re-applied; a failed or unmatched one is tried again.
create or replace function public.record_courier_webhook(p_courier_id uuid, p_provider text, p_event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_inserted boolean;
  v_result text;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if coalesce(p_event ->> 'event_key', '') = '' then
    raise exception 'VALIDATION: event_key is required' using errcode = '22023';
  end if;
  insert into public.courier_webhook_events(courier_id, provider, event_key, event_type, consignment_id, order_ref,
    provider_status, new_status, occurred_at, charges, payload)
  values (p_courier_id, p_provider, left(p_event ->> 'event_key', 300), coalesce(nullif(p_event ->> 'event_type', ''), 'status'),
    nullif(p_event ->> 'consignment_id', ''), nullif(p_event ->> 'order_ref', ''), nullif(p_event ->> 'provider_status', ''),
    nullif(p_event ->> 'status', '')::public.shipment_status, nullif(p_event ->> 'occurred_at', '')::timestamptz,
    coalesce(p_event -> 'charges', '{}'::jsonb), coalesce(p_event -> 'payload', '{}'::jsonb))
  on conflict (event_key) do update set duplicates = public.courier_webhook_events.duplicates + 1
  returning id, (xmax = 0), result into v_id, v_inserted, v_result;
  if not v_inserted and v_result not in ('FAILED', 'UNMATCHED') then
    return jsonb_build_object('status', 'duplicate', 'event_id', v_id);
  end if;
  return public._process_courier_webhook(v_id);
end;
$$;

-- Scheduled: retries failed / unmatched events whose retry time has come.
create or replace function public.retry_courier_webhooks(p_limit int default 100)
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
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  for v_id in
    select id from public.courier_webhook_events
    where result in ('FAILED', 'UNMATCHED') and next_retry_at <= now() and attempts < 6
    order by received_at limit least(greatest(p_limit, 1), 500)
  loop
    v_out := public._process_courier_webhook(v_id);
    v_counts := v_counts || jsonb_build_object(v_out ->> 'status', coalesce((v_counts ->> (v_out ->> 'status'))::int, 0) + 1);
  end loop;
  return v_counts;
end;
$$;

-- Staff: try one event again now (e.g. after fixing a consignment number).
create or replace function public.retry_courier_webhook(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result text;
begin
  perform public.require_permission('shipments.manage');
  select result into v_result from public.courier_webhook_events where id = p_event_id for update;
  if not found then
    raise exception 'NOT_FOUND: webhook event not found' using errcode = 'P0002';
  end if;
  if v_result not in ('FAILED', 'UNMATCHED') then
    raise exception 'VALIDATION: only failed or unmatched events can be retried' using errcode = '22023';
  end if;
  return public._process_courier_webhook(p_event_id);
end;
$$;

-- -----------------------------------------------------------------------------
-- Courier statements: import, match, verify, pay
-- -----------------------------------------------------------------------------
create or replace function public._jnum(p jsonb, p_key text, p_line int)
returns numeric
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v text := nullif(trim(p ->> p_key), '');
begin
  if v is null then
    return null;
  end if;
  return round(v::numeric, 2);
exception when others then
  raise exception 'VALIDATION: line %: % is not a number (%)', p_line, replace(p_key, '_', ' '), left(v, 30) using errcode = '22023';
end;
$$;

-- p: { courier_id, invoice_number?, invoice_date?, period_start?, period_end?, payout_reported?,
--      file_path?, file_name?, notes?,
--      lines: [{ consignment_id?, order_ref?, courier_status?, cod_collected?, delivery_fee?,
--                return_fee?, cod_fee?, other_fee?, payout? }] }
create or replace function public.import_courier_invoice(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_courier public.couriers;
  v_inv public.courier_invoices;
  v_line jsonb;
  v_no int := 0;
  v_ship public.shipments;
  v_order public.orders;
  v_issues text[];
  v_match text;
  v_dup text;
  v_consignment text;
  v_ref text;
  v_cod numeric; v_del numeric; v_ret numeric; v_codfee numeric; v_other numeric; v_payout numeric;
  v_exp_cod numeric; v_exp_del numeric; v_exp_ret numeric; v_exp_codfee numeric;
  v_pct numeric;
  v_seen uuid[] := '{}';
  v_all_payout boolean := true;
  t_cod numeric := 0; t_del numeric := 0; t_ret numeric := 0; t_codfee numeric := 0; t_other numeric := 0; t_payout numeric := 0;
  e_cod numeric := 0; e_del numeric := 0; e_ret numeric := 0; e_codfee numeric := 0; e_payout numeric := 0;
  n_match int := 0; n_mis int := 0; n_un int := 0; n_dup int := 0;
  v_reported numeric;
  v_number text := nullif(trim(p ->> 'invoice_number'), '');
begin
  perform public.require_permission('couriers.manage');
  select * into v_courier from public.couriers where id = (p ->> 'courier_id')::uuid;
  if not found then
    raise exception 'NOT_FOUND: courier not found' using errcode = 'P0002';
  end if;
  if jsonb_typeof(p -> 'lines') is distinct from 'array' or jsonb_array_length(p -> 'lines') = 0 then
    raise exception 'VALIDATION: the statement has no lines' using errcode = '22023';
  end if;
  if jsonb_array_length(p -> 'lines') > 5000 then
    raise exception 'VALIDATION: at most 5,000 lines per statement' using errcode = '22023';
  end if;
  if v_number is not null and exists (select 1 from public.courier_invoices
      where courier_id = v_courier.id and lower(invoice_number) = lower(v_number)) then
    raise exception 'DUPLICATE: statement % from % was already uploaded', v_number, v_courier.name using errcode = '23505';
  end if;
  v_pct := (v_courier.config ->> 'cod_fee_percent')::numeric;

  insert into public.courier_invoices(courier_id, invoice_number, invoice_date, period_start, period_end, file_path, file_name, notes)
  values (v_courier.id, v_number, nullif(p ->> 'invoice_date', '')::date, nullif(p ->> 'period_start', '')::date,
          nullif(p ->> 'period_end', '')::date, nullif(p ->> 'file_path', ''), left(nullif(p ->> 'file_name', ''), 200),
          nullif(trim(p ->> 'notes'), ''))
  returning * into v_inv;

  for v_line in select value from jsonb_array_elements(p -> 'lines') loop
    v_no := v_no + 1;
    v_issues := '{}';
    v_match := null;
    v_dup := null;
    v_ship := null;
    v_order := null;
    v_exp_cod := null; v_exp_del := null; v_exp_ret := null; v_exp_codfee := null;
    v_consignment := nullif(trim(v_line ->> 'consignment_id'), '');
    v_ref := nullif(trim(v_line ->> 'order_ref'), '');
    v_cod := public._jnum(v_line, 'cod_collected', v_no);
    v_del := public._jnum(v_line, 'delivery_fee', v_no);
    v_ret := public._jnum(v_line, 'return_fee', v_no);
    v_codfee := public._jnum(v_line, 'cod_fee', v_no);
    v_other := public._jnum(v_line, 'other_fee', v_no);
    v_payout := public._jnum(v_line, 'payout', v_no);
    if v_consignment is null and v_ref is null then
      raise exception 'VALIDATION: line % has no consignment ID or order number', v_no using errcode = '22023';
    end if;

    select s.* into v_ship
    from public.shipments s join public.orders o on o.id = s.order_id
    where s.courier_id = v_courier.id
      and ((v_consignment is not null and (s.consignment_id = v_consignment or s.tracking_number = v_consignment))
        or (v_ref is not null and upper(o.order_number) = upper(v_ref)))
    order by (v_consignment is not null and (s.consignment_id = v_consignment or s.tracking_number = v_consignment)) desc,
             s.is_active desc, s.created_at desc
    limit 1;

    if v_ship.id is null then
      v_match := 'UNMATCHED';
      v_issues := array['Not found among our ' || v_courier.name || ' parcels'];
    elsif v_ship.id = any(v_seen) then
      v_match := 'DUPLICATE';
      v_issues := array['Listed more than once on this statement'];
    else
      select coalesce(ci.invoice_number, to_char(ci.created_at, 'DD Mon YYYY')) into v_dup
      from public.courier_invoice_lines l join public.courier_invoices ci on ci.id = l.invoice_id
      where l.shipment_id = v_ship.id and l.invoice_id <> v_inv.id and l.match_status in ('MATCHED', 'MISMATCH')
      limit 1;
      if v_dup is not null then
        v_match := 'DUPLICATE';
        v_issues := array['Already billed on statement ' || v_dup];
      end if;
    end if;

    if v_ship.id is not null then
      select * into v_order from public.orders where id = v_ship.order_id;
      v_exp_cod := case when v_ship.status in ('DELIVERED', 'PARTIALLY_DELIVERED') then v_order.cod_amount else 0 end;
      v_exp_del := coalesce((select sum(amount) from public.shipment_charges where shipment_id = v_ship.id and kind = 'DELIVERY'),
                            nullif(v_ship.shipping_cost, 0));
      v_exp_ret := case when v_ship.status in ('RETURNING', 'RETURNED') or v_order.status in ('RETURNING', 'RETURNED')
                     then coalesce((select sum(amount) from public.shipment_charges where shipment_id = v_ship.id and kind = 'RETURN'),
                                   v_ship.return_charge)
                     else coalesce((select sum(amount) from public.shipment_charges where shipment_id = v_ship.id and kind = 'RETURN'), 0) end;
      v_exp_codfee := coalesce((select sum(amount) from public.shipment_charges where shipment_id = v_ship.id and kind = 'COD_FEE'),
                               case when v_pct is not null then round(v_exp_cod * v_pct / 100, 2) end);
      if v_match is null then
        if v_ship.status not in ('DELIVERED', 'PARTIALLY_DELIVERED', 'RETURNING', 'RETURNED', 'FAILED', 'CANCELLED') then
          v_issues := v_issues || ('Still ' || replace(lower(v_ship.status::text), '_', ' ') || ' in our records');
        end if;
        if v_cod is not null and abs(v_cod - v_exp_cod) >= 1 then
          v_issues := v_issues || format('Collected %s, expected %s', v_cod, v_exp_cod);
        end if;
        if v_del is not null and v_exp_del is not null and abs(v_del - v_exp_del) >= 1 then
          v_issues := v_issues || format('Delivery fee %s, expected %s', v_del, v_exp_del);
        end if;
        if v_ret is not null and abs(v_ret - coalesce(v_exp_ret, 0)) >= 1 then
          v_issues := v_issues || format('Return charge %s, expected %s', v_ret, coalesce(v_exp_ret, 0));
        end if;
        if v_codfee is not null and v_exp_codfee is not null and abs(v_codfee - v_exp_codfee) >= 1 then
          v_issues := v_issues || format('COD fee %s, expected %s', v_codfee, v_exp_codfee);
        end if;
        if coalesce(v_other, 0) <> 0 then
          v_issues := v_issues || format('Other fee %s', v_other);
        end if;
        v_match := case when cardinality(v_issues) > 0 then 'MISMATCH' else 'MATCHED' end;
      end if;
      v_seen := v_seen || v_ship.id;
    end if;

    insert into public.courier_invoice_lines(invoice_id, line_no, consignment_id, order_ref, courier_status, cod_collected,
      delivery_fee, return_fee, cod_fee, other_fee, payout, shipment_id, order_id, expected_cod, expected_delivery_fee,
      expected_return_fee, expected_cod_fee, match_status, issues)
    values (v_inv.id, v_no, v_consignment, v_ref, left(nullif(trim(v_line ->> 'courier_status'), ''), 60), v_cod, v_del, v_ret,
      v_codfee, v_other, v_payout, v_ship.id, v_ship.order_id, v_exp_cod, v_exp_del, v_exp_ret, v_exp_codfee, v_match, v_issues);

    t_cod := t_cod + coalesce(v_cod, 0);
    t_del := t_del + coalesce(v_del, 0);
    t_ret := t_ret + coalesce(v_ret, 0);
    t_codfee := t_codfee + coalesce(v_codfee, 0);
    t_other := t_other + coalesce(v_other, 0);
    if v_payout is null then v_all_payout := false; else t_payout := t_payout + v_payout; end if;
    if v_match in ('MATCHED', 'MISMATCH') then
      -- Without our own figure for a fee there is nothing to dispute: the statement's stands.
      e_cod := e_cod + coalesce(v_exp_cod, 0);
      e_del := e_del + coalesce(v_exp_del, v_del, 0);
      e_ret := e_ret + coalesce(v_exp_ret, 0);
      e_codfee := e_codfee + coalesce(v_exp_codfee, v_codfee, 0);
      e_payout := e_payout + coalesce(v_exp_cod, 0) - coalesce(v_exp_del, v_del, 0) - coalesce(v_exp_ret, 0) - coalesce(v_exp_codfee, v_codfee, 0);
    end if;
    case v_match when 'MATCHED' then n_match := n_match + 1; when 'MISMATCH' then n_mis := n_mis + 1;
                 when 'UNMATCHED' then n_un := n_un + 1; else n_dup := n_dup + 1; end case;
  end loop;

  v_reported := coalesce(public._jnum(p, 'payout_reported', 0),
                         case when v_all_payout then t_payout end,
                         t_cod - t_del - t_ret - t_codfee - t_other);
  update public.courier_invoices set
    line_count = v_no, matched_count = n_match, mismatch_count = n_mis, unmatched_count = n_un, duplicate_count = n_dup,
    cod_collected = t_cod, delivery_fees = t_del, return_fees = t_ret, cod_fees = t_codfee, other_fees = t_other,
    payout_reported = v_reported,
    expected_cod_collected = e_cod, expected_delivery_fees = e_del, expected_return_fees = e_ret, expected_cod_fees = e_codfee,
    payout_expected = e_payout,
    status = case when n_mis + n_un + n_dup > 0 or abs(v_reported - e_payout) >= 1 then 'DISCREPANCY' else 'NEEDS_REVIEW' end::public.courier_invoice_status
  where id = v_inv.id
  returning * into v_inv;
  perform public.log_audit('courier_invoice.imported', 'courier_invoice', v_inv.id::text, null,
    jsonb_build_object('courier', v_courier.name, 'invoice_number', v_number, 'lines', v_no, 'difference', v_inv.difference), null);
  return jsonb_build_object('invoice_id', v_inv.id, 'status', v_inv.status, 'lines', v_no, 'matched', n_match,
    'mismatched', n_mis, 'unmatched', n_un, 'duplicates', n_dup, 'payout_expected', v_inv.payout_expected,
    'payout_reported', v_inv.payout_reported, 'difference', v_inv.difference);
end;
$$;

-- The statement's fees become each parcel's actual charges (idempotent per line).
create or replace function public._apply_invoice_charges(p_invoice_id uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inv public.courier_invoices;
  l public.courier_invoice_lines;
  v_label text;
  v_date date;
  v_count int := 0;
begin
  select * into v_inv from public.courier_invoices where id = p_invoice_id;
  v_label := 'statement ' || coalesce(v_inv.invoice_number, to_char(v_inv.created_at, 'DD Mon YYYY'));
  v_date := coalesce(v_inv.invoice_date, (now() at time zone public.store_timezone())::date);
  for l in select * from public.courier_invoice_lines
           where invoice_id = p_invoice_id and match_status in ('MATCHED', 'MISMATCH') and shipment_id is not null
           order by line_no loop
    perform public._set_shipment_charge(l.shipment_id, 'DELIVERY', l.delivery_fee, 'INVOICE', 'invoice_line:' || l.id || ':delivery',
      'Delivery fee on ' || v_label, p_invoice_id, v_date);
    perform public._set_shipment_charge(l.shipment_id, 'RETURN', l.return_fee, 'INVOICE', 'invoice_line:' || l.id || ':return',
      'Return charge on ' || v_label, p_invoice_id, v_date);
    perform public._set_shipment_charge(l.shipment_id, 'COD_FEE', l.cod_fee, 'INVOICE', 'invoice_line:' || l.id || ':cod_fee',
      'COD fee on ' || v_label, p_invoice_id, v_date);
    perform public._set_shipment_charge(l.shipment_id, 'OTHER', l.other_fee, 'INVOICE', 'invoice_line:' || l.id || ':other',
      'Other courier fee on ' || v_label, p_invoice_id, v_date);
    v_count := v_count + 1;
  end loop;
  update public.courier_invoices set charges_applied_at = coalesce(charges_applied_at, now()) where id = p_invoice_id;
  return v_count;
end;
$$;

-- The courier paid out: the cash it collected counts as received on each order.
create or replace function public._settle_invoice_cod(p_invoice_id uuid)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inv public.courier_invoices;
  v_courier text;
  l public.courier_invoice_lines;
  v_order public.orders;
  v_amount numeric;
  v_total numeric := 0;
begin
  select * into v_inv from public.courier_invoices where id = p_invoice_id;
  select name into v_courier from public.couriers where id = v_inv.courier_id;
  for l in select * from public.courier_invoice_lines
           where invoice_id = p_invoice_id and match_status in ('MATCHED', 'MISMATCH') and order_id is not null
             and coalesce(cod_collected, 0) > 0 and settled_at is null
           order by line_no for update loop
    select * into v_order from public.orders where id = l.order_id for update;
    v_amount := least(l.cod_collected, v_order.total_amount - v_order.amount_paid);
    if v_amount > 0 and v_order.status not in ('CANCELLED', 'REJECTED_FRAUD') then
      perform public.record_order_payment(l.order_id, 'COD', 'COURIER_COD', v_amount,
        coalesce(v_inv.invoice_number, 'courier statement'), 'COD paid out by ' || v_courier, 'cod:invoice_line:' || l.id);
      update public.shipments set cod_collected = cod_collected + v_amount, cod_collected_at = now() where id = l.shipment_id;
      v_total := v_total + v_amount;
    end if;
    update public.courier_invoice_lines set settled_at = now() where id = l.id;
  end loop;
  return v_total;
end;
$$;

create or replace function public.set_courier_invoice_status(
  p_invoice_id uuid,
  p_status public.courier_invoice_status,
  p_note text default null,
  p_amount_paid numeric default null,
  p_reference text default null
)
returns public.courier_invoices
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inv public.courier_invoices;
  v_old public.courier_invoice_status;
  v_settled numeric;
begin
  perform public.require_permission(case when p_status = 'PAID' then 'payments.record' else 'couriers.manage' end);
  select * into v_inv from public.courier_invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'NOT_FOUND: statement not found' using errcode = 'P0002';
  end if;
  v_old := v_inv.status;
  if v_old = 'PAID' then
    raise exception 'VALIDATION: a paid statement cannot be changed' using errcode = '22023';
  end if;
  if p_amount_paid is not null and p_amount_paid < 0 then
    raise exception 'VALIDATION: amount paid cannot be negative' using errcode = '22023';
  end if;
  if p_status in ('VERIFIED', 'PAID') then
    perform public._apply_invoice_charges(p_invoice_id);
  end if;
  if p_status = 'PAID' then
    v_settled := public._settle_invoice_cod(p_invoice_id);
  end if;
  update public.courier_invoices set status = p_status,
    notes = coalesce(nullif(trim(p_note), ''), notes),
    amount_paid = case when p_status = 'PAID' then coalesce(p_amount_paid, payout_reported) else amount_paid end,
    paid_at = case when p_status = 'PAID' then now() else paid_at end,
    paid_reference = case when p_status = 'PAID' then nullif(trim(p_reference), '') else paid_reference end,
    reviewed_by = auth.uid(), reviewed_at = now()
  where id = p_invoice_id
  returning * into v_inv;
  perform public.log_audit('courier_invoice.status', 'courier_invoice', p_invoice_id::text,
    jsonb_build_object('status', v_old), jsonb_build_object('status', p_status, 'cod_settled', v_settled), null);
  return v_inv;
end;
$$;

-- -----------------------------------------------------------------------------
-- Courier performance for the Couriers page
-- -----------------------------------------------------------------------------
create or replace function public.courier_metrics(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb;
begin
  perform public.require_permission('couriers.view');
  select coalesce(jsonb_agg(t order by t.booked desc, t.name), '[]'::jsonb) into v from (
    select c.id, c.name, c.provider, c.api_enabled, c.is_active,
      count(s.id) filter (where s.status <> 'CANCELLED') as booked,
      count(s.id) filter (where s.status not in ('PENDING', 'BOOKED', 'CANCELLED')) as shipped,
      count(s.id) filter (where s.status in ('DELIVERED', 'PARTIALLY_DELIVERED')) as delivered,
      count(s.id) filter (where s.status = 'PARTIALLY_DELIVERED') as partial,
      count(s.id) filter (where s.status in ('RETURNING', 'RETURNED')) as returned,
      count(s.id) filter (where s.status = 'CANCELLED') as cancelled,
      count(s.id) filter (where s.status in ('PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'ON_HOLD', 'FAILED')) as in_transit,
      case when count(s.id) filter (where s.status in ('DELIVERED', 'PARTIALLY_DELIVERED', 'RETURNING', 'RETURNED')) > 0
        then round(100.0 * count(s.id) filter (where s.status in ('DELIVERED', 'PARTIALLY_DELIVERED'))
             / count(s.id) filter (where s.status in ('DELIVERED', 'PARTIALLY_DELIVERED', 'RETURNING', 'RETURNED')), 1) end as delivery_rate,
      case when count(s.id) filter (where s.status in ('DELIVERED', 'PARTIALLY_DELIVERED', 'RETURNING', 'RETURNED')) > 0
        then round(100.0 * count(s.id) filter (where s.status in ('RETURNING', 'RETURNED'))
             / count(s.id) filter (where s.status in ('DELIVERED', 'PARTIALLY_DELIVERED', 'RETURNING', 'RETURNED')), 1) end as return_rate,
      coalesce(sum(ch.delivery), 0) as delivery_cost,
      coalesce(sum(ch.return_cost), 0) as return_cost,
      coalesce(sum(ch.cod_fee), 0) as cod_fees,
      coalesce(sum(ch.other), 0) as other_costs,
      coalesce(sum(ch.total), 0) as total_cost,
      case when count(s.id) filter (where s.status not in ('PENDING', 'BOOKED', 'CANCELLED')) > 0
        then round(coalesce(sum(ch.total), 0) / count(s.id) filter (where s.status not in ('PENDING', 'BOOKED', 'CANCELLED')), 2) end as avg_cost_per_order,
      coalesce(sum(o.cod_amount) filter (where s.status in ('DELIVERED', 'PARTIALLY_DELIVERED')), 0) as cod_expected,
      coalesce(sum(s.cod_collected), 0) as cod_settled,
      round(avg(extract(epoch from (s.delivered_at - o.shipped_at)) / 3600)
        filter (where s.delivered_at is not null and o.shipped_at is not null), 1) as avg_delivery_hours
    from public.couriers c
    left join public.shipments s on s.courier_id = c.id
      and s.created_at >= public._ts_from(p_from) and s.created_at < public._ts_from(p_to + 1)
    left join public.orders o on o.id = s.order_id
    left join (
      select shipment_id,
             sum(amount) filter (where kind = 'DELIVERY') as delivery,
             sum(amount) filter (where kind = 'RETURN') as return_cost,
             sum(amount) filter (where kind = 'COD_FEE') as cod_fee,
             sum(amount) filter (where kind = 'OTHER') as other,
             sum(amount) as total
      from public.shipment_charges group by shipment_id
    ) ch on ch.shipment_id = s.id
    group by c.id
    having c.is_active or count(s.id) > 0
  ) t;
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- Webhook secret per courier (Vault). The courier sends it with every callback;
-- couriers.config only says that one is set.
-- -----------------------------------------------------------------------------
create or replace function public.courier_webhook_secret_set(p_courier_id uuid, p_secret text, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_secret uuid;
  v_name text := 'courier-webhook:' || p_courier_id::text;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_secret is null or length(p_secret) < 16 or length(p_secret) > 200 then
    raise exception 'VALIDATION: the webhook secret must be 16 to 200 characters' using errcode = '22023';
  end if;
  if not exists (select 1 from public.couriers where id = p_courier_id) then
    raise exception 'NOT_FOUND: courier not found' using errcode = 'P0002';
  end if;
  select id into v_secret from vault.secrets where name = v_name;
  if v_secret is null then
    perform vault.create_secret(p_secret, v_name, 'Courier webhook secret');
  else
    perform vault.update_secret(v_secret, p_secret);
  end if;
  update public.couriers set config = config || jsonb_build_object('webhook_secret_hint', '••••' || right(p_secret, 4),
    'webhook_secret_set_at', now()) where id = p_courier_id;
  insert into public.audit_logs(actor_id, actor_email, action, entity_type, entity_id, metadata)
  values (p_actor, (select email from public.profiles where id = p_actor), 'courier.webhook_secret_set', 'couriers',
          p_courier_id::text, '{}'::jsonb);
end;
$$;

create or replace function public.courier_webhook_secret_get(p_courier_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_value text;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select decrypted_secret into v_value from vault.decrypted_secrets where name = 'courier-webhook:' || p_courier_id::text;
  return nullif(v_value, '');
end;
$$;

revoke execute on function public.courier_webhook_secret_set(uuid, text, uuid), public.courier_webhook_secret_get(uuid)
  from public, anon, authenticated;
grant execute on function public.courier_webhook_secret_set(uuid, text, uuid), public.courier_webhook_secret_get(uuid)
  to service_role;

-- -----------------------------------------------------------------------------
-- Storage for uploaded statements (staff only)
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('courier-invoices', 'courier-invoices', false, 10485760, null)
on conflict (id) do nothing;
create policy "courier invoices read" on storage.objects for select to authenticated
  using (bucket_id = 'courier-invoices' and ((select public.has_permission('couriers.view')) or (select public.has_permission('finance.view'))));
create policy "courier invoices write" on storage.objects for insert to authenticated
  with check (bucket_id = 'courier-invoices' and (select public.has_permission('couriers.manage')));

-- -----------------------------------------------------------------------------
-- RLS, grants, schedule
-- -----------------------------------------------------------------------------
alter table public.courier_webhook_events enable row level security;
alter table public.shipment_charges enable row level security;
alter table public.courier_invoices enable row level security;
alter table public.courier_invoice_lines enable row level security;

create policy courier_webhook_events_read on public.courier_webhook_events for select to authenticated
  using ((select public.has_permission('couriers.view')) or (select public.has_permission('shipments.manage')));
create policy shipment_charges_read on public.shipment_charges for select to authenticated
  using ((select public.has_permission('orders.view')) or (select public.has_permission('couriers.view'))
         or (select public.has_permission('finance.view')));
create policy courier_invoices_read on public.courier_invoices for select to authenticated
  using ((select public.has_permission('couriers.view')) or (select public.has_permission('finance.view')));
create policy courier_invoice_lines_read on public.courier_invoice_lines for select to authenticated
  using ((select public.has_permission('couriers.view')) or (select public.has_permission('finance.view')));

revoke all on public.courier_webhook_events, public.shipment_charges, public.courier_invoices, public.courier_invoice_lines
  from anon, authenticated;
grant select on public.courier_webhook_events, public.shipment_charges, public.courier_invoices, public.courier_invoice_lines
  to authenticated;
grant all on public.courier_webhook_events, public.shipment_charges, public.courier_invoices, public.courier_invoice_lines
  to service_role;

revoke execute on function
  public._charge_category(public.shipment_charge_kind), public._courier_cod_fee(uuid, numeric),
  public._set_shipment_charge(uuid, public.shipment_charge_kind, numeric, public.charge_source, text, text, uuid, date),
  public._estimate_shipment_charge(uuid, public.shipment_charge_kind, numeric, text, text, date),
  public._shipment_status_regresses(public.shipment_status, public.shipment_status),
  public._process_courier_webhook(uuid), public.record_courier_webhook(uuid, text, jsonb), public.retry_courier_webhooks(int),
  public.retry_courier_webhook(uuid), public._jnum(jsonb, text, int), public.import_courier_invoice(jsonb),
  public._apply_invoice_charges(uuid), public._settle_invoice_cod(uuid),
  public.set_courier_invoice_status(uuid, public.courier_invoice_status, text, numeric, text), public.courier_metrics(date, date),
  public._post_order_delivery_finance(uuid), public._post_order_return_finance(uuid)
from public, anon, authenticated;
grant execute on function public.record_courier_webhook(uuid, text, jsonb), public.retry_courier_webhooks(int) to service_role;
grant execute on function public.retry_courier_webhook(uuid), public.import_courier_invoice(jsonb),
  public.set_courier_invoice_status(uuid, public.courier_invoice_status, text, numeric, text), public.courier_metrics(date, date)
  to authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('courier-webhook-retry', '*/5 * * * *', 'select public.retry_courier_webhooks()');
  end if;
end;
$$;
