-- =============================================================================
-- 0200 · Catalog (categories, products, variants, images) and inventory ledger
-- =============================================================================

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description text,
  parent_id uuid references public.categories(id) on delete set null,
  image_url text,
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index categories_parent_idx on public.categories(parent_id);
create trigger categories_updated_at before update on public.categories
  for each row execute function public.set_updated_at();

create table public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  sku text unique,
  description text,
  category_id uuid references public.categories(id) on delete set null,
  brand text,
  tags text[] not null default '{}',
  status public.product_status not null default 'DRAFT',
  option_names text[] not null default '{}',
  cost_price numeric(12,2) not null default 0 check (cost_price >= 0),
  price numeric(12,2) not null check (price >= 0),
  compare_at_price numeric(12,2) check (compare_at_price is null or compare_at_price >= 0),
  weight_grams int check (weight_grams is null or weight_grams >= 0),
  low_stock_threshold int check (low_stock_threshold is null or low_stock_threshold >= 0),
  track_inventory boolean not null default true,
  requires_production boolean not null default false,
  is_featured boolean not null default false,
  seo_title text,
  seo_description text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index products_category_idx on public.products(category_id);
create index products_status_idx on public.products(status);
create index products_created_idx on public.products(created_at desc);
create index products_tags_idx on public.products using gin(tags);
create index products_name_trgm_idx on public.products using gin(name extensions.gin_trgm_ops);
create trigger products_updated_at before update on public.products
  for each row execute function public.set_updated_at();
create trigger products_audit after insert or update or delete on public.products
  for each row execute function public.audit_row_change();

create table public.product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  sku text not null unique check (length(trim(sku)) > 0),
  title text not null default 'Default',
  size text,
  color text,
  option_values jsonb not null default '{}'::jsonb check (jsonb_typeof(option_values) = 'object'),
  price numeric(12,2) check (price is null or price >= 0),
  compare_at_price numeric(12,2) check (compare_at_price is null or compare_at_price >= 0),
  cost_price numeric(12,2) check (cost_price is null or cost_price >= 0),
  weight_grams int check (weight_grams is null or weight_grams >= 0),
  barcode text,
  position int not null default 0,
  is_default boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index product_variants_product_idx on public.product_variants(product_id);
create index product_variants_sku_trgm_idx on public.product_variants using gin(sku extensions.gin_trgm_ops);
create trigger product_variants_updated_at before update on public.product_variants
  for each row execute function public.set_updated_at();
create trigger product_variants_audit after insert or update or delete on public.product_variants
  for each row execute function public.audit_row_change();

create table public.product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  variant_id uuid references public.product_variants(id) on delete set null,
  storage_path text,
  url text not null,
  alt text,
  position int not null default 0,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index product_images_product_idx on public.product_images(product_id, position);
create unique index product_images_one_primary on public.product_images(product_id) where is_primary;
create trigger product_images_updated_at before update on public.product_images
  for each row execute function public.set_updated_at();

