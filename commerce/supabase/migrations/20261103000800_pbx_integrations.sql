-- =============================================================================
-- PBX Setup and Other Integrations for the platform team.
--
-- VoiceDrive becomes a platform service:
-- * Its settings (rates, gateway address, TURN, maintenance) are the
--   platform's, kept in platform_settings — not a row each merchant can edit.
-- * "PBX super admin" powers (numbers, trunks, packages, balances) belong to
--   platform staff with PBX manage access, acting on one merchant at a time.
--   A merchant's owner no longer has them.
-- * Merchants still manage their own agents and call groups; platform PBX
--   staff can do the same for them.
-- * PBX packages and top-ups are paid to the platform's bKash account (edge
--   function), never the merchant's own.
--
-- Other Integrations: one view of every merchant's stores, couriers, payment
-- gateways, ad accounts and the platform's own services, with safe retries.
-- Merchant credentials stay with the merchant; only their state is shown.
-- =============================================================================

-- Patches below compare and rewrite existing function text. Line endings are
-- normalized first, so they also apply when this file is pasted into an editor
-- that sends Windows line endings.
create or replace function pg_temp.lf(p text) returns text
language sql immutable as $$ select replace(p, E'\r', '') $$;
create or replace function pg_temp.lf_replace(p text, p_from text, p_to text) returns text
language sql immutable as $$ select replace(pg_temp.lf(p), pg_temp.lf(p_from), pg_temp.lf(p_to)) $$;

-- -----------------------------------------------------------------------------
-- 1. VoiceDrive settings are the platform's
-- -----------------------------------------------------------------------------
insert into public.platform_settings (key, value)
select 'voicedrive', coalesce(
  (select value from public.settings where merchant_id = '00000000-0000-4000-8000-000000000001' and key = 'voicedrive'),
  jsonb_build_object('rate_tk_per_min', 0.40, 'vat_percent', 15, 'min_topup_tk', 100, 'max_topup_tk', 50000, 'extra_agent_tk', 100,
    'extra_channel_tk', 150, 'credential_ttl_seconds', 900, 'sip_domain', null, 'wss_url', null,
    'stun_urls', jsonb_build_array('stun:stun.l.google.com:19302'), 'turn_urls', '[]'::jsonb, 'turn_ttl_seconds', 3600,
    'maintenance', jsonb_build_object('starts_at', null, 'until', null, 'message', null)))
on conflict (key) do nothing;

create or replace function public._vd_cfg()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select value from public.platform_settings where key = 'voicedrive'), '{}'::jsonb)
$$;
alter function public._vd_cfg() owner to postgres;

-- What the voicedrive edge function needs (WebSocket address, ICE servers, TTLs).
create or replace function public.platform_voicedrive_config()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public._vd_cfg()
$$;

-- Platform staff with PBX manage access for the merchant in context (and
-- trusted server code). Merchant roles never qualify.
create or replace function public._vd_is_super()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_system_context() or public.platform_can('pbx', 'manage', public.current_merchant_id())
$$;
grant execute on function public.platform_can(text, text, uuid) to app_owner;

create or replace function public._vd_require_super()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public._vd_is_super() then
    raise exception 'PERMISSION_DENIED: PBX lines, packages and balances are set up by the platform team' using errcode = '42501';
  end if;
end;
$$;

-- The merchant's own PBX managers keep agents and call groups; platform PBX
-- staff may manage them too.
do $$
declare
  f text;
  v_old text;
  v_check text := 'perform public.require_permission(''pbx.manage'');';
