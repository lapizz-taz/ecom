-- =============================================================================
-- "Call" role and cost privacy
--
--   * A standard Call role in every store (and every new store): web orders,
--     search, the order page, calling, recording the call outcome and fixing
--     customer details. No dashboard, reports, finance, products or stock.
--   * Order cost and item cost are no longer readable by staff through the
--     tables (column privileges). People allowed to see costs (finance,
--     price override, product or purchase managers, marketing and report
--     viewers) read them through order_cost_summary() / the cost-aware view.
--   * Products and variants (which carry cost prices) are readable by staff
--     who work with the catalog, stock, purchases, production, finance or
--     new orders; not by roles without any of those (such as Call).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Who may see costs and profit
-- ---------------------------------------------------------------------------
create or replace function public._can_see_costs()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_system_context()
    or public.has_permission('finance.view') or public.has_permission('orders.price_override')
    or public.has_permission('products.manage') or public.has_permission('purchases.manage')
    or public.has_permission('marketing.view') or public.has_permission('reports.view')
$$;

-- Staff who work with products in some way may read the catalog tables.
create or replace function public._can_read_catalog()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.has_permission('products.view') or public.has_permission('inventory.view') or public.has_permission('orders.create')
    or public.has_permission('purchases.view') or public.has_permission('production.view') or public.has_permission('finance.view')
    or public.has_permission('marketing.view')
$$;

