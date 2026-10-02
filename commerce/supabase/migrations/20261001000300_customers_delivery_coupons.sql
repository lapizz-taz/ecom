-- =============================================================================
-- 0300 · Customers, delivery zones, coupons
-- =============================================================================

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete set null,
  full_name text not null,
  phone text not null unique check (phone ~ '^[0-9]{6,15}$'),
  email text,
  address text,
  area text,
  city text,
  district text,
  segment public.customer_segment not null default 'NEW',
  status public.customer_status not null default 'ACTIVE',
  risk_level public.risk_level,
  last_fraud_score numeric(5,2),
  last_fraud_check_at timestamptz,
  blocked_reason text,
  notes text,
  tags text[] not null default '{}',
  total_orders int not null default 0,
  delivered_orders int not null default 0,
  cancelled_orders int not null default 0,
  returned_orders int not null default 0,
  failed_deliveries int not null default 0,
  total_spent numeric(12,2) not null default 0,
  average_order_value numeric(12,2) not null default 0,
  first_order_at timestamptz,
  last_order_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index customers_name_trgm_idx on public.customers using gin(full_name extensions.gin_trgm_ops);
create index customers_phone_trgm_idx on public.customers using gin(phone extensions.gin_trgm_ops);
create index customers_segment_idx on public.customers(segment);
create index customers_created_idx on public.customers(created_at desc);
create index customers_last_order_idx on public.customers(last_order_at desc nulls last);
create index customers_district_idx on public.customers(lower(district));
create trigger customers_updated_at before update on public.customers
  for each row execute function public.set_updated_at();

create table public.customer_addresses (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  label text,
  recipient_name text not null,
  phone text not null,
  address_line text not null,
  area text,
  city text,
  district text not null,
  postal_code text,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index customer_addresses_customer_idx on public.customer_addresses(customer_id);
create unique index customer_addresses_one_default on public.customer_addresses(customer_id) where is_default;
create trigger customer_addresses_updated_at before update on public.customer_addresses
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Delivery zones (no delivery charge is hard-coded anywhere in the app)
-- -----------------------------------------------------------------------------
create table public.delivery_zones (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  districts text[] not null default '{}',
  areas text[] not null default '{}',
  charge numeric(12,2) not null check (charge >= 0),
  return_charge numeric(12,2) not null default 0 check (return_charge >= 0),
  estimated_days text,
  is_default boolean not null default false,
  is_active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index delivery_zones_one_default on public.delivery_zones((true)) where is_default and is_active;
create index delivery_zones_districts_idx on public.delivery_zones using gin(districts);
create trigger delivery_zones_updated_at before update on public.delivery_zones
  for each row execute function public.set_updated_at();
create trigger delivery_zones_audit after insert or update or delete on public.delivery_zones
  for each row execute function public.audit_row_change();

-- Lower-case district/area lists so matching is case-insensitive.
create or replace function public.normalize_delivery_zone()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.districts := array(select distinct lower(trim(d)) from unnest(new.districts) d where trim(d) <> '');
  new.areas := array(select distinct lower(trim(a)) from unnest(new.areas) a where trim(a) <> '');
  return new;
end;
$$;
create trigger delivery_zones_normalize before insert or update on public.delivery_zones
  for each row execute function public.normalize_delivery_zone();

-- Area match beats district match beats the default zone.
create or replace function public.resolve_delivery_zone(p_district text, p_area text default null)
returns public.delivery_zones
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select z.*
  from public.delivery_zones z
  where z.is_active
    and (
      (p_area is not null and lower(trim(p_area)) = any(z.areas))
      or lower(trim(coalesce(p_district, ''))) = any(z.districts)
      or z.is_default
    )
  order by
    (p_area is not null and lower(trim(p_area)) = any(z.areas)) desc,
    (lower(trim(coalesce(p_district, ''))) = any(z.districts)) desc,
    z.sort_order
  limit 1
$$;

-- Extra charge for a delivery method configured in settings.delivery.methods.
create or replace function public.delivery_method_extra(p_method text)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select (m ->> 'extra_charge')::numeric
    from jsonb_array_elements(coalesce(public.get_setting('delivery') -> 'methods', '[]'::jsonb)) m
    where m ->> 'code' = coalesce(nullif(p_method, ''), 'standard')
      and coalesce((m ->> 'active')::boolean, true)
  ), case when coalesce(nullif(p_method, ''), 'standard') = 'standard' then 0 end)
$$;

-- -----------------------------------------------------------------------------
-- Coupons
-- -----------------------------------------------------------------------------
create table public.coupons (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9_-]{3,32}$'),
  description text,
  discount_type public.discount_type not null,
  discount_value numeric(12,2) not null default 0 check (discount_value >= 0),
  min_order_value numeric(12,2) not null default 0 check (min_order_value >= 0),
  max_discount numeric(12,2) check (max_discount is null or max_discount > 0),
  starts_at timestamptz,
  ends_at timestamptz,
  usage_limit int check (usage_limit is null or usage_limit > 0),
  per_customer_limit int check (per_customer_limit is null or per_customer_limit > 0),
  usage_count int not null default 0,
  is_active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint coupons_percentage_range check (discount_type <> 'PERCENTAGE' or discount_value between 0.01 and 100),
  constraint coupons_dates check (ends_at is null or starts_at is null or ends_at > starts_at)
);
create trigger coupons_updated_at before update on public.coupons
  for each row execute function public.set_updated_at();
create trigger coupons_audit after insert or update or delete on public.coupons
  for each row execute function public.audit_row_change();

