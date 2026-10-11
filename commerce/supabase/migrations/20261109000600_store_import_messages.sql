-- =============================================================================
-- A store order that cannot come in says exactly why.
--
-- Shopify's checkout does not ask for a phone number unless the store turns
-- that on, so orders arrive without one. They failed with "enter a valid
-- mobile number", which did not say there was no number at all. Now:
--   * no phone:     "the order has no phone number (the customer left it
--                   empty). Add it and import again"
--   * bad phone:    "the phone number "…" is not a valid Bangladesh mobile
--                   number. Fix it and import again"
-- The order stays under Sales channels → Need fixing (also shown on Web
-- Orders) until someone adds it; nothing is lost and no stock moves twice.
-- =============================================================================

create or replace function pg_temp.lf(p text) returns text
language sql immutable as $$ select replace(p, E'\r', '') $$;
create or replace function pg_temp.lf_replace(p text, p_from text, p_to text) returns text
language sql immutable as $$ select replace(pg_temp.lf(p), pg_temp.lf(p_from), pg_temp.lf(p_to)) $$;

do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.channel_ingest_order(uuid,jsonb,text)'::regprocedure));
  v_new text;
begin
  if position('has no phone number' in v_old) > 0 then
    return;
  end if;
  v_new := pg_temp.lf_replace(v_old, $o$    perform set_config('app.order_number', coalesce(v_num, ''), true);
    perform set_config('app.store_order_import', 'on', true);
$o$, $n$    if nullif(trim(coalesce(v_fix ->> 'phone', v_o #>> '{customer,phone}', '')), '') is null then
      raise exception 'VALIDATION: the order has no phone number (the customer left it empty). Add it and import again' using errcode = '22023';
    end if;
    perform set_config('app.order_number', coalesce(v_num, ''), true);
    perform set_config('app.store_order_import', 'on', true);
$n$);
  v_new := pg_temp.lf_replace(v_new, $o$    v_error := regexp_replace(sqlerrm, '^[A-Z_]+: ', '');
$o$, $n$    v_error := regexp_replace(sqlerrm, '^[A-Z_]+: ', '');
    if v_error = 'enter a valid mobile number' then
      v_error := format('the phone number "%s" is not a valid Bangladesh mobile number. Fix it and import again',
        coalesce(nullif(v_fix ->> 'phone', ''), v_o #>> '{customer,phone}'));
    end if;
$n$);
  if position('has no phone number' in v_new) = 0 or position('not a valid Bangladesh mobile number' in v_new) = 0 then
    raise exception 'store import messages: channel_ingest_order has changed';
  end if;
  execute v_new;
end $$;
