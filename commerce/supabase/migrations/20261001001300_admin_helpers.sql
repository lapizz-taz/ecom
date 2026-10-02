-- =============================================================================
-- 1300 · Small read helpers for the admin UI
-- =============================================================================

-- Names of staff members (for "created by" / assignee columns) without
-- exposing the profiles table to every role.
create or replace function public.staff_directory()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when public.is_staff() or public.is_system_context() then
    coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'full_name', coalesce(nullif(p.full_name, ''), p.email),
                                                  'email', p.email, 'role', r.code, 'is_active', p.is_active)
                               order by p.full_name)
              from public.profiles p join public.roles r on r.id = p.role_id), '[]'::jsonb)
  end
$$;

-- Delivered parcels whose COD has not been settled by the courier yet.
create or replace function public.admin_cod_receivable(p_courier_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not (public.is_system_context() or public.has_permission('couriers.view') or public.has_permission('finance.view')) then
    raise exception 'PERMISSION_DENIED: couriers.view is required' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'shipment_id', s.id, 'order_id', o.id, 'order_number', o.order_number, 'customer_name', o.customer_name,
      'courier_id', c.id, 'courier_name', c.name, 'tracking_number', s.tracking_number,
      'delivered_at', coalesce(s.delivered_at, o.delivered_at), 'total_amount', o.total_amount,
      'amount_paid', o.amount_paid, 'due', o.total_amount - o.amount_paid, 'shipping_cost', s.shipping_cost
    ) order by coalesce(s.delivered_at, o.delivered_at))
    from public.shipments s
    join public.orders o on o.id = s.order_id
    join public.couriers c on c.id = s.courier_id
    where s.is_active and o.delivered_at is not null and o.status in ('DELIVERED', 'RETURN_REQUESTED')
      and o.total_amount > o.amount_paid
      and (p_courier_id is null or s.courier_id = p_courier_id)
  ), '[]'::jsonb);
end;
$$;

revoke execute on function public.staff_directory() from public, anon;
revoke execute on function public.admin_cod_receivable(uuid) from public, anon;
grant execute on function public.staff_directory() to authenticated;
grant execute on function public.admin_cod_receivable(uuid) to authenticated;
