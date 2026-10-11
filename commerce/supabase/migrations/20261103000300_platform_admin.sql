-- =============================================================================
-- Super Admin core: platform roles and permissions, second-person approvals,
-- merchant directory and onboarding, audit log, global search and overview.
--
-- Every function here is owned by postgres (it has to see all merchants) and
-- checks the caller itself: active platform staff, a role that grants the
-- module action, and — for staff limited to assigned merchants — that the
-- merchant is one of theirs. Merchant staff can call none of it.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Modules, actions and roles
-- -----------------------------------------------------------------------------
create table public.platform_modules (
  code text primary key,
  name text not null,
  sort_order int not null,
  actions text[] not null
);
insert into public.platform_modules (code, name, sort_order, actions) values
  ('overview', 'Overview', 1, '{view}'),
  ('merchants', 'Merchants', 2, '{view,create,edit,manage,export,approve}'),
  ('employees', 'Employees & Roles', 3, '{view,create,edit,delete,manage,approve}'),
  ('subscriptions', 'Subscriptions & Plans', 4, '{view,create,edit,delete,manage,export,approve}'),
  ('credits', 'Credits & Wallets', 5, '{view,create,manage,export,approve}'),
  ('sms', 'SMS Management', 6, '{view,edit,manage,export}'),
  ('bd_courier', 'BD Courier Integration', 7, '{view,edit,manage,export}'),
  ('integrations', 'Other Integrations', 8, '{view,edit,manage}'),
  ('features', 'Features & Access', 9, '{view,edit,manage,approve}'),
  ('support', 'Support & Issues', 10, '{view,create,edit,manage,approve}'),
  ('pbx', 'PBX Setup', 11, '{view,edit,manage}'),
  ('usage', 'Usage & Analytics', 12, '{view,export}'),
  ('automation', 'Automation Rules', 13, '{view,create,edit,delete,manage}'),
  ('health', 'System Health', 14, '{view,manage}'),
  ('incidents', 'Incident Management', 15, '{view,create,edit,manage}'),
  ('notifications', 'Notifications', 16, '{view,create,manage}'),
  ('audit', 'Audit Logs', 17, '{view,export}'),
  ('security', 'Security Center', 18, '{view,manage}'),
  ('data', 'Data Management', 19, '{view,export,manage,approve}'),
  ('settings', 'Global Settings', 20, '{view,edit,manage}');

create table public.platform_roles (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  name text not null check (length(trim(name)) between 2 and 60),
  description text,
  is_system boolean not null default false,
  -- Super Admin: every permission, always. Only Super Admins grant privileged access.
  is_super boolean not null default false,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger platform_roles_updated_at before update on public.platform_roles
  for each row execute function public.set_updated_at();

create table public.platform_role_permissions (
  role_id uuid not null references public.platform_roles(id) on delete cascade,
  module text not null references public.platform_modules(code),
  action text not null check (action in ('view', 'create', 'edit', 'delete', 'manage', 'export', 'approve')),
  primary key (role_id, module, action)
);

insert into public.platform_roles (code, name, description, is_system, is_super) values
  ('SUPER_ADMIN', 'Super Admin', 'Full control of the platform. Grants privileged access.', true, true),
  ('OPERATIONS_MANAGER', 'Operations Manager', 'Runs merchants, onboarding, integrations and day-to-day operations.', true, false),
  ('SUPPORT_AGENT', 'Support Agent', 'Answers merchants and opens time-limited support views.', true, false),
  ('BILLING_MANAGER', 'Billing Manager', 'Plans, subscriptions, credits and payments.', true, false),
  ('TECHNICAL_SUPPORT', 'Technical Support', 'Integrations, system health and incidents.', true, false),
  ('PBX_ADMIN', 'PBX Administrator', 'PBX setup and configuration.', true, false),
  ('VIEWER', 'Read-only Viewer', 'Sees everything they are allowed to, changes nothing.', true, false);

do $$
declare
  v_grants jsonb := $g${
    "OPERATIONS_MANAGER": {"*": ["view"], "merchants": ["create","edit","manage","export"], "subscriptions": ["edit","manage"],
      "credits": ["manage"], "sms": ["edit"], "bd_courier": ["edit"], "integrations": ["edit","manage"], "features": ["edit","manage"],
      "support": ["create","edit","manage"], "pbx": ["edit"], "usage": ["export"], "automation": ["create","edit"], "health": ["manage"],
      "incidents": ["create","edit","manage"], "notifications": ["create","manage"]},
    "SUPPORT_AGENT": {"overview": ["view"], "merchants": ["view"], "support": ["view","create","edit","manage"], "integrations": ["view"],
      "health": ["view"], "incidents": ["view","create"], "usage": ["view"], "features": ["view"], "notifications": ["view"]},
    "BILLING_MANAGER": {"overview": ["view"], "merchants": ["view","export"], "subscriptions": ["view","create","edit","manage","export"],
      "credits": ["view","create","manage","export"], "sms": ["view"], "usage": ["view","export"], "audit": ["view"], "notifications": ["view","create"]},
    "TECHNICAL_SUPPORT": {"overview": ["view"], "merchants": ["view"], "integrations": ["view","edit","manage"], "bd_courier": ["view"],
      "sms": ["view"], "health": ["view","manage"], "incidents": ["view","create","edit","manage"], "support": ["view","edit"],
      "automation": ["view"], "usage": ["view"], "features": ["view"], "pbx": ["view"], "audit": ["view"]},
    "PBX_ADMIN": {"overview": ["view"], "merchants": ["view"], "pbx": ["view","edit","manage"], "integrations": ["view"], "health": ["view"]},
    "VIEWER": {"*": ["view"]}
  }$g$;
  r record;
  m record;
  a text;
begin
  for r in select pr.id, pr.code from public.platform_roles pr where not pr.is_super loop
    for m in select pm.code, pm.actions from public.platform_modules pm loop
      for a in select jsonb_array_elements_text(coalesce(v_grants -> r.code -> m.code, '[]'::jsonb) || coalesce(v_grants -> r.code -> '*', '[]'::jsonb)) loop
        if a = any (m.actions) then
          insert into public.platform_role_permissions (role_id, module, action) values (r.id, m.code, a) on conflict do nothing;
        end if;
      end loop;
    end loop;
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- 2. Platform staff: role and which merchants they may work on
-- -----------------------------------------------------------------------------
alter table public.platform_staff
  add column role_id uuid references public.platform_roles(id),
  add column merchant_scope text not null default 'ALL' check (merchant_scope in ('ALL', 'ASSIGNED')),
  add column title text,
  add column phone text,
  add column last_seen_at timestamptz;

create table public.platform_staff_merchants (
  user_id uuid not null references public.platform_staff(user_id) on delete cascade,
  merchant_id uuid not null references public.merchants(id),
  assigned_by uuid,
  assigned_at timestamptz not null default now(),
  primary key (user_id, merchant_id)
);
create index platform_staff_merchants_merchant_idx on public.platform_staff_merchants (merchant_id);

-- The people who ran the single-merchant app (its active owners) run the platform.
insert into public.platform_staff (user_id, email, full_name, role_id)
select p.id, p.email, p.full_name, (select id from public.platform_roles where code = 'SUPER_ADMIN')
from public.profiles p join public.roles r on r.id = p.role_id
where p.merchant_id = '00000000-0000-4000-8000-000000000001' and r.code = 'OWNER' and p.is_active
  and not exists (select 1 from public.platform_staff)
on conflict (user_id) do nothing;
update public.platform_staff set role_id = (select id from public.platform_roles where code = 'VIEWER') where role_id is null;
alter table public.platform_staff alter column role_id set not null;

-- -----------------------------------------------------------------------------
-- 3. Merchant profile, onboarding and internal notes
-- -----------------------------------------------------------------------------
alter table public.merchants
  add column account_manager_id uuid references public.platform_staff(user_id),
  add column business_type text,
  add column website text,
  add column address text,
  add column timezone text not null default 'Asia/Dhaka',
  add column onboarding jsonb not null default '{}'::jsonb,
  add column onboarded_at timestamptz,
  add column status_changed_at timestamptz,
  add column status_changed_by uuid;
update public.merchants set onboarded_at = created_at where number = 1;

create table public.merchant_notes (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id),
  author_id uuid not null,
  author_email text,
  body text not null check (length(trim(body)) between 1 and 4000),
  pinned boolean not null default false,
  created_at timestamptz not null default now()
);
create index merchant_notes_merchant_idx on public.merchant_notes (merchant_id, created_at desc);

