-- =============================================================================
-- Auto Order Dashboard: call queues an agent works through with "Open next"
--
--   * Queues: Processing, Incomplete (checkouts with no order), Good but no
--     response, No response, Advance payment, On hold (call-backs that are due).
--   * "Open next" claims the next order (or incomplete checkout) for the agent
--     who asked, so two agents never get the same customer at once; the claim
--     ends when the order's status changes or after 15 minutes.
--   * Orders Auto Pick gave to someone else stay with them.
--   * My daily report: orders taken today and how the agent's orders moved
--     today (shipped, delivered, returned).
--   * Auto Pick round robin: agents assigned in one batch no longer tie on the
--     same timestamp (which sent every order after the first round to one agent).
-- =============================================================================

create table if not exists public.call_claims (
  merchant_id uuid not null default public.current_merchant_id() references public.merchants(id),
  ref_kind text not null check (ref_kind in ('ORDER', 'LEAD')),
  ref_id uuid not null,
  queue text not null,
  claimed_by uuid not null references public.profiles(id) on delete cascade,
  claimed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (merchant_id, ref_kind, ref_id)
);
create index if not exists call_claims_agent_idx on public.call_claims (merchant_id, claimed_by);

alter table public.call_claims enable row level security;
create policy tenant_isolation on public.call_claims as restrictive for all to public
  using (merchant_id = (select public.current_merchant_id()))
  with check (merchant_id = (select public.current_merchant_id()) and not (select public._support_read_only()));
create policy app_owner_all on public.call_claims for all to app_owner using (true) with check (true);
revoke all on public.call_claims from anon, authenticated;
grant select on public.call_claims to authenticated;
create policy call_claims_read on public.call_claims for select to authenticated
  using ((select public.has_permission('orders.view')));

-- How long an opened customer stays with the agent who opened them.
create or replace function public._call_claim_minutes()
returns int
language sql
immutable
as $$ select 15 $$;

-- Is this web order in the queue, as far as the queue's own rule goes?
create or replace function public._auto_queue_has(p_queue text, o public.orders)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select o.confirmed_at is null and o.merged_into is null
    and o.status not in ('CANCELLED', 'REJECTED_FRAUD', 'FRAUD_REVIEW')
    and o.review_status in (select code from public.order_review_statuses where not closes_order)
    and case p_queue
      when 'processing' then o.review_status = 'PROCESSING' and o.status <> 'ADVANCE_REQUIRED'
      when 'good_no_response' then o.review_status = 'GOOD_NO_RESPONSE' and o.status <> 'ADVANCE_REQUIRED'
        and (o.last_contact_at is null or o.last_contact_at < now() - interval '30 minutes')
      when 'no_response' then o.review_status = 'NO_RESPONSE' and o.status <> 'ADVANCE_REQUIRED'
        and (o.last_contact_at is null or o.last_contact_at < now() - interval '30 minutes')
      when 'advance_payment' then o.status = 'ADVANCE_REQUIRED'
      when 'on_hold' then o.review_status = 'FOLLOW_UP' and o.status <> 'ADVANCE_REQUIRED'
        and (o.follow_up_at is null or o.follow_up_at <= now())
      else false end
$$;

