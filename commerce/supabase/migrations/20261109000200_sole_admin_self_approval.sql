-- =============================================================================
-- A lone approver can approve their own requests.
--
-- Approvals normally need a second person. While nobody else on the platform
-- team could approve a request (no other active employee with the "approve"
-- permission for that module and merchant), the person asking may approve it
-- themselves; it is recorded as self-approved. As soon as a second employee
-- who could approve exists, the two-person rule applies again.
-- =============================================================================

alter table public.platform_approvals add column if not exists self_approved boolean not null default false;
alter table public.platform_approvals drop constraint if exists platform_approvals_check;
alter table public.platform_approvals drop constraint if exists platform_approvals_second_person;
alter table public.platform_approvals add constraint platform_approvals_second_person
  check (decided_by is null or decided_by <> requested_by or self_approved);

-- True when the caller is active platform staff and no other active employee
-- may approve p_module for p_merchant. Reads every staff row, so it is owned
-- by the database owner (see the exemption below).
create or replace function public._platform_sole_approver(p_module text, p_merchant uuid default null)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_platform_staff()
     and not exists (select 1 from public.platform_staff s
                     where s.is_active and s.user_id <> auth.uid()
                       and public._platform_staff_can(s.user_id, p_module, 'approve', p_merchant))
$$;
revoke execute on function public._platform_sole_approver(text, uuid) from public, anon, authenticated;
grant execute on function public._platform_sole_approver(text, uuid) to app_owner;

insert into public.tenancy_exempt_functions (name, reason)
values ('_platform_sole_approver', 'Two-person rule: checks whether any other active platform employee could approve a request')
on conflict (name) do nothing;

create or replace function public.platform_approvals_list(p_status text default 'PENDING')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_platform_staff() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.platform_approvals set status = 'EXPIRED' where status = 'PENDING' and expires_at <= now();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', a.id, 'action', a.action, 'module', a.module, 'summary', a.summary, 'reason', a.reason, 'status', a.status,
      'merchant', (select jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name) from public.merchants m where m.id = a.merchant_id),
      'requested_by', (select jsonb_build_object('id', s.user_id, 'name', coalesce(nullif(s.full_name, ''), s.email)) from public.platform_staff s where s.user_id = a.requested_by),
      'decided_by', (select jsonb_build_object('id', s.user_id, 'name', coalesce(nullif(s.full_name, ''), s.email)) from public.platform_staff s where s.user_id = a.decided_by),
      'requested_at', a.requested_at, 'expires_at', a.expires_at, 'decided_at', a.decided_at, 'decision_note', a.decision_note,
      'error', a.error, 'mine', a.requested_by = auth.uid(), 'self_approved', a.self_approved,
      'can_decide', a.status = 'PENDING' and public.platform_can(a.module, 'approve', a.merchant_id)
        and (a.requested_by <> auth.uid() or public._platform_sole_approver(a.module, a.merchant_id)))
      order by a.requested_at desc)
    from public.platform_approvals a
    where (p_status is null or a.status = p_status)
      and (a.requested_by = auth.uid() or public.platform_can(a.module, 'view', a.merchant_id))
      and a.requested_at > now() - interval '90 days'), '[]'::jsonb);
end;
$$;

