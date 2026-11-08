-- =============================================================================
-- Scanner: a partly delivered parcel coming back.
--
-- Asked for on 8 Nov 2026. A courier (Pathao) marks a parcel "partial delivery": the customer kept some
-- items and the rest come back. Scanning that parcel in Returned mode used to answer "Delivered — final,
-- it cannot be returned", and nothing happened. Now:
--   * The scan answers CHOOSE with the order's items, and the scan screen opens a popup where staff tick
--     what is in the parcel (Restock or Damaged). Receiving goes through process_order_return, which
--     already handles a partial delivery (only those items come back; the order stays partly delivered).
--   * Items already recorded with "Partial delivery…" come back as expected_back, so the popup is filled in.
--   * Once the items sent back were received, scanning again answers ALREADY.
--   * Pathao gives the return its own consignment number (return_consignment_id in its webhook). Scanning
--     that label finds the order too.
-- A fully delivered parcel still answers "Delivered — final".
--
-- Changed: scan_parcel(), the parcel_scans result check (adds CHOOSE). New: an index on the return
-- consignment number. Safe to re-run.
-- =============================================================================

alter table public.parcel_scans drop constraint if exists parcel_scans_result_check;
alter table public.parcel_scans add constraint parcel_scans_result_check
  check (result in ('OK', 'ALREADY', 'ERROR', 'NOT_FOUND', 'CHOOSE'));

create index if not exists shipment_events_return_consignment_idx
  on public.shipment_events ((upper(raw ->> 'return_consignment_id')))
  where raw ? 'return_consignment_id';

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
  v_recorded jsonb;
  v_items jsonb;
  v_summary jsonb;
begin
  perform public.require_permission('orders.fulfill');
  if v_action not in ('READY_TO_SHIP', 'SHIPPED', 'RETURNED', 'LOOKUP') then
    raise exception 'VALIDATION: unknown scan action' using errcode = '22023';
  end if;
  if length(v_code) < 3 or length(v_code) > 64 then
    raise exception 'VALIDATION: scan a valid order or tracking barcode' using errcode = '22023';
  end if;

  select * into v_order from public.orders where v_code in (upper(order_number), upper(web_number)) order by upper(order_number) = v_code desc limit 1 for update;
  if not found then
    select o.* into v_order from public.shipments s join public.orders o on o.id = s.order_id
    where s.is_active and (upper(s.tracking_number) = v_code or upper(s.consignment_id) = v_code)
    order by s.created_at desc limit 1;
    if found then
      select * into v_order from public.orders where id = v_order.id for update;
    end if;
  end if;
  -- The label on a parcel coming back can carry the courier's return consignment number.
  if v_order.id is null then
    select o.* into v_order from public.shipment_events e
      join public.shipments s on s.id = e.shipment_id
      join public.orders o on o.id = s.order_id
    where s.is_active and e.raw ? 'return_consignment_id' and upper(e.raw ->> 'return_consignment_id') = v_code
    order by e.created_at desc limit 1;
    if v_order.id is not null then
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
      elsif v_order.status = 'PARTIALLY_DELIVERED' then
        -- The customer kept part of it: staff choose what is in the parcel (nothing changes yet).
        if exists (select 1 from public.shipments where order_id = v_order.id and is_active and return_status = 'RECEIVED')
           or not exists (select 1 from public.order_items where order_id = v_order.id and quantity > returned_quantity + damaged_quantity) then
          v_result := 'ALREADY';
          v_message := 'The items sent back were already received';
        else
          v_result := 'CHOOSE';
          v_message := 'Partly delivered — choose what came back';
          -- What "Partial delivery…" recorded as sent back, when staff recorded it.
          select h.metadata -> 'items' into v_recorded from public.order_status_history h
          where h.order_id = v_order.id and h.metadata ? 'returned_value' and jsonb_typeof(h.metadata -> 'items') = 'array'
          order by h.created_at desc limit 1;
          select coalesce(jsonb_agg(jsonb_build_object(
              'id', oi.id, 'product_name', oi.product_name, 'variant_title', oi.variant_title, 'sku', oi.sku,
              'quantity', oi.quantity, 'returned_quantity', oi.returned_quantity, 'damaged_quantity', oi.damaged_quantity,
              'expected_back', coalesce((select sum(greatest(coalesce((x ->> 'quantity')::int, 0), 0))
                                         from jsonb_array_elements(coalesce(v_recorded, '[]'::jsonb)) x
                                         where x ->> 'order_item_id' = oi.id::text), 0))
            order by oi.created_at, oi.id), '[]'::jsonb)
          into v_items from public.order_items oi where oi.order_id = v_order.id;
        end if;
      elsif v_order.status = 'DELIVERED' then
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
    v_items := null;
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

  v_summary := public._scan_summary(v_order.id);
  if v_items is not null then
    v_summary := v_summary || jsonb_build_object('items', v_items);
  end if;
  return jsonb_build_object('result', v_result, 'message', v_message, 'code', v_code,
    'from_status', v_from, 'order', v_summary);
end;
$$;
