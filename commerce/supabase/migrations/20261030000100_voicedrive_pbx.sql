-- VoiceDrive PBX: browser softphones over a SIP/WebRTC gateway (Asterisk),
-- prepaid outgoing calls, packages paid with bKash, and a Super Admin who
-- provisions each business's IPTSP trunk and DID.
--
-- Trust boundaries
--   * Browsers never see a long-lived SIP password: each softphone start mints
--     a random password, the database keeps only its digest (HA1) for a short
--     TTL, and the gateway reads it through the pbx_gw views.
--   * Trunk passwords live in Vault (integration_secret_store), never in a
--     table a staff member can read.
--   * Billing is metered by the gateway (answer → hang-up on the gateway) and
--     charged here in pbx_gw_call_ended(); the browser's timer is display only.
--   * Every procedure is permission-checked and business-scoped here, not in
--     React.

-- ---------------------------------------------------------------------------
-- Permissions and platform settings
-- ---------------------------------------------------------------------------
insert into public.permissions(code, module, name) values
  ('pbx.call', 'pbx', 'Make and receive calls from the browser phone'),
  ('pbx.manage', 'pbx', 'Manage the business''s phone line: agents, call groups, package, recharge and reports'),
  ('pbx.super_admin', 'pbx', 'Provision businesses on VoiceDrive PBX: numbers, SIP trunks, gateway, balances')
on conflict (code) do nothing;

insert into public.role_permissions(role_id, permission_id)
select r.id, p.id
from (values ('ADMIN', 'pbx.call'), ('ADMIN', 'pbx.manage'), ('MANAGER', 'pbx.call'), ('ORDER_MANAGER', 'pbx.call')) g(role_code, perm)
join public.roles r on r.code = g.role_code
join public.permissions p on p.code = g.perm
on conflict do nothing;

insert into public.settings(key, is_public, description, value) values
  ('voicedrive', false, 'VoiceDrive PBX platform settings (rates, gateway addresses, maintenance). Secrets live in Vault.',
   jsonb_build_object(
     'rate_tk_per_min', 0.40,
     'vat_percent', 15,
     'min_topup_tk', 100,
     'max_topup_tk', 50000,
     'extra_agent_tk', 100,
     'extra_channel_tk', 150,
     'credential_ttl_seconds', 900,
     'sip_domain', null,
     'wss_url', null,
     'stun_urls', jsonb_build_array('stun:stun.l.google.com:19302'),
     'turn_urls', '[]'::jsonb,
     'turn_ttl_seconds', 3600,
     'maintenance', jsonb_build_object('starts_at', null, 'until', null, 'message', null)))
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Packages, businesses, members
-- ---------------------------------------------------------------------------
create table if not exists public.pbx_packages (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z][A-Z0-9_]{1,30}$'),
  name text not null,
  monthly_price_tk numeric(12,2) check (monthly_price_tk is null or monthly_price_tk >= 0),
  agent_limit int check (agent_limit is null or agent_limit > 0),
  concurrent_channels int check (concurrent_channels is null or concurrent_channels > 0),
  is_custom boolean not null default false,
  active boolean not null default true,
  sort int not null default 0,
  check (is_custom or (monthly_price_tk is not null and agent_limit is not null and concurrent_channels is not null))
);

insert into public.pbx_packages(code, name, monthly_price_tk, agent_limit, concurrent_channels, is_custom, sort) values
  ('MICRO', 'Micro', 350, 3, 2, false, 10),
  ('STARTER', 'Starter', 500, 6, 3, false, 20),
  ('GROWTH', 'Growth', 1000, 10, 6, false, 30),
  ('BUSINESS', 'Business', 1500, 20, 10, false, 40),
  ('SCALE', 'Scale', 2100, 40, 15, false, 50),
  ('ENTERPRISE', 'Enterprise', null, null, null, true, 60)
on conflict (code) do nothing;

create sequence if not exists public.pbx_business_code_seq start 1;