-- Effective selling / cost price of a variant (variant overrides product).
create or replace function public.variant_price(p_variant_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(v.price, p.price)
  from public.product_variants v join public.products p on p.id = v.product_id
  where v.id = p_variant_id
$$;

create or replace function public.variant_cost(p_variant_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(v.cost_price, p.cost_price, 0)
  from public.product_variants v join public.products p on p.id = v.product_id
  where v.id = p_variant_id
$$;

-- -----------------------------------------------------------------------------
-- Inventory: one row per variant. available = on_hand - reserved.
-- Rows are only changed through _apply_inventory_movement(), which writes the
-- matching inventory_movements entry in the same transaction.
-- -----------------------------------------------------------------------------
create table public.inventory (
  variant_id uuid primary key references public.product_variants(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  on_hand int not null default 0,
  reserved int not null default 0 check (reserved >= 0),
  damaged int not null default 0 check (damaged >= 0),
  available int generated always as (on_hand - reserved) stored,
  updated_at timestamptz not null default now()
);
create index inventory_product_idx on public.inventory(product_id);
create index inventory_available_idx on public.inventory(available);

create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id),
  variant_id uuid not null references public.product_variants(id),
  movement_type public.inventory_movement_type not null,
  quantity int not null check (quantity > 0),
  on_hand_change int not null default 0,
  reserved_change int not null default 0,
  damaged_change int not null default 0,
  on_hand_after int not null,
  reserved_after int not null,
  damaged_after int not null,
  unit_cost numeric(12,2),
  reference_type text,
  reference_id uuid,
  reference_label text,
  note text,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index inventory_movements_variant_idx on public.inventory_movements(variant_id, created_at desc);
create index inventory_movements_product_idx on public.inventory_movements(product_id, created_at desc);
create index inventory_movements_type_idx on public.inventory_movements(movement_type, created_at desc);
create index inventory_movements_reference_idx on public.inventory_movements(reference_type, reference_id);
create index inventory_movements_created_idx on public.inventory_movements(created_at desc);
create trigger inventory_movements_immutable before update or delete on public.inventory_movements
  for each row execute function public.prevent_mutation();

create or replace function public.ensure_inventory_row()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.inventory(variant_id, product_id) values (new.id, new.product_id)
  on conflict (variant_id) do nothing;
  return new;
end;
$$;
create trigger product_variants_inventory after insert on public.product_variants
  for each row execute function public.ensure_inventory_row();

create or replace function public.allow_overselling()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.setting_bool('inventory', array['allow_overselling'], false)
$$;

-- The single choke point for stock changes.
create or replace function public._apply_inventory_movement(
  p_variant_id uuid,
  p_type public.inventory_movement_type,
  p_on_hand_delta int,
  p_reserved_delta int,
  p_damaged_delta int,
  p_reference_type text,
  p_reference_id uuid,
  p_reference_label text,
  p_note text,
  p_unit_cost numeric default null,
  p_allow_negative boolean default false
)
returns public.inventory_movements
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inv public.inventory;
  v_mov public.inventory_movements;
  v_qty int;
begin
  if coalesce(p_on_hand_delta, 0) = 0 and coalesce(p_reserved_delta, 0) = 0 and coalesce(p_damaged_delta, 0) = 0 then
    raise exception 'VALIDATION: stock movement without a quantity' using errcode = '22023';
  end if;

  insert into public.inventory(variant_id, product_id)
  select v.id, v.product_id from public.product_variants v where v.id = p_variant_id
  on conflict (variant_id) do nothing;

  select * into v_inv from public.inventory where variant_id = p_variant_id for update;
  if not found then
    raise exception 'NOT_FOUND: variant % does not exist', p_variant_id using errcode = 'P0002';
  end if;

  if v_inv.on_hand + p_on_hand_delta < 0 and not (p_allow_negative or public.allow_overselling()) then
    raise exception 'INSUFFICIENT_STOCK: physical stock cannot go below zero' using errcode = 'P0001';
  end if;
  if v_inv.reserved + p_reserved_delta < 0 then
    raise exception 'VALIDATION: reserved stock cannot go below zero' using errcode = '22023';
  end if;
  if v_inv.damaged + p_damaged_delta < 0 then
    raise exception 'VALIDATION: damaged stock cannot go below zero' using errcode = '22023';
  end if;

  update public.inventory
  set on_hand = on_hand + p_on_hand_delta,
      reserved = reserved + p_reserved_delta,
      damaged = damaged + p_damaged_delta,
      updated_at = now()
  where variant_id = p_variant_id
  returning * into v_inv;

  v_qty := greatest(abs(p_on_hand_delta), abs(p_reserved_delta), abs(p_damaged_delta));

  insert into public.inventory_movements(
    product_id, variant_id, movement_type, quantity, on_hand_change, reserved_change, damaged_change,
    on_hand_after, reserved_after, damaged_after, unit_cost, reference_type, reference_id, reference_label,
    note, created_by
  ) values (
    v_inv.product_id, p_variant_id, p_type, v_qty, p_on_hand_delta, p_reserved_delta, p_damaged_delta,
    v_inv.on_hand, v_inv.reserved, v_inv.damaged, p_unit_cost, p_reference_type, p_reference_id,
    p_reference_label, p_note, auth.uid()
  ) returning * into v_mov;

  return v_mov;
end;
$$;

-- Manual stock operations from the admin (Adjust Stock dialog).
--   ADJUSTMENT + mode ADD/REMOVE/SET  -> sellable stock correction
--   PURCHASE                          -> stock received outside a purchase order
--   DAMAGE                            -> sellable -> damaged
--   LOSS                              -> sellable stock lost/stolen
--   TRANSFER                          -> damaged -> sellable (repaired)
create or replace function public.adjust_stock(
  p_variant_id uuid,
  p_type public.inventory_movement_type,
  p_quantity int,
  p_note text,
  p_mode text default 'ADD',
  p_unit_cost numeric default null
)
returns public.inventory_movements
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inv public.inventory;
  v_delta int;
  v_mov public.inventory_movements;
begin
  perform public.require_permission('inventory.adjust');
  if p_quantity is null or p_quantity < 0 or (p_quantity = 0 and upper(coalesce(p_mode, '')) <> 'SET') then
    raise exception 'VALIDATION: quantity must be a positive number' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_note, ''))) = 0 then
    raise exception 'VALIDATION: a reason/note is required for stock adjustments' using errcode = '22023';
  end if;

  select * into v_inv from public.inventory where variant_id = p_variant_id for update;
  if not found then
    raise exception 'NOT_FOUND: variant % has no inventory record', p_variant_id using errcode = 'P0002';
  end if;

  case p_type
    when 'ADJUSTMENT' then
      v_delta := case upper(p_mode)
        when 'ADD' then p_quantity
        when 'REMOVE' then -p_quantity
        when 'SET' then p_quantity - v_inv.on_hand
        else null end;
      if v_delta is null then
        raise exception 'VALIDATION: mode must be ADD, REMOVE or SET' using errcode = '22023';
      end if;
      if v_delta = 0 then
        raise exception 'VALIDATION: stock is already %', p_quantity using errcode = '22023';
      end if;
      if v_delta < 0 and v_inv.available + v_delta < 0 and not public.allow_overselling() then
        raise exception 'INSUFFICIENT_STOCK: only % available (% reserved for orders)', v_inv.available, v_inv.reserved
          using errcode = 'P0001';
      end if;
      v_mov := public._apply_inventory_movement(p_variant_id, 'ADJUSTMENT', v_delta, 0, 0, 'ADJUSTMENT', null, null, p_note, p_unit_cost);
    when 'PURCHASE' then
      v_mov := public._apply_inventory_movement(p_variant_id, 'PURCHASE', p_quantity, 0, 0, 'ADJUSTMENT', null, null, p_note, p_unit_cost);
    when 'DAMAGE' then
      if v_inv.available - p_quantity < 0 and not public.allow_overselling() then
        raise exception 'INSUFFICIENT_STOCK: only % available', v_inv.available using errcode = 'P0001';
      end if;
      v_mov := public._apply_inventory_movement(p_variant_id, 'DAMAGE', -p_quantity, 0, p_quantity, 'ADJUSTMENT', null, null, p_note);
    when 'LOSS' then
      if v_inv.available - p_quantity < 0 and not public.allow_overselling() then
        raise exception 'INSUFFICIENT_STOCK: only % available', v_inv.available using errcode = 'P0001';
      end if;
      v_mov := public._apply_inventory_movement(p_variant_id, 'LOSS', -p_quantity, 0, 0, 'ADJUSTMENT', null, null, p_note);
    when 'TRANSFER' then
      v_mov := public._apply_inventory_movement(p_variant_id, 'TRANSFER', p_quantity, 0, -p_quantity, 'ADJUSTMENT', null, null, p_note);
    else
      raise exception 'VALIDATION: % cannot be recorded manually', p_type using errcode = '22023';
  end case;

  perform public.log_audit('stock.adjusted', 'product_variant', p_variant_id::text,
    jsonb_build_object('on_hand', v_inv.on_hand, 'damaged', v_inv.damaged),
    jsonb_build_object('on_hand', v_mov.on_hand_after, 'damaged', v_mov.damaged_after),
    jsonb_build_object('type', p_type, 'mode', p_mode, 'quantity', p_quantity, 'note', p_note, 'movement_id', v_mov.id));
  return v_mov;