-- -----------------------------------------------------------------------------
-- 4. Second-person approvals
-- -----------------------------------------------------------------------------
create table public.platform_approvals (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  module text not null references public.platform_modules(code),
  merchant_id uuid references public.merchants(id),
  summary text not null,
  payload jsonb not null default '{}'::jsonb,
  reason text not null check (length(trim(reason)) between 5 and 1000),
  status text not null default 'PENDING' check (status in ('PENDING', 'EXECUTED', 'REJECTED', 'FAILED', 'CANCELLED', 'EXPIRED')),
  requested_by uuid not null,
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '72 hours',
  decided_by uuid,
  decided_at timestamptz,
  decision_note text,
  result jsonb,
  error text,
  check (decided_by is null or decided_by <> requested_by)
);
create index platform_approvals_open_idx on public.platform_approvals (status, requested_at desc);

-- -----------------------------------------------------------------------------
-- 5. Audit log: result and request id
-- -----------------------------------------------------------------------------
alter table public.platform_audit_logs
  add column result text not null default 'SUCCESS' check (result in ('SUCCESS', 'FAILED', 'DENIED', 'REQUESTED')),
  add column request_id text;

-- Lock down every new platform table: functions only.
alter table public.platform_modules enable row level security;
alter table public.platform_roles enable row level security;
alter table public.platform_role_permissions enable row level security;
alter table public.platform_staff_merchants enable row level security;
alter table public.merchant_notes enable row level security;
alter table public.platform_approvals enable row level security;
revoke all on public.platform_modules, public.platform_roles, public.platform_role_permissions, public.platform_staff_merchants,
  public.merchant_notes, public.platform_approvals from anon, authenticated;

create or replace function public._tenancy_global_tables()
returns text[]
language sql
immutable
as $$
  select array['permissions', 'order_status_transitions', 'pbx_packages', 'pbx_gateway_status',
               'merchants', 'platform_staff', 'support_sessions', 'tenancy_exempt_functions',
               'platform_settings', 'platform_audit_logs', 'platform_credentials',
               'platform_modules', 'platform_roles', 'platform_role_permissions', 'platform_staff_merchants',
               'merchant_notes', 'platform_approvals']
$$;

-- -----------------------------------------------------------------------------
-- 6. Who may do what
-- -----------------------------------------------------------------------------
-- Is the signed-in platform staff member allowed this module action (and, when
-- given, on this merchant)? Super Admins always are.
create or replace function public.platform_can(p_module text, p_action text, p_merchant uuid default null)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.platform_staff s
    join public.platform_roles r on r.id = s.role_id
    where s.user_id = auth.uid()
      and s.is_active
      and coalesce(auth.jwt() ->> 'role', '') = 'authenticated'
      and (r.is_super or exists (select 1 from public.platform_role_permissions rp
                                 where rp.role_id = r.id and rp.module = p_module and rp.action = p_action))
      and (p_merchant is null or r.is_super or s.merchant_scope = 'ALL'
           or exists (select 1 from public.platform_staff_merchants sm where sm.user_id = s.user_id and sm.merchant_id = p_merchant))
  )
$$;

create or replace function public._platform_require(p_module text, p_action text, p_merchant uuid default null)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.platform_can(p_module, p_action, p_merchant) then
    raise exception 'PERMISSION_DENIED: % % is not allowed%', p_module, p_action,
      case when p_merchant is null then '' else ' for this merchant' end using errcode = '42501';
  end if;
end;
$$;

-- Merchants the caller may see: all, or only the ones assigned to them.
create or replace function public._platform_merchant_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.id from public.merchants m
  where exists (
    select 1 from public.platform_staff s join public.platform_roles r on r.id = s.role_id
    where s.user_id = auth.uid() and s.is_active
      and (r.is_super or s.merchant_scope = 'ALL'
           or exists (select 1 from public.platform_staff_merchants sm where sm.user_id = s.user_id and sm.merchant_id = m.id)))
$$;

create or replace function public._platform_is_super()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.platform_staff s join public.platform_roles r on r.id = s.role_id
                 where s.user_id = auth.uid() and s.is_active and r.is_super
                   and coalesce(auth.jwt() ->> 'role', '') = 'authenticated')
$$;

-- Audit entry for the action just done (or refused). Never skipped.
create or replace function public._platform_log(
  p_action text, p_merchant uuid, p_entity_type text, p_entity_id text, p_reason text,
  p_before jsonb, p_after jsonb, p_result text default 'SUCCESS', p_metadata jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.platform_audit_logs (actor_id, actor_email, action, merchant_id, entity_type, entity_id, reason, before, after, metadata, result, request_id)
  values (auth.uid(), (select email from public.platform_staff where user_id = auth.uid()), p_action, p_merchant, p_entity_type, p_entity_id,
          p_reason, p_before, p_after, coalesce(p_metadata, '{}'::jsonb), p_result,
          nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-request-id');
end;
$$;

-- A refused action is rolled back together with anything it wrote, so the
-- panel reports refusals here afterwards. Who was refused is taken from the
-- sign-in; what they tried is as reported by the panel.
create or replace function public.platform_report_denied(p_action text, p_detail jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_platform_staff() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  -- At most one report per person and action a minute.
  if exists (select 1 from public.platform_audit_logs where actor_id = auth.uid() and action = left(p_action, 80) and result = 'DENIED'
             and created_at > now() - interval '1 minute') then
    return;
  end if;
  perform public._platform_log(left(coalesce(p_action, 'unknown'), 80), null, null, null, null, null, null, 'DENIED',
    jsonb_build_object('reported_by_panel', true, 'detail', left(coalesce(p_detail, '{}'::jsonb)::text, 2000)));
end;
$$;

-- What the signed-in person can see in the Super Admin panel (null: not platform staff).
create or replace function public.platform_me()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s public.platform_staff;
  r public.platform_roles;
begin
  select * into s from public.platform_staff where user_id = auth.uid() and is_active;
  if s.user_id is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' then
    return null;
  end if;
  select * into r from public.platform_roles where id = s.role_id;
  update public.platform_staff set last_seen_at = now() where user_id = s.user_id and (last_seen_at is null or last_seen_at < now() - interval '5 minutes');
  return jsonb_build_object(
    'user_id', s.user_id, 'email', s.email, 'full_name', s.full_name, 'title', s.title,
    'role', jsonb_build_object('id', r.id, 'code', r.code, 'name', r.name, 'is_super', r.is_super),
    'merchant_scope', case when r.is_super then 'ALL' else s.merchant_scope end,
    'merchant_ids', case when r.is_super or s.merchant_scope = 'ALL' then null
      else (select coalesce(jsonb_agg(merchant_id), '[]'::jsonb) from public.platform_staff_merchants where user_id = s.user_id) end,
    'permissions', case when r.is_super
      then (select jsonb_agg(m.code || '.' || a order by m.sort_order, a) from public.platform_modules m, unnest(m.actions) a)
      else (select coalesce(jsonb_agg(rp.module || '.' || rp.action order by rp.module, rp.action), '[]'::jsonb)
            from public.platform_role_permissions rp where rp.role_id = r.id) end,
    'modules', (select jsonb_agg(jsonb_build_object('code', code, 'name', name, 'actions', actions) order by sort_order) from public.platform_modules),
    'merchant_staff', exists (select 1 from public.profiles p where p.id = s.user_id and p.is_active),
    'pending_approvals', (select count(*) from public.platform_approvals a where a.status = 'PENDING' and a.expires_at > now()
                          and a.requested_by <> s.user_id and public.platform_can(a.module, 'approve', a.merchant_id))
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. Employees and roles
-- -----------------------------------------------------------------------------
create or replace function public.platform_staff_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._platform_require('employees', 'view');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'user_id', s.user_id, 'email', s.email, 'full_name', s.full_name, 'title', s.title, 'phone', s.phone,
      'is_active', s.is_active, 'last_seen_at', s.last_seen_at, 'created_at', s.created_at,
      'role', jsonb_build_object('id', r.id, 'code', r.code, 'name', r.name, 'is_super', r.is_super),
      'merchant_scope', s.merchant_scope,
      'merchants', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name) order by m.number), '[]'::jsonb)
                    from public.platform_staff_merchants sm join public.merchants m on m.id = sm.merchant_id where sm.user_id = s.user_id),
      'managed_merchants', (select count(*) from public.merchants m where m.account_manager_id = s.user_id))
      order by s.is_active desc, s.full_name, s.email)
    from public.platform_staff s join public.platform_roles r on r.id = s.role_id), '[]'::jsonb);
end;
$$;