-- An incomplete checkout to call: still open, no order, and the visitor left at least 10 minutes ago.
create or replace function public._auto_lead_open(l public.checkout_leads)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select l.status = 'OPEN' and l.order_id is null and l.updated_at < now() - interval '10 minutes'
$$;

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
  return jsonb_build_object(
    'queues', v_queues || jsonb_build_object('incomplete', (
      select count(*) from public.checkout_leads l
      where public._auto_lead_open(l)
        and not exists (select 1 from public.call_claims c
                        where c.ref_kind = 'LEAD' and c.ref_id = l.id and c.expires_at > now() and c.claimed_by <> v_me))),
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

-- Claims the next customer in a queue for the agent asking, and returns it.
create or replace function public.auto_order_open_next(p_queue text, p_skip uuid[] default '{}')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
  v_id uuid;
  v_kind text := case when p_queue = 'incomplete' then 'LEAD' else 'ORDER' end;
begin
  if not (public.has_permission('orders.update') or public.has_permission('orders.status')) then
    raise exception 'PERMISSION_DENIED: orders.update is required' using errcode = '42501';
  end if;
  if p_queue not in ('processing', 'incomplete', 'good_no_response', 'no_response', 'advance_payment', 'on_hold') then
    raise exception 'VALIDATION: unknown queue %', p_queue using errcode = '22023';
  end if;
  delete from public.call_claims where claimed_by = v_me;

  if v_kind = 'ORDER' then
    select o.id into v_id from public.orders o
    where public._auto_queue_has(p_queue, o)
      and (o.assigned_to is null or o.assigned_to = v_me)
      and not (o.id = any(coalesce(p_skip, '{}')))
      and not exists (select 1 from public.call_claims c
                      where c.ref_kind = 'ORDER' and c.ref_id = o.id and c.expires_at > now())
    order by
      -- The agent's own orders first, then the queue's order.
      (o.assigned_to = v_me) desc nulls last,
      case when p_queue = 'on_hold' then o.follow_up_at end nulls last,
      case when p_queue in ('no_response', 'good_no_response') then o.contact_attempts end,
      case when p_queue in ('no_response', 'good_no_response') then o.last_contact_at end nulls first,
      o.created_at
    limit 1
    for update of o skip locked;
    if v_id is null then
      return null;
    end if;
    update public.orders set assigned_to = v_me, assigned_at = clock_timestamp() where id = v_id and assigned_to is null;
  else
    select l.id into v_id from public.checkout_leads l
    where public._auto_lead_open(l)
      and not (l.id = any(coalesce(p_skip, '{}')))
      and not exists (select 1 from public.call_claims c
                      where c.ref_kind = 'LEAD' and c.ref_id = l.id and c.expires_at > now())
    order by l.updated_at
    limit 1
    for update of l skip locked;
    if v_id is null then
      return null;
    end if;
  end if;

  insert into public.call_claims (ref_kind, ref_id, queue, claimed_by, expires_at)
  values (v_kind, v_id, p_queue, v_me, now() + make_interval(mins => public._call_claim_minutes()))
  on conflict (merchant_id, ref_kind, ref_id) do update
    set queue = excluded.queue, claimed_by = excluded.claimed_by, claimed_at = now(), expires_at = excluded.expires_at;
  return jsonb_build_object('kind', v_kind, 'id', v_id, 'queue', p_queue);
end;
$$;

-- Lets go of whatever the agent has open (leaving the dashboard).
create or replace function public.auto_order_release()
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  delete from public.call_claims where claimed_by = auth.uid()
$$;

-- A status change ends the claim, so the customer is free for the next agent.
create or replace function public._orders_release_claim()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.call_claims where ref_kind = 'ORDER' and ref_id = new.id;
  return null;
end;
$$;
create trigger orders_release_claim after update of review_status, confirmed_at, status on public.orders
  for each row when (old.review_status is distinct from new.review_status or old.confirmed_at is distinct from new.confirmed_at
                     or old.status is distinct from new.status)
  execute function public._orders_release_claim();

create or replace function public._leads_release_claim()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.call_claims where ref_kind = 'LEAD' and ref_id = new.id;
  return null;
end;
$$;
create trigger checkout_leads_release_claim after update of status, contact_count on public.checkout_leads
  for each row when (old.status is distinct from new.status or old.contact_count is distinct from new.contact_count)
  execute function public._leads_release_claim();

-- ---------------------------------------------------------------------------
-- Auto Pick: one distinct time per assignment, so round robin keeps turning
-- inside a batch (Assign waiting, a store import of many orders).
-- ---------------------------------------------------------------------------
create or replace function public._orders_auto_pick()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.assigned_to is null and new.confirmed_at is null then
    new.assigned_to := public._auto_pick_agent();
    if new.assigned_to is not null then
      new.assigned_at := clock_timestamp();
    end if;
  end if;
  return new;
exception when others then
  -- Assignment must never stop an order from being saved.
  perform public._log_system_event('WARN', 'JOB', 'auto-pick', 'Auto Pick could not assign an order: ' || sqlerrm, '{}'::jsonb);
  return new;
end;
$$;

create or replace function public.auto_pick_run()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order record;
  v_agent uuid;
  v_count int := 0;
begin
  perform public.require_permission('orders.assign');
  if not coalesce((public.get_setting('auto_pick') ->> 'enabled')::boolean, false) then
    raise exception 'VALIDATION: turn Auto Pick on first' using errcode = '22023';
  end if;
  for v_order in
    select id from public.orders
    where assigned_to is null and confirmed_at is null and status not in ('CANCELLED', 'REJECTED_FRAUD')
      and review_status in (select code from public.order_review_statuses where not closes_order)
    order by created_at
    for update skip locked
  loop
    v_agent := public._auto_pick_agent();
    exit when v_agent is null;
    update public.orders set assigned_to = v_agent, assigned_at = clock_timestamp() where id = v_order.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public._call_claim_minutes(), public._auto_queue_has(text, public.orders), public._auto_lead_open(public.checkout_leads),
  public._orders_release_claim(), public._leads_release_claim() from public, anon, authenticated;
revoke all on function public.auto_order_dashboard(), public.auto_order_open_next(text, uuid[]), public.auto_order_release() from public, anon;
grant execute on function public.auto_order_dashboard(), public.auto_order_open_next(text, uuid[]), public.auto_order_release() to authenticated;

select public._tenancy_own_functions();

alter function public.auto_order_dashboard() owner to app_owner;
alter function public.auto_order_open_next(text, uuid[]) owner to app_owner;
alter function public.auto_order_release() owner to app_owner;
alter function public._orders_release_claim() owner to app_owner;
alter function public._leads_release_claim() owner to app_owner;
alter function public._orders_auto_pick() owner to app_owner;
alter function public.auto_pick_run() owner to app_owner;
