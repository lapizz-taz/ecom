-- =============================================================================
-- Messaging inbox: Facebook Messenger, Instagram DMs, WhatsApp, and Facebook /
-- Instagram post and ad comments in one inbox (Inbox → Inbox).
--
--   inbox_channels       a connected Facebook Page, Instagram account or WhatsApp
--                        number (its access token lives in Vault: inbox.channel.<id>)
--   inbox_conversations  one per customer per channel (DMs) or per comment thread
--   inbox_messages       every message in and out, once per platform message id
--   inbox_notes          staff notes on a conversation
--   inbox_saved_replies  quick replies staff pick from the composer
--
-- The `inbox` function receives the platforms' webhooks and sends replies; it
-- writes through the system-only functions below. Staff read and change
-- conversations through the inbox_* functions (inbox.view / inbox.reply /
-- inbox.manage). Nothing here sends messages by itself.
-- =============================================================================

create table if not exists public.inbox_channels (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null default public.current_merchant_id() references public.merchants(id),
  platform text not null check (platform in ('FACEBOOK', 'INSTAGRAM', 'WHATSAPP')),
  -- Page id, Instagram account id or WhatsApp phone number id (what the webhooks name).
  external_id text not null check (external_id ~ '^[0-9]{3,40}$'),
  name text not null check (length(name) between 1 and 120),
  username text check (length(username) <= 120),
  avatar_url text check (length(avatar_url) <= 1000),
  -- Instagram is sent through its Facebook Page; WhatsApp numbers belong to a business account.
  page_id text check (page_id ~ '^[0-9]{3,40}$'),
  waba_id text check (waba_id ~ '^[0-9]{3,40}$'),
  display_phone text check (length(display_phone) <= 30),
  receive_comments boolean not null default true,
  status text not null default 'OK' check (status in ('OK', 'FAILED', 'DISCONNECTED')),
  status_error text check (length(status_error) <= 500),
  token_hint text check (length(token_hint) <= 20),
  last_event_at timestamptz,
  connected_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (merchant_id, platform, external_id)
);

create table if not exists public.inbox_conversations (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null default public.current_merchant_id() references public.merchants(id),
  channel_id uuid not null references public.inbox_channels(id) on delete cascade,
  kind text not null default 'MESSAGE' check (kind in ('MESSAGE', 'COMMENT')),
  -- DMs: the customer's id on the platform (PSID, IGSID, WhatsApp number).
  -- Comments: the top-level comment id (replies go under it).
  thread_key text not null check (length(thread_key) between 1 and 200),
  customer_external_id text check (length(customer_external_id) <= 200),
  customer_name text check (length(customer_name) <= 200),
  customer_avatar text check (length(customer_avatar) <= 1000),
  customer_phone text check (length(customer_phone) <= 30),
  customer_address text check (length(customer_address) <= 300),
  customer_id uuid references public.customers(id) on delete set null,
  -- Comments: the post or ad the comment is on.
  post jsonb check (post is null or jsonb_typeof(post) = 'object'),
  status text not null default 'OPEN' check (status in ('OPEN', 'FOLLOW_UP', 'DONE')),
  assigned_to uuid references public.profiles(id) on delete set null,
  starred boolean not null default false,
  labels text[] not null default '{}' check (cardinality(labels) <= 20),
  pinned_message_id uuid,
  linked_order_id uuid references public.orders(id) on delete set null,
  unread_count int not null default 0 check (unread_count >= 0),
  last_message_at timestamptz,
  last_message_preview text check (length(last_message_preview) <= 200),
  last_message_direction text check (last_message_direction in ('IN', 'OUT')),
  -- Messenger and Instagram allow a free reply for 24 hours after the customer writes.
  last_customer_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel_id, kind, thread_key)
);
create index if not exists inbox_conversations_recent_idx on public.inbox_conversations (merchant_id, status, last_message_at desc nulls last);
create index if not exists inbox_conversations_phone_idx on public.inbox_conversations (merchant_id, customer_phone) where customer_phone is not null;

create table if not exists public.inbox_messages (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null default public.current_merchant_id() references public.merchants(id),
  conversation_id uuid not null references public.inbox_conversations(id) on delete cascade,
  direction text not null check (direction in ('IN', 'OUT')),
  external_id text check (length(external_id) <= 300),
  body text check (length(body) <= 8000),
  -- [{type: image|video|audio|file|product|sticker|location, url, name, ...}]
  attachments jsonb not null default '[]' check (jsonb_typeof(attachments) = 'array'),
  reply_to_id uuid references public.inbox_messages(id) on delete set null,
  sender_name text check (length(sender_name) <= 200),
  sent_by uuid references public.profiles(id) on delete set null,
  status text not null default 'SENT' check (status in ('RECEIVED', 'SENT', 'DELIVERED', 'READ', 'FAILED')),
  error text check (length(error) <= 500),
  created_at timestamptz not null default now()
);
create unique index if not exists inbox_messages_external_idx on public.inbox_messages (conversation_id, external_id) where external_id is not null;
create index if not exists inbox_messages_thread_idx on public.inbox_messages (conversation_id, created_at desc);
alter table public.inbox_conversations drop constraint if exists inbox_conversations_pinned_fk;
alter table public.inbox_conversations add constraint inbox_conversations_pinned_fk
  foreign key (pinned_message_id) references public.inbox_messages(id) on delete set null;