create table if not exists public.pbx_businesses (
  id uuid primary key default gen_random_uuid(),
  code int not null unique default nextval('public.pbx_business_code_seq') check (code between 1 and 99999),
  name text not null check (length(trim(name)) between 1 and 120),
  is_primary boolean not null default false,
  did text unique check (did is null or did ~ '^0[0-9]{9,12}$'),
  caller_id text check (caller_id is null or caller_id ~ '^0[0-9]{9,12}$'),
  trunk_host text check (trunk_host is null or trunk_host ~ '^[A-Za-z0-9.-]{1,253}$'),
  trunk_port int not null default 5060 check (trunk_port between 1 and 65535),
  trunk_transport text not null default 'udp' check (trunk_transport in ('udp', 'tcp', 'tls')),
  trunk_user text check (trunk_user is null or length(trunk_user) between 1 and 120),
  trunk_register boolean not null default true,
  trunk_secret_set boolean not null default false,
  dial_format text not null default 'LOCAL' check (dial_format in ('LOCAL', 'E164', 'E164_NO_PLUS')),
  max_call_minutes int not null default 15 check (max_call_minutes between 1 and 120),
  pbx_enabled boolean not null default false,
  bridge_ready boolean not null default false,
  bridge_ready_at timestamptz,
  bridge_ready_by uuid references public.profiles(id),
  provisioned_at timestamptz,
  provisioned_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists pbx_businesses_one_primary on public.pbx_businesses((true)) where is_primary;
drop trigger if exists pbx_businesses_updated_at on public.pbx_businesses;
create trigger pbx_businesses_updated_at before update on public.pbx_businesses
  for each row execute function public.set_updated_at();

insert into public.pbx_businesses(name, is_primary)
select coalesce(nullif(trim(public.get_setting('store') ->> 'name'), ''), 'Own store'), true
where not exists (select 1 from public.pbx_businesses where is_primary);

-- A staff member belongs to one business. Staff without a row belong to the
-- primary business (this store).
create table if not exists public.pbx_members (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  business_id uuid not null references public.pbx_businesses(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.pbx_ring_groups (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.pbx_businesses(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 60),
  strategy text not null default 'RING_ALL' check (strategy in ('RING_ALL', 'LONGEST_IDLE')),
  ring_seconds int not null default 30 check (ring_seconds between 10 and 120),
  is_default boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (business_id, name)
);
create unique index if not exists pbx_ring_groups_one_default on public.pbx_ring_groups(business_id) where is_default;

insert into public.pbx_ring_groups(business_id, name, is_default)
select id, 'Everyone', true from public.pbx_businesses b
where not exists (select 1 from public.pbx_ring_groups g where g.business_id = b.id and g.is_default);

create table if not exists public.pbx_agents (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.pbx_businesses(id) on delete cascade,
  profile_id uuid not null unique references public.profiles(id) on delete cascade,
  extension text not null check (extension ~ '^[1-9][0-9]{1,4}$'),
  sip_username text not null unique check (sip_username ~ '^vd[0-9]+x[0-9]+$'),
  ring_group_id uuid references public.pbx_ring_groups(id) on delete set null,
  inbound_enabled boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (business_id, extension)
);
create index if not exists pbx_agents_business_idx on public.pbx_agents(business_id, active, created_at);

-- One live softphone credential per agent. Only the digest is stored.
create table if not exists public.pbx_sip_credentials (
  agent_id uuid primary key references public.pbx_agents(id) on delete cascade,
  password_digest text not null check (password_digest ~ '^[0-9a-f]{32}$'),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  user_agent text
);

create table if not exists public.pbx_presence (
  agent_id uuid primary key references public.pbx_agents(id) on delete cascade,
  business_id uuid not null references public.pbx_businesses(id) on delete cascade,
  status text not null default 'OFFLINE' check (status in ('AVAILABLE', 'AWAY', 'OFFLINE')),
  registered boolean not null default false,
  registration_state text,
  last_heartbeat_at timestamptz,
  last_registered_at timestamptz,
  last_call_ended_at timestamptz,
  user_agent text
);

-- ---------------------------------------------------------------------------
-- Subscriptions, prepaid balance and ledger, bKash
-- ---------------------------------------------------------------------------
create table if not exists public.pbx_subscriptions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.pbx_businesses(id) on delete cascade,
  package_id uuid not null references public.pbx_packages(id),
  agents int not null check (agents > 0),
  channels int not null check (channels > 0),
  extra_agents int not null default 0 check (extra_agents >= 0),
  extra_channels int not null default 0 check (extra_channels >= 0),
  months int not null default 1 check (months between 1 and 12),
  amount_tk numeric(12,2) not null check (amount_tk >= 0),
  starts_at timestamptz not null,
  expires_at timestamptz not null check (expires_at > starts_at),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'REPLACED', 'CANCELLED')),
  source text not null check (source in ('BKASH', 'ADMIN')),
  bkash_transaction_id uuid,
  note text,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists pbx_subscriptions_business_idx on public.pbx_subscriptions(business_id, status, expires_at desc);

create table if not exists public.pbx_outgoing_balances (
  business_id uuid primary key references public.pbx_businesses(id) on delete cascade,
  balance_tk numeric(14,4) not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.pbx_ledger (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.pbx_businesses(id) on delete cascade,
  kind text not null check (kind in ('TOPUP', 'CALL_CHARGE', 'ADJUSTMENT')),
  amount_tk numeric(14,4) not null check (amount_tk <> 0),
  balance_after_tk numeric(14,4) not null,
  call_id uuid unique,
  bkash_transaction_id uuid unique,
  note text,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists pbx_ledger_business_idx on public.pbx_ledger(business_id, created_at desc);

-- The ledger is history: corrections are new ADJUSTMENT rows, never edits.
create or replace function public.pbx_ledger_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'IMMUTABLE_RECORD: ledger entries cannot be changed; add an adjustment instead' using errcode = '55000';
end;
$$;
drop trigger if exists pbx_ledger_no_update on public.pbx_ledger;
create trigger pbx_ledger_no_update before update or delete on public.pbx_ledger
  for each row execute function public.pbx_ledger_immutable();

create table if not exists public.pbx_bkash_transactions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.pbx_businesses(id) on delete cascade,
  type text not null check (type in ('PACKAGE', 'TOPUP')),
  amount_tk numeric(12,2) not null check (amount_tk > 0),
  reference text not null unique,
  status text not null default 'INITIATED' check (status in ('INITIATED', 'COMPLETED', 'FAILED', 'CANCELLED')),
  payment_id text unique,
  trx_id text unique,
  package_id uuid references public.pbx_packages(id),
  extra_agents int not null default 0 check (extra_agents >= 0),
  extra_channels int not null default 0 check (extra_channels >= 0),
  months int not null default 1 check (months between 1 and 12),
  failure_reason text,
  raw jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check (type <> 'PACKAGE' or package_id is not null)
);
create index if not exists pbx_bkash_business_idx on public.pbx_bkash_transactions(business_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Calls, channel holds, telemetry, gateway heartbeat
-- ---------------------------------------------------------------------------
create table if not exists public.pbx_call_records (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.pbx_businesses(id) on delete cascade,
  agent_id uuid references public.pbx_agents(id) on delete set null,
  direction text not null check (direction in ('INBOUND', 'OUTBOUND')),
  kind text not null check (kind in ('MANUAL', 'APPROVED_ORDER', 'WEB_ORDER', 'CALLBACK', 'INBOUND')),
  order_id uuid references public.orders(id) on delete set null,
  customer_id uuid references public.customers(id) on delete set null,
  callback_of uuid references public.pbx_call_records(id) on delete set null,
  customer_phone text,
  normalized_customer_phone text,
  caller_id text,
  did text,
  agent_extension text,
  status text not null check (status in ('REQUESTED', 'RINGING', 'ANSWERED', 'COMPLETED', 'NO_ANSWER', 'BUSY', 'FAILED', 'CANCELLED', 'REJECTED')),
  outcome text check (outcome is null or outcome in ('CONFIRMED', 'CALL_BACK', 'NOT_REACHABLE', 'WRONG_NUMBER', 'CANCEL_REQUEST', 'RESOLVED', 'OTHER')),
  outcome_note text check (outcome_note is null or length(outcome_note) <= 500),
  reject_reason text,
  hangup_cause text,
  gateway_call_id text unique,
  offered_agents uuid[] not null default '{}',
  max_seconds int check (max_seconds is null or max_seconds > 0),
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  billed_seconds int check (billed_seconds is null or billed_seconds >= 0),
  rate_tk_per_min numeric(10,4),
  cost_tk numeric(14,4),
  vat_tk numeric(14,4),
  charged_tk numeric(14,4),
  recording_url text,
  created_by uuid,
  updated_at timestamptz not null default now()
);
create index if not exists pbx_calls_business_idx on public.pbx_call_records(business_id, requested_at desc);
create index if not exists pbx_calls_agent_idx on public.pbx_call_records(agent_id, requested_at desc);
create index if not exists pbx_calls_phone_idx on public.pbx_call_records(business_id, normalized_customer_phone, requested_at desc);
create index if not exists pbx_calls_order_idx on public.pbx_call_records(order_id, requested_at desc) where order_id is not null;
create index if not exists pbx_calls_live_idx on public.pbx_call_records(business_id, status) where status in ('REQUESTED', 'RINGING', 'ANSWERED');
drop trigger if exists pbx_call_records_updated_at on public.pbx_call_records;
create trigger pbx_call_records_updated_at before update on public.pbx_call_records
  for each row execute function public.set_updated_at();

-- A live call holds one channel (and, for outgoing calls, the most it can cost)
-- until the gateway reports the end.
create table if not exists public.pbx_channel_holds (
  call_id uuid primary key references public.pbx_call_records(id) on delete cascade,
  business_id uuid not null references public.pbx_businesses(id) on delete cascade,
  hold_tk numeric(14,4) not null default 0 check (hold_tk >= 0),
  created_at timestamptz not null default now()
);
create index if not exists pbx_channel_holds_business_idx on public.pbx_channel_holds(business_id);

create table if not exists public.pbx_call_telemetry (
  id bigint generated always as identity primary key,
  business_id uuid not null references public.pbx_businesses(id) on delete cascade,
  agent_id uuid references public.pbx_agents(id) on delete set null,
  call_id uuid references public.pbx_call_records(id) on delete cascade,
  kind text not null check (kind in ('TRACE', 'QUALITY')),
  event text not null check (length(event) between 1 and 60),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists pbx_call_telemetry_call_idx on public.pbx_call_telemetry(call_id, created_at);
create index if not exists pbx_call_telemetry_created_idx on public.pbx_call_telemetry(created_at);

create table if not exists public.pbx_gateway_status (
  id boolean primary key default true check (id),
  last_seen_at timestamptz,
  version text,
  detail jsonb not null default '{}'::jsonb
);
insert into public.pbx_gateway_status(id) values (true) on conflict do nothing;

-- Every table is read through the functions below.
alter table public.pbx_packages enable row level security;
alter table public.pbx_businesses enable row level security;
alter table public.pbx_members enable row level security;
alter table public.pbx_ring_groups enable row level security;
alter table public.pbx_agents enable row level security;
alter table public.pbx_sip_credentials enable row level security;
alter table public.pbx_presence enable row level security;
alter table public.pbx_subscriptions enable row level security;
alter table public.pbx_outgoing_balances enable row level security;
alter table public.pbx_ledger enable row level security;
alter table public.pbx_bkash_transactions enable row level security;
alter table public.pbx_call_records enable row level security;
alter table public.pbx_channel_holds enable row level security;
alter table public.pbx_call_telemetry enable row level security;
alter table public.pbx_gateway_status enable row level security;
revoke all on public.pbx_packages, public.pbx_businesses, public.pbx_members, public.pbx_ring_groups, public.pbx_agents,
  public.pbx_sip_credentials, public.pbx_presence, public.pbx_subscriptions, public.pbx_outgoing_balances, public.pbx_ledger,
  public.pbx_bkash_transactions, public.pbx_call_records, public.pbx_channel_holds, public.pbx_call_telemetry,
  public.pbx_gateway_status from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public._vd_cfg()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.get_setting('voicedrive')
$$;

create or replace function public._vd_num(p_key text, p_default numeric)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(nullif(public._vd_cfg() ->> p_key, '')::numeric, p_default)
$$;

create or replace function public._vd_is_super()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_system_context() or public.has_permission('pbx.super_admin')
$$;

-- The caller's business: their membership, else the primary business.
create or replace function public._vd_my_business()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select business_id from public.pbx_members where profile_id = auth.uid()),
    (select id from public.pbx_businesses where is_primary))
$$;

-- Resolves the business a request is about. Only a Super Admin may act on
-- another business.
create or replace function public._vd_business(p_business_id uuid default null)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_mine uuid := public._vd_my_business();
begin
  if p_business_id is null or p_business_id = v_mine then
    if v_mine is null then
      raise exception 'NOT_FOUND: no business is set up for VoiceDrive PBX' using errcode = 'P0002';
    end if;
    return v_mine;
  end if;
  if not public._vd_is_super() then
    raise exception 'PERMISSION_DENIED: you can only manage your own business' using errcode = '42501';
  end if;
  if not exists (select 1 from public.pbx_businesses where id = p_business_id) then
    raise exception 'NOT_FOUND: business not found' using errcode = 'P0002';
  end if;
  return p_business_id;
end;
$$;

create or replace function public._vd_maintenance()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'state', case
      when s is null then 'none'
      when u is not null and u <= now() then 'none'
      when s <= now() then 'active'
      else 'scheduled' end,
    'startsAt', s, 'until', u, 'message', m)
  from (select nullif(public._vd_cfg() #>> '{maintenance,starts_at}', '')::timestamptz s,
               nullif(public._vd_cfg() #>> '{maintenance,until}', '')::timestamptz u,
               nullif(public._vd_cfg() #>> '{maintenance,message}', '') m) x
$$;

-- The business's current package and limits (nothing active → zeros).
create or replace function public._vd_limits(p_business_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select jsonb_build_object('active', true, 'subscriptionId', s.id, 'packageCode', p.code, 'packageName', p.name,
      'agents', s.agents, 'channels', s.channels, 'extraAgents', s.extra_agents, 'extraChannels', s.extra_channels,
      'startsAt', s.starts_at, 'expiresAt', s.expires_at)
    from public.pbx_subscriptions s join public.pbx_packages p on p.id = s.package_id
    where s.business_id = p_business_id and s.status = 'ACTIVE' and s.starts_at <= now() and s.expires_at > now()
    order by s.starts_at desc limit 1),
    jsonb_build_object('active', false, 'agents', 0, 'channels', 0, 'packageCode', null, 'packageName', null, 'expiresAt',
      (select max(expires_at) from public.pbx_subscriptions where business_id = p_business_id and status = 'ACTIVE')))
$$;

-- Why a business's line can't carry calls right now (empty = it can).
create or replace function public._vd_line_problems(p_business_id uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  b public.pbx_businesses;
  v text[] := '{}';
begin
  select * into b from public.pbx_businesses where id = p_business_id;
  if b.id is null then return array['NOT_FOUND']; end if;
  if not b.pbx_enabled then v := array_append(v, 'NOT_ENABLED'); end if;
  if b.did is null or b.trunk_host is null then v := array_append(v, 'NO_NUMBER'); end if;
  if not b.bridge_ready then v := array_append(v, 'BRIDGE_NOT_READY'); end if;
  if not (public._vd_limits(b.id) ->> 'active')::boolean then v := array_append(v, 'NO_PACKAGE'); end if;
  if public._vd_maintenance() ->> 'state' = 'active' then v := array_append(v, 'MAINTENANCE'); end if;
  return v;
end;
$$;

-- Agents within the paid seats: the oldest active agents first.
create or replace function public._vd_seated(p_agent_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select x.rn <= (public._vd_limits(x.business_id) ->> 'agents')::int
    from (select a.id, a.business_id, row_number() over (partition by a.business_id order by a.created_at, a.id) rn
          from public.pbx_agents a
          where a.active and a.business_id = (select business_id from public.pbx_agents where id = p_agent_id)) x
    where x.id = p_agent_id), false)
$$;

create or replace function public._vd_my_agent()
returns public.pbx_agents
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select * from public.pbx_agents where profile_id = auth.uid()
$$;

-- What a minute of outgoing call costs, VAT included.
create or replace function public._vd_rate_with_vat()
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public._vd_num('rate_tk_per_min', 0.40) * (1 + public._vd_num('vat_percent', 15) / 100)
$$;

create or replace function public._vd_balance(p_business_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select balance_tk from public.pbx_outgoing_balances where business_id = p_business_id), 0)
$$;

-- Adds a ledger row and moves the balance in the same transaction.
create or replace function public._vd_ledger_add(
  p_business_id uuid, p_kind text, p_amount numeric, p_call_id uuid default null, p_bkash uuid default null, p_note text default null)
returns public.pbx_ledger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_balance numeric;
  v_row public.pbx_ledger;
begin
  insert into public.pbx_outgoing_balances(business_id, balance_tk) values (p_business_id, 0) on conflict do nothing;
  update public.pbx_outgoing_balances set balance_tk = balance_tk + p_amount, updated_at = now()
  where business_id = p_business_id returning balance_tk into v_balance;
  insert into public.pbx_ledger(business_id, kind, amount_tk, balance_after_tk, call_id, bkash_transaction_id, note, created_by)
  values (p_business_id, p_kind, p_amount, v_balance, p_call_id, p_bkash, p_note, auth.uid())
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public._vd_call_json(c public.pbx_call_records)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', c.id, 'createdAt', c.requested_at, 'status', c.status, 'outcome', c.outcome, 'outcomeNote', c.outcome_note,
    'direction', c.direction, 'kind', c.kind, 'orderId', c.order_id,
    'orderNumber', (select order_number from public.orders where id = c.order_id),
    'customerPhone', c.customer_phone, 'normalizedCustomerPhone', c.normalized_customer_phone,
    'callerId', c.caller_id, 'did', c.did, 'agentExtension', c.agent_extension,
    'agentName', (select p.full_name from public.pbx_agents a join public.profiles p on p.id = a.profile_id where a.id = c.agent_id),
    'startedAt', c.started_at, 'answeredAt', c.answered_at, 'endedAt', c.ended_at,
    'billedSeconds', c.billed_seconds, 'costTk', c.cost_tk, 'vatTk', c.vat_tk, 'chargedTk', c.charged_tk,
    'maxSeconds', c.max_seconds, 'rejectReason', c.reject_reason, 'hangupCause', c.hangup_cause,
    'callbackOf', c.callback_of, 'recordingUrl', c.recording_url,
    'calledBack', exists (select 1 from public.pbx_call_records x where x.callback_of = c.id))
$$;

-- ---------------------------------------------------------------------------
-- Overview, packages, maintenance, eligibility
-- ---------------------------------------------------------------------------
create or replace function public.pbx_maintenance_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_staff() and not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return public._vd_maintenance();
end;
$$;

create or replace function public.pbx_packages_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_staff() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'packages', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'code', code, 'name', name, 'monthlyPriceTk', monthly_price_tk,
        'agentLimit', agent_limit, 'concurrentChannels', concurrent_channels, 'isCustom', is_custom) order by sort)
      from public.pbx_packages where active), '[]'::jsonb),
    'extraAgentTk', public._vd_num('extra_agent_tk', 100),
    'extraChannelTk', public._vd_num('extra_channel_tk', 150),
    'ratePerMinTk', public._vd_num('rate_tk_per_min', 0.40),
    'vatPercent', public._vd_num('vat_percent', 15),
    'effectivePerMinTk', round(public._vd_rate_with_vat(), 4),
    'minTopupTk', public._vd_num('min_topup_tk', 100),
    'maxTopupTk', public._vd_num('max_topup_tk', 50000));
end;
$$;

