-- =============================================================================
-- Multi warehouse / branch stock
--
-- Settings → Inventory → "Multi Warehouse / Branch Stock" turns it on
-- (settings 'inventory'.multi_branch). Then:
--   * Branches (stores and warehouses), one of them central. The store's total
--     stock stays where it always was (inventory); each other branch keeps its
--     own count (branch_stock) and the central branch holds the rest, so
--     totals, channel sync and reservations work exactly as before.
--   * Every stock movement lands on a branch: the order's branch for sales and
--     returns, the branch chosen for a purchase or adjustment (app.inventory_branch),
--     else the central branch. The movement records which branch.
--   * Branch Stock Setup sets how much each branch holds; transfers move stock
--     between branches (logged). Staff can be assigned to branches; orders get
--     the branch that ships them. Reports per branch.
-- Permissions: settings.manage sets branches up, inventory.adjust moves stock,
-- orders.update picks an order's branch; everyone with inventory.view sees it.
-- =============================================================================

create table if not exists public.branches (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null default public.current_merchant_id() references public.merchants(id),
  name text not null check (length(trim(name)) between 2 and 80),
  code text check (code is null or code ~ '^[A-Z0-9-]{1,12}$'),
  kind text not null default 'STORE' check (kind in ('STORE', 'WAREHOUSE')),
  is_central boolean not null default false,
  address text check (length(address) <= 300),
  phone text check (length(phone) <= 20),
  manager_id uuid references public.profiles(id) on delete set null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (merchant_id, name)
);
create unique index if not exists branches_one_central_idx on public.branches (merchant_id) where is_central;

create table if not exists public.branch_stock (
  merchant_id uuid not null default public.current_merchant_id() references public.merchants(id),
  branch_id uuid not null references public.branches(id) on delete restrict,
  variant_id uuid not null references public.product_variants(id) on delete cascade,
  on_hand int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (branch_id, variant_id)
);
create index if not exists branch_stock_variant_idx on public.branch_stock (merchant_id, variant_id);