create or replace function public.platform_approval_decide(p_id uuid, p_approve boolean, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a public.platform_approvals;
  v_result jsonb;
  v_self boolean := false;
begin
  select * into a from public.platform_approvals where id = p_id for update;
  if a.id is null then
    raise exception 'NOT_FOUND: request not found' using errcode = 'P0002';
  end if;
  if a.status <> 'PENDING' or a.expires_at <= now() then
    raise exception 'VALIDATION: this request is already %', lower(case when a.expires_at <= now() and a.status = 'PENDING' then 'EXPIRED' else a.status end) using errcode = '22023';
  end if;
  if a.requested_by = auth.uid() then
    -- The person asking can withdraw; approve only while nobody else could.
    if p_approve and public._platform_sole_approver(a.module, a.merchant_id) then
      v_self := true;
    elsif p_approve then
      raise exception 'PERMISSION_DENIED: a second person must approve this' using errcode = '42501';
    else
      update public.platform_approvals set status = 'CANCELLED', decided_at = now(), decision_note = p_note where id = a.id;
      perform public._platform_log('approval.cancelled', a.merchant_id, 'platform_approval', a.id::text, p_note, null, null);
      return jsonb_build_object('status', 'CANCELLED');
    end if;
  end if;
  perform public._platform_require(a.module, 'approve', a.merchant_id);
  if not p_approve then
    update public.platform_approvals set status = 'REJECTED', decided_by = auth.uid(), decided_at = now(), decision_note = p_note where id = a.id;
    perform public._platform_log('approval.rejected', a.merchant_id, 'platform_approval', a.id::text, p_note, null, jsonb_build_object('action', a.action));
    return jsonb_build_object('status', 'REJECTED');
  end if;
  if v_self then
    p_note := trim(coalesce(p_note, '') || ' (self-approved: nobody else could approve)');
  end if;
  begin
    v_result := public._platform_execute_approval(a);
  exception when others then
    update public.platform_approvals set status = 'FAILED', decided_by = auth.uid(), decided_at = now(), decision_note = p_note, error = sqlerrm, self_approved = v_self
      where id = a.id;
    perform public._platform_log('approval.failed', a.merchant_id, 'platform_approval', a.id::text, p_note, null,
      jsonb_build_object('action', a.action, 'error', sqlerrm, 'self_approved', v_self), 'FAILED');
    return jsonb_build_object('status', 'FAILED', 'error', sqlerrm);
  end;
  update public.platform_approvals set status = 'EXECUTED', decided_by = auth.uid(), decided_at = now(), decision_note = p_note, result = v_result, self_approved = v_self
    where id = a.id;
  perform public._platform_log('approval.executed', a.merchant_id, 'platform_approval', a.id::text, a.reason, null,
    jsonb_build_object('action', a.action, 'result', v_result, 'self_approved', v_self));
  return jsonb_build_object('status', 'EXECUTED', 'result', v_result);
end;
$$;

-- The delete request says whether the person asking may approve it themselves.
create or replace function public.platform_merchant_delete_request(p_merchant uuid, p_confirm_name text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  m public.merchants;
  v_id uuid;
begin
  perform public._platform_require('merchants', 'manage', p_merchant);
  perform public._platform_in_merchant(p_merchant);
  select * into m from public.merchants where id = p_merchant;
  if not found then
    raise exception 'NOT_FOUND: merchant not found' using errcode = 'P0002';
  end if;
  if m.deleted_at is not null then
    raise exception 'VALIDATION: this merchant was already deleted' using errcode = '22023';
  end if;
  if lower(trim(coalesce(p_confirm_name, ''))) <> lower(trim(m.name)) then
    raise exception 'VALIDATION: type the merchant''s name exactly as shown to confirm' using errcode = '22023';
  end if;
  if coalesce(length(trim(p_reason)), 0) < 10 then
    raise exception 'VALIDATION: explain why (at least 10 characters)' using errcode = '22023';
  end if;
  if public._platform_merchant_recent_export(p_merchant) is null then
    raise exception 'VALIDATION: download a full export of this merchant first (Data Management → Export), then ask within 24 hours'
      using errcode = '22023';
  end if;
  v_id := public.platform_request_approval('merchants', 'merchant_delete', m.id,
    format('Delete merchant #%s %s and all its data', m.number, m.name), jsonb_build_object('merchant_id', m.id, 'name', m.name), trim(p_reason));
  return jsonb_build_object('approval_id', v_id, 'can_self_approve', public._platform_sole_approver('merchants', m.id));
end;
$$;

select public._tenancy_own_functions();