begin
  foreach f in array array['public.pbx_list_agents(uuid)', 'public.pbx_save_agent(jsonb)', 'public.pbx_remove_agent(uuid)',
    'public.pbx_list_ring_groups(uuid)', 'public.pbx_save_ring_group(jsonb)', 'public.pbx_set_business_settings(jsonb)',
    'public.pbx_billing_history(uuid, int)', 'public.pbx_reports(date, date, uuid)']
  loop
    v_old := pg_temp.lf(pg_get_functiondef(f::regprocedure));
    if position(pg_temp.lf(v_check) in v_old) = 0 then
      raise exception 'pbx platform: % has changed; update this migration', f;
    end if;
    execute pg_temp.lf_replace(v_old, v_check, 'if not public._vd_is_super() then
    perform public.require_permission(''pbx.manage'');
  end if;');
  end loop;
end $$;

create or replace function public.pbx_admin_save_settings(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception 'VALIDATION: VoiceDrive settings are managed by the platform (Super Admin → PBX Setup)' using errcode = '22023';
end;
$$;

-- Platform staff provision lines; they are not merchant profiles.
alter table public.pbx_businesses
  drop constraint pbx_businesses_bridge_ready_by_fkey,
  drop constraint pbx_businesses_provisioned_by_fkey,
  add constraint pbx_businesses_bridge_ready_by_fkey foreign key (bridge_ready_by) references auth.users(id),
  add constraint pbx_businesses_provisioned_by_fkey foreign key (provisioned_by) references auth.users(id);

-- -----------------------------------------------------------------------------
-- 2. PBX Setup
-- -----------------------------------------------------------------------------
-- Acts inside one merchant for the rest of this request (platform staff only:
-- current_merchant_id() honours app.merchant_id for them and for server code).
create or replace function public._platform_in_merchant(p_merchant uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  select set_config('app.merchant_id', coalesce(p_merchant::text, ''), true)
$$;

create or replace function public._platform_pbx_business(p_merchant uuid)
returns public.pbx_businesses
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select * from public.pbx_businesses where merchant_id = p_merchant order by is_primary desc, created_at limit 1
$$;

-- What the gateway reported about this merchant's trunk on its last check-in.
create or replace function public._platform_pbx_trunk_state(p_code int)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'reported', (select t ->> 'state' from public.pbx_gateway_status g, jsonb_array_elements(coalesce(g.detail -> 'trunks', '[]'::jsonb)) t
                 where t ->> 'name' = 'vdtrunk-' || p_code limit 1),
    'gateway_online', coalesce((select last_seen_at > now() - interval '2 minutes' from public.pbx_gateway_status), false),
    'gateway_seen_at', (select last_seen_at from public.pbx_gateway_status))
$$;

create or replace function public._platform_pbx_business_json(b public.pbx_businesses)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb;
begin
  if b.id is null then
    return null;
  end if;
  -- The VoiceDrive helpers read through row-level security: run them inside the merchant.
  perform public._platform_in_merchant(b.merchant_id);
  v := jsonb_build_object('id', b.id, 'code', b.code, 'name', b.name, 'did', b.did, 'caller_id', b.caller_id,
    'trunk_host', b.trunk_host, 'trunk_port', b.trunk_port, 'trunk_transport', b.trunk_transport, 'trunk_user', b.trunk_user,
    'trunk_register', b.trunk_register, 'trunk_secret_set', b.trunk_secret_set,
    'trunk_secret_hint', (select hint from public.platform_credentials where key = 'voicedrive.trunk.' || replace(b.id::text, '-', '')),
    'dial_format', b.dial_format, 'max_call_minutes', b.max_call_minutes, 'pbx_enabled', b.pbx_enabled,
    'bridge_ready', b.bridge_ready, 'bridge_ready_at', b.bridge_ready_at, 'provisioned_at', b.provisioned_at,
    'limits', public._vd_limits(b.id), 'balance_tk', round(public._vd_balance(b.id), 2), 'problems', to_jsonb(public._vd_line_problems(b.id)),
    'agents', (select count(*) from public.pbx_agents a where a.business_id = b.id and a.active),
    'trunk', public._platform_pbx_trunk_state(b.code));
  perform public._platform_in_merchant(null);
  return v;
end;
$$;

-- The merchant's own click-to-call setup with another PBX vendor: shown, not
-- managed here (their vendor account, their credentials).
create or replace function public._platform_pbx_click_to_call(p_merchant uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'enabled', coalesce((s.value ->> 'enabled')::boolean, false), 'provider', s.value ->> 'provider', 'mode', s.value ->> 'click_mode',
    'api_host', nullif(substring(s.value ->> 'api_url_template' from '^https?://([^/?#]+)'), ''),
    'extensions', jsonb_array_length(coalesce(s.value -> 'extensions', '[]'::jsonb)),
    'has_secret', exists (select 1 from public.integration_credentials ic where ic.merchant_id = p_merchant and ic.key = 'pbx' and ic.hint is not null),
    'calls_7d', (select count(*) from public.pbx_calls c where c.merchant_id = p_merchant and c.received_at > now() - interval '7 days'))
  from public.settings s where s.merchant_id = p_merchant and s.key = 'pbx'
$$;

create or replace function public.platform_pbx_overview()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows jsonb := '[]'::jsonb;
  m record;
begin
  perform public._platform_require('pbx', 'view');
  for m in
    select mm.id, mm.number, mm.name, mm.status, mm.is_demo from public.merchants mm
    where mm.id in (select public._platform_merchant_ids()) and mm.status <> 'CLOSED' order by mm.number
  loop
    v_rows := v_rows || jsonb_build_object('merchant', jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name, 'status', m.status, 'is_demo', m.is_demo),
      'feature', public.merchant_entitlements(m.id) -> 'pbx',
      'business', public._platform_pbx_business_json(public._platform_pbx_business(m.id)),
      'calls_7d', (select count(*) from public.pbx_call_records c where c.merchant_id = m.id and c.requested_at > now() - interval '7 days'),
      'last_call_at', (select max(requested_at) from public.pbx_call_records c where c.merchant_id = m.id),
      'click_to_call', public._platform_pbx_click_to_call(m.id));
  end loop;
  return jsonb_build_object(
    'merchants', v_rows,
    'gateway', (select jsonb_build_object('last_seen_at', last_seen_at, 'version', version, 'online', last_seen_at > now() - interval '2 minutes',
        'softphones_online', detail -> 'softphonesOnline', 'active_calls', detail -> 'activeCalls', 'trunk_sync', detail -> 'trunkSync',
        'trunks', detail -> 'trunks') from public.pbx_gateway_status),
    'settings', public._vd_cfg(),
    'secrets', jsonb_build_object(
      'gateway_token', (select jsonb_build_object('hint', hint, 'at', updated_at) from public.platform_credentials where key = 'voicedrive.gateway'),
      'turn_secret', (select jsonb_build_object('hint', hint, 'at', updated_at) from public.platform_credentials where key = 'voicedrive.turn')),
    'packages', coalesce((select jsonb_agg(to_jsonb(p) order by p.sort) from public.pbx_packages p), '[]'::jsonb),
    'can', jsonb_build_object('edit', public.platform_can('pbx', 'edit'), 'manage', public.platform_can('pbx', 'manage')));
end;
$$;

create or replace function public.platform_pbx_merchant(p_merchant uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  b public.pbx_businesses := public._platform_pbx_business(p_merchant);
  v jsonb;
begin
  if not exists (select 1 from public.merchants where id = p_merchant) or not public.platform_can('pbx', 'view', p_merchant) then
    raise exception 'NOT_FOUND: merchant not found' using errcode = 'P0002';
  end if;
  v := jsonb_build_object(
    'merchant', (select jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name, 'status', m.status) from public.merchants m where m.id = p_merchant),
    'feature', public.merchant_entitlements(p_merchant) -> 'pbx',
    'business', public._platform_pbx_business_json(b),
    'click_to_call', public._platform_pbx_click_to_call(p_merchant),
    'agents', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'extension', a.extension, 'sip_username', a.sip_username, 'active', a.active,
        'inbound_enabled', a.inbound_enabled, 'ring_group_id', a.ring_group_id, 'profile_id', a.profile_id,
        'name', coalesce(nullif(trim(p.full_name), ''), p.email), 'online', exists (select 1 from public.pbx_presence pr where pr.agent_id = a.id))
        order by a.extension) from public.pbx_agents a join public.profiles p on p.id = a.profile_id where a.business_id = b.id), '[]'::jsonb),
    'ring_groups', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'strategy', g.strategy, 'ring_seconds', g.ring_seconds,
        'is_default', g.is_default, 'active', g.active) order by g.is_default desc, g.name) from public.pbx_ring_groups g where g.business_id = b.id), '[]'::jsonb),
    'staff', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', coalesce(nullif(trim(p.full_name), ''), p.email), 'email', p.email)
        order by p.full_name) from public.profiles p where p.merchant_id = p_merchant and p.is_active), '[]'::jsonb),
    'subscriptions', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'package', pk.name, 'agents', s.agents, 'channels', s.channels,
        'months', s.months, 'amount_tk', s.amount_tk, 'starts_at', s.starts_at, 'expires_at', s.expires_at, 'status', s.status, 'source', s.source, 'note', s.note)
        order by s.created_at desc) from (select * from public.pbx_subscriptions where business_id = b.id order by created_at desc limit 10) s
        join public.pbx_packages pk on pk.id = s.package_id), '[]'::jsonb),
    'ledger', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'kind', l.kind, 'amount_tk', l.amount_tk, 'balance_after_tk', l.balance_after_tk,
        'note', l.note, 'created_at', l.created_at) order by l.created_at desc)
        from (select * from public.pbx_ledger where business_id = b.id order by created_at desc limit 20) l), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('reference', t.reference, 'type', t.type, 'amount_tk', t.amount_tk, 'status', t.status,
        'trx_id', t.trx_id, 'created_at', t.created_at, 'completed_at', t.completed_at, 'failure_reason', t.failure_reason) order by t.created_at desc)
        from (select * from public.pbx_bkash_transactions where business_id = b.id order by created_at desc limit 10) t), '[]'::jsonb),
    'calls', (select jsonb_build_object('total', count(*), 'answered', count(*) filter (where answered_at is not null),
        'missed', count(*) filter (where direction = 'INBOUND' and answered_at is null), 'minutes', round(coalesce(sum(billed_seconds), 0) / 60.0, 1),
        'charged_tk', round(coalesce(sum(charged_tk), 0), 2))
      from public.pbx_call_records where merchant_id = p_merchant and requested_at > now() - interval '30 days'),
    'history', coalesce((select jsonb_agg(jsonb_build_object('action', l.action, 'actor', l.actor_email, 'reason', l.reason, 'result', l.result, 'created_at', l.created_at)
        order by l.created_at desc) from (select * from public.platform_audit_logs where merchant_id = p_merchant and action like 'pbx.%'
        order by created_at desc limit 20) l), '[]'::jsonb),
    'can', jsonb_build_object('edit', public.platform_can('pbx', 'edit', p_merchant), 'manage', public.platform_can('pbx', 'manage', p_merchant)));
  return v;
