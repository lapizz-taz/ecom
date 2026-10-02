-- =============================================================================
-- 0400 · Orders, status pipeline, stock reservations, payments
-- =============================================================================

create sequence public.order_number_seq start with 10001;

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  customer_id uuid not null references public.customers(id),
  auth_user_id uuid references auth.users(id) on delete set null,
  source public.order_source not null default 'STOREFRONT',
  status public.order_status not null default 'PENDING',
  payment_method public.payment_method not null default 'COD',
  payment_status public.payment_status not null default 'UNPAID',
  fraud_status public.fraud_status not null default 'NOT_CHECKED',
  risk_level public.risk_level,
  fraud_check_id uuid,

  customer_name text not null,
  customer_phone text not null,
  customer_email text,
  shipping_address text not null,
  shipping_area text,
  shipping_city text,
  shipping_district text not null,
  shipping_postal_code text,
  delivery_zone_id uuid references public.delivery_zones(id) on delete set null,
  delivery_method text not null default 'standard',

  subtotal numeric(12,2) not null default 0 check (subtotal >= 0),
  coupon_id uuid references public.coupons(id),
  coupon_code text,
  coupon_discount numeric(12,2) not null default 0 check (coupon_discount >= 0),
  manual_discount numeric(12,2) not null default 0 check (manual_discount >= 0),
  discount_total numeric(12,2) not null default 0 check (discount_total >= 0),
  delivery_charge numeric(12,2) not null default 0 check (delivery_charge >= 0),
  delivery_discount numeric(12,2) not null default 0 check (delivery_discount >= 0),
  return_charge numeric(12,2) not null default 0 check (return_charge >= 0),
  total_amount numeric(12,2) not null default 0 check (total_amount >= 0),
  cost_total numeric(12,2) not null default 0 check (cost_total >= 0),

  advance_required numeric(12,2) not null default 0 check (advance_required >= 0),
  advance_type public.advance_type not null default 'NONE',
  advance_due_at timestamptz,
  amount_paid numeric(12,2) not null default 0,
  amount_refunded numeric(12,2) not null default 0 check (amount_refunded >= 0),
  cod_amount numeric(12,2) not null default 0 check (cod_amount >= 0),
  advance_resolution public.advance_resolution,

  customer_note text,
  cancel_reason text,
  idempotency_key text unique,
  utm_source text,
  utm_medium text,
  utm_campaign text,

  confirmed_at timestamptz,
  shipped_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  returned_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint orders_discount_not_above_subtotal check (discount_total <= subtotal),
  constraint orders_delivery_discount_not_above_charge check (delivery_discount <= delivery_charge)
);
create index orders_status_created_idx on public.orders(status, created_at desc);
create index orders_created_idx on public.orders(created_at desc);
create index orders_customer_idx on public.orders(customer_id, created_at desc);
create index orders_phone_idx on public.orders(customer_phone);
create index orders_auth_user_idx on public.orders(auth_user_id) where auth_user_id is not null;
create index orders_payment_status_idx on public.orders(payment_status);
create index orders_fraud_status_idx on public.orders(fraud_status);
create index orders_delivered_idx on public.orders(delivered_at) where delivered_at is not null;
create index orders_district_idx on public.orders(lower(shipping_district));
create index orders_utm_campaign_idx on public.orders(utm_campaign) where utm_campaign is not null;
create index orders_name_trgm_idx on public.orders using gin(customer_name extensions.gin_trgm_ops);
create index orders_phone_trgm_idx on public.orders using gin(customer_phone extensions.gin_trgm_ops);
create index orders_address_trgm_idx on public.orders using gin(shipping_address extensions.gin_trgm_ops);
create index orders_number_trgm_idx on public.orders using gin(order_number extensions.gin_trgm_ops);
create trigger orders_updated_at before update on public.orders
  for each row execute function public.set_updated_at();

alter table public.coupon_usage
  add constraint coupon_usage_order_fk foreign key (order_id) references public.orders(id);

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid not null references public.products(id),
  variant_id uuid not null references public.product_variants(id),
  product_name text not null,
  variant_title text,
  sku text not null,
  image_url text,
  unit_price numeric(12,2) not null check (unit_price >= 0),
  unit_cost numeric(12,2) not null default 0 check (unit_cost >= 0),
  quantity int not null check (quantity > 0),
  line_subtotal numeric(12,2) not null check (line_subtotal >= 0),
  discount_amount numeric(12,2) not null default 0 check (discount_amount >= 0),
  line_total numeric(12,2) not null check (line_total >= 0),
  track_inventory boolean not null default true,
  requires_production boolean not null default false,
  returned_quantity int not null default 0 check (returned_quantity >= 0),
  damaged_quantity int not null default 0 check (damaged_quantity >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint order_items_return_le_qty check (returned_quantity + damaged_quantity <= quantity)
);
create index order_items_order_idx on public.order_items(order_id);
create index order_items_variant_idx on public.order_items(variant_id);
create index order_items_product_idx on public.order_items(product_id);
create index order_items_sku_idx on public.order_items(sku);
create trigger order_items_updated_at before update on public.order_items
  for each row execute function public.set_updated_at();

-- Allowed status transitions live in data, not in code.
create table public.order_status_transitions (
  from_status public.order_status not null,
  to_status public.order_status not null,
  primary key (from_status, to_status),
  check (from_status <> to_status)
);

insert into public.order_status_transitions(from_status, to_status) values
  ('PENDING', 'FRAUD_CHECK'), ('PENDING', 'CONFIRMATION_REQUIRED'), ('PENDING', 'CONFIRMED'),
  ('PENDING', 'ADVANCE_REQUIRED'), ('PENDING', 'CANCELLED'),
  ('FRAUD_CHECK', 'CONFIRMATION_REQUIRED'), ('FRAUD_CHECK', 'CONFIRMED'), ('FRAUD_CHECK', 'ADVANCE_REQUIRED'),
  ('FRAUD_CHECK', 'FRAUD_REVIEW'), ('FRAUD_CHECK', 'REJECTED_FRAUD'), ('FRAUD_CHECK', 'CANCELLED'),
  ('ADVANCE_REQUIRED', 'CONFIRMATION_REQUIRED'), ('ADVANCE_REQUIRED', 'CONFIRMED'), ('ADVANCE_REQUIRED', 'FRAUD_REVIEW'),
  ('ADVANCE_REQUIRED', 'REJECTED_FRAUD'), ('ADVANCE_REQUIRED', 'CANCELLED'), ('ADVANCE_REQUIRED', 'FRAUD_CHECK'),
  ('FRAUD_REVIEW', 'CONFIRMATION_REQUIRED'), ('FRAUD_REVIEW', 'CONFIRMED'), ('FRAUD_REVIEW', 'ADVANCE_REQUIRED'),
  ('FRAUD_REVIEW', 'REJECTED_FRAUD'), ('FRAUD_REVIEW', 'CANCELLED'), ('FRAUD_REVIEW', 'FRAUD_CHECK'),
  ('CONFIRMATION_REQUIRED', 'CONFIRMED'), ('CONFIRMATION_REQUIRED', 'ADVANCE_REQUIRED'),
  ('CONFIRMATION_REQUIRED', 'FRAUD_REVIEW'), ('CONFIRMATION_REQUIRED', 'FRAUD_CHECK'), ('CONFIRMATION_REQUIRED', 'CANCELLED'),
  ('CONFIRMED', 'PROCESSING'), ('CONFIRMED', 'CANCELLED'),
  ('PROCESSING', 'PRODUCTION'), ('PROCESSING', 'PACKING'), ('PROCESSING', 'READY_TO_SHIP'), ('PROCESSING', 'CANCELLED'),
  ('PRODUCTION', 'QUALITY_CHECK'), ('PRODUCTION', 'PACKING'), ('PRODUCTION', 'CANCELLED'),
  ('QUALITY_CHECK', 'PACKING'), ('QUALITY_CHECK', 'PRODUCTION'), ('QUALITY_CHECK', 'CANCELLED'),
  ('PACKING', 'READY_TO_SHIP'), ('PACKING', 'CANCELLED'),
  ('READY_TO_SHIP', 'SHIPPED'), ('READY_TO_SHIP', 'PACKING'), ('READY_TO_SHIP', 'CANCELLED'),
  ('SHIPPED', 'DELIVERED'), ('SHIPPED', 'FAILED_DELIVERY'), ('SHIPPED', 'RETURN_REQUESTED'),
  ('DELIVERED', 'RETURN_REQUESTED'),
  ('FAILED_DELIVERY', 'RETURNED'), ('FAILED_DELIVERY', 'SHIPPED'),
  ('RETURN_REQUESTED', 'RETURNED'), ('RETURN_REQUESTED', 'DELIVERED'),
  ('REJECTED_FRAUD', 'FRAUD_REVIEW');

-- Order activity timeline. Status changes have to_status set; other events
-- (fraud checked, payment received, courier assigned, ...) use event codes.
create table public.order_status_history (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  event text not null default 'STATUS_CHANGED',
  from_status public.order_status,
  to_status public.order_status,
  message text,
  metadata jsonb not null default '{}'::jsonb,
  is_customer_visible boolean not null default false,
  actor_id uuid,
  actor_name text,
  created_at timestamptz not null default now()
);
create index order_status_history_order_idx on public.order_status_history(order_id, created_at);
create index order_status_history_to_status_idx on public.order_status_history(to_status, created_at desc);
create trigger order_status_history_immutable before update or delete on public.order_status_history
  for each row execute function public.prevent_mutation();