end;
$$;

-- -----------------------------------------------------------------------------
-- Atomic product save: product + variants (+ opening stock) in one call.
-- payload: { id?, name, slug?, sku?, description, category_id, brand, tags[],
--   status, option_names[], cost_price, price, compare_at_price, weight_grams,
--   low_stock_threshold, track_inventory, requires_production, is_featured,
--   seo_title, seo_description,
--   variants: [{ id?, sku, title, size, color, option_values, price, compare_at_price,
--                cost_price, weight_grams, barcode, position, is_active, initial_stock }] }
-- Variants omitted from the payload are deactivated (never deleted: history).
-- -----------------------------------------------------------------------------
create or replace function public.admin_save_product(p_payload jsonb)
returns public.products
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product public.products;
  v_id uuid := nullif(p_payload ->> 'id', '')::uuid;
  v_slug text;
  v_variant jsonb;
  v_variant_id uuid;
  v_keep uuid[] := '{}';
  v_initial int;
  v_pos int := 0;
  v_variants jsonb := coalesce(p_payload -> 'variants', '[]'::jsonb);
begin
  perform public.require_permission('products.manage');

  if length(trim(coalesce(p_payload ->> 'name', ''))) = 0 then
    raise exception 'VALIDATION: product name is required' using errcode = '22023';
  end if;
  if (p_payload ->> 'price') is null or (p_payload ->> 'price')::numeric < 0 then
    raise exception 'VALIDATION: price must be zero or more' using errcode = '22023';
  end if;
  v_slug := coalesce(nullif(public.slugify(p_payload ->> 'slug'), ''), public.slugify(p_payload ->> 'name'));
  if v_slug = '' then
    raise exception 'VALIDATION: product slug is required' using errcode = '22023';
  end if;

  if v_id is null then
    insert into public.products(
      name, slug, sku, description, category_id, brand, tags, status, option_names, cost_price, price,
      compare_at_price, weight_grams, low_stock_threshold, track_inventory, requires_production, is_featured,
      seo_title, seo_description, created_by
    ) values (
      trim(p_payload ->> 'name'), v_slug, nullif(trim(p_payload ->> 'sku'), ''), p_payload ->> 'description',
      nullif(p_payload ->> 'category_id', '')::uuid, nullif(p_payload ->> 'brand', ''),
      coalesce(array(select jsonb_array_elements_text(coalesce(p_payload -> 'tags', '[]'::jsonb))), '{}'),
      coalesce(nullif(p_payload ->> 'status', '')::public.product_status, 'DRAFT'),
      coalesce(array(select jsonb_array_elements_text(coalesce(p_payload -> 'option_names', '[]'::jsonb))), '{}'),
      coalesce((p_payload ->> 'cost_price')::numeric, 0), (p_payload ->> 'price')::numeric,
      nullif(p_payload ->> 'compare_at_price', '')::numeric, nullif(p_payload ->> 'weight_grams', '')::int,
      nullif(p_payload ->> 'low_stock_threshold', '')::int,
      coalesce((p_payload ->> 'track_inventory')::boolean, true),
      coalesce((p_payload ->> 'requires_production')::boolean, false),
      coalesce((p_payload ->> 'is_featured')::boolean, false),
      nullif(p_payload ->> 'seo_title', ''), nullif(p_payload ->> 'seo_description', ''), auth.uid()
    ) returning * into v_product;
  else
    update public.products set
      name = trim(p_payload ->> 'name'),
      slug = v_slug,
      sku = nullif(trim(p_payload ->> 'sku'), ''),
      description = p_payload ->> 'description',
      category_id = nullif(p_payload ->> 'category_id', '')::uuid,
      brand = nullif(p_payload ->> 'brand', ''),
      tags = coalesce(array(select jsonb_array_elements_text(coalesce(p_payload -> 'tags', '[]'::jsonb))), '{}'),
      status = coalesce(nullif(p_payload ->> 'status', '')::public.product_status, status),
      option_names = coalesce(array(select jsonb_array_elements_text(coalesce(p_payload -> 'option_names', '[]'::jsonb))), '{}'),
      cost_price = coalesce((p_payload ->> 'cost_price')::numeric, 0),
      price = (p_payload ->> 'price')::numeric,
      compare_at_price = nullif(p_payload ->> 'compare_at_price', '')::numeric,
      weight_grams = nullif(p_payload ->> 'weight_grams', '')::int,
      low_stock_threshold = nullif(p_payload ->> 'low_stock_threshold', '')::int,
      track_inventory = coalesce((p_payload ->> 'track_inventory')::boolean, track_inventory),
      requires_production = coalesce((p_payload ->> 'requires_production')::boolean, requires_production),
      is_featured = coalesce((p_payload ->> 'is_featured')::boolean, is_featured),
      seo_title = nullif(p_payload ->> 'seo_title', ''),
      seo_description = nullif(p_payload ->> 'seo_description', '')
    where id = v_id
    returning * into v_product;
    if not found then
      raise exception 'NOT_FOUND: product % does not exist', v_id using errcode = 'P0002';
    end if;
  end if;

  -- A product always has at least one variant (the "Default" variant).
  if jsonb_array_length(v_variants) = 0 then
    if exists (select 1 from public.product_variants where product_id = v_product.id) then
      v_variants := (
        select jsonb_agg(jsonb_build_object('id', id, 'sku', sku, 'title', title, 'is_active', is_active))
        from public.product_variants where product_id = v_product.id and is_default
      );
    end if;
    if v_variants is null or jsonb_array_length(v_variants) = 0 then
      v_variants := jsonb_build_array(jsonb_build_object(
        'sku', coalesce(v_product.sku, upper(left(v_product.slug, 24)) || '-' || left(v_product.id::text, 6)),
        'title', 'Default'
      ));
    end if;
  end if;

  for v_variant in select * from jsonb_array_elements(v_variants) loop
    v_variant_id := nullif(v_variant ->> 'id', '')::uuid;
    if length(trim(coalesce(v_variant ->> 'sku', ''))) = 0 then
      raise exception 'VALIDATION: every variant needs a SKU' using errcode = '22023';
    end if;
    if v_variant_id is null then
      insert into public.product_variants(
        product_id, sku, title, size, color, option_values, price, compare_at_price, cost_price,
        weight_grams, barcode, position, is_default, is_active
      ) values (
        v_product.id, trim(v_variant ->> 'sku'), coalesce(nullif(trim(v_variant ->> 'title'), ''), 'Default'),
        nullif(v_variant ->> 'size', ''), nullif(v_variant ->> 'color', ''),
        coalesce(v_variant -> 'option_values', '{}'::jsonb),
        nullif(v_variant ->> 'price', '')::numeric, nullif(v_variant ->> 'compare_at_price', '')::numeric,
        nullif(v_variant ->> 'cost_price', '')::numeric, nullif(v_variant ->> 'weight_grams', '')::int,
        nullif(v_variant ->> 'barcode', ''), coalesce((v_variant ->> 'position')::int, v_pos),
        v_pos = 0, coalesce((v_variant ->> 'is_active')::boolean, true)
      ) returning id into v_variant_id;

      v_initial := coalesce(nullif(v_variant ->> 'initial_stock', '')::int, 0);
      if v_initial < 0 then
        raise exception 'VALIDATION: opening stock cannot be negative' using errcode = '22023';
      end if;
      if v_initial > 0 then
        perform public._apply_inventory_movement(v_variant_id, 'ADJUSTMENT', v_initial, 0, 0,
          'ADJUSTMENT', null, null, 'Opening stock', public.variant_cost(v_variant_id));
      end if;
    else
      update public.product_variants set
        sku = trim(v_variant ->> 'sku'),
        title = coalesce(nullif(trim(v_variant ->> 'title'), ''), title),
        size = nullif(v_variant ->> 'size', ''),
        color = nullif(v_variant ->> 'color', ''),
        option_values = coalesce(v_variant -> 'option_values', option_values),
        price = nullif(v_variant ->> 'price', '')::numeric,
        compare_at_price = nullif(v_variant ->> 'compare_at_price', '')::numeric,
        cost_price = nullif(v_variant ->> 'cost_price', '')::numeric,
        weight_grams = nullif(v_variant ->> 'weight_grams', '')::int,
        barcode = nullif(v_variant ->> 'barcode', ''),
        position = coalesce((v_variant ->> 'position')::int, v_pos),
        is_active = coalesce((v_variant ->> 'is_active')::boolean, true)
      where id = v_variant_id and product_id = v_product.id;
      if not found then
        raise exception 'NOT_FOUND: variant % does not belong to this product', v_variant_id using errcode = 'P0002';
      end if;
    end if;
    v_keep := v_keep || v_variant_id;
    v_pos := v_pos + 1;
  end loop;

  update public.product_variants set is_active = false
  where product_id = v_product.id and not (id = any(v_keep)) and is_active;

  -- Exactly one default variant: the first kept one.
  update public.product_variants set is_default = (id = v_keep[1]) where product_id = v_product.id;

  return v_product;
