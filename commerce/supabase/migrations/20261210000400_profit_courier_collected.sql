-- =============================================================================
-- Profit: what the customer paid the courier at the door counts towards a returned parcel's charges.
--
-- Asked for on 30 Oct 2026: when a parcel comes back and the customer paid the delivery charge to the
-- rider, the courier's webhook says how much it collected. That money now pays the return:
--   * Every courier event that carries the amount collected (Pathao "collected_amount", Steadfast
--     "cod_amount") keeps it on the parcel (shipments.collected_amount), the latest one winning.
--   * A returned parcel: the courier's delivery and return charges, less what the customer paid at the
--     door or in advance. A "collected" amount as large as the whole order on a returned parcel is the
--     booked COD amount, not cash, and is not counted.
--   * A partial delivery where the courier collected no more than the delivery charge, and no kept goods
--     are recorded, is a paid return (Steadfast reports those as partial deliveries): no sale and no
--     product cost; the customer's payment goes against the courier's charges.
-- Money counted twice (the door payment, later settled by the courier as a COD payment on the order) is
-- counted once: the larger of the two.
--
-- Functions that change in a line are patched in place (CREATE OR REPLACE keeps each one's owner and
-- grants). Safe to re-run.
-- =============================================================================

-- 1. The amount the courier collected, kept on the parcel ---------------------------------------------

alter table public.shipments add column if not exists collected_amount numeric(12,2) check (collected_amount >= 0);
comment on column public.shipments.collected_amount is
  'What the courier reports the customer paid at the door (on delivery, a partial delivery or a paid return); null until reported.';

create or replace function pg_temp.patch_fn(p_fn text, p_from text, p_to text)
returns void
language plpgsql as $$
declare
  v_old text := replace(pg_get_functiondef(p_fn::regprocedure), E'\r', '');
  v_hits int;
begin
  if position(p_to in v_old) > 0 then
    return; -- already patched
  end if;
  v_hits := (length(v_old) - length(replace(v_old, p_from, ''))) / length(p_from);
  if v_hits <> 1 then
    raise exception 'profit courier collected: % has changed (% matches for "%")', p_fn, v_hits, left(p_from, 60);
  end if;
  execute replace(v_old, p_from, p_to);
end $$;

select pg_temp.patch_fn('public._process_courier_webhook(uuid)',
  $a$  v_note text;
begin$a$,
  $b$  v_note text;
  v_collected boolean := false;
begin$b$);
select pg_temp.patch_fn('public._process_courier_webhook(uuid)',
  $a$    v_result := case when v_applied or v_charged <> 0 then 'PROCESSED' else 'IGNORED' end;$a$,
  $b$    -- What the customer paid the courier (on delivery, a partial delivery or a paid return).
    if e.charges ->> 'collected' is not null and coalesce(e.new_status, v_ship.status) not in ('PENDING', 'BOOKED', 'CANCELLED')
       and v_ship.collected_amount is distinct from (e.charges ->> 'collected')::numeric then
      update public.shipments set collected_amount = (e.charges ->> 'collected')::numeric where id = v_ship.id;
      v_collected := true;
    end if;
    v_result := case when v_applied or v_charged <> 0 or v_collected then 'PROCESSED' else 'IGNORED' end;$b$);

-- Courier events already received: the latest amount each parcel was reported with (written as that business).
do $$
declare v_m uuid;
begin
  for v_m in select distinct merchant_id from public.courier_webhook_events where shipment_id is not null and charges ->> 'collected' is not null loop
    perform set_config('app.merchant_id', v_m::text, true);
    update public.shipments s set collected_amount = x.collected
    from (select distinct on (e.shipment_id) e.shipment_id, (e.charges ->> 'collected')::numeric as collected
          from public.courier_webhook_events e
          where e.merchant_id = v_m and e.shipment_id is not null and e.result = 'PROCESSED' and e.charges ->> 'collected' is not null
            and coalesce(e.new_status::text, '') not in ('PENDING', 'BOOKED', 'CANCELLED')
          order by e.shipment_id, coalesce(e.occurred_at, e.processed_at) desc) x
    where s.id = x.shipment_id and s.collected_amount is null;
  end loop;
  perform set_config('app.merchant_id', '', true);
end $$;

-- 2. The profit of each approved order ------------------------------------------------------------------