create table public.coupon_usage (
  id uuid primary key default gen_random_uuid(),
  coupon_id uuid not null references public.coupons(id),
  order_id uuid not null,
  customer_id uuid references public.customers(id),
  phone text not null,
  discount_amount numeric(12,2) not null default 0,
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (coupon_id, order_id)
);
create index coupon_usage_phone_idx on public.coupon_usage(coupon_id, phone) where voided_at is null;

-- Pure discount maths (no I/O) so it can be unit-tested and reused.
create or replace function public.coupon_discount(
  p_type public.discount_type,
  p_value numeric,
  p_max numeric,
  p_subtotal numeric,
  p_delivery_charge numeric
)
returns table (discount_amount numeric, delivery_discount numeric)
language sql
immutable
set search_path = public, pg_temp
as $$
  select
    case p_type
      when 'PERCENTAGE' then least(public.money(p_subtotal * p_value / 100), coalesce(p_max, 'Infinity'::numeric), p_subtotal)
      when 'FIXED' then least(p_value, p_subtotal)
      else 0
    end,
    case p_type
      when 'FREE_DELIVERY' then least(coalesce(p_delivery_charge, 0), coalesce(p_max, 'Infinity'::numeric))
      else 0
    end
$$;

-- Server-side coupon validation. Never trust a discount from the client.
create or replace function public.evaluate_coupon(
  p_code text,
  p_subtotal numeric,
  p_phone text,
  p_delivery_charge numeric default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_coupon public.coupons;
  v_phone text := public.clean_phone(p_phone);
  v_used int;
  v_disc record;
begin
  if p_code is null or trim(p_code) = '' then
    return jsonb_build_object('valid', false, 'reason', 'EMPTY', 'message', 'Enter a coupon code');
  end if;
  select * into v_coupon from public.coupons where code = upper(trim(p_code));
  if not found or not v_coupon.is_active then
    return jsonb_build_object('valid', false, 'reason', 'NOT_FOUND', 'message', 'This coupon code is not valid');
  end if;
  if v_coupon.starts_at is not null and v_coupon.starts_at > now() then
    return jsonb_build_object('valid', false, 'reason', 'NOT_STARTED', 'message', 'This coupon is not active yet');
  end if;
  if v_coupon.ends_at is not null and v_coupon.ends_at <= now() then
    return jsonb_build_object('valid', false, 'reason', 'EXPIRED', 'message', 'This coupon has expired');
  end if;
  if v_coupon.usage_limit is not null and v_coupon.usage_count >= v_coupon.usage_limit then
    return jsonb_build_object('valid', false, 'reason', 'USAGE_LIMIT', 'message', 'This coupon has reached its usage limit');
  end if;
  if v_coupon.per_customer_limit is not null and v_phone is not null then
    select count(*) into v_used from public.coupon_usage
    where coupon_id = v_coupon.id and phone = v_phone and voided_at is null;
    if v_used >= v_coupon.per_customer_limit then
      return jsonb_build_object('valid', false, 'reason', 'CUSTOMER_LIMIT', 'message', 'You have already used this coupon');
    end if;
  end if;
  if coalesce(p_subtotal, 0) < v_coupon.min_order_value then
    return jsonb_build_object('valid', false, 'reason', 'MIN_ORDER',
      'message', format('Minimum order value for this coupon is %s', v_coupon.min_order_value),
      'min_order_value', v_coupon.min_order_value);
  end if;

  select * into v_disc from public.coupon_discount(
    v_coupon.discount_type, v_coupon.discount_value, v_coupon.max_discount, coalesce(p_subtotal, 0), p_delivery_charge);

  return jsonb_build_object(
    'valid', true,
    'coupon_id', v_coupon.id,
    'code', v_coupon.code,
    'discount_type', v_coupon.discount_type,
    'discount_amount', v_disc.discount_amount,
    'delivery_discount', v_disc.delivery_discount,
    'message', case v_coupon.discount_type when 'FREE_DELIVERY' then 'Free delivery applied' else 'Coupon applied' end
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table public.customers enable row level security;
alter table public.customer_addresses enable row level security;
alter table public.delivery_zones enable row level security;
alter table public.coupons enable row level security;
alter table public.coupon_usage enable row level security;

create policy customers_staff_read on public.customers for select to authenticated
  using ((select public.has_permission('customers.view')));
create policy customers_self_read on public.customers for select to authenticated
  using (auth_user_id = (select auth.uid()));

create policy customer_addresses_staff_read on public.customer_addresses for select to authenticated
  using ((select public.has_permission('customers.view')));
create policy customer_addresses_staff_manage on public.customer_addresses for all to authenticated
  using ((select public.has_permission('customers.manage')))
  with check ((select public.has_permission('customers.manage')));
create policy customer_addresses_self on public.customer_addresses for all to authenticated
  using (customer_id in (select id from public.customers where auth_user_id = (select auth.uid())))
  with check (customer_id in (select id from public.customers where auth_user_id = (select auth.uid())));

create policy delivery_zones_public_read on public.delivery_zones for select to anon, authenticated
  using (is_active or (select public.is_staff()));
create policy delivery_zones_manage on public.delivery_zones for all to authenticated
  using ((select public.has_permission('settings.manage')))
  with check ((select public.has_permission('settings.manage')));

create policy coupons_staff_read on public.coupons for select to authenticated
  using ((select public.has_permission('coupons.manage')) or (select public.has_permission('marketing.view')));
create policy coupons_manage on public.coupons for all to authenticated
  using ((select public.has_permission('coupons.manage')))
  with check ((select public.has_permission('coupons.manage')));

create policy coupon_usage_staff_read on public.coupon_usage for select to authenticated
  using ((select public.has_permission('coupons.manage')) or (select public.has_permission('orders.view')));