end;
$$;

-- -----------------------------------------------------------------------------
-- Inventory overview (low stock / out of stock) — security_invoker so RLS of
-- the underlying tables applies.
-- -----------------------------------------------------------------------------
create or replace view public.inventory_overview
with (security_invoker = true) as
select
  v.id as variant_id,
  p.id as product_id,
  p.name as product_name,
  p.slug as product_slug,
  p.status as product_status,
  p.track_inventory,
  c.name as category_name,
  v.sku,
  v.title as variant_title,
  v.is_active as variant_active,
  coalesce(v.cost_price, p.cost_price) as unit_cost,
  coalesce(v.price, p.price) as unit_price,
  i.on_hand,
  i.reserved,
  i.available,
  i.damaged,
  coalesce(p.low_stock_threshold, public.setting_numeric('inventory', array['low_stock_threshold'], 5)::int) as low_stock_threshold,
  case
    when not p.track_inventory then 'UNTRACKED'
    when i.available <= 0 then 'OUT_OF_STOCK'
    when i.available <= coalesce(p.low_stock_threshold, public.setting_numeric('inventory', array['low_stock_threshold'], 5)::int) then 'LOW_STOCK'
    else 'IN_STOCK'
  end as stock_status,
  round(i.on_hand * coalesce(v.cost_price, p.cost_price), 2) as stock_value,
  i.updated_at