create table if not exists public.inbox_notes (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null default public.current_merchant_id() references public.merchants(id),
  conversation_id uuid not null references public.inbox_conversations(id) on delete cascade,
  body text not null check (length(trim(body)) between 1 and 2000),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists inbox_notes_thread_idx on public.inbox_notes (conversation_id, created_at desc);

create table if not exists public.inbox_saved_replies (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null default public.current_merchant_id() references public.merchants(id),
  title text not null check (length(trim(title)) between 1 and 80),
  body text not null check (length(trim(body)) between 1 and 2000),
  sort_order int not null default 0,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Merchant isolation like every other table. Staff never read these tables
-- directly: the inbox_* functions below are the only way in.
do $$
declare t text;
begin
  foreach t in array array['inbox_channels', 'inbox_conversations', 'inbox_messages', 'inbox_notes', 'inbox_saved_replies'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format($p$create policy tenant_isolation on public.%I as restrictive for all to public
      using (merchant_id = (select public.current_merchant_id()))
      with check (merchant_id = (select public.current_merchant_id()) and not (select public._support_read_only()))$p$, t);
    execute format('drop policy if exists app_owner_all on public.%I', t);
    execute format('create policy app_owner_all on public.%I for all to app_owner using (true) with check (true)', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- permissions
insert into public.permissions(code, module, name) values
  ('inbox.view', 'inbox', 'Read the messaging inbox'),
  ('inbox.reply', 'inbox', 'Reply to customers, label, assign and close conversations'),
  ('inbox.manage', 'inbox', 'Connect Facebook, Instagram and WhatsApp and edit saved replies')
on conflict (code) do nothing;

create or replace function public._seed_inbox_permissions(p_merchant uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.role_permissions (merchant_id, role_id, permission_id)
  select p_merchant, r.id, p.id
  from (values
    ('ADMIN', 'inbox.view'), ('ADMIN', 'inbox.reply'), ('ADMIN', 'inbox.manage'),
    ('MANAGER', 'inbox.view'), ('MANAGER', 'inbox.reply'),
    ('ORDER_MANAGER', 'inbox.view'), ('ORDER_MANAGER', 'inbox.reply'),
    ('CALL', 'inbox.view'), ('CALL', 'inbox.reply')
  ) g(role_code, perm)
  join public.roles r on r.merchant_id = p_merchant and r.code = g.role_code
  join public.permissions p on p.code = g.perm
  on conflict do nothing
$$;
revoke all on function public._seed_inbox_permissions(uuid) from public, anon, authenticated;

do $$
declare m record;
begin
  for m in select id from public.merchants loop
    perform set_config('app.merchant_id', m.id::text, true);
    perform public._seed_inbox_permissions(m.id);
  end loop;
  perform set_config('app.merchant_id', '', true);
end $$;

-- New stores: once their default roles exist (Viewer, then Call, come last).
create or replace function public._roles_seed_inbox()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.code in ('VIEWER', 'CALL') then
    perform public._seed_inbox_permissions(new.merchant_id);
  end if;
  return new;
end;
$$;
drop trigger if exists roles_seed_inbox on public.roles;
create trigger roles_seed_inbox after insert on public.roles for each row execute function public._roles_seed_inbox();

-- ---------------------------------------------------------------- helpers
create or replace function public._inbox_preview(p_body text, p_attachments jsonb)
returns text
language sql
immutable
as $$
  select left(coalesce(nullif(trim(regexp_replace(coalesce(p_body, ''), '\s+', ' ', 'g')), ''),
    case coalesce(p_attachments -> 0 ->> 'type', '')
      when 'image' then 'Photo' when 'video' then 'Video' when 'audio' then 'Voice message'
      when 'product' then 'Product' when 'sticker' then 'Sticker' when 'location' then 'Location'
      when '' then '' else 'Attachment' end), 200)
$$;

-- The store's customer with this phone number (Bangladesh numbers end the same way however they are typed).
create or replace function public._inbox_customer_for_phone(p_phone text)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select c.id from public.customers c
  where length(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')) >= 10
    and right(regexp_replace(c.phone, '\D', '', 'g'), 10) = right(regexp_replace(p_phone, '\D', '', 'g'), 10)
  order by c.last_order_at desc nulls last
  limit 1
$$;
revoke all on function public._inbox_customer_for_phone(text) from public, anon, authenticated;

-- ---------------------------------------------------------------- system (the inbox function)
-- Add or update a connected channel. Returns the row (no secrets live here).
create or replace function public.inbox_channel_save(p jsonb, p_actor uuid default null)
returns public.inbox_channels
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.inbox_channels;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  insert into public.inbox_channels (platform, external_id, name, username, avatar_url, page_id, waba_id, display_phone,
    receive_comments, status, status_error, token_hint, connected_by)
  values (p ->> 'platform', p ->> 'external_id', left(coalesce(nullif(p ->> 'name', ''), p ->> 'external_id'), 120),
    nullif(p ->> 'username', ''), nullif(p ->> 'avatar_url', ''), nullif(p ->> 'page_id', ''), nullif(p ->> 'waba_id', ''),
    nullif(p ->> 'display_phone', ''), coalesce((p ->> 'receive_comments')::boolean, true), coalesce(p ->> 'status', 'OK'),
    nullif(p ->> 'status_error', ''), nullif(p ->> 'token_hint', ''), p_actor)
  on conflict (merchant_id, platform, external_id) do update set
    name = excluded.name, username = coalesce(excluded.username, inbox_channels.username),
    avatar_url = coalesce(excluded.avatar_url, inbox_channels.avatar_url), page_id = coalesce(excluded.page_id, inbox_channels.page_id),
    waba_id = coalesce(excluded.waba_id, inbox_channels.waba_id), display_phone = coalesce(excluded.display_phone, inbox_channels.display_phone),
    receive_comments = excluded.receive_comments, status = excluded.status, status_error = excluded.status_error,
    token_hint = coalesce(excluded.token_hint, inbox_channels.token_hint), connected_by = coalesce(excluded.connected_by, inbox_channels.connected_by),
    updated_at = now()
  returning * into v_row;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, new_values)
  values (p_actor, 'inbox_channel.saved', 'inbox_channel', v_row.id, jsonb_build_object('platform', v_row.platform, 'name', v_row.name, 'status', v_row.status));
  return v_row;
end;
$$;

create or replace function public.inbox_channel_status(p_id uuid, p_status text, p_error text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.inbox_channels set status = p_status, status_error = left(p_error, 500), updated_at = now() where id = p_id;
end;
$$;

-- Channels for the function: by id, by the id a webhook names, or all of them.
create or replace function public.inbox_channels_for(p_id uuid default null, p_platform text default null, p_external_id text default null)
returns setof public.inbox_channels
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query select * from public.inbox_channels c
    where (p_id is null or c.id = p_id)
      and (p_platform is null or c.platform = p_platform)
      and (p_external_id is null or c.external_id = p_external_id or (c.platform = 'INSTAGRAM' and c.page_id = p_external_id))
    order by c.created_at;
end;
$$;

-- One incoming (or echoed outgoing) message. Creates the conversation the first
-- time; a platform message id is stored once, so webhook retries change nothing.
-- p: {channel_id, kind, thread_key, customer:{external_id,name,avatar,phone}, post,
--     message:{external_id, direction, body, attachments, reply_to_external_id, sender_name, created_at}}
create or replace function public.inbox_ingest(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_channel public.inbox_channels;
  v_conv public.inbox_conversations;
  v_msg jsonb := coalesce(p -> 'message', '{}'::jsonb);
  v_cust jsonb := coalesce(p -> 'customer', '{}'::jsonb);
  v_dir text := coalesce(v_msg ->> 'direction', 'IN');
  v_at timestamptz := coalesce((v_msg ->> 'created_at')::timestamptz, now());
  v_attach jsonb := case when jsonb_typeof(v_msg -> 'attachments') = 'array' then v_msg -> 'attachments' else '[]'::jsonb end;
  v_reply uuid;
  v_id uuid;
  v_phone text := nullif(regexp_replace(coalesce(v_cust ->> 'phone', ''), '[^0-9+]', '', 'g'), '');
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select * into v_channel from public.inbox_channels where id = (p ->> 'channel_id')::uuid;
  if v_channel.id is null then
    raise exception 'NOT_FOUND: unknown inbox channel' using errcode = 'P0001';
  end if;

  insert into public.inbox_conversations (channel_id, kind, thread_key, customer_external_id, customer_name, customer_avatar, customer_phone, post, customer_id)
  values (v_channel.id, coalesce(p ->> 'kind', 'MESSAGE'), p ->> 'thread_key', nullif(v_cust ->> 'external_id', ''),
    left(nullif(v_cust ->> 'name', ''), 200), left(nullif(v_cust ->> 'avatar', ''), 1000), left(v_phone, 30),
    case when jsonb_typeof(p -> 'post') = 'object' then p -> 'post' end,
    public._inbox_customer_for_phone(v_phone))
  on conflict (channel_id, kind, thread_key) do update set
    customer_name = coalesce(inbox_conversations.customer_name, excluded.customer_name),
    customer_avatar = coalesce(excluded.customer_avatar, inbox_conversations.customer_avatar),
    customer_phone = coalesce(inbox_conversations.customer_phone, excluded.customer_phone),
    customer_id = coalesce(inbox_conversations.customer_id, excluded.customer_id),
    post = coalesce(excluded.post, inbox_conversations.post)
  returning * into v_conv;

  if nullif(v_msg ->> 'external_id', '') is not null then
    select id into v_id from public.inbox_messages where conversation_id = v_conv.id and external_id = v_msg ->> 'external_id';
    if v_id is not null then
      -- Meta's echo of a file sent from here carries its link; keep it.
      update public.inbox_messages set attachments = v_attach
      where id = v_id and jsonb_array_length(v_attach) > 0
        and not exists (select 1 from jsonb_array_elements(attachments) a where a ? 'url' or a ? 'media_id');
      return jsonb_build_object('conversation_id', v_conv.id, 'message_id', v_id, 'duplicate', true,
        'needs_profile', v_conv.customer_name is null and v_conv.kind = 'MESSAGE');
    end if;
  end if;
  if nullif(v_msg ->> 'reply_to_external_id', '') is not null then
    select id into v_reply from public.inbox_messages where conversation_id = v_conv.id and external_id = v_msg ->> 'reply_to_external_id';
  end if;

  insert into public.inbox_messages (conversation_id, direction, external_id, body, attachments, reply_to_id, sender_name, status, created_at)
  values (v_conv.id, v_dir, nullif(v_msg ->> 'external_id', ''), left(v_msg ->> 'body', 8000), v_attach, v_reply,
    left(nullif(v_msg ->> 'sender_name', ''), 200), case when v_dir = 'IN' then 'RECEIVED' else 'SENT' end, v_at)
  returning id into v_id;

  update public.inbox_conversations set
    last_message_at = greatest(coalesce(last_message_at, v_at), v_at),
    last_message_preview = case when v_at >= coalesce(last_message_at, v_at) then public._inbox_preview(v_msg ->> 'body', v_attach) else last_message_preview end,
    last_message_direction = case when v_at >= coalesce(last_message_at, v_at) then v_dir else last_message_direction end,
    last_customer_message_at = case when v_dir = 'IN' then greatest(coalesce(last_customer_message_at, v_at), v_at) else last_customer_message_at end,
    unread_count = unread_count + case when v_dir = 'IN' then 1 else 0 end,
    -- A customer writing again reopens a closed conversation.
    status = case when v_dir = 'IN' and status = 'DONE' then 'OPEN' else status end,
    updated_at = now()
  where id = v_conv.id;
  update public.inbox_channels set last_event_at = now() where id = v_channel.id;
  return jsonb_build_object('conversation_id', v_conv.id, 'message_id', v_id, 'duplicate', false,
    'needs_profile', v_conv.customer_name is null and v_conv.kind = 'MESSAGE');
end;
$$;

-- The customer's name and picture, looked up on Meta when a conversation starts.
create or replace function public.inbox_set_profile(p_conversation uuid, p_name text, p_avatar text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.inbox_conversations set customer_name = coalesce(customer_name, left(nullif(trim(p_name), ''), 200)),
    customer_avatar = coalesce(left(nullif(p_avatar, ''), 1000), customer_avatar)
  where id = p_conversation;
end;
$$;

-- What the function needs to send into a conversation.
create or replace function public.inbox_send_context(p_conversation uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'conversation_id', c.id, 'kind', c.kind, 'thread_key', c.thread_key, 'customer_external_id', c.customer_external_id,
    'last_customer_message_at', c.last_customer_message_at,
    'channel', jsonb_build_object('id', ch.id, 'platform', ch.platform, 'external_id', ch.external_id, 'page_id', ch.page_id, 'status', ch.status, 'name', ch.name))
  into v
  from public.inbox_conversations c join public.inbox_channels ch on ch.id = c.channel_id
  where c.id = p_conversation;
  if v is null then
    raise exception 'NOT_FOUND: conversation not found' using errcode = 'P0001';
  end if;
  return v;
end;
$$;

-- A message staff sent (or tried to send).
create or replace function public.inbox_record_outgoing(p jsonb, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_conv uuid := (p ->> 'conversation_id')::uuid;
  v_attach jsonb := case when jsonb_typeof(p -> 'attachments') = 'array' then p -> 'attachments' else '[]'::jsonb end;
  v_failed boolean := nullif(p ->> 'error', '') is not null;
  v_id uuid;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if not exists (select 1 from public.inbox_conversations where id = v_conv) then
    raise exception 'NOT_FOUND: conversation not found' using errcode = 'P0001';
  end if;
  insert into public.inbox_messages (conversation_id, direction, external_id, body, attachments, reply_to_id, sender_name, sent_by, status, error)
  values (v_conv, 'OUT', nullif(p ->> 'external_id', ''), left(p ->> 'body', 8000), v_attach,
    nullif(p ->> 'reply_to_id', '')::uuid, (select full_name from public.profiles where id = p_actor), p_actor,
    case when v_failed then 'FAILED' else 'SENT' end, left(p ->> 'error', 500))
  on conflict (conversation_id, external_id) where external_id is not null do nothing
  returning id into v_id;
  if not v_failed then
    update public.inbox_conversations set last_message_at = now(), last_message_preview = public._inbox_preview(p ->> 'body', v_attach),
      last_message_direction = 'OUT', unread_count = 0, updated_at = now()
    where id = v_conv;
  end if;
  return jsonb_build_object('message_id', v_id);
end;
$$;

-- Delivery and read receipts.
create or replace function public.inbox_message_status(p_channel uuid, p_external_id text, p_status text, p_error text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.inbox_messages m set status = p_status, error = coalesce(left(p_error, 500), m.error)
  from public.inbox_conversations c
  where c.id = m.conversation_id and c.channel_id = p_channel and m.external_id = p_external_id and m.direction = 'OUT'
    and (case m.status when 'SENT' then 1 when 'DELIVERED' then 2 when 'READ' then 3 else 0 end)
      < (case p_status when 'DELIVERED' then 2 when 'READ' then 3 when 'FAILED' then 4 else 0 end);
end;
$$;

-- Messenger read receipt: everything sent before the watermark has been seen.
create or replace function public.inbox_mark_seen_until(p_channel uuid, p_thread_key text, p_until timestamptz)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.inbox_messages m set status = 'READ'
  from public.inbox_conversations c
  where c.id = m.conversation_id and c.channel_id = p_channel and c.thread_key = p_thread_key and c.kind = 'MESSAGE'
    and m.direction = 'OUT' and m.status in ('SENT', 'DELIVERED') and m.created_at <= p_until;
end;
$$;

-- ---------------------------------------------------------------- staff
create or replace function public.inbox_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('inbox.view');
  return jsonb_build_object(
    'channels', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'platform', platform, 'name', name, 'username', username,
        'avatar_url', avatar_url, 'display_phone', display_phone, 'status', status, 'status_error', status_error,
        'receive_comments', receive_comments, 'token_hint', token_hint, 'last_event_at', last_event_at, 'created_at', created_at) order by created_at)
      from public.inbox_channels), '[]'::jsonb),
    'counts', jsonb_build_object(
      'open', (select count(*) from public.inbox_conversations where status = 'OPEN'),
      'follow_up', (select count(*) from public.inbox_conversations where status = 'FOLLOW_UP'),
      'done', (select count(*) from public.inbox_conversations where status = 'DONE'),
      'unread', (select count(*) from public.inbox_conversations where unread_count > 0 and status <> 'DONE'),
      'mine', (select count(*) from public.inbox_conversations where assigned_to = auth.uid() and status <> 'DONE'),
      'unassigned', (select count(*) from public.inbox_conversations where assigned_to is null and status <> 'DONE'),
      'starred', (select count(*) from public.inbox_conversations where starred)),
    'labels', coalesce((select jsonb_agg(l order by l) from (select distinct unnest(labels) l from public.inbox_conversations) x), '[]'::jsonb));
end;
$$;

-- p: {status, platform, kind, unread, assigned: me|none, label, starred, q, limit, offset}
create or replace function public.inbox_list(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_q text := nullif(trim(p ->> 'q'), '');
  v_limit int := least(greatest(coalesce((p ->> 'limit')::int, 50), 1), 200);
  v_offset int := greatest(coalesce((p ->> 'offset')::int, 0), 0);
begin
  perform public.require_permission('inbox.view');
  return (
    with rows as (
      select c.*, ch.platform, ch.name as channel_name, pr.full_name as assigned_name
      from public.inbox_conversations c
      join public.inbox_channels ch on ch.id = c.channel_id
      left join public.profiles pr on pr.id = c.assigned_to
      where (nullif(p ->> 'status', '') is null or c.status = p ->> 'status')
        and (nullif(p ->> 'platform', '') is null or ch.platform = p ->> 'platform')
        and (nullif(p ->> 'kind', '') is null or c.kind = p ->> 'kind')
        and (coalesce((p ->> 'unread')::boolean, false) = false or c.unread_count > 0)
        and (coalesce((p ->> 'starred')::boolean, false) = false or c.starred)
        and (p ->> 'assigned' is distinct from 'me' or c.assigned_to = auth.uid())
        and (p ->> 'assigned' is distinct from 'none' or c.assigned_to is null)
        and (nullif(p ->> 'label', '') is null or (p ->> 'label') = any (c.labels))
        and (v_q is null or c.customer_name ilike '%' || v_q || '%' or c.customer_phone ilike '%' || v_q || '%'
             or c.last_message_preview ilike '%' || v_q || '%'
             or exists (select 1 from public.inbox_messages m where m.conversation_id = c.id and m.body ilike '%' || v_q || '%'))
    )
    select jsonb_build_object(
      'total', (select count(*) from rows),
      'items', coalesce((select jsonb_agg(jsonb_build_object(
          'id', r.id, 'channel_id', r.channel_id, 'platform', r.platform, 'channel_name', r.channel_name, 'kind', r.kind,
          'customer_name', r.customer_name, 'customer_avatar', r.customer_avatar, 'customer_phone', r.customer_phone,
          'status', r.status, 'starred', r.starred, 'labels', to_jsonb(r.labels), 'assigned_to', r.assigned_to, 'assigned_name', r.assigned_name,
          'unread_count', r.unread_count, 'last_message_at', r.last_message_at, 'last_message_preview', r.last_message_preview,
          'last_message_direction', r.last_message_direction, 'linked_order_id', r.linked_order_id,
          'post_title', r.post ->> 'title') order by r.last_message_at desc nulls last, r.created_at desc)
        from (select * from rows order by last_message_at desc nulls last, created_at desc limit v_limit offset v_offset) r), '[]'::jsonb))
  );
end;
$$;

-- One conversation with its newest messages (p_before pages back), notes and the customer's orders.
create or replace function public.inbox_thread(p_id uuid, p_before timestamptz default null, p_limit int default 60)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_conv public.inbox_conversations;
  v_customer uuid;
  v_digits text;
begin
  perform public.require_permission('inbox.view');
  select * into v_conv from public.inbox_conversations where id = p_id;
  if v_conv.id is null then
    raise exception 'NOT_FOUND: conversation not found' using errcode = 'P0001';
  end if;
  v_customer := coalesce(v_conv.customer_id, public._inbox_customer_for_phone(v_conv.customer_phone));
  v_digits := right(regexp_replace(coalesce(v_conv.customer_phone, ''), '\D', '', 'g'), 10);
  return jsonb_build_object(
    'conversation', (select to_jsonb(v_conv) || jsonb_build_object('platform', ch.platform, 'channel_name', ch.name,
        'channel_avatar', ch.avatar_url, 'channel_status', ch.status, 'assigned_name', pr.full_name)
      from public.inbox_channels ch left join public.profiles pr on pr.id = v_conv.assigned_to where ch.id = v_conv.channel_id),
    'messages', coalesce((select jsonb_agg(to_jsonb(m) || jsonb_build_object('reply_to',
        case when m.reply_to_id is not null then (select jsonb_build_object('id', r.id, 'body', public._inbox_preview(r.body, r.attachments), 'direction', r.direction)
          from public.inbox_messages r where r.id = m.reply_to_id) end) order by m.created_at)
      from (select * from public.inbox_messages where conversation_id = p_id and (p_before is null or created_at < p_before)
            order by created_at desc limit least(greatest(coalesce(p_limit, 60), 1), 200)) m), '[]'::jsonb),
    'has_more', exists (select 1 from public.inbox_messages where conversation_id = p_id
      and created_at < coalesce((select min(created_at) from (select created_at from public.inbox_messages where conversation_id = p_id
        and (p_before is null or created_at < p_before) order by created_at desc limit least(greatest(coalesce(p_limit, 60), 1), 200)) x), '-infinity')),
    'pinned', (select jsonb_build_object('id', m.id, 'body', public._inbox_preview(m.body, m.attachments), 'created_at', m.created_at)
      from public.inbox_messages m where m.id = v_conv.pinned_message_id),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'body', n.body, 'created_at', n.created_at, 'created_by_name', pr.full_name) order by n.created_at desc)
      from public.inbox_notes n left join public.profiles pr on pr.id = n.created_by where n.conversation_id = p_id), '[]'::jsonb),
    'customer', (select jsonb_build_object('id', c.id, 'full_name', c.full_name, 'phone', c.phone, 'email', c.email, 'address', c.address,
        'area', c.area, 'district', c.district, 'segment', c.segment, 'status', c.status, 'risk_level', c.risk_level, 'tags', to_jsonb(c.tags),
        'total_orders', c.total_orders, 'delivered_orders', c.delivered_orders, 'cancelled_orders', c.cancelled_orders,
        'returned_orders', c.returned_orders, 'total_spent', c.total_spent, 'last_order_at', c.last_order_at)
      from public.customers c where c.id = v_customer),
    'orders', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'order_number', o.order_number, 'status', o.status,
        'total_amount', o.total_amount, 'created_at', o.created_at, 'items', (select count(*) from public.order_items i where i.order_id = o.id),
        'linked', o.id = v_conv.linked_order_id) order by o.created_at desc)
      from (select * from public.orders o
            where o.id = v_conv.linked_order_id
               or (v_customer is not null and o.customer_id = v_customer)
               or (length(v_digits) = 10 and right(regexp_replace(o.customer_phone, '\D', '', 'g'), 10) = v_digits)
            order by o.created_at desc limit 10) o), '[]'::jsonb),
    'other_conversations', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'platform', ch.platform, 'kind', c.kind, 'status', c.status,
        'last_message_at', c.last_message_at, 'last_message_preview', c.last_message_preview) order by c.last_message_at desc nulls last)
      from public.inbox_conversations c join public.inbox_channels ch on ch.id = c.channel_id
      where c.id <> p_id and ((v_customer is not null and c.customer_id = v_customer)
        or (length(v_digits) = 10 and right(regexp_replace(c.customer_phone, '\D', '', 'g'), 10) = v_digits)
        or (v_conv.customer_external_id is not null and c.customer_external_id = v_conv.customer_external_id))), '[]'::jsonb)
  );
