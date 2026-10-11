-- =============================================================================
-- Support & Issues for the platform team.
--
-- * Merchants' existing bug reports and feedback (support_tickets) are now
--   answered by the platform team: assignment, due times from a configurable
--   SLA, internal notes, escalation and a full history per ticket.
-- * Platform staff can open a ticket for a merchant (optionally internal,
--   which the merchant never sees).
-- * Time-limited, read-only customer-view sessions: a support employee sees the
--   merchant's interface as it is, cannot change anything, and every session
--   (who, which merchant, why, how long) is logged. The merchant can see who
--   looked and why. No password is ever involved.
-- * An in-panel notification inbox for platform staff, used here for ticket
--   activity and later by incidents and automation rules.
--
-- Every function is owned by postgres (it works across merchants) and checks
-- platform permissions itself; merchant staff can call none of it.
-- =============================================================================

-- Patches below compare and rewrite existing function text. Line endings are
-- normalized first, so they also apply when this file is pasted into an editor
-- that sends Windows line endings.
create or replace function pg_temp.lf(p text) returns text
language sql immutable as $$ select replace(p, E'\r', '') $$;
create or replace function pg_temp.lf_replace(p text, p_from text, p_to text) returns text
language sql immutable as $$ select replace(pg_temp.lf(p), pg_temp.lf(p_from), pg_temp.lf(p_to)) $$;

-- -----------------------------------------------------------------------------
-- 1. Notifications for platform staff
-- -----------------------------------------------------------------------------
create table public.platform_notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind ~ '^[a-z][a-z0-9_.]{1,60}$'),
  severity text not null default 'INFO' check (severity in ('INFO', 'WARN', 'CRITICAL')),
  title text not null check (length(title) between 1 and 200),
  body text check (length(body) <= 2000),
  link text check (link ~ '^/super-admin'),
  merchant_id uuid references public.merchants(id),
  -- The same alert reaches a person once.
  dedupe_key text check (length(dedupe_key) <= 200),
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index platform_notifications_dedupe_idx on public.platform_notifications (user_id, dedupe_key) where dedupe_key is not null;
create index platform_notifications_user_idx on public.platform_notifications (user_id, created_at desc);
alter table public.platform_notifications enable row level security;
revoke all on public.platform_notifications from anon, authenticated;

-- platform_can() for someone other than the signed-in person.
create or replace function public._platform_staff_can(p_user uuid, p_module text, p_action text, p_merchant uuid default null)
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
    where s.user_id = p_user
      and s.is_active
      and (r.is_super or exists (select 1 from public.platform_role_permissions rp
                                 where rp.role_id = r.id and rp.module = p_module and rp.action = p_action))
      and (p_merchant is null or r.is_super or s.merchant_scope = 'ALL'
           or exists (select 1 from public.platform_staff_merchants sm where sm.user_id = s.user_id and sm.merchant_id = p_merchant))
  )
$$;

-- Sends one notification to every active employee allowed p_module.p_action
-- (for the merchant, when given), or to the named people if they may at least
-- view the module. Returns how many were delivered (duplicates are skipped).
create or replace function public._platform_notify(
  p_module text, p_action text, p_merchant uuid, p_kind text, p_severity text, p_title text, p_body text,
  p_link text, p_dedupe text, p_users uuid[] default null)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n int;
begin
  insert into public.platform_notifications (user_id, kind, severity, title, body, link, merchant_id, dedupe_key)
  select s.user_id, p_kind, coalesce(p_severity, 'INFO'), left(p_title, 200), left(p_body, 2000), p_link, p_merchant, p_dedupe
  from public.platform_staff s
  where s.is_active
    and case when p_users is not null
             then s.user_id = any (p_users) and public._platform_staff_can(s.user_id, p_module, 'view', p_merchant)
             else public._platform_staff_can(s.user_id, p_module, p_action, p_merchant) end
  on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

create or replace function public.platform_notifications_list(p_limit int default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_platform_staff() then
    raise exception 'PERMISSION_DENIED: platform staff only' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'unread', (select count(*) from public.platform_notifications where user_id = auth.uid() and read_at is null),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'kind', n.kind, 'severity', n.severity, 'title', n.title, 'body', n.body,
        'link', n.link, 'read', n.read_at is not null, 'created_at', n.created_at,
        'merchant', (select jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name) from public.merchants m where m.id = n.merchant_id))
        order by n.created_at desc), '[]'::jsonb)
      from (select * from public.platform_notifications where user_id = auth.uid()
            order by created_at desc limit least(greatest(coalesce(p_limit, 30), 1), 100)) n));
end;
$$;

-- Marks the caller's notifications read (all of them when p_ids is null).
create or replace function public.platform_notifications_read(p_ids bigint[] default null)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n int;
begin
  if not public.is_platform_staff() then
    raise exception 'PERMISSION_DENIED: platform staff only' using errcode = '42501';
  end if;
  update public.platform_notifications set read_at = now()
  where user_id = auth.uid() and read_at is null and (p_ids is null or id = any (p_ids));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. Tickets: assignment, due times, escalation, internal notes and history
-- -----------------------------------------------------------------------------
insert into public.platform_settings (key, value) values ('support', jsonb_build_object(
  -- Hours to resolve, and to send the first reply, by priority.
  'sla_hours', jsonb_build_object('URGENT', 4, 'HIGH', 8, 'NORMAL', 24, 'LOW', 72),
  'response_hours', jsonb_build_object('URGENT', 1, 'HIGH', 2, 'NORMAL', 8, 'LOW', 24),
  -- Customer-view sessions.
  'session_default_minutes', 30,
  'session_max_minutes', 120,
  -- Name shown to merchants next to replies from the platform team.
  'team_name', 'Support'))
on conflict (key) do nothing;

alter table public.support_tickets
  alter column created_by drop not null,
  add column opened_by_platform uuid references auth.users(id),
  -- Internal tickets are the platform team's own; the merchant never sees them.
  add column internal boolean not null default false,
  add column assigned_to uuid references auth.users(id),
  add column assigned_at timestamptz,
  add column due_at timestamptz,
  add column first_response_at timestamptz,
  add column escalation_level int not null default 0 check (escalation_level between 0 and 5),
  add column escalated_at timestamptz,
  add column last_reply_from text check (last_reply_from in ('MERCHANT', 'PLATFORM')),
  add constraint support_tickets_opened_by_check check (created_by is not null or opened_by_platform is not null),
  add constraint support_tickets_internal_check check (not internal or opened_by_platform is not null);
create index support_tickets_queue_idx on public.support_tickets (status, due_at) where status in ('OPEN', 'IN_PROGRESS');
create index support_tickets_assigned_idx on public.support_tickets (assigned_to) where status in ('OPEN', 'IN_PROGRESS');

-- Merchants never see internal tickets (nor, through the ticket, their messages).
create policy support_tickets_not_internal on public.support_tickets as restrictive for select to authenticated using (not internal);

alter table public.support_ticket_messages
  alter column author_id drop not null,
  add column platform_author uuid references auth.users(id),
  -- What the merchant sees as the author of a platform reply.
  add column author_label text check (length(author_label) <= 80),
  add constraint support_ticket_messages_author_check check (author_id is not null or platform_author is not null);