-- An order's cost of goods, for people allowed to see it (else null).
create or replace function public.order_cost_total(p_order uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when public._can_see_costs() then o.cost_total end from public.orders o where o.id = p_order
$$;

-- Costs of one order and its lines, for the order page's financial summary.
create or replace function public.order_cost_summary(p_order uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public._can_see_costs() then
    raise exception 'PERMISSION_DENIED: costs are visible to finance staff' using errcode = '42501';
  end if;
  if not public.has_permission('orders.view') then
    raise exception 'PERMISSION_DENIED: orders.view is required' using errcode = '42501';
  end if;
  return (select jsonb_build_object('cost_total', o.cost_total,
      'items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'unit_cost', i.unit_cost)) from public.order_items i where i.order_id = o.id), '[]'::jsonb))
    from public.orders o where o.id = p_order);
end;
$$;

-- The campaign report reads cost through the check above instead of the column.
create or replace view public.marketing_campaign_performance with (security_invoker = true) as
 SELECT c.id AS campaign_id,
    c.platform,
    c.name,
    c.status,
    c.utm_campaign,
    c.start_date,
    c.end_date,
    COALESCE(s.spend, (0)::numeric) AS spend,
    COALESCE(s.orders, (0)::bigint) AS reported_orders,
    COALESCE(s.revenue, (0)::numeric) AS reported_revenue,
    COALESCE(a.orders, (0)::bigint) AS attributed_orders,
    COALESCE(a.revenue, (0)::numeric) AS attributed_revenue,
    COALESCE(a.gross_profit, (0)::numeric) AS attributed_gross_profit,
        CASE
            WHEN (COALESCE(s.spend, (0)::numeric) > (0)::numeric) THEN round((COALESCE(s.revenue, (0)::numeric) / s.spend), 2)
            ELSE NULL::numeric
        END AS roas,
        CASE
            WHEN (COALESCE(s.orders, (0)::bigint) > 0) THEN round((s.spend / (s.orders)::numeric), 2)
            ELSE NULL::numeric
        END AS cpa,
        CASE
            WHEN ((COALESCE(s.orders, (0)::bigint) + COALESCE(a.orders, (0)::bigint)) > 0) THEN round((COALESCE(s.spend, (0)::numeric) / (GREATEST(COALESCE(s.orders, (0)::bigint), COALESCE(a.orders, (0)::bigint)))::numeric), 2)
            ELSE NULL::numeric
        END AS cost_per_order,
        CASE
            WHEN ((COALESCE(s.spend, (0)::numeric) > (0)::numeric) AND (a.revenue IS NOT NULL)) THEN round((a.revenue / s.spend), 2)
            ELSE NULL::numeric
        END AS attributed_roas,
    (COALESCE(a.gross_profit, (0)::numeric) - COALESCE(s.spend, (0)::numeric)) AS profit_after_ad_spend
   FROM ((marketing_campaigns c
     LEFT JOIN ( SELECT marketing_spend.campaign_id,
            sum(marketing_spend.spend) AS spend,
            sum(marketing_spend.orders) AS orders,
            sum(marketing_spend.revenue) AS revenue
           FROM marketing_spend
          GROUP BY marketing_spend.campaign_id) s ON ((s.campaign_id = c.id)))
     LEFT JOIN ( SELECT o.utm_campaign,
            count(*) AS orders,
            sum(o.total_amount) AS revenue,
            sum(((o.subtotal - o.discount_total) - public.order_cost_total(o.id))) AS gross_profit
           FROM orders o
          WHERE ((o.utm_campaign IS NOT NULL) AND (o.status = ANY (ARRAY['DELIVERED'::order_status, 'RETURN_REQUESTED'::order_status])) AND (o.delivered_at IS NOT NULL))
          GROUP BY o.utm_campaign) a ON ((a.utm_campaign = c.utm_campaign)));

-- ---------------------------------------------------------------------------
-- Column privileges: every column of orders / order_items except the costs
-- ---------------------------------------------------------------------------
create or replace function public._grant_columns_except(p_table regclass, p_hidden text[])
returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_cols text;
begin
  select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into v_cols
  from pg_attribute a
  where a.attrelid = p_table and a.attnum > 0 and not a.attisdropped and a.attname <> all (p_hidden);
  execute format('revoke select on %s from authenticated', p_table);
  execute format('grant select (%s) on %s to authenticated', v_cols, p_table);
end;
$$;
revoke all on function public._grant_columns_except(regclass, text[]) from public, anon, authenticated;

select public._grant_columns_except('public.orders', array['cost_total']);
select public._grant_columns_except('public.order_items', array['unit_cost']);

-- ---------------------------------------------------------------------------
-- Catalog reads
-- ---------------------------------------------------------------------------
drop policy if exists products_staff_read on public.products;
create policy products_staff_read on public.products for select to authenticated
  using ((select public.is_staff()) and (select public._can_read_catalog()));
drop policy if exists product_variants_staff_read on public.product_variants;
create policy product_variants_staff_read on public.product_variants for select to authenticated
  using ((select public.is_staff()) and (select public._can_read_catalog()));

-- ---------------------------------------------------------------------------
-- The Call role: every store now, and every new store from now on
-- ---------------------------------------------------------------------------
create or replace function public._seed_call_role(p_merchant uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role uuid;
begin
  insert into public.roles (merchant_id, code, name, description, is_system, rank)
  values (p_merchant, 'CALL', 'Call', 'Calls customers from Web Orders and Search: confirms or cancels orders and fixes customer details. No sales, profit, costs or stock.', true, 30)
  on conflict do nothing;
  select id into v_role from public.roles where merchant_id = p_merchant and code = 'CALL';
  if v_role is null then
    return;
  end if;
  insert into public.role_permissions (merchant_id, role_id, permission_id)
  select p_merchant, v_role, p.id from public.permissions p
  where p.code in ('orders.view', 'orders.status', 'orders.update', 'pbx.call')
  on conflict do nothing;
end;
$$;
revoke all on function public._seed_call_role(uuid) from public, anon, authenticated;

-- New stores: their default roles are seeded together; the Viewer role is the last of them.
create or replace function public._roles_seed_call()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.code = 'VIEWER' then
    perform public._seed_call_role(new.merchant_id);
  end if;
  return new;
end;
$$;
drop trigger if exists roles_seed_call on public.roles;
create trigger roles_seed_call after insert on public.roles for each row execute function public._roles_seed_call();

do $$
declare m record;
begin
  for m in select id from public.merchants loop
    perform set_config('app.merchant_id', m.id::text, true);
    perform public._seed_call_role(m.id);
  end loop;
  perform set_config('app.merchant_id', '', true);
end $$;

revoke all on function public._can_see_costs(), public._can_read_catalog(), public.order_cost_total(uuid) from public, anon;
grant execute on function public._can_see_costs(), public._can_read_catalog(), public.order_cost_total(uuid) to authenticated;
revoke all on function public.order_cost_summary(uuid) from public, anon;
grant execute on function public.order_cost_summary(uuid) to authenticated;

select public._tenancy_own_functions();
