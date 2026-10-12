-- The theme editor previews the store inside a frame on the admin's own
-- address. Until now the frame opened the store at /s/<name>, which only
-- exists while the online store is on: with the store off, or selling on
-- Shopify / WooCommerce, the frame fell back to the platform's own home page.
-- Staff now resolve their own store for the preview, whatever its mode and
-- even before it has a store name. Shoppers still only reach stores that are on.

/** Staff: their own store, for the theme editor's preview (works while the store is off). */
create or replace function public.storefront_resolve_preview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_m public.merchants;
begin
  if not public.is_staff() then
    raise exception 'PERMISSION_DENIED: staff only' using errcode = '42501';
  end if;
  select * into v_m from public.merchants where id = public.current_merchant_id();
  if v_m.id is null then
    return jsonb_build_object('kind', 'missing');
  end if;
  return public._store_json(v_m);
end;
$$;

revoke execute on function public.storefront_resolve_preview() from public, anon;
grant execute on function public.storefront_resolve_preview() to authenticated;

select public._tenancy_own_functions();
