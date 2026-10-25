-- =============================================================================
-- Approval requests come only from the flows that check the asker first.
--
-- Found by the platform write sweep: platform_request_approval was callable by every platform
-- employee, with the module, action and payload of their choosing. A read-only employee could
-- file "grant_super_admin" for themselves under a module that someone else may approve (a custom
-- role with "approve" on support, say), and that person's approval made them Super Admin; the
-- request's summary, written by the asker, was all a Super Admin saw next to the action.
--
--   * The four flows that ask for approval (adding a Super Admin, closing a merchant, deleting a
--     merchant, a large credit adjustment) check the asker's rights and then file the request;
--     staff can no longer call platform_request_approval themselves.
--   * Each action is filed under the module whose approvers decide it.
--
-- Production had 7 requests, all merchant deletions filed through the delete flow. Safe to re-run.
-- =============================================================================

create or replace function public.platform_request_approval(p_module text, p_action text, p_merchant uuid, p_summary text, p_payload jsonb, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  -- Each action belongs to one module: its approvers decide it.
  if p_module is distinct from (case p_action
      when 'grant_super_admin' then 'employees'
      when 'merchant_close' then 'merchants'
      when 'merchant_delete' then 'merchants'
      when 'credit_adjust' then 'credits' end) then
    raise exception 'VALIDATION: "%" cannot be approved under the % module', p_action, p_module using errcode = '22023';
  end if;
  if not public.is_platform_staff() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if coalesce(length(trim(p_reason)), 0) < 5 then
    raise exception 'VALIDATION: explain why (at least 5 characters)' using errcode = '22023';
  end if;
  -- The same request waiting already: no second copy.
  select id into v_id from public.platform_approvals
  where status = 'PENDING' and expires_at > now() and action = p_action and requested_by = auth.uid()
    and merchant_id is not distinct from p_merchant and payload = p_payload;
  if v_id is not null then
    return v_id;
  end if;
  insert into public.platform_approvals (action, module, merchant_id, summary, payload, reason, requested_by)
  values (p_action, p_module, p_merchant, p_summary, coalesce(p_payload, '{}'::jsonb), trim(p_reason), auth.uid())
  returning id into v_id;
  perform public._platform_log('approval.requested', p_merchant, 'platform_approval', v_id::text, p_reason, null,
    jsonb_build_object('action', p_action, 'summary', p_summary), 'REQUESTED');
  return v_id;
end;
$$;

-- Only the flows above may file a request (they run as the database owner or app_owner).
revoke all on function public.platform_request_approval(text, text, uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.platform_request_approval(text, text, uuid, text, jsonb, text) to app_owner;

select public._tenancy_own_functions();
