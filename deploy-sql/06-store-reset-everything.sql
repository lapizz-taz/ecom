-- Paste into Supabase → SQL editor → Run (one time).
-- A full ("Everything") store reset then removes every connection the business made:
-- Shopify/WooCommerce stores, couriers, ad accounts, payment/SMS/fraud providers, API keys,
-- custom domains, their saved keys and their history. Orders-only resets are unchanged.

begin;

do $$
declare
  v_def text := replace(pg_get_functiondef('public.platform_store_reset(uuid, text, text, text)'::regprocedure), E'\r', '');
  v_new text;
begin
  if position('store_connections' in v_def) > 0 then
    return; -- already applied
  end if;
  -- Matched loosely (any spacing or line endings), so a copy-paste cannot break it.
  v_new := regexp_replace(v_def,
    'update public\.sales_channels set first_sync_at = null,\s*catalog_imported_at = null,\s*settings = settings \|\| ''\{"inventory_sync": false\}''::jsonb\s*where merchant_id = p_merchant;',
    replace($n$-- Store connections go too, with their saved keys.
    delete from public.channel_oauth_states where merchant_id = p_merchant;
    delete from vault.secrets where id in (
      select secret_id from public.integration_credentials
      where merchant_id = p_merchant and key like 'channels.%' and secret_id is not null);
    delete from public.integration_credentials where merchant_id = p_merchant and key like 'channels.%';
    delete from public.sales_channels where merchant_id = p_merchant;
    get diagnostics n = row_count; v := v || jsonb_build_object('store_connections', n);$n$, E'\r', ''));
  if v_new = v_def then
    raise exception 'store reset connections: platform_store_reset() has changed; update this migration';
  end if;
  execute v_new;
end $$;

do $$
declare
  v_def text := replace(pg_get_functiondef('public.platform_store_reset(uuid, text, text, text)'::regprocedure), E'\r', '');
  v_anchor text := $a$get diagnostics n = row_count; v := v || jsonb_build_object('store_connections', n);$a$;
begin
  if position('every_connection' in v_def) > 0 then
    return; -- already applied
  end if;
  if position(v_anchor in v_def) = 0 then
    raise exception 'platform_store_reset: expected the store connections step; apply 20261108000100 first';
  end if;
  v_def := replace(v_def, v_anchor, v_anchor || replace($b$
    -- Every other connection, with its saved keys and history.
    delete from public.api_request_logs where merchant_id = p_merchant;
    delete from public.api_keys where merchant_id = p_merchant;
    delete from public.site_api_keys where merchant_id = p_merchant;
    delete from public.ad_oauth_states where merchant_id = p_merchant;
    delete from public.ad_accounts where merchant_id = p_merchant;
    delete from public.ad_connections where merchant_id = p_merchant;
    delete from public.meta_ad_accounts where merchant_id = p_merchant;
    delete from vault.secrets where id in (
      select secret_id from public.courier_credentials where merchant_id = p_merchant and secret_id is not null
      union all
      select secret_id from public.integration_credentials where merchant_id = p_merchant and secret_id is not null);
    delete from public.courier_credentials where merchant_id = p_merchant;
    delete from public.integration_credentials where merchant_id = p_merchant;
    delete from public.couriers where merchant_id = p_merchant;
    get diagnostics n = row_count; v := v || jsonb_build_object('couriers', n);
    delete from public.store_domains where merchant_id = p_merchant;
    get diagnostics n = row_count; v := v || jsonb_build_object('domains', n);
    delete from public.system_logs where merchant_id = p_merchant;
    -- Connection settings back to a new business's defaults ("Own delivery" courier included).
    delete from public.settings where merchant_id = p_merchant
      and key in ('ad_platforms', 'meta_ads', 'sms', 'pbx', 'payments', 'couriers', 'fraud', 'notifications');
    perform public._merchant_seed_defaults(p_merchant);
    -- A store that sent visitors to a removed Shopify/WooCommerce shop is closed instead.
    update public.settings set value = (value - 'redirect_url') || '{"mode": "OFF"}'::jsonb
    where merchant_id = p_merchant and key = 'storefront' and upper(coalesce(value ->> 'mode', '')) in ('SHOPIFY', 'WOOCOMMERCE');
    v := v || jsonb_build_object('every_connection', true);$b$, E'\r', ''));
  execute v_def;
end $$;

select public._tenancy_own_functions();

insert into supabase_migrations.schema_migrations (version, name) values
  (to_char(now() at time zone 'utc', 'YYYYMMDDHH24MISS'), 'store_reset_connections'),
  (to_char(now() at time zone 'utc' + interval '1 second', 'YYYYMMDDHH24MISS'), 'store_reset_all_connections')
on conflict do nothing;

commit;
