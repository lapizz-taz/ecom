-- Data Management → Deletion requests: once a request is approved and its
-- waiting period (deletion_cooling_days, 14 by default) is over, staff can
-- delete the whole merchant there, not only erase its customers' personal data.
-- The same rules as the request flow: someone other than the approver carries it
-- out, types the merchant's name, and a full export was taken in the last 24
-- hours. It removes what Merchants → Delete removes (money records and audit
-- trails stay under "Deleted merchant #N") and completes the request.

create or replace function public.platform_deletion_request_delete_merchant(p_id uuid, p_confirm text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.merchant_deletion_requests;
  m public.merchants;
  a public.platform_approvals;
  v_result jsonb;
begin
  select * into r from public.merchant_deletion_requests where id = p_id for update;
  if r.id is null then
    raise exception 'NOT_FOUND: request not found' using errcode = 'P0002';
  end if;
  perform public._platform_require('data', 'manage', r.merchant_id);
  perform public._platform_require('merchants', 'manage', r.merchant_id);
  select * into m from public.merchants where id = r.merchant_id;
  if r.status <> 'APPROVED' then
    raise exception 'VALIDATION: only an approved request can be carried out' using errcode = '22023';
  end if;
  if r.erase_after > now() then
    raise exception 'VALIDATION: the waiting period ends %', to_char(r.erase_after at time zone 'Asia/Dhaka', 'DD Mon YYYY HH24:MI') using errcode = '22023';
  end if;
  if r.decided_by = auth.uid() then
    raise exception 'VALIDATION: the person who approved it cannot also delete the merchant' using errcode = '22023';
  end if;
  if m.deleted_at is not null then
    raise exception 'VALIDATION: this merchant was already deleted' using errcode = '22023';
  end if;
  if lower(trim(coalesce(p_confirm, ''))) <> lower(trim(m.name)) then
    raise exception 'VALIDATION: type the merchant''s name exactly to confirm' using errcode = '22023';
  end if;

  -- Completed first (the store reset inside refuses while a request is still open);
  -- if anything below fails, the whole transaction, this included, is undone.
  update public.merchant_deletion_requests set status = 'COMPLETED', completed_by = auth.uid(), completed_at = now() where id = p_id;

  -- The merchant delete reads the merchant, the reason and (for the log) an approval id.
  a.merchant_id := m.id;
  a.reason := format('Deletion request #%s: %s', r.number, r.reason);
  v_result := public._platform_merchant_delete(a);

  update public.merchant_deletion_requests
  set result = coalesce(v_result -> 'deleted', '{}'::jsonb) || jsonb_build_object('logins_removed', coalesce((v_result ->> 'logins_removed')::int, 0))
  where id = p_id returning * into r;
  perform public._platform_log('data.merchant_deleted', m.id, 'deletion_request', r.id::text, r.reason, null, v_result);
  return public._deletion_request_json(r);
end;
$$;

revoke execute on function public.platform_deletion_request_delete_merchant(uuid, text) from public, anon;
grant execute on function public.platform_deletion_request_delete_merchant(uuid, text) to authenticated;

insert into public.tenancy_exempt_functions (name, reason) values
  ('platform_deletion_request_delete_merchant', 'Super Admin Data Management: deletes one merchant after its approved deletion request waited out, permission-checked')
on conflict (name) do nothing;

select public._tenancy_own_functions();