create or replace function public.platform_roles_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._platform_require('employees', 'view');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id, 'code', r.code, 'name', r.name, 'description', r.description, 'is_system', r.is_system, 'is_super', r.is_super,
      'staff', (select count(*) from public.platform_staff s where s.role_id = r.id),
      'permissions', case when r.is_super then '["*"]'::jsonb
        else (select coalesce(jsonb_agg(rp.module || '.' || rp.action order by rp.module, rp.action), '[]'::jsonb)
              from public.platform_role_permissions rp where rp.role_id = r.id) end)
      order by r.is_super desc, r.is_system desc, r.name)
    from public.platform_roles r), '[]'::jsonb);
end;
$$;

-- Create or change a role. Only Super Admins shape what roles may do.
create or replace function public.platform_role_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.platform_roles;
  v_before jsonb;
  v_perm text;
  v_module text;
  v_action text;
begin
  if not public._platform_is_super() then
    raise exception 'PERMISSION_DENIED: only a Super Admin can change roles' using errcode = '42501';
  end if;
  if nullif(p ->> 'id', '') is not null then
    select * into v_role from public.platform_roles where id = (p ->> 'id')::uuid for update;
    if v_role.id is null then
      raise exception 'NOT_FOUND: role not found' using errcode = 'P0002';
    end if;
    if v_role.is_super then
      raise exception 'VALIDATION: the Super Admin role always has every permission' using errcode = '22023';
    end if;
    v_before := jsonb_build_object('name', v_role.name, 'permissions',
      (select coalesce(jsonb_agg(module || '.' || action order by module, action), '[]'::jsonb) from public.platform_role_permissions where role_id = v_role.id));
    update public.platform_roles set name = coalesce(nullif(trim(p ->> 'name'), ''), name), description = coalesce(p ->> 'description', description)
    where id = v_role.id returning * into v_role;
  else
    insert into public.platform_roles (code, name, description, created_by)
    values (upper(regexp_replace(coalesce(nullif(p ->> 'code', ''), p ->> 'name'), '[^A-Za-z0-9]+', '_', 'g')), trim(p ->> 'name'), p ->> 'description', auth.uid())
    returning * into v_role;
  end if;
  if p ? 'permissions' then
    delete from public.platform_role_permissions where role_id = v_role.id;
    for v_perm in select jsonb_array_elements_text(p -> 'permissions') loop
      v_module := split_part(v_perm, '.', 1);
      v_action := split_part(v_perm, '.', 2);
      if not exists (select 1 from public.platform_modules where code = v_module and v_action = any (actions)) then
        raise exception 'VALIDATION: unknown permission %', v_perm using errcode = '22023';
      end if;
      insert into public.platform_role_permissions (role_id, module, action) values (v_role.id, v_module, v_action);
    end loop;
  end if;
  perform public._platform_log('employees.role_save', null, 'platform_role', v_role.id::text, null, v_before,
    jsonb_build_object('name', v_role.name, 'permissions', p -> 'permissions'));
  return to_jsonb(v_role);
end;
$$;

create or replace function public.platform_role_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.platform_roles;
begin
  if not public._platform_is_super() then
    raise exception 'PERMISSION_DENIED: only a Super Admin can change roles' using errcode = '42501';
  end if;
  select * into v_role from public.platform_roles where id = p_id for update;
  if v_role.id is null then
    raise exception 'NOT_FOUND: role not found' using errcode = 'P0002';
  end if;
  if v_role.is_system then
    raise exception 'VALIDATION: built-in roles cannot be removed' using errcode = '22023';
  end if;
  if exists (select 1 from public.platform_staff where role_id = p_id) then
    raise exception 'VALIDATION: move the people in this role to another role first' using errcode = '22023';
  end if;
  delete from public.platform_roles where id = p_id;
  perform public._platform_log('employees.role_delete', null, 'platform_role', p_id::text, null, to_jsonb(v_role), null);
end;
$$;

-- Adds or changes a platform employee (the account itself is created by the
-- platform-admin function). Giving someone the Super Admin role needs a
-- second Super Admin's approval, unless nobody else could give it.
create or replace function public.platform_staff_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := (p ->> 'user_id')::uuid;
  v_role public.platform_roles;
  v_old public.platform_staff;
  v_auth record;
  v_supers int;
  v_approval uuid;
begin
  select * into v_old from public.platform_staff where user_id = v_user;
  perform public._platform_require('employees', case when v_old.user_id is null then 'create' else 'edit' end);
  select * into v_role from public.platform_roles where id = coalesce((p ->> 'role_id')::uuid, v_old.role_id);
  if v_role.id is null then
    raise exception 'VALIDATION: choose a role' using errcode = '22023';
  end if;
  -- Roles decide access: only Super Admins hand them out or change them.
  if (v_old.user_id is null or v_old.role_id is distinct from v_role.id) and not public._platform_is_super() then
    raise exception 'PERMISSION_DENIED: only a Super Admin can assign roles' using errcode = '42501';
  end if;
  if v_user = auth.uid() and v_old.role_id is distinct from v_role.id then
    raise exception 'VALIDATION: you cannot change your own role' using errcode = '22023';
  end if;
  select * into v_auth from public._auth_user(v_user);
  if v_auth.id is null then
    raise exception 'NOT_FOUND: no account with this id' using errcode = 'P0002';
  end if;

  if v_role.is_super and (v_old.user_id is null or v_old.role_id is distinct from v_role.id) then
    select count(*) into v_supers from public.platform_staff s join public.platform_roles r on r.id = s.role_id
    where r.is_super and s.is_active and s.user_id <> auth.uid();
    if v_supers > 0 then
      v_approval := public.platform_request_approval('employees', 'grant_super_admin', null,
        format('Make %s a Super Admin', coalesce(nullif(p ->> 'full_name', ''), v_auth.email)),
        jsonb_build_object('user_id', v_user, 'role_id', v_role.id, 'full_name', p ->> 'full_name', 'title', p ->> 'title'),
        coalesce(nullif(trim(p ->> 'reason'), ''), 'Grant Super Admin access'));
      return jsonb_build_object('pending_approval', v_approval);
    end if;
  end if;

  insert into public.platform_staff (user_id, email, full_name, title, phone, role_id, merchant_scope, created_by)
  values (v_user, v_auth.email, coalesce(nullif(trim(p ->> 'full_name'), ''), v_auth.full_name, ''), p ->> 'title', p ->> 'phone',
          v_role.id, coalesce(p ->> 'merchant_scope', 'ALL'), auth.uid())
  on conflict (user_id) do update set
    full_name = coalesce(nullif(trim(excluded.full_name), ''), public.platform_staff.full_name),
    title = coalesce(p ->> 'title', public.platform_staff.title),
    phone = coalesce(p ->> 'phone', public.platform_staff.phone),
    role_id = excluded.role_id,
    merchant_scope = coalesce(p ->> 'merchant_scope', public.platform_staff.merchant_scope);
  if p ? 'merchant_ids' then
    perform public.platform_staff_assign(v_user, array(select (jsonb_array_elements_text(p -> 'merchant_ids'))::uuid));
  end if;
  perform public._platform_log('employees.save', null, 'platform_staff', v_user::text, p ->> 'reason',
    case when v_old.user_id is null then null else jsonb_build_object('role_id', v_old.role_id, 'merchant_scope', v_old.merchant_scope) end,
    jsonb_build_object('role', v_role.code, 'merchant_scope', coalesce(p ->> 'merchant_scope', v_old.merchant_scope, 'ALL')));
  return (select to_jsonb(s) from public.platform_staff s where s.user_id = v_user);
end;
$$;

