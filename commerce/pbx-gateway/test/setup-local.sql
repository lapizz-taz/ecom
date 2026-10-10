-- Local end-to-end setup (dev database only): one line on a fake IPTSP at
-- 127.0.0.1:5070, the gateway token "vdgw-local-test-token-0123456789abcdef",
-- a package, 50 tk balance, and owner@example.com as extension 101.
\set ON_ERROR_STOP on
do $$
declare
  v_biz uuid := (select id from public.pbx_businesses where is_primary);
  v_owner uuid := (select id from public.profiles where email = 'owner@example.com');
  v_pkg uuid := (select id from public.pbx_packages where code = 'GROWTH');
begin
  perform public.pbx_admin_save_settings(jsonb_build_object('sip_domain', '127.0.0.1', 'wss_url', 'ws://127.0.0.1:8088/ws',
    'stun_urls', '[]'::jsonb, 'turn_urls', '[]'::jsonb));
  perform public.pbx_provision_business_did(jsonb_build_object('business_id', v_biz, 'did', '09639123456', 'trunk_host', '127.0.0.2',
    'trunk_port', 5070, 'trunk_user', 'acct1', 'trunk_register', true, 'pbx_enabled', true));
  perform public.integration_secret_store('voicedrive.trunk.' || replace(v_biz::text, '-', ''), '{"password":"trunkpass"}'::jsonb, '••ss', v_owner);
  perform public.pbx_admin_mark_trunk_secret(v_biz, true);
  perform public.integration_secret_store('voicedrive.gateway',
    jsonb_build_object('token_sha256', encode(sha256('vdgw-local-test-token-0123456789abcdef'::bytea), 'hex')), 'vdgw_••••cdef', v_owner);
  if not (public._vd_limits(v_biz) ->> 'active')::boolean then
    perform public.pbx_admin_grant_package(jsonb_build_object('business_id', v_biz, 'package_id', v_pkg, 'months', 1));
  end if;
  if public._vd_balance(v_biz) < 20 then
    perform public.pbx_admin_adjust_balance(v_biz, 50, 'Local test credit');
  end if;
  if not exists (select 1 from public.pbx_agents where profile_id = v_owner) then
    perform public.pbx_save_agent(jsonb_build_object('profile_id', v_owner, 'extension', '101'));
  end if;
  perform public.pbx_gw_ping('setup', '{}');
  perform public.pbx_set_pbx_bridge_ready(v_biz, true);
end $$;
select code, did, bridge_ready from public.pbx_businesses where is_primary;
select sip_username from public.pbx_agents;