from public.product_variants v
join public.products p on p.id = v.product_id
join public.inventory i on i.variant_id = v.id
left join public.categories c on c.id = p.category_id;

-- -----------------------------------------------------------------------------
-- RLS — staff read the catalog directly; the storefront uses the
-- storefront_* functions (which never expose cost prices).
-- -----------------------------------------------------------------------------
alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.product_variants enable row level security;
alter table public.product_images enable row level security;
alter table public.inventory enable row level security;
alter table public.inventory_movements enable row level security;

create policy categories_staff_read on public.categories for select to authenticated
  using ((select public.is_staff()));
create policy categories_manage on public.categories for all to authenticated
  using ((select public.has_permission('products.manage')))
  with check ((select public.has_permission('products.manage')));

create policy products_staff_read on public.products for select to authenticated
  using ((select public.is_staff()));
create policy products_manage_update on public.products for update to authenticated
  using ((select public.has_permission('products.manage')))
  with check ((select public.has_permission('products.manage')));
create policy products_manage_delete on public.products for delete to authenticated
  using ((select public.has_permission('products.manage')));

create policy product_variants_staff_read on public.product_variants for select to authenticated
  using ((select public.is_staff()));

create policy product_images_staff_read on public.product_images for select to authenticated
  using ((select public.is_staff()));
create policy product_images_manage on public.product_images for all to authenticated
  using ((select public.has_permission('products.manage')))
  with check ((select public.has_permission('products.manage')));

create policy inventory_staff_read on public.inventory for select to authenticated
  using ((select public.has_permission('inventory.view')) or (select public.has_permission('products.view')));
create policy inventory_movements_read on public.inventory_movements for select to authenticated
  using ((select public.has_permission('inventory.view')));