create or replace function public.platform_staff_assign(p_user uuid, p_merchants uuid[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb;
begin
  perform public._platform_require('employees', 'manage');
  if not exists (select 1 from public.platform_staff where user_id = p_user) then
    raise exception 'NOT_FOUND: employee not found' using errcode = 'P0002';
  end if;
  select coalesce(jsonb_agg(merchant_id), '[]'::jsonb) into v_before from public.platform_staff_merchants where user_id = p_user;
  delete from public.platform_staff_merchants where user_id = p_user and merchant_id <> all (coalesce(p_merchants, '{}'));
  insert into public.platform_staff_merchants (user_id, merchant_id, assigned_by)
  select p_user, m, auth.uid() from unnest(coalesce(p_merchants, '{}')) m
  where exists (select 1 from public.merchants where id = m)
  on conflict do nothing;
  perform public._platform_log('employees.merchants_assigned', null, 'platform_staff', p_user::text, null, v_before, to_jsonb(p_merchants));
end;
$$;

create or replace function public.platform_staff_set_active(p_user uuid, p_active boolean, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_staff public.platform_staff;
  v_is_super boolean;
begin
  perform public._platform_require('employees', 'manage');
  if p_user = auth.uid() then
    raise exception 'VALIDATION: you cannot deactivate yourself' using errcode = '22023';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'VALIDATION: give a reason' using errcode = '22023';
  end if;
  select * into v_staff from public.platform_staff where user_id = p_user for update;
  if v_staff.user_id is null then
    raise exception 'NOT_FOUND: employee not found' using errcode = 'P0002';
  end if;
  select is_super into v_is_super from public.platform_roles where id = v_staff.role_id;
  if v_is_super and not public._platform_is_super() then
    raise exception 'PERMISSION_DENIED: only a Super Admin can change another Super Admin' using errcode = '42501';
  end if;
  if v_is_super and not p_active and (select count(*) from public.platform_staff s join public.platform_roles r on r.id = s.role_id
                                       where r.is_super and s.is_active and s.user_id <> p_user) = 0 then
    raise exception 'VALIDATION: the platform needs at least one active Super Admin' using errcode = '22023';
  end if;
  update public.platform_staff set is_active = p_active where user_id = p_user;
  -- Open support sessions end with the account.
  if not p_active then
    update public.support_sessions set ended_at = now(), ended_by = auth.uid(), end_reason = 'Employee deactivated'
    where staff_user_id = p_user and ended_at is null;
  end if;
  perform public._platform_log(case when p_active then 'employees.reactivated' else 'employees.deactivated' end, null, 'platform_staff',
    p_user::text, p_reason, jsonb_build_object('is_active', v_staff.is_active), jsonb_build_object('is_active', p_active));
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. Approvals
-- -----------------------------------------------------------------------------
create or replace function public.platform_request_approval(p_module text, p_action text, p_merchant uuid, p_summary text, p_payload jsonb, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if not public.is_platform_staff() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if coalesce(length(trim(p_reason)), 0) < 5 then
    raise exception 'VALIDATION: explain why (at least 5 characters)' using errcode = '22023';
  end if;
  -- The same request waiting already: no second copy.
  select id into v_id from public.platform_approvals
  where status = 'PENDING' and expires_at > now() and action = p_action and requested_by = auth.uid()
    and merchant_id is not distinct from p_merchant and payload = p_payload;
  if v_id is not null then
    return v_id;
  end if;
  insert into public.platform_approvals (action, module, merchant_id, summary, payload, reason, requested_by)
  values (p_action, p_module, p_merchant, p_summary, coalesce(p_payload, '{}'::jsonb), trim(p_reason), auth.uid())
  returning id into v_id;
  perform public._platform_log('approval.requested', p_merchant, 'platform_approval', v_id::text, p_reason, null,
    jsonb_build_object('action', p_action, 'summary', p_summary), 'REQUESTED');
  return v_id;
end;
$$;

create or replace function public.platform_approvals_list(p_status text default 'PENDING')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_platform_staff() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.platform_approvals set status = 'EXPIRED' where status = 'PENDING' and expires_at <= now();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', a.id, 'action', a.action, 'module', a.module, 'summary', a.summary, 'reason', a.reason, 'status', a.status,
      'merchant', (select jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name) from public.merchants m where m.id = a.merchant_id),
      'requested_by', (select jsonb_build_object('id', s.user_id, 'name', coalesce(nullif(s.full_name, ''), s.email)) from public.platform_staff s where s.user_id = a.requested_by),
      'decided_by', (select jsonb_build_object('id', s.user_id, 'name', coalesce(nullif(s.full_name, ''), s.email)) from public.platform_staff s where s.user_id = a.decided_by),
      'requested_at', a.requested_at, 'expires_at', a.expires_at, 'decided_at', a.decided_at, 'decision_note', a.decision_note,
      'error', a.error, 'mine', a.requested_by = auth.uid(),
      'can_decide', a.status = 'PENDING' and a.requested_by <> auth.uid() and public.platform_can(a.module, 'approve', a.merchant_id))
      order by a.requested_at desc)
    from public.platform_approvals a
    where (p_status is null or a.status = p_status)
      and (a.requested_by = auth.uid() or public.platform_can(a.module, 'view', a.merchant_id))
      and a.requested_at > now() - interval '90 days'), '[]'::jsonb);
end;
$$;

-- Carries out an approved request. Each action is listed here; nothing else runs.
create or replace function public._platform_execute_approval(a public.platform_approvals)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  case a.action
    when 'grant_super_admin' then
      insert into public.platform_staff (user_id, email, full_name, title, role_id, created_by)
      select u.id, u.email, coalesce(nullif(a.payload ->> 'full_name', ''), u.full_name), a.payload ->> 'title', (a.payload ->> 'role_id')::uuid, a.requested_by
      from public._auth_user((a.payload ->> 'user_id')::uuid) u
      on conflict (user_id) do update set role_id = excluded.role_id;
      return jsonb_build_object('user_id', a.payload ->> 'user_id');
    when 'merchant_close' then
      update public.merchants set status = 'CLOSED', status_reason = a.reason, status_changed_at = now(), status_changed_by = a.requested_by
      where id = a.merchant_id and status <> 'CLOSED';
      update public.support_sessions set ended_at = now(), end_reason = 'Merchant closed' where merchant_id = a.merchant_id and ended_at is null;
      return jsonb_build_object('merchant_id', a.merchant_id, 'status', 'CLOSED');
    else
      return public._platform_execute_approval_more(a);
  end case;
end;
$$;

-- Extension point for later modules (credits, data deletion, support assist).
create or replace function public._platform_execute_approval_more(a public.platform_approvals)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception 'VALIDATION: unknown approval action %', a.action using errcode = '22023';
end;
$$;

