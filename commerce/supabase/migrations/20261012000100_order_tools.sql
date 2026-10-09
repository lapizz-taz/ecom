-- =============================================================================
-- Order tools
--   * Order Block List: phone numbers, IP addresses and addresses, temporary or
--     permanent, enforced when an order is placed online
--   * Assigned agent + Auto Pick: new web orders are handed to call agents
--     (round robin or least busy)
--   * Call queue: the next web order an agent should call
--   * Super Edit: owner / admin override of status and courier details, with a
--     reason, a fresh sign-in and a full audit trail
--   * Orders dashboard: approved-order flow per day, per courier and ageing
-- =============================================================================

insert into public.permissions(code, module, name) values
  ('orders.override', 'orders', 'Super Edit: override order status and courier details'),
  ('orders.block', 'orders', 'Manage the order block list'),
  ('orders.assign', 'orders', 'Assign web orders to agents and set up Auto Pick')
on conflict (code) do nothing;

insert into public.role_permissions(role_id, permission_id)
select r.id, p.id
from (values
  ('ADMIN', 'orders.override'), ('ADMIN', 'orders.block'), ('ADMIN', 'orders.assign'),
  ('MANAGER', 'orders.block'), ('MANAGER', 'orders.assign'),
  ('ORDER_MANAGER', 'orders.block'), ('ORDER_MANAGER', 'orders.assign')
) g(role_code, perm)
join public.roles r on r.code = g.role_code
join public.permissions p on p.code = g.perm
on conflict do nothing;

alter table public.orders
  add column if not exists assigned_to uuid references public.profiles(id),
  add column if not exists assigned_at timestamptz,
  add column if not exists client_ip text check (client_ip is null or length(client_ip) <= 64),
  add column if not exists user_agent text check (user_agent is null or length(user_agent) <= 400);
create index if not exists orders_assigned_open_idx on public.orders(assigned_to, created_at desc) where confirmed_at is null;
create index if not exists orders_client_ip_idx on public.orders(client_ip) where client_ip is not null;

insert into public.settings(key, is_public, description, value) values
  ('auto_pick', false, 'Hand new web orders to call agents automatically', jsonb_build_object(
    'enabled', false, 'mode', 'round_robin', 'agent_ids', '[]'::jsonb, 'max_open', 0))
on conflict (key) do nothing;

-- -----------------------------------------------------------------------------
-- Block list
-- -----------------------------------------------------------------------------
create table if not exists public.order_blocks (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('PHONE', 'IP', 'ADDRESS')),
  value text not null check (length(value) between 3 and 300),
  reason text not null check (length(trim(reason)) between 3 and 500),
  expires_at timestamptz,
  is_active boolean not null default true,
  source_order_id uuid references public.orders(id),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  lifted_at timestamptz,
  lifted_by uuid references public.profiles(id),
  lift_reason text
);
create unique index if not exists order_blocks_active_uq on public.order_blocks(kind, value) where is_active;
create index if not exists order_blocks_created_idx on public.order_blocks(created_at desc);

alter table public.order_blocks enable row level security;
revoke all on public.order_blocks from anon, authenticated;
grant select on public.order_blocks to authenticated;
grant all on public.order_blocks to service_role;
create policy order_blocks_read on public.order_blocks for select to authenticated
  using ((select public.has_permission('orders.view')));

