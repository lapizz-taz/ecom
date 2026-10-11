-- Step 2 of 2. Paste into Supabase → SQL editor → Run.
-- Finishes Isolation's reset of 11 Oct: removes the 4 store connections it left
-- behind (all disconnected, no orders, no synced data) and their saved keys, so
-- Sales channels starts empty. Nothing else is touched.
do $$
declare
  v_m uuid := (select id from public.merchants where slug = 'isolation');
  v_n int;
begin
  if v_m is null then raise exception 'Isolation not found'; end if;
  if exists (select 1 from public.orders where merchant_id = v_m and sales_channel_id is not null) then
    raise exception 'Some orders still point at a store connection; nothing was removed';
  end if;
  perform set_config('app.merchant_id', v_m::text, true);
  delete from public.channel_oauth_states where merchant_id = v_m;
  delete from vault.secrets where id in (
    select secret_id from public.integration_credentials
    where merchant_id = v_m and key like 'channels.%' and secret_id is not null);
  delete from public.integration_credentials where merchant_id = v_m and key like 'channels.%';
  delete from public.sales_channels where merchant_id = v_m and status = 'DISCONNECTED';
  get diagnostics v_n = row_count;
  insert into public.audit_logs (merchant_id, action, entity_type, entity_id, metadata)
  values (v_m, 'store.reset.connections', 'merchant', v_m::text, jsonb_build_object('removed_connections', v_n));
  raise notice 'Removed % store connections', v_n;
end $$;