create or replace function public.platform_approval_decide(p_id uuid, p_approve boolean, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a public.platform_approvals;
  v_result jsonb;
begin
  select * into a from public.platform_approvals where id = p_id for update;
  if a.id is null then
    raise exception 'NOT_FOUND: request not found' using errcode = 'P0002';
  end if;
  if a.status <> 'PENDING' or a.expires_at <= now() then
    raise exception 'VALIDATION: this request is already %', lower(case when a.expires_at <= now() and a.status = 'PENDING' then 'EXPIRED' else a.status end) using errcode = '22023';
  end if;
  if a.requested_by = auth.uid() then
    -- The person asking can withdraw, never approve.
    if p_approve then
      raise exception 'PERMISSION_DENIED: a second person must approve this' using errcode = '42501';
    end if;
    update public.platform_approvals set status = 'CANCELLED', decided_at = now(), decision_note = p_note where id = a.id;
    perform public._platform_log('approval.cancelled', a.merchant_id, 'platform_approval', a.id::text, p_note, null, null);
    return jsonb_build_object('status', 'CANCELLED');
  end if;
  perform public._platform_require(a.module, 'approve', a.merchant_id);
  if not p_approve then
    update public.platform_approvals set status = 'REJECTED', decided_by = auth.uid(), decided_at = now(), decision_note = p_note where id = a.id;
    perform public._platform_log('approval.rejected', a.merchant_id, 'platform_approval', a.id::text, p_note, null, jsonb_build_object('action', a.action));
    return jsonb_build_object('status', 'REJECTED');
  end if;
  begin
    v_result := public._platform_execute_approval(a);
  exception when others then
    update public.platform_approvals set status = 'FAILED', decided_by = auth.uid(), decided_at = now(), decision_note = p_note, error = sqlerrm where id = a.id;
    perform public._platform_log('approval.failed', a.merchant_id, 'platform_approval', a.id::text, p_note, null,
      jsonb_build_object('action', a.action, 'error', sqlerrm), 'FAILED');
    return jsonb_build_object('status', 'FAILED', 'error', sqlerrm);
  end;
  update public.platform_approvals set status = 'EXECUTED', decided_by = auth.uid(), decided_at = now(), decision_note = p_note, result = v_result where id = a.id;
  perform public._platform_log('approval.executed', a.merchant_id, 'platform_approval', a.id::text, a.reason, null,
    jsonb_build_object('action', a.action, 'result', v_result));
  return jsonb_build_object('status', 'EXECUTED', 'result', v_result);
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. Merchants
-- -----------------------------------------------------------------------------
-- Onboarding checklist, from what actually exists for the merchant.
create or replace function public._merchant_onboarding(p_merchant uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with steps as (
    select jsonb_build_array(
      jsonb_build_object('key', 'profile', 'label', 'Business details', 'done',
        (select coalesce(nullif(trim(m.phone), ''), nullif(trim(m.owner_email), '')) is not null from public.merchants m where m.id = p_merchant)),
      jsonb_build_object('key', 'owner', 'label', 'Owner can sign in', 'done',
        exists (select 1 from public.profiles p join public.roles r on r.id = p.role_id where p.merchant_id = p_merchant and r.code = 'OWNER' and p.is_active)),
      jsonb_build_object('key', 'store', 'label', 'Store connected or own store live', 'done',
        exists (select 1 from public.sales_channels c where c.merchant_id = p_merchant and c.status = 'CONNECTED')
        or exists (select 1 from public.products p where p.merchant_id = p_merchant and p.status = 'ACTIVE')),
      jsonb_build_object('key', 'courier', 'label', 'Courier account connected', 'done',
        exists (select 1 from public.couriers c where c.merchant_id = p_merchant and c.api_enabled)),
      jsonb_build_object('key', 'first_order', 'label', 'First order received', 'done',
        exists (select 1 from public.orders o where o.merchant_id = p_merchant))
    ) as list
  )
  select jsonb_build_object('steps', list,
    'done', (select count(*) from jsonb_array_elements(list) e where (e ->> 'done')::boolean),
    'total', jsonb_array_length(list))
  from steps
$$;

create or replace function public.platform_merchants_list(
  p_filters jsonb default '{}'::jsonb, p_sort text default 'created_at', p_direction text default 'desc', p_limit int default 25, p_offset int default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_q text := nullif(trim(coalesce(p_filters ->> 'q', '')), '');
  v_status text := nullif(p_filters ->> 'status', '');
  v_manager uuid := nullif(p_filters ->> 'manager_id', '')::uuid;
  v_store text := nullif(p_filters ->> 'store', '');
  v_demo text := nullif(p_filters ->> 'demo', '');
  v_result jsonb;
begin
  perform public._platform_require('merchants', 'view');
  with base as (
    select m.*,
      (select count(*) from public.sales_channels c where c.merchant_id = m.id and c.status <> 'DISCONNECTED') as stores,
      (select string_agg(distinct c.platform, ',') from public.sales_channels c where c.merchant_id = m.id and c.status <> 'DISCONNECTED') as store_platforms,
      (select count(*) from public.orders o where o.merchant_id = m.id) as orders_total,
      (select count(*) from public.orders o where o.merchant_id = m.id and o.created_at > now() - interval '30 days') as orders_30d,
      (select max(o.created_at) from public.orders o where o.merchant_id = m.id) as last_order_at,
      (select count(*) from public.profiles p where p.merchant_id = m.id and p.is_active) as staff,
      (select coalesce(nullif(s.full_name, ''), s.email) from public.platform_staff s where s.user_id = m.account_manager_id) as manager_name
    from public.merchants m
    where m.id in (select public._platform_merchant_ids())
      and (v_status is null or m.status = v_status)
      and (v_manager is null or m.account_manager_id = v_manager)
      and (v_demo is null or m.is_demo = (v_demo = 'true'))
      and (v_q is null or m.name ilike '%' || v_q || '%' or m.slug ilike '%' || v_q || '%' or m.owner_email ilike '%' || v_q || '%'
           or m.phone ilike '%' || v_q || '%' or m.number::text = v_q)
  ), filtered as (
    select * from base
    where v_store is null or (v_store = 'none' and stores = 0) or (v_store <> 'none' and store_platforms ilike '%' || v_store || '%')
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'id', f.id, 'number', f.number, 'name', f.name, 'slug', f.slug, 'status', f.status, 'status_reason', f.status_reason,
        'is_demo', f.is_demo, 'owner_email', f.owner_email, 'phone', f.phone, 'created_at', f.created_at, 'onboarded_at', f.onboarded_at,
        'account_manager', case when f.account_manager_id is null then null else jsonb_build_object('id', f.account_manager_id, 'name', f.manager_name) end,
        'stores', f.stores, 'store_platforms', coalesce(string_to_array(f.store_platforms, ','), '{}'),
        'orders_total', f.orders_total, 'orders_30d', f.orders_30d, 'last_order_at', f.last_order_at, 'staff', f.staff,
        'onboarding', public._merchant_onboarding(f.id)))
      from (select * from filtered
            order by
              case when p_direction = 'asc' then case p_sort when 'name' then lower(name) when 'status' then status else null end end asc,
              case when p_direction <> 'asc' then case p_sort when 'name' then lower(name) when 'status' then status else null end end desc,
              case when p_direction = 'asc' then case p_sort when 'orders' then orders_30d when 'number' then number else null end end asc,
              case when p_direction <> 'asc' then case p_sort when 'orders' then orders_30d when 'number' then number else null end end desc,
              case when p_direction = 'asc' then case p_sort when 'last_order' then last_order_at when 'created_at' then created_at else null end end asc nulls first,
              case when p_direction <> 'asc' then case p_sort when 'last_order' then last_order_at when 'created_at' then created_at else null end end desc nulls last,
              number desc
            limit greatest(1, least(p_limit, 200)) offset greatest(0, p_offset)) f), '[]'::jsonb),
    'counts', (select jsonb_object_agg(status, n) from (select status, count(*) n from public.merchants
                where id in (select public._platform_merchant_ids()) group by status) c))
  into v_result;
  return v_result;
end;
$$;

create or replace function public.platform_merchant_get(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  m public.merchants;
begin
  perform public._platform_require('merchants', 'view', p_id);
  select * into m from public.merchants where id = p_id;
  if m.id is null then
    raise exception 'NOT_FOUND: merchant not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'merchant', to_jsonb(m),
    'account_manager', (select jsonb_build_object('id', s.user_id, 'name', coalesce(nullif(s.full_name, ''), s.email), 'email', s.email)
                        from public.platform_staff s where s.user_id = m.account_manager_id),
    'onboarding', public._merchant_onboarding(m.id),
    'staff', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'email', p.email, 'full_name', p.full_name, 'role', r.code,
                'is_active', p.is_active, 'last_seen_at', p.last_seen_at) order by r.rank desc, p.full_name), '[]'::jsonb)
              from public.profiles p join public.roles r on r.id = p.role_id where p.merchant_id = m.id),
    'stores', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'platform', c.platform, 'name', c.name, 'shop_domain', c.shop_domain,
                'status', c.status, 'last_sync_at', c.last_sync_at, 'last_error', nullif(c.last_error, ''), 'orders_imported', c.orders_imported)
                order by c.created_at), '[]'::jsonb)
               from public.sales_channels c where c.merchant_id = m.id),
    'couriers', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'provider', c.provider, 'api_enabled', c.api_enabled,
                  'api_status', c.api_status, 'is_active', c.is_active) order by c.name), '[]'::jsonb)
                 from public.couriers c where c.merchant_id = m.id),
    'activity', jsonb_build_object(
      'orders_total', (select count(*) from public.orders o where o.merchant_id = m.id),
      'orders_30d', (select count(*) from public.orders o where o.merchant_id = m.id and o.created_at > now() - interval '30 days'),
      'order_value_30d', (select coalesce(sum(o.total_amount), 0) from public.orders o
                          where o.merchant_id = m.id and o.created_at > now() - interval '30 days' and o.status not in ('CANCELLED', 'REJECTED_FRAUD')),
      'returns_30d', (select count(*) from public.orders o where o.merchant_id = m.id and o.status = 'RETURNED' and o.updated_at > now() - interval '30 days'),
      'last_order_at', (select max(o.created_at) from public.orders o where o.merchant_id = m.id),
      'products', (select count(*) from public.products p where p.merchant_id = m.id),
      'stock_units', (select coalesce(sum(i.on_hand), 0) from public.inventory i where i.merchant_id = m.id),
      'shipments_30d', (select count(*) from public.shipments s where s.merchant_id = m.id and s.created_at > now() - interval '30 days'),
      'sms_sent_30d', (select count(*) from public.notification_logs n where n.merchant_id = m.id and n.channel = 'SMS'
                       and n.status = 'SENT' and n.created_at > now() - interval '30 days'),
      'courier_checks_30d', (select count(*) from public.fraud_checks f where f.merchant_id = m.id and f.created_at > now() - interval '30 days'
                             and 'courier_history' = any (f.providers))),
    'errors', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'level', l.level, 'category', l.category, 'source', l.source,
                 'message', l.message, 'occurrences', l.occurrences, 'last_seen_at', l.last_seen_at) order by l.last_seen_at desc), '[]'::jsonb)
               from (select * from public.system_logs l where l.merchant_id = m.id and l.resolved_at is null and l.level in ('ERROR', 'WARN')
                     order by l.last_seen_at desc limit 15) l),
    'recent_activity', (select coalesce(jsonb_agg(jsonb_build_object('action', a.action, 'entity_type', a.entity_type, 'actor_email', a.actor_email,
                 'created_at', a.created_at) order by a.created_at desc), '[]'::jsonb)
               from (select * from public.audit_logs a where a.merchant_id = m.id order by a.created_at desc limit 20) a),
    'notes', (select coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'body', n.body, 'pinned', n.pinned, 'author', n.author_email,
                'created_at', n.created_at) order by n.pinned desc, n.created_at desc), '[]'::jsonb)
              from public.merchant_notes n where n.merchant_id = m.id),
    'platform_log', (select coalesce(jsonb_agg(jsonb_build_object('action', l.action, 'actor_email', l.actor_email, 'reason', l.reason,
                 'result', l.result, 'created_at', l.created_at) order by l.created_at desc), '[]'::jsonb)
               from (select * from public.platform_audit_logs l where l.merchant_id = m.id order by l.created_at desc limit 20) l),
    'can', jsonb_build_object('edit', public.platform_can('merchants', 'edit', m.id), 'manage', public.platform_can('merchants', 'manage', m.id)));
