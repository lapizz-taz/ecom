-- =============================================================================
-- Security hardening from the database advisor.
--
-- * The external API functions (api_*) already refuse anyone but the server
--   (_require_system), and the API edge function calls them with the service
--   role. Visitors and signed-in users no longer get EXECUTE on them at all.
-- * Admin API-key and contact-message functions: signed-in users only (each
--   still checks the permission inside).
-- * Trigger functions are not callable through the API.
-- * Functions without a fixed search_path get one.
-- =============================================================================

do $$
declare
  f regprocedure;
begin
  -- Server only.
  for f in select p.oid::regprocedure from pg_proc p
           where p.pronamespace = 'public'::regnamespace
             and p.proname in ('api_customers', 'api_inventory', 'api_inventory_adjust', 'api_key_check', 'api_key_merchant', 'api_order',
                               'api_order_set_status', 'api_orders', 'api_products', 'api_request_log', '_api_order_json', '_api_require') loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  -- Signed-in users (permission checked inside).
  for f in select p.oid::regprocedure from pg_proc p
           where p.pronamespace = 'public'::regnamespace
             and p.proname in ('admin_api_key_create', 'admin_api_key_revoke', 'admin_api_keys', 'admin_api_logs',
                               'platform_contact_message_update', 'platform_contact_messages_list') loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  -- Trigger functions.
  for f in select p.oid::regprocedure from pg_proc p
           where p.pronamespace = 'public'::regnamespace
             and p.proname in ('_order_items_channel_restock_trigger', '_orders_access_guard', '_queue_woo_status_push') loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
  -- A fixed search_path.
  for f in select p.oid::regprocedure from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.proconfig is null
             and p.proname in ('_announcement_optional_kinds', '_billing_interval', '_merchant_delete_kept_tables', '_platform_automation_catalog',
                               '_store_reset_tables', '_tenancy_global_tables', '_usage_feature', '_usage_module', '_usage_policy_validate', 'pbx_ledger_immutable') loop
    execute format('alter function %s set search_path = public, pg_temp', f);
  end loop;
end $$;
