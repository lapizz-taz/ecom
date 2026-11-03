-- =============================================================================
-- Call tracking: did the staff really try to call the customer? For the Owner and Admins only.
--
-- Asked for on 3 Nov 2026. Until calls go through Cloud Calling (which records the call itself),
-- Fullfilio records what it can see, with who and when:
--   * TAP: a staff member tapped Call on an order (the phone link or the click-to-call button).
--   * STATUS: a staff member set a call status (No response, Follow-up, Cancelled, …), every time,
--     also when it is the same status again.
--   * APPROVED: the order was approved (by whom; nobody for an automatic approval).
-- A tap proves the Call button was used, not that the customer answered.
--
-- Employees see none of it: the events are read only through order_call_history() and calls_report(),
-- which need the new permission calls.view (the Owner always has it; it is given to Admin). Recording
-- a tap needs only orders.view and returns nothing.
--
-- New: order_call_events, permission calls.view, order_call_tap(), order_call_history(), calls_report().
-- Safe to re-run.
-- =============================================================================

create table if not exists public.order_call_events (
  -- A running number: the order things happened in, even within the same millisecond.
  id bigint generated always as identity primary key,
  merchant_id uuid not null default public.current_merchant_id() references public.merchants(id),
  order_id uuid not null references public.orders(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  kind text not null check (kind in ('TAP', 'STATUS', 'APPROVED')),
  status text check (length(status) <= 60),
  source text check (length(source) <= 40),
  -- The real moment, so a tap, a status and an approval in one request keep their order.
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists order_call_events_time_idx on public.order_call_events (merchant_id, created_at desc);
create index if not exists order_call_events_order_idx on public.order_call_events (order_id, created_at);

do $$
begin
  alter table public.order_call_events enable row level security;
  drop policy if exists tenant_isolation on public.order_call_events;
  create policy tenant_isolation on public.order_call_events as restrictive for all to public
    using (merchant_id = (select public.current_merchant_id()))
    with check (merchant_id = (select public.current_merchant_id()) and not (select public._support_read_only()));
  drop policy if exists app_owner_all on public.order_call_events;
  create policy app_owner_all on public.order_call_events for all to app_owner using (true) with check (true);
  revoke all on public.order_call_events from anon, authenticated;
end $$;

-- ---------------------------------------------------------------- permission (Owner and Admin)
insert into public.permissions(code, module, name) values
  ('calls.view', 'orders', 'See who called each customer, how many times, and the calls report')
on conflict (code) do nothing;

-- Every business's Admin role, one business at a time (the audit log belongs to that business).
do $$
declare m record;
begin
  for m in select id from public.merchants loop
    perform set_config('app.merchant_id', m.id::text, true);
    insert into public.role_permissions (merchant_id, role_id, permission_id)
    select r.merchant_id, r.id, p.id
    from public.roles r join public.permissions p on p.code = 'calls.view'
    where r.merchant_id = m.id and r.code = 'ADMIN'
    on conflict do nothing;
  end loop;
end $$;

-- New businesses: their Admin role gets it too.
create or replace function public._roles_seed_call_tracking()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.code = 'ADMIN' then
    insert into public.role_permissions (merchant_id, role_id, permission_id)
    select new.merchant_id, new.id, p.id from public.permissions p where p.code = 'calls.view'
    on conflict do nothing;
  end if;
  return new;
end;
$$;
revoke all on function public._roles_seed_call_tracking() from public, anon, authenticated;
drop trigger if exists roles_seed_call_tracking on public.roles;
create trigger roles_seed_call_tracking after insert on public.roles for each row execute function public._roles_seed_call_tracking();

-- ---------------------------------------------------------------- recording
-- A call status set, or an approval: recorded with who did it. A problem here never stops the order.
create or replace function public._order_call_events()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (new.review_updated_at is distinct from old.review_updated_at or new.contact_attempts is distinct from old.contact_attempts
      or new.review_status is distinct from old.review_status) and new.review_updated_by is not null then
    insert into public.order_call_events (merchant_id, order_id, actor_id, kind, status)
    values (new.merchant_id, new.id, new.review_updated_by, 'STATUS', left(new.review_status, 60));
  end if;
  if old.confirmed_at is null and new.confirmed_at is not null then
    insert into public.order_call_events (merchant_id, order_id, actor_id, kind)
    -- approved_by is filled a moment later: the person approving is the one signed in (nobody: automatic).
    values (new.merchant_id, new.id, coalesce(new.approved_by, auth.uid()), 'APPROVED');
  end if;
  return null;
exception when others then
  raise warning 'calls: order % not recorded: %', new.id, sqlerrm;
  return null;
end;
$$;
revoke all on function public._order_call_events() from public, anon, authenticated;
drop trigger if exists orders_call_events on public.orders;
create trigger orders_call_events after update of review_updated_at, review_status, contact_attempts, confirmed_at on public.orders
  for each row when (old.review_updated_at is distinct from new.review_updated_at or old.contact_attempts is distinct from new.contact_attempts
    or old.review_status is distinct from new.review_status or (old.confirmed_at is null and new.confirmed_at is not null))
  execute function public._order_call_events();

-- A tap on Call for an order. Anyone who can see the order; nothing comes back. A double tap counts once.
create or replace function public.order_call_tap(p_order uuid, p_source text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
begin
  perform public.require_permission('orders.view');
  if p_order is null or v_user is null or not exists (select 1 from public.orders where id = p_order) then
    return;
  end if;
  if exists (select 1 from public.order_call_events e
             where e.order_id = p_order and e.actor_id = v_user and e.kind = 'TAP' and e.created_at > clock_timestamp() - interval '15 seconds') then
    return;
  end if;
  insert into public.order_call_events (order_id, actor_id, kind, source)
  values (p_order, v_user, 'TAP', left(nullif(trim(coalesce(p_source, '')), ''), 40));
end;
$$;

-- ---------------------------------------------------------------- reading (calls.view)
-- One order: every tap, call status and approval, oldest first, with who did it.
create or replace function public.order_call_history(p_order uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('calls.view');
  return jsonb_build_object(
    'taps', (select count(*) from public.order_call_events where order_id = p_order and kind = 'TAP'),
    'statuses', (select count(*) from public.order_call_events where order_id = p_order and kind = 'STATUS'),
    'not_reached', (select count(*) from public.order_call_events e
                    join public.order_review_statuses s on s.code = e.status and s.counts_contact
                    where e.order_id = p_order and e.kind = 'STATUS'),
    'events', coalesce((select jsonb_agg(jsonb_build_object(
        'kind', e.kind, 'status', e.status, 'status_label', s.label, 'source', e.source, 'at', e.created_at,
        'actor_id', e.actor_id, 'actor_name', pr.full_name) order by e.id)
      from public.order_call_events e
      left join public.order_review_statuses s on s.code = e.status
      left join public.profiles pr on pr.id = e.actor_id
      where e.order_id = p_order), '[]'::jsonb));
end;
$$;

-- Everyone's calls between two times: per staff member, the orders closed without any tap on Call,
-- and the web orders still waiting that nobody has tapped Call on. p: {from, to}
create or replace function public.calls_report(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_from timestamptz := coalesce(nullif(p ->> 'from', '')::timestamptz, date_trunc('day', now()));
  v_to timestamptz := coalesce(nullif(p ->> 'to', '')::timestamptz, clock_timestamp());
begin
  perform public.require_permission('calls.view');
  return jsonb_build_object(
    'from', v_from, 'to', v_to,
    'staff', coalesce((select jsonb_agg(x.row order by x.taps desc, x.name) from (
      select pr.full_name as name, count(*) filter (where e.kind = 'TAP') as taps, jsonb_build_object(
        'user_id', pr.id, 'name', pr.full_name, 'role', r.name,
        'taps', count(*) filter (where e.kind = 'TAP'),
        'orders_called', count(distinct e.order_id) filter (where e.kind = 'TAP'),
        'statuses', count(*) filter (where e.kind = 'STATUS'),
        'not_reached', count(*) filter (where e.kind = 'STATUS' and s.counts_contact),
        'approved', count(*) filter (where e.kind = 'APPROVED'),
        'closed', count(*) filter (where e.kind = 'STATUS' and s.closes_order),
        'without_call', count(*) filter (where (e.kind = 'APPROVED' or (e.kind = 'STATUS' and s.closes_order))
          and not exists (select 1 from public.order_call_events t where t.order_id = e.order_id and t.kind = 'TAP' and t.id < e.id))
      ) as row
      from public.order_call_events e
      join public.profiles pr on pr.id = e.actor_id
      left join public.roles r on r.id = pr.role_id
      left join public.order_review_statuses s on s.code = e.status and e.kind = 'STATUS'
      where e.created_at >= v_from and e.created_at < v_to
      group by pr.id, pr.full_name, r.name) x), '[]'::jsonb),
    'automatic_approvals', (select count(*) from public.order_call_events e
                            where e.kind = 'APPROVED' and e.actor_id is null and e.created_at >= v_from and e.created_at < v_to),
    'without_call', coalesce((select jsonb_agg(y.row order by y.at desc) from (
      select e.created_at as at, jsonb_build_object(
        'order_id', o.id, 'order_number', o.order_number, 'customer_name', o.customer_name,
        'outcome', case when e.kind = 'APPROVED' then 'Approved' else coalesce(s.label, e.status) end,
        'actor_name', pr.full_name, 'at', e.created_at) as row
      from public.order_call_events e
      join public.orders o on o.id = e.order_id
      left join public.order_review_statuses s on s.code = e.status
      left join public.profiles pr on pr.id = e.actor_id
      where e.created_at >= v_from and e.created_at < v_to and e.actor_id is not null
        and (e.kind = 'APPROVED' or (e.kind = 'STATUS' and s.closes_order))
        and not exists (select 1 from public.order_call_events t where t.order_id = e.order_id and t.kind = 'TAP' and t.id < e.id)
      order by e.created_at desc limit 200) y), '[]'::jsonb),
    'never_called', jsonb_build_object(
      'count', (select count(*) from public.orders o
                where o.confirmed_at is null and o.status not in ('CANCELLED', 'REJECTED_FRAUD')
                  and o.created_at < now() - interval '1 hour'
                  and not exists (select 1 from public.order_call_events t where t.order_id = o.id and t.kind = 'TAP')),
      'items', coalesce((select jsonb_agg(z.row order by z.at) from (
        select o.created_at as at, jsonb_build_object('order_id', o.id, 'order_number', o.order_number,
          'customer_name', o.customer_name, 'created_at', o.created_at, 'status', o.review_status) as row
        from public.orders o
        where o.confirmed_at is null and o.status not in ('CANCELLED', 'REJECTED_FRAUD')
          and o.created_at < now() - interval '1 hour'
          and not exists (select 1 from public.order_call_events t where t.order_id = o.id and t.kind = 'TAP')
        order by o.created_at limit 50) z), '[]'::jsonb)));
end;
$$;

revoke all on function public.order_call_tap(uuid, text), public.order_call_history(uuid), public.calls_report(jsonb) from public, anon;
grant execute on function public.order_call_tap(uuid, text), public.order_call_history(uuid), public.calls_report(jsonb) to authenticated, service_role;

select public._tenancy_own_functions();
