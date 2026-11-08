-- =============================================================================
-- Abandoned checkouts (Shopify and WooCommerce): create the order from one.
--
-- Asked for on 8 Nov 2026. Our own store's abandoned carts had an Order button (New order filled with the
-- cart); a Shopify or WooCommerce abandoned checkout had none, so staff who reached the customer had to
-- type the order again. Now:
--   * admin_abandoned_checkout_draft(id) gives New order the customer, the address, the district worked
--     out from it, and the items matched to this business's products: first by the store's own variant
--     link (sales_channel_variants), then by SKU. Items with no match come back unmatched, by name.
--   * admin_link_abandoned_checkout(id, order) runs once the order is created: the checkout counts as
--     recovered (completed_at is kept by later fetches, so it stays recovered) and remembers the order.
--
-- New: shopify_abandoned_checkouts.order_id, admin_abandoned_checkout_draft(), admin_link_abandoned_checkout().
-- Safe to re-run.
-- =============================================================================

alter table public.shopify_abandoned_checkouts add column if not exists order_id uuid references public.orders(id) on delete set null;

create or replace function public.admin_abandoned_checkout_draft(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.shopify_abandoned_checkouts;
  v_items jsonb;
begin
  perform public.require_permission('orders.create');
  select * into v_row from public.shopify_abandoned_checkouts where id = p_id;
  if v_row.id is null then
    raise exception 'NOT_FOUND: abandoned checkout not found' using errcode = 'P0002';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'title', coalesce(i ->> 'title', 'Item'), 'variant', i ->> 'variant', 'sku', i ->> 'sku',
      'quantity', greatest(coalesce((i ->> 'quantity')::int, 1), 1),
      'price', nullif(i ->> 'price', '')::numeric,
      'variant_id', coalesce(
        (select scv.variant_id from public.sales_channel_variants scv
         where scv.channel_id = v_row.channel_id and scv.external_variant_id = i ->> 'external_variant_id' and scv.variant_id is not null limit 1),
        (select pv.id from public.product_variants pv
         where nullif(trim(i ->> 'sku'), '') is not null and lower(pv.sku) = lower(trim(i ->> 'sku')) order by pv.created_at limit 1)))
    order by n), '[]'::jsonb)
  into v_items
  from jsonb_array_elements(coalesce(v_row.items, '[]'::jsonb)) with ordinality as t(i, n);

  return jsonb_build_object(
    'id', v_row.id, 'name', v_row.name, 'status', v_row.status, 'order_id', v_row.order_id,
    'customer_name', v_row.customer_name, 'phone', v_row.phone, 'email', v_row.email,
    'address', v_row.address, 'city', v_row.city, 'province', v_row.province, 'country', v_row.country,
    'district', public._bd_district(array[v_row.city, v_row.province, v_row.address]),
    'items', v_items);
end;
$$;

create or replace function public.admin_link_abandoned_checkout(p_id uuid, p_order_id uuid)
returns public.shopify_abandoned_checkouts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.shopify_abandoned_checkouts;
begin
  perform public.require_permission('orders.create');
  select * into v_row from public.shopify_abandoned_checkouts where id = p_id for update;
  if v_row.id is null then
    raise exception 'NOT_FOUND: abandoned checkout not found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.orders where id = p_order_id) then
    raise exception 'NOT_FOUND: order not found' using errcode = 'P0002';
  end if;
  if v_row.order_id is not null and v_row.order_id <> p_order_id then
    raise exception 'VALIDATION: this checkout already became another order' using errcode = '22023';
  end if;
  update public.shopify_abandoned_checkouts
  set order_id = p_order_id, completed_at = coalesce(completed_at, now()), status = 'RECOVERED'
  where id = p_id returning * into v_row;
  perform public._order_log(p_order_id, 'FROM_ABANDONED_CHECKOUT',
    'Created from an abandoned checkout' || coalesce(' (' || v_row.name || ')', ''));
  perform public.log_audit('shopify_abandoned.order', 'shopify_abandoned_checkout', p_id::text, null, jsonb_build_object('order_id', p_order_id));
  return v_row;
end;
$$;

alter function public.admin_abandoned_checkout_draft(uuid) owner to app_owner;
alter function public.admin_link_abandoned_checkout(uuid, uuid) owner to app_owner;
revoke all on function public.admin_abandoned_checkout_draft(uuid), public.admin_link_abandoned_checkout(uuid, uuid) from public, anon;
grant execute on function public.admin_abandoned_checkout_draft(uuid), public.admin_link_abandoned_checkout(uuid, uuid) to authenticated;