create table public.order_notes (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  kind public.note_kind not null default 'NOTE',
  visibility public.note_visibility not null default 'INTERNAL',
  body text not null check (length(trim(body)) > 0),
  created_by uuid,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index order_notes_order_idx on public.order_notes(order_id, created_at desc);

create table public.stock_reservations (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  order_item_id uuid references public.order_items(id) on delete set null,
  variant_id uuid not null references public.product_variants(id),
  quantity int not null check (quantity > 0),
  status public.reservation_status not null default 'ACTIVE',
  released_at timestamptz,
  committed_at timestamptz,
  created_at timestamptz not null default now()
);
create index stock_reservations_order_idx on public.stock_reservations(order_id);
create index stock_reservations_active_idx on public.stock_reservations(variant_id) where status = 'ACTIVE';

-- -----------------------------------------------------------------------------
-- Payments
--   payments          one row per payment attempt with a provider (gateway or
--                     manual mobile-banking submission)
--   payment_events    raw provider callbacks; unique (provider, event_id)
--                     makes webhooks safe to receive many times
--   order_payments    confirmed money in/out for an order (immutable ledger)
-- -----------------------------------------------------------------------------
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id),
  provider text not null check (provider ~ '^[a-z0-9_]+$'),
  purpose public.payment_purpose not null,
  amount numeric(12,2) not null check (amount > 0),
  currency text not null default 'BDT',
  status public.payment_intent_status not null default 'PENDING',
  reference text not null unique default ('PAY-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 16))),
  provider_transaction_id text,
  channel public.payment_channel not null default 'GATEWAY',
  payer_phone text,
  redirect_url text,
  failure_reason text,
  verified_by uuid,
  verified_at timestamptz,
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index payments_provider_txn_unique on public.payments(provider, provider_transaction_id)
  where provider_transaction_id is not null and status not in ('FAILED', 'CANCELLED');
create index payments_order_idx on public.payments(order_id);
create index payments_status_idx on public.payments(status, created_at desc);
create trigger payments_updated_at before update on public.payments
  for each row execute function public.set_updated_at();

create table public.payment_events (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid references public.payments(id),
  provider text not null,
  event_id text not null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  result text,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (provider, event_id)
);
create index payment_events_payment_idx on public.payment_events(payment_id);

create table public.order_payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id),
  payment_id uuid unique references public.payments(id),
  kind public.order_payment_kind not null,
  channel public.payment_channel not null,
  amount numeric(12,2) not null check (amount > 0),
  reference text,
  note text,
  idempotency_key text unique,
  recorded_by uuid,
  created_at timestamptz not null default now()
);
create index order_payments_order_idx on public.order_payments(order_id);
create index order_payments_created_idx on public.order_payments(created_at desc);
create index order_payments_kind_idx on public.order_payments(kind, created_at desc);
create trigger order_payments_immutable before update or delete on public.order_payments
  for each row execute function public.prevent_mutation();

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------
create or replace function public.next_order_number()
returns text
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select public.setting_text('store', array['order_prefix'], 'ISO') || '-' || nextval('public.order_number_seq')::text
$$;

create or replace function public.order_is_editable(p_status public.order_status)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_status in ('PENDING', 'FRAUD_CHECK', 'ADVANCE_REQUIRED', 'FRAUD_REVIEW', 'CONFIRMATION_REQUIRED',
                      'CONFIRMED', 'PROCESSING', 'PRODUCTION', 'QUALITY_CHECK', 'PACKING', 'READY_TO_SHIP')
$$;

create or replace function public.actor_display_name()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select nullif(full_name, '') from public.profiles where id = auth.uid()),
    (select email from public.profiles where id = auth.uid()),
    case when auth.uid() is not null then 'Customer' else 'System' end
  )
$$;

