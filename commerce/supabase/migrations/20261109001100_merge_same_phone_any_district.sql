-- =============================================================================
-- Repeat orders from the same phone merge whatever the district says.
--
-- Two open web orders (not yet approved, unpaid, no parcel) from the same
-- phone within the window were only merged when their districts matched; a
-- store order whose district could not be read, or a district typed
-- differently, left a "possible duplicate" for staff instead. They now merge.
-- When the merged order gave another address or district, the kept order's
-- note says so, so it is confirmed on the confirmation call. The merged
-- order's store tax is kept in the total (one parcel, one delivery charge).
-- =============================================================================

create or replace function pg_temp.lf(p text) returns text
language sql immutable as $$ select replace(p, E'\r', '') $$;

-- 1. Merging: the district no longer has to match
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public._auto_merge_web_order(uuid)'::regprocedure));
  v_from text := $a$    and lower(o.shipping_district) is not distinct from lower(v_order.shipping_district)
$a$;
begin
  if position(v_from in v_old) = 0 then
    if position('is not distinct from lower(v_order.shipping_district)' in v_old) = 0 then
      return;  -- already applied
    end if;
    raise exception 'merge by phone: _auto_merge_web_order has changed';
  end if;
  execute replace(v_old, v_from, '');
end $$;

-- 2. The kept order: notes the other address and district, keeps the store tax
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public._merge_web_orders(uuid,uuid,text,text)'::regprocedure));
  v_new text := v_old;
  r record;
begin
  if position('v_source.tax_amount' in v_old) > 0 then
    return;
  end if;
  for r in select * from (values
    ($a$  v_note := case when public.normalize_address(v_source.shipping_address) is distinct from public.normalize_address(v_target.shipping_address)
    then format('Merged order %s gave another address: %s', v_source.order_number, v_source.shipping_address) end;
$a$, $b$  v_note := case when public.normalize_address(v_source.shipping_address) is distinct from public.normalize_address(v_target.shipping_address)
      or lower(coalesce(v_source.shipping_district, '')) is distinct from lower(coalesce(v_target.shipping_district, ''))
    then format('Merged order %s gave another address: %s', v_source.order_number,
      concat_ws(', ', nullif(trim(v_source.shipping_address), ''), nullif(v_source.shipping_district, ''))) end;
$b$),
    ($a$    merged_count = merged_count + 1 + v_source.merged_count,
$a$, $b$    merged_count = merged_count + 1 + v_source.merged_count,
    tax_amount = coalesce(tax_amount, 0) + coalesce(v_source.tax_amount, 0),
$b$)) as t(old_text, new_text)
  loop
    if position(r.old_text in v_new) = 0 then
      raise exception 'merge by phone: _merge_web_orders has changed near %', left(r.old_text, 60);
    end if;
    v_new := replace(v_new, r.old_text, r.new_text);
  end loop;
  execute v_new;
end $$;

select public._tenancy_own_functions();
