-- =============================================================================
-- Super Edit without the extra friction: no reason and no password step.
-- Still limited to staff with orders.override (checked here, not in the UI),
-- still walks the normal steps unless forced, and every override is still in
-- the audit log with who did it and what changed (the reason, if given).
-- =============================================================================

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
  v_skipped int := 0;
begin
  perform public.require_permission('orders.override');

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
  v_note := 'Super Edit' || coalesce(': ' || nullif(trim(p_reason), ''), '');

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
    jsonb_build_object('reason', nullif(trim(p_reason), ''), 'mode', v_mode, 'path', to_jsonb(v_path), 'order_number', v_order.order_number,
                       'messages_skipped', v_skipped));
  return jsonb_build_object('order', to_jsonb(v_order), 'mode', v_mode, 'path', to_jsonb(v_path), 'messages_skipped', v_skipped);
end;
$$;
