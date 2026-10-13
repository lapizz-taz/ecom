-- Send the customer's courier receive rate with each WooCommerce order-status
-- update, so the Fullfilio Connect plugin's ad tracking can skip a
-- low-receive-rate order (plugin 1.3.0 reads `receive_rate` in
-- FFC_Orders::apply_from_fullfilio). Identical to the live definition except
-- for the one new 'receive_rate' key in the 'order' object.
--
-- The rate comes from the order's fraud check (metrics.receive_rate, falling
-- back to courier_score, the same rule the order list uses). The cast is
-- guarded so a malformed value yields null instead of failing the whole
-- fulfilment sync.

create or replace function public.channel_fulfillment_context(p_order_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_order public.orders;
  v_eff public.orders;
  v_f public.channel_fulfillments;
  v_ship record;
  v_c public.sales_channels;
  v_sync public.channel_order_sync;
  v_import jsonb;
begin
  perform public._require_system();
  select * into v_order from public.orders where id = p_order_id;
  select * into v_eff from public.orders where id = public._effective_order_id(p_order_id);
  select * into v_c from public.sales_channels where id = v_order.sales_channel_id;
  select * into v_f from public.channel_fulfillments where order_id = p_order_id and source = 'APP';
  select * into v_sync from public.channel_order_sync where order_id = p_order_id;
  select payload -> 'lines' into v_import from public.channel_order_imports
  where channel_id = v_order.sales_channel_id and order_id = p_order_id order by created_at desc limit 1;
  select s.consignment_id, s.tracking_number, s.created_at, s.status, c.name as courier_name, c.provider, c.tracking_url_template
  into v_ship from public.shipments s join public.couriers c on c.id = s.courier_id
  where s.order_id = v_eff.id and s.is_active order by s.created_at desc limit 1;
  return jsonb_build_object(
    'order', jsonb_build_object('id', v_order.id, 'order_number', v_order.order_number, 'status', v_eff.status,
      'own_status', v_order.status, 'merged_into', case when v_eff.id <> v_order.id then v_eff.order_number end,
      'external_order_id', v_order.external_order_id, 'customer_email', v_order.customer_email, 'shipped_at', v_eff.shipped_at,
      'delivered_at', v_eff.delivered_at, 'payment_method', v_order.payment_method, 'was_delivered', v_eff.delivered_at is not null,
      'receive_rate', (select coalesce(
          case when (fc.metrics ->> 'receive_rate') ~ '^-?[0-9]+(\.[0-9]+)?$' then (fc.metrics ->> 'receive_rate')::numeric end,
          fc.courier_score)
        from public.fraud_checks fc
        where fc.id = coalesce(v_order.fraud_check_id, v_eff.fraud_check_id) and fc.status <> 'ERROR')),
    'fulfillment', case when v_f.id is null then null else to_jsonb(v_f) end,
    'delivered_target', coalesce(v_f.fulfillment_id, (select f.fulfillment_id from public.channel_fulfillments f
      where f.order_id = p_order_id and f.source = 'SHOPIFY' and f.fulfillment_id is not null order by f.created_at desc limit 1)),
    'sync', case when v_sync.order_id is null then null else to_jsonb(v_sync) end,
    'settings', jsonb_build_object(
      'inventory_sync', public._channel_opt(v_c, 'inventory_sync', false),
      'mark_paid_on_delivery', public._channel_opt(v_c, 'mark_paid_on_delivery', true),
      'status_tags', public._channel_opt(v_c, 'status_tags', true),
      'courier_events', public._channel_opt(v_c, 'courier_events', true),
      'status_sync', public._channel_opt(v_c, 'status_sync', true),
      'fulfill_on_ship', public._channel_opt(v_c, 'fulfill_on_ship', v_c.platform = 'SHOPIFY')),
    'status_tag', case when v_eff.id <> v_order.id and v_eff.status <> 'CANCELLED'
      then public._channel_status_tag(v_eff.status) else public._channel_status_tag(v_order.status) end,
    'merged_tag', case when v_eff.id <> v_order.id then 'Fullfilio: merged into ' || v_eff.order_number end,
    'shipment', case when v_ship is null then null else jsonb_build_object(
      'courier', v_ship.courier_name, 'provider', v_ship.provider,
      'tracking', coalesce(v_ship.consignment_id, v_ship.tracking_number),
      'tracking_url', case when v_ship.tracking_url_template is not null and coalesce(v_ship.consignment_id, v_ship.tracking_number) is not null
        then replace(v_ship.tracking_url_template, '{tracking}', coalesce(v_ship.consignment_id, v_ship.tracking_number)) end,
      'shipped_at', v_ship.created_at) end,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('variant_id', i.variant_id, 'sku', i.sku,
        'quantity', i.quantity - i.returned_quantity,
        'external_variant_id', (select m.external_variant_id from public.sales_channel_variants m
                                where m.channel_id = v_order.sales_channel_id and m.variant_id = i.variant_id limit 1)))
      from public.order_items i where i.order_id = p_order_id), '[]'::jsonb),
    'restock_lines', coalesce((select jsonb_agg(jsonb_build_object(
        'external_variant_id', coalesce(
          (select m.external_variant_id from public.sales_channel_variants m where m.channel_id = v_order.sales_channel_id and m.variant_id = i.variant_id limit 1),
          (select l ->> 'external_variant_id' from jsonb_array_elements(coalesce(v_import, '[]'::jsonb)) l
           where nullif(l ->> 'sku', '') is not null and l ->> 'sku' = i.sku limit 1)),
        'sku', i.sku, 'name', i.product_name, 'quantity', i.returned_quantity) order by i.created_at)
      from public.order_items i where i.order_id = p_order_id and i.returned_quantity > 0), '[]'::jsonb)
  );
end;
$function$;
