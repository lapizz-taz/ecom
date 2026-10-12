-- =============================================================================
-- Merged orders: the first order's address is the one used.
--
-- The kept (first) order's address and district never change when later
-- orders are merged into it. The note about a merged order's other address
-- now says so plainly instead of reading like something to decide.
-- =============================================================================

create or replace function pg_temp.lf(p text) returns text
language sql immutable as $$ select replace(p, E'\r', '') $$;

do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public._merge_web_orders(uuid,uuid,text,text)'::regprocedure));
  v_from text := $a$    then format('Merged order %s gave another address: %s', v_source.order_number,
      concat_ws(', ', nullif(trim(v_source.shipping_address), ''), nullif(v_source.shipping_district, ''))) end;$a$;
  v_to text := $b$    then format('Merged order %s had another address (%s); the first order''s address is used', v_source.order_number,
      coalesce(nullif(concat_ws(', ', nullif(trim(v_source.shipping_address), ''), nullif(v_source.shipping_district, '')), ''), 'none')) end;$b$;
begin
  if position('the first order''''s address is used' in v_old) > 0 or position('first order''s address is used' in v_old) > 0 then
    return;
  end if;
  if position(v_from in v_old) = 0 then
    raise exception 'first address counts: _merge_web_orders has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

select public._tenancy_own_functions();