end;
$$;

create or replace function public.inbox_mark_read(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('inbox.view');
  update public.inbox_conversations set unread_count = 0 where id = p_id and unread_count > 0;
end;
$$;

-- p: any of {status, assigned_to, starred, labels, pinned_message_id, customer_name, customer_phone,
--            customer_address, customer_id, linked_order_id, unread}
create or replace function public.inbox_update(p_id uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_labels text[];
begin
  perform public.require_permission('inbox.reply');
  if not exists (select 1 from public.inbox_conversations where id = p_id) then
    raise exception 'NOT_FOUND: conversation not found' using errcode = 'P0001';
  end if;
  if p ? 'status' and (p ->> 'status') not in ('OPEN', 'FOLLOW_UP', 'DONE') then
    raise exception 'VALIDATION: unknown status' using errcode = '22023';
  end if;
  if p ? 'assigned_to' and nullif(p ->> 'assigned_to', '') is not null
     and not exists (select 1 from public.profiles where id = (p ->> 'assigned_to')::uuid) then
    raise exception 'VALIDATION: unknown staff member' using errcode = '22023';
  end if;
  if p ? 'pinned_message_id' and nullif(p ->> 'pinned_message_id', '') is not null
     and not exists (select 1 from public.inbox_messages where id = (p ->> 'pinned_message_id')::uuid and conversation_id = p_id) then
    raise exception 'VALIDATION: that message is not in this conversation' using errcode = '22023';
  end if;
  if p ? 'linked_order_id' and nullif(p ->> 'linked_order_id', '') is not null
     and not exists (select 1 from public.orders where id = (p ->> 'linked_order_id')::uuid) then
    raise exception 'VALIDATION: unknown order' using errcode = '22023';
  end if;
  if p ? 'customer_id' and nullif(p ->> 'customer_id', '') is not null
     and not exists (select 1 from public.customers where id = (p ->> 'customer_id')::uuid) then
    raise exception 'VALIDATION: unknown customer' using errcode = '22023';
  end if;
  if p ? 'labels' then
    select coalesce(array_agg(distinct left(trim(l), 40)) filter (where trim(l) <> ''), '{}') into v_labels
    from jsonb_array_elements_text(case when jsonb_typeof(p -> 'labels') = 'array' then p -> 'labels' else '[]'::jsonb end) l;
    if cardinality(v_labels) > 20 then
      raise exception 'VALIDATION: at most 20 labels' using errcode = '22023';
    end if;
  end if;
  update public.inbox_conversations set
    status = case when p ? 'status' then p ->> 'status' else status end,
    assigned_to = case when p ? 'assigned_to' then nullif(p ->> 'assigned_to', '')::uuid else assigned_to end,
    starred = case when p ? 'starred' then coalesce((p ->> 'starred')::boolean, false) else starred end,
    labels = case when p ? 'labels' then v_labels else labels end,
    pinned_message_id = case when p ? 'pinned_message_id' then nullif(p ->> 'pinned_message_id', '')::uuid else pinned_message_id end,
    customer_name = case when p ? 'customer_name' then left(nullif(trim(p ->> 'customer_name'), ''), 200) else customer_name end,
    customer_phone = case when p ? 'customer_phone' then left(nullif(regexp_replace(p ->> 'customer_phone', '[^0-9+]', '', 'g'), ''), 30) else customer_phone end,
    customer_address = case when p ? 'customer_address' then left(nullif(trim(p ->> 'customer_address'), ''), 300) else customer_address end,
    customer_id = case when p ? 'customer_id' then nullif(p ->> 'customer_id', '')::uuid
                       when p ? 'customer_phone' then coalesce(customer_id, public._inbox_customer_for_phone(p ->> 'customer_phone')) else customer_id end,
    linked_order_id = case when p ? 'linked_order_id' then nullif(p ->> 'linked_order_id', '')::uuid else linked_order_id end,
    unread_count = case when coalesce((p ->> 'unread')::boolean, false) then greatest(unread_count, 1) else unread_count end,
    updated_at = now()
  where id = p_id;
end;
$$;

create or replace function public.inbox_note_add(p_id uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  perform public.require_permission('inbox.reply');
  if not exists (select 1 from public.inbox_conversations where id = p_id) then
    raise exception 'NOT_FOUND: conversation not found' using errcode = 'P0001';
  end if;
  if length(trim(coalesce(p_body, ''))) = 0 then
    raise exception 'VALIDATION: write the note first' using errcode = '22023';
  end if;
  insert into public.inbox_notes (conversation_id, body, created_by) values (p_id, left(trim(p_body), 2000), auth.uid()) returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.inbox_note_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('inbox.reply');
  delete from public.inbox_notes where id = p_id;
end;
$$;

create or replace function public.inbox_saved_replies()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('inbox.view');
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'title', title, 'body', body) order by sort_order, title)
    from public.inbox_saved_replies), '[]'::jsonb);