-- What happened to a ticket, including internal notes. Platform-only, append-only.
create table public.support_ticket_events (
  id bigint generated always as identity primary key,
  ticket_id uuid not null references public.support_tickets(id),
  merchant_id uuid not null references public.merchants(id),
  kind text not null check (kind in ('CREATED', 'NOTE', 'ASSIGNED', 'STATUS', 'PRIORITY', 'DUE', 'ESCALATED', 'REPLY', 'MERCHANT_REPLY', 'SESSION')),
  body text check (length(body) <= 4000),
  data jsonb not null default '{}'::jsonb,
  actor_id uuid,
  actor_email text,
  created_at timestamptz not null default now()
);
create index support_ticket_events_ticket_idx on public.support_ticket_events (ticket_id, id);
create trigger support_ticket_events_immutable before update or delete on public.support_ticket_events
  for each row execute function public.prevent_mutation();
alter table public.support_ticket_events enable row level security;
revoke all on public.support_ticket_events from anon, authenticated;

create or replace function public._platform_support_settings()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select value from public.platform_settings where key = 'support'), '{}'::jsonb)
$$;

create or replace function public._platform_ticket_event(p_ticket uuid, p_merchant uuid, p_kind text, p_body text, p_data jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.support_ticket_events (ticket_id, merchant_id, kind, body, data, actor_id, actor_email)
  values (p_ticket, p_merchant, p_kind, left(p_body, 4000), coalesce(p_data, '{}'::jsonb), auth.uid(),
          (select email from public.platform_staff where user_id = auth.uid()))
$$;

-- Due time from the priority (on creation, and when the priority changes
-- without someone setting a due time by hand).
create or replace function public._platform_ticket_sla()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hours numeric;
begin
  if tg_op = 'INSERT' or (new.priority is distinct from old.priority and new.due_at is not distinct from old.due_at) then
    v_hours := nullif(public._platform_support_settings() #>> array['sla_hours', new.priority], '')::numeric;
    if v_hours is not null and (tg_op = 'UPDATE' or new.due_at is null) then
      new.due_at := new.created_at + make_interval(secs => v_hours * 3600);
    end if;
  end if;
  return new;
end;
$$;
create trigger support_tickets_sla before insert or update of priority on public.support_tickets
  for each row execute function public._platform_ticket_sla();

-- A new merchant ticket is recorded; urgent ones alert the support team.
create or replace function public._platform_ticket_created()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.support_ticket_events (ticket_id, merchant_id, kind, body, data, actor_id, actor_email)
  values (new.id, new.merchant_id, 'CREATED', null,
          jsonb_build_object('priority', new.priority, 'kind', new.kind, 'by', case when new.opened_by_platform is null then 'MERCHANT' else 'PLATFORM' end),
          coalesce(new.opened_by_platform, new.created_by),
          coalesce((select email from public.platform_staff where user_id = new.opened_by_platform),
                   (select email from public.profiles where id = new.created_by)));
  if new.opened_by_platform is null and new.priority in ('HIGH', 'URGENT') then
    perform public._platform_notify('support', 'edit', new.merchant_id, 'support.ticket_new',
      case when new.priority = 'URGENT' then 'CRITICAL' else 'WARN' end,
      format('%s ticket #%s: %s', initcap(new.priority), new.number, new.subject),
      (select name from public.merchants where id = new.merchant_id), '/super-admin/support?ticket=' || new.id, 'ticket.new:' || new.id);
  end if;
  return new;
end;
$$;
create trigger support_tickets_created after insert on public.support_tickets
  for each row execute function public._platform_ticket_created();

-- Who wrote last, and an alert to the assignee when the merchant writes.
create or replace function public._platform_ticket_message()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  t public.support_tickets;
begin
  select * into t from public.support_tickets where id = new.ticket_id;
  update public.support_tickets set last_reply_from = case when new.platform_author is null then 'MERCHANT' else 'PLATFORM' end
  where id = new.ticket_id;
  if new.platform_author is null then
    insert into public.support_ticket_events (ticket_id, merchant_id, kind, body, data, actor_id, actor_email)
    values (t.id, t.merchant_id, 'MERCHANT_REPLY', left(new.body, 300), jsonb_build_object('message_id', new.id), new.author_id,
            (select email from public.profiles where id = new.author_id));
    -- Only once the platform team is involved: the merchant writing to their own ticket before anyone answered is not news.
    if t.assigned_to is not null then
      perform public._platform_notify('support', 'view', t.merchant_id, 'support.ticket_reply', 'INFO',
        format('Reply on #%s: %s', t.number, t.subject), left(new.body, 300), '/super-admin/support?ticket=' || t.id,
        'ticket.reply:' || new.id, array[t.assigned_to]);
    end if;
  end if;
  return new;
end;
$$;
create trigger support_ticket_messages_activity after insert on public.support_ticket_messages
  for each row execute function public._platform_ticket_message();

-- Merchant staff replying are never "support" any more: support is the platform team.
create or replace function public.support_ticket_reply(p_id uuid, p_body text)
returns public.support_ticket_messages
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_t public.support_tickets;
  v_support boolean := public.has_permission('support.manage');
  v_row public.support_ticket_messages;
begin
  select * into v_t from public.support_tickets where id = p_id for update;
  if v_t.id is null or v_t.internal or not (v_t.created_by = auth.uid() or v_support) or not public.is_staff() then
    raise exception 'NOT_FOUND: ticket not found' using errcode = 'P0002';
  end if;
  if length(trim(coalesce(p_body, ''))) < 1 then
    raise exception 'VALIDATION: write a reply' using errcode = '22023';
  end if;
  insert into public.support_ticket_messages(ticket_id, author_id, body, is_support)
  values (p_id, auth.uid(), left(trim(p_body), 4000), false)
  returning * into v_row;
  update public.support_tickets set replies = replies + 1, last_reply_at = now(), last_reply_by = auth.uid(),
    -- The merchant writing again reopens a resolved ticket.
    status = case when status in ('RESOLVED', 'CLOSED') then 'OPEN' else status end,
    resolved_at = case when status in ('RESOLVED', 'CLOSED') then null else resolved_at end
  where id = p_id;
  return v_row;
end;
$$;

create or replace function public._platform_ticket_get_row(p_id uuid, p_action text)
returns public.support_tickets
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  t public.support_tickets;
begin
  select * into t from public.support_tickets where id = p_id for update;
  if t.id is null or not public.platform_can('support', 'view', t.merchant_id) then
    raise exception 'NOT_FOUND: ticket not found' using errcode = 'P0002';
  end if;
  perform public._platform_require('support', p_action, t.merchant_id);
  return t;
end;
$$;

create or replace function public._platform_ticket_json(t public.support_tickets)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', t.id, 'number', t.number, 'kind', t.kind, 'category', t.category, 'subject', t.subject, 'status', t.status, 'priority', t.priority,
    'internal', t.internal, 'source', case when t.opened_by_platform is null then 'MERCHANT' else 'PLATFORM' end,
    'merchant', (select jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name, 'status', m.status) from public.merchants m where m.id = t.merchant_id),
    'reporter', coalesce((select jsonb_build_object('name', coalesce(nullif(trim(p.full_name), ''), p.email), 'email', p.email, 'platform', false)
                          from public.profiles p where p.id = t.created_by),
                         (select jsonb_build_object('name', coalesce(nullif(trim(s.full_name), ''), s.email), 'email', s.email, 'platform', true)
                          from public.platform_staff s where s.user_id = t.opened_by_platform)),
    'assigned', (select jsonb_build_object('user_id', s.user_id, 'name', coalesce(nullif(trim(s.full_name), ''), s.email), 'email', s.email)
                 from public.platform_staff s where s.user_id = t.assigned_to),
    'due_at', t.due_at,
    'overdue', t.status in ('OPEN', 'IN_PROGRESS') and t.due_at < now(),
    'response_due_at', t.created_at + make_interval(secs => coalesce(nullif(public._platform_support_settings() #>> array['response_hours', t.priority], '')::numeric, 24) * 3600),
    'first_response_at', t.first_response_at,
    'escalation_level', t.escalation_level, 'escalated_at', t.escalated_at,
    'replies', t.replies, 'last_reply_at', t.last_reply_at, 'last_reply_from', t.last_reply_from,
    'created_at', t.created_at, 'updated_at', t.updated_at, 'resolved_at', t.resolved_at)
$$;

create or replace function public.platform_tickets_list(p jsonb default '{}'::jsonb, p_limit int default 50, p_offset int default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_view text := coalesce(nullif(p ->> 'view', ''), 'active');
  v_q text := nullif(trim(coalesce(p ->> 'q', '')), '');
  v_merchant uuid := nullif(p ->> 'merchant', '')::uuid;
  v_priority text := nullif(upper(coalesce(p ->> 'priority', '')), '');
  v_assigned uuid := nullif(p ->> 'assigned', '')::uuid;
  v_total int;
  v_rows jsonb;
begin
  perform public._platform_require('support', 'view', v_merchant);
  if v_view not in ('active', 'mine', 'unassigned', 'overdue', 'waiting', 'escalated', 'resolved', 'all') then
    raise exception 'VALIDATION: unknown view' using errcode = '22023';
  end if;
  with f as (
    select t.* from public.support_tickets t
    where t.merchant_id in (select public._platform_merchant_ids())
      and (v_merchant is null or t.merchant_id = v_merchant)
      and (v_priority is null or t.priority = v_priority)
      and (v_assigned is null or t.assigned_to = v_assigned)
      and (v_q is null or t.subject ilike '%' || v_q || '%' or t.number::text = ltrim(v_q, '#')
           or exists (select 1 from public.merchants m where m.id = t.merchant_id and m.name ilike '%' || v_q || '%'))
      and case v_view
        when 'active' then t.status in ('OPEN', 'IN_PROGRESS')
        when 'mine' then t.status in ('OPEN', 'IN_PROGRESS') and t.assigned_to = auth.uid()
        when 'unassigned' then t.status in ('OPEN', 'IN_PROGRESS') and t.assigned_to is null
        when 'overdue' then t.status in ('OPEN', 'IN_PROGRESS') and t.due_at < now()
        when 'waiting' then t.status in ('OPEN', 'IN_PROGRESS') and coalesce(t.last_reply_from, 'MERCHANT') = 'MERCHANT'
        when 'escalated' then t.status in ('OPEN', 'IN_PROGRESS') and t.escalation_level > 0
        when 'resolved' then t.status in ('RESOLVED', 'CLOSED')
        else true end),
  page as (
    -- Overdue first, then by priority, then the most pressing due time.
    select f.*, row_number() over (order by
        case when v_view = 'resolved' then 0 else (f.due_at < now())::int end desc,
        case f.priority when 'URGENT' then 0 when 'HIGH' then 1 when 'NORMAL' then 2 else 3 end,
        case when v_view = 'resolved' then f.resolved_at end desc nulls last,
        f.due_at nulls last, f.created_at desc) as rn
    from f)
  select (select count(*) from f),
         (select coalesce(jsonb_agg(public._platform_ticket_json(t) order by pg.rn), '[]'::jsonb)
          from (select id, rn from page where rn > greatest(coalesce(p_offset, 0), 0)
                order by rn limit least(greatest(coalesce(p_limit, 50), 1), 200)) pg
          join public.support_tickets t on t.id = pg.id)
    into v_total, v_rows;
  return jsonb_build_object(
    'total', v_total,
    'rows', v_rows,
    'summary', (select jsonb_build_object(
        'active', count(*) filter (where t.status in ('OPEN', 'IN_PROGRESS')),
        'mine', count(*) filter (where t.status in ('OPEN', 'IN_PROGRESS') and t.assigned_to = auth.uid()),
        'unassigned', count(*) filter (where t.status in ('OPEN', 'IN_PROGRESS') and t.assigned_to is null),
        'overdue', count(*) filter (where t.status in ('OPEN', 'IN_PROGRESS') and t.due_at < now()),
        'waiting', count(*) filter (where t.status in ('OPEN', 'IN_PROGRESS') and coalesce(t.last_reply_from, 'MERCHANT') = 'MERCHANT'),
        'escalated', count(*) filter (where t.status in ('OPEN', 'IN_PROGRESS') and t.escalation_level > 0),
        'resolved_7d', count(*) filter (where t.resolved_at > now() - interval '7 days'),
        -- Hours from opening to resolution, tickets resolved in the last 30 days.
        'avg_resolution_hours_30d', round((avg(extract(epoch from t.resolved_at - t.created_at) / 3600)
                                    filter (where t.resolved_at > now() - interval '30 days'))::numeric, 1),
        'avg_first_response_hours_30d', round((avg(extract(epoch from t.first_response_at - t.created_at) / 3600)
                                        filter (where t.first_response_at > now() - interval '30 days'))::numeric, 1),
        'resolved_on_time_30d', count(*) filter (where t.resolved_at > now() - interval '30 days' and (t.due_at is null or t.resolved_at <= t.due_at)),
        'resolved_30d', count(*) filter (where t.resolved_at > now() - interval '30 days'))
      from public.support_tickets t
      where t.merchant_id in (select public._platform_merchant_ids()) and (v_merchant is null or t.merchant_id = v_merchant)),
    'settings', public._platform_support_settings(),
    'can', jsonb_build_object('create', public.platform_can('support', 'create', v_merchant), 'edit', public.platform_can('support', 'edit', v_merchant),
                              'manage', public.platform_can('support', 'manage', v_merchant)));
end;
$$;

create or replace function public.platform_ticket_get(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  t public.support_tickets;
begin
  select * into t from public.support_tickets where id = p_id;
  if t.id is null or not public.platform_can('support', 'view', t.merchant_id) then
    raise exception 'NOT_FOUND: ticket not found' using errcode = 'P0002';
  end if;
  return public._platform_ticket_json(t) || jsonb_build_object(
    'body', t.body, 'rating', t.rating, 'context', t.context,
    'merchant_detail', (select jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name, 'status', m.status, 'owner_email', m.owner_email,
        'phone', m.phone, 'is_demo', m.is_demo, 'access_mode', public.merchant_access_mode(m.id),
        'plan', (select jsonb_build_object('code', pl.code, 'name', pl.name, 'status', s.status) from public.subscriptions s
                 join public.plans pl on pl.id = s.plan_id where s.merchant_id = m.id and s.ended_at is null order by s.created_at desc limit 1),
        'account_manager', (select coalesce(nullif(trim(ps.full_name), ''), ps.email) from public.platform_staff ps where ps.user_id = m.account_manager_id))
      from public.merchants m where m.id = t.merchant_id),
    'messages', (select coalesce(jsonb_agg(jsonb_build_object('id', msg.id, 'body', msg.body, 'created_at', msg.created_at,
        'from', case when msg.platform_author is null then 'MERCHANT' else 'PLATFORM' end,
        'author', coalesce((select coalesce(nullif(trim(p.full_name), ''), p.email) from public.profiles p where p.id = msg.author_id),
                           (select coalesce(nullif(trim(s.full_name), ''), s.email) from public.platform_staff s where s.user_id = msg.platform_author)),
        'label', msg.author_label) order by msg.created_at), '[]'::jsonb)
      from public.support_ticket_messages msg where msg.ticket_id = t.id),
    'events', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'body', e.body, 'data', e.data, 'actor', e.actor_email,
        'created_at', e.created_at) order by e.id), '[]'::jsonb)
      from public.support_ticket_events e where e.ticket_id = t.id),
    -- Recent problems on the merchant's account, for context.
    'logs', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'level', l.level, 'category', l.category, 'source', l.source, 'message', l.message,
        'occurrences', l.occurrences, 'last_seen_at', l.last_seen_at, 'resolved', l.resolved_at is not null) order by l.last_seen_at desc), '[]'::jsonb)
      from (select * from public.system_logs l where l.merchant_id = t.merchant_id and l.level in ('ERROR', 'WARN')
              and l.last_seen_at > least(t.created_at, now()) - interval '7 days'
            order by l.last_seen_at desc limit 20) l),
    'sessions', (select coalesce(jsonb_agg(public._platform_session_json(s) order by s.started_at desc), '[]'::jsonb)
      from (select * from public.support_sessions s where s.merchant_id = t.merchant_id
              and (s.ticket_id = t.id or s.started_at > t.created_at - interval '1 day') order by s.started_at desc limit 10) s),
    'other_open', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'number', o.number, 'subject', o.subject, 'status', o.status,
        'priority', o.priority, 'created_at', o.created_at) order by o.created_at desc), '[]'::jsonb)
      from public.support_tickets o where o.merchant_id = t.merchant_id and o.id <> t.id and o.status in ('OPEN', 'IN_PROGRESS')),
    -- People this ticket can be given to.
    'assignable', (select coalesce(jsonb_agg(jsonb_build_object('user_id', s.user_id, 'name', coalesce(nullif(trim(s.full_name), ''), s.email),
        'email', s.email) order by coalesce(nullif(trim(s.full_name), ''), s.email)), '[]'::jsonb)
      from public.platform_staff s where s.is_active and public._platform_staff_can(s.user_id, 'support', 'edit', t.merchant_id)),
    'can', jsonb_build_object('edit', public.platform_can('support', 'edit', t.merchant_id), 'manage', public.platform_can('support', 'manage', t.merchant_id),
                              'view_as', public.platform_can('support', 'edit', t.merchant_id) and
                                         (select status <> 'CLOSED' from public.merchants where id = t.merchant_id)));
