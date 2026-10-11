-- external-api part 4 of 5: run the parts in order
create or replace function public.api_products(p_key uuid, p jsonb default '{}')
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit int := least(greatest(coalesce((p ->> 'limit')::int, 50), 1), 100);
  v_offset int := greatest(coalesce((p ->> 'offset')::int, 0), 0);
  v_search text := nullif(trim(coalesce(p ->> 'search', '')), '');
  v_rows jsonb;
  v_total bigint;
begin
  perform public._api_require(p_key, 'products:read');
  select count(*) into v_total from public.products pr where v_search is null or pr.name ilike '%' || v_search || '%' or pr.sku ilike v_search || '%';
  select coalesce(jsonb_agg(x.j order by x.updated_at desc), '[]'::jsonb) into v_rows from (
    select pr.updated_at, jsonb_build_object('id', pr.id, 'name', pr.name, 'slug', pr.slug, 'sku', pr.sku, 'status', pr.status, 'price', pr.price,
      'compare_at_price', pr.compare_at_price, 'brand', pr.brand, 'tags', to_jsonb(coalesce(pr.tags, '{}')), 'updated_at', pr.updated_at,
      'variants', coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'sku', v.sku, 'title', v.title, 'price', coalesce(v.price, pr.price), 'barcode', v.barcode,
          'active', v.is_active, 'available', i.available, 'on_hand', i.on_hand) order by v.position, v.created_at)
        from public.product_variants v left join public.inventory i on i.variant_id = v.id where v.product_id = pr.id), '[]'::jsonb)) j
    from public.products pr where v_search is null or pr.name ilike '%' || v_search || '%' or pr.sku ilike v_search || '%'
    order by pr.updated_at desc, pr.id limit v_limit offset v_offset) x;
  return jsonb_build_object('data', v_rows, 'total', v_total, 'limit', v_limit, 'offset', v_offset);
end;
$$;
create or replace function public.api_inventory(p_key uuid, p jsonb default '{}')
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit int := least(greatest(coalesce((p ->> 'limit')::int, 100), 1), 500);
  v_offset int := greatest(coalesce((p ->> 'offset')::int, 0), 0);
  v_sku text := nullif(trim(coalesce(p ->> 'sku', '')), '');
begin
  perform public._api_require(p_key, 'inventory:read');
  return jsonb_build_object('data', coalesce((select jsonb_agg(x.j order by x.sku) from (
      select v.sku, jsonb_build_object('sku', v.sku, 'variant_id', v.id, 'product', pr.name, 'variant', v.title,
        'on_hand', i.on_hand, 'reserved', i.reserved, 'available', i.available, 'damaged', i.damaged, 'updated_at', i.updated_at) j
      from public.product_variants v join public.products pr on pr.id = v.product_id join public.inventory i on i.variant_id = v.id
      where v_sku is null or v.sku = v_sku
      order by v.sku limit v_limit offset v_offset) x), '[]'::jsonb), 'limit', v_limit, 'offset', v_offset);
end;
$$;
create or replace function public.api_inventory_adjust(p_key uuid, p_sku text, p_mode text, p_quantity int, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_variant uuid;
  v_name text;
  v_inv public.inventory;
begin
  perform public._api_require(p_key, 'inventory:write');
  select id into v_variant from public.product_variants where sku = trim(coalesce(p_sku, ''));
  if v_variant is null then
    raise exception 'NOT_FOUND: no product with SKU %', p_sku using errcode = 'P0002';
  end if;
  if upper(coalesce(p_mode, '')) not in ('SET', 'ADD', 'REMOVE') then
    raise exception 'VALIDATION: mode must be set, add or remove' using errcode = '22023';
  end if;
  select name into v_name from public.api_keys where id = p_key;
  perform public.adjust_stock(v_variant, 'ADJUSTMENT', p_quantity,
    coalesce(nullif(trim(p_note), ''), 'API') || format(' (API key "%s")', v_name), upper(p_mode));
  select * into v_inv from public.inventory where variant_id = v_variant;
  return jsonb_build_object('sku', trim(p_sku), 'on_hand', v_inv.on_hand, 'reserved', v_inv.reserved, 'available', v_inv.available);
end;
$$;
create or replace function public.api_customers(p_key uuid, p jsonb default '{}')
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit int := least(greatest(coalesce((p ->> 'limit')::int, 50), 1), 100);
  v_offset int := greatest(coalesce((p ->> 'offset')::int, 0), 0);
  v_phone text := nullif(public.normalize_phone(nullif(trim(coalesce(p ->> 'phone', '')), '')), '');
begin
  perform public._api_require(p_key, 'customers:read');
  return jsonb_build_object('data', coalesce((select jsonb_agg(x.j order by x.last_order_at desc nulls last) from (
      select c.last_order_at, jsonb_build_object('id', c.id, 'name', c.full_name, 'phone', c.phone, 'email', c.email, 'district', c.district,
        'segment', c.segment, 'total_orders', c.total_orders, 'delivered_orders', c.delivered_orders, 'returned_orders', c.returned_orders,
        'total_spent', c.total_spent, 'first_order_at', c.first_order_at, 'last_order_at', c.last_order_at) j
      from public.customers c where v_phone is null or c.phone = v_phone
      order by c.last_order_at desc nulls last, c.id limit v_limit offset v_offset) x), '[]'::jsonb), 'limit', v_limit, 'offset', v_offset);
end;
$$;
