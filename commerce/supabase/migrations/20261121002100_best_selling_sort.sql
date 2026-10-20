-- Store builder: "Best sellers" sections list products by what actually sold.
--
-- storefront_list_products takes p_sort = 'best_selling': units sold in the last 90 days, from
-- orders that went ahead (not cancelled, rejected, returned, lost or failed), newest products
-- first among equals. Nothing is shown that the orders do not support.

-- Text is compared without carriage returns (a script pasted on Windows has CRLF line ends).
create or replace function pg_temp.lf(p text) returns text
language sql immutable as $$ select replace(p, E'\r', '') $$;

do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.storefront_list_products(text,text,text,numeric,numeric,boolean,text,boolean,integer,integer)'::regprocedure));
  v_from text := pg_temp.lf($a$          case when p_sort = 'featured' then f.is_featured end desc,$a$);
  v_to text := pg_temp.lf($b$          case when p_sort = 'featured' then f.is_featured end desc,
          case when p_sort = 'best_selling' then (
            select coalesce(sum(oi.quantity), 0) from public.order_items oi join public.orders o on o.id = oi.order_id
            where oi.product_id = f.id and o.created_at > now() - interval '90 days'
              and o.status not in ('CANCELLED', 'REJECTED_FRAUD', 'RETURNED', 'LOST', 'FAILED_DELIVERY')) end desc,$b$);
begin
  if position('best_selling' in v_old) > 0 then
    return;
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'best selling sort: storefront_list_products has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

select public._tenancy_own_functions();