end;
$$;

-- Creates a merchant with the defaults every new business starts with. The
-- owner's login is created by the platform-admin function afterwards.
create or replace function public.platform_merchant_create(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_seeded jsonb;
  v_name text := trim(coalesce(p ->> 'name', ''));
  v_slug text := nullif(lower(trim(coalesce(p ->> 'slug', ''))), '');
begin
  perform public._platform_require('merchants', 'create');
  if length(v_name) < 2 then
    raise exception 'VALIDATION: enter the business name' using errcode = '22023';
  end if;
  if v_slug is not null and exists (select 1 from public.merchants where slug = v_slug) then
    raise exception 'DUPLICATE: that short name is taken' using errcode = '23505';
  end if;
  insert into public.merchants (name, slug, status, is_demo, owner_email, phone, business_type, website, address, notes, account_manager_id, created_by,
                                onboarding)
  values (v_name, v_slug, 'ONBOARDING', coalesce((p ->> 'is_demo')::boolean, false), lower(nullif(trim(p ->> 'owner_email'), '')),
          nullif(trim(p ->> 'phone'), ''), nullif(p ->> 'business_type', ''), nullif(p ->> 'website', ''), nullif(p ->> 'address', ''),
          nullif(p ->> 'notes', ''), coalesce(nullif(p ->> 'account_manager_id', '')::uuid, auth.uid()), auth.uid(),
          jsonb_build_object('started_at', now(), 'by', auth.uid()))
  returning id into v_id;
  -- Seed inside the new merchant only.
  perform set_config('app.merchant_id', v_id::text, true);
  v_seeded := public._merchant_seed_defaults(v_id);
  update public.settings set value = value || jsonb_build_object('name', v_name)
  where merchant_id = v_id and key = 'store';
  perform set_config('app.merchant_id', '', true);
  perform public._platform_log('merchant.created', v_id, 'merchant', v_id::text, p ->> 'reason', null,
    jsonb_build_object('name', v_name, 'is_demo', coalesce((p ->> 'is_demo')::boolean, false), 'seeded', v_seeded));
  return jsonb_build_object('id', v_id, 'seeded', v_seeded);
end;
$$;

-- Makes a login the merchant's owner (the login itself is created by the
-- platform-admin function). Whoever created the merchant may name its first
-- owner; changing an existing owner needs merchants.manage.
create or replace function public.platform_merchant_set_owner(p_merchant uuid, p_user uuid, p_full_name text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  m public.merchants;
  v_auth record;
  v_other uuid;
  v_role uuid;
  v_profile public.profiles;
begin
  select * into m from public.merchants where id = p_merchant for update;
  if m.id is null then
    raise exception 'NOT_FOUND: merchant not found' using errcode = 'P0002';
  end if;
  if not (public.platform_can('merchants', 'manage', m.id)
          or (public.platform_can('merchants', 'create') and m.created_by = auth.uid()
              and not exists (select 1 from public.profiles p join public.roles r on r.id = p.role_id
                              where p.merchant_id = m.id and r.code = 'OWNER'))) then
    raise exception 'PERMISSION_DENIED: merchants manage is not allowed for this merchant' using errcode = '42501';
  end if;
  if m.status = 'CLOSED' then
    raise exception 'VALIDATION: the merchant is closed' using errcode = '22023';
  end if;
  select * into v_auth from public._auth_user(p_user);
  if v_auth.id is null then
    raise exception 'NOT_FOUND: no account with this id' using errcode = 'P0002';
  end if;
  v_other := public._staff_merchant(p_user);
  if v_other is not null and v_other <> m.id then
    raise exception 'VALIDATION: this account already belongs to another business' using errcode = '22023';
  end if;
  select id into v_role from public.roles where merchant_id = m.id and code = 'OWNER';
  if v_role is null then
    raise exception 'VALIDATION: the merchant has no Owner role yet' using errcode = '22023';
  end if;
  perform set_config('app.merchant_id', m.id::text, true);
  insert into public.profiles (id, merchant_id, email, full_name, role_id, is_active)
  values (p_user, m.id, v_auth.email, coalesce(nullif(trim(p_full_name), ''), v_auth.full_name, ''), v_role, true)
  on conflict (id) do update set role_id = excluded.role_id, is_active = true
  returning * into v_profile;
  update public.merchants set owner_email = coalesce(owner_email, v_auth.email) where id = m.id;
  perform set_config('app.merchant_id', '', true);
  perform public._platform_log('merchant.owner_set', m.id, 'profile', p_user::text, null, null, jsonb_build_object('email', v_auth.email));
  return jsonb_build_object('user_id', v_profile.id, 'email', v_profile.email);
end;
$$;

create or replace function public.platform_merchant_update(p_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before public.merchants;
  v_after public.merchants;
begin
  perform public._platform_require('merchants', 'edit', p_id);
  select * into v_before from public.merchants where id = p_id for update;
  if v_before.id is null then
    raise exception 'NOT_FOUND: merchant not found' using errcode = 'P0002';
  end if;
  if p ? 'account_manager_id' then
    perform public._platform_require('merchants', 'manage', p_id);
    if nullif(p ->> 'account_manager_id', '') is not null
       and not exists (select 1 from public.platform_staff where user_id = (p ->> 'account_manager_id')::uuid and is_active) then
      raise exception 'VALIDATION: choose an active employee' using errcode = '22023';
    end if;
  end if;
  update public.merchants set
    name = coalesce(nullif(trim(p ->> 'name'), ''), name),
    slug = case when p ? 'slug' then nullif(lower(trim(p ->> 'slug')), '') else slug end,
    owner_email = case when p ? 'owner_email' then lower(nullif(trim(p ->> 'owner_email'), '')) else owner_email end,
    phone = case when p ? 'phone' then nullif(trim(p ->> 'phone'), '') else phone end,
    business_type = case when p ? 'business_type' then nullif(p ->> 'business_type', '') else business_type end,
    website = case when p ? 'website' then nullif(p ->> 'website', '') else website end,
    address = case when p ? 'address' then nullif(p ->> 'address', '') else address end,
    notes = case when p ? 'notes' then nullif(p ->> 'notes', '') else notes end,
    is_demo = coalesce((p ->> 'is_demo')::boolean, is_demo),
    account_manager_id = case when p ? 'account_manager_id' then nullif(p ->> 'account_manager_id', '')::uuid else account_manager_id end
  where id = p_id returning * into v_after;
  perform public._platform_log('merchant.updated', p_id, 'merchant', p_id::text, p ->> 'reason',
    to_jsonb(v_before) - 'onboarding', to_jsonb(v_after) - 'onboarding');
  return to_jsonb(v_after);
end;
$$;

-- Who a status change would touch, and a token proving the preview was seen.
create or replace function public.platform_merchant_status_preview(p_ids uuid[], p_status text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_items jsonb;
begin
  perform public._platform_require('merchants', 'manage');
  if p_status not in ('ACTIVE', 'SUSPENDED', 'CLOSED') then
    raise exception 'VALIDATION: unknown status' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name, 'status', m.status,
      'changes', m.status <> p_status,
      'allowed', public.platform_can('merchants', 'manage', m.id),
      'open_orders', (select count(*) from public.orders o where o.merchant_id = m.id
                      and o.status not in ('DELIVERED', 'CANCELLED', 'RETURNED', 'REJECTED_FRAUD')),
      'stores', (select count(*) from public.sales_channels c where c.merchant_id = m.id and c.status = 'CONNECTED'),
      'staff', (select count(*) from public.profiles p where p.merchant_id = m.id and p.is_active)) order by m.number), '[]'::jsonb)
  into v_items
  from public.merchants m where m.id = any (p_ids);
  return jsonb_build_object('status', p_status, 'items', v_items,
    'token', md5(p_status || ':' || array_to_string(array(select unnest(p_ids)::text order by 1), ',')),
    'needs_approval', p_status = 'CLOSED');
