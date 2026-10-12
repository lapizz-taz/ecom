-- Functions are not public unless a migration says so.
--
-- api_grants.sql tried to make that the default with
--   alter default privileges in schema public revoke execute on functions from public;
-- but PostgreSQL adds per-schema default privileges to its built-in default (EXECUTE to
-- PUBLIC); only a role-wide default can take it away. So every function created since
-- the last hand-written sweep has been callable by anyone, including anonymous store
-- visitors — among them merchant_usage(), merchant_limits() and merchant_entitlements(),
-- which take a merchant id and answer with that store's order volume, staff and product
-- counts and plan features (audit finding F-008).
--
-- 1. The role-wide default, so this cannot happen again.
alter default privileges for role postgres revoke execute on functions from public;

-- 2. The functions that still carry the built-in PUBLIC grant. Internal helpers and the
--    plan/usage functions are reached only through SECURITY DEFINER functions or by the
--    service role, which keep their own grants.
revoke execute on function
  public._announcement_optional_kinds(), public._billing_interval(text), public._channel_in_use(uuid, text),
  public._merchant_delete_kept_tables(), public._platform_automation_catalog(), public._plugin_config(jsonb),
  public._profiles_deleted_stay_off(), public._store_reset_active(text), public._store_reset_tables(),
  public._support_read_only(), public._support_session_id(), public._tenancy_global_tables(),
  public._usage_feature(text), public._usage_module(text), public._usage_policy_validate(text, jsonb),
  public.current_merchant_id(), public.feature_enabled(text, uuid), public.is_platform_staff(),
  public.merchant_access_mode(uuid), public.merchant_entitlements(uuid), public.merchant_limits(uuid),
  public.merchant_usage(uuid), public.my_plan(), public.platform_contact_submit(jsonb),
  public.require_feature(text), public.require_limit(text), public.storefront_resolve(text)
from public;

-- 3. What row-security policies and triggers evaluate as the visitor or the signed-in
--    person must stay callable by them (these return nothing about other stores).
grant execute on function
  public.current_merchant_id(), public._support_read_only(), public._support_session_id(),
  public._store_reset_active(text), public._store_reset_tables(), public._profiles_deleted_stay_off()
to anon, authenticated;
grant execute on function public.merchant_access_mode(uuid), public.is_platform_staff(), public.my_plan() to authenticated;
grant execute on function public.storefront_resolve(text), public.platform_contact_submit(jsonb) to anon, authenticated;
