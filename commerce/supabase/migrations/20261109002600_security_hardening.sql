-- =============================================================================
-- Security audit round 2 — DB hardening (low-severity findings).
--
-- Each function is patched in place from its current definition (which carries
-- earlier patches), so nothing else changes; CREATE OR REPLACE keeps the owner
-- and grants. Every patch is idempotent (a marker guard) and asserts it matched
-- exactly once, so a drifted definition fails loudly instead of silently.
--
-- 1. merchant_access_mode(uuid): a signed-in user could read ANY merchant's
--    access state (FULL / READ_ONLY / BLOCKED — i.e. its suspension and
--    subscription health) by passing that merchant's id, because the parameter
--    was honoured for everyone. Now a caller-supplied id is honoured only for
--    system callers (service role / cron / internal definer calls) and platform
--    staff; a merchant user always resolves to their own merchant.
-- 2. sms_log_test / meta_account_save: make the per-merchant checks explicit
--    (merchant_id = current_merchant_id()) so they are correct even if the
--    function is one of the SECURITY DEFINER functions that bypass RLS.
-- 3. _vd_cfg() / _store_root_domain(): still carried the built-in EXECUTE-to-
--    PUBLIC grant; they expose only non-secret platform config, but nothing
--    outside the server needs them. Revoke public/anon/authenticated execute.
-- =============================================================================

create or replace function pg_temp.sec_patch(p_fn text, p_marker text, p_from text, p_to text)
returns void
language plpgsql as $$
declare
  v_old text := replace(pg_get_functiondef(p_fn::regprocedure), E'\r', '');
  v_hits int;
begin
  if position(p_marker in v_old) > 0 then
    return; -- already patched
  end if;
  v_hits := (length(v_old) - length(replace(v_old, p_from, ''))) / length(p_from);
  if v_hits <> 1 then
    raise exception 'security hardening: % has changed (% matches for "%")', p_fn, v_hits, left(p_from, 60);
  end if;
  execute replace(v_old, p_from, p_to);
end $$;

-- 1. merchant_access_mode: bind a caller-supplied merchant to the caller.
select pg_temp.sec_patch('public.merchant_access_mode(uuid)',
  'is_system_context() or public.is_platform_staff()',
  '  v_id uuid := coalesce(p_merchant, public.current_merchant_id());',
  '  v_id uuid := case when public.is_system_context() or public.is_platform_staff()'
    || ' then coalesce(p_merchant, public.current_merchant_id()) else public.current_merchant_id() end;');

-- 2a. sms_log_test: the 20-test-per-hour cap is per merchant.
select pg_temp.sec_patch('public.sms_log_test(text,text,uuid)',
  'merchant_id = public.current_merchant_id() and created_at > now() - interval ''1 hour''',
  'where purpose = ''TEST'' and created_at > now() - interval ''1 hour''',
  'where purpose = ''TEST'' and merchant_id = public.current_merchant_id() and created_at > now() - interval ''1 hour''');

-- 2b. meta_account_save: the payment account must belong to the caller's merchant.
select pg_temp.sec_patch('public.meta_account_save(jsonb,uuid)',
  'id = v_pay and is_active and merchant_id = public.current_merchant_id()',
  'where id = v_pay and is_active) then',
  'where id = v_pay and is_active and merchant_id = public.current_merchant_id()) then');

-- 3. Internal config helpers are not for the public.
revoke execute on function public._vd_cfg() from public, anon, authenticated;
revoke execute on function public._store_root_domain() from public, anon, authenticated;