end;
$$;

-- Activate, suspend or reactivate merchants after the preview. Closing an
-- account needs a second person's approval.
create or replace function public.platform_merchant_set_status(p_ids uuid[], p_status text, p_reason text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  m public.merchants;
  v_changed int := 0;
  v_requests jsonb := '[]'::jsonb;
begin
  perform public._platform_require('merchants', 'manage');
  if coalesce(length(trim(p_reason)), 0) < 5 then
    raise exception 'VALIDATION: give a reason (at least 5 characters)' using errcode = '22023';
  end if;
  if p_token is distinct from md5(p_status || ':' || array_to_string(array(select unnest(p_ids)::text order by 1), ',')) then
    raise exception 'VALIDATION: review the list of merchants first' using errcode = '22023';
  end if;
  for m in select * from public.merchants where id = any (p_ids) order by number for update loop
    perform public._platform_require('merchants', 'manage', m.id);
    continue when m.status = p_status;
    if p_status = 'CLOSED' then
      v_requests := v_requests || to_jsonb(public.platform_request_approval('merchants', 'merchant_close', m.id,
        format('Close merchant #%s %s', m.number, m.name), jsonb_build_object('merchant_id', m.id), p_reason));
      continue;
    end if;
    if m.status = 'CLOSED' then
      raise exception 'VALIDATION: % is closed; closed accounts are not reopened from here', m.name using errcode = '22023';
    end if;
    update public.merchants set status = p_status, status_reason = trim(p_reason), status_changed_at = now(), status_changed_by = auth.uid()
    where id = m.id;
    if p_status = 'ACTIVE' and m.onboarded_at is null then
      update public.merchants set onboarded_at = now() where id = m.id;
    end if;
    v_changed := v_changed + 1;
    perform public._platform_log('merchant.status_changed', m.id, 'merchant', m.id::text, p_reason,
      jsonb_build_object('status', m.status), jsonb_build_object('status', p_status),
      'SUCCESS', jsonb_build_object('bulk', cardinality(p_ids) > 1));
  end loop;
  return jsonb_build_object('changed', v_changed, 'approval_requests', v_requests);
end;
$$;

create or replace function public.platform_merchant_note_add(p_merchant uuid, p_body text, p_pinned boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_note public.merchant_notes;
begin
  perform public._platform_require('merchants', 'edit', p_merchant);
  insert into public.merchant_notes (merchant_id, author_id, author_email, body, pinned)
  values (p_merchant, auth.uid(), (select email from public.platform_staff where user_id = auth.uid()), trim(p_body), coalesce(p_pinned, false))
  returning * into v_note;
  perform public._platform_log('merchant.note_added', p_merchant, 'merchant_note', v_note.id::text, null, null, null);
  return to_jsonb(v_note);
end;
$$;

-- -----------------------------------------------------------------------------
-- 10. Audit log and global search
-- -----------------------------------------------------------------------------
create or replace function public.platform_audit_list(p_filters jsonb default '{}'::jsonb, p_limit int default 50, p_offset int default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_merchant uuid := nullif(p_filters ->> 'merchant_id', '')::uuid;
  v_actor uuid := nullif(p_filters ->> 'actor_id', '')::uuid;
  v_action text := nullif(p_filters ->> 'action', '');
  v_result text := nullif(p_filters ->> 'result', '');
  v_from timestamptz := nullif(p_filters ->> 'from', '')::timestamptz;
  v_to timestamptz := nullif(p_filters ->> 'to', '')::timestamptz;
  v_q text := nullif(trim(coalesce(p_filters ->> 'q', '')), '');
begin
  perform public._platform_require('audit', 'view', v_merchant);
  return (
    with rows as (
      select l.* from public.platform_audit_logs l
      where (v_merchant is null or l.merchant_id = v_merchant)
        and (l.merchant_id is null or l.merchant_id in (select public._platform_merchant_ids()))
        and (v_actor is null or l.actor_id = v_actor)
        and (v_action is null or l.action like v_action || '%')
        and (v_result is null or l.result = v_result)
        and (v_from is null or l.created_at >= v_from)
        and (v_to is null or l.created_at < v_to)
        and (v_q is null or l.action ilike '%' || v_q || '%' or l.entity_id ilike '%' || v_q || '%' or l.reason ilike '%' || v_q || '%'
             or l.actor_email ilike '%' || v_q || '%')
    )
    select jsonb_build_object(
      'total', (select count(*) from rows),
      'items', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'action', r.action, 'result', r.result, 'actor_email', r.actor_email,
          'actor_id', r.actor_id, 'merchant', (select jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name) from public.merchants m where m.id = r.merchant_id),
          'entity_type', r.entity_type, 'entity_id', r.entity_id, 'reason', r.reason, 'before', r.before, 'after', r.after,
          'metadata', r.metadata, 'request_id', r.request_id, 'created_at', r.created_at) order by r.created_at desc, r.id desc)
        from (select * from rows order by created_at desc, id desc limit greatest(1, least(p_limit, 500)) offset greatest(0, p_offset)) r), '[]'::jsonb))
  );
end;
$$;