create or replace function public._order_log(
  p_order_id uuid,
  p_event text,
  p_message text,
  p_from public.order_status default null,
  p_to public.order_status default null,
  p_metadata jsonb default '{}'::jsonb,
  p_customer_visible boolean default false
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.order_status_history(order_id, event, from_status, to_status, message, metadata,
                                          is_customer_visible, actor_id, actor_name)
  values (p_order_id, p_event, p_from, p_to, p_message, coalesce(p_metadata, '{}'::jsonb),
          p_customer_visible, auth.uid(), public.actor_display_name())
$$;

-- -----------------------------------------------------------------------------
-- Pricing: every price, discount and delivery charge is computed here, from
-- the database, never from client input.
-- p_items: [{variant_id, quantity, unit_price?}] — unit_price is honoured only
-- when p_allow_price_override (staff manual orders with orders.price_override).
-- -----------------------------------------------------------------------------
create or replace function public.calculate_order_quote(
  p_items jsonb,
  p_district text,
  p_area text default null,
  p_delivery_method text default 'standard',
  p_coupon_code text default null,
  p_phone text default null,
  p_allow_inactive boolean default false,
  p_allow_price_override boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_lines jsonb := '[]'::jsonb;
  v_item record;
  v_subtotal numeric := 0;
  v_cost numeric := 0;
  v_zone public.delivery_zones;
  v_method_extra numeric;
  v_delivery numeric := 0;
  v_coupon jsonb;
  v_coupon_discount numeric := 0;
  v_delivery_discount numeric := 0;
  v_max_qty int := public.setting_numeric('orders', array['max_quantity_per_item'], 50)::int;
  v_errors jsonb := '[]'::jsonb;
  v_unit numeric;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'VALIDATION: the cart is empty' using errcode = '22023';
  end if;

  for v_item in
    with requested as (
      select (e ->> 'variant_id')::uuid as variant_id,
             sum((e ->> 'quantity')::int) as quantity,
             max(nullif(e ->> 'unit_price', '')::numeric) as unit_price_override
      from jsonb_array_elements(p_items) e
      group by 1
    )
    select r.variant_id, r.quantity, r.unit_price_override,
           v.sku, v.title as variant_title, v.is_active as variant_active,
           p.id as product_id, p.name as product_name, p.status as product_status,
           p.track_inventory, p.requires_production,
           coalesce(v.price, p.price) as unit_price,
           coalesce(v.cost_price, p.cost_price, 0) as unit_cost,
           coalesce(i.available, 0) as available,
           (select pi.url from public.product_images pi
             where pi.product_id = p.id and (pi.variant_id = v.id or pi.variant_id is null)
             order by (pi.variant_id = v.id) desc nulls last, pi.is_primary desc, pi.position limit 1) as image_url
    from requested r
    left join public.product_variants v on v.id = r.variant_id
    left join public.products p on p.id = v.product_id
    left join public.inventory i on i.variant_id = v.id
  loop
    if v_item.sku is null then
      raise exception 'VALIDATION: a product in the cart no longer exists' using errcode = '22023';
    end if;
    if not p_allow_inactive and (v_item.product_status <> 'ACTIVE' or not v_item.variant_active) then
      raise exception 'VALIDATION: % is no longer available', v_item.product_name using errcode = '22023';
    end if;
    if v_item.quantity is null or v_item.quantity < 1 then
      raise exception 'VALIDATION: quantity must be at least 1' using errcode = '22023';
    end if;
    if v_item.quantity > v_max_qty then
      raise exception 'VALIDATION: you can order at most % of %', v_max_qty, v_item.product_name using errcode = '22023';
    end if;
    if v_item.track_inventory and v_item.available < v_item.quantity and not public.allow_overselling() then
      v_errors := v_errors || jsonb_build_object('variant_id', v_item.variant_id, 'code', 'INSUFFICIENT_STOCK',
        'message', case when v_item.available <= 0 then format('%s is out of stock', v_item.product_name)
                        else format('Only %s of %s left in stock', v_item.available, v_item.product_name) end,
        'available', greatest(v_item.available, 0));
    end if;

    v_unit := case when p_allow_price_override and v_item.unit_price_override is not null
                   then v_item.unit_price_override else v_item.unit_price end;
    if v_unit < 0 then
      raise exception 'VALIDATION: price cannot be negative' using errcode = '22023';
    end if;

    v_lines := v_lines || jsonb_build_object(
      'variant_id', v_item.variant_id,
      'product_id', v_item.product_id,
      'product_name', v_item.product_name,
      'variant_title', v_item.variant_title,
      'sku', v_item.sku,
      'image_url', v_item.image_url,
      'unit_price', public.money(v_unit),
      'unit_cost', public.money(v_item.unit_cost),
      'quantity', v_item.quantity,
      'line_subtotal', public.money(v_unit * v_item.quantity),
      'track_inventory', v_item.track_inventory,
      'requires_production', v_item.requires_production,
      'available', case when v_item.track_inventory then greatest(v_item.available, 0) end
    );
    v_subtotal := v_subtotal + public.money(v_unit * v_item.quantity);
    v_cost := v_cost + public.money(v_item.unit_cost * v_item.quantity);
  end loop;

  v_zone := public.resolve_delivery_zone(p_district, p_area);
  v_method_extra := public.delivery_method_extra(p_delivery_method);
  if v_method_extra is null then
    raise exception 'VALIDATION: delivery method % is not available', p_delivery_method using errcode = '22023';
  end if;
  if v_zone.id is not null then
    v_delivery := v_zone.charge + v_method_extra;
  elsif coalesce(trim(p_district), '') <> '' then
    raise exception 'VALIDATION: we do not deliver to % yet', p_district using errcode = '22023';
  end if;

  -- Free delivery over a configured order value.
  if public.setting_numeric('delivery', array['free_delivery_threshold'], 0) > 0
     and v_subtotal >= public.setting_numeric('delivery', array['free_delivery_threshold'], 0) then
    v_delivery_discount := v_delivery;
  end if;

  if coalesce(trim(p_coupon_code), '') <> '' then
    v_coupon := public.evaluate_coupon(p_coupon_code, v_subtotal, p_phone, v_delivery);
    if (v_coupon ->> 'valid')::boolean then
      v_coupon_discount := (v_coupon ->> 'discount_amount')::numeric;
      v_delivery_discount := greatest(v_delivery_discount, (v_coupon ->> 'delivery_discount')::numeric);
    end if;
  end if;

  -- Allocate the coupon discount across lines (largest line takes rounding).
  v_lines := public._allocate_discount(v_lines, v_coupon_discount);

  return jsonb_build_object(
    'lines', v_lines,
    'subtotal', public.money(v_subtotal),
    'coupon', v_coupon,
    'coupon_discount', public.money(v_coupon_discount),
    'discount_total', public.money(v_coupon_discount),
    'delivery_zone', case when v_zone.id is null then null else jsonb_build_object(
      'id', v_zone.id, 'name', v_zone.name, 'charge', v_zone.charge, 'return_charge', v_zone.return_charge,
      'estimated_days', v_zone.estimated_days) end,
    'delivery_method', coalesce(nullif(p_delivery_method, ''), 'standard'),
    'delivery_charge', public.money(v_delivery),
    'delivery_discount', public.money(v_delivery_discount),
    'return_charge', public.money(coalesce(v_zone.return_charge, 0)),
    'total', public.money(v_subtotal - v_coupon_discount + v_delivery - v_delivery_discount),
    'cost_total', public.money(v_cost),
    'stock_errors', v_errors
  );
end;
$$;

-- Distributes p_discount across lines proportionally to line_subtotal and
-- writes discount_amount / line_total on each line.
create or replace function public._allocate_discount(p_lines jsonb, p_discount numeric)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_total numeric := 0;
  v_out jsonb := '[]'::jsonb;
  v_line jsonb;
  v_share numeric;
  v_allocated numeric := 0;
  v_idx int := 0;
  v_max_idx int := 0;
  v_max_val numeric := -1;
  v_count int := jsonb_array_length(p_lines);
begin
  select coalesce(sum((l ->> 'line_subtotal')::numeric), 0) into v_total from jsonb_array_elements(p_lines) l;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_share := case when v_total > 0 and coalesce(p_discount, 0) > 0
      then round(coalesce(p_discount, 0) * (v_line ->> 'line_subtotal')::numeric / v_total, 2) else 0 end;
    v_allocated := v_allocated + v_share;
    if (v_line ->> 'line_subtotal')::numeric > v_max_val then
      v_max_val := (v_line ->> 'line_subtotal')::numeric;
      v_max_idx := v_idx;
    end if;
    v_out := v_out || jsonb_build_array(v_line || jsonb_build_object('_share', v_share));
    v_idx := v_idx + 1;
  end loop;

  -- Put the rounding remainder on the largest line.
  v_out := (
    select jsonb_agg(
      (l - '_share') || jsonb_build_object(
        'discount_amount', least((l ->> '_share')::numeric
          + case when ord - 1 = v_max_idx then coalesce(p_discount, 0) - v_allocated else 0 end,
          (l ->> 'line_subtotal')::numeric),
        'line_total', (l ->> 'line_subtotal')::numeric - least((l ->> '_share')::numeric
          + case when ord - 1 = v_max_idx then coalesce(p_discount, 0) - v_allocated else 0 end,
          (l ->> 'line_subtotal')::numeric)
      ) order by ord)
    from jsonb_array_elements(v_out) with ordinality as t(l, ord)
  );
  return coalesce(v_out, '[]'::jsonb);
end;
$$;

-- -----------------------------------------------------------------------------
-- Stock reservation lifecycle for orders
-- -----------------------------------------------------------------------------
create or replace function public._reserve_order_item(p_item public.order_items, p_order_number text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inv public.inventory;
begin
  if not p_item.track_inventory then
    return;
  end if;
  select * into v_inv from public.inventory where variant_id = p_item.variant_id for update;
  if not found then
    raise exception 'NOT_FOUND: no inventory for %', p_item.sku using errcode = 'P0002';
  end if;
  if v_inv.available < p_item.quantity and not public.allow_overselling() then
    raise exception 'INSUFFICIENT_STOCK: % has only % available', p_item.product_name, greatest(v_inv.available, 0)
      using errcode = 'P0001';
  end if;
  perform public._apply_inventory_movement(p_item.variant_id, 'RESERVATION', 0, p_item.quantity, 0,
    'ORDER', p_item.order_id, p_order_number, 'Reserved for order', null, true);
  insert into public.stock_reservations(order_id, order_item_id, variant_id, quantity)
  values (p_item.order_id, p_item.id, p_item.variant_id, p_item.quantity);
end;
$$;

create or replace function public._release_order_stock(p_order_id uuid, p_reason text)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_res public.stock_reservations;
  v_number text := (select order_number from public.orders where id = p_order_id);
  v_count int := 0;
begin
  for v_res in select * from public.stock_reservations where order_id = p_order_id and status = 'ACTIVE' for update loop
    perform public._apply_inventory_movement(v_res.variant_id, 'RELEASE', 0, -v_res.quantity, 0,
      'ORDER', p_order_id, v_number, coalesce(p_reason, 'Reservation released'), null, true);
    update public.stock_reservations set status = 'RELEASED', released_at = now() where id = v_res.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Shipment converts the reservation into a sale (physical stock leaves).
create or replace function public._commit_order_stock(p_order_id uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_res public.stock_reservations;
  v_number text := (select order_number from public.orders where id = p_order_id);
  v_count int := 0;
begin
  for v_res in select * from public.stock_reservations where order_id = p_order_id and status = 'ACTIVE' for update loop
    perform public._apply_inventory_movement(v_res.variant_id, 'SALE', -v_res.quantity, -v_res.quantity, 0,
      'ORDER', p_order_id, v_number, 'Shipped', public.variant_cost(v_res.variant_id), true);
    update public.stock_reservations set status = 'COMMITTED', committed_at = now() where id = v_res.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Returned goods: RESTOCK goes back to sellable stock, DAMAGED to the damaged
-- bucket. p_items: [{order_item_id, quantity, condition}] or null = everything
-- not yet returned, using the default condition from settings.
create or replace function public._return_order_stock(p_order_id uuid, p_items jsonb, p_note text)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_item public.order_items;
  v_req jsonb;
  v_reqs jsonb;
  v_qty int;
  v_condition text;
  v_count int := 0;
  v_default text := case when public.setting_bool('inventory', array['return_restock_default'], true)
                         then 'RESTOCK' else 'DAMAGED' end;
  v_mov public.inventory_movements;
begin
  select * into v_order from public.orders where id = p_order_id;
  if v_order.shipped_at is null then
    return 0; -- nothing left the warehouse; reservations are released instead
  end if;

  if p_items is null then
    select coalesce(jsonb_agg(jsonb_build_object('order_item_id', id,
             'quantity', quantity - returned_quantity - damaged_quantity, 'condition', v_default)), '[]'::jsonb)
    into v_reqs
    from public.order_items
    where order_id = p_order_id and quantity - returned_quantity - damaged_quantity > 0;
  else
    v_reqs := p_items;
  end if;

  -- Several entries may target the same line (e.g. 2 restocked + 1 damaged).
  for v_req in select * from jsonb_array_elements(v_reqs) loop
    select * into v_item from public.order_items
    where id = (v_req ->> 'order_item_id')::uuid and order_id = p_order_id for update;
    if not found then
      raise exception 'VALIDATION: returned item does not belong to this order' using errcode = '22023';
    end if;
    v_qty := (v_req ->> 'quantity')::int;
    v_condition := upper(coalesce(v_req ->> 'condition', v_default));
    if v_qty is null or v_qty <= 0 then
      continue;
    end if;
    if v_qty > v_item.quantity - v_item.returned_quantity - v_item.damaged_quantity then
      raise exception 'VALIDATION: cannot return more % than were shipped', v_item.sku using errcode = '22023';
    end if;
    if v_condition not in ('RESTOCK', 'DAMAGED') then
      raise exception 'VALIDATION: return condition must be RESTOCK or DAMAGED' using errcode = '22023';
    end if;

    v_mov := null;
    if v_item.track_inventory then
      if v_condition = 'RESTOCK' then
        v_mov := public._apply_inventory_movement(v_item.variant_id, 'RETURN', v_qty, 0, 0, 'ORDER', p_order_id,
          v_order.order_number, coalesce(p_note, 'Returned to stock'), v_item.unit_cost);
      else
        v_mov := public._apply_inventory_movement(v_item.variant_id, 'DAMAGE', 0, 0, v_qty, 'ORDER', p_order_id,
          v_order.order_number, coalesce(p_note, 'Returned damaged'), v_item.unit_cost);
      end if;
    end if;

    if v_condition = 'RESTOCK' then
      update public.order_items set returned_quantity = returned_quantity + v_qty where id = v_item.id;
      -- Goods back on the shelf after revenue was recognised: reverse their COGS.
      if v_order.delivered_at is not null and v_item.unit_cost > 0 then
        perform public._post_finance('EXPENSE', 'COGS', -public.money(v_item.unit_cost * v_qty),
          (now() at time zone public.store_timezone())::date, false, p_order_id,
          v_order.customer_id, null,
          v_order.order_number, format('COGS reversal: %s × %s returned to stock', v_qty, v_item.sku),
          'order_item:' || v_item.id || ':return:' || coalesce(v_mov.id::text, gen_random_uuid()::text),
          null);
      end if;
    else
      update public.order_items set damaged_quantity = damaged_quantity + v_qty where id = v_item.id;
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- Totals & customer statistics
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

  -- Manual discount can never exceed what is left after the coupon.
  v_coupon_discount := least(v_coupon_discount, v_subtotal);
  update public.orders set manual_discount = least(manual_discount, v_subtotal - v_coupon_discount)
  where id = p_order_id returning * into v_order;

  -- Re-allocate the total discount across lines.
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

  update public.orders set
    subtotal = public.money(v_subtotal),
    coupon_discount = public.money(v_coupon_discount),
    discount_total = public.money(v_coupon_discount + manual_discount),
    delivery_discount = public.money(v_delivery_discount),
    total_amount = v_total,
    cost_total = public.money(v_cost),
    amount_paid = public.money(v_paid - v_refunded),
    amount_refunded = public.money(v_refunded),
    cod_amount = greatest(v_total - public.money(v_paid - v_refunded), 0),
    payment_status = case
      when v_refunded > 0 and v_paid - v_refunded <= 0 then 'REFUNDED'
      when v_refunded > 0 then 'PARTIALLY_REFUNDED'
      when v_paid >= v_total and v_total > 0 then 'PAID'
      when v_paid > 0 then 'PARTIALLY_PAID'
      else 'UNPAID'
    end::public.payment_status
  where id = p_order_id
  returning * into v_order;

  return v_order;
end;
$$;

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
      count(*) filter (where status in ('DELIVERED', 'RETURN_REQUESTED') and delivered_at is not null) as delivered,
      count(*) filter (where status = 'CANCELLED') as cancelled,
      count(*) filter (where status = 'RETURNED' and delivered_at is not null) as returned,
      count(*) filter (where status = 'FAILED_DELIVERY' or (status = 'RETURNED' and delivered_at is null)) as failed,
      coalesce(sum(total_amount - amount_refunded) filter (
        where status in ('DELIVERED', 'RETURN_REQUESTED') and delivered_at is not null), 0) as spent,
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

-- -----------------------------------------------------------------------------
-- Order creation (shared by storefront checkout and admin manual orders)
-- -----------------------------------------------------------------------------
create or replace function public._create_order(p_payload jsonb, p_source public.order_source)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.orders;
  v_customer public.customers;
  v_phone text := public.clean_phone(p_payload #>> '{customer,phone}');
  v_name text := trim(coalesce(p_payload #>> '{customer,full_name}', ''));
  v_email text := nullif(lower(trim(coalesce(p_payload #>> '{customer,email}', ''))), '');
  v_address text := trim(coalesce(p_payload #>> '{shipping,address}', ''));
  v_district text := trim(coalesce(p_payload #>> '{shipping,district}', ''));
  v_area text := nullif(trim(coalesce(p_payload #>> '{shipping,area}', '')), '');
  v_city text := nullif(trim(coalesce(p_payload #>> '{shipping,city}', '')), '');
  v_postal text := nullif(trim(coalesce(p_payload #>> '{shipping,postal_code}', '')), '');
  v_auth uuid := nullif(p_payload ->> 'auth_user_id', '')::uuid;
  v_is_admin boolean := p_source <> 'STOREFRONT';
  v_quote jsonb;
  v_order public.orders;
  v_line jsonb;
  v_item public.order_items;
  v_coupon_id uuid;
  v_coupon public.coupons;
  v_pattern text := public.setting_text('store', array['phone_pattern'], '^01[3-9][0-9]{8}$');
  v_delivery_override numeric := nullif(p_payload ->> 'delivery_charge', '')::numeric;
  v_manual_discount numeric := coalesce(nullif(p_payload ->> 'manual_discount', '')::numeric, 0);
  v_payment_method public.payment_method := coalesce(nullif(p_payload ->> 'payment_method', ''), 'COD')::public.payment_method;
begin
  -- Idempotent checkout: the same key always returns the same order.
  if nullif(p_payload ->> 'idempotency_key', '') is not null then
    select * into v_existing from public.orders where idempotency_key = p_payload ->> 'idempotency_key';
    if found then
      return v_existing;
    end if;
  end if;

  if length(v_name) < 2 then
    raise exception 'VALIDATION: customer name is required' using errcode = '22023';
  end if;
  if v_phone is null or v_phone !~ v_pattern then
    raise exception 'VALIDATION: enter a valid mobile number' using errcode = '22023';
  end if;
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'VALIDATION: enter a valid email address' using errcode = '22023';
  end if;
  if length(v_address) < 5 then
    raise exception 'VALIDATION: delivery address is required' using errcode = '22023';
  end if;
  if v_district = '' then
    raise exception 'VALIDATION: district is required' using errcode = '22023';
  end if;
  if v_manual_discount < 0 or (v_delivery_override is not null and v_delivery_override < 0) then
    raise exception 'VALIDATION: amounts cannot be negative' using errcode = '22023';
  end if;
  if not v_is_admin and v_payment_method = 'COD' and not public.setting_bool('payments', array['cod_enabled'], true) then
    raise exception 'VALIDATION: cash on delivery is not available' using errcode = '22023';
  end if;

  -- Customer (one record per phone number).
  select * into v_customer from public.customers where phone = v_phone for update;
  if not found then
    insert into public.customers(full_name, phone, email, address, area, city, district, auth_user_id)
    values (v_name, v_phone, v_email, v_address, v_area, v_city, v_district,
            case when v_auth is not null and not exists (select 1 from public.customers where auth_user_id = v_auth)
                 then v_auth end)
    returning * into v_customer;
  else
    if v_customer.status = 'BLOCKED' and not v_is_admin then
      raise exception 'ORDER_BLOCKED: this order cannot be placed online' using errcode = 'P0001';
    end if;
    update public.customers set
      email = coalesce(email, v_email),
      address = v_address, area = v_area, city = v_city, district = v_district
    where id = v_customer.id
    returning * into v_customer;
  end if;

  -- Server-side pricing.
  v_quote := public.calculate_order_quote(
    p_payload -> 'items', v_district, v_area, coalesce(p_payload ->> 'delivery_method', 'standard'),
    p_payload ->> 'coupon_code', v_phone, v_is_admin,
    v_is_admin and public.has_permission('orders.price_override') or (v_is_admin and public.is_system_context()));

  if nullif(trim(coalesce(p_payload ->> 'coupon_code', '')), '') is not null then
    if not coalesce((v_quote #>> '{coupon,valid}')::boolean, false) then
      raise exception 'COUPON_INVALID: %', coalesce(v_quote #>> '{coupon,message}', 'coupon is not valid')
        using errcode = 'P0001';
    end if;
    v_coupon_id := (v_quote #>> '{coupon,coupon_id}')::uuid;
    -- Serialize concurrent use of a limited coupon.
    select * into v_coupon from public.coupons where id = v_coupon_id for update;
    if v_coupon.usage_limit is not null and v_coupon.usage_count >= v_coupon.usage_limit then
      raise exception 'COUPON_INVALID: this coupon has reached its usage limit' using errcode = 'P0001';
    end if;
  end if;

  insert into public.orders(
    order_number, customer_id, auth_user_id, source, status, payment_method,
    customer_name, customer_phone, customer_email,
    shipping_address, shipping_area, shipping_city, shipping_district, shipping_postal_code,
    delivery_zone_id, delivery_method, coupon_id, coupon_code, manual_discount,
    delivery_charge, delivery_discount, return_charge,
    customer_note, idempotency_key, utm_source, utm_medium, utm_campaign, created_by
  ) values (
    public.next_order_number(), v_customer.id, v_auth, p_source, 'PENDING', v_payment_method,
    v_name, v_phone, v_email,
    v_address, v_area, v_city, v_district, v_postal,
    (v_quote #>> '{delivery_zone,id}')::uuid, v_quote ->> 'delivery_method', v_coupon_id,
    case when v_coupon_id is not null then upper(v_quote #>> '{coupon,code}') end,
    case when v_is_admin then v_manual_discount else 0 end,
    case when v_is_admin and v_delivery_override is not null then v_delivery_override
         else (v_quote ->> 'delivery_charge')::numeric end,
    case when v_is_admin and v_delivery_override is not null then 0
         else (v_quote ->> 'delivery_discount')::numeric end,
    (v_quote ->> 'return_charge')::numeric,
    nullif(trim(coalesce(p_payload ->> 'customer_note', '')), ''),
    nullif(p_payload ->> 'idempotency_key', ''),
    nullif(p_payload #>> '{utm,source}', ''), nullif(p_payload #>> '{utm,medium}', ''),
    nullif(p_payload #>> '{utm,campaign}', ''),
    case when v_is_admin then auth.uid() end
  ) returning * into v_order;

  for v_line in select * from jsonb_array_elements(v_quote -> 'lines') loop
    insert into public.order_items(
      order_id, product_id, variant_id, product_name, variant_title, sku, image_url, unit_price, unit_cost,
      quantity, line_subtotal, discount_amount, line_total, track_inventory, requires_production
    ) values (
      v_order.id, (v_line ->> 'product_id')::uuid, (v_line ->> 'variant_id')::uuid, v_line ->> 'product_name',
      nullif(v_line ->> 'variant_title', 'Default'), v_line ->> 'sku', v_line ->> 'image_url',
      (v_line ->> 'unit_price')::numeric, (v_line ->> 'unit_cost')::numeric, (v_line ->> 'quantity')::int,
      (v_line ->> 'line_subtotal')::numeric, (v_line ->> 'discount_amount')::numeric,
      (v_line ->> 'line_total')::numeric, (v_line ->> 'track_inventory')::boolean,
      (v_line ->> 'requires_production')::boolean
    ) returning * into v_item;
    perform public._reserve_order_item(v_item, v_order.order_number);
  end loop;

  if v_coupon_id is not null then
    insert into public.coupon_usage(coupon_id, order_id, customer_id, phone, discount_amount)
    values (v_coupon_id, v_order.id, v_customer.id, v_phone, (v_quote ->> 'coupon_discount')::numeric);
    update public.coupons set usage_count = usage_count + 1 where id = v_coupon_id;
  end if;

  -- Remember the address for the customer's next order.
  if not exists (select 1 from public.customer_addresses
                 where customer_id = v_customer.id and lower(address_line) = lower(v_address)
                   and lower(district) = lower(v_district)) then
    insert into public.customer_addresses(customer_id, recipient_name, phone, address_line, area, city,
                                          district, postal_code, is_default)
    values (v_customer.id, v_name, v_phone, v_address, v_area, v_city, v_district, v_postal,
            not exists (select 1 from public.customer_addresses where customer_id = v_customer.id and is_default));
  end if;

  v_order := public.recalculate_order_totals(v_order.id);

  perform public._order_log(v_order.id, 'CREATED',
    case p_source when 'STOREFRONT' then 'Order placed on the storefront' else 'Order created by staff' end,
    null, 'PENDING', jsonb_build_object('source', p_source, 'total', v_order.total_amount), true);
  perform public._order_log(v_order.id, 'STOCK_RESERVED', 'Stock reserved for all tracked items');

  if nullif(trim(coalesce(p_payload ->> 'internal_note', '')), '') is not null then
    insert into public.order_notes(order_id, kind, visibility, body, created_by, created_by_name)
    values (v_order.id, 'NOTE', 'INTERNAL', trim(p_payload ->> 'internal_note'), auth.uid(), public.actor_display_name());
  end if;

  perform public.refresh_customer_stats(v_customer.id);
  perform public._enqueue_order_notification(v_order.id, 'ORDER_CREATED');
  return v_order;
end;
$$;

-- -----------------------------------------------------------------------------
-- Status machine
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

  update public.orders set
    status = p_to,
    confirmed_at = case when p_to = 'CONFIRMED' then coalesce(confirmed_at, now()) else confirmed_at end,
    shipped_at = case when p_to = 'SHIPPED' then coalesce(shipped_at, now()) else shipped_at end,
    delivered_at = case when p_to = 'DELIVERED' then coalesce(delivered_at, now()) else delivered_at end,
    cancelled_at = case when p_to in ('CANCELLED', 'REJECTED_FRAUD') then now() else cancelled_at end,
    returned_at = case when p_to = 'RETURNED' then now() else returned_at end,
    cancel_reason = case when p_to in ('CANCELLED', 'REJECTED_FRAUD') then coalesce(p_note, cancel_reason) else cancel_reason end,
    advance_due_at = case when p_to = 'ADVANCE_REQUIRED'
      then now() + make_interval(hours => public.setting_numeric('orders', array['advance_payment_timeout_hours'], 24)::int)
      else advance_due_at end
  where id = p_order_id
  returning * into v_order;

  perform public._order_log(p_order_id, 'STATUS_CHANGED', p_note, v_from, p_to, p_metadata,
    p_to in ('CONFIRMED', 'ADVANCE_REQUIRED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'RETURNED', 'READY_TO_SHIP'));

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
    perform public._enqueue_order_notification(p_order_id, 'ORDER_SHIPPED');
  elsif p_to = 'DELIVERED' then
    update public.shipments set status = 'DELIVERED', delivered_at = coalesce(delivered_at, now()),
      return_status = 'NONE', updated_at = now()
    where order_id = p_order_id and is_active and status <> 'DELIVERED';
    perform public._post_order_delivery_finance(p_order_id);
    if v_from = 'SHIPPED' then
      perform public._enqueue_order_notification(p_order_id, 'ORDER_DELIVERED');
    end if;
  elsif p_to = 'FAILED_DELIVERY' then
    update public.shipments set status = 'FAILED', updated_at = now()
    where order_id = p_order_id and is_active and status not in ('FAILED', 'RETURNED');
  elsif p_to = 'RETURN_REQUESTED' then
    update public.shipments set return_status = 'REQUESTED', updated_at = now()
    where order_id = p_order_id and is_active and return_status = 'NONE';
  elsif p_to = 'RETURNED' then
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

-- Public entry point (permission-checked).
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
  perform public.require_permission(case when p_to in ('CANCELLED') then 'orders.cancel' else 'orders.status' end);
  select status into v_before from public.orders where id = p_order_id;
  if p_to = 'REJECTED_FRAUD' or (v_before in ('FRAUD_REVIEW', 'REJECTED_FRAUD') and p_to <> 'CANCELLED') then
    perform public.require_permission('fraud.review');
  end if;
  if p_to = 'CONFIRMED' and v_before in ('ADVANCE_REQUIRED', 'FRAUD_REVIEW') then
    perform public.require_permission('fraud.review');
  end if;
  if p_to = 'CANCELLED' and length(trim(coalesce(p_note, ''))) = 0 then
    raise exception 'VALIDATION: a cancellation reason is required' using errcode = '22023';
  end if;
  v_order := public._transition_order(p_order_id, p_to, p_note);
  perform public.log_audit('order.status_changed', 'order', p_order_id::text,
    jsonb_build_object('status', v_before), jsonb_build_object('status', p_to), jsonb_build_object('note', p_note));
  return v_order;
end;
$$;

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

-- Return processing with per-item condition, then RETURNED.
create or replace function public.process_order_return(p_order_id uuid, p_items jsonb, p_note text default null)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
begin
  perform public.require_permission('orders.status');
  select * into v_order from public.orders where id = p_order_id for update;
  if v_order.status not in ('FAILED_DELIVERY', 'RETURN_REQUESTED') then
    raise exception 'INVALID_TRANSITION: only failed deliveries or return requests can be returned' using errcode = 'P0001';
  end if;
  perform public._return_order_stock(p_order_id, p_items, p_note);
  v_order := public._transition_order(p_order_id, 'RETURNED', p_note, jsonb_build_object('items', p_items));
  perform public.log_audit('order.returned', 'order', p_order_id::text, null, p_items, jsonb_build_object('note', p_note));
  return v_order;
end;
$$;

-- -----------------------------------------------------------------------------
-- Admin order operations
-- -----------------------------------------------------------------------------
create or replace function public.admin_create_order(p_payload jsonb, p_confirm boolean default false)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
begin
  perform public.require_permission('orders.create');
  v_order := public._create_order(p_payload, 'ADMIN');
  if p_confirm then
    v_order := public._transition_order(v_order.id, 'CONFIRMED', 'Confirmed by staff when the order was created');
  end if;
  perform public.log_audit('order.created', 'order', v_order.id::text, null,
    jsonb_build_object('order_number', v_order.order_number, 'total', v_order.total_amount));
  return v_order;
end;
$$;

-- Edits customer/shipping/pricing fields. Allowed before shipment only.
-- p_changes keys (all optional): customer_name, customer_phone, customer_email,
-- shipping_address, shipping_area, shipping_city, shipping_district,
-- shipping_postal_code, delivery_charge, manual_discount, payment_method,
-- delivery_method, customer_note
create or replace function public.admin_update_order(p_order_id uuid, p_changes jsonb)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old public.orders;
  v_order public.orders;
  v_phone text;
  v_customer_id uuid;
  v_pattern text := public.setting_text('store', array['phone_pattern'], '^01[3-9][0-9]{8}$');
begin
  perform public.require_permission('orders.update');
  select * into v_old from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'NOT_FOUND: order not found' using errcode = 'P0002';
  end if;
  if not public.order_is_editable(v_old.status) then
    raise exception 'VALIDATION: orders cannot be edited after they ship (status %)', v_old.status using errcode = '22023';
  end if;
  if (p_changes ? 'delivery_charge' or p_changes ? 'manual_discount')
     and not public.has_permission('orders.price_override') and not public.is_system_context() then
    raise exception 'PERMISSION_DENIED: orders.price_override is required to change prices' using errcode = '42501';
  end if;
  if (p_changes ->> 'delivery_charge')::numeric < 0 or (p_changes ->> 'manual_discount')::numeric < 0 then
    raise exception 'VALIDATION: amounts cannot be negative' using errcode = '22023';
  end if;

  v_customer_id := v_old.customer_id;
  if p_changes ? 'customer_phone' then
    v_phone := public.clean_phone(p_changes ->> 'customer_phone');
    if v_phone is null or v_phone !~ v_pattern then
      raise exception 'VALIDATION: enter a valid mobile number' using errcode = '22023';
    end if;
    if v_phone <> v_old.customer_phone then
      -- Changing the phone moves the order to that phone's customer record.
      select id into v_customer_id from public.customers where phone = v_phone;
      if v_customer_id is null then
        insert into public.customers(full_name, phone, email, address, area, city, district)
        values (coalesce(p_changes ->> 'customer_name', v_old.customer_name), v_phone, v_old.customer_email,
                v_old.shipping_address, v_old.shipping_area, v_old.shipping_city, v_old.shipping_district)
        returning id into v_customer_id;
      end if;
    end if;
  end if;

  update public.orders set
    customer_id = v_customer_id,
    customer_name = coalesce(nullif(trim(p_changes ->> 'customer_name'), ''), customer_name),
    customer_phone = coalesce(v_phone, customer_phone),
    customer_email = case when p_changes ? 'customer_email' then nullif(lower(trim(p_changes ->> 'customer_email')), '') else customer_email end,
    shipping_address = coalesce(nullif(trim(p_changes ->> 'shipping_address'), ''), shipping_address),
    shipping_area = case when p_changes ? 'shipping_area' then nullif(trim(p_changes ->> 'shipping_area'), '') else shipping_area end,
    shipping_city = case when p_changes ? 'shipping_city' then nullif(trim(p_changes ->> 'shipping_city'), '') else shipping_city end,
    shipping_district = coalesce(nullif(trim(p_changes ->> 'shipping_district'), ''), shipping_district),
    shipping_postal_code = case when p_changes ? 'shipping_postal_code' then nullif(trim(p_changes ->> 'shipping_postal_code'), '') else shipping_postal_code end,
    delivery_method = coalesce(nullif(p_changes ->> 'delivery_method', ''), delivery_method),
    delivery_charge = coalesce((p_changes ->> 'delivery_charge')::numeric, delivery_charge),
    delivery_discount = case when p_changes ? 'delivery_charge' then 0 else delivery_discount end,
    manual_discount = coalesce((p_changes ->> 'manual_discount')::numeric, manual_discount),
    payment_method = coalesce(nullif(p_changes ->> 'payment_method', '')::public.payment_method, payment_method),
    customer_note = case when p_changes ? 'customer_note' then nullif(trim(p_changes ->> 'customer_note'), '') else customer_note end
  where id = p_order_id;

  v_order := public.recalculate_order_totals(p_order_id);
  if v_order.advance_required > v_order.total_amount then
    update public.orders set advance_required = v_order.total_amount where id = p_order_id returning * into v_order;
  end if;

  perform public._order_log(p_order_id, 'EDITED', 'Order details updated', null, null,
    jsonb_build_object('fields', (select jsonb_agg(k) from jsonb_object_keys(p_changes) k)));
  perform public.log_audit('order.edited', 'order', p_order_id::text,
    (select jsonb_object_agg(k, to_jsonb(v_old) -> k) from jsonb_object_keys(p_changes) k),
    (select jsonb_object_agg(k, to_jsonb(v_order) -> k) from jsonb_object_keys(p_changes) k));
  if v_customer_id <> v_old.customer_id then
    perform public.refresh_customer_stats(v_old.customer_id);
  end if;
  perform public.refresh_customer_stats(v_customer_id);
  return v_order;
end;
$$;

-- Replaces the order's items (add / remove / change quantity / price).
-- Reservations are released and re-made so stock stays exact.
create or replace function public.admin_set_order_items(p_order_id uuid, p_items jsonb)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old public.orders;
  v_quote jsonb;
  v_line jsonb;
  v_item public.order_items;
  v_old_items jsonb;
  v_override boolean := public.has_permission('orders.price_override') or public.is_system_context();
  v_existing public.order_items;
begin
  perform public.require_permission('orders.update');
  select * into v_old from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'NOT_FOUND: order not found' using errcode = 'P0002';
  end if;
  if not public.order_is_editable(v_old.status) then
    raise exception 'VALIDATION: items cannot be changed after the order ships' using errcode = '22023';
  end if;

  select jsonb_agg(jsonb_build_object('sku', sku, 'quantity', quantity, 'unit_price', unit_price))
  into v_old_items from public.order_items where order_id = p_order_id;

  -- Without price-override permission, existing lines keep their price and new
  -- lines get the catalogue price.
  if not v_override then
    p_items := (
      select jsonb_agg(
        case when oi.unit_price is not null
          then (e - 'unit_price') || jsonb_build_object('unit_price', oi.unit_price)
          else e - 'unit_price' end)
      from jsonb_array_elements(p_items) e
      left join lateral (
        select unit_price from public.order_items
        where order_id = p_order_id and variant_id = (e ->> 'variant_id')::uuid limit 1
      ) oi on true
    );
  end if;

  v_quote := public.calculate_order_quote(p_items, v_old.shipping_district, v_old.shipping_area,
    v_old.delivery_method, null, null, true, true);

  perform public._release_order_stock(p_order_id, 'Released: order items edited');
  delete from public.order_items where order_id = p_order_id;

  for v_line in select * from jsonb_array_elements(v_quote -> 'lines') loop
    insert into public.order_items(
      order_id, product_id, variant_id, product_name, variant_title, sku, image_url, unit_price, unit_cost,
      quantity, line_subtotal, discount_amount, line_total, track_inventory, requires_production
    ) values (
      p_order_id, (v_line ->> 'product_id')::uuid, (v_line ->> 'variant_id')::uuid, v_line ->> 'product_name',
      nullif(v_line ->> 'variant_title', 'Default'), v_line ->> 'sku', v_line ->> 'image_url',
      (v_line ->> 'unit_price')::numeric, (v_line ->> 'unit_cost')::numeric, (v_line ->> 'quantity')::int,
      (v_line ->> 'line_subtotal')::numeric, 0, (v_line ->> 'line_subtotal')::numeric,
      (v_line ->> 'track_inventory')::boolean, (v_line ->> 'requires_production')::boolean
    ) returning * into v_item;
    perform public._reserve_order_item(v_item, v_old.order_number);
  end loop;

  perform public.recalculate_order_totals(p_order_id);
  perform public._production_refresh_items(p_order_id);
  perform public._order_log(p_order_id, 'ITEMS_CHANGED', 'Order items updated', null, null,
    jsonb_build_object('before', v_old_items, 'after', v_quote -> 'lines'));
  perform public.log_audit('order.items_changed', 'order', p_order_id::text,
    jsonb_build_object('items', v_old_items, 'total', v_old.total_amount),
    jsonb_build_object('items', p_items));
  select * into v_old from public.orders where id = p_order_id;
  return v_old;
end;
$$;

create or replace function public.admin_duplicate_order(p_order_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_src public.orders;
  v_new public.orders;
begin
  perform public.require_permission('orders.create');
  select * into v_src from public.orders where id = p_order_id;
  if not found then
    raise exception 'NOT_FOUND: order not found' using errcode = 'P0002';
  end if;
  v_new := public._create_order(jsonb_build_object(
    'customer', jsonb_build_object('full_name', v_src.customer_name, 'phone', v_src.customer_phone, 'email', v_src.customer_email),
    'shipping', jsonb_build_object('address', v_src.shipping_address, 'area', v_src.shipping_area,
      'city', v_src.shipping_city, 'district', v_src.shipping_district, 'postal_code', v_src.shipping_postal_code),
    'items', (select jsonb_agg(jsonb_build_object('variant_id', variant_id, 'quantity', quantity, 'unit_price', unit_price))
              from public.order_items where order_id = p_order_id),
    'delivery_method', v_src.delivery_method,
    'payment_method', v_src.payment_method,
    'delivery_charge', v_src.delivery_charge - v_src.delivery_discount,
    'manual_discount', v_src.manual_discount,
    'internal_note', 'Duplicated from ' || v_src.order_number
  ), 'ADMIN');
  perform public.log_audit('order.duplicated', 'order', v_new.id::text, null,
    jsonb_build_object('source_order', v_src.order_number, 'order_number', v_new.order_number));
  return v_new;
end;
$$;

create or replace function public.add_order_note(
  p_order_id uuid,
  p_body text,
  p_visibility public.note_visibility default 'INTERNAL',
  p_kind public.note_kind default 'NOTE'
)
returns public.order_notes
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_note public.order_notes;
begin
  perform public.require_permission('orders.update');
  if length(trim(coalesce(p_body, ''))) = 0 then
    raise exception 'VALIDATION: note cannot be empty' using errcode = '22023';
  end if;
  insert into public.order_notes(order_id, kind, visibility, body, created_by, created_by_name)
  values (p_order_id, p_kind, p_visibility, trim(p_body), auth.uid(), public.actor_display_name())
  returning * into v_note;
  if p_kind = 'CONTACT' then
    perform public._order_log(p_order_id, 'CUSTOMER_CONTACTED', trim(p_body));
  end if;
  return v_note;
end;
$$;

-- -----------------------------------------------------------------------------
-- Payments
-- -----------------------------------------------------------------------------
create or replace function public._order_payment_after_change(p_order_id uuid, p_kind public.order_payment_kind, p_amount numeric)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
begin
  v_order := public.recalculate_order_totals(p_order_id);
  if p_kind <> 'REFUND' and v_order.status = 'ADVANCE_REQUIRED' and v_order.amount_paid >= v_order.advance_required then
    perform public._order_log(p_order_id, 'ADVANCE_RECEIVED',
      format('Advance of %s received', v_order.amount_paid), null, null, '{}'::jsonb, true);
    perform public._enqueue_order_notification(p_order_id, 'ADVANCE_RECEIVED');
    v_order := public._transition_order(p_order_id,
      case when public.setting_bool('orders', array['require_confirmation_after_advance'], false)
           then 'CONFIRMATION_REQUIRED' else 'CONFIRMED' end::public.order_status,
      'Advance payment received');
  end if;
  return v_order;
end;
$$;

-- Turns a verified payment attempt into ledger + finance entries. Idempotent:
-- order_payments.payment_id is unique, so a second call is a no-op.
create or replace function public._settle_payment(p_payment_id uuid, p_amount numeric)
returns public.order_payments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.payments;
  v_order public.orders;
  v_op public.order_payments;
  v_kind public.order_payment_kind;
begin
  select * into v_payment from public.payments where id = p_payment_id for update;
  select * into v_op from public.order_payments where payment_id = p_payment_id;
  if found then
    return v_op;
  end if;
  if v_payment.status in ('FAILED', 'CANCELLED', 'EXPIRED') then
    raise exception 'VALIDATION: payment % is %', v_payment.reference, v_payment.status using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'VALIDATION: paid amount must be positive' using errcode = '22023';
  end if;

  update public.payments set status = 'SUCCEEDED', verified_at = now(), verified_by = auth.uid()
  where id = p_payment_id;

  v_kind := case v_payment.purpose when 'ADVANCE' then 'ADVANCE' when 'FULL' then 'FULL' else 'BALANCE' end;
  insert into public.order_payments(order_id, payment_id, kind, channel, amount, reference, recorded_by, idempotency_key)
  values (v_payment.order_id, p_payment_id, v_kind, v_payment.channel, public.money(p_amount),
          coalesce(v_payment.provider_transaction_id, v_payment.reference), auth.uid(), 'payment:' || p_payment_id)
  returning * into v_op;

  select * into v_order from public.orders where id = v_payment.order_id;
  perform public._post_finance('INCOME',
    case when v_kind = 'ADVANCE' then 'ADVANCE_PAYMENTS' else 'ONLINE_PAYMENTS' end,
    v_op.amount, (now() at time zone public.store_timezone())::date, true, v_order.id, v_order.customer_id, null,
    v_order.order_number, format('%s payment via %s (%s)', initcap(v_kind::text), v_payment.provider, v_op.reference),
    'order_payment:' || v_op.id, v_payment.channel);

  perform public._order_log(v_order.id, 'PAYMENT_RECEIVED',
    format('%s received via %s', v_op.amount, v_payment.provider), null, null,
    jsonb_build_object('payment_id', p_payment_id, 'amount', v_op.amount, 'reference', v_op.reference));
  perform public._order_payment_after_change(v_order.id, v_kind, v_op.amount);
  return v_op;
end;
$$;

-- Creates a payment attempt for the amount currently due (service role only:
-- called by the payments edge function before redirecting to a provider).
create or replace function public.start_order_payment(
  p_order_number text,
  p_phone text,
  p_purpose public.payment_purpose,
  p_provider text,
  p_channel public.payment_channel default 'GATEWAY'
)
returns public.payments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_amount numeric;
  v_payment public.payments;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select * into v_order from public.orders
  where order_number = upper(trim(p_order_number)) and customer_phone = public.clean_phone(p_phone)
  for update;
  if not found then
    raise exception 'NOT_FOUND: order not found' using errcode = 'P0002';
  end if;
  if v_order.status in ('CANCELLED', 'REJECTED_FRAUD', 'RETURNED', 'DELIVERED', 'FAILED_DELIVERY') then
    raise exception 'VALIDATION: this order no longer accepts payments' using errcode = '22023';
  end if;

  v_amount := case p_purpose
    when 'ADVANCE' then v_order.advance_required - v_order.amount_paid
    else v_order.total_amount - v_order.amount_paid end;
  if v_amount <= 0 then
    raise exception 'VALIDATION: nothing is due on this order' using errcode = '22023';
  end if;

  -- Re-use an open attempt with the same provider and amount.
  select * into v_payment from public.payments
  where order_id = v_order.id and provider = p_provider and purpose = p_purpose and status = 'PENDING'
    and amount = public.money(v_amount) and (expires_at is null or expires_at > now())
  order by created_at desc limit 1;
  if found then
    return v_payment;
  end if;

  insert into public.payments(order_id, provider, purpose, amount, currency, channel, payer_phone, expires_at)
  values (v_order.id, p_provider, p_purpose, public.money(v_amount),
          public.setting_text('store', array['currency'], 'BDT'), p_channel, v_order.customer_phone,
          now() + interval '2 hours')
  returning * into v_payment;
  return v_payment;
end;
$$;

create or replace function public.attach_payment_provider_data(
  p_payment_id uuid,
  p_redirect_url text,
  p_metadata jsonb
)
returns public.payments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.payments;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.payments set redirect_url = p_redirect_url, metadata = metadata || coalesce(p_metadata, '{}'::jsonb)
  where id = p_payment_id returning * into v_payment;
  return v_payment;
end;
$$;

-- Webhook / return-URL confirmation after the provider was asked server-side
-- to verify the transaction. Safe to call any number of times per event.
create or replace function public.confirm_payment(
  p_reference text,
  p_provider text,
  p_provider_transaction_id text,
  p_amount numeric,
  p_event_id text,
  p_event_type text,
  p_payload jsonb,
  p_success boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.payments;
  v_event_id uuid;
  v_op public.order_payments;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  select * into v_payment from public.payments where reference = p_reference and provider = p_provider for update;
  if not found then
    raise exception 'NOT_FOUND: payment % not found', p_reference using errcode = 'P0002';
  end if;

  insert into public.payment_events(payment_id, provider, event_id, event_type, payload)
  values (v_payment.id, p_provider, p_event_id, p_event_type, coalesce(p_payload, '{}'::jsonb))
  on conflict (provider, event_id) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    return jsonb_build_object('status', 'duplicate_event', 'payment_status', v_payment.status);
  end if;

  if v_payment.status = 'SUCCEEDED' then
    update public.payment_events set processed_at = now(), result = 'already_succeeded' where id = v_event_id;
    return jsonb_build_object('status', 'already_succeeded', 'payment_status', v_payment.status);
  end if;

  if not p_success then
    update public.payments set status = 'FAILED', failure_reason = coalesce(p_payload ->> 'reason', 'Declined by provider')
    where id = v_payment.id and status in ('PENDING', 'REQUIRES_VERIFICATION');
    update public.payment_events set processed_at = now(), result = 'failed' where id = v_event_id;
    return jsonb_build_object('status', 'failed');
  end if;

  if p_amount is null or public.money(p_amount) < v_payment.amount then
    update public.payments set status = 'REQUIRES_VERIFICATION',
      failure_reason = format('Amount mismatch: expected %s, provider reported %s', v_payment.amount, p_amount),
      provider_transaction_id = coalesce(provider_transaction_id, p_provider_transaction_id)
    where id = v_payment.id;
    update public.payment_events set processed_at = now(), result = 'amount_mismatch' where id = v_event_id;
    return jsonb_build_object('status', 'amount_mismatch');
  end if;

  update public.payments set provider_transaction_id = coalesce(provider_transaction_id, p_provider_transaction_id)
  where id = v_payment.id;
  v_op := public._settle_payment(v_payment.id, least(public.money(p_amount), v_payment.amount));
  update public.payment_events set processed_at = now(), result = 'succeeded' where id = v_event_id;
  return jsonb_build_object('status', 'succeeded', 'order_payment_id', v_op.id);
end;
$$;

-- Customer reports a manual mobile-banking payment (bKash/Nagad/Rocket send
-- money). It is NOT counted until staff verify it against the statement.
create or replace function public.submit_manual_payment(
  p_order_number text,
  p_phone text,
  p_channel public.payment_channel,
  p_sender_phone text,
  p_transaction_id text,
  p_amount numeric
)
returns public.payments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_payment public.payments;
  v_txn text := upper(regexp_replace(coalesce(p_transaction_id, ''), '\s', '', 'g'));
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if v_txn !~ '^[A-Z0-9]{6,30}$' then
    raise exception 'VALIDATION: enter the transaction ID from your payment SMS' using errcode = '22023';
  end if;
  if p_channel not in ('BKASH', 'NAGAD', 'ROCKET', 'BANK_TRANSFER', 'OTHER') then
    raise exception 'VALIDATION: unsupported payment method' using errcode = '22023';
  end if;
  select * into v_order from public.orders
  where order_number = upper(trim(p_order_number)) and customer_phone = public.clean_phone(p_phone);
  if not found then
    raise exception 'NOT_FOUND: order not found' using errcode = 'P0002';
  end if;
  if v_order.status in ('CANCELLED', 'REJECTED_FRAUD', 'RETURNED', 'DELIVERED') then
    raise exception 'VALIDATION: this order no longer accepts payments' using errcode = '22023';
  end if;
  if exists (select 1 from public.payments where provider = 'manual' and provider_transaction_id = v_txn
             and status not in ('FAILED', 'CANCELLED')) then
    raise exception 'DUPLICATE: this transaction ID has already been submitted' using errcode = '23505';
  end if;
  if coalesce(p_amount, 0) <= 0 then
    raise exception 'VALIDATION: enter the amount you sent' using errcode = '22023';
  end if;

  insert into public.payments(order_id, provider, purpose, amount, currency, status, provider_transaction_id,
                              channel, payer_phone, metadata)
  values (v_order.id, 'manual',
          case when v_order.advance_required > v_order.amount_paid and p_amount < v_order.total_amount - v_order.amount_paid
               then 'ADVANCE' else 'FULL' end::public.payment_purpose,
          public.money(p_amount), public.setting_text('store', array['currency'], 'BDT'), 'REQUIRES_VERIFICATION',
          v_txn, p_channel, public.clean_phone(p_sender_phone),
          jsonb_build_object('submitted_at', now()))
  returning * into v_payment;

  perform public._order_log(v_order.id, 'PAYMENT_SUBMITTED',
    format('Customer reported %s %s payment (TrxID %s) — awaiting verification', p_amount, p_channel, v_txn),
    null, null, jsonb_build_object('payment_id', v_payment.id), true);
  return v_payment;
end;
$$;

create or replace function public.verify_manual_payment(p_payment_id uuid, p_approve boolean, p_note text default null)
returns public.payments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.payments;
begin
  perform public.require_permission('payments.verify');
  select * into v_payment from public.payments where id = p_payment_id for update;
  if not found then
    raise exception 'NOT_FOUND: payment not found' using errcode = 'P0002';
  end if;
  if v_payment.status <> 'REQUIRES_VERIFICATION' then
    raise exception 'VALIDATION: payment is % and cannot be verified', v_payment.status using errcode = '22023';
  end if;
  if p_approve then
    perform public._settle_payment(p_payment_id, v_payment.amount);
  else
    update public.payments set status = 'FAILED', failure_reason = coalesce(p_note, 'Rejected during verification'),
      verified_by = auth.uid(), verified_at = now()
    where id = p_payment_id;
    perform public._order_log(v_payment.order_id, 'PAYMENT_REJECTED',
      coalesce(p_note, 'Payment could not be verified'), null, null, jsonb_build_object('payment_id', p_payment_id));
  end if;
  perform public.log_audit(case when p_approve then 'payment.verified' else 'payment.rejected' end,
    'payment', p_payment_id::text, null, jsonb_build_object('amount', v_payment.amount), jsonb_build_object('note', p_note));
  select * into v_payment from public.payments where id = p_payment_id;
  return v_payment;
end;
$$;

-- Staff record money received outside a gateway (cash, bank, mobile banking).
create or replace function public.record_order_payment(
  p_order_id uuid,
  p_kind public.order_payment_kind,
  p_channel public.payment_channel,
  p_amount numeric,
  p_reference text default null,
  p_note text default null,
  p_idempotency_key text default null
)
returns public.order_payments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_op public.order_payments;
begin
  perform public.require_permission('payments.record');
  if p_kind = 'REFUND' then
    raise exception 'VALIDATION: use refund_order for refunds' using errcode = '22023';
  end if;
  if coalesce(p_amount, 0) <= 0 then
    raise exception 'VALIDATION: amount must be positive' using errcode = '22023';
  end if;
  if p_idempotency_key is not null then
    select * into v_op from public.order_payments where idempotency_key = p_idempotency_key;
    if found then
      return v_op;
    end if;
  end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'NOT_FOUND: order not found' using errcode = 'P0002';
  end if;
  if v_order.status in ('CANCELLED', 'REJECTED_FRAUD') then
    raise exception 'VALIDATION: cannot record a payment on a % order', v_order.status using errcode = '22023';
  end if;
  if public.money(p_amount) > v_order.total_amount - v_order.amount_paid then
    raise exception 'VALIDATION: amount exceeds the %s still due', v_order.total_amount - v_order.amount_paid
      using errcode = '22023';
  end if;

  insert into public.order_payments(order_id, kind, channel, amount, reference, note, idempotency_key, recorded_by)
  values (p_order_id, p_kind, p_channel, public.money(p_amount), nullif(trim(coalesce(p_reference, '')), ''),
          nullif(trim(coalesce(p_note, '')), ''), p_idempotency_key, auth.uid())
  returning * into v_op;

  perform public._post_finance('INCOME',
    case p_kind when 'ADVANCE' then 'ADVANCE_PAYMENTS' when 'COD' then 'COD_COLLECTIONS' else 'ONLINE_PAYMENTS' end,
    v_op.amount, (now() at time zone public.store_timezone())::date, true, p_order_id, v_order.customer_id, null,
    v_order.order_number, format('%s payment recorded (%s)', initcap(p_kind::text), p_channel),
    'order_payment:' || v_op.id, p_channel);

  perform public._order_log(p_order_id, 'PAYMENT_RECEIVED',
    format('%s %s payment recorded via %s', v_op.amount, lower(p_kind::text), p_channel), null, null,
    jsonb_build_object('order_payment_id', v_op.id));
  perform public.log_audit('payment.recorded', 'order', p_order_id::text, null,
    jsonb_build_object('kind', p_kind, 'channel', p_channel, 'amount', v_op.amount, 'reference', p_reference));
  perform public._order_payment_after_change(p_order_id, p_kind, v_op.amount);
  return v_op;
end;
$$;

create or replace function public.refund_order(
  p_order_id uuid,
  p_amount numeric,
  p_channel public.payment_channel,
  p_reason text,
  p_idempotency_key text default null
)
returns public.order_payments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_op public.order_payments;
  v_revenue_recognised boolean;
begin
  perform public.require_permission('refunds.manage');
  if coalesce(p_amount, 0) <= 0 then
    raise exception 'VALIDATION: refund amount must be positive' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_reason, ''))) = 0 then
    raise exception 'VALIDATION: a refund reason is required' using errcode = '22023';
  end if;
  if p_idempotency_key is not null then
    select * into v_op from public.order_payments where idempotency_key = p_idempotency_key;
    if found then
      return v_op;
    end if;
  end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'NOT_FOUND: order not found' using errcode = 'P0002';
  end if;
  if public.money(p_amount) > v_order.amount_paid then
    raise exception 'VALIDATION: refund exceeds the % paid on this order', v_order.amount_paid using errcode = '22023';
  end if;
  if v_order.advance_resolution = 'RETAINED' then
    raise exception 'VALIDATION: the advance on this order was retained as income' using errcode = '22023';
  end if;

  insert into public.order_payments(order_id, kind, channel, amount, reference, note, idempotency_key, recorded_by)
  values (p_order_id, 'REFUND', p_channel, public.money(p_amount), null, trim(p_reason), p_idempotency_key, auth.uid())
  returning * into v_op;

  -- Revenue recognised (delivered) -> contra-revenue. Otherwise it is just the
  -- advance going back: cash out, no P&L effect.
  v_revenue_recognised := exists (select 1 from public.finance_transactions
                                  where source_key = 'order:' || p_order_id || ':product_revenue');
  perform public._post_finance('EXPENSE', case when v_revenue_recognised then 'REFUNDS' else 'ADVANCE_REFUNDS' end,
    v_op.amount, (now() at time zone public.store_timezone())::date, true, p_order_id, v_order.customer_id, null,
    v_order.order_number, 'Refund: ' || trim(p_reason), 'order_payment:' || v_op.id, p_channel);

  v_order := public.recalculate_order_totals(p_order_id);
  if v_order.amount_paid <= 0 and v_order.status in ('CANCELLED', 'REJECTED_FRAUD', 'RETURNED', 'FAILED_DELIVERY') then
    update public.orders set advance_resolution = 'REFUNDED' where id = p_order_id;
  end if;
  perform public._order_log(p_order_id, 'REFUNDED', format('Refunded %s: %s', v_op.amount, trim(p_reason)),
    null, null, jsonb_build_object('order_payment_id', v_op.id), true);
  perform public.log_audit('refund.created', 'order', p_order_id::text, null,
    jsonb_build_object('amount', v_op.amount, 'channel', p_channel, 'reason', p_reason));
  return v_op;
end;
$$;

-- When a paid order is cancelled/returned without delivery, the business
-- either refunds the advance (refund_order) or keeps it (this function).
create or replace function public.retain_order_advance(p_order_id uuid, p_note text)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
begin
  perform public.require_permission('refunds.manage');
  select * into v_order from public.orders where id = p_order_id for update;
  if v_order.status not in ('CANCELLED', 'REJECTED_FRAUD', 'RETURNED', 'FAILED_DELIVERY') or v_order.delivered_at is not null then
    raise exception 'VALIDATION: advances can only be retained on undelivered cancelled/returned orders' using errcode = '22023';
  end if;
  if v_order.amount_paid <= 0 or v_order.advance_resolution is not null then
    raise exception 'VALIDATION: there is no unresolved advance on this order' using errcode = '22023';
  end if;
  perform public._post_finance('INCOME', 'RETAINED_ADVANCES', v_order.amount_paid,
    (now() at time zone public.store_timezone())::date, false, p_order_id, v_order.customer_id, null,
    v_order.order_number, coalesce(nullif(trim(p_note), ''), 'Advance retained after cancellation/return'),
    'order:' || p_order_id || ':retained_advance', null);
  update public.orders set advance_resolution = 'RETAINED' where id = p_order_id returning * into v_order;
  perform public._order_log(p_order_id, 'ADVANCE_RETAINED', coalesce(p_note, 'Advance retained'));
  perform public.log_audit('order.advance_retained', 'order', p_order_id::text, null,
    jsonb_build_object('amount', v_order.amount_paid), jsonb_build_object('note', p_note));
  return v_order;
end;
$$;

-- Unpaid advance orders are cancelled after the configured timeout (pg_cron).
create or replace function public.expire_unpaid_advance_orders()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_count int := 0;
begin
  if not public.is_system_context() then
    perform public.require_permission('orders.cancel');
  end if;
  for v_id in
    select id from public.orders
    where status = 'ADVANCE_REQUIRED' and advance_due_at < now() and amount_paid < advance_required
      and not exists (select 1 from public.payments p where p.order_id = orders.id and p.status = 'REQUIRES_VERIFICATION')
    order by advance_due_at
    limit 500
  loop
    perform public._transition_order(v_id, 'CANCELLED', 'Advance payment not received in time');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- Customer-facing reads (never expose fraud/cost fields)
-- -----------------------------------------------------------------------------
create or replace function public._order_public_json(p_order public.orders)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  return jsonb_build_object(
    'id', p_order.id,
    'order_number', p_order.order_number,
    'status', p_order.status,
    'payment_status', p_order.payment_status,
    'payment_method', p_order.payment_method,
    'created_at', p_order.created_at,
    'customer_name', p_order.customer_name,
    'shipping_address', p_order.shipping_address,
    'shipping_area', p_order.shipping_area,
    'shipping_district', p_order.shipping_district,
    'subtotal', p_order.subtotal,
    'discount_total', p_order.discount_total,
    'delivery_charge', p_order.delivery_charge - p_order.delivery_discount,
    'total_amount', p_order.total_amount,
    'advance_required', p_order.advance_required,
    'amount_paid', p_order.amount_paid,
    'amount_due_now', greatest(p_order.advance_required - p_order.amount_paid, 0),
    'cod_amount', p_order.cod_amount,
    'advance_due_at', p_order.advance_due_at,
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
        'product_name', oi.product_name, 'variant_title', oi.variant_title, 'sku', oi.sku,
        'image_url', oi.image_url, 'quantity', oi.quantity, 'unit_price', oi.unit_price,
        'line_total', oi.line_total) order by oi.created_at), '[]'::jsonb)
      from public.order_items oi where oi.order_id = p_order.id),
    'timeline', (select coalesce(jsonb_agg(jsonb_build_object(
        'event', h.event, 'status', h.to_status, 'message', case when h.event = 'STATUS_CHANGED' then null else h.message end,
        'created_at', h.created_at) order by h.created_at), '[]'::jsonb)
      from public.order_status_history h where h.order_id = p_order.id and h.is_customer_visible),
    'shipment', (select jsonb_build_object('courier', c.name, 'tracking_number', s.tracking_number,
        'tracking_url', case when c.tracking_url_template is not null and s.tracking_number is not null
          then replace(c.tracking_url_template, '{tracking}', s.tracking_number) end,
        'status', s.status)
      from public.shipments s join public.couriers c on c.id = s.courier_id
      where s.order_id = p_order.id and s.is_active limit 1),
    'pending_payment_verification', exists (select 1 from public.payments p
      where p.order_id = p_order.id and p.status = 'REQUIRES_VERIFICATION')
  );
end;
$$;

create or replace function public.track_order(p_order_number text, p_phone text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
begin
  select * into v_order from public.orders
  where order_number = upper(trim(coalesce(p_order_number, '')))
    and customer_phone = public.clean_phone(p_phone);
  if not found then
    return null;
  end if;
  return public._order_public_json(v_order);
end;
$$;

create or replace function public.customer_my_orders(p_limit int default 20, p_offset int default 0)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'total', (select count(*) from public.orders where auth_user_id = auth.uid()),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', o.id, 'order_number', o.order_number, 'status', o.status, 'payment_status', o.payment_status,
        'total_amount', o.total_amount, 'created_at', o.created_at,
        'item_count', (select coalesce(sum(quantity), 0) from public.order_items where order_id = o.id)
      ) order by o.created_at desc)
      from (select * from public.orders where auth_user_id = auth.uid()
            order by created_at desc limit least(greatest(p_limit, 1), 100) offset greatest(p_offset, 0)) o
    ), '[]'::jsonb)
  )
  where auth.uid() is not null
$$;

create or replace function public.customer_get_order(p_order_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public._order_public_json(o) from public.orders o
  where o.id = p_order_id and o.auth_user_id = auth.uid() and auth.uid() is not null
$$;

-- -----------------------------------------------------------------------------
-- Admin order search (server-side filtering, sorting and pagination)
-- p_filters: { q, status, statuses[], payment_status, fraud_status, risk_level,
--   source, courier_id, district, date_from, date_to, customer_id, has_due }
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
      'item_count', (select coalesce(sum(quantity), 0) from public.order_items oi where oi.order_id = p.id),
      'courier_name', (select c.name from public.shipments s join public.couriers c on c.id = s.courier_id
                       where s.order_id = p.id and s.is_active limit 1),
      'tracking_number', (select s.tracking_number from public.shipments s where s.order_id = p.id and s.is_active limit 1)
    )) from page p), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

create or replace function public.admin_order_status_counts()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when public.has_permission('orders.view') or public.is_system_context() then
    coalesce((select jsonb_object_agg(status, n) from (
      select status, count(*) as n from public.orders group by status) s), '{}'::jsonb)
  end
$$;

-- -----------------------------------------------------------------------------
-- RLS — staff read via policies; every write goes through the functions above.
-- -----------------------------------------------------------------------------
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_status_transitions enable row level security;
alter table public.order_status_history enable row level security;
alter table public.order_notes enable row level security;
alter table public.stock_reservations enable row level security;
alter table public.payments enable row level security;
alter table public.payment_events enable row level security;
alter table public.order_payments enable row level security;

create policy orders_staff_read on public.orders for select to authenticated
  using ((select public.has_permission('orders.view')));
create policy order_items_staff_read on public.order_items for select to authenticated
  using ((select public.has_permission('orders.view')));
create policy order_status_transitions_read on public.order_status_transitions for select to authenticated
  using ((select public.is_staff()));
create policy order_status_history_staff_read on public.order_status_history for select to authenticated
  using ((select public.has_permission('orders.view')));
create policy order_notes_staff_read on public.order_notes for select to authenticated
  using ((select public.has_permission('orders.view')));
create policy stock_reservations_staff_read on public.stock_reservations for select to authenticated
  using ((select public.has_permission('orders.view')) or (select public.has_permission('inventory.view')));
create policy payments_staff_read on public.payments for select to authenticated
  using ((select public.has_permission('orders.view')) or (select public.has_permission('finance.view')));
create policy payment_events_staff_read on public.payment_events for select to authenticated
  using ((select public.has_permission('finance.view')));
create policy order_payments_staff_read on public.order_payments for select to authenticated
  using ((select public.has_permission('orders.view')) or (select public.has_permission('finance.view')));