end;
$$;

create or replace function public.inbox_saved_reply_save(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
begin
  perform public.require_permission('inbox.manage');
  if length(trim(coalesce(p ->> 'title', ''))) = 0 or length(trim(coalesce(p ->> 'body', ''))) = 0 then
    raise exception 'VALIDATION: give the reply a title and text' using errcode = '22023';
  end if;
  if v_id is null then
    insert into public.inbox_saved_replies (title, body, sort_order, created_by)
    values (left(trim(p ->> 'title'), 80), left(trim(p ->> 'body'), 2000), coalesce((p ->> 'sort_order')::int, 0), auth.uid())
    returning id into v_id;
  else
    update public.inbox_saved_replies set title = left(trim(p ->> 'title'), 80), body = left(trim(p ->> 'body'), 2000),
      sort_order = coalesce((p ->> 'sort_order')::int, sort_order), updated_at = now()
    where id = v_id;
    if not found then
      raise exception 'NOT_FOUND: saved reply not found' using errcode = 'P0001';
    end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.inbox_saved_reply_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('inbox.manage');
  delete from public.inbox_saved_replies where id = p_id;
end;
$$;

-- Counts for the menu badge.
create or replace function public.inbox_unread_count()
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when public.has_permission('inbox.view')
    then (select count(*)::int from public.inbox_conversations where unread_count > 0 and status <> 'DONE') else 0 end
$$;

revoke all on function public.inbox_channel_save(jsonb, uuid), public.inbox_channel_status(uuid, text, text),
  public.inbox_channels_for(uuid, text, text), public.inbox_ingest(jsonb), public.inbox_send_context(uuid),
  public.inbox_record_outgoing(jsonb, uuid), public.inbox_message_status(uuid, text, text, text),
  public.inbox_mark_seen_until(uuid, text, timestamptz), public.inbox_set_profile(uuid, text, text) from public, anon, authenticated;
grant execute on function public.inbox_channel_save(jsonb, uuid), public.inbox_channel_status(uuid, text, text),
  public.inbox_channels_for(uuid, text, text), public.inbox_ingest(jsonb), public.inbox_send_context(uuid),
  public.inbox_record_outgoing(jsonb, uuid), public.inbox_message_status(uuid, text, text, text),
  public.inbox_mark_seen_until(uuid, text, timestamptz), public.inbox_set_profile(uuid, text, text) to service_role;

revoke all on function public.inbox_overview(), public.inbox_list(jsonb), public.inbox_thread(uuid, timestamptz, int),
  public.inbox_mark_read(uuid), public.inbox_update(uuid, jsonb), public.inbox_note_add(uuid, text), public.inbox_note_delete(uuid),
  public.inbox_saved_replies(), public.inbox_saved_reply_save(jsonb), public.inbox_saved_reply_delete(uuid),
  public.inbox_unread_count() from public, anon;
grant execute on function public.inbox_overview(), public.inbox_list(jsonb), public.inbox_thread(uuid, timestamptz, int),
  public.inbox_mark_read(uuid), public.inbox_update(uuid, jsonb), public.inbox_note_add(uuid, text), public.inbox_note_delete(uuid),
  public.inbox_saved_replies(), public.inbox_saved_reply_save(jsonb), public.inbox_saved_reply_delete(uuid),
  public.inbox_unread_count() to authenticated;

-- A full store reset also removes the inbox (its channel tokens are in
-- integration_credentials, which the reset already clears).
do $$
declare
  v_def text := replace(pg_get_functiondef('public.platform_store_reset(uuid, text, text, text)'::regprocedure), E'\r', '');
  v_anchor text := $a$delete from public.meta_ad_accounts where merchant_id = p_merchant;$a$;
begin
  if position('inbox_channels' in v_def) > 0 then
    return; -- already applied
  end if;
  if position(v_anchor in v_def) = 0 then
    raise exception 'platform_store_reset: expected the connections step; apply 20261108000300 first';
  end if;
  v_def := replace(v_def, v_anchor, v_anchor || $b$
    delete from public.inbox_saved_replies where merchant_id = p_merchant;
    update public.inbox_conversations set pinned_message_id = null where merchant_id = p_merchant;
    delete from public.inbox_channels where merchant_id = p_merchant;$b$);
  execute v_def;
end $$;

select public._tenancy_own_functions();