create or replace function public._block_value(p_kind text, p_value text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case upper(p_kind)
    when 'PHONE' then coalesce(public.clean_phone(p_value), regexp_replace(coalesce(p_value, ''), '\D', '', 'g'))
    when 'IP' then lower(trim(coalesce(p_value, '')))
    else lower(regexp_replace(trim(coalesce(p_value, '')), '\s+', ' ', 'g'))
  end
$$;

-- The active block that matches an order, if any.
create or replace function public.order_block_match(p_phone text, p_ip text default null, p_address text default null)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select to_jsonb(b) - 'created_by' - 'lifted_by' from public.order_blocks b
  where b.is_active and (b.expires_at is null or b.expires_at > now())
    and ((b.kind = 'PHONE' and b.value = public._block_value('PHONE', p_phone))
      or (b.kind = 'IP' and p_ip is not null and b.value = public._block_value('IP', p_ip))
      or (b.kind = 'ADDRESS' and p_address is not null and length(b.value) >= 8
          and public._block_value('ADDRESS', p_address) like '%' || b.value || '%'))
  order by b.created_at
  limit 1
$$;

-- Online orders from a blocked phone, IP or address are refused (staff can
-- still enter an order by hand after talking to the customer).
create or replace function public._orders_block_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.source = 'STOREFRONT' and public.order_block_match(new.customer_phone, new.client_ip, new.shipping_address) is not null then
    raise exception 'ORDER_BLOCKED: %', public.setting_text('fraud', array['messages', 'blocked'],
      'We are unable to accept this order online. Please contact us to complete your purchase.') using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create or replace trigger orders_block_guard before insert on public.orders
  for each row execute function public._orders_block_guard();

-- Saved by the checkout function: where the order was placed from.
create or replace function public.record_order_client(p_order_id uuid, p_ip text, p_user_agent text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.orders set client_ip = left(nullif(trim(p_ip), 'unknown'), 64), user_agent = left(p_user_agent, 400)
  where id = p_order_id and client_ip is null;
end;
$$;

create or replace function public.admin_block_add(
  p_kind text, p_value text, p_reason text, p_expires_at timestamptz default null, p_order_id uuid default null
)
returns public.order_blocks
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind text := upper(coalesce(p_kind, ''));
  v_value text := nullif(trim(coalesce(p_value, '')), '');
  v_order public.orders;
  v_row public.order_blocks;
begin
  perform public.require_permission('orders.block');
  if v_kind not in ('PHONE', 'IP', 'ADDRESS') then
    raise exception 'VALIDATION: choose phone, IP address or address' using errcode = '22023';
  end if;
  if p_order_id is not null then
    select * into v_order from public.orders where id = p_order_id;
    if not found then
      raise exception 'NOT_FOUND: order not found' using errcode = 'P0002';
    end if;
    v_value := coalesce(v_value, case v_kind when 'PHONE' then v_order.customer_phone when 'IP' then v_order.client_ip
                                              else v_order.shipping_address end);
  end if;
  if v_value is null then
    raise exception 'VALIDATION: %', case v_kind when 'IP' then 'this order has no IP address recorded' else 'enter what to block' end using errcode = '22023';
  end if;
  v_value := public._block_value(v_kind, v_value);
  if v_kind = 'PHONE' and v_value !~ '^01[3-9][0-9]{8}$' then
    raise exception 'VALIDATION: enter a Bangladeshi mobile number (01XXXXXXXXX)' using errcode = '22023';
  end if;
  if v_kind = 'IP' and v_value !~ '^[0-9a-f:.]{3,45}$' then
    raise exception 'VALIDATION: that is not an IP address' using errcode = '22023';
  end if;
  if v_kind = 'ADDRESS' and length(v_value) < 8 then
    raise exception 'VALIDATION: write at least 8 characters of the address' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'VALIDATION: give a reason for the block' using errcode = '22023';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'VALIDATION: the block must end in the future' using errcode = '22023';
  end if;
  if exists (select 1 from public.order_blocks where kind = v_kind and value = v_value and is_active) then
    raise exception 'DUPLICATE: % is already blocked', v_value using errcode = '23505';
  end if;

  insert into public.order_blocks(kind, value, reason, expires_at, source_order_id, created_by)
  values (v_kind, v_value, trim(p_reason), p_expires_at, p_order_id, auth.uid())
  returning * into v_row;

  -- A permanently blocked phone also blocks the customer record (fraud rule "Blocked customer").
  if v_kind = 'PHONE' and p_expires_at is null then
    update public.customers set status = 'BLOCKED', blocked_reason = left('Block list: ' || trim(p_reason), 500)
    where phone = v_value and status <> 'BLOCKED';
  end if;
  perform public.log_audit('order_block.created', 'order_block', v_row.id::text, null, to_jsonb(v_row), '{}'::jsonb);
  return v_row;
end;
$$;

create or replace function public.admin_block_lift(p_id uuid, p_reason text default null)
returns public.order_blocks
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.order_blocks;
begin
  perform public.require_permission('orders.block');
  update public.order_blocks set is_active = false, lifted_at = now(), lifted_by = auth.uid(), lift_reason = nullif(trim(coalesce(p_reason, '')), '')
  where id = p_id and is_active returning * into v_row;
  if not found then
    raise exception 'NOT_FOUND: this block is not active' using errcode = 'P0002';
  end if;
  if v_row.kind = 'PHONE' then
    update public.customers set status = 'ACTIVE', blocked_reason = null
    where phone = v_row.value and status = 'BLOCKED' and blocked_reason like 'Block list:%';
  end if;
  perform public.log_audit('order_block.removed', 'order_block', v_row.id::text, null, to_jsonb(v_row), '{}'::jsonb);
  return v_row;
end;
$$;

-- Blocks with the history behind them (orders, delivered, returned, cancelled).
create or replace function public.admin_block_list(p_status text default 'active', p_kind text default null, p_q text default null,
  p_limit int default 50, p_offset int default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_q text := nullif(trim(coalesce(p_q, '')), '');
begin
  perform public.require_permission('orders.view');
  return jsonb_build_object(
    'total', (select count(*) from public.order_blocks b
      where (p_kind is null or b.kind = p_kind)
        and (v_q is null or b.value ilike '%' || v_q || '%' or b.reason ilike '%' || v_q || '%')
        and case coalesce(p_status, 'active')
              when 'active' then b.is_active and (b.expires_at is null or b.expires_at > now())
              when 'expired' then b.is_active and b.expires_at <= now()
              when 'lifted' then not b.is_active
              else true end),
    'items', coalesce((select jsonb_agg(r order by r.created_at desc) from (
      select b.id, b.kind, b.value, b.reason, b.expires_at, b.is_active, b.created_at, b.lifted_at, b.lift_reason,
             b.source_order_id, o.order_number as source_order_number,
             (select coalesce(nullif(full_name, ''), email) from public.profiles where id = b.created_by) as created_by_name,
             (select coalesce(nullif(full_name, ''), email) from public.profiles where id = b.lifted_by) as lifted_by_name,
             case when not b.is_active then 'LIFTED' when b.expires_at is not null and b.expires_at <= now() then 'EXPIRED'
                  when b.expires_at is not null then 'TEMPORARY' else 'PERMANENT' end as state,
             h.orders, h.delivered, h.returned, h.cancelled, h.customer_id, h.customer_name
      from public.order_blocks b
      left join public.orders o on o.id = b.source_order_id
      left join lateral (
        select count(*) as orders,
               count(*) filter (where x.status in ('DELIVERED', 'PARTIALLY_DELIVERED')) as delivered,
               count(*) filter (where x.status in ('RETURNED', 'RETURNING', 'RETURN_REQUESTED')) as returned,
               count(*) filter (where x.status in ('CANCELLED', 'REJECTED_FRAUD')) as cancelled,
               max(x.customer_id::text)::uuid as customer_id, max(x.customer_name) as customer_name
        from public.orders x
        where (b.kind = 'PHONE' and x.customer_phone = b.value)
           or (b.kind = 'IP' and x.client_ip = b.value)
           or (b.kind = 'ADDRESS' and lower(x.shipping_address) like '%' || b.value || '%')
      ) h on true
      where (p_kind is null or b.kind = p_kind)
        and (v_q is null or b.value ilike '%' || v_q || '%' or b.reason ilike '%' || v_q || '%')
        and case coalesce(p_status, 'active')
              when 'active' then b.is_active and (b.expires_at is null or b.expires_at > now())
              when 'expired' then b.is_active and b.expires_at <= now()
              when 'lifted' then not b.is_active
              else true end
      order by b.created_at desc
      limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0)) r), '[]'::jsonb));
end;
$$;

-- -----------------------------------------------------------------------------
-- Assigned agent and Auto Pick
-- -----------------------------------------------------------------------------
create or replace function public._auto_pick_agent()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_cfg jsonb := public.get_setting('auto_pick');
  v_mode text := coalesce(v_cfg ->> 'mode', 'round_robin');
  v_max int := coalesce((v_cfg ->> 'max_open')::int, 0);
  v_agent uuid;
begin
  if not coalesce((v_cfg ->> 'enabled')::boolean, false) then
    return null;
  end if;
  with agents as (
    select p.id from public.profiles p
    where p.is_active and p.id::text in (select jsonb_array_elements_text(coalesce(v_cfg -> 'agent_ids', '[]'::jsonb)))
  ), load as (
    select a.id,
      (select count(*) from public.orders o where o.assigned_to = a.id and o.confirmed_at is null
         and o.status not in ('CANCELLED', 'REJECTED_FRAUD')
         and o.review_status in (select code from public.order_review_statuses where not closes_order)) as open_count,
      (select max(o.assigned_at) from public.orders o where o.assigned_to = a.id) as last_assigned
    from agents a
  )
  select id into v_agent from load
  where v_max <= 0 or open_count < v_max
  order by case when v_mode = 'least_open' then open_count else 0 end, last_assigned nulls first, id
  limit 1;
  return v_agent;
end;
$$;

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
      new.assigned_at := now();
    end if;
  end if;
  return new;
exception when others then
  -- Assignment must never stop an order from being saved.
  perform public._log_system_event('WARN', 'JOB', 'auto-pick', 'Auto Pick could not assign an order: ' || sqlerrm, '{}'::jsonb);
  return new;
end;
$$;
create or replace trigger orders_auto_pick before insert on public.orders
  for each row execute function public._orders_auto_pick();

create or replace function public.assign_orders(p_order_ids uuid[], p_agent uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int;
begin
  perform public.require_permission('orders.assign');
  if p_agent is not null and not exists (select 1 from public.profiles p join public.roles r on r.id = p.role_id
                                         where p.id = p_agent and p.is_active) then
    raise exception 'VALIDATION: choose an active staff member' using errcode = '22023';
  end if;
  update public.orders set assigned_to = p_agent, assigned_at = case when p_agent is null then null else now() end
  where id = any(p_order_ids) and assigned_to is distinct from p_agent;
  get diagnostics v_count = row_count;
  perform public.log_audit('order.assigned', 'order', array_to_string(p_order_ids[1:5], ','), null,
    jsonb_build_object('assigned_to', p_agent), jsonb_build_object('orders', cardinality(p_order_ids)));
  return v_count;
end;
$$;

-- Hands every unassigned open web order to the agents, as Auto Pick would.
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
    update public.orders set assigned_to = v_agent, assigned_at = now() where id = v_order.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create or replace function public.auto_pick_update(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mode text := coalesce(p ->> 'mode', 'round_robin');
  v_value jsonb;
begin
  perform public.require_permission('orders.assign');
  if v_mode not in ('round_robin', 'least_open') then
    raise exception 'VALIDATION: unknown mode' using errcode = '22023';
  end if;
  if coalesce((p ->> 'max_open')::int, 0) < 0 then
    raise exception 'VALIDATION: the limit cannot be negative' using errcode = '22023';
  end if;
  update public.settings set value = jsonb_build_object(
      'enabled', coalesce((p ->> 'enabled')::boolean, false),
      'mode', v_mode,
      'agent_ids', coalesce((select jsonb_agg(x) from jsonb_array_elements_text(coalesce(p -> 'agent_ids', '[]'::jsonb)) x
                             where x in (select id::text from public.profiles where is_active)), '[]'::jsonb),
      'max_open', coalesce((p ->> 'max_open')::int, 0)),
    updated_by = auth.uid()
  where key = 'auto_pick' returning value into v_value;
  perform public.log_audit('auto_pick.updated', 'settings', 'auto_pick', null, v_value, '{}'::jsonb);
  return v_value;
end;
$$;

-- Settings plus each agent's workload.
create or replace function public.auto_pick_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_today timestamptz := public._ts_from(public._local_date(now()));
begin
  perform public.require_permission('orders.view');
  return jsonb_build_object(
    'settings', public.get_setting('auto_pick'),
    'unassigned', (select count(*) from public.orders where assigned_to is null and confirmed_at is null
      and status not in ('CANCELLED', 'REJECTED_FRAUD')
      and review_status in (select code from public.order_review_statuses where not closes_order)),
    'agents', coalesce((select jsonb_agg(a order by a.name) from (
      select p.id, coalesce(nullif(p.full_name, ''), p.email) as name, r.name as role, p.is_active,
        (select count(*) from public.orders o where o.assigned_to = p.id and o.confirmed_at is null
           and o.status not in ('CANCELLED', 'REJECTED_FRAUD')
           and o.review_status in (select code from public.order_review_statuses where not closes_order)) as open,
        (select count(*) from public.orders o where o.assigned_to = p.id and o.assigned_at >= v_today) as assigned_today,
        (select count(*) from public.orders o where o.approved_by = p.id and o.confirmed_at >= v_today) as approved_today,
        (select count(*) from public.orders o where o.assigned_to = p.id and o.confirmed_at is null and o.follow_up_at <= now()
           and o.status not in ('CANCELLED', 'REJECTED_FRAUD')) as callbacks_due
      from public.profiles p join public.roles r on r.id = p.role_id
      where p.is_active and (r.code = 'OWNER' or exists (select 1 from public.role_permissions rp join public.permissions pm on pm.id = rp.permission_id
                                    where rp.role_id = p.role_id and pm.code in ('orders.update', 'orders.status')))) a), '[]'::jsonb));
end;
$$;

-- -----------------------------------------------------------------------------
-- Call queue: the next web order to call
-- -----------------------------------------------------------------------------
create or replace function public.call_queue_next(p_scope text default 'mine', p_skip uuid[] default '{}')
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
  v_id uuid;
  v_counts jsonb;
begin
  perform public.require_permission('orders.view');
  with q as (
    select o.id, o.created_at, o.follow_up_at, o.contact_attempts, o.last_contact_at, o.review_status
    from public.orders o
    where o.confirmed_at is null and o.status not in ('CANCELLED', 'REJECTED_FRAUD', 'FRAUD_REVIEW')
      and o.review_status in (select code from public.order_review_statuses where not closes_order)
      and (o.follow_up_at is null or o.follow_up_at <= now())
      and (o.last_contact_at is null or o.last_contact_at < now() - interval '30 minutes')
      and not (o.id = any(coalesce(p_skip, '{}')))
      and case coalesce(p_scope, 'mine')
            when 'mine' then o.assigned_to = v_me
            when 'unassigned' then o.assigned_to is null
            else true end
  )
  select id into v_id from q
  -- Call-backs that are due first, then new orders oldest first, then retries.
  order by (follow_up_at is not null) desc, (review_status = 'PROCESSING') desc, contact_attempts, created_at
  limit 1;

  select jsonb_build_object(
    'mine', count(*) filter (where o.assigned_to = v_me),
    'unassigned', count(*) filter (where o.assigned_to is null),
    'all', count(*))
  into v_counts
  from public.orders o
  where o.confirmed_at is null and o.status not in ('CANCELLED', 'REJECTED_FRAUD', 'FRAUD_REVIEW')
    and o.review_status in (select code from public.order_review_statuses where not closes_order)
    and (o.follow_up_at is null or o.follow_up_at <= now())
    and (o.last_contact_at is null or o.last_contact_at < now() - interval '30 minutes');

  return jsonb_build_object('order_id', v_id, 'counts', v_counts);
end;
$$;

-- -----------------------------------------------------------------------------
-- Super Edit
-- -----------------------------------------------------------------------------
-- Shortest chain of allowed status changes from one status to another.
create or replace function public._order_status_path(p_from public.order_status, p_to public.order_status)
returns public.order_status[]
language sql
stable
set search_path = public, pg_temp
as $$
  with recursive walk(status, path) as (
    select p_from, array[]::public.order_status[]
    union all
    select t.to_status, w.path || t.to_status
    from walk w
    join public.order_status_transitions t on t.from_status = w.status
    where cardinality(w.path) < 8 and not (t.to_status = any(w.path)) and t.to_status <> p_from
  )
  select path from walk where status = p_to and cardinality(path) > 0
  order by cardinality(path) limit 1
$$;

-- p_changes: { status?, shipment?: { courier_id, tracking_number, consignment_id, status, shipping_cost, cod_amount, return_charge } }
-- p_force: when no allowed chain exists, set the status alone (stock, finance
-- and the courier record are then NOT adjusted — say so in the reason).
create or replace function public.admin_override_order(p_order_id uuid, p_changes jsonb, p_reason text,
  p_force boolean default false, p_notify boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_before jsonb;
  v_after jsonb;
  v_to public.order_status := nullif(p_changes ->> 'status', '')::public.order_status;
  v_path public.order_status[];
  v_step public.order_status;
  v_ship jsonb := p_changes -> 'shipment';
  v_shipment public.shipments;
  v_note text;
  v_mode text := null;
  v_signed_in timestamptz;
  v_skipped int := 0;
begin
  perform public.require_permission('orders.override');
  if length(trim(coalesce(p_reason, ''))) < 5 then
    raise exception 'VALIDATION: write why this order is being overridden' using errcode = '22023';
  end if;
  if not public.is_system_context() then
    select last_sign_in_at into v_signed_in from auth.users where id = auth.uid();
    if v_signed_in is null or v_signed_in < now() - interval '10 minutes' then
      raise exception 'REAUTH_REQUIRED: enter your password again to use Super Edit' using errcode = '42501';
    end if;
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'NOT_FOUND: order not found' using errcode = 'P0002';
  end if;
  select * into v_shipment from public.shipments where order_id = p_order_id and is_active;
  v_before := jsonb_build_object('status', v_order.status,
    'shipment', case when v_shipment.id is null then null else jsonb_build_object(
      'courier_id', v_shipment.courier_id, 'tracking_number', v_shipment.tracking_number, 'consignment_id', v_shipment.consignment_id,
      'status', v_shipment.status, 'shipping_cost', v_shipment.shipping_cost, 'cod_amount', v_shipment.cod_amount,
      'return_charge', v_shipment.return_charge) end);
  v_note := 'Super Edit: ' || trim(p_reason);

  -- Courier details first, so a status change sees the right shipment.
  if v_ship is not null and jsonb_typeof(v_ship) = 'object' then
    if v_ship ? 'courier_id' and nullif(v_ship ->> 'courier_id', '') is not null
       and not exists (select 1 from public.couriers where id = (v_ship ->> 'courier_id')::uuid) then
      raise exception 'VALIDATION: unknown courier' using errcode = '22023';
    end if;
    if coalesce((v_ship ->> 'shipping_cost')::numeric, 0) < 0 or coalesce((v_ship ->> 'cod_amount')::numeric, 0) < 0
       or coalesce((v_ship ->> 'return_charge')::numeric, 0) < 0 then
      raise exception 'VALIDATION: amounts cannot be negative' using errcode = '22023';
    end if;
    if v_shipment.id is null then
      if nullif(v_ship ->> 'courier_id', '') is null then
        raise exception 'VALIDATION: choose a courier' using errcode = '22023';
      end if;
      insert into public.shipments(order_id, courier_id, tracking_number, consignment_id, status, shipping_cost, cod_amount,
        return_charge, notes, created_by)
      values (p_order_id, (v_ship ->> 'courier_id')::uuid, nullif(trim(v_ship ->> 'tracking_number'), ''),
        nullif(trim(v_ship ->> 'consignment_id'), ''), coalesce(nullif(v_ship ->> 'status', '')::public.shipment_status, 'BOOKED'),
        coalesce((v_ship ->> 'shipping_cost')::numeric, 0), coalesce((v_ship ->> 'cod_amount')::numeric, greatest(v_order.total_amount - v_order.amount_paid, 0)),
        coalesce((v_ship ->> 'return_charge')::numeric, 0), v_note, auth.uid());
    else
      update public.shipments set
        courier_id = case when v_ship ? 'courier_id' and nullif(v_ship ->> 'courier_id', '') is not null then (v_ship ->> 'courier_id')::uuid else courier_id end,
        tracking_number = case when v_ship ? 'tracking_number' then nullif(trim(v_ship ->> 'tracking_number'), '') else tracking_number end,
        consignment_id = case when v_ship ? 'consignment_id' then nullif(trim(v_ship ->> 'consignment_id'), '') else consignment_id end,
        status = case when nullif(v_ship ->> 'status', '') is not null then (v_ship ->> 'status')::public.shipment_status else status end,
        shipping_cost = coalesce((v_ship ->> 'shipping_cost')::numeric, shipping_cost),
        cod_amount = coalesce((v_ship ->> 'cod_amount')::numeric, cod_amount),
        return_charge = coalesce((v_ship ->> 'return_charge')::numeric, return_charge),
        updated_at = now()
      where id = v_shipment.id;
    end if;
    perform public._order_log(p_order_id, 'OVERRIDE', v_note || ' (courier details)', null, null, jsonb_build_object('shipment', v_ship));
  end if;

  if v_to is not null and v_to <> v_order.status then
    v_path := public._order_status_path(v_order.status, v_to);
    if v_path is not null then
      v_mode := 'steps';
      foreach v_step in array v_path loop
        perform public._transition_order(p_order_id, v_step, v_note, jsonb_build_object('override', true));
      end loop;
    elsif p_force then
      v_mode := 'forced';
      update public.orders set status = v_to,
        confirmed_at = case when v_to in ('CONFIRMED', 'PROCESSING', 'PACKING', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED', 'PARTIALLY_DELIVERED', 'PRE_ORDER')
                            then coalesce(confirmed_at, now()) else confirmed_at end,
        shipped_at = case when v_to in ('SHIPPED', 'DELIVERED', 'PARTIALLY_DELIVERED', 'RETURNING', 'RETURNED') then coalesce(shipped_at, now()) else shipped_at end,
        delivered_at = case when v_to in ('DELIVERED', 'PARTIALLY_DELIVERED') then coalesce(delivered_at, now()) else delivered_at end,
        returned_at = case when v_to = 'RETURNED' then coalesce(returned_at, now()) else returned_at end,
        cancelled_at = case when v_to in ('CANCELLED', 'REJECTED_FRAUD') then coalesce(cancelled_at, now()) else cancelled_at end
      where id = p_order_id;
      perform public._order_log(p_order_id, 'STATUS_CHANGED', v_note || ' (forced: stock and finance not adjusted)', v_order.status, v_to,
        jsonb_build_object('override', true, 'forced', true), false);
    else
      raise exception 'VALIDATION: there is no normal way from % to %. Tick "Force" to set it anyway (stock and finance will not be adjusted).',
        v_order.status, v_to using errcode = '22023';
    end if;
  end if;

  -- An override is a correction: don't text the customer about it.
  if not p_notify then
    update public.notification_logs set status = 'SKIPPED', error = 'Not sent: Super Edit correction'
    where order_id = p_order_id and status = 'QUEUED' and created_at >= now();
    get diagnostics v_skipped = row_count;
  end if;

  perform public.refresh_customer_stats(v_order.customer_id);
  select * into v_order from public.orders where id = p_order_id;
  select * into v_shipment from public.shipments where order_id = p_order_id and is_active;
  v_after := jsonb_build_object('status', v_order.status,
    'shipment', case when v_shipment.id is null then null else jsonb_build_object(
      'courier_id', v_shipment.courier_id, 'tracking_number', v_shipment.tracking_number, 'consignment_id', v_shipment.consignment_id,
      'status', v_shipment.status, 'shipping_cost', v_shipment.shipping_cost, 'cod_amount', v_shipment.cod_amount,
      'return_charge', v_shipment.return_charge) end);
  perform public.log_audit('order.override', 'order', p_order_id::text, v_before, v_after,
    jsonb_build_object('reason', trim(p_reason), 'mode', v_mode, 'path', to_jsonb(v_path), 'order_number', v_order.order_number,
                       'messages_skipped', v_skipped));
  return jsonb_build_object('order', to_jsonb(v_order), 'mode', v_mode, 'path', to_jsonb(v_path), 'messages_skipped', v_skipped);
end;
$$;

-- Super Edit history: recent overrides with who, why and what changed.
create or replace function public.admin_override_history(p_limit int default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('orders.override');
  return coalesce((select jsonb_agg(r) from (
    select a.id, a.created_at, a.entity_id as order_id, a.metadata ->> 'order_number' as order_number, a.metadata ->> 'reason' as reason,
           a.metadata ->> 'mode' as mode, a.old_values, a.new_values, a.actor_email,
           (select coalesce(nullif(full_name, ''), email) from public.profiles where id = a.actor_id) as actor_name
    from public.audit_logs a where a.action = 'order.override'
    order by a.created_at desc limit least(greatest(coalesce(p_limit, 30), 1), 100)) r), '[]'::jsonb);
end;
$$;

-- -----------------------------------------------------------------------------
-- Orders dashboard (approved orders)
-- -----------------------------------------------------------------------------
create or replace function public.orders_dashboard(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz text := public.store_timezone();
  v_start timestamptz := public._ts_from(p_from);
  v_end timestamptz := public._ts_from(p_to + 1);
begin
  perform public.require_permission('orders.view');
  return jsonb_build_object(
    'daily', coalesce((select jsonb_agg(d order by d.day) from (
      select g::date as day,
        (select count(*) from public.orders where (confirmed_at at time zone v_tz)::date = g::date) as approved,
        (select count(*) from public.orders where (shipped_at at time zone v_tz)::date = g::date) as shipped,
        (select count(*) from public.orders where (delivered_at at time zone v_tz)::date = g::date) as delivered,
        (select count(*) from public.orders where (returned_at at time zone v_tz)::date = g::date) as returned,
        (select count(*) from public.orders where (cancelled_at at time zone v_tz)::date = g::date and confirmed_at is not null) as cancelled
      from generate_series(p_from, p_to, interval '1 day') g) d), '[]'::jsonb),
    'totals', (select jsonb_build_object(
        'approved', count(*) filter (where confirmed_at >= v_start and confirmed_at < v_end),
        'shipped', count(*) filter (where shipped_at >= v_start and shipped_at < v_end),
        'delivered', count(*) filter (where delivered_at >= v_start and delivered_at < v_end),
        'returned', count(*) filter (where returned_at >= v_start and returned_at < v_end),
        'cancelled', count(*) filter (where cancelled_at >= v_start and cancelled_at < v_end and confirmed_at is not null),
        'approved_value', coalesce(sum(total_amount) filter (where confirmed_at >= v_start and confirmed_at < v_end), 0),
        'delivered_value', coalesce(sum(total_amount) filter (where delivered_at >= v_start and delivered_at < v_end), 0))
      from public.orders),
    -- Open approved orders by courier and stage, right now.
    'by_courier', coalesce((select jsonb_agg(c order by c.total desc) from (
      select coalesce(cr.name, 'Not booked') as courier, cr.id as courier_id, count(*) as total,
        count(*) filter (where public.order_stage(o.status, o.confirmed_at) = 'PENDING') as pending,
        count(*) filter (where public.order_stage(o.status, o.confirmed_at) = 'RTS') as rts,
        count(*) filter (where public.order_stage(o.status, o.confirmed_at) = 'SHIPPED') as shipped,
        count(*) filter (where public.order_stage(o.status, o.confirmed_at) in ('PENDING_RETURN', 'RETURN_PENDING')) as pending_return,
        count(*) filter (where public.order_stage(o.status, o.confirmed_at) = 'PENDING_CANCEL') as pending_cancel,
        coalesce(sum(o.total_amount - o.amount_paid), 0) as cod_open
      from public.orders o
      left join public.shipments s on s.order_id = o.id and s.is_active
      left join public.couriers cr on cr.id = s.courier_id
      where o.confirmed_at is not null
        and public.order_stage(o.status, o.confirmed_at) in ('PENDING', 'RTS', 'SHIPPED', 'PENDING_RETURN', 'RETURN_PENDING', 'PENDING_CANCEL')
      group by cr.id, cr.name) c), '[]'::jsonb),
    -- Orders that have waited too long at a stage.
    'aging', jsonb_build_object(
      'pending_over_2d', (select count(*) from public.orders o where public.order_stage(o.status, o.confirmed_at) = 'PENDING' and o.confirmed_at < now() - interval '2 days'),
      'rts_over_1d', (select count(*) from public.orders o where o.status = 'READY_TO_SHIP' and o.updated_at < now() - interval '1 day'),
      'shipped_over_7d', (select count(*) from public.orders o where o.status = 'SHIPPED' and o.shipped_at < now() - interval '7 days'),
      'return_over_7d', (select count(*) from public.orders o where o.status in ('FAILED_DELIVERY', 'RETURN_REQUESTED', 'RETURNING') and o.updated_at < now() - interval '7 days'),
      'unbooked', (select count(*) from public.orders o where o.confirmed_at is not null and o.status in ('CONFIRMED', 'PROCESSING', 'PACKING', 'READY_TO_SHIP')
                   and not exists (select 1 from public.shipments s where s.order_id = o.id and s.is_active))),
    'by_agent', coalesce((select jsonb_agg(a order by a.approved desc) from (
      select coalesce(nullif(p.full_name, ''), p.email) as name, count(*) as approved, coalesce(sum(o.total_amount), 0) as value
      from public.orders o join public.profiles p on p.id = o.approved_by
      where o.confirmed_at >= v_start and o.confirmed_at < v_end
      group by p.id, p.full_name, p.email limit 20) a), '[]'::jsonb)
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Access
-- -----------------------------------------------------------------------------
revoke all on function public._block_value(text, text), public.order_block_match(text, text, text), public._orders_block_guard(),
  public.record_order_client(uuid, text, text), public.admin_block_add(text, text, text, timestamptz, uuid),
  public.admin_block_lift(uuid, text), public.admin_block_list(text, text, text, int, int),
  public._auto_pick_agent(), public._orders_auto_pick(), public.assign_orders(uuid[], uuid), public.auto_pick_run(),
  public.auto_pick_update(jsonb), public.auto_pick_overview(), public.call_queue_next(text, uuid[]),
  public._order_status_path(public.order_status, public.order_status),
  public.admin_override_order(uuid, jsonb, text, boolean, boolean), public.admin_override_history(int),
  public.orders_dashboard(date, date)
from public, anon;
revoke all on function public._block_value(text, text), public.order_block_match(text, text, text), public._orders_block_guard(),
  public.record_order_client(uuid, text, text), public._auto_pick_agent(), public._orders_auto_pick(),
  public._order_status_path(public.order_status, public.order_status)
from authenticated;
grant execute on function public.admin_block_add(text, text, text, timestamptz, uuid), public.admin_block_lift(uuid, text),
  public.admin_block_list(text, text, text, int, int), public.assign_orders(uuid[], uuid), public.auto_pick_run(),
  public.auto_pick_update(jsonb), public.auto_pick_overview(), public.call_queue_next(text, uuid[]),
  public.admin_override_order(uuid, jsonb, text, boolean, boolean), public.admin_override_history(int),
  public.orders_dashboard(date, date)
to authenticated;
grant execute on function public.order_block_match(text, text, text), public.record_order_client(uuid, text, text) to service_role;
