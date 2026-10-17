-- =============================================================================
-- Auto Order Dashboard: show the customers a queue is holding back.
--
-- Good but no response and No response wait 30 minutes after a call before the
-- customer comes up again, and On hold waits for its call-back time. Until now
-- those customers simply did not count, so a queue read 0 while Web Orders
-- listed them. The dashboard now also returns, per queue, how many are waiting
-- and when the first of them is ready.
-- =============================================================================

create or replace function public.auto_order_dashboard()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
  v_today timestamptz := public._ts_from(public._local_date(now()));
  v_queues jsonb;
  v_waiting jsonb;
begin
  perform public.require_permission('orders.view');
  select jsonb_object_agg(q.key, (
      select count(*) from public.orders o
      where public._auto_queue_has(q.key, o)
        and (o.assigned_to is null or o.assigned_to = v_me)
        and not exists (select 1 from public.call_claims c
                        where c.ref_kind = 'ORDER' and c.ref_id = o.id and c.expires_at > now() and c.claimed_by <> v_me)))
    into v_queues
  from unnest(array['processing', 'good_no_response', 'no_response', 'advance_payment', 'on_hold']) q(key);

  -- In the queue's status but not yet due: called under 30 minutes ago, or a call-back still ahead.
  select jsonb_object_agg(q.key, jsonb_build_object('count', w.n, 'next_at', w.next_at))
    into v_waiting
  from (values ('good_no_response', 'GOOD_NO_RESPONSE'), ('no_response', 'NO_RESPONSE'), ('on_hold', 'FOLLOW_UP')) q(key, code)
  cross join lateral (
    select count(*) as n,
           min(case when q.key = 'on_hold' then o.follow_up_at else o.last_contact_at + interval '30 minutes' end) as next_at
    from public.orders o
    where o.review_status = q.code
      and o.confirmed_at is null and o.merged_into is null
      and o.status not in ('CANCELLED', 'REJECTED_FRAUD', 'FRAUD_REVIEW', 'ADVANCE_REQUIRED')
      and (o.assigned_to is null or o.assigned_to = v_me)
      and not public._auto_queue_has(q.key, o)
  ) w;

  return jsonb_build_object(
    'queues', v_queues || jsonb_build_object('incomplete', (
      select count(*) from public.checkout_leads l
      where public._auto_lead_open(l)
        and not exists (select 1 from public.call_claims c
                        where c.ref_kind = 'LEAD' and c.ref_id = l.id and c.expires_at > now() and c.claimed_by <> v_me))),
    'waiting', coalesce(v_waiting, '{}'::jsonb),
    'report', jsonb_build_object(
      'taken', (select count(*) from public.orders o where o.assigned_to = v_me and o.assigned_at >= v_today),
      'approved', (select count(*) from public.orders o where o.approved_by = v_me and o.confirmed_at >= v_today),
      'shipped', (select count(*) from public.orders o where o.approved_by = v_me and o.shipped_at >= v_today),
      'delivered', (select count(*) from public.orders o where o.approved_by = v_me and o.delivered_at >= v_today),
      'returned', (select count(*) from public.orders o where o.approved_by = v_me and o.returned_at >= v_today)),
    'claim', (select jsonb_build_object('kind', c.ref_kind, 'id', c.ref_id, 'queue', c.queue, 'expires_at', c.expires_at)
              from public.call_claims c where c.claimed_by = v_me and c.expires_at > now()
              order by c.claimed_at desc limit 1));
end;
$$;

select public._tenancy_own_functions();