end;
$$;

create or replace function public._platform_ticket_assignee_ok(p_user uuid, p_merchant uuid)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public._platform_staff_can(p_user, 'support', 'edit', p_merchant) then
    raise exception 'VALIDATION: that person cannot work on this merchant''s tickets' using errcode = '22023';
  end if;
end;
$$;

create or replace function public.platform_ticket_create(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_merchant uuid := nullif(p ->> 'merchant', '')::uuid;
  v_priority text := upper(coalesce(nullif(p ->> 'priority', ''), 'NORMAL'));
  v_assign uuid := nullif(p ->> 'assign_to', '')::uuid;
  t public.support_tickets;
begin
  if v_merchant is null or not exists (select 1 from public.merchants where id = v_merchant) then
    raise exception 'VALIDATION: choose the merchant' using errcode = '22023';
  end if;
  perform public._platform_require('support', 'create', v_merchant);
  if v_priority not in ('LOW', 'NORMAL', 'HIGH', 'URGENT') then
    raise exception 'VALIDATION: unknown priority' using errcode = '22023';
  end if;
  if length(trim(coalesce(p ->> 'subject', ''))) < 3 then
    raise exception 'VALIDATION: add a short title' using errcode = '22023';
  end if;
  if length(trim(coalesce(p ->> 'body', ''))) < 5 then
    raise exception 'VALIDATION: describe the issue in a few words' using errcode = '22023';
  end if;
  if v_assign is not null then
    if v_assign <> auth.uid() then
      perform public._platform_require('support', 'manage', v_merchant);
    end if;
    perform public._platform_ticket_assignee_ok(v_assign, v_merchant);
  end if;
  insert into public.support_tickets (merchant_id, kind, category, subject, body, priority, context, created_by, opened_by_platform, internal,
                                      assigned_to, assigned_at)
  values (v_merchant, 'BUG', upper(coalesce(nullif(p ->> 'category', ''), 'GENERAL')), left(trim(p ->> 'subject'), 140), left(trim(p ->> 'body'), 4000),
          v_priority, jsonb_build_object('source', 'platform'), null, auth.uid(), coalesce((p ->> 'internal')::boolean, false),
          v_assign, case when v_assign is not null then now() end)
  returning * into t;
  if v_assign is not null then
    perform public._platform_ticket_event(t.id, t.merchant_id, 'ASSIGNED', null, jsonb_build_object('to', v_assign,
      'to_email', (select email from public.platform_staff where user_id = v_assign)));
    if v_assign <> auth.uid() then
      perform public._platform_notify('support', 'view', t.merchant_id, 'support.ticket_assigned', 'INFO', format('Ticket #%s is yours: %s', t.number, t.subject),
        null, '/super-admin/support?ticket=' || t.id, null, array[v_assign]);
    end if;
  end if;
  perform public._platform_log('support.ticket_created', t.merchant_id, 'support_ticket', t.id::text, null, null,
    jsonb_build_object('number', t.number, 'subject', t.subject, 'priority', t.priority, 'internal', t.internal));
  return public._platform_ticket_json(t);
end;
$$;

create or replace function public.platform_ticket_reply(p_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  t public.support_tickets := public._platform_ticket_get_row(p_id, 'edit');
  v_name text;
begin
  if t.internal then
    raise exception 'VALIDATION: this is an internal ticket; add a note instead' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_body, ''))) < 1 then
    raise exception 'VALIDATION: write a reply' using errcode = '22023';
  end if;
  select split_part(coalesce(nullif(trim(full_name), ''), split_part(email, '@', 1)), ' ', 1) into v_name
  from public.platform_staff where user_id = auth.uid();
  insert into public.support_ticket_messages (ticket_id, merchant_id, author_id, platform_author, author_label, body, is_support)
  values (t.id, t.merchant_id, null, auth.uid(), left(v_name || ' · ' || coalesce(public._platform_support_settings() ->> 'team_name', 'Support'), 80),
          left(trim(p_body), 4000), true);
  update public.support_tickets set replies = replies + 1, last_reply_at = now(), last_reply_by = null,
    first_response_at = coalesce(first_response_at, now()),
    status = case when status = 'OPEN' then 'IN_PROGRESS' else status end
  where id = t.id
  returning * into t;
  perform public._platform_ticket_event(t.id, t.merchant_id, 'REPLY', left(trim(p_body), 300));
  return public._platform_ticket_json(t);