create or replace function public._order_profit_rows(p_from date, p_to date)
returns table (order_id uuid, day date, state text, sales numeric, product_cost numeric, courier_cost numeric,
               return_paid numeric, courier_estimated boolean, missing_cost boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with o as (
    select o.id, o.status, o.total_amount, o.delivery_charge, o.return_charge, o.cod_amount,
           coalesce(o.partial_return_amount, 0) as partial_return,
           greatest(o.amount_paid, 0) as kept, -- paid less refunded
           o.amount_refunded, o.advance_resolution,
           public._local_date(o.confirmed_at) as day
    from public.orders o
    where o.confirmed_at >= public._ts_from(p_from) and o.confirmed_at < public._ts_from(p_to + 1)
      and o.merged_into is null
  ), i as (
    -- Product cost: the cost kept on the order, else the product's cost today.
    select x.order_id, sum(x.cost * x.quantity) as cost_all, sum(x.cost * (x.quantity - x.returned)) as cost_kept,
           bool_or(x.cost = 0) as missing
    from (select oi.order_id, oi.quantity, coalesce(oi.returned_quantity, 0) as returned,
                 coalesce(nullif(oi.unit_cost, 0), public.variant_cost(oi.variant_id), 0) as cost
          from public.order_items oi join o on o.id = oi.order_id
          where oi.quantity > 0) x
    group by x.order_id
  ), ch as (
    -- Courier charges recorded so far (each entry is a change, so the sum is the charge).
    select c.order_id, sum(c.amount) as recorded,
           bool_or(c.kind = 'DELIVERY') as has_delivery, bool_or(c.kind = 'RETURN') as has_return,
           bool_or(c.kind = 'COD_FEE') as has_cod
    from public.shipment_charges c join o on o.id = c.order_id
    group by c.order_id
  ), s as (
    select s.order_id, s.courier_id, s.shipping_cost, s.return_charge, s.collected_amount
    from public.shipments s join o on o.id = s.order_id
    where s.is_active
  ), st as (
    select o.*, s.order_id is not null as booked, s.courier_id, s.shipping_cost, s.return_charge as parcel_return_charge,
           case when o.status = 'DELIVERED' then 'delivered'
                -- A paid return: the courier collected no more than the delivery charge and no kept goods are recorded.
                when o.status = 'PARTIALLY_DELIVERED' and not (o.partial_return = 0 and s.collected_amount is not null
                                                              and s.collected_amount <= o.delivery_charge) then 'delivered'
                when o.status in ('PARTIALLY_DELIVERED', 'RETURN_REQUESTED', 'RETURNING', 'RETURNED', 'FAILED_DELIVERY') then 'returned'
                when o.status = 'LOST' then 'lost'
                when o.status in ('CANCELLED', 'REJECTED_FRAUD', 'PENDING_CANCEL') then 'cancelled'
                else 'open' end as state,
           -- Paid at the door; an amount as large as the whole order is the booked COD amount, not cash.
           case when s.collected_amount > 0 and s.collected_amount < o.total_amount then s.collected_amount else 0 end as door
    from o left join s on s.order_id = o.id
  ), c as (
    -- What is not recorded yet, estimated the way the books post it on delivery or return.
    select st.*, coalesce(ch.recorded, 0) as recorded,
           case when (st.state in ('open', 'delivered') or (st.state = 'returned' and st.booked)) and not coalesce(ch.has_delivery, false)
                then coalesce(nullif(st.shipping_cost, 0), st.delivery_charge) else 0 end
           + case when st.state in ('open', 'delivered') and st.courier_id is not null and not coalesce(ch.has_cod, false)
                  then coalesce(public._courier_cod_fee(st.courier_id, st.cod_amount), 0) else 0 end
           + case when st.state = 'returned' and st.booked and not coalesce(ch.has_return, false)
                  then coalesce(nullif(st.parcel_return_charge, 0), st.return_charge) else 0 end as estimated,
           coalesce(i.cost_all, 0) as cost_all, coalesce(i.cost_kept, 0) as cost_kept, coalesce(i.missing, false) as missing
    from st left join ch on ch.order_id = st.id left join i on i.order_id = st.id
  )
  select c.id, c.day, c.state,
         case c.state when 'open' then c.total_amount
                      when 'delivered' then greatest(c.total_amount - c.partial_return - c.amount_refunded, 0)
                      else 0 end,
         case c.state when 'open' then c.cost_all when 'delivered' then c.cost_kept when 'lost' then c.cost_all else 0 end,
         c.recorded + c.estimated,
         -- Paid towards a return: at the door, or an advance (one the business kept counts in full, one not
         -- settled yet up to the charges). A door payment the courier later settles is also in the advance
         -- column (amount_paid), so the larger of the two counts, not both.
         case when c.state not in ('returned', 'cancelled') then 0
              when c.advance_resolution = 'RETAINED' then greatest(c.door, c.kept)
              else greatest(c.door, least(c.kept, greatest(c.recorded + c.estimated, 0))) end,
         c.estimated > 0,
         c.missing and c.state in ('open', 'delivered', 'lost')
  from c
$$;
revoke all on function public._order_profit_rows(date, date) from public, anon, authenticated;

select public._tenancy_own_functions();
