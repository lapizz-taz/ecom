-- =============================================================================
-- Web Orders and Approved Orders
--
-- Every order starts in Web Orders: it is not approved yet (confirmed_at is
-- null). Staff call the customer, record the outcome with a configurable call
-- status (Processing, No response, Follow-up, …) and approve it. Approval is
-- the CONFIRMED transition, so the existing stock, fraud and payment rules all
-- still apply. From then on the order is in Approved Orders, where its stage
-- (Pending, RTS, Shipped, Delivered, …) follows the order status.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Call statuses for web orders (editable in Settings → Orders)
-- -----------------------------------------------------------------------------
create table public.order_review_statuses (
  code text primary key check (code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  label text not null check (length(trim(label)) between 1 and 40),
  description text check (length(description) <= 200),
  color text not null default 'neutral' check (color in ('neutral', 'info', 'success', 'warning', 'danger', 'violet')),
  -- Moving an order here cancels it (stock goes back, pending payments are voided).
  closes_order boolean not null default false,
  -- Requires a call-back time.
  needs_follow_up boolean not null default false,
  -- Counts as a call attempt.
  counts_contact boolean not null default false,
  is_system boolean not null default false,
  is_active boolean not null default true,
  sort_order int not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger order_review_statuses_updated_at before update on public.order_review_statuses
  for each row execute function public.set_updated_at();

insert into public.order_review_statuses(code, label, description, color, closes_order, needs_follow_up, counts_contact, is_system, sort_order) values
  ('PROCESSING', 'Processing', 'New, or being handled', 'info', false, false, false, true, 10),
  ('GOOD_NO_RESPONSE', 'Good but no response', 'Good courier history, but did not pick up', 'violet', false, false, true, true, 20),
  ('NO_RESPONSE', 'No response', 'Did not pick up the call', 'warning', false, false, true, true, 30),
  ('FOLLOW_UP', 'Follow-up', 'Call back at an agreed time', 'info', false, true, false, true, 40),
  ('DUPLICATE', 'Duplicate', 'The customer ordered the same thing again', 'neutral', true, false, false, true, 80),
  ('INVALID', 'Invalid', 'Fake, prank or unusable details', 'danger', true, false, false, true, 85),
  ('CANCELLED', 'Cancelled', 'Cancelled before approval', 'neutral', true, false, false, true, 90),
  ('OLD_CANCELLED', 'Old cancelled', 'Went stale without an answer and was closed', 'neutral', true, false, false, true, 95)
on conflict (code) do nothing;

alter table public.orders
  add column review_status text not null default 'PROCESSING' references public.order_review_statuses(code),
  add column review_note text check (length(review_note) <= 500),
  add column follow_up_at timestamptz,
  add column contact_attempts int not null default 0 check (contact_attempts >= 0),
  add column last_contact_at timestamptz,
  add column review_updated_at timestamptz,
  add column review_updated_by uuid,
  add column approved_by uuid,
  -- Value of the goods the customer sent back on a partial delivery: not due.
  add column partial_return_amount numeric(12,2) not null default 0 check (partial_return_amount >= 0),
  add column lost_at timestamptz,
  add constraint orders_partial_return_le_total check (partial_return_amount <= total_amount);

create index orders_web_queue_idx on public.orders(review_status, created_at desc) where confirmed_at is null;
create index orders_follow_up_idx on public.orders(follow_up_at) where confirmed_at is null and follow_up_at is not null;
create index orders_approved_idx on public.orders(status, confirmed_at desc) where confirmed_at is not null;

-- Orders that already moved past confirmation count as approved.
update public.orders set confirmed_at = created_at
where confirmed_at is null
  and status not in ('PENDING', 'FRAUD_CHECK', 'ADVANCE_REQUIRED', 'FRAUD_REVIEW', 'CONFIRMATION_REQUIRED', 'CANCELLED', 'REJECTED_FRAUD');
update public.orders set review_status = case when status = 'REJECTED_FRAUD' then 'INVALID' else 'CANCELLED' end
where confirmed_at is null and status in ('CANCELLED', 'REJECTED_FRAUD');

-- Web orders wait for approval instead of being confirmed automatically.
update public.settings set value = value || '{"require_confirmation": true}'::jsonb where key = 'orders';

-- -----------------------------------------------------------------------------
-- Stage of an order (WEB until approved)
-- -----------------------------------------------------------------------------
create or replace function public.order_stage(p_status public.order_status, p_confirmed_at timestamptz)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_confirmed_at is null then 'WEB'
    when p_status in ('CONFIRMED', 'PROCESSING', 'PRODUCTION', 'QUALITY_CHECK', 'PACKING') then 'PENDING'
    when p_status = 'PRE_ORDER' then 'PRE_ORDER'
    when p_status = 'READY_TO_SHIP' then 'RTS'
    when p_status = 'SHIPPED' then 'SHIPPED'
    when p_status = 'PENDING_CANCEL' then 'PENDING_CANCEL'
    when p_status = 'DELIVERED' then 'DELIVERED'
    when p_status = 'PARTIALLY_DELIVERED' then 'PARTIAL'
    when p_status in ('FAILED_DELIVERY', 'RETURN_REQUESTED') then 'PENDING_RETURN'
    when p_status = 'RETURNING' then 'RETURN_PENDING'
    when p_status = 'RETURNED' then 'RETURNED'
    when p_status = 'LOST' then 'LOST'
    else 'CANCELLED'
  end
$$;

-- A web order cancelled by any route (customer, timeout, fraud) shows as
-- Cancelled / Invalid; one reopened from fraud review goes back to Processing.
create or replace function public._orders_review_sync()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.confirmed_at is null and new.status in ('CANCELLED', 'REJECTED_FRAUD')
     and old.status not in ('CANCELLED', 'REJECTED_FRAUD')
     and not exists (select 1 from public.order_review_statuses where code = new.review_status and closes_order) then
    new.review_status := case when new.status = 'REJECTED_FRAUD' then 'INVALID' else 'CANCELLED' end;
  elsif new.status not in ('CANCELLED', 'REJECTED_FRAUD') and old.status in ('CANCELLED', 'REJECTED_FRAUD') then
    new.review_status := 'PROCESSING';
  end if;
  if new.confirmed_at is not null and old.confirmed_at is null then
    new.follow_up_at := null;
  end if;
  return new;
end;
$$;
create trigger orders_review_sync before update of status on public.orders
  for each row execute function public._orders_review_sync();

-- -----------------------------------------------------------------------------
-- New transitions
-- -----------------------------------------------------------------------------
insert into public.order_status_transitions(from_status, to_status) values
  ('CONFIRMED', 'PRE_ORDER'), ('PROCESSING', 'PRE_ORDER'),
  ('PRE_ORDER', 'PROCESSING'), ('PRE_ORDER', 'PRODUCTION'), ('PRE_ORDER', 'PACKING'), ('PRE_ORDER', 'READY_TO_SHIP'),
  ('PRE_ORDER', 'CANCELLED'),
  ('READY_TO_SHIP', 'PENDING_CANCEL'), ('SHIPPED', 'PENDING_CANCEL'),
  ('PENDING_CANCEL', 'CANCELLED'), ('PENDING_CANCEL', 'READY_TO_SHIP'), ('PENDING_CANCEL', 'SHIPPED'),
  ('PENDING_CANCEL', 'DELIVERED'), ('PENDING_CANCEL', 'RETURNING'), ('PENDING_CANCEL', 'RETURNED'), ('PENDING_CANCEL', 'LOST'),
  ('SHIPPED', 'PARTIALLY_DELIVERED'), ('FAILED_DELIVERY', 'PARTIALLY_DELIVERED'),
  ('PARTIALLY_DELIVERED', 'RETURN_REQUESTED'),
  ('SHIPPED', 'RETURNING'), ('FAILED_DELIVERY', 'RETURNING'), ('RETURN_REQUESTED', 'RETURNING'),
  ('RETURNING', 'RETURNED'), ('RETURNING', 'LOST'),
  ('SHIPPED', 'LOST'), ('FAILED_DELIVERY', 'LOST'), ('RETURN_REQUESTED', 'LOST'),
  ('LOST', 'DELIVERED'), ('LOST', 'RETURNED')
on conflict do nothing;

insert into public.finance_categories(code, name, type, pnl_group, is_system, allow_manual, sort_order, description) values
  ('PARTIAL_RETURNS', 'Partial delivery returns', 'EXPENSE', 'CONTRA_REVENUE', true, false, 215,
   'Goods sent back on a partial delivery (reduces revenue)'),
  ('LOST_PARCELS', 'Lost parcels', 'EXPENSE', 'COGS', true, false, 115, 'Cost of goods a courier lost'),
  ('COURIER_CLAIMS', 'Courier claims', 'INCOME', 'OTHER_INCOME', true, true, 65,
   'Compensation from couriers for lost or damaged parcels')
on conflict (code) do nothing;

create or replace function public.order_is_editable(p_status public.order_status)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_status in ('PENDING', 'FRAUD_CHECK', 'ADVANCE_REQUIRED', 'FRAUD_REVIEW', 'CONFIRMATION_REQUIRED',
                      'CONFIRMED', 'PRE_ORDER', 'PROCESSING', 'PRODUCTION', 'QUALITY_CHECK', 'PACKING', 'READY_TO_SHIP')
$$;

-- -----------------------------------------------------------------------------
-- Finance for the new stages
-- -----------------------------------------------------------------------------
create or replace function public._post_partial_return_finance(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
begin
  select * into v_order from public.orders where id = p_order_id;
  if v_order.partial_return_amount <= 0 or v_order.delivered_at is null then
    return;
  end if;
  perform public._post_finance('EXPENSE', 'PARTIAL_RETURNS', v_order.partial_return_amount,
    (v_order.delivered_at at time zone public.store_timezone())::date, false, p_order_id, v_order.customer_id, null,
    v_order.order_number, 'Goods sent back on a partial delivery', 'order:' || p_order_id || ':partial_return', null);
end;
$$;

-- The goods are gone: their cost becomes an expense (reversed if the parcel turns up).
create or replace function public._post_lost_parcel_finance(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_cost numeric;
  v_n int;
begin
  select * into v_order from public.orders where id = p_order_id;
  if v_order.shipped_at is null or v_order.delivered_at is not null then
    return; -- not shipped yet, or the cost was already recognised on delivery
  end if;
  select coalesce(sum(unit_cost * (quantity - returned_quantity - damaged_quantity)), 0) into v_cost
  from public.order_items where order_id = p_order_id;
  select count(*) into v_n from public.order_status_history where order_id = p_order_id and to_status = 'LOST';
  perform public._post_finance('EXPENSE', 'LOST_PARCELS', public.money(v_cost),
    (now() at time zone public.store_timezone())::date, false, p_order_id, null, null,
    v_order.order_number, 'Parcel lost by the courier', 'order:' || p_order_id || ':lost:' || v_n, null);
end;
$$;

create or replace function public._reverse_lost_parcel_finance(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n int;
  v_amount numeric;
  v_number text;
begin
  select count(*) into v_n from public.order_status_history where order_id = p_order_id and to_status = 'LOST';
  select amount into v_amount from public.finance_transactions where source_key = 'order:' || p_order_id || ':lost:' || v_n;
  if v_amount is null then
    return;
  end if;
  select order_number into v_number from public.orders where id = p_order_id;
  perform public._post_finance('EXPENSE', 'LOST_PARCELS', -v_amount,
    (now() at time zone public.store_timezone())::date, false, p_order_id, null, null,
    v_number, 'Lost parcel found', 'order:' || p_order_id || ':lost:' || v_n || ':found', null);
end;
$$;

-- -----------------------------------------------------------------------------
-- Status engine (adds the new stages; everything else unchanged)
-- -----------------------------------------------------------------------------
create or replace function public._transition_order(
  p_order_id uuid,
  p_to public.order_status,
  p_note text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_sync_production boolean default true
)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_from public.order_status;
  v_released int;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'NOT_FOUND: order % does not exist', p_order_id using errcode = 'P0002';
  end if;
  v_from := v_order.status;
  if v_from = p_to then
    return v_order;
  end if;
  if not exists (select 1 from public.order_status_transitions where from_status = v_from and to_status = p_to) then
    raise exception 'INVALID_TRANSITION: an order cannot move from % to %', v_from, p_to using errcode = 'P0001';
  end if;

  if p_to = 'SHIPPED' and public.setting_bool('orders', array['require_courier_before_ship'], false)
     and not exists (select 1 from public.shipments where order_id = p_order_id and is_active) then
    raise exception 'VALIDATION: assign a courier before shipping' using errcode = '22023';
  end if;
  if v_from = 'PENDING_CANCEL' and v_order.shipped_at is not null and p_to in ('CANCELLED', 'READY_TO_SHIP') then
    raise exception 'VALIDATION: the courier already picked this parcel up — mark it as returning instead' using errcode = '22023';
  end if;
  if v_from = 'PENDING_CANCEL' and v_order.shipped_at is null and p_to in ('RETURNING', 'RETURNED', 'LOST') then
    raise exception 'VALIDATION: the parcel was never picked up — cancel the order instead' using errcode = '22023';
  end if;

  update public.orders set
    status = p_to,
    confirmed_at = case when p_to = 'CONFIRMED' then coalesce(confirmed_at, now()) else confirmed_at end,
    shipped_at = case when p_to = 'SHIPPED' then coalesce(shipped_at, now()) else shipped_at end,
    delivered_at = case when p_to in ('DELIVERED', 'PARTIALLY_DELIVERED') then coalesce(delivered_at, now()) else delivered_at end,
    cancelled_at = case when p_to in ('CANCELLED', 'REJECTED_FRAUD') then now() else cancelled_at end,
    returned_at = case when p_to = 'RETURNED' then now() else returned_at end,
    lost_at = case when p_to = 'LOST' then now() when v_from = 'LOST' then null else lost_at end,
    cancel_reason = case
      when p_to = 'PENDING_CANCEL' then coalesce(p_note, cancel_reason)
      when p_to = 'CANCELLED' and v_from = 'PENDING_CANCEL' then coalesce(cancel_reason, p_note)
      when p_to in ('CANCELLED', 'REJECTED_FRAUD') then coalesce(p_note, cancel_reason)
      else cancel_reason end,
    advance_due_at = case when p_to = 'ADVANCE_REQUIRED'
      then now() + make_interval(hours => public.setting_numeric('orders', array['advance_payment_timeout_hours'], 24)::int)
      else advance_due_at end
  where id = p_order_id
  returning * into v_order;

  perform public._order_log(p_order_id, 'STATUS_CHANGED', p_note, v_from, p_to, p_metadata,
    p_to in ('CONFIRMED', 'ADVANCE_REQUIRED', 'PROCESSING', 'PRE_ORDER', 'SHIPPED', 'DELIVERED', 'PARTIALLY_DELIVERED',
             'CANCELLED', 'RETURNED', 'READY_TO_SHIP'));

  -- Side effects --------------------------------------------------------------
  if p_to in ('CANCELLED', 'REJECTED_FRAUD') then
    v_released := public._release_order_stock(p_order_id, case when p_to = 'REJECTED_FRAUD'
      then 'Released: order rejected (fraud)' else 'Released: order cancelled' end);
    if v_released > 0 then
      perform public._order_log(p_order_id, 'STOCK_RELEASED', format('%s reservation(s) released', v_released));
    end if;
    update public.coupon_usage set voided_at = now() where order_id = p_order_id and voided_at is null;
    if found then
      update public.coupons c set usage_count = greatest(c.usage_count - 1, 0)
      where c.id = v_order.coupon_id;
    end if;
    update public.payments set status = 'CANCELLED', failure_reason = 'Order cancelled'
    where order_id = p_order_id and status in ('PENDING');
    update public.shipments set status = 'CANCELLED', updated_at = now()
    where order_id = p_order_id and is_active and status in ('PENDING', 'BOOKED', 'ON_HOLD');
    perform public._production_cancel_for_order(p_order_id);
    if p_to = 'CANCELLED' then
      perform public._enqueue_order_notification(p_order_id, 'ORDER_CANCELLED');
    end if;
  elsif p_to = 'ADVANCE_REQUIRED' then
    perform public._enqueue_order_notification(p_order_id, 'ADVANCE_REQUIRED');
  elsif p_to = 'CONFIRMED' then
    perform public._enqueue_order_notification(p_order_id, 'ORDER_CONFIRMED');
  elsif p_to = 'PROCESSING' then
    perform public._production_create_for_order(p_order_id);
  elsif p_to = 'SHIPPED' then
    perform public._commit_order_stock(p_order_id);
    update public.shipments set status = 'IN_TRANSIT', updated_at = now()
    where order_id = p_order_id and is_active and status in ('PENDING', 'BOOKED', 'PICKED_UP', 'FAILED', 'ON_HOLD');
    if v_from <> 'PENDING_CANCEL' then
      perform public._enqueue_order_notification(p_order_id, 'ORDER_SHIPPED');
    end if;
  elsif p_to in ('DELIVERED', 'PARTIALLY_DELIVERED') then
    update public.shipments set status = case when p_to = 'DELIVERED' then 'DELIVERED' else 'PARTIALLY_DELIVERED' end::public.shipment_status,
      delivered_at = coalesce(delivered_at, now()),
      return_status = case when p_to = 'DELIVERED' then 'NONE' else return_status end, updated_at = now()
    where order_id = p_order_id and is_active and status not in ('DELIVERED', 'PARTIALLY_DELIVERED');
    if v_from = 'LOST' then
      perform public._reverse_lost_parcel_finance(p_order_id);
    end if;
    perform public._post_order_delivery_finance(p_order_id);
    if p_to = 'PARTIALLY_DELIVERED' then
      perform public._post_partial_return_finance(p_order_id);
    end if;
    if v_from = 'SHIPPED' then
      perform public._enqueue_order_notification(p_order_id, 'ORDER_DELIVERED');
    end if;
  elsif p_to = 'FAILED_DELIVERY' then
    update public.shipments set status = 'FAILED', updated_at = now()
    where order_id = p_order_id and is_active and status not in ('FAILED', 'RETURNED');
  elsif p_to = 'RETURN_REQUESTED' then
    update public.shipments set return_status = 'REQUESTED', updated_at = now()
    where order_id = p_order_id and is_active and return_status = 'NONE';
  elsif p_to = 'RETURNING' then
    update public.shipments set status = 'RETURNING', return_status = 'IN_TRANSIT', updated_at = now()
    where order_id = p_order_id and is_active and status <> 'RETURNED';
  elsif p_to = 'LOST' then
    perform public._post_lost_parcel_finance(p_order_id);
    perform public._order_log(p_order_id, 'PARCEL_LOST', 'File a claim with the courier and record the compensation in Finance');
  elsif p_to = 'RETURNED' then
    if v_from = 'LOST' then
      perform public._reverse_lost_parcel_finance(p_order_id);
    end if;
    perform public._return_order_stock(p_order_id, null, 'Returned to stock');
    update public.shipments set status = 'RETURNED', return_status = 'RECEIVED', updated_at = now()
    where order_id = p_order_id and is_active;
    perform public._post_order_return_finance(p_order_id);
    perform public._enqueue_order_notification(p_order_id, 'ORDER_RETURNED');
  end if;

  if p_sync_production and p_to in ('PRODUCTION', 'QUALITY_CHECK', 'PACKING', 'READY_TO_SHIP') then
    perform public._production_sync_from_order(p_order_id, p_to);
  end if;

  perform public.refresh_customer_stats(v_order.customer_id);
  select * into v_order from public.orders where id = p_order_id;
  return v_order;
end;
$$;

create or replace function public.transition_order_status(
  p_order_id uuid,
  p_to public.order_status,
  p_note text default null
)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_before public.order_status;
begin
  perform public.require_permission(case when p_to in ('CANCELLED', 'PENDING_CANCEL') then 'orders.cancel' else 'orders.status' end);
  select status into v_before from public.orders where id = p_order_id;
  if p_to = 'REJECTED_FRAUD' or (v_before in ('FRAUD_REVIEW', 'REJECTED_FRAUD') and p_to <> 'CANCELLED') then
    perform public.require_permission('fraud.review');
  end if;
  if p_to = 'CONFIRMED' and v_before in ('ADVANCE_REQUIRED', 'FRAUD_REVIEW') then
    perform public.require_permission('fraud.review');
  end if;
  if p_to in ('CANCELLED', 'PENDING_CANCEL') and length(trim(coalesce(p_note, ''))) = 0 then
    raise exception 'VALIDATION: a cancellation reason is required' using errcode = '22023';
  end if;
  if p_to = 'PARTIALLY_DELIVERED' then
    raise exception 'VALIDATION: record which items came back to mark a partial delivery' using errcode = '22023';
  end if;
  v_order := public._transition_order(p_order_id, p_to, p_note);
  perform public.log_audit('order.status_changed', 'order', p_order_id::text,
    jsonb_build_object('status', v_before), jsonb_build_object('status', p_to), jsonb_build_object('note', p_note));
  return v_order;
end;
$$;

-- -----------------------------------------------------------------------------
-- Totals: goods refused on a partial delivery are not due
-- -----------------------------------------------------------------------------
create or replace function public.recalculate_order_totals(p_order_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_coupon public.coupons;
  v_subtotal numeric;
  v_cost numeric;
  v_coupon_discount numeric := 0;
  v_delivery_discount numeric;
  v_paid numeric;
  v_refunded numeric;
  v_total numeric;
  v_due_total numeric;
  v_lines jsonb;
  v_disc record;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'NOT_FOUND: order % does not exist', p_order_id using errcode = 'P0002';
  end if;

  select coalesce(sum(line_subtotal), 0), coalesce(sum(unit_cost * quantity), 0)
  into v_subtotal, v_cost from public.order_items where order_id = p_order_id;

  v_delivery_discount := least(v_order.delivery_discount, v_order.delivery_charge);
  if v_order.coupon_id is not null then
    select * into v_coupon from public.coupons where id = v_order.coupon_id;
    select * into v_disc from public.coupon_discount(v_coupon.discount_type, v_coupon.discount_value,
      v_coupon.max_discount, v_subtotal, v_order.delivery_charge);
    v_coupon_discount := v_disc.discount_amount;
    if v_coupon.discount_type = 'FREE_DELIVERY' then
      v_delivery_discount := v_disc.delivery_discount;
    end if;
  end if;

  v_coupon_discount := least(v_coupon_discount, v_subtotal);
  update public.orders set manual_discount = least(manual_discount, v_subtotal - v_coupon_discount)
  where id = p_order_id returning * into v_order;

  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'line_subtotal', line_subtotal) order by line_subtotal desc, id), '[]'::jsonb)
  into v_lines from public.order_items where order_id = p_order_id;
  v_lines := public._allocate_discount(v_lines, v_coupon_discount + v_order.manual_discount);
  update public.order_items oi
  set discount_amount = (l ->> 'discount_amount')::numeric, line_total = (l ->> 'line_total')::numeric
  from jsonb_array_elements(v_lines) l
  where oi.id = (l ->> 'id')::uuid
    and (oi.discount_amount, oi.line_total) is distinct from ((l ->> 'discount_amount')::numeric, (l ->> 'line_total')::numeric);

  select coalesce(sum(amount) filter (where kind <> 'REFUND'), 0), coalesce(sum(amount) filter (where kind = 'REFUND'), 0)
  into v_paid, v_refunded from public.order_payments where order_id = p_order_id;

  v_total := public.money(v_subtotal - v_coupon_discount - v_order.manual_discount + v_order.delivery_charge - v_delivery_discount);
  v_due_total := greatest(v_total - v_order.partial_return_amount, 0);

  update public.orders set
    subtotal = public.money(v_subtotal),
    coupon_discount = public.money(v_coupon_discount),
    discount_total = public.money(v_coupon_discount + manual_discount),
    delivery_discount = public.money(v_delivery_discount),
    total_amount = v_total,
    cost_total = public.money(v_cost),
    amount_paid = public.money(v_paid - v_refunded),
    amount_refunded = public.money(v_refunded),
    cod_amount = greatest(v_due_total - public.money(v_paid - v_refunded), 0),
    payment_status = case
      when v_refunded > 0 and v_paid - v_refunded <= 0 then 'REFUNDED'
      when v_refunded > 0 then 'PARTIALLY_REFUNDED'
      when v_paid >= v_due_total and v_due_total > 0 then 'PAID'
      when v_paid > 0 then 'PARTIALLY_PAID'
      else 'UNPAID'
    end::public.payment_status
  where id = p_order_id
  returning * into v_order;

  return v_order;
end;
$$;

-- Same as before, but COD collected on delivery is what is actually due.
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

  select * into v_ship from public.shipments where order_id = p_order_id and is_active;
  if found and public.setting_bool('finance', array['record_courier_cost_on_delivery'], true) then
    perform public._post_finance('EXPENSE', 'COURIER', v_ship.shipping_cost, v_date, true,
      p_order_id, null, null, v_order.order_number, 'Courier charge',
      'shipment:' || v_ship.id || ':shipping_cost', 'COURIER_COD');
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
    v_due := v_order.cod_amount;
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
-- Customer and fraud history understand the new outcomes
-- -----------------------------------------------------------------------------
create or replace function public.refresh_customer_stats(p_customer_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_vip_spent numeric := public.setting_numeric('customers', array['vip_min_spent'], 20000);
  v_vip_orders int := public.setting_numeric('customers', array['vip_min_orders'], 5)::int;
  v_regular_orders int := public.setting_numeric('customers', array['regular_min_orders'], 2)::int;
  v_high_risk_rate numeric := public.setting_numeric('customers', array['high_risk_bad_rate'], 0.5);
begin
  with s as (
    select
      count(*) as total,
      count(*) filter (where status in ('DELIVERED', 'PARTIALLY_DELIVERED', 'RETURN_REQUESTED') and delivered_at is not null) as delivered,
      count(*) filter (where status = 'CANCELLED') as cancelled,
      count(*) filter (where status in ('RETURNING', 'RETURNED') and delivered_at is not null) as returned,
      count(*) filter (where status in ('FAILED_DELIVERY', 'RETURNING', 'RETURNED') and delivered_at is null) as failed,
      coalesce(sum(total_amount - amount_refunded - partial_return_amount) filter (
        where status in ('DELIVERED', 'PARTIALLY_DELIVERED', 'RETURN_REQUESTED') and delivered_at is not null), 0) as spent,
      min(created_at) as first_at,
      max(created_at) as last_at
    from public.orders where customer_id = p_customer_id
  )
  update public.customers c set
    total_orders = s.total,
    delivered_orders = s.delivered,
    cancelled_orders = s.cancelled,
    returned_orders = s.returned,
    failed_deliveries = s.failed,
    total_spent = public.money(s.spent),
    average_order_value = case when s.delivered > 0 then public.money(s.spent / s.delivered) else 0 end,
    first_order_at = s.first_at,
    last_order_at = s.last_at,
    segment = case
      when c.status = 'BLOCKED' then 'BLOCKED'
      when c.risk_level in ('HIGH', 'CRITICAL') then 'HIGH_RISK'
      when (s.returned + s.failed + s.cancelled) >= 2
           and (s.returned + s.failed + s.cancelled)::numeric / greatest(s.delivered + s.returned + s.failed + s.cancelled, 1) >= v_high_risk_rate
        then 'HIGH_RISK'
      when s.spent >= v_vip_spent or s.delivered >= v_vip_orders then 'VIP'
      when s.delivered >= v_regular_orders then 'REGULAR'
      else 'NEW'
    end::public.customer_segment
  from s
  where c.id = p_customer_id;
end;
$$;

create or replace function public.fraud_customer_metrics(p_phone text, p_exclude_order_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_phone text := public.clean_phone(p_phone);
  v_customer public.customers;
  v_m jsonb;
begin
  if not (public.is_system_context() or public.has_permission('fraud.view')) then
    raise exception 'PERMISSION_DENIED: fraud.view is required' using errcode = '42501';
  end if;
  select * into v_customer from public.customers where phone = v_phone;
  select jsonb_build_object(
    'phone', v_phone,
    'customer_id', v_customer.id,
    'previous_orders', count(*),
    'delivered_orders', count(*) filter (where o.delivered_at is not null and o.status in ('DELIVERED', 'PARTIALLY_DELIVERED', 'RETURN_REQUESTED')),
    'cancelled_orders', count(*) filter (where o.status = 'CANCELLED'),
    'returned_orders', count(*) filter (where o.status in ('RETURNING', 'RETURNED') and o.delivered_at is not null),
    'failed_delivery_orders', count(*) filter (where o.status in ('FAILED_DELIVERY', 'RETURNING', 'RETURNED') and o.delivered_at is null),
    'rejected_fraud_orders', count(*) filter (where o.status = 'REJECTED_FRAUD'),
    'cod_orders', count(*) filter (where o.payment_method = 'COD'),
    'failed_cod_orders', count(*) filter (where o.payment_method = 'COD'
        and o.status in ('FAILED_DELIVERY', 'RETURNING', 'RETURNED') and o.delivered_at is null),
    'open_orders', count(*) filter (where o.status in ('PENDING', 'FRAUD_CHECK', 'ADVANCE_REQUIRED', 'FRAUD_REVIEW',
        'CONFIRMATION_REQUIRED', 'CONFIRMED', 'PRE_ORDER', 'PROCESSING', 'PRODUCTION', 'QUALITY_CHECK', 'PACKING',
        'READY_TO_SHIP', 'SHIPPED', 'PENDING_CANCEL')),
    'lifetime_value', coalesce(v_customer.total_spent, 0),
    'last_fraud_score', v_customer.last_fraud_score,
    'customer_status', coalesce(v_customer.status::text, 'NEW'),
    'customer_segment', coalesce(v_customer.segment::text, 'NEW'),
    'is_new_customer', v_customer.id is null or coalesce(v_customer.delivered_orders, 0) = 0,
    'phone_flagged', coalesce(v_customer.status = 'BLOCKED', false)
  ) into v_m
  from public.orders o
  where o.customer_phone = v_phone and (p_exclude_order_id is null or o.id <> p_exclude_order_id);
  return v_m;
end;
$$;

-- -----------------------------------------------------------------------------
-- Partial delivery and receiving returns
-- -----------------------------------------------------------------------------
-- p_items: the items the customer sent back [{order_item_id, quantity}].
create or replace function public.record_partial_delivery(p_order_id uuid, p_items jsonb, p_note text default null)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_value numeric;
  v_units int;
  v_over boolean;
  v_all int;
  v_message text;
begin
  perform public.require_permission('orders.status');
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'NOT_FOUND: order not found' using errcode = 'P0002';
  end if;
  if v_order.status not in ('SHIPPED', 'FAILED_DELIVERY', 'PARTIALLY_DELIVERED') then
    raise exception 'INVALID_TRANSITION: only shipped orders can be partly delivered' using errcode = 'P0001';
  end if;
  if v_order.partial_return_amount > 0 then
    raise exception 'VALIDATION: the partial delivery was already recorded' using errcode = '22023';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'VALIDATION: choose the items the customer sent back' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_items) r
             where not exists (select 1 from public.order_items oi
                               where oi.id::text = r ->> 'order_item_id' and oi.order_id = p_order_id)) then
    raise exception 'VALIDATION: an item does not belong to this order' using errcode = '22023';
  end if;

  select coalesce(sum(round(oi.line_total / oi.quantity * b.back, 2)), 0), coalesce(sum(b.back), 0), coalesce(bool_or(b.back > oi.quantity), false)
  into v_value, v_units, v_over
  from (select (r ->> 'order_item_id')::uuid as id, sum(greatest(coalesce((r ->> 'quantity')::int, 0), 0)) as back
        from jsonb_array_elements(p_items) r group by 1) b
  join public.order_items oi on oi.id = b.id;
  select coalesce(sum(quantity), 0) into v_all from public.order_items where order_id = p_order_id;
  if v_over then
    raise exception 'VALIDATION: more items came back than were shipped' using errcode = '22023';
  end if;
  if v_units = 0 then
    raise exception 'VALIDATION: choose the items the customer sent back' using errcode = '22023';
  end if;
  if v_units >= v_all then
    raise exception 'VALIDATION: everything came back — mark the order as returning instead' using errcode = '22023';
  end if;

  update public.orders set partial_return_amount = least(public.money(v_value), total_amount) where id = p_order_id;
  v_order := public.recalculate_order_totals(p_order_id);
  v_message := coalesce(nullif(trim(p_note), ''),
    format('Customer kept part of the order; %s item(s) worth %s coming back', v_units, v_order.partial_return_amount));
  if v_order.status = 'PARTIALLY_DELIVERED' then
    perform public._post_partial_return_finance(p_order_id);
    perform public._order_log(p_order_id, 'PARTIAL_RECORDED', v_message, null, null,
      jsonb_build_object('items', p_items, 'returned_value', v_order.partial_return_amount));
  else
    v_order := public._transition_order(p_order_id, 'PARTIALLY_DELIVERED', v_message,
      jsonb_build_object('items', p_items, 'returned_value', v_order.partial_return_amount));
  end if;
  perform public.log_audit('order.partial_delivery', 'order', p_order_id::text, null,
    jsonb_build_object('items', p_items, 'returned_value', v_order.partial_return_amount), jsonb_build_object('note', p_note));
  select * into v_order from public.orders where id = p_order_id;
  return v_order;
end;
$$;

-- Receiving a parcel back. Partial deliveries stay Partial (only the returned
-- items are restocked); everything else becomes Returned.
create or replace function public.process_order_return(p_order_id uuid, p_items jsonb, p_note text default null)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_count int;
begin
  perform public.require_permission('orders.status');
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'NOT_FOUND: order not found' using errcode = 'P0002';
  end if;
  if v_order.status = 'PARTIALLY_DELIVERED' then
    if p_items is null or jsonb_array_length(p_items) = 0 then
      raise exception 'VALIDATION: choose the items that came back' using errcode = '22023';
    end if;
    v_count := public._return_order_stock(p_order_id, p_items, p_note);
    perform public._post_order_return_finance(p_order_id);
    update public.shipments set return_status = 'RECEIVED', updated_at = now() where order_id = p_order_id and is_active;
    perform public._order_log(p_order_id, 'PARTIAL_RETURN_RECEIVED',
      coalesce(nullif(trim(p_note), ''), format('%s returned line(s) received', v_count)), null, null, jsonb_build_object('items', p_items));
    perform public.log_audit('order.returned', 'order', p_order_id::text, null, p_items, jsonb_build_object('note', p_note, 'partial', true));
    select * into v_order from public.orders where id = p_order_id;
    return v_order;
  end if;
  if v_order.status not in ('FAILED_DELIVERY', 'RETURN_REQUESTED', 'RETURNING', 'PENDING_CANCEL', 'LOST') then
    raise exception 'INVALID_TRANSITION: only parcels on their way back can be received' using errcode = 'P0001';
  end if;
  perform public._return_order_stock(p_order_id, p_items, p_note);
  v_order := public._transition_order(p_order_id, 'RETURNED', p_note, jsonb_build_object('items', p_items));
  perform public.log_audit('order.returned', 'order', p_order_id::text, null, p_items, jsonb_build_object('note', p_note));
  return v_order;
end;
$$;

-- -----------------------------------------------------------------------------
-- Courier updates move orders into the new stages
-- -----------------------------------------------------------------------------
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

  -- Cancel asked for, but the courier picked the parcel up anyway.
  if v_order.status = 'PENDING_CANCEL' and v_order.shipped_at is null
     and p_status in ('PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'PARTIALLY_DELIVERED', 'FAILED', 'RETURNING', 'RETURNED') then
    perform public._commit_order_stock(v_order.id);
    update public.orders set shipped_at = coalesce(p_occurred_at, now()) where id = v_order.id returning * into v_order;
    perform public._order_log(v_order.id, 'PICKED_UP_DESPITE_CANCEL',
      'The courier picked the parcel up before the cancellation went through');
  end if;

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
    if p_status = 'PARTIALLY_DELIVERED' and v_order.status in ('SHIPPED', 'FAILED_DELIVERY') then
      perform public._transition_order(v_order.id, 'PARTIALLY_DELIVERED',
        coalesce(p_description, 'Partially delivered by courier — record which items came back'));
    elsif v_order.status in ('SHIPPED', 'RETURN_REQUESTED', 'FAILED_DELIVERY', 'PENDING_CANCEL', 'LOST') then
      if v_order.status = 'FAILED_DELIVERY' then
        perform public._transition_order(v_order.id, 'SHIPPED', 'Re-attempted delivery');
      end if;
      perform public._transition_order(v_order.id, 'DELIVERED', coalesce(p_description, 'Delivered by courier'));
    end if;
  elsif p_status = 'FAILED' and v_order.status = 'SHIPPED' then
    perform public._transition_order(v_order.id, 'FAILED_DELIVERY', coalesce(p_description, 'Delivery failed'));
  elsif p_status in ('RETURNING', 'RETURNED') then
    if v_order.status in ('SHIPPED', 'FAILED_DELIVERY', 'RETURN_REQUESTED', 'PENDING_CANCEL') then
      perform public._transition_order(v_order.id, 'RETURNING', coalesce(p_description, 'Parcel returning to merchant'));
    elsif v_order.status = 'DELIVERED' then
      perform public._transition_order(v_order.id, 'RETURN_REQUESTED', coalesce(p_description, 'Customer return in transit'));
      perform public._transition_order(v_order.id, 'RETURNING', coalesce(p_description, 'Customer return in transit'));
    end if;
    if p_status = 'RETURNED' then
      perform public._order_log(v_order.id, 'PARCEL_RETURNED',
        'Courier marked the parcel as returned. Receive it to restock or mark damaged.');
    end if;
  elsif p_status = 'CANCELLED' and v_order.status = 'PENDING_CANCEL' and v_order.shipped_at is null then
    perform public._transition_order(v_order.id, 'CANCELLED', coalesce(p_description, 'Courier cancelled the parcel'));
  end if;
  return v_ship;
end;
$$;

-- -----------------------------------------------------------------------------
-- Packing-desk scanner: pre-orders can be packed; returns in any return stage
-- -----------------------------------------------------------------------------
create or replace function public._scan_to_ready(p_order public.orders, p_note text)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders := p_order;
begin
  if v_order.status in ('PENDING', 'FRAUD_CHECK', 'ADVANCE_REQUIRED', 'FRAUD_REVIEW', 'CONFIRMATION_REQUIRED') then
    raise exception 'VALIDATION: not approved yet (%) — do not pack this parcel', replace(lower(v_order.status::text), '_', ' ')
      using errcode = '22023';
  end if;
  if v_order.status in ('PRODUCTION', 'QUALITY_CHECK') then
    raise exception 'VALIDATION: still in production' using errcode = '22023';
  end if;
  if v_order.status = 'PENDING_CANCEL' then
    raise exception 'VALIDATION: a cancellation was asked for — do not ship' using errcode = '22023';
  end if;
  if v_order.status not in ('CONFIRMED', 'PRE_ORDER', 'PROCESSING', 'PACKING') then
    raise exception 'VALIDATION: a % order cannot be marked ready to ship', replace(lower(v_order.status::text), '_', ' ')
      using errcode = '22023';
  end if;
  if exists (select 1 from public.order_items where order_id = v_order.id and requires_production)
     and not exists (select 1 from public.production_orders where order_id = v_order.id and status = 'READY') then
    raise exception 'VALIDATION: made-to-order items are not ready yet' using errcode = '22023';
  end if;
  if public.setting_bool('fulfillment', array['require_label_before_rts'], false) and v_order.label_printed_at is null then
    raise exception 'VALIDATION: print the shipping label first' using errcode = '22023';
  end if;
  if v_order.status = 'CONFIRMED' then
    v_order := public._transition_order(v_order.id, 'PROCESSING', p_note);
  end if;
  return public._transition_order(v_order.id, 'READY_TO_SHIP', p_note);
end;
$$;

create or replace function public.scan_parcel(p_code text, p_action text, p_courier_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g'));
  v_action text := upper(coalesce(p_action, 'LOOKUP'));
  v_order public.orders;
  v_from public.order_status;
  v_result text := 'OK';
  v_message text;
  v_note text;
begin
  perform public.require_permission('orders.fulfill');
  if v_action not in ('READY_TO_SHIP', 'SHIPPED', 'RETURNED', 'LOOKUP') then
    raise exception 'VALIDATION: unknown scan action' using errcode = '22023';
  end if;
  if length(v_code) < 3 or length(v_code) > 64 then
    raise exception 'VALIDATION: scan a valid order or tracking barcode' using errcode = '22023';
  end if;

  select * into v_order from public.orders where upper(order_number) = v_code for update;
  if not found then
    select o.* into v_order from public.shipments s join public.orders o on o.id = s.order_id
    where s.is_active and (upper(s.tracking_number) = v_code or upper(s.consignment_id) = v_code)
    order by s.created_at desc limit 1;
    if found then
      select * into v_order from public.orders where id = v_order.id for update;
    end if;
  end if;

  if v_order.id is null then
    insert into public.parcel_scans(code, action, result, message, courier_id, scanned_by, scanned_by_name)
    values (v_code, v_action, 'NOT_FOUND', 'No order matches this barcode', p_courier_id, auth.uid(), public.actor_display_name());
    return jsonb_build_object('result', 'NOT_FOUND', 'message', 'No order matches this barcode', 'code', v_code);
  end if;

  v_from := v_order.status;
  v_note := 'Scanned at packing desk';
  begin
    if v_action = 'LOOKUP' then
      v_message := 'Found';
    elsif v_order.status in ('CANCELLED', 'REJECTED_FRAUD') then
      v_result := 'ERROR';
      v_message := 'Order is cancelled — do not ship';
    elsif v_action in ('READY_TO_SHIP', 'SHIPPED') and v_order.status = 'PENDING_CANCEL' and v_order.shipped_at is null then
      v_result := 'ERROR';
      v_message := 'A cancellation was asked for — do not ship';
    elsif v_action = 'READY_TO_SHIP' then
      if v_order.status = 'READY_TO_SHIP' then
        v_result := 'ALREADY';
        v_message := 'Already ready to ship';
      elsif v_order.shipped_at is not null then
        v_result := 'ALREADY';
        v_message := 'Already ' || replace(lower(v_order.status::text), '_', ' ');
      else
        v_order := public._scan_to_ready(v_order, v_note);
        v_message := 'Ready to ship';
      end if;
    elsif v_action = 'SHIPPED' then
      if v_order.status = 'SHIPPED' then
        v_result := 'ALREADY';
        v_message := 'Already shipped';
      elsif v_order.shipped_at is not null then
        v_result := 'ALREADY';
        v_message := 'Already ' || replace(lower(v_order.status::text), '_', ' ');
      else
        if v_order.status <> 'READY_TO_SHIP' then
          v_order := public._scan_to_ready(v_order, v_note);
        end if;
        if p_courier_id is not null
           and not exists (select 1 from public.shipments where order_id = v_order.id and is_active) then
          perform public.assign_courier(v_order.id, p_courier_id, null, null, 'Assigned at packing desk');
        end if;
        v_order := public._transition_order(v_order.id, 'SHIPPED', 'Handed to courier (scanned)');
        v_message := 'Shipped';
      end if;
    elsif v_action = 'RETURNED' then
      if v_order.status = 'RETURNED' then
        v_result := 'ALREADY';
        v_message := 'Already received back';
      elsif v_order.status = 'SHIPPED' then
        v_order := public._transition_order(v_order.id, 'RETURNING', 'Parcel came back (scanned)');
        v_order := public._transition_order(v_order.id, 'RETURNED', 'Returned parcel received (scanned)');
        v_message := 'Returned to stock';
      elsif v_order.status = 'DELIVERED' then
        v_order := public._transition_order(v_order.id, 'RETURN_REQUESTED', 'Customer return arrived (scanned)');
        v_order := public._transition_order(v_order.id, 'RETURNED', 'Returned parcel received (scanned)');
        v_message := 'Returned to stock';
      elsif v_order.status in ('FAILED_DELIVERY', 'RETURN_REQUESTED', 'RETURNING', 'LOST')
         or (v_order.status = 'PENDING_CANCEL' and v_order.shipped_at is not null) then
        v_order := public._transition_order(v_order.id, 'RETURNED', 'Returned parcel received (scanned)');
        v_message := 'Returned to stock';
      elsif v_order.status = 'PARTIALLY_DELIVERED' then
        v_result := 'ERROR';
        v_message := 'Partial delivery — open the order and choose the items that came back';
      else
        v_result := 'ERROR';
        v_message := 'This order has not been shipped';
      end if;
    end if;
  exception when others then
    v_result := 'ERROR';
    v_message := regexp_replace(sqlerrm, '^[A-Z_]+: ', '');
    select * into v_order from public.orders where id = v_order.id;
  end;

  insert into public.parcel_scans(code, action, order_id, order_number, result, message, from_status, to_status,
                                  courier_id, scanned_by, scanned_by_name)
  values (v_code, v_action, v_order.id, v_order.order_number, v_result, v_message, v_from,
          case when v_order.status <> v_from then v_order.status end, p_courier_id, auth.uid(), public.actor_display_name());
  if v_action <> 'LOOKUP' then
    perform public._order_log(v_order.id, 'PARCEL_SCANNED',
      format('Scanned for %s: %s', replace(lower(v_action), '_', ' '), v_message), null, null,
      jsonb_build_object('action', v_action, 'result', v_result, 'code', v_code));
  end if;

  return jsonb_build_object('result', v_result, 'message', v_message, 'code', v_code,
    'from_status', v_from, 'order', public._scan_summary(v_order.id));
end;
$$;

-- -----------------------------------------------------------------------------
-- Web order actions
-- -----------------------------------------------------------------------------
create or replace function public.set_web_order_status(
  p_order_ids uuid[],
  p_status text,
  p_note text default null,
  p_follow_up_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status public.order_review_statuses;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_id uuid;
  v_order public.orders;
  v_ok int := 0;
  v_failed jsonb := '[]'::jsonb;
begin
  perform public.require_permission('orders.update');
  select * into v_status from public.order_review_statuses where code = upper(trim(coalesce(p_status, ''))) and is_active;
  if not found then
    raise exception 'VALIDATION: choose a status' using errcode = '22023';
  end if;
  if v_status.closes_order then
    perform public.require_permission('orders.cancel');
  end if;
  if v_status.needs_follow_up and p_follow_up_at is null then
    raise exception 'VALIDATION: choose when to call back' using errcode = '22023';
  end if;
  if length(v_note) > 500 then
    raise exception 'VALIDATION: keep the note under 500 characters' using errcode = '22023';
  end if;
  if coalesce(array_length(p_order_ids, 1), 0) > 200 then
    raise exception 'VALIDATION: at most 200 orders at a time' using errcode = '22023';
  end if;

  foreach v_id in array coalesce(p_order_ids, '{}') loop
    begin
      select * into v_order from public.orders where id = v_id for update;
      if not found then
        raise exception 'NOT_FOUND: order not found' using errcode = 'P0002';
      end if;
      if v_order.confirmed_at is not null then
        raise exception 'VALIDATION: already approved — change its stage in Approved Orders' using errcode = '22023';
      end if;
      if v_order.status in ('CANCELLED', 'REJECTED_FRAUD') and not v_status.closes_order then
        raise exception 'VALIDATION: this order is cancelled' using errcode = '22023';
      end if;
      if v_status.closes_order and v_order.status not in ('CANCELLED', 'REJECTED_FRAUD') then
        perform public._transition_order(v_id, 'CANCELLED', v_status.label || coalesce(': ' || v_note, ''));
      end if;
      update public.orders set
        review_status = v_status.code,
        review_note = v_note,
        follow_up_at = case when v_status.needs_follow_up then p_follow_up_at end,
        contact_attempts = contact_attempts + case when v_status.counts_contact then 1 else 0 end,
        last_contact_at = case when v_status.counts_contact then now() else last_contact_at end,
        review_updated_at = now(),
        review_updated_by = auth.uid()
      where id = v_id;
      perform public._order_log(v_id, 'REVIEW_STATUS',
        v_status.label || coalesce(' — ' || v_note, '')
          || case when v_status.needs_follow_up
               then ' (call back ' || to_char(p_follow_up_at at time zone public.store_timezone(), 'DD Mon, HH24:MI') || ')' else '' end,
        null, null, jsonb_build_object('from', v_order.review_status, 'to', v_status.code, 'follow_up_at', p_follow_up_at));
      perform public.log_audit('order.review_status', 'order', v_id::text,
        jsonb_build_object('review_status', v_order.review_status), jsonb_build_object('review_status', v_status.code),
        jsonb_build_object('note', v_note));
      v_ok := v_ok + 1;
    exception when others then
      v_failed := v_failed || jsonb_build_object('order_id', v_id,
        'order_number', (select order_number from public.orders where id = v_id), 'error', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('updated', v_ok, 'failed', v_failed);
end;
$$;

-- Approve web orders: they move to Approved Orders (stage Pending).
create or replace function public.approve_orders(p_order_ids uuid[], p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_order public.orders;
  v_ok int := 0;
  v_failed jsonb := '[]'::jsonb;
begin
  perform public.require_permission('orders.status');
  if coalesce(array_length(p_order_ids, 1), 0) > 200 then
    raise exception 'VALIDATION: at most 200 orders at a time' using errcode = '22023';
  end if;
  foreach v_id in array coalesce(p_order_ids, '{}') loop
    begin
      select * into v_order from public.orders where id = v_id for update;
      if not found then
        raise exception 'NOT_FOUND: order not found' using errcode = 'P0002';
      end if;
      if v_order.confirmed_at is not null then
        raise exception 'VALIDATION: already approved' using errcode = '22023';
      end if;
      if v_order.status = 'REJECTED_FRAUD' then
        raise exception 'VALIDATION: rejected for fraud — reopen it in fraud review first' using errcode = '22023';
      end if;
      if v_order.status = 'CANCELLED' then
        raise exception 'VALIDATION: cancelled orders cannot be approved' using errcode = '22023';
      end if;
      perform public.transition_order_status(v_id, 'CONFIRMED', coalesce(nullif(trim(p_note), ''), 'Approved'));
      update public.orders set approved_by = auth.uid() where id = v_id;
      v_ok := v_ok + 1;
    exception when others then
      v_failed := v_failed || jsonb_build_object('order_id', v_id,
        'order_number', (select order_number from public.orders where id = v_id), 'error', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('approved', v_ok, 'failed', v_failed);
end;
$$;

-- Add or edit a call status. System statuses keep their behaviour; only their
-- wording, colour and order change.
create or replace function public.admin_save_review_status(p jsonb)
returns public.order_review_statuses
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_label text := trim(coalesce(p ->> 'label', ''));
  v_code text := upper(trim(both '_' from regexp_replace(coalesce(nullif(p ->> 'code', ''), p ->> 'label', ''), '[^A-Za-z0-9]+', '_', 'g')));
  v_existing public.order_review_statuses;
  v_row public.order_review_statuses;
  v_color text := coalesce(nullif(p ->> 'color', ''), 'neutral');
begin
  perform public.require_permission('settings.manage');
  if length(v_label) = 0 or length(v_label) > 40 then
    raise exception 'VALIDATION: give the status a name (up to 40 characters)' using errcode = '22023';
  end if;
  if v_code !~ '^[A-Z][A-Z0-9_]{1,39}$' then
    raise exception 'VALIDATION: the name must start with a letter' using errcode = '22023';
  end if;
  if v_color not in ('neutral', 'info', 'success', 'warning', 'danger', 'violet') then
    raise exception 'VALIDATION: unknown colour' using errcode = '22023';
  end if;
  select * into v_existing from public.order_review_statuses where code = v_code;
  if found and v_existing.is_system then
    if v_code in ('PROCESSING', 'CANCELLED', 'INVALID') and not coalesce((p ->> 'is_active')::boolean, true) then
      raise exception 'VALIDATION: % is used by the system and cannot be turned off', v_existing.label using errcode = '22023';
    end if;
    update public.order_review_statuses set label = v_label,
      description = nullif(trim(coalesce(p ->> 'description', '')), ''),
      color = v_color,
      sort_order = coalesce((p ->> 'sort_order')::int, sort_order),
      is_active = coalesce((p ->> 'is_active')::boolean, is_active)
    where code = v_code returning * into v_row;
  else
    insert into public.order_review_statuses(code, label, description, color, closes_order, needs_follow_up, counts_contact, is_active, sort_order)
    values (v_code, v_label, nullif(trim(coalesce(p ->> 'description', '')), ''), v_color,
            coalesce((p ->> 'closes_order')::boolean, false), coalesce((p ->> 'needs_follow_up')::boolean, false),
            coalesce((p ->> 'counts_contact')::boolean, false), coalesce((p ->> 'is_active')::boolean, true),
            coalesce((p ->> 'sort_order')::int, 60))
    on conflict (code) do update set label = excluded.label, description = excluded.description, color = excluded.color,
      closes_order = excluded.closes_order, needs_follow_up = excluded.needs_follow_up, counts_contact = excluded.counts_contact,
      is_active = excluded.is_active, sort_order = excluded.sort_order
    returning * into v_row;
  end if;
  perform public.log_audit('settings.review_status_saved', 'order_review_status', v_row.code,
    case when v_existing.code is not null then to_jsonb(v_existing) end, to_jsonb(v_row));
  return v_row;
end;
$$;

-- -----------------------------------------------------------------------------
-- Lists and counts for the two pages
-- -----------------------------------------------------------------------------
create or replace function public.admin_search_orders(
  p_filters jsonb default '{}'::jsonb,
  p_sort text default 'created_at',
  p_direction text default 'desc',
  p_limit int default 25,
  p_offset int default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_q text := nullif(trim(coalesce(p_filters ->> 'q', '')), '');
  v_phone text := public.clean_phone(p_filters ->> 'q');
  v_tz text := public.store_timezone();
  v_result jsonb;
  v_statuses public.order_status[];
  v_label text := nullif(p_filters ->> 'label', '');
  v_queue text := nullif(p_filters ->> 'queue', '');
  v_review text := nullif(p_filters ->> 'review_status', '');
  v_stage text := nullif(p_filters ->> 'stage', '');
begin
  perform public.require_permission('orders.view');
  if p_filters ? 'statuses' then
    select array_agg(s::public.order_status) into v_statuses from jsonb_array_elements_text(p_filters -> 'statuses') s;
  elsif nullif(p_filters ->> 'status', '') is not null then
    v_statuses := array[(p_filters ->> 'status')::public.order_status];
  end if;

  with filtered as (
    select o.*
    from public.orders o
    where (v_statuses is null or o.status = any(v_statuses))
      and (v_queue is null or (v_queue = 'web' and o.confirmed_at is null) or (v_queue = 'approved' and o.confirmed_at is not null))
      and (v_review is null or o.review_status = v_review)
      and (v_stage is null or public.order_stage(o.status, o.confirmed_at) = v_stage)
      and (not coalesce((p_filters ->> 'follow_up_due')::boolean, false) or o.follow_up_at <= now())
      and (nullif(p_filters ->> 'payment_status', '') is null or o.payment_status = (p_filters ->> 'payment_status')::public.payment_status)
      and (nullif(p_filters ->> 'payment_method', '') is null or o.payment_method = (p_filters ->> 'payment_method')::public.payment_method)
      and (nullif(p_filters ->> 'fraud_status', '') is null or o.fraud_status = (p_filters ->> 'fraud_status')::public.fraud_status)
      and (nullif(p_filters ->> 'risk_level', '') is null or o.risk_level = (p_filters ->> 'risk_level')::public.risk_level)
      and (nullif(p_filters ->> 'source', '') is null or o.source = (p_filters ->> 'source')::public.order_source)
      and (nullif(p_filters ->> 'customer_id', '') is null or o.customer_id = (p_filters ->> 'customer_id')::uuid)
      and (nullif(p_filters ->> 'district', '') is null or lower(o.shipping_district) = lower(p_filters ->> 'district'))
      and (nullif(p_filters ->> 'date_from', '') is null or o.created_at >= ((p_filters ->> 'date_from')::date::timestamp at time zone v_tz))
      and (nullif(p_filters ->> 'date_to', '') is null or o.created_at < (((p_filters ->> 'date_to')::date + 1)::timestamp at time zone v_tz))
      and (nullif(p_filters ->> 'courier_id', '') is null or exists (
            select 1 from public.shipments s where s.order_id = o.id and s.is_active and s.courier_id = (p_filters ->> 'courier_id')::uuid))
      and (not coalesce((p_filters ->> 'has_due')::boolean, false) or o.cod_amount > 0)
      and (not coalesce((p_filters ->> 'duplicates')::boolean, false)
           or (o.duplicate_status = 'SUSPECTED' and o.status not in ('CANCELLED', 'REJECTED_FRAUD')))
      and (v_label is null or (v_label = 'printed' and o.label_printed_at is not null)
                           or (v_label = 'not_printed' and o.label_printed_at is null))
      and (v_q is null
        or o.order_number ilike '%' || v_q || '%'
        or (v_phone is not null and length(v_phone) >= 4 and o.customer_phone like '%' || v_phone || '%')
        or o.customer_name ilike '%' || v_q || '%'
        or o.shipping_address ilike '%' || v_q || '%'
        or exists (select 1 from public.shipments s where s.order_id = o.id and (s.tracking_number ilike v_q || '%' or s.consignment_id ilike v_q || '%'))
        or exists (select 1 from public.order_items oi where oi.order_id = o.id and oi.sku ilike v_q || '%'))
  ), counted as (
    select count(*) as total from filtered
  ), page as (
    select f.* from filtered f
    order by
      case when p_direction = 'asc' and p_sort = 'created_at' then f.created_at end asc,
      case when p_direction <> 'asc' and p_sort = 'created_at' then f.created_at end desc,
      case when p_direction = 'asc' and p_sort = 'total_amount' then f.total_amount end asc,
      case when p_direction <> 'asc' and p_sort = 'total_amount' then f.total_amount end desc,
      case when p_direction = 'asc' and p_sort = 'order_number' then f.order_number end asc,
      case when p_direction <> 'asc' and p_sort = 'order_number' then f.order_number end desc,
      case when p_direction = 'asc' and p_sort = 'status' then f.status end asc,
      case when p_direction <> 'asc' and p_sort = 'status' then f.status end desc,
      case when p_direction = 'asc' and p_sort = 'follow_up_at' then f.follow_up_at end asc nulls last,
      case when p_direction <> 'asc' and p_sort = 'follow_up_at' then f.follow_up_at end desc nulls last,
      f.created_at desc
    limit least(greatest(p_limit, 1), 200) offset greatest(p_offset, 0)
  )
  select jsonb_build_object(
    'total', (select total from counted),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
      'id', p.id, 'order_number', p.order_number, 'status', p.status, 'payment_status', p.payment_status,
      'payment_method', p.payment_method, 'fraud_status', p.fraud_status, 'risk_level', p.risk_level,
      'source', p.source, 'customer_id', p.customer_id, 'customer_name', p.customer_name,
      'customer_phone', p.customer_phone, 'shipping_district', p.shipping_district,
      'total_amount', p.total_amount, 'amount_paid', p.amount_paid, 'cod_amount', p.cod_amount,
      'advance_required', p.advance_required, 'created_at', p.created_at,
      'label_printed_at', p.label_printed_at, 'label_print_count', p.label_print_count,
      'duplicate_status', p.duplicate_status, 'merged_count', p.merged_count,
      'duplicate_of_number', (select d.order_number from public.orders d where d.id = p.duplicate_of),
      'merged_into_number', (select d.order_number from public.orders d where d.id = p.merged_into),
      'item_count', (select coalesce(sum(quantity), 0) from public.order_items oi where oi.order_id = p.id),
      'items_preview', (select string_agg(oi.product_name || coalesce(' · ' || oi.variant_title, '') || ' ×' || oi.quantity, ', ' order by oi.created_at)
                        from public.order_items oi where oi.order_id = p.id),
      'courier_name', (select c.name from public.shipments s join public.couriers c on c.id = s.courier_id
                       where s.order_id = p.id and s.is_active limit 1),
      'tracking_number', (select s.tracking_number from public.shipments s where s.order_id = p.id and s.is_active limit 1),
      'stage', public.order_stage(p.status, p.confirmed_at),
      'confirmed_at', p.confirmed_at,
      'review_status', p.review_status, 'review_note', p.review_note, 'follow_up_at', p.follow_up_at,
      'contact_attempts', p.contact_attempts, 'last_contact_at', p.last_contact_at,
      'partial_return_amount', p.partial_return_amount,
      'attribution', (select jsonb_build_object('source', a.source, 'channel', a.channel, 'is_paid', a.is_paid, 'campaign', a.campaign)
                      from public.order_attributions a where a.order_id = p.id),
      'courier_history', (select jsonb_build_object('delivered', fc.delivered_orders,
                            'completed', fc.delivered_orders + fc.returned_orders + fc.failed_delivery_orders, 'score', fc.courier_score)
                          from public.fraud_checks fc where fc.id = p.fraud_check_id and fc.status <> 'ERROR')
    )) from page p), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

create or replace function public.admin_order_queue_counts()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('orders.view');
  return jsonb_build_object(
    'web', coalesce((select jsonb_object_agg(review_status, n) from (
      select review_status, count(*) as n from public.orders where confirmed_at is null group by review_status) s), '{}'::jsonb),
    'approved', coalesce((select jsonb_object_agg(stage, n) from (
      select public.order_stage(status, confirmed_at) as stage, count(*) as n
      from public.orders where confirmed_at is not null group by 1) s), '{}'::jsonb),
    'follow_up_due', (select count(*) from public.orders where confirmed_at is null and follow_up_at <= now()
                        and status not in ('CANCELLED', 'REJECTED_FRAUD')),
    'incomplete', (select count(*) from public.checkout_leads where status in ('OPEN', 'CONTACTED'))
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Bulk moves: an approved order steps through Processing on its way to packing
-- -----------------------------------------------------------------------------
create or replace function public.bulk_transition_orders(p_order_ids uuid[], p_to public.order_status, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_ok int := 0;
  v_failed jsonb := '[]'::jsonb;
begin
  if coalesce(array_length(p_order_ids, 1), 0) > 200 then
    raise exception 'VALIDATION: at most 200 orders per bulk update' using errcode = '22023';
  end if;
  foreach v_id in array coalesce(p_order_ids, '{}') loop
    begin
      if p_to in ('PRODUCTION', 'PACKING', 'READY_TO_SHIP') and (select status from public.orders where id = v_id) = 'CONFIRMED' then
        perform public.transition_order_status(v_id, 'PROCESSING', p_note);
      end if;
      perform public.transition_order_status(v_id, p_to, p_note);
      v_ok := v_ok + 1;
    exception when others then
      v_failed := v_failed || jsonb_build_object(
        'order_id', v_id,
        'order_number', (select order_number from public.orders where id = v_id),
        'error', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('updated', v_ok, 'failed', v_failed);
end;
$$;

-- -----------------------------------------------------------------------------
-- Incomplete checkouts turned into orders by staff keep the visitor's ad data
-- -----------------------------------------------------------------------------
create or replace function public._record_order_attribution(p_order_id uuid, p_attribution jsonb)
returns public.order_attributions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.order_attributions;
  v_first jsonb := case when jsonb_typeof(p_attribution -> 'first_touch') = 'object' then p_attribution -> 'first_touch' end;
  v_last jsonb := case when jsonb_typeof(p_attribution -> 'last_touch') = 'object' then p_attribution -> 'last_touch' end;
  v_visitor text := nullif(left(p_attribution ->> 'visitor_id', 64), '');
  v_session text := nullif(left(p_attribution ->> 'session_id', 64), '');
  v_c jsonb;
  v_fc jsonb;
  v_params jsonb;
  v_journey jsonb := '{}'::jsonb;
  v_order public.orders;
  v_campaign uuid;
begin
  select * into v_order from public.orders where id = p_order_id;
  if not found then
    raise exception 'NOT_FOUND: order not found' using errcode = 'P0002';
  end if;
  if length(coalesce(p_attribution, '{}'::jsonb)::text) > 20000 then
    raise exception 'VALIDATION: attribution data is too large' using errcode = '22023';
  end if;

  -- No ad, tagged link or referral within the window: a known visitor is direct;
  -- no data at all is unknown.
  v_c := case
    when v_last is not null then public.classify_touch(v_last)
    when v_first is not null or v_visitor is not null then public.classify_touch(jsonb_build_object('params', '{}'::jsonb))
    else public.classify_touch(null) end;
  v_fc := case when v_first is not null then public.classify_touch(v_first) end;
  v_params := coalesce(v_last -> 'params', '{}'::jsonb);

  if v_visitor is not null then
    select jsonb_build_object(
      'visits', count(distinct session_id),
      'page_views', count(*) filter (where event_type = 'PAGE_VIEW'),
      'product_views', count(*) filter (where event_type = 'VIEW_PRODUCT'),
      'add_to_cart', count(*) filter (where event_type = 'ADD_TO_CART'),
      'checkouts', count(*) filter (where event_type = 'BEGIN_CHECKOUT'),
      'first_seen_at', min(created_at),
      'last_seen_at', max(created_at))
    into v_journey
    from public.storefront_events
    where visitor_id = v_visitor and created_at between v_order.created_at - interval '30 days' and v_order.created_at + interval '5 minutes';
  end if;

  if v_c ->> 'campaign_id' is not null then
    select id into v_campaign from public.marketing_campaigns
    where platform = (v_c ->> 'platform')::public.marketing_platform and external_id = v_c ->> 'campaign_id';
  end if;
  if v_campaign is null and v_c ->> 'campaign' is not null then
    select id into v_campaign from public.marketing_campaigns where utm_campaign = v_c ->> 'campaign' limit 1;
  end if;

  insert into public.order_attributions(
    order_id, channel, source, medium, is_paid, platform, campaign, adset, ad, campaign_id, adset_id, ad_id,
    click_id_type, click_id, utm_source, utm_medium, utm_campaign, utm_content, utm_term, landing_page, referrer_host,
    first_channel, first_source, first_touch, last_touch, first_touch_at, last_touch_at, visitor_id, session_id,
    journey, marketing_campaign_id, recorded_by
  ) values (
    p_order_id, v_c ->> 'channel', v_c ->> 'source', v_c ->> 'medium', (v_c ->> 'is_paid')::boolean,
    (v_c ->> 'platform')::public.marketing_platform, left(v_c ->> 'campaign', 200), left(v_c ->> 'adset', 200), left(v_c ->> 'ad', 200),
    left(v_c ->> 'campaign_id', 64), left(v_c ->> 'adset_id', 64), left(v_c ->> 'ad_id', 64),
    v_c ->> 'click_id_type', v_c ->> 'click_id',
    left(v_params ->> 'utm_source', 120), left(v_params ->> 'utm_medium', 120), left(v_params ->> 'utm_campaign', 200),
    left(v_params ->> 'utm_content', 200), left(v_params ->> 'utm_term', 200),
    left(coalesce(v_last ->> 'landing', v_first ->> 'landing'), 300), v_c ->> 'referrer_host',
    coalesce(v_fc ->> 'channel', v_c ->> 'channel'), coalesce(v_fc ->> 'source', v_c ->> 'source'), v_first, v_last,
    (v_first ->> 'at')::timestamptz, (v_last ->> 'at')::timestamptz, v_visitor, v_session,
    coalesce(v_journey, '{}'::jsonb), v_campaign, 'STOREFRONT'
  )
  on conflict (order_id) do nothing
  returning * into v_row;

  if v_row.order_id is not null then
    update public.orders set
      utm_source = coalesce(utm_source, left(v_params ->> 'utm_source', 120)),
      utm_medium = coalesce(utm_medium, left(v_params ->> 'utm_medium', 120)),
      utm_campaign = coalesce(utm_campaign, left(v_params ->> 'utm_campaign', 200))
    where id = p_order_id;
  else
    select * into v_row from public.order_attributions where order_id = p_order_id;
  end if;
  return v_row;
end;
$$;

create or replace function public.record_order_attribution(p_order_id uuid, p_attribution jsonb)
returns public.order_attributions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return public._record_order_attribution(p_order_id, p_attribution);
end;
$$;

create or replace function public.admin_link_checkout_lead(p_lead_id uuid, p_order_id uuid)
returns public.checkout_leads
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lead public.checkout_leads;
  v_number text;
begin
  perform public.require_permission('orders.create');
  select * into v_lead from public.checkout_leads where id = p_lead_id for update;
  if not found then
    raise exception 'NOT_FOUND: incomplete checkout not found' using errcode = 'P0002';
  end if;
  select order_number into v_number from public.orders where id = p_order_id;
  if v_number is null then
    raise exception 'NOT_FOUND: order not found' using errcode = 'P0002';
  end if;
  if v_lead.status = 'CONVERTED' and v_lead.order_id is distinct from p_order_id then
    raise exception 'VALIDATION: this checkout already became another order' using errcode = '22023';
  end if;
  if jsonb_typeof(v_lead.attribution) = 'object' then
    perform public._record_order_attribution(p_order_id, v_lead.attribution);
  end if;
  update public.checkout_leads set status = 'CONVERTED', order_id = p_order_id, updated_at = now()
  where id = p_lead_id returning * into v_lead;
  perform public._order_log(p_order_id, 'FROM_INCOMPLETE_CHECKOUT', 'Created from an incomplete checkout');
  perform public.log_audit('checkout_lead.converted', 'checkout_lead', p_lead_id::text, null,
    jsonb_build_object('order_id', p_order_id, 'order_number', v_number));
  return v_lead;
end;
$$;

-- Whatever route the order comes in by, the customer's open checkout is done.
create or replace function public._orders_convert_leads()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.checkout_leads set status = 'CONVERTED', order_id = new.id, updated_at = now()
  where phone = new.customer_phone and status in ('OPEN', 'CONTACTED') and updated_at > now() - interval '7 days';
  return new;
end;
$$;
create trigger orders_convert_leads after insert on public.orders
  for each row execute function public._orders_convert_leads();

-- -----------------------------------------------------------------------------
-- Access
-- -----------------------------------------------------------------------------
alter table public.order_review_statuses enable row level security;
create policy order_review_statuses_read on public.order_review_statuses for select to authenticated
  using ((select public.is_staff()));
revoke all on public.order_review_statuses from anon, authenticated;
grant select on public.order_review_statuses to authenticated;
grant all on public.order_review_statuses to service_role;

revoke execute on function public.order_stage(public.order_status, timestamptz), public._orders_review_sync(),
  public._post_partial_return_finance(uuid), public._post_lost_parcel_finance(uuid), public._reverse_lost_parcel_finance(uuid),
  public.record_partial_delivery(uuid, jsonb, text), public.set_web_order_status(uuid[], text, text, timestamptz),
  public.approve_orders(uuid[], text), public.admin_save_review_status(jsonb), public.admin_order_queue_counts(),
  public._record_order_attribution(uuid, jsonb), public.admin_link_checkout_lead(uuid, uuid), public._orders_convert_leads()
from public, anon, authenticated;
grant execute on function public.order_stage(public.order_status, timestamptz), public._orders_review_sync(),
  public._post_partial_return_finance(uuid), public._post_lost_parcel_finance(uuid), public._reverse_lost_parcel_finance(uuid),
  public.record_partial_delivery(uuid, jsonb, text), public.set_web_order_status(uuid[], text, text, timestamptz),
  public.approve_orders(uuid[], text), public.admin_save_review_status(jsonb), public.admin_order_queue_counts(),
  public._record_order_attribution(uuid, jsonb), public.admin_link_checkout_lead(uuid, uuid), public._orders_convert_leads()
to service_role;
grant execute on function public.order_stage(public.order_status, timestamptz),
  public.record_partial_delivery(uuid, jsonb, text), public.set_web_order_status(uuid[], text, text, timestamptz),
  public.approve_orders(uuid[], text), public.admin_save_review_status(jsonb), public.admin_order_queue_counts(),
  public.admin_link_checkout_lead(uuid, uuid)
to authenticated;
