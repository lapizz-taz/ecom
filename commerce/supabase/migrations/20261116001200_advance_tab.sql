-- Web Orders: orders waiting for the fraud-check advance get their own tab ("Advance
-- due", beside Incomplete) instead of sitting in Processing or another call tab. Until
-- the advance is paid there is nobody to call about them, so the call tabs leave them
-- out and the new tab counts them.

create or replace function public.admin_order_queue_counts()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('orders.view');
  return jsonb_build_object(
    'web', coalesce((select jsonb_object_agg(review_status, n) from (
      select review_status, count(*) as n from public.orders
      where confirmed_at is null and status <> 'ADVANCE_REQUIRED' group by review_status) s), '{}'::jsonb),
    'approved', coalesce((select jsonb_object_agg(stage, n) from (
      select public.order_stage(status, confirmed_at) as stage, count(*) as n
      from public.orders where confirmed_at is not null group by 1) s), '{}'::jsonb),
    'follow_up_due', (select count(*) from public.orders where confirmed_at is null and follow_up_at <= now()
                        and status not in ('CANCELLED', 'REJECTED_FRAUD', 'ADVANCE_REQUIRED')),
    'incomplete', (select count(*) from public.checkout_leads where status in ('OPEN', 'CONTACTED')),
    'advance', (select count(*) from public.orders where confirmed_at is null and status = 'ADVANCE_REQUIRED')
  );
end;
$$;