create or replace function public.pbx_overview(p_business_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  b public.pbx_businesses;
  v_problems text[];
  v_agent public.pbx_agents;
begin
  if not (public.has_permission('pbx.call') or public.has_permission('pbx.manage') or public._vd_is_super()) then
    raise exception 'PERMISSION_DENIED: pbx.call is required' using errcode = '42501';
  end if;
  v_id := public._vd_business(p_business_id);
  select * into b from public.pbx_businesses where id = v_id;
  v_problems := public._vd_line_problems(v_id);
  v_agent := public._vd_my_agent();
  return jsonb_build_object(
    'business', jsonb_build_object('id', b.id, 'code', b.code, 'name', b.name, 'did', b.did, 'callerId', b.caller_id,
      'pbxEnabled', b.pbx_enabled, 'bridgeReady', b.bridge_ready, 'maxCallMinutes', b.max_call_minutes, 'isPrimary', b.is_primary),
    'lineStatus', case when cardinality(v_problems) = 0 then 'ACTIVE' else 'INACTIVE' end,
    'lineProblems', to_jsonb(v_problems),
    'limits', public._vd_limits(v_id),
    'balanceTk', round(public._vd_balance(v_id), 2),
    'agentsUsed', (select count(*) from public.pbx_agents where business_id = v_id and active),
    'channelsInUse', (select count(*) from public.pbx_channel_holds where business_id = v_id),
    'maintenance', public._vd_maintenance(),
    'me', case when v_agent.id is null then null else jsonb_build_object('agentId', v_agent.id, 'extension', v_agent.extension,
      'sipUsername', v_agent.sip_username, 'active', v_agent.active, 'seated', public._vd_seated(v_agent.id)) end,
    'canManage', public.has_permission('pbx.manage') or public._vd_is_super(),
    'isSuperAdmin', public._vd_is_super(),
    'gateway', (select jsonb_build_object('lastSeenAt', last_seen_at, 'version', version,
      'online', last_seen_at > now() - interval '2 minutes') from public.pbx_gateway_status));
end;
$$;

create or replace function public.pbx_get_inbound_phone_eligibility()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  a public.pbx_agents;
  v_reasons text[] := '{}';
begin
  perform public.require_permission('pbx.call');
  a := public._vd_my_agent();
  if a.id is null then
    return jsonb_build_object('eligible', false, 'reasons', jsonb_build_array('NO_EXTENSION'));
  end if;
  v_reasons := public._vd_line_problems(a.business_id);
  if not a.active then v_reasons := array_append(v_reasons, 'AGENT_DISABLED'); end if;
  if not a.inbound_enabled then v_reasons := array_append(v_reasons, 'INBOUND_OFF'); end if;
  if not public._vd_seated(a.id) then v_reasons := array_append(v_reasons, 'NO_SEAT'); end if;
  return jsonb_build_object('eligible', cardinality(v_reasons) = 0, 'reasons', to_jsonb(v_reasons),
    'extension', a.extension, 'ringGroupId', a.ring_group_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Softphone credentials and presence
-- ---------------------------------------------------------------------------
-- Called by the voicedrive edge function with the user's session: stores the
-- digest of a freshly generated password and returns what the browser needs.
create or replace function public.pbx_issue_my_credential(p_password text, p_user_agent text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a public.pbx_agents;
  v_problems text[];
  v_ttl int := greatest(least(public._vd_num('credential_ttl_seconds', 900)::int, 3600), 120);
  v_exp timestamptz := now() + make_interval(secs => v_ttl);
  v_domain text := nullif(public._vd_cfg() ->> 'sip_domain', '');
begin
  perform public.require_permission('pbx.call');
  if p_password is null or length(p_password) < 24 then
    raise exception 'VALIDATION: password too short' using errcode = '22023';
  end if;
  a := public._vd_my_agent();
  if a.id is null then
    raise exception 'VALIDATION: you have no phone extension yet — ask your admin to add you under Call Agents' using errcode = '22023';
  end if;
  if not a.active then
    raise exception 'VALIDATION: your phone extension is switched off' using errcode = '22023';
  end if;
  v_problems := public._vd_line_problems(a.business_id);
  if cardinality(v_problems) > 0 then
    raise exception 'VALIDATION: the phone line is not active (%)', array_to_string(v_problems, ', ') using errcode = '22023';
  end if;
  if not public._vd_seated(a.id) then
    raise exception 'VALIDATION: all paid agent seats are in use — add a seat or switch off another agent' using errcode = '22023';
  end if;
  if v_domain is null then
    raise exception 'VALIDATION: the gateway address is not set yet (Super Admin → Gateway)' using errcode = '22023';
  end if;
  insert into public.pbx_sip_credentials(agent_id, password_digest, issued_at, expires_at, user_agent)
  values (a.id, md5(a.sip_username || ':voicedrive:' || p_password), now(), v_exp, left(p_user_agent, 300))
  on conflict (agent_id) do update set password_digest = excluded.password_digest, issued_at = now(),
    expires_at = excluded.expires_at, user_agent = excluded.user_agent;
  return jsonb_build_object('sipUsername', a.sip_username, 'extension', a.extension, 'businessId', a.business_id,
    'sipUri', 'sip:' || a.sip_username || '@' || v_domain, 'sipDomain', v_domain, 'expiresAt', v_exp, 'ttlSeconds', v_ttl,
    'agentId', a.id);
end;
$$;

create or replace function public.pbx_get_my_browser_phone_registration()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  a public.pbx_agents;
  p public.pbx_presence;
  c public.pbx_sip_credentials;
begin
  perform public.require_permission('pbx.call');
  a := public._vd_my_agent();
  if a.id is null then
    return jsonb_build_object('hasExtension', false, 'registered', false);
  end if;
  select * into p from public.pbx_presence where agent_id = a.id;
  select * into c from public.pbx_sip_credentials where agent_id = a.id;
  return jsonb_build_object('hasExtension', true, 'extension', a.extension, 'sipUsername', a.sip_username,
    'registered', coalesce(p.registered and p.last_heartbeat_at > now() - interval '45 seconds', false),
    'registrationState', p.registration_state, 'status', coalesce(p.status, 'OFFLINE'),
    'lastHeartbeatAt', p.last_heartbeat_at, 'lastRegisteredAt', p.last_registered_at,
    'credentialExpiresAt', c.expires_at);
end;
$$;

create or replace function public.pbx_set_inbound_phone_presence(
  p_status text default 'AVAILABLE', p_registered boolean default true, p_registration_state text default null, p_user_agent text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a public.pbx_agents;
begin
  perform public.require_permission('pbx.call');
  if p_status not in ('AVAILABLE', 'AWAY') then
    raise exception 'VALIDATION: status must be AVAILABLE or AWAY' using errcode = '22023';
  end if;
  a := public._vd_my_agent();
  if a.id is null then
    raise exception 'VALIDATION: you have no phone extension' using errcode = '22023';
  end if;
  insert into public.pbx_presence(agent_id, business_id, status, registered, registration_state, last_heartbeat_at, last_registered_at, user_agent)
  values (a.id, a.business_id, p_status, coalesce(p_registered, false), left(p_registration_state, 40), now(),
          case when p_registered then now() end, left(p_user_agent, 300))
  on conflict (agent_id) do update set status = excluded.status, registered = excluded.registered,
    registration_state = excluded.registration_state, last_heartbeat_at = now(), business_id = excluded.business_id,
    last_registered_at = case when excluded.registered then now() else pbx_presence.last_registered_at end,
    user_agent = coalesce(excluded.user_agent, pbx_presence.user_agent);
  return public.pbx_get_inbound_phone_eligibility() || jsonb_build_object('status', p_status, 'registered', p_registered);
end;
$$;

create or replace function public.pbx_clear_inbound_phone_presence()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a public.pbx_agents;
begin
  perform public.require_permission('pbx.call');
  a := public._vd_my_agent();
  if a.id is null then return; end if;
  update public.pbx_presence set status = 'OFFLINE', registered = false, registration_state = 'unregistered', last_heartbeat_at = now()
  where agent_id = a.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Outgoing call requests (the gateway re-checks everything at dial time)
-- ---------------------------------------------------------------------------
create or replace function public._vd_start_outbound(p_phone text, p_kind text, p_order_id uuid, p_callback_of uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a public.pbx_agents;
  b public.pbx_businesses;
  v_problems text[];
  v_phone text := public.normalize_phone(p_phone);
  v_row public.pbx_call_records;
  v_cust uuid;
  v_balance numeric;
begin
  perform public.require_permission('pbx.call');
  a := public._vd_my_agent();
  if a.id is null or not a.active then
    raise exception 'VALIDATION: you have no active phone extension' using errcode = '22023';
  end if;
  if v_phone is null or v_phone !~ '^0[0-9]{9,12}$' then
    raise exception 'VALIDATION: enter a Bangladeshi phone number like 01XXXXXXXXX' using errcode = '22023';
  end if;
  select * into b from public.pbx_businesses where id = a.business_id;
  v_problems := public._vd_line_problems(b.id);
  if cardinality(v_problems) > 0 then
    raise exception 'VALIDATION: the phone line is not active (%)', array_to_string(v_problems, ', ') using errcode = '22023';
  end if;
  if not public._vd_seated(a.id) then
    raise exception 'VALIDATION: all paid agent seats are in use' using errcode = '22023';
  end if;
  v_balance := public._vd_balance(b.id);
  if v_balance <= 0 then
    raise exception 'VALIDATION: outgoing balance is empty — recharge with bKash' using errcode = '22023';
  end if;
  if (select count(*) from public.pbx_channel_holds where business_id = b.id) >= (public._vd_limits(b.id) ->> 'channels')::int then
    raise exception 'VALIDATION: all % call channels are busy — try again in a moment', (public._vd_limits(b.id) ->> 'channels') using errcode = '22023';
  end if;
  -- One open request per agent: an older one that never dialled is cancelled.
  update public.pbx_call_records set status = 'CANCELLED', reject_reason = 'REPLACED', ended_at = now()
  where agent_id = a.id and status = 'REQUESTED';
  select id into v_cust from public.customers where phone = v_phone limit 1;
  insert into public.pbx_call_records(business_id, agent_id, direction, kind, order_id, customer_id, callback_of,
    customer_phone, normalized_customer_phone, caller_id, did, agent_extension, status, created_by)
  values (b.id, a.id, 'OUTBOUND', p_kind, p_order_id, v_cust, p_callback_of, left(p_phone, 40), v_phone,
    coalesce(b.caller_id, b.did), b.did, a.extension, 'REQUESTED', auth.uid())
  returning * into v_row;
  return public._vd_call_json(v_row) || jsonb_build_object('dial', v_phone, 'expiresInSeconds', 120);
end;
$$;

create or replace function public.pbx_start_manual_call(p_phone text, p_callback_of uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_missed public.pbx_call_records;
begin
  if p_callback_of is not null then
    select * into v_missed from public.pbx_call_records where id = p_callback_of and business_id = public._vd_my_business();
    if v_missed.id is null then
      raise exception 'NOT_FOUND: missed call not found' using errcode = 'P0002';
    end if;
    return public._vd_start_outbound(coalesce(nullif(p_phone, ''), v_missed.customer_phone), 'CALLBACK', null, v_missed.id);
  end if;
  return public._vd_start_outbound(p_phone, 'MANUAL', null, null);
end;
$$;

create or replace function public._vd_start_order_call(p_order_id uuid, p_kind text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o record;
begin
  perform public.require_permission('orders.view');
  select id, customer_phone, merged_into into o from public.orders where id = p_order_id;
  if o.id is null then
    raise exception 'NOT_FOUND: order not found' using errcode = 'P0002';
  end if;
  if coalesce(o.customer_phone, '') = '' then
    raise exception 'VALIDATION: this order has no phone number' using errcode = '22023';
  end if;
  return public._vd_start_outbound(o.customer_phone, p_kind, o.id, null);
end;
$$;

create or replace function public.pbx_start_approved_order_call(p_order_id uuid)
returns jsonb language sql security definer set search_path = public, pg_temp
as $$ select public._vd_start_order_call(p_order_id, 'APPROVED_ORDER') $$;

create or replace function public.pbx_start_web_order_call(p_order_id uuid)
returns jsonb language sql security definer set search_path = public, pg_temp
as $$ select public._vd_start_order_call(p_order_id, 'WEB_ORDER') $$;

-- The agent's own call, for state, end and cancel.
create or replace function public._vd_my_call(p_call_id uuid)
returns public.pbx_call_records
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  c public.pbx_call_records;
begin
  select * into c from public.pbx_call_records where id = p_call_id;
  if c.id is null or not (c.agent_id = (public._vd_my_agent()).id
      or (c.business_id = public._vd_my_business() and public.has_permission('pbx.manage'))) then
    raise exception 'NOT_FOUND: call not found' using errcode = 'P0002';
  end if;
  return c;
end;
$$;

create or replace function public.pbx_get_call_state(p_call_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('pbx.call');
  return public._vd_call_json(public._vd_my_call(p_call_id));
end;
$$;

create or replace function public.pbx_get_my_outgoing_call_request_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  c public.pbx_call_records;
begin
  perform public.require_permission('pbx.call');
  select * into c from public.pbx_call_records
  where agent_id = (public._vd_my_agent()).id and direction = 'OUTBOUND'
  order by requested_at desc limit 1;
  return case when c.id is null then null else public._vd_call_json(c) end;
end;
$$;

-- Cancel a request that has not connected. Hanging up a live call is a SIP BYE
-- from the browser; the gateway reports how it ended.
create or replace function public.pbx_cancel_call(p_call_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c public.pbx_call_records;
begin
  perform public.require_permission('pbx.call');
  c := public._vd_my_call(p_call_id);
  if c.status = 'REQUESTED' then
    update public.pbx_call_records set status = 'CANCELLED', reject_reason = 'CANCELLED_BY_AGENT', ended_at = now()
    where id = c.id returning * into c;
  end if;
  return public._vd_call_json(c);
end;
$$;

-- What happened on the call, from the agent (does not touch billing).
create or replace function public.pbx_end_call(p_call_id uuid, p_outcome text default null, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c public.pbx_call_records;
begin
  perform public.require_permission('pbx.call');
  if p_outcome is not null and p_outcome not in ('CONFIRMED', 'CALL_BACK', 'NOT_REACHABLE', 'WRONG_NUMBER', 'CANCEL_REQUEST', 'RESOLVED', 'OTHER') then
    raise exception 'VALIDATION: unknown call outcome' using errcode = '22023';
  end if;
  c := public._vd_my_call(p_call_id);
  if c.status = 'REQUESTED' then
    update public.pbx_call_records set status = 'CANCELLED', reject_reason = 'CANCELLED_BY_AGENT', ended_at = now() where id = c.id;
  end if;
  update public.pbx_call_records set outcome = coalesce(p_outcome, outcome), outcome_note = coalesce(left(nullif(trim(p_note), ''), 500), outcome_note)
  where id = c.id returning * into c;
  return public._vd_call_json(c);
end;
$$;

-- ---------------------------------------------------------------------------
-- Incoming calls and screen-pop
-- ---------------------------------------------------------------------------
create or replace function public.pbx_get_my_active_inbound_call()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  a public.pbx_agents;
  c public.pbx_call_records;
begin
  perform public.require_permission('pbx.call');
  a := public._vd_my_agent();
  if a.id is null then return null; end if;
  select * into c from public.pbx_call_records
  where business_id = a.business_id and direction = 'INBOUND'
    and ((status = 'RINGING' and a.id = any(offered_agents)) or (status = 'ANSWERED' and agent_id = a.id))
    and requested_at > now() - interval '3 hours'
  order by requested_at desc limit 1;
  return case when c.id is null then null else public._vd_call_json(c) end;
end;
$$;

create or replace function public.pbx_resolve_inbound_caller_context(p_phone text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_phone text := public.normalize_phone(p_phone);
  cu public.customers;
begin
  perform public.require_permission('pbx.call');
  perform public.require_permission('orders.view');
  if v_phone is null then
    return jsonb_build_object('phone', p_phone, 'known', false);
  end if;
  select * into cu from public.customers where phone = v_phone limit 1;
  return jsonb_build_object('phone', v_phone, 'known', cu.id is not null or exists (select 1 from public.orders where customer_phone = v_phone),
    'customer', case when cu.id is null then null else jsonb_build_object('id', cu.id, 'name', cu.full_name, 'district', cu.district,
      'totalOrders', cu.total_orders, 'deliveredOrders', cu.delivered_orders, 'cancelledOrders', cu.cancelled_orders,
      'returnedOrders', cu.returned_orders, 'totalSpent', cu.total_spent, 'lastOrderAt', cu.last_order_at, 'notes', cu.notes) end,
    'name', coalesce(cu.full_name, (select customer_name from public.orders where customer_phone = v_phone order by created_at desc limit 1)),
    'orders', coalesce((select jsonb_agg(x order by x ->> 'createdAt' desc) from (
        select jsonb_build_object('id', o.id, 'orderNumber', o.order_number, 'status', o.status, 'totalAmount', o.total_amount,
          'paymentStatus', o.payment_status, 'createdAt', o.created_at) x
        from public.orders o where o.customer_phone = v_phone and o.merged_into is null
        order by o.created_at desc limit 8) s), '[]'::jsonb),
    'previousCalls', (select count(*) from public.pbx_call_records where business_id = public._vd_my_business() and normalized_customer_phone = v_phone));
end;
$$;

create or replace function public.pbx_get_inbound_caller_order_detail(p_phone text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_phone text := public.normalize_phone(p_phone);
  o public.orders;
  s record;
begin
  perform public.require_permission('pbx.call');
  perform public.require_permission('orders.view');
  select * into o from public.orders where customer_phone = v_phone and merged_into is null order by created_at desc limit 1;
  if o.id is null then return null; end if;
  select sh.tracking_number, sh.consignment_id, sh.status, c.name courier, c.provider, c.tracking_url_template
    into s
  from public.shipments sh join public.couriers c on c.id = sh.courier_id
  where sh.order_id = o.id and sh.is_active order by sh.created_at desc limit 1;
  return jsonb_build_object('id', o.id, 'orderNumber', o.order_number, 'status', o.status, 'paymentMethod', o.payment_method,
    'paymentStatus', o.payment_status, 'totalAmount', o.total_amount, 'amountPaid', o.amount_paid, 'codAmount', o.cod_amount,
    'customerName', o.customer_name, 'shippingAddress', o.shipping_address, 'shippingDistrict', o.shipping_district,
    'createdAt', o.created_at, 'confirmedAt', o.confirmed_at, 'shippedAt', o.shipped_at, 'deliveredAt', o.delivered_at,
    'customerNote', o.customer_note,
    'items', coalesce((select jsonb_agg(jsonb_build_object('name', i.product_name, 'variant', i.variant_title, 'quantity', i.quantity,
        'lineTotal', i.line_total, 'imageUrl', i.image_url) order by i.created_at) from public.order_items i where i.order_id = o.id), '[]'::jsonb),
    'shipment', case when s.courier is null then null else jsonb_build_object('courier', s.courier, 'status', s.status,
      'trackingNumber', coalesce(s.tracking_number, s.consignment_id),
      'trackingUrl', public._tracking_url(s.provider, s.tracking_url_template, coalesce(s.tracking_number, s.consignment_id))) end);
end;
$$;

-- Staff-only courier record for the caller (never read to the customer).
create or replace function public.pbx_resolve_inbound_caller_courier_rating(p_phone text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_phone text := public.normalize_phone(p_phone);
  f public.fraud_checks;
begin
  perform public.require_permission('pbx.call');
  perform public.require_permission('orders.view');
  select * into f from public.fraud_checks where phone = v_phone and status <> 'ERROR' order by created_at desc limit 1;
  if f.id is null then return jsonb_build_object('phone', v_phone, 'checked', false); end if;
  return jsonb_build_object('phone', v_phone, 'checked', true, 'checkedAt', f.created_at,
    'successRate', coalesce((f.metrics ->> 'receive_rate')::numeric, f.courier_score),
    'riskLevel', f.risk_level, 'totalParcels', f.previous_orders, 'delivered', f.delivered_orders,
    'cancelled', f.cancelled_orders, 'returned', f.returned_orders);
end;
$$;

create or replace function public.pbx_get_recent_missed_inbound_calls(p_limit int default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('pbx.call');
  return jsonb_build_object('items', coalesce((select jsonb_agg(public._vd_call_json(c) order by c.requested_at desc)
    from (select * from public.pbx_call_records
          where business_id = public._vd_my_business() and direction = 'INBOUND' and status in ('NO_ANSWER', 'REJECTED', 'BUSY', 'FAILED')
          order by requested_at desc limit greatest(1, least(coalesce(p_limit, 50), 200))) c), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- Telemetry from the browser (bounded; never trusted for billing)
-- ---------------------------------------------------------------------------
create or replace function public._vd_telemetry(p_kind text, p_call_id uuid, p_event text, p_detail jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a public.pbx_agents;
begin
  perform public.require_permission('pbx.call');
  a := public._vd_my_agent();
  if a.id is null then return; end if;
  if p_call_id is not null and not exists (select 1 from public.pbx_call_records where id = p_call_id and business_id = a.business_id) then
    p_call_id := null;
  end if;
  if (select count(*) from public.pbx_call_telemetry where agent_id = a.id and created_at > now() - interval '1 minute') >= 120 then
    return;
  end if;
  insert into public.pbx_call_telemetry(business_id, agent_id, call_id, kind, event, detail)
  values (a.business_id, a.id, p_call_id, p_kind, left(coalesce(nullif(p_event, ''), 'event'), 60),
    case when length(coalesce(p_detail, '{}'::jsonb)::text) > 4000 then jsonb_build_object('truncated', true) else coalesce(p_detail, '{}'::jsonb) end);
end;
$$;

create or replace function public.pbx_record_call_attempt_trace(p_call_id uuid, p_event text, p_detail jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = public, pg_temp
as $$ select public._vd_telemetry('TRACE', p_call_id, p_event, p_detail) $$;

create or replace function public.pbx_report_call_quality(p_call_id uuid, p_stats jsonb)
returns void language sql security definer set search_path = public, pg_temp
as $$ select public._vd_telemetry('QUALITY', p_call_id, 'quality', p_stats) $$;

-- ---------------------------------------------------------------------------
-- Call state for order lists
-- ---------------------------------------------------------------------------
create or replace function public.pbx_get_order_call_states(p_order_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('orders.view');
  return coalesce((select jsonb_object_agg(order_id, v) from (
      select c.order_id, jsonb_build_object('lastStatus', (array_agg(c.status order by c.requested_at desc))[1],
        'lastOutcome', (array_agg(c.outcome order by c.requested_at desc))[1],
        'lastAt', max(c.requested_at), 'attempts', count(*),
        'answered', count(*) filter (where c.answered_at is not null),
        'live', bool_or(c.status in ('REQUESTED', 'RINGING', 'ANSWERED') and c.requested_at > now() - interval '3 hours')) v
      from public.pbx_call_records c
      where c.order_id = any(coalesce(p_order_ids, '{}')) and c.business_id = public._vd_my_business()
      group by c.order_id) x), '{}'::jsonb);
end;
$$;

create or replace function public.pbx_get_order_call_state_availability()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  a public.pbx_agents;
  v_problems text[];
begin
  if not public.is_staff() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  a := public._vd_my_agent();
  v_problems := public._vd_line_problems(public._vd_my_business());
  return jsonb_build_object('lineActive', cardinality(v_problems) = 0, 'lineProblems', to_jsonb(v_problems),
    'canCall', public.has_permission('pbx.call') and a.id is not null and a.active and cardinality(v_problems) = 0 and public._vd_seated(a.id),
    'hasExtension', a.id is not null);
end;
$$;

-- ---------------------------------------------------------------------------
-- Business admin: agents, call groups, settings, ledger, reports
-- ---------------------------------------------------------------------------
create or replace function public.pbx_list_agents(p_business_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  perform public.require_permission('pbx.manage');
  v_id := public._vd_business(p_business_id);
  return jsonb_build_object(
    'agents', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'profileId', a.profile_id, 'name', p.full_name, 'email', p.email,
        'extension', a.extension, 'sipUsername', a.sip_username, 'ringGroupId', a.ring_group_id, 'inboundEnabled', a.inbound_enabled,
        'active', a.active, 'seated', public._vd_seated(a.id),
        'online', coalesce(pr.registered and pr.last_heartbeat_at > now() - interval '45 seconds', false),
        'status', case when coalesce(pr.registered and pr.last_heartbeat_at > now() - interval '45 seconds', false) then pr.status else 'OFFLINE' end,
        'lastSeenAt', pr.last_heartbeat_at,
        'onCall', exists (select 1 from public.pbx_call_records c where c.agent_id = a.id and c.status = 'ANSWERED' and c.requested_at > now() - interval '3 hours'))
      order by a.created_at) from public.pbx_agents a join public.profiles p on p.id = a.profile_id
      left join public.pbx_presence pr on pr.agent_id = a.id where a.business_id = v_id), '[]'::jsonb),
    'staff', coalesce((select jsonb_agg(jsonb_build_object('profileId', p.id, 'name', p.full_name, 'email', p.email) order by p.full_name)
      from public.profiles p where p.is_active and not exists (select 1 from public.pbx_agents a where a.profile_id = p.id)
        and coalesce((select business_id from public.pbx_members m where m.profile_id = p.id),
                     (select id from public.pbx_businesses where is_primary)) = v_id), '[]'::jsonb),
    'seats', (public._vd_limits(v_id) ->> 'agents')::int);
end;
$$;

create or replace function public.pbx_save_agent(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := public._vd_business(nullif(p ->> 'business_id', '')::uuid);
  b public.pbx_businesses;
  a public.pbx_agents;
  v_profile uuid := nullif(p ->> 'profile_id', '')::uuid;
  v_ext text := nullif(trim(p ->> 'extension'), '');
  v_group uuid := nullif(p ->> 'ring_group_id', '')::uuid;
  v_active boolean := coalesce((p ->> 'active')::boolean, true);
begin
  perform public.require_permission('pbx.manage');
  select * into b from public.pbx_businesses where id = v_id;
  if v_group is not null and not exists (select 1 from public.pbx_ring_groups where id = v_group and business_id = v_id) then
    raise exception 'VALIDATION: choose a call group of this business' using errcode = '22023';
  end if;
  if nullif(p ->> 'id', '') is not null then
    select * into a from public.pbx_agents where id = (p ->> 'id')::uuid and business_id = v_id;
    if a.id is null then raise exception 'NOT_FOUND: agent not found' using errcode = 'P0002'; end if;
  else
    if v_profile is null or not exists (select 1 from public.profiles where id = v_profile and is_active) then
      raise exception 'VALIDATION: choose a staff member' using errcode = '22023';
    end if;
    if coalesce((select business_id from public.pbx_members where profile_id = v_profile),
                (select id from public.pbx_businesses where is_primary)) <> v_id then
      raise exception 'VALIDATION: this staff member belongs to another business' using errcode = '22023';
    end if;
  end if;
  if v_ext is null then
    v_ext := coalesce(a.extension, (select (coalesce(max(extension::int), 100) + 1)::text from public.pbx_agents where business_id = v_id));
  end if;
  if v_ext !~ '^[1-9][0-9]{1,4}$' then
    raise exception 'VALIDATION: an extension is 2–5 digits, like 101' using errcode = '22023';
  end if;
  if exists (select 1 from public.pbx_agents where business_id = v_id and extension = v_ext and id is distinct from a.id) then
    raise exception 'VALIDATION: extension % is already used', v_ext using errcode = '22023';
  end if;
  if v_active and not coalesce(a.active, false)
     and (select count(*) from public.pbx_agents where business_id = v_id and active) >= (public._vd_limits(v_id) ->> 'agents')::int then
    raise exception 'VALIDATION: all % agent seats are used — add a seat under Package & Recharge', (public._vd_limits(v_id) ->> 'agents') using errcode = '22023';
  end if;
  if a.id is null then
    insert into public.pbx_agents(business_id, profile_id, extension, sip_username, ring_group_id, inbound_enabled, active)
    values (v_id, v_profile, v_ext, 'vd' || b.code || 'x' || v_ext, v_group, coalesce((p ->> 'inbound_enabled')::boolean, true), v_active)
    returning * into a;
  else
    update public.pbx_agents set extension = v_ext, sip_username = 'vd' || b.code || 'x' || v_ext,
      ring_group_id = case when p ? 'ring_group_id' then v_group else ring_group_id end,
      inbound_enabled = coalesce((p ->> 'inbound_enabled')::boolean, inbound_enabled), active = v_active
    where id = a.id returning * into a;
    -- A changed username or a switched-off agent must sign in to the phone again.
    if a.sip_username is distinct from ('vd' || b.code || 'x' || a.extension) or not a.active then
      delete from public.pbx_sip_credentials where agent_id = a.id;
    end if;
  end if;
  if not a.active then
    delete from public.pbx_sip_credentials where agent_id = a.id;
    update public.pbx_presence set status = 'OFFLINE', registered = false where agent_id = a.id;
  end if;
  perform public.log_audit('pbx.agent_saved', 'pbx_agent', a.id::text, null, to_jsonb(a));
  return to_jsonb(a);
end;
$$;

create or replace function public.pbx_remove_agent(p_agent_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a public.pbx_agents;
begin
  perform public.require_permission('pbx.manage');
  select * into a from public.pbx_agents where id = p_agent_id;
  if a.id is null or a.business_id <> public._vd_business(a.business_id) then
    raise exception 'NOT_FOUND: agent not found' using errcode = 'P0002';
  end if;
  -- Calls keep their history; the agent row goes (agent_id becomes null on old calls).
  delete from public.pbx_agents where id = a.id;
  perform public.log_audit('pbx.agent_removed', 'pbx_agent', a.id::text, to_jsonb(a), null);
end;
$$;

create or replace function public.pbx_list_ring_groups(p_business_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  perform public.require_permission('pbx.manage');
  v_id := public._vd_business(p_business_id);
  return coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'strategy', g.strategy, 'ringSeconds', g.ring_seconds,
      'isDefault', g.is_default, 'active', g.active,
      'agents', (select count(*) from public.pbx_agents a where a.business_id = v_id and a.active
        and (a.ring_group_id = g.id or (a.ring_group_id is null and g.is_default)))) order by g.is_default desc, g.name)
    from public.pbx_ring_groups g where g.business_id = v_id), '[]'::jsonb);
end;
$$;

create or replace function public.pbx_save_ring_group(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := public._vd_business(nullif(p ->> 'business_id', '')::uuid);
  g public.pbx_ring_groups;
begin
  perform public.require_permission('pbx.manage');
  if coalesce(p ->> 'strategy', 'RING_ALL') not in ('RING_ALL', 'LONGEST_IDLE') then
    raise exception 'VALIDATION: choose ring all or longest idle' using errcode = '22023';
  end if;
  if nullif(p ->> 'id', '') is null then
    insert into public.pbx_ring_groups(business_id, name, strategy, ring_seconds)
    values (v_id, trim(p ->> 'name'), coalesce(p ->> 'strategy', 'RING_ALL'), coalesce((p ->> 'ring_seconds')::int, 30))
    returning * into g;
  else
    update public.pbx_ring_groups set name = coalesce(nullif(trim(p ->> 'name'), ''), name),
      strategy = coalesce(p ->> 'strategy', strategy), ring_seconds = coalesce((p ->> 'ring_seconds')::int, ring_seconds),
      active = case when is_default then true else coalesce((p ->> 'active')::boolean, active) end
    where id = (p ->> 'id')::uuid and business_id = v_id returning * into g;
    if g.id is null then raise exception 'NOT_FOUND: call group not found' using errcode = 'P0002'; end if;
  end if;
  return to_jsonb(g);
end;
$$;

create or replace function public.pbx_set_business_settings(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := public._vd_business(nullif(p ->> 'business_id', '')::uuid);
  b public.pbx_businesses;
begin
  perform public.require_permission('pbx.manage');
  if p ? 'max_call_minutes' and coalesce((p ->> 'max_call_minutes')::int, 0) not between 1 and 120 then
    raise exception 'VALIDATION: the longest call must be 1–120 minutes' using errcode = '22023';
  end if;
  update public.pbx_businesses set max_call_minutes = coalesce((p ->> 'max_call_minutes')::int, max_call_minutes)
  where id = v_id returning * into b;
  perform public.log_audit('pbx.business_settings', 'pbx_business', b.id::text, null, jsonb_build_object('max_call_minutes', b.max_call_minutes));
  return jsonb_build_object('maxCallMinutes', b.max_call_minutes);
end;
$$;

create or replace function public.pbx_billing_history(p_business_id uuid default null, p_limit int default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  perform public.require_permission('pbx.manage');
  v_id := public._vd_business(p_business_id);
  return jsonb_build_object(
    'ledger', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'kind', l.kind, 'amountTk', round(l.amount_tk, 4),
        'balanceAfterTk', round(l.balance_after_tk, 4), 'note', l.note, 'callId', l.call_id, 'createdAt', l.created_at) order by l.created_at desc)
      from (select * from public.pbx_ledger where business_id = v_id order by created_at desc limit greatest(1, least(p_limit, 500))) l), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'type', t.type, 'amountTk', t.amount_tk, 'status', t.status,
        'trxId', t.trx_id, 'reference', t.reference, 'createdAt', t.created_at, 'completedAt', t.completed_at,
        'package', (select name from public.pbx_packages where id = t.package_id), 'failureReason', t.failure_reason) order by t.created_at desc)
      from (select * from public.pbx_bkash_transactions where business_id = v_id order by created_at desc limit 50) t), '[]'::jsonb),
    'subscriptions', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'package', pk.name, 'agents', s.agents, 'channels', s.channels,
        'startsAt', s.starts_at, 'expiresAt', s.expires_at, 'status', s.status, 'source', s.source, 'amountTk', s.amount_tk) order by s.created_at desc)
      from (select * from public.pbx_subscriptions where business_id = v_id order by created_at desc limit 24) s
      join public.pbx_packages pk on pk.id = s.package_id), '[]'::jsonb));
end;
$$;

create or replace function public.pbx_reports(p_from date, p_to date, p_business_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_from timestamptz := (coalesce(p_from, current_date - 6)::timestamp at time zone 'Asia/Dhaka');
  v_to timestamptz := ((coalesce(p_to, current_date) + 1)::timestamp at time zone 'Asia/Dhaka');
begin
  perform public.require_permission('pbx.manage');
  v_id := public._vd_business(p_business_id);
  return jsonb_build_object(
    'totals', (select jsonb_build_object(
        'calls', count(*),
        'outbound', count(*) filter (where direction = 'OUTBOUND' and status <> 'CANCELLED'),
        'inbound', count(*) filter (where direction = 'INBOUND'),
        'answered', count(*) filter (where answered_at is not null),
        'missed', count(*) filter (where direction = 'INBOUND' and status in ('NO_ANSWER', 'REJECTED', 'BUSY', 'FAILED')),
        'talkSeconds', coalesce(sum(extract(epoch from (ended_at - answered_at))) filter (where answered_at is not null and ended_at is not null), 0)::int,
        'billedSeconds', coalesce(sum(billed_seconds), 0), 'chargedTk', round(coalesce(sum(charged_tk), 0), 2))
      from public.pbx_call_records where business_id = v_id and requested_at >= v_from and requested_at < v_to),
    'byDay', coalesce((select jsonb_agg(d order by d ->> 'day') from (
        select jsonb_build_object('day', (requested_at at time zone 'Asia/Dhaka')::date, 'calls', count(*),
          'answered', count(*) filter (where answered_at is not null),
          'missed', count(*) filter (where direction = 'INBOUND' and status in ('NO_ANSWER', 'REJECTED', 'BUSY', 'FAILED')),
          'chargedTk', round(coalesce(sum(charged_tk), 0), 2)) d
        from public.pbx_call_records where business_id = v_id and requested_at >= v_from and requested_at < v_to
        group by (requested_at at time zone 'Asia/Dhaka')::date) x), '[]'::jsonb),
    'byAgent', coalesce((select jsonb_agg(d order by (d ->> 'calls')::int desc) from (
        select jsonb_build_object('agentId', c.agent_id, 'name', coalesce(p.full_name, 'No agent'), 'extension', max(c.agent_extension),
          'calls', count(*), 'outbound', count(*) filter (where c.direction = 'OUTBOUND' and c.status <> 'CANCELLED'),
          'inbound', count(*) filter (where c.direction = 'INBOUND' and c.answered_at is not null),
          'answered', count(*) filter (where c.answered_at is not null),
          'talkSeconds', coalesce(sum(extract(epoch from (c.ended_at - c.answered_at))) filter (where c.answered_at is not null and c.ended_at is not null), 0)::int,
          'chargedTk', round(coalesce(sum(c.charged_tk), 0), 2)) d
        from public.pbx_call_records c left join public.pbx_agents a on a.id = c.agent_id left join public.profiles p on p.id = a.profile_id
        where c.business_id = v_id and c.requested_at >= v_from and c.requested_at < v_to
        group by c.agent_id, p.full_name) x), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(public._vd_call_json(c) order by c.requested_at desc)
      from (select * from public.pbx_call_records where business_id = v_id and requested_at >= v_from and requested_at < v_to
            order by requested_at desc limit 100) c), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- bKash: start (amount set here), complete (system only, exactly once)
-- ---------------------------------------------------------------------------
create or replace function public.pbx_bkash_start(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := public._vd_business(nullif(p ->> 'business_id', '')::uuid);
  v_type text := p ->> 'type';
  v_amount numeric;
  v_pkg public.pbx_packages;
  v_months int := coalesce((p ->> 'months')::int, 1);
  v_ea int := coalesce((p ->> 'extra_agents')::int, 0);
  v_ec int := coalesce((p ->> 'extra_channels')::int, 0);
  t public.pbx_bkash_transactions;
begin
  perform public.require_permission('pbx.manage');
  if v_type = 'TOPUP' then
    v_amount := round(coalesce((p ->> 'amount_tk')::numeric, 0), 2);
    if v_amount < public._vd_num('min_topup_tk', 100) then
      raise exception 'VALIDATION: the smallest recharge is % tk', public._vd_num('min_topup_tk', 100) using errcode = '22023';
    end if;
    if v_amount > public._vd_num('max_topup_tk', 50000) then
      raise exception 'VALIDATION: the largest recharge is % tk', public._vd_num('max_topup_tk', 50000) using errcode = '22023';
    end if;
  elsif v_type = 'PACKAGE' then
    select * into v_pkg from public.pbx_packages where id = nullif(p ->> 'package_id', '')::uuid and active;
    if v_pkg.id is null then raise exception 'VALIDATION: choose a package' using errcode = '22023'; end if;
    if v_pkg.is_custom then
      raise exception 'VALIDATION: Enterprise is arranged with the VoiceDrive team, not paid here' using errcode = '22023';
    end if;
    if v_months not between 1 and 12 or v_ea not between 0 and 500 or v_ec not between 0 and 200 then
      raise exception 'VALIDATION: check the months and extras' using errcode = '22023';
    end if;
    v_amount := (v_pkg.monthly_price_tk + v_ea * public._vd_num('extra_agent_tk', 100) + v_ec * public._vd_num('extra_channel_tk', 150)) * v_months;
  else
    raise exception 'VALIDATION: choose a package or a recharge' using errcode = '22023';
  end if;
  insert into public.pbx_bkash_transactions(business_id, type, amount_tk, reference, package_id, extra_agents, extra_channels, months, created_by)
  values (v_id, v_type, v_amount, 'VD' || to_char(now() at time zone 'Asia/Dhaka', 'YYMMDD') || upper(substr(md5(gen_random_uuid()::text), 1, 8)),
    v_pkg.id, case when v_type = 'PACKAGE' then v_ea else 0 end, case when v_type = 'PACKAGE' then v_ec else 0 end,
    case when v_type = 'PACKAGE' then v_months else 1 end, auth.uid())
  returning * into t;
  return jsonb_build_object('id', t.id, 'reference', t.reference, 'amountTk', t.amount_tk, 'type', t.type,
    'businessPhone', (select caller_id from public.pbx_businesses where id = v_id));
end;
$$;

create or replace function public.pbx_bkash_attach(p_id uuid, p_payment_id text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.pbx_bkash_transactions set payment_id = p_payment_id where id = p_id and status = 'INITIATED';
end;
$$;

create or replace function public.pbx_bkash_find(p_payment_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return (select to_jsonb(t) from public.pbx_bkash_transactions t where payment_id = p_payment_id);
end;
$$;

-- Applies a confirmed package purchase.
create or replace function public._vd_apply_package(t public.pbx_bkash_transactions)
returns public.pbx_subscriptions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pkg public.pbx_packages;
  cur public.pbx_subscriptions;
  v_start timestamptz := now();
  s public.pbx_subscriptions;
begin
  select * into v_pkg from public.pbx_packages where id = t.package_id;
  select * into cur from public.pbx_subscriptions
  where business_id = t.business_id and status = 'ACTIVE' and expires_at > now() order by expires_at desc limit 1;
  if cur.id is not null and cur.package_id = t.package_id and cur.extra_agents = t.extra_agents and cur.extra_channels = t.extra_channels then
    -- Same plan: the new months follow the current ones.
    v_start := cur.expires_at;
  elsif cur.id is not null then
    -- A different plan starts now and replaces the current one.
    update public.pbx_subscriptions set status = 'REPLACED' where business_id = t.business_id and status = 'ACTIVE' and expires_at > now();
  end if;
  insert into public.pbx_subscriptions(business_id, package_id, agents, channels, extra_agents, extra_channels, months, amount_tk,
    starts_at, expires_at, source, bkash_transaction_id, created_by)
  values (t.business_id, t.package_id, v_pkg.agent_limit + t.extra_agents, v_pkg.concurrent_channels + t.extra_channels,
    t.extra_agents, t.extra_channels, t.months, t.amount_tk, v_start, v_start + make_interval(months => t.months), 'BKASH', t.id, t.created_by)
  returning * into s;
  return s;
end;
$$;

create or replace function public.pbx_bkash_complete(p_reference text, p_success boolean, p_trx_id text, p_amount numeric, p_reason text default null, p_raw jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  t public.pbx_bkash_transactions;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select * into t from public.pbx_bkash_transactions where reference = p_reference for update;
  if t.id is null then
    return jsonb_build_object('status', 'unknown');
  end if;
  if t.status = 'COMPLETED' then
    return jsonb_build_object('status', 'already_completed', 'type', t.type, 'businessId', t.business_id);
  end if;
  if not p_success then
    update public.pbx_bkash_transactions set status = case when p_reason ilike '%cancel%' then 'CANCELLED' else 'FAILED' end,
      failure_reason = left(p_reason, 300), raw = p_raw where id = t.id;
    return jsonb_build_object('status', 'failed', 'type', t.type, 'businessId', t.business_id);
  end if;
  if p_trx_id is null or p_amount is null or round(p_amount, 2) <> t.amount_tk then
    update public.pbx_bkash_transactions set status = 'FAILED', raw = p_raw,
      failure_reason = format('bKash confirmed %s tk, %s tk was due — not applied, contact support', p_amount, t.amount_tk) where id = t.id;
    perform public.log_audit('pbx.bkash_amount_mismatch', 'pbx_bkash_transaction', t.id::text, null,
      jsonb_build_object('expected', t.amount_tk, 'received', p_amount, 'trx_id', p_trx_id));
    return jsonb_build_object('status', 'amount_mismatch', 'type', t.type, 'businessId', t.business_id);
  end if;
  update public.pbx_bkash_transactions set status = 'COMPLETED', trx_id = p_trx_id, completed_at = now(), raw = p_raw
  where id = t.id returning * into t;
  if t.type = 'TOPUP' then
    perform public._vd_ledger_add(t.business_id, 'TOPUP', t.amount_tk, null, t.id, 'bKash ' || p_trx_id);
  else
    perform public._vd_apply_package(t);
  end if;
  perform public.log_audit('pbx.bkash_completed', 'pbx_bkash_transaction', t.id::text, null,
    jsonb_build_object('type', t.type, 'amount', t.amount_tk, 'trx_id', p_trx_id));
  return jsonb_build_object('status', 'completed', 'type', t.type, 'businessId', t.business_id);
end;
$$;

create or replace function public.pbx_bkash_pending(p_limit int default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('reference', reference, 'paymentId', payment_id,
      'ageMinutes', extract(epoch from now() - created_at) / 60))
    from (select * from public.pbx_bkash_transactions where status = 'INITIATED' and payment_id is not null
            and created_at < now() - interval '5 minutes' and created_at > now() - interval '2 days'
          order by created_at limit p_limit) t), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Super Admin
-- ---------------------------------------------------------------------------
create or replace function public._vd_require_super()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public._vd_is_super() then
    raise exception 'PERMISSION_DENIED: pbx.super_admin is required' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.pbx_admin_list_businesses()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._vd_require_super();
  return jsonb_build_object(
    'businesses', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'code', b.code, 'name', b.name, 'isPrimary', b.is_primary,
        'did', b.did, 'callerId', b.caller_id, 'trunkHost', b.trunk_host, 'trunkPort', b.trunk_port, 'trunkTransport', b.trunk_transport,
        'trunkUser', b.trunk_user, 'trunkRegister', b.trunk_register, 'trunkSecretSet', b.trunk_secret_set, 'dialFormat', b.dial_format,
        'maxCallMinutes', b.max_call_minutes, 'pbxEnabled', b.pbx_enabled, 'bridgeReady', b.bridge_ready, 'bridgeReadyAt', b.bridge_ready_at,
        'limits', public._vd_limits(b.id), 'balanceTk', round(public._vd_balance(b.id), 2),
        'agents', (select count(*) from public.pbx_agents a where a.business_id = b.id and a.active),
        'members', (select count(*) from public.pbx_members m where m.business_id = b.id),
        'lineProblems', to_jsonb(public._vd_line_problems(b.id))) order by b.is_primary desc, b.created_at)
      from public.pbx_businesses b), '[]'::jsonb),
    'gateway', (select jsonb_build_object('lastSeenAt', last_seen_at, 'version', version, 'detail', detail,
      'online', last_seen_at > now() - interval '2 minutes') from public.pbx_gateway_status),
    'settings', (select jsonb_build_object('sipDomain', v ->> 'sip_domain', 'wssUrl', v ->> 'wss_url', 'stunUrls', v -> 'stun_urls',
        'turnUrls', v -> 'turn_urls', 'turnTtlSeconds', v -> 'turn_ttl_seconds', 'credentialTtlSeconds', v -> 'credential_ttl_seconds',
        'ratePerMinTk', v -> 'rate_tk_per_min', 'vatPercent', v -> 'vat_percent', 'minTopupTk', v -> 'min_topup_tk',
        'maintenance', v -> 'maintenance') from (select public._vd_cfg() v) x),
    'secrets', jsonb_build_object(
      'gatewayToken', (select jsonb_build_object('hint', hint, 'at', connected_at) from public.integration_credentials where key = 'voicedrive.gateway' and hint is not null),
      'turnSecret', (select jsonb_build_object('hint', hint, 'at', connected_at) from public.integration_credentials where key = 'voicedrive.turn' and hint is not null)),
    'packages', (public.pbx_packages_list() -> 'packages'),
    'staff', coalesce((select jsonb_agg(jsonb_build_object('profileId', p.id, 'name', p.full_name, 'email', p.email,
        'businessId', m.business_id) order by p.full_name) from public.profiles p left join public.pbx_members m on m.profile_id = p.id
      where p.is_active), '[]'::jsonb));
end;
$$;

create or replace function public.pbx_admin_save_business(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  b public.pbx_businesses;
begin
  perform public._vd_require_super();
  if nullif(p ->> 'id', '') is null then
    insert into public.pbx_businesses(name) values (trim(p ->> 'name')) returning * into b;
    insert into public.pbx_ring_groups(business_id, name, is_default) values (b.id, 'Everyone', true);
  else
    update public.pbx_businesses set name = coalesce(nullif(trim(p ->> 'name'), ''), name)
    where id = (p ->> 'id')::uuid returning * into b;
    if b.id is null then raise exception 'NOT_FOUND: business not found' using errcode = 'P0002'; end if;
  end if;
  perform public.log_audit('pbx.business_saved', 'pbx_business', b.id::text, null, jsonb_build_object('name', b.name));
  return to_jsonb(b) - 'trunk_user';
end;
$$;

-- Number, caller ID and trunk (the password goes to Vault through the edge
-- function, which then calls pbx_admin_mark_trunk_secret).
create or replace function public.pbx_provision_business_did(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  b public.pbx_businesses;
  v_did text := public.normalize_phone(nullif(trim(p ->> 'did'), ''));
  v_caller text := public.normalize_phone(nullif(trim(p ->> 'caller_id'), ''));
  v_host text := lower(nullif(trim(p ->> 'trunk_host'), ''));
begin
  perform public._vd_require_super();
  select * into b from public.pbx_businesses where id = (p ->> 'business_id')::uuid for update;
  if b.id is null then raise exception 'NOT_FOUND: business not found' using errcode = 'P0002'; end if;
  if v_did is null or v_did !~ '^0[0-9]{9,12}$' then
    raise exception 'VALIDATION: enter the DID like 09639XXXXXX' using errcode = '22023';
  end if;
  if v_caller is not null and v_caller !~ '^0[0-9]{9,12}$' then
    raise exception 'VALIDATION: enter the caller ID like 09639XXXXXX' using errcode = '22023';
  end if;
  if v_host is null or v_host !~ '^[a-z0-9.-]{1,253}$' then
    raise exception 'VALIDATION: enter the trunk host (name or IP) from your IPTSP' using errcode = '22023';
  end if;
  if exists (select 1 from public.pbx_businesses where did = v_did and id <> b.id) then
    raise exception 'VALIDATION: this number is already used by another business' using errcode = '22023';
  end if;
  if coalesce(p ->> 'trunk_transport', 'udp') not in ('udp', 'tcp', 'tls') or coalesce(p ->> 'dial_format', 'LOCAL') not in ('LOCAL', 'E164', 'E164_NO_PLUS') then
    raise exception 'VALIDATION: check the transport and dial format' using errcode = '22023';
  end if;
  update public.pbx_businesses set did = v_did, caller_id = coalesce(v_caller, v_did), trunk_host = v_host,
    trunk_port = coalesce((p ->> 'trunk_port')::int, trunk_port), trunk_transport = coalesce(p ->> 'trunk_transport', trunk_transport),
    trunk_user = coalesce(nullif(trim(p ->> 'trunk_user'), ''), trunk_user),
    trunk_register = coalesce((p ->> 'trunk_register')::boolean, trunk_register),
    dial_format = coalesce(p ->> 'dial_format', dial_format),
    pbx_enabled = coalesce((p ->> 'pbx_enabled')::boolean, pbx_enabled),
    -- Changing the trunk means the gateway must be checked again.
    bridge_ready = case when b.did is distinct from v_did or b.trunk_host is distinct from v_host
      or b.trunk_user is distinct from coalesce(nullif(trim(p ->> 'trunk_user'), ''), b.trunk_user) then false else bridge_ready end,
    provisioned_at = now(), provisioned_by = auth.uid()
  where id = b.id returning * into b;
  perform public.log_audit('pbx.business_provisioned', 'pbx_business', b.id::text, null,
    jsonb_build_object('did', b.did, 'caller_id', b.caller_id, 'trunk_host', b.trunk_host, 'pbx_enabled', b.pbx_enabled));
  return jsonb_build_object('id', b.id, 'did', b.did, 'callerId', b.caller_id, 'bridgeReady', b.bridge_ready, 'pbxEnabled', b.pbx_enabled);
end;
$$;

create or replace function public.pbx_admin_mark_trunk_secret(p_business_id uuid, p_set boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.pbx_businesses set trunk_secret_set = p_set, bridge_ready = case when p_set then bridge_ready else false end
  where id = p_business_id;
end;
$$;

create or replace function public.pbx_set_pbx_bridge_ready(p_business_id uuid, p_ready boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  b public.pbx_businesses;
begin
  perform public._vd_require_super();
  select * into b from public.pbx_businesses where id = p_business_id;
  if b.id is null then raise exception 'NOT_FOUND: business not found' using errcode = 'P0002'; end if;
  if p_ready and (b.did is null or b.trunk_host is null or not b.trunk_secret_set) then
    raise exception 'VALIDATION: add the number, trunk host and trunk password first' using errcode = '22023';
  end if;
  if p_ready and not coalesce((select last_seen_at > now() - interval '2 minutes' from public.pbx_gateway_status), false) then
    raise exception 'VALIDATION: the gateway has not checked in for 2 minutes — start it, then try again' using errcode = '22023';
  end if;
  update public.pbx_businesses set bridge_ready = p_ready, bridge_ready_at = case when p_ready then now() end,
    bridge_ready_by = case when p_ready then auth.uid() end
  where id = b.id returning * into b;
  perform public.log_audit('pbx.bridge_ready', 'pbx_business', b.id::text, null, jsonb_build_object('ready', p_ready));
  return jsonb_build_object('id', b.id, 'bridgeReady', b.bridge_ready, 'bridgeReadyAt', b.bridge_ready_at);
end;
$$;

create or replace function public.pbx_admin_set_member(p_profile_id uuid, p_business_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._vd_require_super();
  if exists (select 1 from public.pbx_agents where profile_id = p_profile_id and business_id <> coalesce(p_business_id, business_id)) then
    raise exception 'VALIDATION: remove this person''s phone extension before moving them' using errcode = '22023';
  end if;
  if p_business_id is null or p_business_id = (select id from public.pbx_businesses where is_primary) then
    delete from public.pbx_members where profile_id = p_profile_id;
  else
    insert into public.pbx_members(profile_id, business_id) values (p_profile_id, p_business_id)
    on conflict (profile_id) do update set business_id = excluded.business_id;
  end if;
  perform public.log_audit('pbx.member', 'profile', p_profile_id::text, null, jsonb_build_object('business_id', p_business_id));
end;
$$;

create or replace function public.pbx_admin_grant_package(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pkg public.pbx_packages;
  v_id uuid := (p ->> 'business_id')::uuid;
  v_agents int;
  v_channels int;
  v_months int := coalesce((p ->> 'months')::int, 1);
  s public.pbx_subscriptions;
begin
  perform public._vd_require_super();
  if not exists (select 1 from public.pbx_businesses where id = v_id) then
    raise exception 'NOT_FOUND: business not found' using errcode = 'P0002';
  end if;
  select * into v_pkg from public.pbx_packages where id = (p ->> 'package_id')::uuid;
  if v_pkg.id is null then raise exception 'VALIDATION: choose a package' using errcode = '22023'; end if;
  v_agents := coalesce(v_pkg.agent_limit, 0) + coalesce((p ->> 'extra_agents')::int, 0);
  v_channels := coalesce(v_pkg.concurrent_channels, 0) + coalesce((p ->> 'extra_channels')::int, 0);
  if v_pkg.is_custom then
    v_agents := (p ->> 'agents')::int;
    v_channels := (p ->> 'channels')::int;
  end if;
  if coalesce(v_agents, 0) < 1 or coalesce(v_channels, 0) < 1 or v_months not between 1 and 12 then
    raise exception 'VALIDATION: give the agents, channels and 1–12 months' using errcode = '22023';
  end if;
  update public.pbx_subscriptions set status = 'REPLACED' where business_id = v_id and status = 'ACTIVE' and expires_at > now();
  insert into public.pbx_subscriptions(business_id, package_id, agents, channels, extra_agents, extra_channels, months, amount_tk,
    starts_at, expires_at, source, note, created_by)
  values (v_id, v_pkg.id, v_agents, v_channels, coalesce((p ->> 'extra_agents')::int, 0), coalesce((p ->> 'extra_channels')::int, 0),
    v_months, coalesce((p ->> 'amount_tk')::numeric, 0), now(), now() + make_interval(months => v_months), 'ADMIN',
    left(nullif(trim(p ->> 'note'), ''), 300), auth.uid())
  returning * into s;
  perform public.log_audit('pbx.package_granted', 'pbx_business', v_id::text, null, to_jsonb(s));
  return to_jsonb(s);
end;
$$;

create or replace function public.pbx_admin_adjust_balance(p_business_id uuid, p_amount numeric, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  l public.pbx_ledger;
begin
  perform public._vd_require_super();
  if coalesce(p_amount, 0) = 0 or abs(p_amount) > 1000000 then
    raise exception 'VALIDATION: enter an amount' using errcode = '22023';
  end if;
  if nullif(trim(p_note), '') is null then
    raise exception 'VALIDATION: say why the balance changes' using errcode = '22023';
  end if;
  l := public._vd_ledger_add(p_business_id, 'ADJUSTMENT', round(p_amount, 4), null, null, left(trim(p_note), 300));
  perform public.log_audit('pbx.balance_adjusted', 'pbx_business', p_business_id::text, null, to_jsonb(l));
  return jsonb_build_object('balanceTk', round(l.balance_after_tk, 2));
end;
$$;

create or replace function public.pbx_admin_save_settings(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb := public._vd_cfg();
  u text;
begin
  perform public._vd_require_super();
  if p ? 'sip_domain' then
    if nullif(trim(p ->> 'sip_domain'), '') is not null and trim(p ->> 'sip_domain') !~ '^[A-Za-z0-9.-]{3,253}$' then
      raise exception 'VALIDATION: the SIP domain is a host name like pbx.example.com' using errcode = '22023';
    end if;
    v := v || jsonb_build_object('sip_domain', nullif(lower(trim(p ->> 'sip_domain')), ''));
  end if;
  if p ? 'wss_url' then
    -- Browsers need WSS; plain ws:// is accepted only for a gateway on this machine (local testing).
    if nullif(trim(p ->> 'wss_url'), '') is not null and trim(p ->> 'wss_url') !~ '^wss://[^\s/]+(/\S*)?$'
       and trim(p ->> 'wss_url') !~ '^ws://(localhost|127\.0\.0\.1)(:[0-9]+)?(/\S*)?$' then
      raise exception 'VALIDATION: the WebSocket address starts with wss://' using errcode = '22023';
    end if;
    v := v || jsonb_build_object('wss_url', nullif(trim(p ->> 'wss_url'), ''));
  end if;
  if p ? 'turn_urls' then
    for u in select jsonb_array_elements_text(coalesce(p -> 'turn_urls', '[]'::jsonb)) loop
      if u !~ '^turns?:[^\s]+$' then
        raise exception 'VALIDATION: TURN addresses start with turn: or turns:' using errcode = '22023';
      end if;
    end loop;
    v := v || jsonb_build_object('turn_urls', coalesce(p -> 'turn_urls', '[]'::jsonb));
  end if;
  if p ? 'stun_urls' then v := v || jsonb_build_object('stun_urls', coalesce(p -> 'stun_urls', '[]'::jsonb)); end if;
  if p ? 'credential_ttl_seconds' then
    v := v || jsonb_build_object('credential_ttl_seconds', greatest(120, least(3600, (p ->> 'credential_ttl_seconds')::int)));
  end if;
  if p ? 'rate_tk_per_min' then
    if (p ->> 'rate_tk_per_min')::numeric not between 0.01 and 10 then
      raise exception 'VALIDATION: rate must be 0.01–10 tk a minute' using errcode = '22023';
    end if;
    v := v || jsonb_build_object('rate_tk_per_min', (p ->> 'rate_tk_per_min')::numeric);
  end if;
  if p ? 'vat_percent' then
    v := v || jsonb_build_object('vat_percent', greatest(0, least(50, (p ->> 'vat_percent')::numeric)));
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
  update public.settings set value = v, updated_by = auth.uid() where key = 'voicedrive';
  perform public.log_audit('pbx.platform_settings', 'settings', 'voicedrive', null, v);
  return v;
end;
$$;

-- ---------------------------------------------------------------------------
-- Gateway procedures (service role only; the voicedrive edge function calls
-- them for the gateway after checking its token)
-- ---------------------------------------------------------------------------
create or replace function public._vd_require_system()
returns void
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.pbx_gw_ping(p_version text, p_detail jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._vd_require_system();
  update public.pbx_gateway_status set last_seen_at = now(), version = left(p_version, 80),
    detail = case when length(coalesce(p_detail, '{}'::jsonb)::text) > 20000 then jsonb_build_object('truncated', true) else coalesce(p_detail, '{}'::jsonb) end
  where id;
  return jsonb_build_object('ok', true, 'at', now());
end;
$$;

-- Businesses whose trunk the gateway should carry (passwords added by the edge function from Vault).
create or replace function public.pbx_gw_trunks()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._vd_require_system();
  return coalesce((select jsonb_agg(jsonb_build_object('businessId', id, 'code', code, 'did', did, 'callerId', coalesce(caller_id, did),
      'host', trunk_host, 'port', trunk_port, 'transport', trunk_transport, 'user', trunk_user, 'register', trunk_register,
      'dialFormat', dial_format, 'enabled', pbx_enabled) order by code)
    from public.pbx_businesses where trunk_host is not null and did is not null and trunk_secret_set), '[]'::jsonb);
end;
$$;

-- An agent's browser dialled out. Authoritative checks happen here, at dial time.
create or replace function public.pbx_gw_outbound_start(p_sip_username text, p_dialed text, p_call_id uuid, p_gateway_call_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a public.pbx_agents;
  b public.pbx_businesses;
  c public.pbx_call_records;
  v_problems text[];
  v_channels int;
  v_rate numeric := public._vd_rate_with_vat();
  v_available numeric;
  v_max int;
  v_dial text := public.normalize_phone(p_dialed);
  v_reason text;
begin
  perform public._vd_require_system();
  select * into a from public.pbx_agents where sip_username = p_sip_username;
  if a.id is null then
    return jsonb_build_object('allow', false, 'reason', 'UNKNOWN_EXTENSION');
  end if;
  -- Serialise call starts per business so channel and balance checks can't race.
  select * into b from public.pbx_businesses where id = a.business_id for update;
  if p_call_id is null then
    return jsonb_build_object('allow', false, 'reason', 'NO_REQUEST');
  end if;
  select * into c from public.pbx_call_records where id = p_call_id for update;
  if c.id is null or c.agent_id <> a.id or c.direction <> 'OUTBOUND' then
    return jsonb_build_object('allow', false, 'reason', 'NO_REQUEST');
  end if;
  if c.status <> 'REQUESTED' then
    return jsonb_build_object('allow', false, 'reason', 'REQUEST_USED', 'callId', c.id);
  end if;
  if c.requested_at < now() - interval '120 seconds' then
    v_reason := 'REQUEST_EXPIRED';
  elsif v_dial is distinct from c.normalized_customer_phone then
    v_reason := 'NUMBER_MISMATCH';
  elsif not a.active or not public._vd_seated(a.id) then
    v_reason := 'NO_SEAT';
  end if;
  if v_reason is null then
    v_problems := public._vd_line_problems(b.id);
    if cardinality(v_problems) > 0 then v_reason := v_problems[1]; end if;
  end if;
  if v_reason is null then
    v_channels := (public._vd_limits(b.id) ->> 'channels')::int;
    if (select count(*) from public.pbx_channel_holds where business_id = b.id) >= v_channels then
      v_reason := 'CHANNEL_LIMIT';
    end if;
  end if;
  if v_reason is null then
    -- Money not already held by other live calls decides the longest this call may run.
    v_available := public._vd_balance(b.id) - coalesce((select sum(hold_tk) from public.pbx_channel_holds where business_id = b.id), 0);
    if v_available <= 0 then
      v_reason := 'INSUFFICIENT_BALANCE';
    else
      v_max := least(b.max_call_minutes * 60, floor(v_available / (v_rate / 60))::int);
      if v_max < 10 then v_reason := 'INSUFFICIENT_BALANCE'; end if;
    end if;
  end if;
  if v_reason is not null then
    update public.pbx_call_records set status = 'REJECTED', reject_reason = v_reason, ended_at = now(),
      gateway_call_id = coalesce(gateway_call_id, left(p_gateway_call_id, 120))
    where id = c.id;
    return jsonb_build_object('allow', false, 'reason', v_reason, 'callId', c.id);
  end if;
  insert into public.pbx_channel_holds(call_id, business_id, hold_tk) values (c.id, b.id, round(v_max * v_rate / 60, 4));
  update public.pbx_call_records set status = 'RINGING', started_at = now(), max_seconds = v_max,
    gateway_call_id = left(p_gateway_call_id, 120), rate_tk_per_min = public._vd_num('rate_tk_per_min', 0.40)
  where id = c.id;
  return jsonb_build_object('allow', true, 'callId', c.id, 'businessCode', b.code, 'trunk', 'vdtrunk-' || b.code,
    'dial', case b.dial_format when 'E164' then '+880' || substr(v_dial, 2) when 'E164_NO_PLUS' then '880' || substr(v_dial, 2) else v_dial end,
    'callerId', coalesce(b.caller_id, b.did), 'maxSeconds', v_max);
end;
$$;

-- A call reached a business number.
create or replace function public.pbx_gw_inbound_start(p_did text, p_from text, p_gateway_call_id text, p_business_code int default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  b public.pbx_businesses;
  c public.pbx_call_records;
  v_did text := public.normalize_phone(p_did);
  v_from text := public.normalize_phone(p_from);
  v_reason text;
  v_targets jsonb;
  v_group public.pbx_ring_groups;
  v_ids uuid[];
begin
  perform public._vd_require_system();
  select * into b from public.pbx_businesses where did = v_did for update;
  if b.id is null and p_business_code is not null then
    select * into b from public.pbx_businesses where code = p_business_code for update;
  end if;
  if b.id is null then
    return jsonb_build_object('allow', false, 'reason', 'UNKNOWN_NUMBER');
  end if;
  -- Same INVITE retried: give back the same call.
  select * into c from public.pbx_call_records where gateway_call_id = left(p_gateway_call_id, 120);
  if c.id is not null then
    return jsonb_build_object('allow', c.status = 'RINGING', 'callId', c.id, 'reason', 'DUPLICATE');
  end if;
  v_reason := (public._vd_line_problems(b.id))[1];
  if v_reason is null and (select count(*) from public.pbx_channel_holds where business_id = b.id) >= (public._vd_limits(b.id) ->> 'channels')::int then
    v_reason := 'CHANNEL_LIMIT';
  end if;
  insert into public.pbx_call_records(business_id, direction, kind, customer_id, customer_phone, normalized_customer_phone, caller_id, did,
    status, reject_reason, gateway_call_id, started_at, ended_at)
  values (b.id, 'INBOUND', 'INBOUND', (select id from public.customers where phone = v_from limit 1), left(p_from, 40), v_from, v_from, b.did,
    case when v_reason is null then 'RINGING' else 'REJECTED' end, v_reason, left(p_gateway_call_id, 120), now(),
    case when v_reason is null then null else now() end)
  returning * into c;
  if v_reason is not null then
    return jsonb_build_object('allow', false, 'reason', v_reason, 'callId', c.id);
  end if;
  insert into public.pbx_channel_holds(call_id, business_id, hold_tk) values (c.id, b.id, 0);

  select * into v_group from public.pbx_ring_groups where business_id = b.id and is_default;
  -- Available = online in the last 45 s, marked available, seated, not on a call.
  select coalesce(jsonb_agg(jsonb_build_object('agentId', x.id, 'sipUsername', x.sip_username, 'extension', x.extension) order by x.ord), '[]'::jsonb),
         coalesce(array_agg(x.id), '{}')
    into v_targets, v_ids
  from (
    select a.id, a.sip_username, a.extension,
      row_number() over (order by case when v_group.strategy = 'LONGEST_IDLE' then coalesce(pr.last_call_ended_at, 'epoch'::timestamptz) end asc nulls first, a.created_at) ord
    from public.pbx_agents a join public.pbx_presence pr on pr.agent_id = a.id
    where a.business_id = b.id and a.active and a.inbound_enabled
      and (a.ring_group_id is null or a.ring_group_id = v_group.id
           or exists (select 1 from public.pbx_ring_groups g where g.id = a.ring_group_id and not g.active))
      and pr.status = 'AVAILABLE' and pr.registered and pr.last_heartbeat_at > now() - interval '45 seconds'
      and public._vd_seated(a.id)
      and not exists (select 1 from public.pbx_call_records oc where oc.agent_id = a.id and oc.status in ('RINGING', 'ANSWERED')
                        and oc.requested_at > now() - interval '3 hours')
  ) x;
  update public.pbx_call_records set offered_agents = v_ids where id = c.id;
  return jsonb_build_object('allow', true, 'callId', c.id, 'businessCode', b.code, 'targets', v_targets,
    'strategy', coalesce(v_group.strategy, 'RING_ALL'), 'ringSeconds', coalesce(v_group.ring_seconds, 30),
    'maxSeconds', b.max_call_minutes * 60);
end;
$$;

create or replace function public.pbx_gw_call_answered(p_call_id uuid, p_sip_username text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c public.pbx_call_records;
  a public.pbx_agents;
begin
  perform public._vd_require_system();
  select * into c from public.pbx_call_records where id = p_call_id for update;
  if c.id is null then return jsonb_build_object('ok', false, 'reason', 'NOT_FOUND'); end if;
  if c.status not in ('RINGING', 'ANSWERED') then
    return jsonb_build_object('ok', false, 'reason', 'NOT_RINGING', 'status', c.status);
  end if;
  if c.direction = 'INBOUND' and p_sip_username is not null then
    select * into a from public.pbx_agents where sip_username = p_sip_username and business_id = c.business_id;
  end if;
  update public.pbx_call_records set status = 'ANSWERED', answered_at = coalesce(answered_at, now()),
    agent_id = coalesce(a.id, agent_id), agent_extension = coalesce(a.extension, agent_extension)
  where id = c.id returning * into c;
  return jsonb_build_object('ok', true, 'callId', c.id, 'agentId', c.agent_id);
end;
$$;

-- The gateway's record of how the call ended. Charges outgoing answered calls
-- once (the ledger has one row per call).
create or replace function public.pbx_gw_call_ended(
  p_call_id uuid, p_status text, p_billsec numeric default 0, p_hangup_cause text default null, p_answered boolean default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c public.pbx_call_records;
  v_status text := upper(coalesce(p_status, 'FAILED'));
  v_billed int;
  v_cost numeric;
  v_vat numeric;
  v_rate numeric;
begin
  perform public._vd_require_system();
  select * into c from public.pbx_call_records where id = p_call_id for update;
  if c.id is null then return jsonb_build_object('ok', false, 'reason', 'NOT_FOUND'); end if;
  if v_status not in ('COMPLETED', 'NO_ANSWER', 'BUSY', 'FAILED', 'CANCELLED', 'REJECTED') then v_status := 'FAILED'; end if;
  if c.status in ('COMPLETED', 'NO_ANSWER', 'BUSY', 'FAILED', 'CANCELLED', 'REJECTED') then
    delete from public.pbx_channel_holds where call_id = c.id;
    return jsonb_build_object('ok', true, 'already', true, 'status', c.status, 'chargedTk', c.charged_tk);
  end if;
  if coalesce(p_answered, c.answered_at is not null) then
    v_status := 'COMPLETED';
    v_billed := ceil(greatest(coalesce(p_billsec, 0), 0))::int;
  else
    v_billed := 0;
    if v_status = 'COMPLETED' then v_status := 'NO_ANSWER'; end if;
  end if;
  if c.direction = 'OUTBOUND' and v_billed > 0 then
    v_rate := coalesce(c.rate_tk_per_min, public._vd_num('rate_tk_per_min', 0.40));
    v_cost := round(v_billed * v_rate / 60, 4);
    v_vat := round(v_cost * public._vd_num('vat_percent', 15) / 100, 4);
    perform public._vd_ledger_add(c.business_id, 'CALL_CHARGE', -(v_cost + v_vat), c.id, null,
      format('Call to %s, %s s', c.normalized_customer_phone, v_billed));
  else
    v_cost := 0; v_vat := 0;
  end if;
  update public.pbx_call_records set status = v_status, ended_at = now(), billed_seconds = v_billed,
    answered_at = case when v_status = 'COMPLETED' then coalesce(answered_at, now() - make_interval(secs => v_billed)) else answered_at end,
    hangup_cause = left(p_hangup_cause, 60), cost_tk = v_cost, vat_tk = v_vat, charged_tk = v_cost + v_vat
  where id = c.id returning * into c;
  delete from public.pbx_channel_holds where call_id = c.id;
  if c.agent_id is not null then
    update public.pbx_presence set last_call_ended_at = now() where agent_id = c.agent_id;
  end if;
  return jsonb_build_object('ok', true, 'status', c.status, 'billedSeconds', c.billed_seconds, 'chargedTk', c.charged_tk);
end;
$$;

-- Cron: expire requests that never dialled, and free holds whose end the
-- gateway never reported (no charge without a gateway record).
create or replace function public.pbx_sweep()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_expired int;
  v_lost int;
begin
  perform public._vd_require_system();
  update public.pbx_call_records set status = 'CANCELLED', reject_reason = 'REQUEST_EXPIRED', ended_at = now()
  where status = 'REQUESTED' and requested_at < now() - interval '3 minutes';
  get diagnostics v_expired = row_count;
  with lost as (
    select c.id from public.pbx_call_records c join public.pbx_channel_holds h on h.call_id = c.id
    where c.status in ('RINGING', 'ANSWERED')
      and coalesce(c.started_at, c.requested_at) < now() - make_interval(secs => coalesce(c.max_seconds, 7200) + 600))
  update public.pbx_call_records c set status = 'FAILED', hangup_cause = 'GATEWAY_LOST', ended_at = now()
  from lost where c.id = lost.id;
  get diagnostics v_lost = row_count;
  delete from public.pbx_channel_holds h using public.pbx_call_records c
  where c.id = h.call_id and c.status not in ('RINGING', 'ANSWERED');
  delete from public.pbx_call_telemetry where created_at < now() - interval '30 days';
  delete from public.pbx_sip_credentials where expires_at < now() - interval '1 day';
  if v_lost > 0 then
    perform public.log_audit('pbx.calls_lost', 'pbx', 'sweep', null, jsonb_build_object('calls', v_lost));
  end if;
  return jsonb_build_object('expired', v_expired, 'lost', v_lost);
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('voicedrive-sweep', '* * * * *', 'select public.pbx_sweep()');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- One request for many reads (like a batched API call on page load)
-- ---------------------------------------------------------------------------
create or replace function public.pbx_batch(p_calls jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_out jsonb := '{}'::jsonb;
  k text;
  v_input jsonb;
  v_result jsonb;
begin
  if jsonb_typeof(p_calls) <> 'object' or (select count(*) from jsonb_object_keys(p_calls)) > 20 then
    raise exception 'VALIDATION: send up to 20 procedures as an object' using errcode = '22023';
  end if;
  for k, v_input in select * from jsonb_each(p_calls) loop
    begin
      v_result := case k
        when 'overview' then public.pbx_overview(nullif(v_input ->> 'businessId', '')::uuid)
        when 'maintenanceStatus' then public.pbx_maintenance_status()
        when 'packages' then public.pbx_packages_list()
        when 'getInboundPhoneEligibility' then public.pbx_get_inbound_phone_eligibility()
        when 'getMyBrowserPhoneRegistration' then public.pbx_get_my_browser_phone_registration()
        when 'getMyActiveInboundBrowserCall' then public.pbx_get_my_active_inbound_call()
        when 'getMyOutgoingCallRequestState' then public.pbx_get_my_outgoing_call_request_state()
        when 'getRecentMissedInboundCalls' then public.pbx_get_recent_missed_inbound_calls(coalesce((v_input ->> 'limit')::int, 50))
        when 'getOrderCallStateAvailability' then public.pbx_get_order_call_state_availability()
        when 'listAgents' then public.pbx_list_agents(nullif(v_input ->> 'businessId', '')::uuid)
        when 'listRingGroups' then public.pbx_list_ring_groups(nullif(v_input ->> 'businessId', '')::uuid)
        when 'billingHistory' then public.pbx_billing_history(nullif(v_input ->> 'businessId', '')::uuid, coalesce((v_input ->> 'limit')::int, 50))
        else null end;
      if v_result is null and k not in ('getMyActiveInboundBrowserCall', 'getMyOutgoingCallRequestState') then
        if k not in ('overview', 'maintenanceStatus', 'packages', 'getInboundPhoneEligibility', 'getMyBrowserPhoneRegistration',
                     'getRecentMissedInboundCalls', 'getOrderCallStateAvailability', 'listAgents', 'listRingGroups', 'billingHistory') then
          v_out := v_out || jsonb_build_object(k, jsonb_build_object('error', jsonb_build_object('code', 'NOT_FOUND', 'message', 'Unknown procedure')));
          continue;
        end if;
      end if;
      v_out := v_out || jsonb_build_object(k, jsonb_build_object('result', v_result));
    exception when others then
      v_out := v_out || jsonb_build_object(k, jsonb_build_object('error', jsonb_build_object('code', sqlstate, 'message', sqlerrm)));
    end;
  end loop;
  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
do $$
declare
  f text;
begin
  -- Helpers and gateway/system procedures: never callable from the browser.
  foreach f in array array[
    'public._vd_cfg()', 'public._vd_num(text, numeric)', 'public._vd_is_super()', 'public._vd_my_business()', 'public._vd_business(uuid)',
    'public._vd_maintenance()', 'public._vd_limits(uuid)', 'public._vd_line_problems(uuid)', 'public._vd_seated(uuid)', 'public._vd_my_agent()',
    'public._vd_rate_with_vat()', 'public._vd_balance(uuid)', 'public._vd_ledger_add(uuid, text, numeric, uuid, uuid, text)',
    'public._vd_call_json(public.pbx_call_records)', 'public._vd_start_outbound(text, text, uuid, uuid)', 'public._vd_start_order_call(uuid, text)',
    'public._vd_my_call(uuid)', 'public._vd_telemetry(text, uuid, text, jsonb)', 'public._vd_apply_package(public.pbx_bkash_transactions)',
    'public._vd_require_super()', 'public._vd_require_system()',
    'public.pbx_bkash_attach(uuid, text)', 'public.pbx_bkash_find(text)', 'public.pbx_bkash_pending(int)',
    'public.pbx_bkash_complete(text, boolean, text, numeric, text, jsonb)', 'public.pbx_admin_mark_trunk_secret(uuid, boolean)',
    'public.pbx_gw_ping(text, jsonb)', 'public.pbx_gw_trunks()', 'public.pbx_gw_outbound_start(text, text, uuid, text)',
    'public.pbx_gw_inbound_start(text, text, text, int)', 'public.pbx_gw_call_answered(uuid, text)',
    'public.pbx_gw_call_ended(uuid, text, numeric, text, boolean)', 'public.pbx_sweep()', 'public.pbx_ledger_immutable()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  -- Signed-in staff (each checks its own permission).
  foreach f in array array[
    'public.pbx_maintenance_status()', 'public.pbx_packages_list()', 'public.pbx_overview(uuid)', 'public.pbx_get_inbound_phone_eligibility()',
    'public.pbx_issue_my_credential(text, text)', 'public.pbx_get_my_browser_phone_registration()',
    'public.pbx_set_inbound_phone_presence(text, boolean, text, text)', 'public.pbx_clear_inbound_phone_presence()',
    'public.pbx_start_manual_call(text, uuid)', 'public.pbx_start_approved_order_call(uuid)', 'public.pbx_start_web_order_call(uuid)',
    'public.pbx_get_call_state(uuid)', 'public.pbx_get_my_outgoing_call_request_state()', 'public.pbx_cancel_call(uuid)',
    'public.pbx_end_call(uuid, text, text)', 'public.pbx_get_my_active_inbound_call()', 'public.pbx_resolve_inbound_caller_context(text)',
    'public.pbx_get_inbound_caller_order_detail(text)', 'public.pbx_resolve_inbound_caller_courier_rating(text)',
    'public.pbx_get_recent_missed_inbound_calls(int)', 'public.pbx_record_call_attempt_trace(uuid, text, jsonb)',
    'public.pbx_report_call_quality(uuid, jsonb)', 'public.pbx_get_order_call_states(uuid[])', 'public.pbx_get_order_call_state_availability()',
    'public.pbx_list_agents(uuid)', 'public.pbx_save_agent(jsonb)', 'public.pbx_remove_agent(uuid)', 'public.pbx_list_ring_groups(uuid)',
    'public.pbx_save_ring_group(jsonb)', 'public.pbx_set_business_settings(jsonb)', 'public.pbx_billing_history(uuid, int)',
    'public.pbx_reports(date, date, uuid)', 'public.pbx_bkash_start(jsonb)', 'public.pbx_admin_list_businesses()',
    'public.pbx_admin_save_business(jsonb)', 'public.pbx_provision_business_did(jsonb)', 'public.pbx_set_pbx_bridge_ready(uuid, boolean)',
    'public.pbx_admin_set_member(uuid, uuid)', 'public.pbx_admin_grant_package(jsonb)', 'public.pbx_admin_adjust_balance(uuid, numeric, text)',
    'public.pbx_admin_save_settings(jsonb)', 'public.pbx_batch(jsonb)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Gateway read access (Asterisk realtime). A NOLOGIN role is created here;
-- the Super Admin gives it a password in the SQL editor when deploying:
--   alter role pbx_gateway with login password '…';
-- It can read only these views: SIP usernames and password digests of
-- softphones whose credential has not expired.
-- ---------------------------------------------------------------------------
create schema if not exists pbx_gw;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'pbx_gateway') then
    create role pbx_gateway nologin;
  end if;
end;
$$;

create or replace view pbx_gw.ps_endpoints as
select a.sip_username as id,
  'transport-wss'::text as transport,
  a.sip_username as aors,
  a.sip_username as auth,
  'vd-agents'::text as context,
  'all'::text as disallow,
  -- G.711 first: IPTSP trunks carry G.711, so most calls need no transcoding.
  'alaw,ulaw,opus'::text as allow,
  'yes'::text as webrtc,
  'yes'::text as dtls_auto_generate_cert,
  format('"%s" <%s>', replace(coalesce(p.full_name, a.extension), '"', ''), a.extension) as callerid,
  'no'::text as send_pai,
  'yes'::text as rtp_symmetric,
  'yes'::text as force_rport,
  'yes'::text as rewrite_contact,
  'no'::text as allow_subscribe
from public.pbx_agents a
join public.pbx_sip_credentials c on c.agent_id = a.id and c.expires_at > now()
join public.pbx_businesses b on b.id = a.business_id
left join public.profiles p on p.id = a.profile_id
where a.active and b.pbx_enabled;

create or replace view pbx_gw.ps_auths as
select a.sip_username as id,
  'digest'::text as auth_type,
  a.sip_username as username,
  'voicedrive'::text as realm,
  'MD5:' || c.password_digest as password_digest
from public.pbx_agents a
join public.pbx_sip_credentials c on c.agent_id = a.id and c.expires_at > now()
where a.active;

create or replace view pbx_gw.ps_aors as
select a.sip_username as id,
  1 as max_contacts,
  'yes'::text as remove_existing,
  120 as default_expiration,
  60 as minimum_expiration,
  600 as maximum_expiration,
  0 as qualify_frequency
from public.pbx_agents a
join public.pbx_sip_credentials c on c.agent_id = a.id and c.expires_at > now()
where a.active;

revoke all on schema pbx_gw from public;
grant usage on schema pbx_gw to pbx_gateway;
-- Asterisk queries unqualified table names.
alter role pbx_gateway set search_path = pbx_gw;
grant select on pbx_gw.ps_endpoints, pbx_gw.ps_auths, pbx_gw.ps_aors to pbx_gateway;
revoke all on pbx_gw.ps_endpoints, pbx_gw.ps_auths, pbx_gw.ps_aors from anon, authenticated;