end;
$$;

-- Creates the merchant's PBX line if there is none, and saves the number and
-- trunk (the trunk password is saved by the platform-admin edge function).
create or replace function public.platform_pbx_setup(p_merchant uuid, p jsonb, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  b public.pbx_businesses := public._platform_pbx_business(p_merchant);
  v_before jsonb;
  v_after jsonb;
begin
  if not exists (select 1 from public.merchants where id = p_merchant and status <> 'CLOSED') or not public.platform_can('pbx', 'view', p_merchant) then
    raise exception 'NOT_FOUND: merchant not found' using errcode = 'P0002';
  end if;
  perform public._platform_require('pbx', 'manage', p_merchant);
  perform public._platform_in_merchant(p_merchant);
  if b.id is null then
    insert into public.pbx_businesses (merchant_id, name, is_primary)
    values (p_merchant, (select name from public.merchants where id = p_merchant), true) returning * into b;
    insert into public.pbx_ring_groups (merchant_id, business_id, name, is_default) values (p_merchant, b.id, 'Everyone', true);
  end if;
  v_before := to_jsonb(b) - 'trunk_user';
  -- Checked across every merchant (the line procedure only sees this one).
  if exists (select 1 from public.pbx_businesses x where x.did = public.normalize_phone(nullif(trim(p ->> 'did'), '')) and x.id <> b.id) then
    raise exception 'VALIDATION: this number is already used by another merchant' using errcode = '22023';
  end if;
  if coalesce(p ->> 'did', '') <> '' or coalesce(p ->> 'trunk_host', '') <> '' then
    perform public.pbx_provision_business_did(p || jsonb_build_object('business_id', b.id));
  end if;
  if p ? 'max_call_minutes' then
    if (p ->> 'max_call_minutes')::int not between 1 and 120 then
      raise exception 'VALIDATION: the longest call is 1–120 minutes' using errcode = '22023';
    end if;
    update public.pbx_businesses set max_call_minutes = (p ->> 'max_call_minutes')::int where id = b.id;
  end if;
  select to_jsonb(x) - 'trunk_user' into v_after from public.pbx_businesses x where id = b.id;
  perform public._platform_in_merchant(null);
  perform public._platform_log('pbx.configured', p_merchant, 'pbx_business', b.id::text, p_reason, v_before, v_after);
  return public._platform_pbx_business_json((select x from public.pbx_businesses x where id = b.id));
end;
$$;

-- Switches the merchant's PBX line on or off.
create or replace function public.platform_pbx_set_enabled(p_merchant uuid, p_enabled boolean, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  b public.pbx_businesses := public._platform_pbx_business(p_merchant);
begin
  if b.id is null or not public.platform_can('pbx', 'view', p_merchant) then
    raise exception 'NOT_FOUND: set up the merchant''s PBX line first' using errcode = 'P0002';
  end if;
  perform public._platform_require('pbx', 'manage', p_merchant);
  if length(trim(coalesce(p_reason, ''))) < 5 then
    raise exception 'VALIDATION: say why (kept in the audit log)' using errcode = '22023';
  end if;
  if p_enabled and (b.did is null or b.trunk_host is null) then
    raise exception 'VALIDATION: add the number and the trunk before switching the line on' using errcode = '22023';
  end if;
  update public.pbx_businesses set pbx_enabled = p_enabled where id = b.id;
  perform public._platform_log(case when p_enabled then 'pbx.enabled' else 'pbx.disabled' end, p_merchant, 'pbx_business', b.id::text, trim(p_reason),
    jsonb_build_object('pbx_enabled', b.pbx_enabled), jsonb_build_object('pbx_enabled', p_enabled));
  return public._platform_pbx_business_json((select x from public.pbx_businesses x where id = b.id));
end;
$$;

-- Marks the line tested on the gateway (only when the gateway is online and the trunk is complete).
create or replace function public.platform_pbx_bridge_ready(p_merchant uuid, p_ready boolean, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  b public.pbx_businesses := public._platform_pbx_business(p_merchant);
begin
  if b.id is null or not public.platform_can('pbx', 'view', p_merchant) then
    raise exception 'NOT_FOUND: set up the merchant''s PBX line first' using errcode = 'P0002';
  end if;
  perform public._platform_require('pbx', 'manage', p_merchant);
  perform public._platform_in_merchant(p_merchant);
  perform public.pbx_set_pbx_bridge_ready(b.id, p_ready);
  perform public._platform_in_merchant(null);
  perform public._platform_log('pbx.bridge_ready', p_merchant, 'pbx_business', b.id::text, p_reason,
    jsonb_build_object('bridge_ready', b.bridge_ready), jsonb_build_object('bridge_ready', p_ready));
  return public._platform_pbx_business_json((select x from public.pbx_businesses x where id = b.id));
end;
$$;

-- A line check: everything the database and the gateway can say about it.
create or replace function public.platform_pbx_check(p_merchant uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  b public.pbx_businesses := public._platform_pbx_business(p_merchant);
  v_trunk jsonb;
  v_checks jsonb := '[]'::jsonb;
  v_limits jsonb;
begin
  if not public.platform_can('pbx', 'view', p_merchant) then
    raise exception 'NOT_FOUND: merchant not found' using errcode = 'P0002';
  end if;
  if b.id is null then
    return jsonb_build_object('ok', false, 'checks', jsonb_build_array(jsonb_build_object('key', 'line', 'ok', false, 'detail', 'No PBX line set up')));
  end if;
  v_trunk := public._platform_pbx_trunk_state(b.code);
  perform public._platform_in_merchant(p_merchant);
  v_limits := public._vd_limits(b.id);
  v_checks := jsonb_build_array(
    jsonb_build_object('key', 'feature', 'ok', coalesce((public.merchant_entitlements(p_merchant) -> 'pbx' ->> 'enabled')::boolean, false),
      'detail', 'PBX for this merchant: ' || coalesce(replace(lower(public.merchant_entitlements(p_merchant) -> 'pbx' ->> 'state'), '_', ' '), 'unknown')),
    jsonb_build_object('key', 'enabled', 'ok', b.pbx_enabled, 'detail', case when b.pbx_enabled then 'Line switched on' else 'Line switched off' end),
    jsonb_build_object('key', 'number', 'ok', b.did is not null and b.trunk_host is not null,
      'detail', coalesce('Number ' || b.did || ' via ' || b.trunk_host || ':' || b.trunk_port || '/' || b.trunk_transport, 'No number or trunk')),
    jsonb_build_object('key', 'secret', 'ok', b.trunk_secret_set, 'detail', case when b.trunk_secret_set then 'Trunk password saved (encrypted)' else 'Trunk password missing' end),
    jsonb_build_object('key', 'gateway', 'ok', (v_trunk ->> 'gateway_online')::boolean,
      'detail', case when v_trunk ->> 'gateway_seen_at' is null then 'The gateway has never checked in'
                     when (v_trunk ->> 'gateway_online')::boolean then 'Gateway checked in within 2 minutes'
                     else 'Gateway last checked in ' || to_char((v_trunk ->> 'gateway_seen_at')::timestamptz at time zone 'Asia/Dhaka', 'DD Mon HH24:MI') end),
    jsonb_build_object('key', 'trunk', 'ok', coalesce(v_trunk ->> 'reported', '') = 'online',
      'detail', case when v_trunk ->> 'reported' is null then 'The gateway does not report this trunk (not loaded yet, or no password)'
                     else 'Gateway reports the trunk as ' || (v_trunk ->> 'reported') end),
    jsonb_build_object('key', 'bridge', 'ok', b.bridge_ready, 'detail', case when b.bridge_ready then 'Marked tested' else 'Not marked tested' end),
    jsonb_build_object('key', 'package', 'ok', coalesce((v_limits ->> 'active')::boolean, false),
      'detail', case when (v_limits ->> 'active')::boolean then format('%s agents, %s channels', v_limits ->> 'agents', v_limits ->> 'channels') else 'No active package' end),
    jsonb_build_object('key', 'balance', 'ok', public._vd_balance(b.id) > 0, 'detail', format('Outgoing balance %s tk', round(public._vd_balance(b.id), 2))));
  perform public._platform_in_merchant(null);
  perform public._platform_log('pbx.checked', p_merchant, 'pbx_business', b.id::text, null, null,
    jsonb_build_object('failed', (select jsonb_agg(c ->> 'key') from jsonb_array_elements(v_checks) c where not (c ->> 'ok')::boolean)));
  return jsonb_build_object('ok', not exists (select 1 from jsonb_array_elements(v_checks) c where not (c ->> 'ok')::boolean), 'checks', v_checks, 'at', now());
end;
$$;

create or replace function public.platform_pbx_grant_package(p_merchant uuid, p jsonb, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  b public.pbx_businesses := public._platform_pbx_business(p_merchant);
  v jsonb;
begin
  if b.id is null or not public.platform_can('pbx', 'view', p_merchant) then
    raise exception 'NOT_FOUND: set up the merchant''s PBX line first' using errcode = 'P0002';
  end if;
  perform public._platform_require('pbx', 'manage', p_merchant);
  if length(trim(coalesce(p_reason, ''))) < 5 then
    raise exception 'VALIDATION: say why the package is given (kept in the audit log)' using errcode = '22023';
  end if;
  perform public._platform_in_merchant(p_merchant);
  v := public.pbx_admin_grant_package(p || jsonb_build_object('business_id', b.id, 'note', trim(p_reason)));
  perform public._platform_in_merchant(null);
  perform public._platform_log('pbx.package_granted', p_merchant, 'pbx_business', b.id::text, trim(p_reason), null, v);
  return v;
end;
$$;

create or replace function public.platform_pbx_adjust_balance(p_merchant uuid, p_amount numeric, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  b public.pbx_businesses := public._platform_pbx_business(p_merchant);
  v jsonb;
begin
  if b.id is null or not public.platform_can('pbx', 'view', p_merchant) then
    raise exception 'NOT_FOUND: set up the merchant''s PBX line first' using errcode = 'P0002';
  end if;
  perform public._platform_require('pbx', 'manage', p_merchant);
  if length(trim(coalesce(p_reason, ''))) < 5 then
    raise exception 'VALIDATION: say why the balance changes (kept in the audit log)' using errcode = '22023';
  end if;
  perform public._platform_in_merchant(p_merchant);
  v := public.pbx_admin_adjust_balance(b.id, p_amount, trim(p_reason));
  perform public._platform_in_merchant(null);
  perform public._platform_log('pbx.balance_adjusted', p_merchant, 'pbx_business', b.id::text, trim(p_reason), null,
    jsonb_build_object('amount_tk', p_amount) || v);
  return v;
end;
$$;

-- Agents (extensions) and call groups for a merchant, through the merchant's own procedures.
create or replace function public.platform_pbx_agent_save(p_merchant uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  b public.pbx_businesses := public._platform_pbx_business(p_merchant);
  v jsonb;
begin
  if b.id is null or not public.platform_can('pbx', 'view', p_merchant) then
    raise exception 'NOT_FOUND: set up the merchant''s PBX line first' using errcode = 'P0002';
  end if;
  perform public._platform_require('pbx', 'manage', p_merchant);
  perform public._platform_in_merchant(p_merchant);
  if coalesce((p ->> 'remove')::boolean, false) then
    perform public.pbx_remove_agent((p ->> 'id')::uuid);
    v := jsonb_build_object('removed', p ->> 'id');
  else
    v := public.pbx_save_agent(p || jsonb_build_object('business_id', b.id));
  end if;
  perform public._platform_in_merchant(null);
  perform public._platform_log(case when v ? 'removed' then 'pbx.agent_removed' else 'pbx.agent_saved' end, p_merchant, 'pbx_agent',
    coalesce(v ->> 'id', p ->> 'id'), null, null, p - 'remove');
  return v;
end;
$$;

create or replace function public.platform_pbx_ring_group_save(p_merchant uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  b public.pbx_businesses := public._platform_pbx_business(p_merchant);
  v jsonb;
begin
  if b.id is null or not public.platform_can('pbx', 'view', p_merchant) then
    raise exception 'NOT_FOUND: set up the merchant''s PBX line first' using errcode = 'P0002';
  end if;
  perform public._platform_require('pbx', 'manage', p_merchant);
  perform public._platform_in_merchant(p_merchant);
  v := public.pbx_save_ring_group(p || jsonb_build_object('business_id', b.id));
  perform public._platform_in_merchant(null);
  perform public._platform_log('pbx.ring_group_saved', p_merchant, 'pbx_ring_group', v ->> 'id', null, null, p);
  return v;
end;
$$;

-- The shared gateway settings (rates, addresses, TURN, maintenance).
create or replace function public.platform_pbx_settings_save(p jsonb, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb := public._vd_cfg();
  v jsonb := public._vd_cfg();
  u text;
  k text;
begin
  perform public._platform_require('pbx', 'manage');
  if p ? 'sip_domain' then
    if nullif(trim(p ->> 'sip_domain'), '') is not null and trim(p ->> 'sip_domain') !~ '^[A-Za-z0-9.-]{3,253}$' then
      raise exception 'VALIDATION: the SIP domain is a host name like pbx.example.com' using errcode = '22023';
    end if;
    v := v || jsonb_build_object('sip_domain', nullif(lower(trim(p ->> 'sip_domain')), ''));
  end if;
  if p ? 'wss_url' then
    -- Browsers need WSS; plain ws:// only for a gateway on this machine (local testing).
    if nullif(trim(p ->> 'wss_url'), '') is not null and trim(p ->> 'wss_url') !~ '^wss://[^\s/]+(/\S*)?$'
       and trim(p ->> 'wss_url') !~ '^ws://(localhost|127\.0\.0\.1)(:[0-9]+)?(/\S*)?$' then
      raise exception 'VALIDATION: the WebSocket address starts with wss://' using errcode = '22023';
    end if;
    v := v || jsonb_build_object('wss_url', nullif(trim(p ->> 'wss_url'), ''));
  end if;
  foreach k in array array['turn_urls', 'stun_urls'] loop
    if p ? k then
      if jsonb_typeof(p -> k) <> 'array' then
        raise exception 'VALIDATION: % is a list of addresses', replace(k, '_', ' ') using errcode = '22023';
      end if;
      for u in select jsonb_array_elements_text(p -> k) loop
        if (k = 'turn_urls' and u !~ '^turns?:[^\s]+$') or (k = 'stun_urls' and u !~ '^stuns?:[^\s]+$') then
          raise exception 'VALIDATION: % addresses start with %', upper(split_part(k, '_', 1)), case when k = 'turn_urls' then 'turn: or turns:' else 'stun:' end using errcode = '22023';
        end if;
      end loop;
      v := v || jsonb_build_object(k, p -> k);
    end if;
  end loop;
  if p ? 'credential_ttl_seconds' then
    if (p ->> 'credential_ttl_seconds')::int not between 120 and 3600 then
      raise exception 'VALIDATION: a softphone password lasts 2–60 minutes' using errcode = '22023';
    end if;
    v := v || jsonb_build_object('credential_ttl_seconds', (p ->> 'credential_ttl_seconds')::int);
  end if;
  if p ? 'rate_tk_per_min' then
    if (p ->> 'rate_tk_per_min')::numeric not between 0.01 and 10 then
      raise exception 'VALIDATION: the rate is 0.01–10 tk a minute' using errcode = '22023';
    end if;
    v := v || jsonb_build_object('rate_tk_per_min', (p ->> 'rate_tk_per_min')::numeric);
  end if;
  if p ? 'vat_percent' then
    if (p ->> 'vat_percent')::numeric not between 0 and 50 then
      raise exception 'VALIDATION: VAT is 0–50%%' using errcode = '22023';
    end if;
    v := v || jsonb_build_object('vat_percent', (p ->> 'vat_percent')::numeric);
  end if;
  foreach k in array array['min_topup_tk', 'max_topup_tk', 'extra_agent_tk', 'extra_channel_tk'] loop
    if p ? k then
      if (p ->> k)::numeric not between 0 and 1000000 then
        raise exception 'VALIDATION: % must be 0 or more', replace(k, '_', ' ') using errcode = '22023';
      end if;
      v := v || jsonb_build_object(k, (p ->> k)::numeric);
    end if;
  end loop;
  if (v ->> 'min_topup_tk')::numeric > (v ->> 'max_topup_tk')::numeric then
    raise exception 'VALIDATION: the smallest top-up cannot be more than the largest' using errcode = '22023';
  end if;
  if p ? 'maintenance' then
    if nullif(p #>> '{maintenance,until}', '') is not null and nullif(p #>> '{maintenance,starts_at}', '') is not null
       and (p #>> '{maintenance,until}')::timestamptz <= (p #>> '{maintenance,starts_at}')::timestamptz then
      raise exception 'VALIDATION: maintenance must end after it starts' using errcode = '22023';
    end if;
    v := v || jsonb_build_object('maintenance', jsonb_build_object(
      'starts_at', nullif(p #>> '{maintenance,starts_at}', '')::timestamptz,
      'until', nullif(p #>> '{maintenance,until}', '')::timestamptz,
      'message', left(nullif(trim(p #>> '{maintenance,message}'), ''), 200)));
  end if;
  update public.platform_settings set value = v, updated_by = auth.uid() where key = 'voicedrive';
  perform public._config_version('platform_setting', 'voicedrive', v, p_reason);
  perform public._platform_log('pbx.settings_changed', null, 'platform_setting', 'voicedrive', p_reason, v_before, v);
  return v;
end;
$$;

-- After the platform-admin edge function saved (or cleared) the trunk password
-- in the platform's Vault: mark the line and record who did it.
create or replace function public.platform_pbx_trunk_secret_saved(p_merchant uuid, p_set boolean, p_hint text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  b public.pbx_businesses := public._platform_pbx_business(p_merchant);
begin
  if b.id is null or not public.platform_can('pbx', 'view', p_merchant) then
    raise exception 'NOT_FOUND: set up the merchant''s PBX line first' using errcode = 'P0002';
  end if;
  perform public._platform_require('pbx', 'manage', p_merchant);
  -- A new or removed password means the line must be checked again.
  update public.pbx_businesses set trunk_secret_set = p_set, bridge_ready = false where id = b.id;
  perform public._platform_log(case when p_set then 'pbx.trunk_secret_saved' else 'pbx.trunk_secret_cleared' end, p_merchant, 'pbx_business', b.id::text,
    null, jsonb_build_object('trunk_secret_set', b.trunk_secret_set), jsonb_build_object('trunk_secret_set', p_set, 'hint', p_hint));
  return public._platform_pbx_business_json((select x from public.pbx_businesses x where id = b.id));
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Other Integrations
-- -----------------------------------------------------------------------------
create or replace function public.platform_integrations_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
  v_sms jsonb := coalesce((select value from public.platform_settings where key = 'sms'), '{}'::jsonb);
  v_bd jsonb := coalesce((select value from public.platform_settings where key = 'bd_courier'), '{}'::jsonb);
begin
  perform public._platform_require('integrations', 'view');
  select coalesce(array_agg(id), '{}') into v_ids from public.merchants where id in (select public._platform_merchant_ids()) and status <> 'CLOSED';
  return jsonb_build_object(
    -- Shopify and WooCommerce stores (merchant-authorised; their credentials stay with them).
    'stores', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'merchant', jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name),
        'platform', c.platform, 'name', c.name, 'domain', c.shop_domain, 'status', c.status, 'last_sync_at', c.last_sync_at, 'last_order_at', c.last_order_at,
        'last_error', c.last_error, 'orders', c.orders_imported,
        'failed_jobs', (select count(*) from public.channel_sync_jobs j where j.channel_id = c.id and j.status = 'FAILED'),
        'overdue_jobs', (select count(*) from public.channel_sync_jobs j where j.channel_id = c.id and j.status = 'PENDING' and j.next_attempt_at < now() - interval '15 minutes'),
        'webhook_errors_24h', (select count(*) from public.system_logs l where l.merchant_id = c.merchant_id and l.category = 'WEBHOOK' and l.level = 'ERROR'
                               and l.last_seen_at > now() - interval '24 hours' and l.source ilike '%' || lower(c.platform) || '%'))
        order by (c.status = 'ERROR') desc, m.number)
      from public.sales_channels c join public.merchants m on m.id = c.merchant_id
      where c.merchant_id = any (v_ids) and c.status <> 'DISCONNECTED'), '[]'::jsonb),
    -- Courier accounts each merchant connected (Pathao, Steadfast, RedX, Carrybee…).
    'couriers', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'merchant', jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name),
        'name', c.name, 'provider', c.provider, 'api_enabled', c.api_enabled, 'api_status', c.api_status, 'is_active', c.is_active,
        'last_event_at', (select max(e.received_at) from public.courier_webhook_events e where e.merchant_id = c.merchant_id and e.courier_id = c.id),
        'failed_events_24h', (select count(*) from public.courier_webhook_events e where e.merchant_id = c.merchant_id and e.courier_id = c.id
                              and e.result in ('FAILED', 'UNMATCHED') and e.received_at > now() - interval '24 hours'),
        'failed_bookings_7d', (select count(*) from public.system_logs l where l.merchant_id = c.merchant_id and l.category = 'COURIER' and l.level = 'ERROR'
                               and l.last_seen_at > now() - interval '7 days'))
        order by m.number, c.name)
      from public.couriers c join public.merchants m on m.id = c.merchant_id
      where c.merchant_id = any (v_ids) and c.api_enabled), '[]'::jsonb),
    -- Payment gateways merchants use for their customers' advances (their own accounts).
    'payments', coalesce((select jsonb_agg(jsonb_build_object('merchant', jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name),
        'providers', (select coalesce(jsonb_agg(g.key order by g.key), '[]'::jsonb) from jsonb_each(s.value -> 'providers') g
                      where (g.value ->> 'enabled')::boolean and g.value ->> 'type' = 'redirect'),
        'events_24h', (select count(*) from public.payment_events e where e.merchant_id = m.id and e.created_at > now() - interval '24 hours'),
        'last_event_at', (select max(created_at) from public.payment_events e where e.merchant_id = m.id),
        'errors_24h', (select count(*) from public.system_logs l where l.merchant_id = m.id and l.category = 'PAYMENT' and l.level = 'ERROR'
                       and l.last_seen_at > now() - interval '24 hours')) order by m.number)
      from public.merchants m join public.settings s on s.merchant_id = m.id and s.key = 'payments'
      where m.id = any (v_ids) and exists (select 1 from jsonb_each(s.value -> 'providers') g where (g.value ->> 'enabled')::boolean and g.value ->> 'type' = 'redirect')), '[]'::jsonb),
    -- Ad platforms (Meta, TikTok, Google).
    'ads', coalesce((select jsonb_agg(x order by x ->> 'merchant_number') from (
        select jsonb_build_object('merchant', jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name), 'merchant_number', lpad(m.number::text, 8, '0'),
          'platform', a.platform, 'name', coalesce(a.display_name, a.external_user), 'status', a.status, 'last_error', a.last_error, 'at', a.connected_at) x
        from public.ad_connections a join public.merchants m on m.id = a.merchant_id where a.merchant_id = any (v_ids)
        union all
        select jsonb_build_object('merchant', jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name), 'merchant_number', lpad(m.number::text, 8, '0'),
          'platform', 'META', 'name', coalesce(a.meta_name, a.name),
          'status', case when a.connection_status = 'ERROR' or a.last_sync_status = 'ERROR' then 'ERROR' else a.connection_status end,
          'last_error', coalesce(a.connection_error, a.last_sync_error), 'at', a.last_sync_at)
        from public.meta_ad_accounts a join public.merchants m on m.id = a.merchant_id where a.merchant_id = any (v_ids) and a.is_active and a.token_hint is not null) y), '[]'::jsonb),
    -- The platform's own services.
    'platform', jsonb_build_object(
      'sms', jsonb_build_object('connected', coalesce((v_sms ->> 'connected')::boolean, false), 'provider', v_sms ->> 'provider',
        'balance', v_sms -> 'balance', 'balance_checked_at', v_sms -> 'balance_checked_at',
        'failed_24h', (select count(*) from public.service_usage where service = 'SMS' and status = 'FAILED' and created_at > now() - interval '24 hours'),
        'sent_24h', (select count(*) from public.service_usage where service = 'SMS' and status = 'SUCCEEDED' and created_at > now() - interval '24 hours'),
        'last_error', (select error from public.service_usage where service = 'SMS' and status = 'FAILED' order by created_at desc limit 1)),
      'bd_courier', jsonb_build_object('connected', coalesce((v_bd ->> 'connected')::boolean, false), 'service', v_bd ->> 'service',
        'last_test_at', v_bd -> 'last_test_at', 'last_test_ok', v_bd -> 'last_test_ok', 'last_error', v_bd -> 'last_error',
        'failed_24h', (select count(*) from public.service_usage where service = 'BD_COURIER' and status = 'FAILED' and created_at > now() - interval '24 hours'),
        'succeeded_24h', (select count(*) from public.service_usage where service = 'BD_COURIER' and status = 'SUCCEEDED' and created_at > now() - interval '24 hours')),
      'billing_gateways', coalesce((select value from public.platform_settings where key = 'billing_gateways'), '{}'::jsonb),
      'pbx', (select jsonb_build_object('last_seen_at', last_seen_at, 'online', last_seen_at > now() - interval '2 minutes', 'version', version)
              from public.pbx_gateway_status),
      'ai', jsonb_build_object('present', false, 'note', 'No AI service is connected in this application yet')),
    'can', jsonb_build_object('edit', public.platform_can('integrations', 'edit'), 'manage', public.platform_can('integrations', 'manage')));
end;
$$;

-- Safe retries: a failed store sync job or a failed courier webhook is tried
-- again by the normal machinery (each one is idempotent).
create or replace function public.platform_integration_retry(p_kind text, p_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_merchant uuid;
  v_out jsonb;
  v_n int;
  v_event uuid;
  v_status text;
begin
  if p_kind = 'store_jobs' then
    select merchant_id into v_merchant from public.sales_channels where id = p_id;
  elsif p_kind = 'courier_events' then
    select merchant_id into v_merchant from public.couriers where id = p_id;
  else
    raise exception 'VALIDATION: nothing to retry for %', p_kind using errcode = '22023';
  end if;
  if v_merchant is null or not public.platform_can('integrations', 'view', v_merchant) then
    raise exception 'NOT_FOUND: integration not found' using errcode = 'P0002';
  end if;
  perform public._platform_require('integrations', 'edit', v_merchant);
  if p_kind = 'store_jobs' then
    -- Same rule as the merchant's own retry: never a second copy of a job already waiting or running.
    update public.channel_sync_jobs j set status = 'PENDING', attempts = 0, next_attempt_at = now(), last_error = null, locked_until = null
    where j.channel_id = p_id and j.status = 'FAILED'
      and not exists (select 1 from public.channel_sync_jobs o where o.id <> j.id and o.channel_id = j.channel_id and o.kind = j.kind
                      and o.ref_id = j.ref_id and o.status in ('PENDING', 'RUNNING'));
    get diagnostics v_n = row_count;
    v_out := jsonb_build_object('requeued', v_n);
  else
    perform public._platform_in_merchant(v_merchant);
    v_out := '{}'::jsonb;
    v_n := 0;
    for v_event in select e.id from public.courier_webhook_events e where e.merchant_id = v_merchant and e.courier_id = p_id
                     and e.result in ('FAILED', 'UNMATCHED') and e.received_at > now() - interval '7 days' order by e.received_at limit 100 loop
      v_n := v_n + 1;
      v_status := coalesce(public._process_courier_webhook(v_event) ->> 'status', 'unknown');
      v_out := v_out || jsonb_build_object(v_status, coalesce((v_out ->> v_status)::int, 0) + 1);
    end loop;
    perform public._platform_in_merchant(null);
    v_out := jsonb_build_object('retried', v_n, 'results', v_out);
  end if;
  perform public._platform_log('integrations.retry', v_merchant, p_kind, p_id::text, p_reason, null, v_out);
  return v_out;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Grants, exemptions, ownership
-- -----------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array['platform_pbx_overview()', 'platform_pbx_merchant(uuid)', 'platform_pbx_setup(uuid,jsonb,text)',
    'platform_pbx_set_enabled(uuid,boolean,text)', 'platform_pbx_bridge_ready(uuid,boolean,text)', 'platform_pbx_check(uuid)',
    'platform_pbx_grant_package(uuid,jsonb,text)', 'platform_pbx_adjust_balance(uuid,numeric,text)', 'platform_pbx_agent_save(uuid,jsonb)',
    'platform_pbx_ring_group_save(uuid,jsonb)', 'platform_pbx_settings_save(jsonb,text)', 'platform_integrations_overview()',
    'platform_pbx_trunk_secret_saved(uuid,boolean,text)',
    'platform_integration_retry(text,uuid,text)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  execute 'revoke execute on function public.platform_voicedrive_config() from public, anon, authenticated';
  execute 'grant execute on function public.platform_voicedrive_config() to service_role';
  foreach f in array array['_platform_in_merchant(uuid)', '_platform_pbx_business(uuid)', '_platform_pbx_trunk_state(integer)',
    '_platform_pbx_business_json(public.pbx_businesses)', '_platform_pbx_click_to_call(uuid)']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;

insert into public.tenancy_exempt_functions (name, reason)
select f, 'PBX Setup and integrations: platform staff act on one named merchant at a time, permission-checked'
from unnest(array['platform_pbx_overview', 'platform_pbx_merchant', 'platform_pbx_setup', 'platform_pbx_set_enabled', 'platform_pbx_bridge_ready',
  'platform_pbx_check', 'platform_pbx_grant_package', 'platform_pbx_adjust_balance', 'platform_pbx_agent_save', 'platform_pbx_ring_group_save',
  'platform_pbx_settings_save', 'platform_integrations_overview', 'platform_integration_retry', '_platform_in_merchant', '_platform_pbx_business',
  'platform_pbx_trunk_secret_saved',
  '_platform_pbx_trunk_state', '_platform_pbx_business_json', '_platform_pbx_click_to_call', 'platform_voicedrive_config']) f
on conflict (name) do nothing;
insert into public.tenancy_exempt_functions (name, reason)
values ('_vd_cfg', 'VoiceDrive settings are the platform''s (platform_settings), shared by every merchant')
on conflict (name) do nothing;

select public._tenancy_own_functions();
