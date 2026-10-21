-- Bundles / quantity breaks: "1 piece, 2 pieces −10%, 3 pieces −15%" on a store's product page,
-- charged as shown.
--
-- The merchant sets the options in the theme builder (the "Bundles / Quantity breaks" product page
-- block, saved in storefront.theme.product_page.blocks). Prices are always worked out here, so the
-- published block is read by calculate_order_quote: buying that many of a product (all its options
-- together) lowers the unit price by the option's percent. The cart, checkout and the order all use
-- that price; the line also says its regular price and the percent, and the quote what was saved.
-- Staff orders, staff edits and orders imported from Shopify / WooCommerce keep their own prices.
-- A draft that is not published changes nothing.

-- Text is compared without carriage returns (a script pasted on Windows has CRLF line ends).
create or replace function pg_temp.lf(p text) returns text
language sql immutable as $$ select replace(p, E'\r', '') $$;

/** Replaces each text once in a function's definition (it must appear exactly once), then runs it. */
create or replace function pg_temp.patch(p_fn regprocedure, p_marker text, p_pairs text[][])
returns void
language plpgsql as $$
declare
  v_def text := pg_temp.lf(pg_get_functiondef(p_fn));
  v_from text;
  i int;
begin
  if position(p_marker in v_def) > 0 then
    return;
  end if;
  for i in 1 .. array_length(p_pairs, 1) loop
    v_from := pg_temp.lf(p_pairs[i][1]);
    if (length(v_def) - length(replace(v_def, v_from, ''))) / length(v_from) <> 1 then
      raise exception 'product bundles: % has changed (part %)', p_fn, i;
    end if;
    v_def := replace(v_def, v_from, pg_temp.lf(p_pairs[i][2]));
  end loop;
  execute v_def;
end;
$$;

/** The store's published, switched-on bundles block, or null. */
create or replace function public._bundle_rule()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select b from jsonb_array_elements(
      case when jsonb_typeof(public.get_setting('storefront') #> '{theme,product_page,blocks}') = 'array'
           then public.get_setting('storefront') #> '{theme,product_page,blocks}' else '[]'::jsonb end) b
  where jsonb_typeof(b) = 'object' and b ->> 'type' = 'bundles' and coalesce(b ->> 'enabled', 'true') <> 'false'
  limit 1
$$;

/**
 * The bundle discount in percent (0–90) for buying p_quantity of a product: the option with the
 * largest quantity at or under it (the first one when two have the same quantity). Options that are
 * not whole numbers 1–50 are left out; a block for one category applies to that category only.
 */
create or replace function public._bundle_percent(p_rule jsonb, p_quantity int, p_category_id uuid)
returns numeric
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_pct numeric;
begin
  if p_rule is null or p_quantity is null or p_quantity < 1 then
    return 0;
  end if;
  if coalesce(p_rule #>> '{settings,scope}', 'all') = 'category' and not exists (
      select 1 from public.categories c where c.id = p_category_id and c.slug = nullif(p_rule #>> '{settings,category}', '')) then
    return 0;
  end if;
  select t.pct into v_pct
  from (
    select distinct on (q) q, pct
    from (
      select floor((x ->> 'quantity')::numeric)::int as q,
             case when x ->> 'percent' ~ '^\s*\d+(\.\d+)?\s*$' then least(90, greatest(0, (x ->> 'percent')::numeric)) else 0 end as pct,
             ord
      from jsonb_array_elements(case when jsonb_typeof(p_rule #> '{settings,tiers}') = 'array' then p_rule #> '{settings,tiers}' else '[]'::jsonb end)
           with ordinality e(x, ord)
      where jsonb_typeof(x) = 'object' and x ->> 'quantity' ~ '^\s*\d+(\.\d+)?\s*$'
    ) a
    where q between 1 and 50
    order by q, ord
  ) t
  where t.q <= p_quantity
  order by t.q desc
  limit 1;
  return coalesce(v_pct, 0);
end;
$$;

select pg_temp.patch('public.calculate_order_quote(jsonb,text,text,text,text,text,boolean,boolean)'::regprocedure, 'v_bundle jsonb',
  array[
    array[$a$  v_unit numeric;
begin$a$, $b$  v_unit numeric;
  -- Bundles / quantity breaks (the published product page block): a lower unit price for buying more.
  v_bundle jsonb := public._bundle_rule();
  v_regular numeric;
  v_pct numeric;
  v_bundle_savings numeric := 0;
begin$b$],
    array[$a$           coalesce(i.available, 0) as available,$a$, $b$           coalesce(i.available, 0) as available,
           p.category_id, sum(r.quantity) over (partition by p.id) as product_quantity,$b$],
    array[$a$    if v_unit < 0 then
      raise exception 'VALIDATION: price cannot be negative' using errcode = '22023';
    end if;
$a$, $b$    if v_unit < 0 then
      raise exception 'VALIDATION: price cannot be negative' using errcode = '22023';
    end if;
    -- Customers only: staff set their own prices, and imported orders keep the store's.
    v_regular := v_unit;
    v_pct := 0;
    if v_bundle is not null and not p_allow_inactive and not p_allow_price_override
       and coalesce(current_setting('app.store_order_import', true), '') <> 'on' then
      v_pct := public._bundle_percent(v_bundle, v_item.product_quantity::int, v_item.category_id);
      if v_pct > 0 then
        v_unit := public.money(v_unit * (1 - v_pct / 100));
        v_bundle_savings := v_bundle_savings + (v_regular - v_unit) * v_item.quantity;
      end if;
    end if;
$b$],
    array[$a$      'unit_price', public.money(v_unit),$a$, $b$      'unit_price', public.money(v_unit),
      'regular_unit_price', public.money(v_regular),
      'bundle_percent', v_pct,$b$],
    array[$a$    'subtotal', public.money(v_subtotal),
    'coupon', v_coupon,$a$, $b$    'subtotal', public.money(v_subtotal),
    'bundle_savings', public.money(v_bundle_savings),
    'coupon', v_coupon,$b$]]);

-- Used inside the pricing function only.
revoke all on function public._bundle_rule(), public._bundle_percent(jsonb, int, uuid) from public, anon, authenticated;

select public._tenancy_own_functions();