create table if not exists public.branch_staff (
  merchant_id uuid not null default public.current_merchant_id() references public.merchants(id),
  branch_id uuid not null references public.branches(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  primary key (branch_id, profile_id)
);

create table if not exists public.branch_transfers (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null default public.current_merchant_id() references public.merchants(id),
  from_branch uuid not null references public.branches(id),
  to_branch uuid not null references public.branches(id),
  variant_id uuid not null references public.product_variants(id),
  quantity int not null check (quantity > 0),
  kind text not null default 'TRANSFER' check (kind in ('TRANSFER', 'SETUP')),
  note text check (length(note) <= 300),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  check (from_branch <> to_branch)
);
create index if not exists branch_transfers_recent_idx on public.branch_transfers (merchant_id, created_at desc);

alter table public.orders add column if not exists branch_id uuid references public.branches(id) on delete set null;
alter table public.inventory_movements add column if not exists branch_id uuid references public.branches(id);
create index if not exists orders_branch_idx on public.orders (merchant_id, branch_id) where branch_id is not null;
-- Staff read orders column by column (order costs are hidden): the new column too.
grant select (branch_id) on public.orders to authenticated;

do $$
declare t text;
begin
  foreach t in array array['branches', 'branch_stock', 'branch_staff', 'branch_transfers'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format($p$create policy tenant_isolation on public.%I as restrictive for all to public
      using (merchant_id = (select public.current_merchant_id()))
      with check (merchant_id = (select public.current_merchant_id()) and not (select public._support_read_only()))$p$, t);
    execute format('create policy app_owner_all on public.%I for all to app_owner using (true) with check (true)', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('create policy staff_read on public.%I for select to authenticated using ((select public.is_staff()))', t);
  end loop;
end $$;

create or replace function public._branches_on()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((public.get_setting('inventory') ->> 'multi_branch')::boolean, false)
$$;

create or replace function public._central_branch()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select id from public.branches where is_central and merchant_id = public.current_merchant_id()
$$;

-- Each movement lands on a branch. The central branch is the rest of the total,
-- so only other branches keep a count of their own.
create or replace function public._inventory_movement_branch()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_central uuid;
  v_branch uuid;
begin
  if not public._branches_on() then
    return new;
  end if;
  v_central := public._central_branch();
  v_branch := coalesce(new.branch_id, nullif(current_setting('app.inventory_branch', true), '')::uuid,
    case when new.reference_type = 'ORDER' then (select o.branch_id from public.orders o where o.id = new.reference_id) end, v_central);
  if v_branch is not null and not exists (select 1 from public.branches where id = v_branch) then
    v_branch := v_central;
  end if;
  new.branch_id := v_branch;
  if new.on_hand_change <> 0 and v_branch is not null and v_branch is distinct from v_central then
    insert into public.branch_stock (merchant_id, branch_id, variant_id, on_hand)
    values (new.merchant_id, v_branch, new.variant_id, new.on_hand_change)
    on conflict (branch_id, variant_id) do update set on_hand = public.branch_stock.on_hand + excluded.on_hand, updated_at = now();
  end if;
  return new;
end;
$$;
create trigger inventory_movements_branch before insert on public.inventory_movements
  for each row execute function public._inventory_movement_branch();

-- Turn branch stock on or off. The first time, the central branch is created with all the stock.
create or replace function public.branches_enable(p_on boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('settings.manage');
  if p_on and public._central_branch() is null then
    insert into public.branches (name, code, kind, is_central) values ('Main warehouse', 'MAIN', 'WAREHOUSE', true);
  end if;
  update public.settings set value = value || jsonb_build_object('multi_branch', coalesce(p_on, false)), updated_by = auth.uid()
  where key = 'inventory';
  if not found then
    insert into public.settings (key, value, updated_by) values ('inventory', jsonb_build_object('multi_branch', coalesce(p_on, false)), auth.uid());
  end if;
  perform public.log_audit(case when p_on then 'branches.enabled' else 'branches.disabled' end, 'settings', 'inventory', null, null, '{}'::jsonb);
  return public.branches_overview();
end;
$$;

create or replace function public.branches_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_central uuid := public._central_branch();
begin
  perform public.require_permission('inventory.view');
  return jsonb_build_object(
    'enabled', public._branches_on(),
    'stats', jsonb_build_object(
      'total', (select count(*) from public.branches where is_active),
      'stores', (select count(*) from public.branches where is_active and kind = 'STORE'),
      'warehouses', (select count(*) from public.branches where is_active and kind = 'WAREHOUSE'),
      'central', (select name from public.branches where id = v_central)),
    'branches', coalesce((select jsonb_agg(jsonb_build_object(
        'id', b.id, 'name', b.name, 'code', b.code, 'kind', b.kind, 'is_central', b.is_central, 'address', b.address, 'phone', b.phone,
        'manager_id', b.manager_id, 'manager', (select coalesce(nullif(p.full_name, ''), p.email) from public.profiles p where p.id = b.manager_id),
        'is_active', b.is_active,
        'units', case when b.is_central
          then (select coalesce(sum(i.on_hand), 0) from public.inventory i) - (select coalesce(sum(s.on_hand), 0) from public.branch_stock s join public.branches x on x.id = s.branch_id where not x.is_central)
          else (select coalesce(sum(s.on_hand), 0) from public.branch_stock s where s.branch_id = b.id) end,
        'skus', case when b.is_central then null else (select count(*) from public.branch_stock s where s.branch_id = b.id and s.on_hand <> 0) end,
        'staff', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', coalesce(nullif(p.full_name, ''), p.email)) order by p.full_name)
                  from public.branch_staff bs join public.profiles p on p.id = bs.profile_id where bs.branch_id = b.id), '[]'::jsonb),
        'open_orders', (select count(*) from public.orders o where coalesce(o.branch_id, v_central) = b.id and o.confirmed_at is not null
                          and o.status in ('CONFIRMED', 'PROCESSING', 'PRODUCTION', 'QUALITY_CHECK', 'PACKING', 'READY_TO_SHIP')))
      order by b.is_central desc, b.is_active desc, b.name) from public.branches b), '[]'::jsonb));
end;
$$;

create or replace function public.branch_save(p jsonb)
returns public.branches
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.branches;
  v_id uuid := nullif(p ->> 'id', '')::uuid;
begin
  perform public.require_permission('settings.manage');
  if v_id is null then
    insert into public.branches (name, code, kind, address, phone, manager_id)
    values (trim(p ->> 'name'), nullif(upper(trim(coalesce(p ->> 'code', ''))), ''), coalesce(p ->> 'kind', 'STORE'),
            nullif(trim(coalesce(p ->> 'address', '')), ''), nullif(trim(coalesce(p ->> 'phone', '')), ''), nullif(p ->> 'manager_id', '')::uuid)
    returning * into v_row;
    if public._central_branch() is null then
      update public.branches set is_central = true where id = v_row.id returning * into v_row;
    end if;
  else
    update public.branches set name = trim(p ->> 'name'), code = nullif(upper(trim(coalesce(p ->> 'code', ''))), ''), kind = coalesce(p ->> 'kind', kind),
      address = nullif(trim(coalesce(p ->> 'address', '')), ''), phone = nullif(trim(coalesce(p ->> 'phone', '')), ''),
      manager_id = nullif(p ->> 'manager_id', '')::uuid,
      is_active = case when is_central then true else coalesce((p ->> 'is_active')::boolean, is_active) end, updated_at = now()
    where id = v_id returning * into v_row;
    if v_row.id is null then
      raise exception 'NOT_FOUND: branch not found' using errcode = 'P0002';
    end if;
  end if;
  if v_row.manager_id is not null and not exists (select 1 from public.profiles where id = v_row.manager_id and merchant_id = v_row.merchant_id) then
    raise exception 'VALIDATION: the manager must be one of your staff' using errcode = '22023';
  end if;
  if not v_row.is_active and exists (select 1 from public.branch_stock where branch_id = v_row.id and on_hand <> 0) then
    raise exception 'VALIDATION: move this branch''s stock to another branch before closing it' using errcode = '22023';
  end if;
  perform public.log_audit('branch.saved', 'branch', v_row.id::text, null, to_jsonb(v_row), '{}'::jsonb);
  return v_row;
end;
$$;

-- The central branch moves: its derived stock becomes the new central's, the old one keeps a count.
create or replace function public.branch_set_central(p_branch uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old uuid := public._central_branch();
begin
  perform public.require_permission('settings.manage');
  if p_branch = v_old then
    return;
  end if;
  if not exists (select 1 from public.branches where id = p_branch and is_active) then
    raise exception 'NOT_FOUND: branch not found' using errcode = 'P0002';
  end if;
  -- The old central keeps what it holds now as its own count; the new one's count is dropped (it becomes the rest).
  insert into public.branch_stock (branch_id, variant_id, on_hand)
  select v_old, i.variant_id, i.on_hand - coalesce((select sum(s.on_hand) from public.branch_stock s where s.variant_id = i.variant_id), 0)
  from public.inventory i where v_old is not null
  on conflict (branch_id, variant_id) do update set on_hand = excluded.on_hand, updated_at = now();
  delete from public.branch_stock where branch_id = p_branch;
  update public.branches set is_central = false where id = v_old;
  update public.branches set is_central = true, updated_at = now() where id = p_branch;
  perform public.log_audit('branch.central', 'branch', p_branch::text, jsonb_build_object('was', v_old), null, '{}'::jsonb);
end;
$$;

-- Delete a branch that never held stock or orders (otherwise close it instead).
create or replace function public.branch_delete(p_branch uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('settings.manage');
  if exists (select 1 from public.branches where id = p_branch and is_central) then
    raise exception 'VALIDATION: choose another central branch before deleting this one' using errcode = '22023';
  end if;
  if exists (select 1 from public.branch_stock where branch_id = p_branch and on_hand <> 0)
     or exists (select 1 from public.orders where branch_id = p_branch)
     or exists (select 1 from public.inventory_movements where branch_id = p_branch)
     or exists (select 1 from public.branch_transfers where p_branch in (from_branch, to_branch)) then
    raise exception 'VALIDATION: this branch has stock or history; close it instead' using errcode = '22023';
  end if;
  delete from public.branch_stock where branch_id = p_branch;
  delete from public.branches where id = p_branch;
  if not found then
    raise exception 'NOT_FOUND: branch not found' using errcode = 'P0002';
  end if;
  perform public.log_audit('branch.deleted', 'branch', p_branch::text, null, null, '{}'::jsonb);
end;
$$;

-- Stock per branch for a page of variants (central = total − the other branches).
create or replace function public.branch_stock_list(p_q text default null, p_limit int default 50, p_offset int default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_central uuid := public._central_branch();
begin
  perform public.require_permission('inventory.view');
  return jsonb_build_object(
    'total', (select count(*) from public.product_variants v join public.products p on p.id = v.product_id
              where p.status <> 'ARCHIVED' and (p_q is null or p.name ilike '%' || p_q || '%' or v.sku ilike '%' || p_q || '%')),
    'items', coalesce((select jsonb_agg(r order by r ->> 'product', r ->> 'variant') from (
      select jsonb_build_object('variant_id', v.id, 'product', p.name, 'variant', nullif(v.title, 'Default'), 'sku', v.sku,
        'total', coalesce(i.on_hand, 0), 'reserved', coalesce(i.reserved, 0),
        'branches', (select jsonb_object_agg(b.id, case when b.id = v_central
                        then coalesce(i.on_hand, 0) - coalesce((select sum(s.on_hand) from public.branch_stock s where s.variant_id = v.id and s.branch_id <> v_central), 0)
                        else coalesce((select s.on_hand from public.branch_stock s where s.variant_id = v.id and s.branch_id = b.id), 0) end)
                     from public.branches b where b.is_active)) as r
      from public.product_variants v join public.products p on p.id = v.product_id
      left join public.inventory i on i.variant_id = v.id
      where p.status <> 'ARCHIVED' and (p_q is null or p.name ilike '%' || p_q || '%' or v.sku ilike '%' || p_q || '%')
      order by p.name, v.title
      limit least(greatest(p_limit, 1), 200) offset greatest(p_offset, 0)) x), '[]'::jsonb));
end;
$$;

-- Moves stock between branches (the total does not change).
create or replace function public.branch_transfer(p_from uuid, p_to uuid, p_items jsonb, p_note text default null, p_kind text default 'TRANSFER')
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_central uuid := public._central_branch();
  it record;
  v_have int;
  v_n int := 0;
begin
  perform public.require_permission('inventory.adjust');
  if not public._branches_on() then
    raise exception 'VALIDATION: turn on branch stock first (Settings → Inventory)' using errcode = '22023';
  end if;
  if p_from = p_to or not exists (select 1 from public.branches where id = p_from and is_active)
     or not exists (select 1 from public.branches where id = p_to and is_active) then
    raise exception 'VALIDATION: choose two different open branches' using errcode = '22023';
  end if;
  for it in select (e ->> 'variant_id')::uuid as variant_id, (e ->> 'quantity')::int as qty from jsonb_array_elements(p_items) e loop
    continue when coalesce(it.qty, 0) <= 0;
    if p_from = v_central then
      v_have := coalesce((select on_hand from public.inventory where variant_id = it.variant_id), 0)
                - coalesce((select sum(on_hand) from public.branch_stock where variant_id = it.variant_id and branch_id <> v_central), 0);
    else
      v_have := coalesce((select on_hand from public.branch_stock where branch_id = p_from and variant_id = it.variant_id for update), 0);
    end if;
    if v_have < it.qty then
      raise exception 'VALIDATION: only % in stock at that branch for one of the items', greatest(v_have, 0) using errcode = '22023';
    end if;
    if p_from <> v_central then
      update public.branch_stock set on_hand = on_hand - it.qty, updated_at = now() where branch_id = p_from and variant_id = it.variant_id;
    end if;
    if p_to <> v_central then
      insert into public.branch_stock (branch_id, variant_id, on_hand) values (p_to, it.variant_id, it.qty)
      on conflict (branch_id, variant_id) do update set on_hand = public.branch_stock.on_hand + excluded.on_hand, updated_at = now();
    end if;
    insert into public.branch_transfers (from_branch, to_branch, variant_id, quantity, kind, note, created_by)
    values (p_from, p_to, it.variant_id, it.qty, case when p_kind = 'SETUP' then 'SETUP' else 'TRANSFER' end, left(p_note, 300), auth.uid());
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- Branch Stock Setup: how much a branch holds; the difference comes from (or goes back to) the central branch.
create or replace function public.branch_stock_set(p_branch uuid, p_items jsonb)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_central uuid := public._central_branch();
  it record;
  v_now int;
  v_n int := 0;
begin
  perform public.require_permission('inventory.adjust');
  if p_branch = v_central then
    raise exception 'VALIDATION: the central branch holds whatever the other branches do not; set the other branches instead' using errcode = '22023';
  end if;
  for it in select (e ->> 'variant_id')::uuid as variant_id, (e ->> 'on_hand')::int as want from jsonb_array_elements(p_items) e loop
    continue when it.want is null or it.want < 0;
    v_now := coalesce((select on_hand from public.branch_stock where branch_id = p_branch and variant_id = it.variant_id), 0);
    if it.want > v_now then
      v_n := v_n + public.branch_transfer(v_central, p_branch, jsonb_build_array(jsonb_build_object('variant_id', it.variant_id, 'quantity', it.want - v_now)), 'Branch stock setup', 'SETUP');
    elsif it.want < v_now then
      v_n := v_n + public.branch_transfer(p_branch, v_central, jsonb_build_array(jsonb_build_object('variant_id', it.variant_id, 'quantity', v_now - it.want)), 'Branch stock setup', 'SETUP');
    end if;
  end loop;
  return v_n;
end;
$$;

create or replace function public.branch_staff_set(p_branch uuid, p_profiles uuid[])
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('settings.manage');
  if not exists (select 1 from public.branches where id = p_branch) then
    raise exception 'NOT_FOUND: branch not found' using errcode = 'P0002';
  end if;
  if exists (select 1 from unnest(coalesce(p_profiles, '{}')) x where not exists (select 1 from public.profiles p where p.id = x and p.merchant_id = public.current_merchant_id())) then
    raise exception 'VALIDATION: choose your own staff' using errcode = '22023';
  end if;
  delete from public.branch_staff where branch_id = p_branch and not (profile_id = any(coalesce(p_profiles, '{}')));
  insert into public.branch_staff (branch_id, profile_id) select p_branch, x from unnest(coalesce(p_profiles, '{}')) x on conflict do nothing;
  return coalesce(cardinality(p_profiles), 0);
end;
$$;

-- Which branch ships these orders (before they ship, so their stock leaves the right branch).
create or replace function public.orders_set_branch(p_orders uuid[], p_branch uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n int;
begin
  perform public.require_permission('orders.update');
  if p_branch is not null and not exists (select 1 from public.branches where id = p_branch and is_active) then
    raise exception 'VALIDATION: choose an open branch' using errcode = '22023';
  end if;
  update public.orders set branch_id = p_branch
  where id = any(p_orders) and status not in ('SHIPPED', 'DELIVERED', 'PARTIALLY_DELIVERED', 'RETURN_REQUESTED', 'RETURNING', 'RETURNED', 'LOST', 'CANCELLED', 'REJECTED_FRAUD')
    and branch_id is distinct from p_branch;
  get diagnostics v_n = row_count;
  perform public.log_audit('order.branch', 'order', array_to_string(p_orders[1:5], ','), null, jsonb_build_object('branch', p_branch), jsonb_build_object('orders', cardinality(p_orders)));
  return v_n;
end;
$$;

-- New orders from a staff member who belongs to one branch start on that branch.
create or replace function public._orders_default_branch()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.branch_id is null and public._branches_on() and auth.uid() is not null then
    new.branch_id := (select (array_agg(bs.branch_id))[1] from public.branch_staff bs join public.branches b on b.id = bs.branch_id
                      where bs.profile_id = auth.uid() and b.is_active having count(*) = 1);
  end if;
  return new;
end;
$$;
create trigger orders_default_branch before insert on public.orders
  for each row execute function public._orders_default_branch();

-- Per branch over a period: orders, sales, delivered, returned, and stock on hand now.
create or replace function public.branch_report(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_central uuid := public._central_branch();
  v_from timestamptz := public._ts_from(p_from);
  v_to timestamptz := public._ts_from(p_to + 1);
begin
  perform public.require_permission('reports.view');
  return coalesce((select jsonb_agg(jsonb_build_object(
      'branch_id', b.id, 'name', b.name, 'kind', b.kind, 'is_central', b.is_central,
      'orders', (select count(*) from public.orders o where coalesce(o.branch_id, v_central) = b.id and o.confirmed_at >= v_from and o.confirmed_at < v_to),
      'sales', (select coalesce(sum(o.total_amount), 0) from public.orders o where coalesce(o.branch_id, v_central) = b.id and o.confirmed_at >= v_from and o.confirmed_at < v_to
                  and o.status not in ('CANCELLED', 'REJECTED_FRAUD')),
      'delivered', (select count(*) from public.orders o where coalesce(o.branch_id, v_central) = b.id and o.delivered_at >= v_from and o.delivered_at < v_to),
      'returned', (select count(*) from public.orders o where coalesce(o.branch_id, v_central) = b.id and o.returned_at >= v_from and o.returned_at < v_to),
      'units', case when b.is_central
          then (select coalesce(sum(i.on_hand), 0) from public.inventory i) - (select coalesce(sum(s.on_hand), 0) from public.branch_stock s where s.branch_id <> b.id)
          else (select coalesce(sum(s.on_hand), 0) from public.branch_stock s where s.branch_id = b.id) end)
    order by b.is_central desc, b.name) from public.branches b where b.is_active), '[]'::jsonb);
end;
$$;

-- Super Admin: a store's branches (read-only).
create or replace function public.platform_merchant_branches(p_merchant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._platform_require('merchants', 'view', p_merchant);
  return jsonb_build_object(
    'enabled', coalesce((select (value ->> 'multi_branch')::boolean from public.settings where merchant_id = p_merchant and key = 'inventory'), false),
    'branches', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'kind', b.kind, 'is_central', b.is_central, 'is_active', b.is_active,
        'staff', (select count(*) from public.branch_staff s where s.branch_id = b.id)) order by b.is_central desc, b.name)
      from public.branches b where b.merchant_id = p_merchant), '[]'::jsonb));
end;
$$;

revoke all on function public._branches_on(), public._central_branch(), public._inventory_movement_branch(), public._orders_default_branch()
  from public, anon, authenticated;
revoke all on function public.branches_enable(boolean), public.branches_overview(), public.branch_save(jsonb), public.branch_set_central(uuid),
  public.branch_delete(uuid), public.branch_stock_list(text, int, int), public.branch_transfer(uuid, uuid, jsonb, text, text),
  public.branch_stock_set(uuid, jsonb), public.branch_staff_set(uuid, uuid[]), public.orders_set_branch(uuid[], uuid),
  public.branch_report(date, date), public.platform_merchant_branches(uuid) from public, anon;
grant execute on function public.branches_enable(boolean), public.branches_overview(), public.branch_save(jsonb), public.branch_set_central(uuid),
  public.branch_delete(uuid), public.branch_stock_list(text, int, int), public.branch_transfer(uuid, uuid, jsonb, text, text),
  public.branch_stock_set(uuid, jsonb), public.branch_staff_set(uuid, uuid[]), public.orders_set_branch(uuid[], uuid),
  public.branch_report(date, date), public.platform_merchant_branches(uuid) to authenticated;

insert into public.tenancy_exempt_functions (name, reason) values
  ('platform_merchant_branches', 'Super Admin: one store''s branches, read-only, checked against the staff member''s merchants')
on conflict (name) do nothing;

select public._tenancy_own_functions();

alter function public._branches_on() owner to app_owner;
alter function public._central_branch() owner to app_owner;
alter function public._inventory_movement_branch() owner to app_owner;
alter function public._orders_default_branch() owner to app_owner;
alter function public.branches_enable(boolean) owner to app_owner;
alter function public.branches_overview() owner to app_owner;
alter function public.branch_save(jsonb) owner to app_owner;
alter function public.branch_set_central(uuid) owner to app_owner;
alter function public.branch_delete(uuid) owner to app_owner;
alter function public.branch_stock_list(text, int, int) owner to app_owner;
alter function public.branch_transfer(uuid, uuid, jsonb, text, text) owner to app_owner;
alter function public.branch_stock_set(uuid, jsonb) owner to app_owner;
alter function public.branch_staff_set(uuid, uuid[]) owner to app_owner;
alter function public.orders_set_branch(uuid[], uuid) owner to app_owner;
alter function public.branch_report(date, date) owner to app_owner;
