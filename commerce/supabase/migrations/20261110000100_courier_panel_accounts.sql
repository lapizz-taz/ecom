-- =============================================================================
-- Courier panel accounts (platform account)
--   The company's own logins to the courier merchant panels (Steadfast,
--   Pathao, RedX, Carrybee, Paperfly), connected once in Super Admin and used
--   for every merchant — the same model as the BD Courier Integration. We sign
--   in to each panel the way a browser would and read its customer success /
--   fraud page for a phone number. A second delivery-success source next to BD
--   Courier; it is metered the same way (free allowance, then credits).
--
--   Logins live in Vault under the existing platform_secret mechanism
--   (key 'courier_panel'); only masked hints and the connection/test status go
--   in platform_settings('courier_panel') for the Super Admin screen to read.
-- =============================================================================

-- Connection/status row for the Super Admin screen (no secrets here).
insert into public.platform_settings (key, value, description) values
  ('courier_panel', jsonb_build_object('connected', false, 'providers', '{}'::jsonb),
   'Courier sign-in accounts (Steadfast, Pathao, RedX, Carrybee, Paperfly): which are connected and their last test')
on conflict (key) do nothing;

-- Merge one courier's status into platform_settings('courier_panel'). System
-- context only (the platform-admin edge function calls it with the service
-- role), mirroring platform_bd_courier_set_connection.
create or replace function public.platform_courier_panel_set(
  p_provider text, p_hint text, p_actor uuid, p_connected boolean default null, p_test_ok boolean default null, p_error text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb;
  v_providers jsonb;
  v_entry jsonb;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_provider !~ '^(steadfast|pathao|redx|carrybee|paperfly)$' then
    raise exception 'VALIDATION: bad provider' using errcode = '22023';
  end if;
  select value into v from public.platform_settings where key = 'courier_panel' for update;
  v := coalesce(v, jsonb_build_object('connected', false, 'providers', '{}'::jsonb));
  v_providers := coalesce(v -> 'providers', '{}'::jsonb);

  if p_connected is false then
    v_providers := v_providers - p_provider;
  else
    v_entry := coalesce(v_providers -> p_provider, '{}'::jsonb);
    if p_connected is true then
      v_entry := v_entry || jsonb_build_object('connected', true, 'hint', left(p_hint, 120), 'connected_at', now());
    end if;
    if p_test_ok is not null then
      v_entry := v_entry || jsonb_build_object('last_test_at', now(), 'last_test_ok', p_test_ok, 'last_error', left(p_error, 300));
    end if;
    v_providers := v_providers || jsonb_build_object(p_provider, v_entry);
  end if;

  v := v || jsonb_build_object('providers', v_providers, 'connected', v_providers <> '{}'::jsonb);
  update public.platform_settings set value = v, updated_by = coalesce(p_actor, updated_by) where key = 'courier_panel';

  perform public._platform_log(
    case when p_connected is false then 'courier_panel.disconnected' when p_connected is true then 'courier_panel.connected' else 'courier_panel.tested' end,
    null, 'platform_credential', 'courier_panel', null, null, jsonb_build_object('provider', p_provider, 'hint', p_hint));
  return v;
end;
$$;

revoke execute on function public.platform_courier_panel_set(text, text, uuid, boolean, boolean, text) from public, anon, authenticated;
grant execute on function public.platform_courier_panel_set(text, text, uuid, boolean, boolean, text) to service_role, app_owner;

-- platform_settings has row-level security with no policies, so only a
-- superuser-owned definer may write it. Keep this function postgres-owned
-- (exempt from the tenant re-ownership), exactly like platform_bd_courier_set_connection.
insert into public.tenancy_exempt_functions (name, reason) values
  ('platform_courier_panel_set', 'Platform: writes platform_settings; no merchant')
on conflict (name) do nothing;

select public._tenancy_own_functions();
