-- Delivered is final for the scanner too: scanning a delivered (or partly delivered) parcel
-- as "Returned" is refused with a clear message instead of turning it into a return.
create or replace function public.scan_parcel(p_code text, p_action text, p_courier_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g'));
  v_action text := upper(coalesce(p_action, 'LOOKUP'));
  v_order public.orders;
  v_from public.order_status;
  v_result text := 'OK';
  v_message text;
  v_note text;
begin
  perform public.require_permission('orders.fulfill');
  if v_action not in ('READY_TO_SHIP', 'SHIPPED', 'RETURNED', 'LOOKUP') then
    raise exception 'VALIDATION: unknown scan action' using errcode = '22023';
  end if;
  if length(v_code) < 3 or length(v_code) > 64 then
    raise exception 'VALIDATION: scan a valid order or tracking barcode' using errcode = '22023';
  end if;

  select * into v_order from public.orders where upper(order_number) = v_code for update;
  if not found then
    select o.* into v_order from public.shipments s join public.orders o on o.id = s.order_id
    where s.is_active and (upper(s.tracking_number) = v_code or upper(s.consignment_id) = v_code)
    order by s.created_at desc limit 1;
    if found then
      select * into v_order from public.orders where id = v_order.id for update;
    end if;
  end if;

  if v_order.id is null then
    insert into public.parcel_scans(code, action, result, message, courier_id, scanned_by, scanned_by_name)
    values (v_code, v_action, 'NOT_FOUND', 'No order matches this barcode', p_courier_id, auth.uid(), public.actor_display_name());
    return jsonb_build_object('result', 'NOT_FOUND', 'message', 'No order matches this barcode', 'code', v_code);
  end if;

  v_from := v_order.status;
  v_note := 'Scanned at packing desk';
  begin
    if v_action = 'LOOKUP' then
      v_message := 'Found';
    elsif v_order.status in ('CANCELLED', 'REJECTED_FRAUD') then
      v_result := 'ERROR';
      v_message := 'Order is cancelled — do not ship';
    elsif v_action in ('READY_TO_SHIP', 'SHIPPED') and v_order.status = 'PENDING_CANCEL' and v_order.shipped_at is null then
      v_result := 'ERROR';
      v_message := 'A cancellation was asked for — do not ship';
    elsif v_action = 'READY_TO_SHIP' then
      if v_order.status = 'READY_TO_SHIP' then
        v_result := 'ALREADY';
        v_message := 'Already ready to ship';
      elsif v_order.shipped_at is not null then
        v_result := 'ALREADY';
        v_message := 'Already ' || replace(lower(v_order.status::text), '_', ' ');
      else
        v_order := public._scan_to_ready(v_order, v_note);
        v_message := 'Ready to ship';
      end if;
    elsif v_action = 'SHIPPED' then
      if v_order.status = 'SHIPPED' then
        v_result := 'ALREADY';
        v_message := 'Already shipped';
      elsif v_order.shipped_at is not null then
        v_result := 'ALREADY';
        v_message := 'Already ' || replace(lower(v_order.status::text), '_', ' ');
      else
        if v_order.status <> 'READY_TO_SHIP' then
          v_order := public._scan_to_ready(v_order, v_note);
        end if;
        if p_courier_id is not null
           and not exists (select 1 from public.shipments where order_id = v_order.id and is_active) then
          perform public.assign_courier(v_order.id, p_courier_id, null, null, 'Assigned at packing desk');
        end if;
        v_order := public._transition_order(v_order.id, 'SHIPPED', 'Handed to courier (scanned)');
        v_message := 'Shipped';
      end if;
    elsif v_action = 'RETURNED' then
      if v_order.status = 'RETURNED' then
        v_result := 'ALREADY';
        v_message := 'Already received back';
      elsif v_order.status = 'SHIPPED' then
        v_order := public._transition_order(v_order.id, 'RETURNING', 'Parcel came back (scanned)');
        v_order := public._transition_order(v_order.id, 'RETURNED', 'Returned parcel received (scanned)');
        v_message := 'Returned to stock';
      elsif v_order.status in ('DELIVERED', 'PARTIALLY_DELIVERED') then
        v_result := 'ERROR';
        v_message := 'Delivered — final, it cannot be returned. Adjust stock by hand if the item really came back';
      elsif v_order.status in ('FAILED_DELIVERY', 'RETURN_REQUESTED', 'RETURNING', 'LOST')
         or (v_order.status = 'PENDING_CANCEL' and v_order.shipped_at is not null) then
        v_order := public._transition_order(v_order.id, 'RETURNED', 'Returned parcel received (scanned)');
        v_message := 'Returned to stock';
      else
        v_result := 'ERROR';
        v_message := 'This order has not been shipped';
      end if;
    end if;
  exception when others then
    v_result := 'ERROR';
    v_message := regexp_replace(sqlerrm, '^[A-Z_]+: ', '');
    select * into v_order from public.orders where id = v_order.id;
  end;

  insert into public.parcel_scans(code, action, order_id, order_number, result, message, from_status, to_status,
                                  courier_id, scanned_by, scanned_by_name)
  values (v_code, v_action, v_order.id, v_order.order_number, v_result, v_message, v_from,
          case when v_order.status <> v_from then v_order.status end, p_courier_id, auth.uid(), public.actor_display_name());
  if v_action <> 'LOOKUP' then
    perform public._order_log(v_order.id, 'PARCEL_SCANNED',
      format('Scanned for %s: %s', replace(lower(v_action), '_', ' '), v_message), null, null,
      jsonb_build_object('action', v_action, 'result', v_result, 'code', v_code));
  end if;

  return jsonb_build_object('result', v_result, 'message', v_message, 'code', v_code,
    'from_status', v_from, 'order', public._scan_summary(v_order.id));
end;
$$;
