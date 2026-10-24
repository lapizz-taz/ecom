-- =============================================================================
-- The Moderator picks products for an order without seeing what they cost.
--   * Creating orders (orders.create) no longer opens the products and product_variants
--     tables. Every staff member reads tables as the same database role, so a column such as
--     cost_price cannot be hidden from one staff role: the tables now open only to staff who
--     work with products (products, stock, purchases, production, finance, marketing).
--   * order_catalog: what an order form (and the inbox's "send a product") picks from — name,
--     variant, SKU, price, picture and whether it is in stock — for anyone who creates orders
--     or answers chats. The cost only for staff who may see costs (_can_see_costs), the stock
--     count only for staff who may see stock. Before, staff who could create orders but not see
--     stock found no products at all in the order form.
-- Safe to re-run.
-- =============================================================================

-- Staff who work with products in some way may read the catalog tables.
create or replace function public._can_read_catalog()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.has_permission('products.view') or public.has_permission('inventory.view')
    or public.has_permission('purchases.view') or public.has_permission('production.view') or public.has_permission('finance.view')
    or public.has_permission('marketing.view')
$$;

-- Variants to put on an order: by name or SKU (active variants), or by id (any).
create or replace function public.order_catalog(p_search text default null, p_variant_ids uuid[] default null, p_limit int default 12)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_costs boolean := public._can_see_costs();
  v_stock boolean := public.has_permission('inventory.view') or public.has_permission('products.view');
  v_term text := nullif(btrim(regexp_replace(coalesce(p_search, ''), '[%_,()\\]', ' ', 'g')), '');
  v_limit int := case when p_variant_ids is not null then coalesce(cardinality(p_variant_ids), 0)
                      else least(greatest(coalesce(p_limit, 12), 1), 50) end;
begin
  if not (public.has_permission('orders.create') or public.has_permission('inbox.reply') or public._can_read_catalog()) then
    raise exception 'PERMISSION_DENIED: orders.create is required' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(r) order by r.product_name, r.variant_title)
    from (
      select v.id as variant_id, p.id as product_id, p.name as product_name, p.slug as product_slug,
             p.status::text as product_status, v.title as variant_title, v.sku, v.is_active as variant_active,
             p.track_inventory, coalesce(v.price, p.price) as unit_price,
             case when v_costs then coalesce(v.cost_price, p.cost_price) end as unit_cost,
             case when v_stock then i.available end as available,
             (not p.track_inventory or coalesce(i.available, 0) > 0) as in_stock,
             (select pi.url from public.product_images pi where pi.product_id = p.id
               order by pi.is_primary desc, pi.position limit 1) as image_url
      from public.product_variants v
      join public.products p on p.id = v.product_id
      left join public.inventory i on i.variant_id = v.id
      where case when p_variant_ids is not null then v.id = any(p_variant_ids)
                 else v.is_active and (v_term is null or p.name ilike '%' || v_term || '%' or v.sku ilike '%' || v_term || '%') end
      order by p.name, v.title
      limit v_limit
    ) r
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.order_catalog(text, uuid[], int) from public, anon;
grant execute on function public.order_catalog(text, uuid[], int) to authenticated;

select public._tenancy_own_functions();
