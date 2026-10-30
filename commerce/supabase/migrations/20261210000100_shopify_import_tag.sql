-- =============================================================================
-- Every Shopify order imported into Fullfilio gets the tag "Fullfilio" in Shopify.
--
-- Asked for on 30 Oct 2026: in Shopify you can see at a glance which orders came into Fullfilio and which
-- did not (Orders → filter "Tagged with: Fullfilio", or "Not tagged with").
--   * The tag is written as soon as the order is imported. Before, a Shopify order only got a tag
--     ("Fullfilio: <status>") once its status changed here, so a new order had none.
--   * It stays on the order; the status tags ("Fullfilio: Confirmed", …) still follow the status.
--   * A switch per store, on by default: Sales channels → Shopify → Settings → "Tag imported orders".
--     Switching it back on tags the orders imported while it was off.
--   * The Shopify orders imported before today are tagged too.
-- The tags are written by the store sync job (channels function), as the status tags are; it needs the
-- write_orders permission, which the status tags already use.
--
-- Functions that change in a line are patched in place (CREATE OR REPLACE keeps each one's owner and
-- grants). Safe to re-run.
-- =============================================================================

-- 1. Queue the store sync for a channel's imported orders that do not carry the tag yet ---------------
-- (The sync job records the tags it wrote as "Fullfilio | Fullfilio: <status>": the first one is this tag.)

create or replace function public._channel_tag_imported_orders(p_channel_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_n integer := 0;
begin
  for v_id in
    select o.id from public.orders o join public.sales_channels c on c.id = o.sales_channel_id
    where c.id = p_channel_id and c.platform = 'SHOPIFY' and c.status <> 'DISCONNECTED' and o.external_order_id is not null
      and not exists (select 1 from public.channel_order_sync s
                      where s.order_id = o.id and (s.status_tag = 'Fullfilio' or s.status_tag like 'Fullfilio |%'))
  loop
    perform public._queue_channel_order_sync(v_id, false);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

revoke all on function public._channel_tag_imported_orders(uuid) from public, anon, authenticated;

-- 2. The import, the sync job and the settings ----------------------------------------------------------

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
    raise exception 'shopify import tag: % has changed (% matches for "%")', p_fn, v_hits, left(p_from, 60);
  end if;
  execute replace(v_old, p_from, p_to);
end $$;

-- A new import queues the store sync at once, so the tags go on without waiting for a status change.
select pg_temp.patch_fn('public.channel_ingest_order(uuid,jsonb,text)',
  $a$v_shown := public._after_order_created(v_order.id);$a$,
  $b$v_shown := public._after_order_created(v_order.id); if v_channel.platform = 'SHOPIFY' and public._channel_opt(v_channel, 'import_tag', true) then perform public._queue_channel_order_sync(v_order.id, false); end if;$b$);

-- The sync job reads the switch.
select pg_temp.patch_fn('public.channel_fulfillment_context(uuid)',
  $a$'status_tags', public._channel_opt(v_c, 'status_tags', true),$a$,
  $b$'status_tags', public._channel_opt(v_c, 'status_tags', true), 'import_tag', public._channel_opt(v_c, 'import_tag', true),$b$);

-- The settings page shows it (Shopify only) and saves it; switching it on tags the orders imported meanwhile.
select pg_temp.patch_fn('public.channel_inventory_overview(uuid)',
  $a$'status_tags', v_c.platform = 'SHOPIFY' and public._channel_opt(v_c, 'status_tags', true),$a$,
  $b$'status_tags', v_c.platform = 'SHOPIFY' and public._channel_opt(v_c, 'status_tags', true), 'import_tag', v_c.platform = 'SHOPIFY' and public._channel_opt(v_c, 'import_tag', true),$b$);
select pg_temp.patch_fn('public.channel_sync_settings_save(uuid,jsonb)',
  $a$'status_tags', (p ->> 'status_tags')::boolean,$a$,
  $b$'status_tags', (p ->> 'status_tags')::boolean, 'import_tag', (p ->> 'import_tag')::boolean,$b$);
select pg_temp.patch_fn('public.channel_sync_settings_save(uuid,jsonb)',
  $a$update public.sales_channels set settings = v_new where id = p_channel_id;$a$,
  $b$update public.sales_channels set settings = v_new where id = p_channel_id; if v_old.platform = 'SHOPIFY' and coalesce((v_new ->> 'import_tag')::boolean, true) and not public._channel_opt(v_old, 'import_tag', true) then perform public._channel_tag_imported_orders(p_channel_id); end if;$b$);

-- 3. The Shopify orders imported before today ------------------------------------------------------------
-- Each store's orders are queued as that business (the sync rows and jobs belong to it).

do $$
declare v_c record;
begin
  for v_c in
    select id, merchant_id from public.sales_channels
    where platform = 'SHOPIFY' and status <> 'DISCONNECTED' and coalesce((settings ->> 'import_tag')::boolean, true)
  loop
    perform set_config('app.merchant_id', v_c.merchant_id::text, true);
    perform public._channel_tag_imported_orders(v_c.id);
  end loop;
  perform set_config('app.merchant_id', '', true);
end $$;

select public._tenancy_own_functions();
