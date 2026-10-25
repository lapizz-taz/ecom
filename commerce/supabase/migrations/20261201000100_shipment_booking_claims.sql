-- =============================================================================
-- One courier booking per order at a time.
--
-- Found by the round-4 audit: booking an order with a courier's API checked "already booked",
-- called the courier, then saved the parcel. Two bookings of the same order at the same moment
-- (two staff, two tabs, or the same bulk booking started again while the first was still
-- running) both passed the check and both created a real parcel at the courier; the second save
-- then overwrote the first parcel's tracking number, so that parcel stayed live at the courier
-- with nothing tracking it.
--
--   * shipment_booking_claim(order, courier) is called before the courier is asked: it refuses an
--     order that is already booked or is being booked right now (a claim younger than 3 minutes).
--   * assign_courier clears the claim when the parcel is saved; shipment_booking_release clears it
--     when the courier refused the booking.
--   * A claim left by a booking that died half-way lapses after 3 minutes.
--
-- assign_courier is patched in place (CREATE OR REPLACE keeps owner and grants). Safe to re-run.
-- =============================================================================

create table if not exists public.shipment_booking_claims (
  order_id uuid primary key references public.orders(id) on delete cascade,
  merchant_id uuid not null default public.current_merchant_id() references public.merchants(id),
  courier_id uuid references public.couriers(id) on delete cascade,
  claimed_by uuid references public.profiles(id) on delete set null,
  claimed_at timestamptz not null default now()
);

alter table public.shipment_booking_claims enable row level security;
drop policy if exists tenant_isolation on public.shipment_booking_claims;
create policy tenant_isolation on public.shipment_booking_claims as restrictive for all to public
  using (merchant_id = (select public.current_merchant_id()))
  with check (merchant_id = (select public.current_merchant_id()) and not (select public._support_read_only()));
drop policy if exists app_owner_all on public.shipment_booking_claims;
create policy app_owner_all on public.shipment_booking_claims for all to app_owner using (true) with check (true);
-- Only the functions below read or write claims.
revoke all on public.shipment_booking_claims from anon, authenticated;

create or replace function public.shipment_booking_claim(p_order_id uuid, p_courier_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_claimed_at timestamptz;
begin
  perform public.require_permission('shipments.manage');
  -- The order row lock makes two claims of one order wait for each other.
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'NOT_FOUND: order not found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.shipments where order_id = p_order_id and is_active
             and coalesce(nullif(trim(tracking_number), ''), nullif(trim(consignment_id), '')) is not null) then
    raise exception 'ALREADY_BOOKED: % is already booked', v_order.order_number using errcode = '23505';
  end if;
  select claimed_at into v_claimed_at from public.shipment_booking_claims where order_id = p_order_id;
  if v_claimed_at > now() - interval '3 minutes' then
    raise exception 'BOOKING_IN_PROGRESS: % is being booked right now; wait for that booking to finish', v_order.order_number
      using errcode = '55P03';
  end if;
  insert into public.shipment_booking_claims (order_id, merchant_id, courier_id, claimed_by, claimed_at)
  values (p_order_id, v_order.merchant_id, p_courier_id, auth.uid(), now())
  on conflict (order_id) do update
    set courier_id = excluded.courier_id, claimed_by = excluded.claimed_by, claimed_at = excluded.claimed_at;
end;
$$;

-- The courier refused (or could not be reached): the order may be booked again at once.
create or replace function public.shipment_booking_release(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('shipments.manage');
  delete from public.shipment_booking_claims where order_id = p_order_id and claimed_by is not distinct from auth.uid();
end;
$$;

revoke all on function public.shipment_booking_claim(uuid, uuid) from public, anon;
revoke all on function public.shipment_booking_release(uuid) from public, anon;
grant execute on function public.shipment_booking_claim(uuid, uuid) to authenticated, service_role;
grant execute on function public.shipment_booking_release(uuid) to authenticated, service_role;

-- Saving the parcel ends the booking.
do $$
declare
  v_old text := replace(pg_get_functiondef('public.assign_courier(uuid, uuid, text, numeric, text, text, jsonb)'::regprocedure), E'\r', '');
  v_from text := E'  return v_ship;\nend;';
  v_hits int;
begin
  if position('shipment_booking_claims' in v_old) > 0 then
    return; -- already patched
  end if;
  v_hits := (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from);
  if v_hits <> 1 then
    raise exception 'shipment booking claims: assign_courier has changed (% matches)', v_hits;
  end if;
  execute replace(v_old, v_from, E'  delete from public.shipment_booking_claims where order_id = p_order_id;\n  return v_ship;\nend;');
end $$;

select public._tenancy_own_functions();
