-- =============================================================================
-- 1. Store mode: the business sells through our hosted store, or only through
--    its Shopify / WooCommerce store (orders still arrive here through Sales
--    channels). When the hosted store is switched off, the storefront shows a
--    closed page and the database refuses storefront orders, so a stale tab or
--    a direct API call cannot place one.
-- 2. Product details: short description, extra categories, shipping note,
--    warranty and an internal note (staff only, never sent to the storefront).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Store mode
-- -----------------------------------------------------------------------------
create or replace function public.storefront_mode()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case upper(coalesce(public.get_setting('storefront') ->> 'mode', 'OWN'))
    when 'SHOPIFY' then 'SHOPIFY' when 'WOOCOMMERCE' then 'WOOCOMMERCE' when 'OFF' then 'OFF' else 'OWN' end
$$;

create or replace function public._orders_store_open_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.source = 'STOREFRONT' and public.storefront_mode() <> 'OWN' then
    raise exception 'ORDER_BLOCKED: The online store is closed. Orders are not being taken here right now.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create or replace trigger orders_store_open_guard before insert on public.orders
  for each row execute function public._orders_store_open_guard();

-- Staff switch the mode here (settings.manage); the rest of the storefront
-- setting is kept as it is.
create or replace function public.admin_set_store_mode(p_mode text, p_redirect_url text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mode text := upper(trim(coalesce(p_mode, '')));
  v_url text := nullif(trim(coalesce(p_redirect_url, '')), '');
  v_old jsonb;
  v_new jsonb;
begin
  perform public.require_permission('settings.manage');
  if v_mode not in ('OWN', 'SHOPIFY', 'WOOCOMMERCE', 'OFF') then
    raise exception 'VALIDATION: choose our store, Shopify, WooCommerce or off' using errcode = '22023';
  end if;
  if v_url is not null and v_url !~* '^https://[a-z0-9.-]+\.[a-z]{2,}(/[^\s]*)?$' then
    raise exception 'VALIDATION: the store address must start with https://' using errcode = '22023';
  end if;
  select value into v_old from public.settings where key = 'storefront' for update;
  if v_old is null then
    raise exception 'NOT_FOUND: storefront settings missing' using errcode = 'P0002';
  end if;
  v_new := v_old || jsonb_build_object('mode', v_mode, 'redirect_url', v_url);
  update public.settings set value = v_new, updated_by = auth.uid() where key = 'storefront';
  perform public.log_audit('store.mode', 'setting', 'storefront',
    jsonb_build_object('mode', coalesce(v_old ->> 'mode', 'OWN'), 'redirect_url', v_old ->> 'redirect_url'),
    jsonb_build_object('mode', v_mode, 'redirect_url', v_url));
  return jsonb_build_object('mode', v_mode, 'redirect_url', v_url);
end;
$$;

-- -----------------------------------------------------------------------------
-- Product details
-- -----------------------------------------------------------------------------
alter table public.products add column if not exists short_description text;
alter table public.products add column if not exists shipping_note text;
alter table public.products add column if not exists warranty text;
alter table public.products add column if not exists admin_note text;
-- Extra categories besides the main one. Kept to categories that exist by the
-- save function; reads join categories, so a removed category is simply left out.
alter table public.products add column if not exists extra_category_ids uuid[] not null default '{}';
create index if not exists products_extra_categories_idx on public.products using gin(extra_category_ids);

alter table public.products add constraint products_short_description_len check (short_description is null or length(short_description) <= 600) not valid;
alter table public.products add constraint products_notes_len check (
  coalesce(length(shipping_note), 0) <= 600 and coalesce(length(warranty), 0) <= 2000 and coalesce(length(admin_note), 0) <= 2000) not valid;

-- Saves the product (admin_save_product) and the extra details in one go.
create or replace function public.admin_save_product_full(p_payload jsonb)
returns public.products
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product public.products;
  v_cats uuid[];
begin
  perform public.require_permission('products.manage');
  v_product := public.admin_save_product(p_payload);
  v_cats := coalesce(array(
    select distinct c.id from jsonb_array_elements_text(coalesce(p_payload -> 'extra_category_ids', '[]'::jsonb)) x
    join public.categories c on c.id::text = x
    where c.id is distinct from v_product.category_id), '{}');
  update public.products set
    short_description = nullif(trim(coalesce(p_payload ->> 'short_description', '')), ''),
    shipping_note = nullif(trim(coalesce(p_payload ->> 'shipping_note', '')), ''),
    warranty = nullif(trim(coalesce(p_payload ->> 'warranty', '')), ''),
    admin_note = nullif(trim(coalesce(p_payload ->> 'admin_note', '')), ''),
    extra_category_ids = v_cats
  where id = v_product.id
  returning * into v_product;
  return v_product;
end;
$$;

-- One-field changes from the product list: cost, selling price, active,
-- stock tracking. Prices are set on the product; a product with a single
-- variant clears that variant's own price so the list and the store agree.
create or replace function public.admin_product_quick_update(p_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.products;
  v_single boolean;
begin
  perform public.require_permission('products.manage');
  select * into v_row from public.products where id = p_id for update;
  if not found then
    raise exception 'NOT_FOUND: product not found' using errcode = 'P0002';
  end if;
  if p ? 'cost_price' and ((p ->> 'cost_price') is null or (p ->> 'cost_price')::numeric < 0) then
    raise exception 'VALIDATION: cost price must be zero or more' using errcode = '22023';
  end if;
  if p ? 'price' and ((p ->> 'price') is null or (p ->> 'price')::numeric < 0) then
    raise exception 'VALIDATION: selling price must be zero or more' using errcode = '22023';
  end if;
  v_single := (select count(*) from public.product_variants where product_id = p_id and is_active) = 1;

  update public.products set
    cost_price = case when p ? 'cost_price' then round((p ->> 'cost_price')::numeric, 2) else cost_price end,
    price = case when p ? 'price' then round((p ->> 'price')::numeric, 2) else price end,
    status = case when p ? 'active' then
               case when (p ->> 'active')::boolean then 'ACTIVE'::public.product_status
                    when status = 'ACTIVE' then 'ARCHIVED'::public.product_status else status end
             else status end,
    track_inventory = case when p ? 'track_inventory' then (p ->> 'track_inventory')::boolean else track_inventory end
  where id = p_id returning * into v_row;

  if v_single then
    update public.product_variants set
      cost_price = case when p ? 'cost_price' then null else cost_price end,
      price = case when p ? 'price' then null else price end
    where product_id = p_id and is_active;
  end if;
  return jsonb_build_object('id', v_row.id, 'cost_price', v_row.cost_price, 'price', v_row.price,
                            'status', v_row.status, 'track_inventory', v_row.track_inventory);
end;
$$;

-- Header numbers on the product list.
create or replace function public.admin_product_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('products.view');
  return (
    with v as (
      select p.status, greatest(coalesce(i.on_hand, 0), 0) as qty,
             coalesce(v.price, p.price) as price, coalesce(v.cost_price, p.cost_price, 0) as cost
      from public.products p
      join public.product_variants v on v.product_id = p.id and v.is_active
      left join public.inventory i on i.variant_id = v.id
      where p.track_inventory
    )
    select jsonb_build_object(
      'products', (select count(*) from public.products where status <> 'ARCHIVED'),
      'active', (select count(*) from public.products where status = 'ACTIVE'),
      'inactive', (select count(*) from public.products where status <> 'ACTIVE'),
      'variants', (select count(*) from public.product_variants v join public.products p on p.id = v.product_id
                   where v.is_active and p.status <> 'ARCHIVED'),
      'stock', coalesce((select sum(qty) from v where status <> 'ARCHIVED'), 0),
      'sell_value', coalesce((select sum(qty * price) from v where status <> 'ARCHIVED'), 0),
      'cost_value', coalesce((select sum(qty * cost) from v where status <> 'ARCHIVED'), 0),
      'low_stock', (select count(*) from public.products p where p.status = 'ACTIVE' and p.track_inventory
                    and coalesce((select sum(i.available) from public.product_variants v join public.inventory i on i.variant_id = v.id
                                  where v.product_id = p.id and v.is_active), 0)
                        <= coalesce(p.low_stock_threshold, public.setting_numeric('inventory', array['low_stock_threshold'], 5)))
    )
  );
end;
$$;

-- Storefront: a product shows in its extra categories too, and the product
-- page gets the short description, shipping note and warranty (never the
-- internal note).
create or replace function public.storefront_list_products(p_category text DEFAULT NULL::text, p_search text DEFAULT NULL::text, p_sort text DEFAULT 'newest'::text, p_min_price numeric DEFAULT NULL::numeric, p_max_price numeric DEFAULT NULL::numeric, p_in_stock boolean DEFAULT false, p_tag text DEFAULT NULL::text, p_featured boolean DEFAULT false, p_limit integer DEFAULT 24, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_result jsonb;
  v_q text := nullif(trim(coalesce(p_search, '')), '');
  v_cats uuid[];
begin
  if p_category is not null then
    v_cats := array(select id from public.categories where slug = p_category
                    or parent_id in (select id from public.categories where slug = p_category));
  end if;
  with base as (
    select p.*, coalesce((select min(coalesce(v.price, p.price)) from public.product_variants v
                          where v.product_id = p.id and v.is_active), p.price) as eff_price
    from public.products p
    where p.status = 'ACTIVE'
      and (p_category is null or p.category_id = any(v_cats) or p.extra_category_ids && v_cats)
      and (v_q is null or p.name ilike '%' || v_q || '%' or p.brand ilike '%' || v_q || '%'
           or exists (select 1 from unnest(p.tags) t where t ilike v_q || '%')
           or exists (select 1 from public.product_variants v where v.product_id = p.id and v.is_active and v.sku ilike v_q || '%'))
      and (p_tag is null or p_tag = any(p.tags))
      and (not p_featured or p.is_featured)
  ), filtered as (
    select * from base b
    where (p_min_price is null or b.eff_price >= p_min_price)
      and (p_max_price is null or b.eff_price <= p_max_price)
      and (not p_in_stock or not b.track_inventory or exists (
        select 1 from public.product_variants v join public.inventory inv on inv.variant_id = v.id
        where v.product_id = b.id and v.is_active and inv.available > 0))
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered),
    'items', coalesce((
      select jsonb_agg(public._storefront_product_card(pr) order by x.rn)
      from (
        select f.id, row_number() over (order by
          case when p_sort = 'price_asc' then f.eff_price end asc,
          case when p_sort = 'price_desc' then f.eff_price end desc,
          case when p_sort = 'name' then f.name end asc,
          case when p_sort = 'featured' then f.is_featured end desc,
          f.created_at desc) as rn
        from filtered f
        order by rn
        limit least(greatest(p_limit, 1), 60) offset greatest(p_offset, 0)
      ) x
      join public.products pr on pr.id = x.id
    ), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$function$;

create or replace function public.storefront_get_product(p_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_p public.products;
  v_overselling boolean := public.allow_overselling();
begin
  select * into v_p from public.products where slug = p_slug and status = 'ACTIVE';
  if not found then
    return null;
  end if;
  return public._storefront_product_card(v_p) || jsonb_build_object(
    'description', v_p.description,
    'short_description', v_p.short_description,
    'shipping_note', v_p.shipping_note,
    'warranty', v_p.warranty,
    'sku', v_p.sku,
    'option_names', to_jsonb(v_p.option_names),
    'seo_title', v_p.seo_title,
    'seo_description', v_p.seo_description,
    'track_inventory', v_p.track_inventory,
    'max_quantity', public.setting_numeric('orders', array['max_quantity_per_item'], 50),
    'images', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'url', i.url, 'alt', coalesce(i.alt, v_p.name),
                          'variant_id', i.variant_id) order by i.is_primary desc, i.position)
                        from public.product_images i where i.product_id = v_p.id), '[]'::jsonb),
    'variants', coalesce((select jsonb_agg(jsonb_build_object(
        'id', v.id, 'sku', v.sku, 'title', v.title, 'size', v.size, 'color', v.color,
        'option_values', v.option_values,
        'price', coalesce(v.price, v_p.price),
        'compare_at_price', coalesce(v.compare_at_price, v_p.compare_at_price),
        'available', case when not v_p.track_inventory or v_overselling then null else greatest(coalesce(inv.available, 0), 0) end,
        'in_stock', not v_p.track_inventory or v_overselling or coalesce(inv.available, 0) > 0
      ) order by v.position, v.created_at)
      from public.product_variants v left join public.inventory inv on inv.variant_id = v.id
      where v.product_id = v_p.id and v.is_active), '[]'::jsonb),
    'related', coalesce((select jsonb_agg(public._storefront_product_card(r)) from (
        select * from public.products r
        where r.status = 'ACTIVE' and r.id <> v_p.id
          and (r.category_id = v_p.category_id or r.tags && v_p.tags)
        order by (r.category_id = v_p.category_id) desc, r.created_at desc
        limit 4) r), '[]'::jsonb)
  );
end;
$function$;

revoke all on function public.storefront_mode(), public._orders_store_open_guard(), public.admin_set_store_mode(text, text),
  public.admin_save_product_full(jsonb), public.admin_product_quick_update(uuid, jsonb), public.admin_product_stats()
from public, anon, authenticated;
grant execute on function public.storefront_mode() to anon, authenticated, service_role;
grant execute on function public.admin_set_store_mode(text, text), public.admin_save_product_full(jsonb),
  public.admin_product_quick_update(uuid, jsonb), public.admin_product_stats() to authenticated;
