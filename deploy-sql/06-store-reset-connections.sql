-- Step 1 of 2. Paste into Supabase → SQL editor → Run.
-- Makes a full ("Everything") store reset also remove Shopify/WooCommerce connections and their saved keys.

do $$
declare
  v_def text := replace(pg_get_functiondef('public.platform_store_reset(uuid, text, text, text)'::regprocedure), E'\r', '');
  v_new text;
begin
  v_new := replace(v_def,
    $o$    update public.sales_channels set first_sync_at = null, catalog_imported_at = null,
      settings = settings || '{"inventory_sync": false}'::jsonb
    where merchant_id = p_merchant;$o$,
    $n$    -- Store connections go too, with their saved keys.
    delete from public.channel_oauth_states where merchant_id = p_merchant;
    delete from vault.secrets where id in (
      select secret_id from public.integration_credentials
      where merchant_id = p_merchant and key like 'channels.%' and secret_id is not null);
    delete from public.integration_credentials where merchant_id = p_merchant and key like 'channels.%';
    delete from public.sales_channels where merchant_id = p_merchant;
    get diagnostics n = row_count; v := v || jsonb_build_object('store_connections', n);$n$);
  if v_new = v_def then
    raise exception 'store reset connections: platform_store_reset() has changed; update this migration';
  end if;
  execute v_new;
end $$;

select public._tenancy_own_functions();

insert into supabase_migrations.schema_migrations (version, name)
values (to_char(now() at time zone 'utc', 'YYYYMMDDHH24MISS'), 'store_reset_connections') on conflict do nothing;