end;
$$;

create or replace function public.platform_ticket_note(p_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  t public.support_tickets := public._platform_ticket_get_row(p_id, 'edit');
begin
  if length(trim(coalesce(p_body, ''))) < 2 then
    raise exception 'VALIDATION: write the note' using errcode = '22023';
  end if;
  perform public._platform_ticket_event(t.id, t.merchant_id, 'NOTE', trim(p_body));
  return public._platform_ticket_json(t);
end;
$$;

-- Raises a ticket one level: priority goes up a step and managers are alerted.
-- p_auto: called by an automation rule (no signed-in person).
create or replace function public._platform_ticket_escalate(t public.support_tickets, p_reason text, p_auto boolean)
returns public.support_tickets
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.support_tickets;
begin
  if t.escalation_level >= 5 then
    return t;
  end if;
  update public.support_tickets set escalation_level = escalation_level + 1, escalated_at = now(),
    priority = case priority when 'LOW' then 'NORMAL' when 'NORMAL' then 'HIGH' else 'URGENT' end
  where id = t.id returning * into v_row;
  perform public._platform_ticket_event(t.id, t.merchant_id, 'ESCALATED', p_reason,
    jsonb_build_object('level', v_row.escalation_level, 'priority_from', t.priority, 'priority_to', v_row.priority, 'automatic', p_auto));
  perform public._platform_notify('support', 'manage', t.merchant_id, 'support.ticket_escalated',
    case when v_row.priority = 'URGENT' then 'CRITICAL' else 'WARN' end,
    format('Escalated (level %s): #%s %s', v_row.escalation_level, t.number, t.subject), p_reason,
    '/super-admin/support?ticket=' || t.id, format('ticket.escalated:%s:%s', t.id, v_row.escalation_level));
  if t.assigned_to is not null then
    perform public._platform_notify('support', 'view', t.merchant_id, 'support.ticket_escalated', 'WARN',
      format('Your ticket #%s was escalated', t.number), p_reason, '/super-admin/support?ticket=' || t.id,
      format('ticket.escalated:%s:%s', t.id, v_row.escalation_level), array[t.assigned_to]);
  end if;
  return v_row;
end;
$$;

create or replace function public.platform_ticket_escalate(p_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  t public.support_tickets := public._platform_ticket_get_row(p_id, 'edit');
begin
  if length(trim(coalesce(p_reason, ''))) < 5 then
    raise exception 'VALIDATION: say why it is being escalated' using errcode = '22023';
  end if;
  if t.status not in ('OPEN', 'IN_PROGRESS') then
    raise exception 'VALIDATION: only open tickets can be escalated' using errcode = '22023';
  end if;
  if t.escalation_level >= 5 then
    raise exception 'VALIDATION: this ticket is already at the highest escalation level' using errcode = '22023';
  end if;
  t := public._platform_ticket_escalate(t, trim(p_reason), false);
  perform public._platform_log('support.ticket_escalated', t.merchant_id, 'support_ticket', t.id::text, trim(p_reason), null,
    jsonb_build_object('level', t.escalation_level, 'priority', t.priority));
  return public._platform_ticket_json(t);
end;
$$;

-- Status, priority, due time and assignee. Giving a ticket to someone else (or
-- taking it from them) needs support.manage; taking an unassigned one does not.
create or replace function public.platform_ticket_update(p_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  t public.support_tickets := public._platform_ticket_get_row(p_id, 'edit');
  v_row public.support_tickets;
  v_status text := nullif(upper(coalesce(p ->> 'status', '')), '');
  v_priority text := nullif(upper(coalesce(p ->> 'priority', '')), '');
  v_due timestamptz := nullif(p ->> 'due_at', '')::timestamptz;
  v_assign uuid := nullif(p ->> 'assigned_to', '')::uuid;
  v_assign_given boolean := p ? 'assigned_to';
begin
  if v_status is not null and v_status not in ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED') then
    raise exception 'VALIDATION: unknown status' using errcode = '22023';
  end if;
  if v_priority is not null and v_priority not in ('LOW', 'NORMAL', 'HIGH', 'URGENT') then
    raise exception 'VALIDATION: unknown priority' using errcode = '22023';
  end if;
  if v_due is not null and v_due < now() - interval '1 minute' then
    raise exception 'VALIDATION: the due time is in the past' using errcode = '22023';
  end if;
  if v_assign_given and v_assign is distinct from t.assigned_to then
    if (v_assign is not null and v_assign <> auth.uid()) or (t.assigned_to is not null and t.assigned_to <> auth.uid()) then
      perform public._platform_require('support', 'manage', t.merchant_id);
    end if;
    if v_assign is not null then
      perform public._platform_ticket_assignee_ok(v_assign, t.merchant_id);
    end if;
  end if;

  update public.support_tickets set
    status = coalesce(v_status, status),
    priority = coalesce(v_priority, priority),
    due_at = coalesce(v_due, due_at),
    assigned_to = case when v_assign_given then v_assign else assigned_to end,
    assigned_at = case when v_assign_given and v_assign is distinct from t.assigned_to then case when v_assign is null then null else now() end
                       else assigned_at end,
    resolved_at = case when coalesce(v_status, status) in ('RESOLVED', 'CLOSED') then coalesce(resolved_at, now()) else null end
  where id = t.id returning * into v_row;

  if v_row.status is distinct from t.status then
    perform public._platform_ticket_event(t.id, t.merchant_id, 'STATUS', nullif(trim(coalesce(p ->> 'reason', '')), ''),
      jsonb_build_object('from', t.status, 'to', v_row.status));
  end if;
  if v_row.priority is distinct from t.priority then
    perform public._platform_ticket_event(t.id, t.merchant_id, 'PRIORITY', null, jsonb_build_object('from', t.priority, 'to', v_row.priority));
  end if;
  if v_row.due_at is distinct from t.due_at then
    perform public._platform_ticket_event(t.id, t.merchant_id, 'DUE', null, jsonb_build_object('from', t.due_at, 'to', v_row.due_at));
  end if;
  if v_row.assigned_to is distinct from t.assigned_to then
    perform public._platform_ticket_event(t.id, t.merchant_id, 'ASSIGNED', null, jsonb_build_object('from', t.assigned_to, 'to', v_row.assigned_to,
      'to_email', (select email from public.platform_staff where user_id = v_row.assigned_to)));
    if v_row.assigned_to is not null and v_row.assigned_to <> auth.uid() then
      perform public._platform_notify('support', 'view', t.merchant_id, 'support.ticket_assigned', 'INFO',
        format('Ticket #%s is yours: %s', t.number, t.subject), null, '/super-admin/support?ticket=' || t.id, null, array[v_row.assigned_to]);
    end if;
  end if;
  perform public._platform_log('support.ticket_updated', t.merchant_id, 'support_ticket', t.id::text, nullif(trim(coalesce(p ->> 'reason', '')), ''),
    jsonb_build_object('status', t.status, 'priority', t.priority, 'due_at', t.due_at, 'assigned_to', t.assigned_to),
    jsonb_build_object('status', v_row.status, 'priority', v_row.priority, 'due_at', v_row.due_at, 'assigned_to', v_row.assigned_to));
  return public._platform_ticket_json(v_row);
end;
$$;

create or replace function public.platform_support_settings_save(p jsonb, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb := public._platform_support_settings();
  v_after jsonb;
  k text;
begin
  perform public._platform_require('support', 'manage');
  v_after := v_before || coalesce(p, '{}'::jsonb);
  foreach k in array array['URGENT', 'HIGH', 'NORMAL', 'LOW'] loop
    if coalesce(nullif(v_after #>> array['sla_hours', k], '')::numeric, 0) not between 0.25 and 720
       or coalesce(nullif(v_after #>> array['response_hours', k], '')::numeric, 0) not between 0.25 and 720 then
      raise exception 'VALIDATION: each target is between 15 minutes and 30 days' using errcode = '22023';
    end if;
    if (v_after #>> array['response_hours', k])::numeric > (v_after #>> array['sla_hours', k])::numeric then
      raise exception 'VALIDATION: the first reply cannot be due after the resolution' using errcode = '22023';
    end if;
  end loop;
  if coalesce((v_after ->> 'session_max_minutes')::int, 0) not between 5 and 240
     or coalesce((v_after ->> 'session_default_minutes')::int, 0) not between 5 and (v_after ->> 'session_max_minutes')::int then
    raise exception 'VALIDATION: customer-view sessions last 5 minutes to 4 hours, and the default cannot exceed the maximum' using errcode = '22023';
  end if;
  if length(trim(coalesce(v_after ->> 'team_name', ''))) not between 2 and 40 then
    raise exception 'VALIDATION: the team name is 2–40 characters' using errcode = '22023';
  end if;
  v_after := jsonb_build_object('sla_hours', v_after -> 'sla_hours', 'response_hours', v_after -> 'response_hours',
    'session_default_minutes', (v_after ->> 'session_default_minutes')::int, 'session_max_minutes', (v_after ->> 'session_max_minutes')::int,
    'team_name', trim(v_after ->> 'team_name'));
  insert into public.platform_settings (key, value, updated_by) values ('support', v_after, auth.uid())
  on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by;
  perform public._config_version('platform_setting', 'support', v_after, p_reason);
  perform public._platform_log('support.settings_changed', null, 'platform_setting', 'support', p_reason, v_before, v_after);
  return v_after;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Customer-view sessions
-- -----------------------------------------------------------------------------
create or replace function public._platform_session_json(s public.support_sessions)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', s.id, 'mode', s.mode, 'reason', s.reason,
    'staff', (select jsonb_build_object('user_id', ps.user_id, 'name', coalesce(nullif(trim(ps.full_name), ''), ps.email), 'email', ps.email)
              from public.platform_staff ps where ps.user_id = s.staff_user_id),
    'merchant', (select jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name) from public.merchants m where m.id = s.merchant_id),
    'ticket', (select jsonb_build_object('id', t.id, 'number', t.number, 'subject', t.subject) from public.support_tickets t where t.id = s.ticket_id),
    'started_at', s.started_at, 'expires_at', s.expires_at, 'ended_at', s.ended_at, 'end_reason', s.end_reason,
    'ended_by', (select email from public.platform_staff where user_id = s.ended_by),
    'status', case when s.ended_at is null and s.expires_at > now() then 'ACTIVE'
                   when s.ended_at is null or s.end_reason = 'Expired' then 'EXPIRED' else 'ENDED' end,
    'minutes', round(extract(epoch from least(coalesce(s.ended_at, s.expires_at), now()) - s.started_at) / 60))
$$;

-- Closes sessions whose time ran out and logs each one. (The session already
-- stopped working at expires_at; this only completes the record.)
create or replace function public._platform_support_expire()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s public.support_sessions;
  v_n int := 0;
begin
  for s in
    update public.support_sessions set ended_at = expires_at, end_reason = 'Expired'
    where ended_at is null and expires_at <= now()
    returning *
  loop
    v_n := v_n + 1;
    insert into public.platform_audit_logs (actor_id, actor_email, action, merchant_id, entity_type, entity_id, reason, after, metadata, result)
    values (s.staff_user_id, (select email from public.platform_staff where user_id = s.staff_user_id), 'support.session_expired', s.merchant_id,
            'support_session', s.id::text, s.reason,
            jsonb_build_object('minutes', round(extract(epoch from s.expires_at - s.started_at) / 60), 'ticket_id', s.ticket_id),
            jsonb_build_object('automatic', true), 'SUCCESS');
  end loop;
  return v_n;
end;
$$;

-- The signed-in person's open session, for get_my_access().
create or replace function public._platform_support_session_info()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object('id', s.id, 'mode', s.mode, 'reason', s.reason, 'started_at', s.started_at, 'expires_at', s.expires_at,
    'merchant_id', s.merchant_id,
    'ticket', (select jsonb_build_object('id', t.id, 'number', t.number) from public.support_tickets t where t.id = s.ticket_id),
    'email', ps.email, 'full_name', ps.full_name)
  from public.support_sessions s join public.platform_staff ps on ps.user_id = s.staff_user_id
  where s.id = public._support_session_id()
$$;

create or replace function public.platform_support_session_start(p_merchant uuid, p_reason text, p_minutes int default null, p_ticket uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings jsonb := public._platform_support_settings();
  v_minutes int := coalesce(p_minutes, (v_settings ->> 'session_default_minutes')::int, 30);
  v_max int := least(coalesce((v_settings ->> 'session_max_minutes')::int, 120), 240);
  m public.merchants;
  s public.support_sessions;
begin
  select * into m from public.merchants where id = p_merchant;
  if m.id is null or not public.platform_can('support', 'view', m.id) then
    raise exception 'NOT_FOUND: merchant not found' using errcode = 'P0002';
  end if;
  perform public._platform_require('support', 'edit', m.id);
  if m.status = 'CLOSED' then
    raise exception 'VALIDATION: this merchant is closed' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 10 then
    raise exception 'VALIDATION: say why you need to see the merchant''s screens (it is logged and shown to the merchant)' using errcode = '22023';
  end if;
  if v_minutes < 5 or v_minutes > v_max then
    raise exception 'VALIDATION: a session lasts 5 to % minutes', v_max using errcode = '22023';
  end if;
  if p_ticket is not null and not exists (select 1 from public.support_tickets where id = p_ticket and merchant_id = m.id) then
    raise exception 'VALIDATION: that ticket belongs to another merchant' using errcode = '22023';
  end if;
  perform public._platform_support_expire();
  -- One open session per person.
  for s in
    update public.support_sessions set ended_at = now(), ended_by = auth.uid(), end_reason = 'Replaced by a new session'
    where staff_user_id = auth.uid() and ended_at is null returning *
  loop
    perform public._platform_log('support.session_ended', s.merchant_id, 'support_session', s.id::text, 'Replaced by a new session', null,
      jsonb_build_object('minutes', round(extract(epoch from now() - s.started_at) / 60)));
  end loop;
  insert into public.support_sessions (staff_user_id, merchant_id, mode, reason, ticket_id, expires_at)
  values (auth.uid(), m.id, 'VIEW', left(trim(p_reason), 500), p_ticket, now() + make_interval(mins => v_minutes))
  returning * into s;
  if p_ticket is not null then
    perform public._platform_ticket_event(p_ticket, m.id, 'SESSION', trim(p_reason), jsonb_build_object('session_id', s.id, 'minutes', v_minutes));
  end if;
  perform public._platform_log('support.session_started', m.id, 'support_session', s.id::text, trim(p_reason), null,
    jsonb_build_object('mode', 'VIEW', 'minutes', v_minutes, 'expires_at', s.expires_at, 'ticket_id', p_ticket));
  return public._platform_session_json(s);
end;
$$;

-- Ends the caller's open session (p_id null), or a named one. Ending someone
-- else's session needs support.manage.
create or replace function public.platform_support_session_end(p_id uuid default null, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s public.support_sessions;
begin
  if not public.is_platform_staff() then
    raise exception 'PERMISSION_DENIED: platform staff only' using errcode = '42501';
  end if;
  if p_id is null then
    select * into s from public.support_sessions where staff_user_id = auth.uid() and ended_at is null order by started_at desc limit 1;
    if s.id is null then
      return null;
    end if;
  else
    select * into s from public.support_sessions where id = p_id;
    if s.id is null or not public.platform_can('support', 'view', s.merchant_id) then
      raise exception 'NOT_FOUND: session not found' using errcode = 'P0002';
    end if;
    if s.staff_user_id <> auth.uid() then
      perform public._platform_require('support', 'manage', s.merchant_id);
      if length(trim(coalesce(p_reason, ''))) < 5 then
        raise exception 'VALIDATION: say why you are ending someone else''s session' using errcode = '22023';
      end if;
    end if;
  end if;
  if s.ended_at is not null then
    return public._platform_session_json(s);
  end if;
  update public.support_sessions set ended_at = least(now(), expires_at), ended_by = auth.uid(),
    end_reason = case when expires_at <= now() then 'Expired' else coalesce(nullif(trim(coalesce(p_reason, '')), ''), 'Ended') end
  where id = s.id returning * into s;
  perform public._platform_log(case when s.end_reason = 'Expired' then 'support.session_expired' else 'support.session_ended' end,
    s.merchant_id, 'support_session', s.id::text, s.end_reason, null,
    jsonb_build_object('minutes', round(extract(epoch from s.ended_at - s.started_at) / 60), 'by_owner', s.staff_user_id = auth.uid()));
  return public._platform_session_json(s);
end;
$$;

create or replace function public.platform_support_sessions(p jsonb default '{}'::jsonb, p_limit int default 100)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_merchant uuid := nullif(p ->> 'merchant', '')::uuid;
  v_active boolean := coalesce((p ->> 'active')::boolean, false);
begin
  perform public._platform_require('support', 'view', v_merchant);
  perform public._platform_support_expire();
  return jsonb_build_object(
    'mine', (select public._platform_session_json(s) from public.support_sessions s
             where s.staff_user_id = auth.uid() and s.ended_at is null and s.expires_at > now() order by s.started_at desc limit 1),
    'rows', (select coalesce(jsonb_agg(public._platform_session_json(s) order by s.started_at desc), '[]'::jsonb)
             from (select * from public.support_sessions s
                   where s.merchant_id in (select public._platform_merchant_ids())
                     and (v_merchant is null or s.merchant_id = v_merchant)
                     and (not v_active or (s.ended_at is null and s.expires_at > now()))
                   order by s.started_at desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) s),
    'settings', jsonb_build_object('default_minutes', (public._platform_support_settings() ->> 'session_default_minutes')::int,
                                   'max_minutes', (public._platform_support_settings() ->> 'session_max_minutes')::int),
    'can', jsonb_build_object('start', public.platform_can('support', 'edit', v_merchant), 'manage', public.platform_can('support', 'manage', v_merchant)));
end;
$$;

-- The merchant sees who from the platform looked at their account, and why.
create or replace function public.support_access_log(p_limit int default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('audit.view');
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', s.id, 'mode', s.mode, 'reason', s.reason,
        -- First name only: enough to recognise, without exposing the employee's details.
        'staff', coalesce((select split_part(coalesce(nullif(trim(ps.full_name), ''), split_part(ps.email, '@', 1)), ' ', 1) from public.platform_staff ps
                           where ps.user_id = s.staff_user_id), 'Platform support'),
        'ticket_number', (select t.number from public.support_tickets t where t.id = s.ticket_id and not t.internal),
        'started_at', s.started_at, 'ended_at', least(coalesce(s.ended_at, s.expires_at), greatest(now(), s.started_at)),
        'active', s.ended_at is null and s.expires_at > now()) order by s.started_at desc)
    from (select * from public.support_sessions s where s.merchant_id = public.current_merchant_id()
          order by s.started_at desc limit least(greatest(coalesce(p_limit, 50), 1), 200)) s), '[]'::jsonb);
end;
$$;

-- get_my_access: during a support session the platform employee sees the
-- merchant as a read-only viewer (every *.view permission, nothing else).
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.get_my_access()'::regprocedure));
  v_new text;
begin
  if position('v_device public.staff_devices;' in v_old) = 0 or position('select * into v_p from public.profiles where id = auth.uid() and is_active;' in v_old) = 0 then
    raise exception 'support center: get_my_access() has changed; update this migration';
  end if;
  v_new := pg_temp.lf_replace(v_old, 'v_device public.staff_devices;', 'v_device public.staff_devices;
  v_support jsonb := public._platform_support_session_info();');
  v_new := pg_temp.lf_replace(v_new, 'select * into v_p from public.profiles where id = auth.uid() and is_active;', $r$if v_support is not null then
    return jsonb_build_object(
      'user_id', auth.uid(),
      'merchant_id', (v_support ->> 'merchant_id')::uuid,
      'access_mode', public.merchant_access_mode((v_support ->> 'merchant_id')::uuid),
      'merchant', (select jsonb_build_object('id', m.id, 'number', m.number, 'name', m.name, 'status', m.status)
                   from public.merchants m where m.id = (v_support ->> 'merchant_id')::uuid),
      'email', v_support ->> 'email',
      'full_name', v_support ->> 'full_name',
      'role', 'SUPPORT_VIEW',
      'role_name', 'Platform support (view only)',
      'device_blocked', false,
      'device', jsonb_build_object('required', false, 'id', null, 'status', null),
      'idle_logout_minutes', 0,
      'pbx_click_to_call', false,
      'support_session', v_support - 'email' - 'full_name' - 'merchant_id',
      'permissions', (select coalesce(jsonb_agg(code order by code), '[]'::jsonb) from public.permissions where code like '%.view'));
  end if;
  select * into v_p from public.profiles where id = auth.uid() and is_active;$r$);
  execute v_new;
end $$;

-- A support viewer's browser is not one of the merchant's devices.
do $$
declare
  v_old text := pg_temp.lf(pg_get_functiondef('public.device_register(text,text)'::regprocedure));
  v_check text := $c$raise exception 'PERMISSION_DENIED: staff only' using errcode = '42501';
  end if;$c$;
begin
  if position(pg_temp.lf(v_check) in v_old) = 0 then
    raise exception 'support center: device_register() has changed; update this migration';
  end if;
  execute pg_temp.lf_replace(v_old, v_check, v_check || $a$
  if public._support_session_id() is not null then
    return null;
  end if;$a$);
end $$;

-- -----------------------------------------------------------------------------
-- 4. platform_me: unread notifications and the open customer-view session
-- -----------------------------------------------------------------------------
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
                          and a.requested_by <> s.user_id and public.platform_can(a.module, 'approve', a.merchant_id)),
    'unread_notifications', (select count(*) from public.platform_notifications n where n.user_id = s.user_id and n.read_at is null),
    'support_session', (select public._platform_session_json(ss) from public.support_sessions ss
                        where ss.staff_user_id = s.user_id and ss.ended_at is null and ss.expires_at > now() order by ss.started_at desc limit 1)
  );
end;
$$;

-- The support settings have their own validated function.
create or replace function public.platform_setting_save(p_key text, p_value jsonb, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb;
begin
  if p_key like 'usage.%' then
    -- Validated, permission-checked and versioned there.
    return public.platform_usage_policy_save(upper(substr(p_key, 7)), p_value, coalesce(p_reason, 'Settings change'));
  end if;
  if p_key = 'support' then
    return public.platform_support_settings_save(p_value, p_reason);
  end if;
  if p_key in ('sms', 'bd_courier', 'billing_gateways') then
    raise exception 'VALIDATION: % is changed on its own page (it holds connection state)', p_key using errcode = '22023';
  end if;
  perform public._platform_require('settings', 'edit');
  if p_key = 'access_rules' then
    perform public._platform_require('subscriptions', 'manage');
    if exists (select 1 from jsonb_each_text(p_value) e where e.value not in ('FULL', 'READ_ONLY', 'BLOCKED')) then
      raise exception 'VALIDATION: each rule is FULL, READ_ONLY or BLOCKED' using errcode = '22023';
    end if;
  end if;
  if p_key = 'credits' then
    perform public._platform_require('credits', 'manage');
    if coalesce((p_value ->> 'approval_threshold')::int, -1) < 0 then
      raise exception 'VALIDATION: the approval threshold is a number of credits (0 or more)' using errcode = '22023';
    end if;
  end if;
  if p_key !~ '^[a-z0-9_.]{2,60}$' or jsonb_typeof(p_value) <> 'object' then
    raise exception 'VALIDATION: bad setting' using errcode = '22023';
  end if;
  select value into v_before from public.platform_settings where key = p_key;
  insert into public.platform_settings (key, value, updated_by) values (p_key, p_value, auth.uid())
  on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by;
  perform public._config_version(case when p_key = 'access_rules' then 'access_rules' else 'platform_setting' end, p_key, p_value, p_reason);
  perform public._platform_log('settings.changed', null, 'platform_setting', p_key, p_reason, v_before, p_value);
  return p_value;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Grants, global tables, exemptions and ownership
-- -----------------------------------------------------------------------------
create or replace function public._tenancy_global_tables()
returns text[]
language sql
immutable
as $$
  select array['permissions', 'order_status_transitions', 'pbx_packages', 'pbx_gateway_status',
               'merchants', 'platform_staff', 'support_sessions', 'tenancy_exempt_functions',
               'platform_settings', 'platform_audit_logs', 'platform_credentials',
               'platform_modules', 'platform_roles', 'platform_role_permissions', 'platform_staff_merchants',
               'merchant_notes', 'platform_approvals', 'config_versions', 'features', 'plans', 'plan_addons',
               'credit_types', 'credit_packages', 'platform_notifications', 'support_ticket_events']
$$;

do $$
declare
  f text;
begin
  foreach f in array array['platform_notifications_list(integer)', 'platform_notifications_read(bigint[])',
    'platform_tickets_list(jsonb,integer,integer)', 'platform_ticket_get(uuid)', 'platform_ticket_create(jsonb)', 'platform_ticket_reply(uuid,text)',
    'platform_ticket_note(uuid,text)', 'platform_ticket_escalate(uuid,text)', 'platform_ticket_update(uuid,jsonb)',
    'platform_support_settings_save(jsonb,text)', 'platform_support_session_start(uuid,text,integer,uuid)',
    'platform_support_session_end(uuid,text)', 'platform_support_sessions(jsonb,integer)', 'support_access_log(integer)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['_platform_staff_can(uuid,text,text,uuid)',
    '_platform_notify(text,text,uuid,text,text,text,text,text,text,uuid[])', '_platform_support_settings()',
    '_platform_ticket_event(uuid,uuid,text,text,jsonb)', '_platform_ticket_sla()', '_platform_ticket_created()', '_platform_ticket_message()',
    '_platform_ticket_get_row(uuid,text)', '_platform_ticket_json(public.support_tickets)', '_platform_ticket_assignee_ok(uuid,uuid)',
    '_platform_ticket_escalate(public.support_tickets,text,boolean)', '_platform_session_json(public.support_sessions)',
    '_platform_support_expire()']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
  -- get_my_access (owned by app_owner) asks for the open session.
  execute 'revoke execute on function public._platform_support_session_info() from public, anon';
  execute 'grant execute on function public._platform_support_session_info() to authenticated, app_owner';
end $$;

insert into public.tenancy_exempt_functions (name, reason)
select f, 'Support center: platform staff work across merchants and check platform permissions themselves'
from unnest(array['_platform_staff_can', '_platform_notify', 'platform_notifications_list', 'platform_notifications_read',
  '_platform_support_settings', '_platform_ticket_event', '_platform_ticket_sla', '_platform_ticket_created', '_platform_ticket_message',
  '_platform_ticket_get_row', '_platform_ticket_json', '_platform_ticket_assignee_ok', '_platform_ticket_escalate',
  'platform_tickets_list', 'platform_ticket_get', 'platform_ticket_create', 'platform_ticket_reply', 'platform_ticket_note',
  'platform_ticket_escalate', 'platform_ticket_update', 'platform_support_settings_save', '_platform_session_json', '_platform_support_expire',
  '_platform_support_session_info', 'platform_support_session_start', 'platform_support_session_end', 'platform_support_sessions']) f
on conflict (name) do nothing;
insert into public.tenancy_exempt_functions (name, reason)
values ('support_access_log', 'Shows the signed-in merchant the platform support sessions on their own account (filters by current_merchant_id())')
on conflict (name) do nothing;

select public._tenancy_own_functions();
