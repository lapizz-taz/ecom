-- Inventory insights: one server-side read for the inventory dashboard.
-- Per tracked variant: units sold (approved, not cancelled orders) in the last
-- 7 / 30 / 90 days, a weighted daily sales rate, days of stock left, stock on
-- order from suppliers, a suggested reorder quantity, dead stock (no sale for
-- p_dead_days while there is stock), and an ABC class by 90-day revenue
-- (A = top 80% of revenue, B = next 15%, C = the rest, null = no sales).
create or replace function public.inventory_insights(p_lead_days int default 7, p_cover_days int default 30, p_dead_days int default 60)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_lead int := least(greatest(coalesce(p_lead_days, 7), 0), 120);
  v_cover int := least(greatest(coalesce(p_cover_days, 30), 1), 365);
  v_dead int := least(greatest(coalesce(p_dead_days, 60), 7), 730);
  v_items jsonb;
begin
  perform public.require_permission('inventory.view');
  with v as (
    select io.*, (select pi.url from public.product_images pi where pi.product_id = io.product_id
                  order by pi.is_primary desc, pi.position limit 1) as image_url
    from public.inventory_overview io
    where io.track_inventory and io.variant_active and io.product_status <> 'ARCHIVED'
  ), sold as (
    select i.variant_id,
      coalesce(sum(i.quantity - i.returned_quantity) filter (where o.confirmed_at >= now() - interval '7 days'), 0) as sold_7,
      coalesce(sum(i.quantity - i.returned_quantity) filter (where o.confirmed_at >= now() - interval '30 days'), 0) as sold_30,
      coalesce(sum(i.quantity - i.returned_quantity), 0) as sold_90,
      coalesce(sum(i.line_subtotal), 0) as revenue_90
    from public.order_items i join public.orders o on o.id = i.order_id
    where o.confirmed_at >= now() - interval '90 days' and o.merged_into is null
      and o.status not in ('CANCELLED', 'REJECTED_FRAUD', 'PENDING_CANCEL')
    group by i.variant_id
  ), last_sale as (
    select i.variant_id, max(o.confirmed_at) as last_sale_at
    from public.order_items i join public.orders o on o.id = i.order_id
    where o.confirmed_at is not null and o.status not in ('CANCELLED', 'REJECTED_FRAUD')
    group by i.variant_id
  ), first_in as (
    select variant_id, min(created_at) as first_in_at from public.inventory_movements
    where on_hand_change > 0 group by variant_id
  ), incoming as (
    select pi.variant_id, sum(greatest(pi.quantity - pi.received_quantity, 0)) as qty, min(po.expected_date) as expected
    from public.purchase_order_items pi join public.purchase_orders po on po.id = pi.purchase_order_id
    where po.status in ('ORDERED', 'PARTIALLY_RECEIVED') group by pi.variant_id
  ), base as (
    select v.variant_id, v.product_id, v.product_name, v.variant_title, v.sku, v.category_name, v.image_url,
      v.on_hand, v.reserved, v.available, v.damaged, v.unit_cost, v.unit_price, v.stock_value, v.low_stock_threshold, v.stock_status,
      coalesce(s.sold_7, 0) as sold_7, coalesce(s.sold_30, 0) as sold_30, coalesce(s.sold_90, 0) as sold_90,
      coalesce(s.revenue_90, 0) as revenue_90, ls.last_sale_at, fi.first_in_at,
      coalesce(inc.qty, 0) as incoming, inc.expected as incoming_expected,
      round((coalesce(s.sold_7, 0) / 7.0) * 0.4 + (coalesce(s.sold_30, 0) / 30.0) * 0.4 + (coalesce(s.sold_90, 0) / 90.0) * 0.2, 3) as daily
    from v
    left join sold s on s.variant_id = v.variant_id
    left join last_sale ls on ls.variant_id = v.variant_id
    left join first_in fi on fi.variant_id = v.variant_id
    left join incoming inc on inc.variant_id = v.variant_id
  ), ranked as (
    select b.*,
      case when b.revenue_90 > 0 then
        sum(b.revenue_90) over (order by b.revenue_90 desc, b.variant_id rows between unbounded preceding and current row)
          / nullif(sum(b.revenue_90) over (), 0) end as cum_share
    from base b
  ), calc as (
    select r.*,
      case when r.daily > 0 then round(greatest(r.available, 0) / r.daily, 1) end as cover_days,
      case when r.daily > 0 then greatest(ceil(r.daily * (v_lead + v_cover))::int - greatest(r.available, 0) - r.incoming, 0) end as suggest,
      case when r.revenue_90 <= 0 then null
           when r.cum_share - r.revenue_90 / nullif(sum(r.revenue_90) over (), 0) < 0.80 then 'A'
           when r.cum_share - r.revenue_90 / nullif(sum(r.revenue_90) over (), 0) < 0.95 then 'B'
           else 'C' end as abc,
      (r.on_hand > 0 and coalesce(r.last_sale_at, r.first_in_at, now()) < now() - make_interval(days => v_dead)) as dead
    from ranked r
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'variant_id', c.variant_id, 'product_id', c.product_id, 'product_name', c.product_name, 'variant_title', c.variant_title, 'sku', c.sku,
      'category', c.category_name, 'image_url', c.image_url, 'on_hand', c.on_hand, 'reserved', c.reserved, 'available', c.available,
      'unit_cost', c.unit_cost, 'unit_price', c.unit_price, 'stock_value', c.stock_value, 'low_stock_threshold', c.low_stock_threshold,
      'sold_7', c.sold_7, 'sold_30', c.sold_30, 'sold_90', c.sold_90, 'revenue_90', c.revenue_90, 'daily', c.daily,
      'last_sale_at', c.last_sale_at, 'incoming', c.incoming, 'incoming_expected', c.incoming_expected,
      'cover_days', c.cover_days, 'suggest', c.suggest, 'abc', c.abc, 'dead', c.dead,
      'status', case when c.available <= 0 then 'OUT'
                     when c.cover_days is not null and c.cover_days < v_lead then 'CRITICAL'
                     when c.stock_status = 'LOW_STOCK' or (c.cover_days is not null and c.cover_days < v_lead + 7) then 'LOW'
                     when c.dead then 'DEAD'
                     else 'OK' end)
    order by c.revenue_90 desc, c.product_name), '[]'::jsonb)
  into v_items from calc c;
  return jsonb_build_object('lead_days', v_lead, 'cover_days', v_cover, 'dead_days', v_dead, 'generated_at', now(), 'items', v_items);
end;
$$;
revoke all on function public.inventory_insights(int, int, int) from public, anon;
grant execute on function public.inventory_insights(int, int, int) to authenticated;
