-- =============================================================================
-- "Moderator" role: messaging only
--
--   * A standard Moderator role in every store (and every new store): read the
--     messaging inbox (messages and comments), reply to customers, and create
--     orders. Nothing else: no order lists or order pages, customers,
--     dashboard, reports, finance, products, stock or settings. Creating an
--     order lets them pick products (the catalog without costs), get a quote
--     and see the customer's courier record, as for anyone with orders.create.
--   * Setting an order's source (Facebook, Instagram, ...) needs orders.update
--     and linking an order to a chat needs orders.view. Someone who may create
--     orders may do both for an order they created (or that their new order
--     was merged into) in the last hour, so a Moderator's order from a chat
--     records where it came from and shows on the chat.
-- Safe to re-run.
-- =============================================================================

create or replace function public._seed_moderator_role(p_merchant uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role uuid;
begin
  insert into public.roles (merchant_id, code, name, description, is_system, rank)
  values (p_merchant, 'MODERATOR', 'Moderator', 'Answers Facebook, Instagram and WhatsApp messages and comments and creates orders from them. No order lists, customers, sales, costs, stock or settings.', true, 25)
  on conflict do nothing;
  select id into v_role from public.roles where merchant_id = p_merchant and code = 'MODERATOR';
  if v_role is null then
    return;
  end if;
  insert into public.role_permissions (merchant_id, role_id, permission_id)
  select p_merchant, v_role, p.id from public.permissions p
  where p.code in ('inbox.view', 'inbox.reply', 'orders.create')
  on conflict do nothing;
end;
$$;
revoke all on function public._seed_moderator_role(uuid) from public, anon, authenticated;

-- New stores: their default roles are seeded together; the Viewer role is the last of them.
create or replace function public._roles_seed_moderator()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.code = 'VIEWER' then
    perform public._seed_moderator_role(new.merchant_id);
  end if;
  return new;
end;
$$;
drop trigger if exists roles_seed_moderator on public.roles;
create trigger roles_seed_moderator after insert on public.roles for each row execute function public._roles_seed_moderator();

do $$
declare m record;
begin
  for m in select id from public.merchants loop
    perform set_config('app.merchant_id', m.id::text, true);
    perform public._seed_moderator_role(m.id);
  end loop;
  perform set_config('app.merchant_id', '', true);
end $$;

-- ---------------------------------------------------------------------------
-- An order the person just created
-- ---------------------------------------------------------------------------
-- Someone who may create orders, for an order they created (or that their new order was merged
-- into) in the last hour: its source may be set and it may be linked to the chat it came from,
-- without orders.update / orders.view.
create or replace function public._own_recent_order(p_order uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_order is not null and public.has_permission('orders.create') and (
    exists (select 1 from public.orders o where o.id = p_order and o.created_by = auth.uid() and o.created_at > now() - interval '1 hour')
    or exists (select 1 from public.order_merges m where m.order_id = p_order and m.created_by = auth.uid() and m.created_at > now() - interval '1 hour'))
$$;
revoke all on function public._own_recent_order(uuid) from public, anon, authenticated;

create or replace function pg_temp.patch_fn(p_fn text, p_marker text, p_pairs text[])
returns void
language plpgsql as $$
declare
  v_old text := replace(pg_get_functiondef(p_fn::regprocedure), E'\r', '');
  v_new text;
  v_from text;
  v_hits int;
  i int;
begin
  if position(p_marker in v_old) > 0 then
    return; -- already patched
  end if;
  v_new := v_old;
  for i in 1 .. array_length(p_pairs, 1) by 2 loop
    v_from := replace(p_pairs[i], E'\r', '');
    v_hits := (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from);
    if v_hits <> 1 then
      raise exception 'moderator role: % has changed (% matches for "%")', p_fn, v_hits, left(v_from, 60);
    end if;
    v_new := replace(v_new, v_from, replace(p_pairs[i + 1], E'\r', ''));
  end loop;
  execute v_new;
end $$;

select pg_temp.patch_fn('public.admin_set_order_source(uuid,text,text)', '_own_recent_order', array[
$a$  perform public.require_permission('orders.update');$a$,
$b$  if not public._own_recent_order(p_order_id) then
    perform public.require_permission('orders.update');
  end if;$b$]);

select pg_temp.patch_fn('public.inbox_update(uuid,jsonb)', '_own_recent_order', array[
$a$  if p ? 'linked_order_id' then
    perform public.require_permission('orders.view');
  end if;$a$,
$b$  if p ? 'linked_order_id' and not public._own_recent_order(nullif(p ->> 'linked_order_id', '')::uuid) then
    perform public.require_permission('orders.view');
  end if;$b$]);

select public._tenancy_own_functions();
