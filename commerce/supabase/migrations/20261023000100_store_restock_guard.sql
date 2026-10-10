-- Shopify's own restock for an order we also have is not counted twice.
--
-- Stock here follows our order: a cancel here releases it, a return is put
-- back when it is received, a delivered or lost order keeps nothing. When the
-- same order is also cancelled or returned in Shopify with "restock", Shopify
-- adds the items to its own count, and two-way stock then copied that here as
-- a change made in Shopify (Belt Diesel: returned here, then cancelled with
-- restock in Shopify, 5 became 6). Such a restock is now expected: the "last
-- pushed" marker moves with it, so it is not taken as a change made in
-- Shopify, and Shopify's count is set back to ours. Each restock line is
-- handled once; only restocks made after this change are looked at.
create or replace function public.channel_store_restock_seen(p_channel_id uuid, p_external_order_id text, p_lines jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_c public.sales_channels;
  v_order public.orders;
  v_line jsonb;
  v_m public.sales_channel_variants;
  v_qty int;
  v_loc text;
  v_since timestamptz;
  v_n int := 0;
  v_items text[] := '{}';
begin
  perform public._require_system();
  select * into v_c from public.sales_channels where id = p_channel_id;
  if not found or not public._channel_opt(v_c, 'inventory_sync', false) then
    return jsonb_build_object('status', 'SKIPPED');
  end if;
  select * into v_order from public.orders where sales_channel_id = p_channel_id and external_order_id = p_external_order_id;
  if not found then
    -- Never part of our stock here, so Shopify's restock is a real change.
    return jsonb_build_object('status', 'NO_ORDER');
  end if;
  v_loc := regexp_replace(coalesce(v_c.settings ->> 'location_id', ''), '^.*/', '');
  v_since := coalesce((v_c.settings ->> 'restock_guard_since')::timestamptz, v_c.created_at);
  for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    v_qty := coalesce((v_line ->> 'quantity')::int, 0);
    continue when v_qty <= 0 or coalesce(v_line ->> 'line_id', '') = '';
    continue when nullif(v_line ->> 'location_id', '') is not null and v_line ->> 'location_id' <> v_loc;
    continue when (v_line ->> 'created_at') is not null and (v_line ->> 'created_at')::timestamptz < v_since;
    insert into public.channel_webhook_deliveries(channel_id, delivery_id, topic)
    values (p_channel_id, 'restock:' || (v_line ->> 'line_id'), 'store_restock')
    on conflict do nothing;
    continue when not found;
    for v_m in select * from public.sales_channel_variants
               where channel_id = p_channel_id and external_variant_id = v_line ->> 'external_variant_id' and last_pushed_qty is not null
               for update loop
      update public.sales_channel_variants set last_pushed_qty = last_pushed_qty + v_qty
      where channel_id = v_m.channel_id and external_variant_id = v_m.external_variant_id;
      perform public.channel_job_enqueue(p_channel_id, 'INVENTORY', v_m.variant_id, '{}'::jsonb, 5);
      v_n := v_n + v_qty;
      v_items := v_items || coalesce((select p.name from public.product_variants pv join public.products p on p.id = pv.product_id where pv.id = v_m.variant_id), 'item');
    end loop;
  end loop;
  if v_n > 0 then
    perform public._order_log(v_order.id, 'CHANNEL_SYNC',
      format('Shopify put %s item(s) back in its stock for this order (%s). Not counted again here: stock here follows this order (now %s), so Shopify''s count is set back to ours.',
        v_n, array_to_string(v_items, ', '), lower(replace(v_order.status::text, '_', ' '))));
  end if;
  return jsonb_build_object('status', 'OK', 'ignored', v_n);
end;
$$;
revoke all on function public.channel_store_restock_seen(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.channel_store_restock_seen(uuid, text, jsonb) to service_role;

update public.sales_channels set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('restock_guard_since', now())
where not (coalesce(settings, '{}'::jsonb) ? 'restock_guard_since');