create or replace function public.platform_search(p_q text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_q text := trim(coalesce(p_q, ''));
  v_like text;
begin
  if not public.is_platform_staff() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if length(v_q) < 2 then
    return jsonb_build_object('merchants', '[]'::jsonb, 'employees', '[]'::jsonb, 'stores', '[]'::jsonb, 'orders', '[]'::jsonb,
                              'errors', '[]'::jsonb, 'audit', '[]'::jsonb, 'tickets', '[]'::jsonb);
  end if;
  v_like := '%' || replace(replace(v_q, '%', ''), '_', '') || '%';
  return jsonb_build_object(
    'merchants', case when public.platform_can('merchants', 'view') then coalesce((select jsonb_agg(jsonb_build_object(
        'id', m.id, 'number', m.number, 'name', m.name, 'status', m.status, 'owner_email', m.owner_email))
      from (select * from public.merchants m where m.id in (select public._platform_merchant_ids())
              and (m.name ilike v_like or m.owner_email ilike v_like or m.phone ilike v_like or m.slug ilike v_like or m.number::text = v_q)
            order by m.number limit 8) m), '[]'::jsonb) else '[]'::jsonb end,
    'employees', case when public.platform_can('employees', 'view') then coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.user_id, 'name', coalesce(nullif(s.full_name, ''), s.email), 'email', s.email, 'is_active', s.is_active))
      from (select * from public.platform_staff s where s.full_name ilike v_like or s.email ilike v_like limit 6) s), '[]'::jsonb) else '[]'::jsonb end,
    'stores', case when public.platform_can('merchants', 'view') then coalesce((select jsonb_agg(jsonb_build_object(
        'id', c.id, 'platform', c.platform, 'name', c.name, 'shop_domain', c.shop_domain, 'status', c.status, 'merchant_id', c.merchant_id,
        'merchant', (select m.name from public.merchants m where m.id = c.merchant_id)))
      from (select * from public.sales_channels c where c.merchant_id in (select public._platform_merchant_ids())
              and (c.shop_domain ilike v_like or c.name ilike v_like) limit 6) c), '[]'::jsonb) else '[]'::jsonb end,
    'orders', case when public.platform_can('merchants', 'view') then coalesce((select jsonb_agg(jsonb_build_object(
        'id', o.id, 'order_number', o.order_number, 'external_order_number', o.external_order_number, 'status', o.status,
        'merchant_id', o.merchant_id, 'merchant', (select m.name from public.merchants m where m.id = o.merchant_id), 'created_at', o.created_at))
      from (select * from public.orders o where o.merchant_id in (select public._platform_merchant_ids())
              and (o.order_number ilike v_q || '%' or o.external_order_number = v_q or o.external_order_id = v_q)
            order by o.created_at desc limit 8) o), '[]'::jsonb) else '[]'::jsonb end,
    'errors', case when public.platform_can('health', 'view') then coalesce((select jsonb_agg(jsonb_build_object(
        'id', l.id, 'level', l.level, 'category', l.category, 'message', l.message, 'merchant_id', l.merchant_id, 'last_seen_at', l.last_seen_at))
      from (select * from public.system_logs l where (l.merchant_id is null or l.merchant_id in (select public._platform_merchant_ids()))
              and l.message ilike v_like order by l.last_seen_at desc limit 6) l), '[]'::jsonb) else '[]'::jsonb end,
    'audit', case when public.platform_can('audit', 'view') then coalesce((select jsonb_agg(jsonb_build_object(
        'id', a.id, 'action', a.action, 'entity_id', a.entity_id, 'actor_email', a.actor_email, 'created_at', a.created_at))
      from (select * from public.platform_audit_logs a where (a.merchant_id is null or a.merchant_id in (select public._platform_merchant_ids()))
              and (a.action ilike v_like or a.entity_id ilike v_like or a.reason ilike v_like) order by a.created_at desc limit 6) a), '[]'::jsonb) else '[]'::jsonb end,
    'tickets', case when public.platform_can('support', 'view') then coalesce((select jsonb_agg(jsonb_build_object(
        'id', t.id, 'number', t.number, 'subject', t.subject, 'status', t.status, 'merchant_id', t.merchant_id,
        'merchant', (select m.name from public.merchants m where m.id = t.merchant_id)))
      from (select * from public.support_tickets t where t.merchant_id in (select public._platform_merchant_ids())
              and (t.subject ilike v_like or t.number::text = v_q) order by t.created_at desc limit 6) t), '[]'::jsonb) else '[]'::jsonb end
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 11. Overview (figures later modules add: subscriptions, credits, incidents)
-- -----------------------------------------------------------------------------
create or replace function public.platform_overview(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_from timestamptz := p_from::timestamptz;
  v_to timestamptz := (p_to + 1)::timestamptz;
begin
  perform public._platform_require('overview', 'view');
  return jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to),
    'merchants', jsonb_build_object(
      'total', (select count(*) from public.merchants where id in (select public._platform_merchant_ids()) and not is_demo),
      'demo', (select count(*) from public.merchants where id in (select public._platform_merchant_ids()) and is_demo),
      'by_status', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (select status, count(*) n from public.merchants
                    where id in (select public._platform_merchant_ids()) and not is_demo group by status) s),
      'new', (select count(*) from public.merchants where id in (select public._platform_merchant_ids()) and not is_demo
              and created_at >= v_from and created_at < v_to),
      'onboarded', (select count(*) from public.merchants where id in (select public._platform_merchant_ids()) and not is_demo
                    and onboarded_at >= v_from and onboarded_at < v_to),
      -- Placed no order in the last 30 days though they have before: worth a look, not a confirmed churn.
      'quiet_30d', (select count(*) from public.merchants m where m.id in (select public._platform_merchant_ids()) and not m.is_demo
                    and m.status = 'ACTIVE' and exists (select 1 from public.orders o where o.merchant_id = m.id)
                    and not exists (select 1 from public.orders o where o.merchant_id = m.id and o.created_at > now() - interval '30 days'))),
    'stores', (select coalesce(jsonb_object_agg(platform, jsonb_build_object('connected', connected, 'error', errored)), '{}'::jsonb)
               from (select platform, count(*) filter (where status = 'CONNECTED') connected, count(*) filter (where status = 'ERROR') errored
                     from public.sales_channels where merchant_id in (select public._platform_merchant_ids()) group by platform) s),
    'orders', (select jsonb_build_object('count', count(*), 'value', coalesce(sum(total_amount) filter (where status not in ('CANCELLED', 'REJECTED_FRAUD')), 0))
               from public.orders where merchant_id in (select public._platform_merchant_ids()) and created_at >= v_from and created_at < v_to),
    'sms', (select jsonb_build_object('sent', count(*) filter (where status = 'SENT'), 'failed', count(*) filter (where status = 'FAILED'),
                                      'queued', count(*) filter (where status = 'QUEUED'), 'segments', coalesce(sum(segments) filter (where status = 'SENT'), 0))
            from public.notification_logs where channel = 'SMS' and merchant_id in (select public._platform_merchant_ids())
              and created_at >= v_from and created_at < v_to),
    'courier', jsonb_build_object(
      'history_checks', (select count(*) from public.fraud_checks where merchant_id in (select public._platform_merchant_ids())
                         and 'courier_history' = any (providers) and created_at >= v_from and created_at < v_to),
      'accounts_connected', (select count(*) from public.couriers where merchant_id in (select public._platform_merchant_ids()) and api_enabled),
      'bookings', (select count(*) from public.shipments where merchant_id in (select public._platform_merchant_ids())
                   and created_at >= v_from and created_at < v_to and consignment_id is not null),
      'webhook_failures', (select count(*) from public.courier_webhook_events where merchant_id in (select public._platform_merchant_ids())
                           and result = 'FAILED' and received_at >= v_from and received_at < v_to)),
    'integrations', jsonb_build_object(
      'errors', (select count(*) from public.system_logs where level = 'ERROR' and last_seen_at >= v_from and last_seen_at < v_to
                 and (merchant_id is null or merchant_id in (select public._platform_merchant_ids()))),
      'webhook_errors', (select count(*) from public.system_logs where level in ('ERROR', 'WARN') and category = 'WEBHOOK'
                         and last_seen_at >= v_from and last_seen_at < v_to
                         and (merchant_id is null or merchant_id in (select public._platform_merchant_ids()))),
      'failed_jobs', (select count(*) from public.channel_sync_jobs where status = 'FAILED' and updated_at >= v_from and updated_at < v_to
                      and merchant_id in (select public._platform_merchant_ids()))),
    'support', jsonb_build_object(
      'open', (select count(*) from public.support_tickets where status not in ('RESOLVED', 'CLOSED')
               and merchant_id in (select public._platform_merchant_ids()))),
    'pbx', (select jsonb_build_object('gateway_seen_at', max(last_seen_at), 'businesses', (select count(*) from public.pbx_businesses where pbx_enabled))
            from public.pbx_gateway_status),
    'series', (select coalesce(jsonb_agg(jsonb_build_object('day', d::date,
        'orders', (select count(*) from public.orders o where o.merchant_id in (select public._platform_merchant_ids())
                   and o.created_at >= d and o.created_at < d + interval '1 day'),
        'merchants', (select count(*) from public.merchants m where m.id in (select public._platform_merchant_ids()) and not m.is_demo
                      and m.created_at >= d and m.created_at < d + interval '1 day')) order by d), '[]'::jsonb)
               from generate_series(v_from, v_to - interval '1 day', interval '1 day') d),
    'approvals_pending', (select count(*) from public.platform_approvals where status = 'PENDING' and expires_at > now())
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 12. Grants and ownership
-- -----------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'platform_me()', 'platform_can(text,text,uuid)', 'platform_staff_list()', 'platform_roles_list()', 'platform_role_save(jsonb)',
    'platform_role_delete(uuid)', 'platform_staff_save(jsonb)', 'platform_staff_assign(uuid,uuid[])', 'platform_staff_set_active(uuid,boolean,text)',
    'platform_request_approval(text,text,uuid,text,jsonb,text)', 'platform_approvals_list(text)', 'platform_approval_decide(uuid,boolean,text)',
    'platform_merchants_list(jsonb,text,text,integer,integer)', 'platform_merchant_get(uuid)', 'platform_merchant_create(jsonb)',
    'platform_merchant_update(uuid,jsonb)', 'platform_merchant_status_preview(uuid[],text)', 'platform_merchant_set_status(uuid[],text,text,text)',
    'platform_merchant_note_add(uuid,text,boolean)', 'platform_audit_list(jsonb,integer,integer)', 'platform_search(text)', 'platform_overview(date,date)',
    'platform_report_denied(text,jsonb)', 'platform_merchant_set_owner(uuid,uuid,text)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['_platform_require(text,text,uuid)', '_platform_merchant_ids()', '_platform_is_super()',
    '_platform_log(text,uuid,text,text,text,jsonb,jsonb,text,jsonb)', '_platform_execute_approval(public.platform_approvals)',
    '_platform_execute_approval_more(public.platform_approvals)', '_merchant_onboarding(uuid)']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;

insert into public.tenancy_exempt_functions (name, reason)
select f, 'Super Admin: sees every merchant and checks platform permissions itself'
from unnest(array['platform_me', 'platform_can', '_platform_require', '_platform_merchant_ids', '_platform_is_super', '_platform_log',
  'platform_staff_list', 'platform_roles_list', 'platform_role_save', 'platform_role_delete', 'platform_staff_save', 'platform_staff_assign',
  'platform_staff_set_active', 'platform_request_approval', 'platform_approvals_list', 'platform_approval_decide', '_platform_execute_approval',
  '_platform_execute_approval_more', '_merchant_onboarding', 'platform_merchants_list', 'platform_merchant_get', 'platform_merchant_create',
  'platform_merchant_update', 'platform_merchant_status_preview', 'platform_merchant_set_status', 'platform_merchant_note_add',
  'platform_audit_list', 'platform_search', 'platform_overview', 'platform_report_denied', 'platform_merchant_set_owner']) f
on conflict (name) do nothing;

select public._tenancy_own_functions();
