-- =============================================================================
-- "Do you want a Fullfilio online store?" moves from sign-up to the admin
-- dashboard. A new business starts with the online store off and no store
-- address; the owner answers on the dashboard:
--   yes -> the online store is switched on under the store name they chose
--   no  -> nothing is published; the question is not asked again
-- Either answer can be changed later under Sales channels.
-- =============================================================================

/** Staff: where their store is published, and whether the online-store question was answered. */
create or replace function public.merchant_store_address()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := public.current_merchant_id();
  v_m public.merchants;
  v_front jsonb;
  v_mode text;
  v_root text := public._store_root_domain();
begin
  if not public.is_staff() then
    raise exception 'PERMISSION_DENIED: staff only' using errcode = '42501';
  end if;
  select * into v_m from public.merchants where id = v_id;
  select value into v_front from public.settings where merchant_id = v_id and key = 'storefront';
  v_mode := coalesce(v_front ->> 'mode', 'OWN');
  return jsonb_build_object(
    'mode', v_mode,
    'slug', v_m.slug,
    'root_domain', v_root,
    'subdomain', case when v_mode = 'OWN' and v_m.slug is not null and v_root is not null then v_m.slug || '.' || v_root end,
    'custom_domain', (select domain from public.store_domains where merchant_id = v_id and is_primary and status = 'ACTIVE' limit 1),
    -- Answered on the dashboard, or already selling somewhere (any mode but off).
    'asked', v_mode <> 'OFF' or coalesce((v_front ->> 'store_prompt_done')::boolean, false));
end;
$$;

/** Owner's answer on the dashboard: open the online store under p_slug, or not. */
create or replace function public.admin_online_store_answer(p_open boolean, p_slug text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := public.current_merchant_id();
  v_slug text := nullif(lower(trim(coalesce(p_slug, ''))), '');
  v_old jsonb;
begin
  perform public.require_permission('settings.manage');
  if p_open is null then
    raise exception 'VALIDATION: answer yes or no' using errcode = '22023';
  end if;
  select value into v_old from public.settings where merchant_id = v_id and key = 'storefront' for update;
  if v_old is null then
    raise exception 'NOT_FOUND: storefront settings missing' using errcode = 'P0002';
  end if;

  if not p_open then
    update public.settings set value = v_old || jsonb_build_object('store_prompt_done', true), updated_by = auth.uid()
    where merchant_id = v_id and key = 'storefront';
    return public.merchant_store_address();
  end if;

  -- Switching the store on gives it a free name (trigger); the chosen name then
  -- replaces it, checked against every business. A taken name undoes both.
  update public.settings set value = v_old || jsonb_build_object('mode', 'OWN', 'store_prompt_done', true), updated_by = auth.uid()
  where merchant_id = v_id and key = 'storefront';
  if v_slug is not null then
    perform public.admin_set_store_slug(v_slug);
  end if;
  perform public.log_audit('store.mode', 'setting', 'storefront',
    jsonb_build_object('mode', coalesce(v_old ->> 'mode', 'OWN')), jsonb_build_object('mode', 'OWN', 'slug', v_slug));
  return public.merchant_store_address();
end;
$$;

revoke execute on function public.admin_online_store_answer(boolean, text) from public;
grant execute on function public.admin_online_store_answer(boolean, text) to authenticated;

select public._tenancy_own_functions();
