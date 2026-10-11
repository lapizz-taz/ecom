-- =============================================================================
-- A full ("everything") store reset now leaves no trace of anything the
-- business had connected: courier accounts, ad accounts, payment, SMS and
-- fraud-check providers, API keys, custom domains, their saved keys (in Vault)
-- and their logs. Connection settings return to what a new business starts
-- with, and a store that sent visitors to a removed Shopify/WooCommerce shop is
-- closed. The account, staff, roles, other settings, subscription, credits,
-- order fees and audit logs stay. Orders-only resets are unchanged.
-- =============================================================================

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
  v_def := replace(v_def, v_anchor, v_anchor || $b$
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
    v := v || jsonb_build_object('every_connection', true);$b$);
  execute v_def;
end $$;

select public._tenancy_own_functions();
