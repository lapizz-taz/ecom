-- =============================================================================
-- Messaging v2: a Comments workspace (comments grouped by post, reply in public,
-- in private or both, like / hide / delete, "no reply needed"), Auto Replies
-- (keyword rules and a default first reply, switched on per channel), comment
-- moderation (hide comments with phone numbers, links or chosen words),
-- automatic follow-ups inside Meta's 24-hour window, staff reminders, and an
-- activity log of everything that ran by itself.
--
--   inbox_posts              the post or ad a comment is on (caption, picture, link)
--   inbox_auto_replies       keyword rules and the default first reply
--   inbox_settings           per store: where auto replies run, moderation, follow-up
--   inbox_automation_log     auto replies, follow-ups, moderation and comment actions
--
-- Nothing here talks to Meta: the `inbox` function asks inbox_automation_plan what
-- to do with a new message, does it, and records the outcome.
-- =============================================================================

create table if not exists public.inbox_posts (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null default public.current_merchant_id() references public.merchants(id),
  channel_id uuid not null references public.inbox_channels(id) on delete cascade,
  external_id text not null check (length(external_id) between 1 and 200),
  caption text check (length(caption) <= 4000),
  image_url text check (length(image_url) <= 2000),
  permalink text check (length(permalink) <= 1000),
  media_type text check (length(media_type) <= 40),
  is_ad boolean not null default false,
  posted_at timestamptz,
  likes int check (likes >= 0),
  shares int check (shares >= 0),
  comments int check (comments >= 0),
  fetched_at timestamptz,
  fetch_error text check (length(fetch_error) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel_id, external_id)
);

alter table public.inbox_conversations
  add column if not exists post_external_id text check (length(post_external_id) <= 200),
  add column if not exists no_reply_needed boolean not null default false,
  -- When the oldest unanswered customer message arrived (null once answered).
  add column if not exists awaiting_since timestamptz,
  -- A message sent by itself if the customer has not answered by then.
  add column if not exists auto_follow_up_at timestamptz,
  add column if not exists auto_follow_up_text text check (length(auto_follow_up_text) <= 2000),
  add column if not exists auto_follow_up_by uuid references public.profiles(id) on delete set null,
  -- A reminder for staff ("call back at 5").
  add column if not exists remind_at timestamptz,
  add column if not exists remind_note text check (length(remind_note) <= 300);
create index if not exists inbox_conversations_post_idx on public.inbox_conversations (merchant_id, channel_id, post_external_id) where kind = 'COMMENT';
create index if not exists inbox_conversations_follow_up_idx on public.inbox_conversations (auto_follow_up_at) where auto_follow_up_at is not null;

alter table public.inbox_messages
  add column if not exists hidden boolean not null default false,
  add column if not exists liked boolean not null default false,
  add column if not exists removed_at timestamptz,
  -- Moderation hid it, and why ("Phone number", "Link", "Word: …").
  add column if not exists filtered text check (length(filtered) <= 120),
  add column if not exists auto_kind text check (auto_kind in ('AUTO_REPLY', 'FOLLOW_UP')),
  add column if not exists private_reply boolean not null default false;

create table if not exists public.inbox_auto_replies (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null default public.current_merchant_id() references public.merchants(id),
  name text not null check (length(trim(name)) between 1 and 80),
  enabled boolean not null default true,
  -- The default first reply: a first-time customer whose message matched no keyword.
  is_default boolean not null default false,
  applies_to text not null default 'BOTH' check (applies_to in ('MESSAGE', 'COMMENT', 'BOTH')),
  keywords text[] not null default '{}' check (cardinality(keywords) <= 30),
  match text not null default 'CONTAINS' check (match in ('CONTAINS', 'EXACT')),
  -- Empty: every channel where auto replies are switched on.
  channel_ids uuid[] not null default '{}' check (cardinality(channel_ids) <= 50),
  -- Comments only on these posts (empty: any post).
  post_ids text[] not null default '{}' check (cardinality(post_ids) <= 50),
  -- A message, or the public reply under a comment.
  reply_text text check (length(reply_text) <= 2000),
  -- Comments: also message the person privately.
  private_text text check (length(private_text) <= 2000),
  like_comment boolean not null default false,
  -- Never the same rule twice in one conversation (otherwise at most every 10 minutes).
  once_per_customer boolean not null default true,
  sent_count int not null default 0 check (sent_count >= 0),
  last_sent_at timestamptz,
  sort_order int not null default 0,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists inbox_auto_replies_one_default on public.inbox_auto_replies (merchant_id) where is_default;

create table if not exists public.inbox_settings (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null default public.current_merchant_id() references public.merchants(id) unique,
  auto_reply_channels uuid[] not null default '{}' check (cardinality(auto_reply_channels) <= 50),
  moderation jsonb not null default '{"enabled": false, "hide_phone": true, "hide_links": true, "keywords": []}'
    check (jsonb_typeof(moderation) = 'object'),
  -- Empty: every channel.
  moderation_channels uuid[] not null default '{}' check (cardinality(moderation_channels) <= 50),
  follow_up jsonb not null default '{"enabled": false, "after_minutes": 180}' check (jsonb_typeof(follow_up) = 'object'),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists public.inbox_automation_log (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null default public.current_merchant_id() references public.merchants(id),
  kind text not null check (kind in ('AUTO_REPLY', 'FOLLOW_UP', 'MODERATION', 'COMMENT_ACTION')),
  status text not null check (status in ('SENT', 'FAILED', 'SKIPPED', 'DONE', 'SCHEDULED', 'CANCELLED')),
  rule_id uuid references public.inbox_auto_replies(id) on delete set null,
  conversation_id uuid references public.inbox_conversations(id) on delete cascade,
  message_id uuid references public.inbox_messages(id) on delete set null,
  detail text check (length(detail) <= 500),
  actor uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists inbox_automation_log_recent_idx on public.inbox_automation_log (merchant_id, created_at desc);
create index if not exists inbox_automation_log_conv_idx on public.inbox_automation_log (conversation_id, created_at desc);

do $$
declare t text;
begin
  foreach t in array array['inbox_posts', 'inbox_auto_replies', 'inbox_settings', 'inbox_automation_log'] loop
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

-- Existing data: the post each comment is on, and who is still waiting for an answer.
update public.inbox_conversations set post_external_id = post ->> 'id' where post_external_id is null and post ? 'id';
update public.inbox_conversations set awaiting_since = coalesce(last_customer_message_at, last_message_at)
where awaiting_since is null and last_message_direction = 'IN' and status <> 'DONE';

-- ---------------------------------------------------------------- helpers
-- A Bangladeshi mobile number in a message ("01712-345678", "+8801712345678"), as 01XXXXXXXXX.
create or replace function public._inbox_bd_phone(p_text text)
returns text
language sql
immutable
as $$
  select '0' || (regexp_match(regexp_replace(coalesce(p_text, ''), '[\s().-]', '', 'g'), '(?<![0-9])(?:\+?880|0)(1[3-9][0-9]{8})(?![0-9])'))[1]
$$;

-- Why moderation would hide this comment, or null.
create or replace function public._inbox_moderation_reason(p_text text, p_mod jsonb)
returns text
language plpgsql
immutable
as $$
declare
  v text := lower(coalesce(p_text, ''));
  k text;
begin
  if v = '' then
    return null;
  end if;
  if coalesce((p_mod ->> 'hide_phone')::boolean, true) and (public._inbox_bd_phone(p_text) is not null
      or regexp_replace(v, '[^0-9]', '', 'g') ~ '[0-9]{10,}') then
    return 'Phone number';
  end if;
  if coalesce((p_mod ->> 'hide_links')::boolean, true)
     and v ~ '(https?://|www\.|bit\.ly|t\.me/|wa\.me/|\m[a-z0-9-]+\.(com|net|org|xyz|link|shop|store|online|site|me|io|bd)\M)' then
    return 'Link';
  end if;
  for k in select lower(trim(x)) from jsonb_array_elements_text(case when jsonb_typeof(p_mod -> 'keywords') = 'array' then p_mod -> 'keywords' else '[]'::jsonb end) x loop
    if k <> '' and position(k in v) > 0 then
      return left('Word: ' || k, 120);
    end if;
  end loop;
  return null;
end;
$$;

-- The first keyword rule that answers this text (default replies are chosen separately).
create or replace function public._inbox_rule_for(p_text text, p_kind text, p_channel uuid, p_post text)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select r.id from public.inbox_auto_replies r
  where r.enabled and not r.is_default
    and r.applies_to in (p_kind, 'BOTH')
    and (cardinality(r.channel_ids) = 0 or p_channel = any (r.channel_ids))
    and (p_kind <> 'COMMENT' or cardinality(r.post_ids) = 0 or p_post = any (r.post_ids))
    and (cardinality(r.keywords) = 0 or exists (
      select 1 from unnest(r.keywords) k
      where length(trim(k)) > 0 and case r.match
        when 'EXACT' then lower(trim(regexp_replace(coalesce(p_text, ''), '\s+', ' ', 'g'))) = lower(trim(k))
        else position(lower(trim(k)) in lower(coalesce(p_text, ''))) > 0 end))
  order by r.sort_order, r.created_at
  limit 1
$$;

create or replace function public._inbox_money(p numeric)
returns text
language sql
immutable
as $$
  select '৳' || regexp_replace(trim(to_char(coalesce(p, 0), 'FM9,999,999,990.00')), '\.00$', '')
$$;

-- The store's inbox settings, or the defaults when nothing was saved yet.
create or replace function public._inbox_settings()
returns public.inbox_settings
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  s public.inbox_settings;
begin
  select * into s from public.inbox_settings limit 1;
  if s.id is null then
    s.auto_reply_channels := '{}';
    s.moderation := '{"enabled": false, "hide_phone": true, "hide_links": true, "keywords": []}';
    s.moderation_channels := '{}';
    s.follow_up := '{"enabled": false, "after_minutes": 180}';
  end if;
  return s;
end;
$$;

create or replace function public._inbox_follow_up_default()
returns text
language sql
immutable
as $$
  select 'Hi! Just checking in. Would you like to place the order? Reply here and we will help you right away.'::text
$$;

revoke all on function public._inbox_bd_phone(text), public._inbox_moderation_reason(text, jsonb),
  public._inbox_rule_for(text, text, uuid, text), public._inbox_money(numeric), public._inbox_settings(),
  public._inbox_follow_up_default() from public, anon, authenticated;

-- ---------------------------------------------------------------- system (the inbox function)
-- One incoming (or echoed outgoing) message. As before, plus: the post a comment
-- is on, who is waiting for an answer, a phone number typed in a message, and
-- whether the post's details still need fetching.
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
  v_kind text := coalesce(p ->> 'kind', 'MESSAGE');
  v_post text := left(nullif(p -> 'post' ->> 'id', ''), 200);
  v_reply uuid;
  v_id uuid;
  v_phone text := nullif(regexp_replace(coalesce(v_cust ->> 'phone', ''), '[^0-9+]', '', 'g'), '');
  v_typed text;
  v_needs_post boolean;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select * into v_channel from public.inbox_channels where id = (p ->> 'channel_id')::uuid;
  if v_channel.id is null then
    raise exception 'NOT_FOUND: unknown inbox channel' using errcode = 'P0001';
  end if;

  insert into public.inbox_conversations (channel_id, kind, thread_key, customer_external_id, customer_name, customer_avatar, customer_phone, post, post_external_id, customer_id)
  values (v_channel.id, v_kind, p ->> 'thread_key', nullif(v_cust ->> 'external_id', ''),
    left(nullif(v_cust ->> 'name', ''), 200), left(nullif(v_cust ->> 'avatar', ''), 1000), left(v_phone, 30),
    case when jsonb_typeof(p -> 'post') = 'object' then p -> 'post' end, v_post,
    public._inbox_customer_for_phone(v_phone))
  on conflict (channel_id, kind, thread_key) do update set
    customer_name = coalesce(inbox_conversations.customer_name, excluded.customer_name),
    customer_avatar = coalesce(excluded.customer_avatar, inbox_conversations.customer_avatar),
    customer_phone = coalesce(inbox_conversations.customer_phone, excluded.customer_phone),
    customer_id = coalesce(inbox_conversations.customer_id, excluded.customer_id),
    customer_external_id = coalesce(inbox_conversations.customer_external_id, excluded.customer_external_id),
    post = coalesce(excluded.post, inbox_conversations.post),
    post_external_id = coalesce(excluded.post_external_id, inbox_conversations.post_external_id)
  returning * into v_conv;

  v_needs_post := v_conv.kind = 'COMMENT' and v_conv.post_external_id is not null and not exists (
    select 1 from public.inbox_posts ip where ip.channel_id = v_channel.id and ip.external_id = v_conv.post_external_id
      and ip.fetched_at > now() - interval '6 hours');

  if nullif(v_msg ->> 'external_id', '') is not null then
    select id into v_id from public.inbox_messages where conversation_id = v_conv.id and external_id = v_msg ->> 'external_id';
    if v_id is not null then
      -- Meta's echo of a file sent from here carries its link; keep it.
      update public.inbox_messages set attachments = v_attach
      where id = v_id and jsonb_array_length(v_attach) > 0
        and not exists (select 1 from jsonb_array_elements(attachments) a where a ? 'url' or a ? 'media_id');
      return jsonb_build_object('conversation_id', v_conv.id, 'message_id', v_id, 'duplicate', true,
        'needs_profile', v_conv.customer_name is null and v_conv.kind = 'MESSAGE', 'needs_post', v_needs_post, 'direction', v_dir);
    end if;
  end if;
  if nullif(v_msg ->> 'reply_to_external_id', '') is not null then
    select id into v_reply from public.inbox_messages where conversation_id = v_conv.id and external_id = v_msg ->> 'reply_to_external_id';
  end if;

  insert into public.inbox_messages (conversation_id, direction, external_id, body, attachments, reply_to_id, sender_name, status, created_at)
  values (v_conv.id, v_dir, nullif(v_msg ->> 'external_id', ''), left(v_msg ->> 'body', 8000), v_attach, v_reply,
    left(nullif(v_msg ->> 'sender_name', ''), 200), case when v_dir = 'IN' then 'RECEIVED' else 'SENT' end, v_at)
  returning id into v_id;

  -- A number the customer typed in a message fills an empty mobile number.
  if v_dir = 'IN' and v_conv.kind = 'MESSAGE' and v_conv.customer_phone is null then
    v_typed := public._inbox_bd_phone(v_msg ->> 'body');
  end if;

  update public.inbox_conversations set
    last_message_at = greatest(coalesce(last_message_at, v_at), v_at),
    last_message_preview = case when v_at >= coalesce(last_message_at, v_at) then public._inbox_preview(v_msg ->> 'body', v_attach) else last_message_preview end,
    last_message_direction = case when v_at >= coalesce(last_message_at, v_at) then v_dir else last_message_direction end,
    last_customer_message_at = case when v_dir = 'IN' then greatest(coalesce(last_customer_message_at, v_at), v_at) else last_customer_message_at end,
    unread_count = unread_count + case when v_dir = 'IN' then 1 else 0 end,
    -- A customer writing again reopens a closed conversation.
    status = case when v_dir = 'IN' and status = 'DONE' then 'OPEN' else status end,
    no_reply_needed = case when v_dir = 'IN' then false else no_reply_needed end,
    awaiting_since = case when v_dir = 'IN' then coalesce(awaiting_since, v_at) else null end,
    -- The customer answered: no follow-up needed.
    auto_follow_up_at = case when v_dir = 'IN' then null else auto_follow_up_at end,
    auto_follow_up_text = case when v_dir = 'IN' then null else auto_follow_up_text end,
    customer_phone = coalesce(customer_phone, v_typed),
    customer_id = coalesce(customer_id, public._inbox_customer_for_phone(v_typed)),
    updated_at = now()
  where id = v_conv.id;
  update public.inbox_channels set last_event_at = now() where id = v_channel.id;
  return jsonb_build_object('conversation_id', v_conv.id, 'message_id', v_id, 'duplicate', false,
    'needs_profile', v_conv.customer_name is null and v_conv.kind = 'MESSAGE', 'needs_post', v_needs_post, 'direction', v_dir);
end;
$$;

-- A message staff sent (or the automation sent, auto_kind), or tried to send.
create or replace function public.inbox_record_outgoing(p jsonb, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_conv public.inbox_conversations;
  v_attach jsonb := case when jsonb_typeof(p -> 'attachments') = 'array' then p -> 'attachments' else '[]'::jsonb end;
  v_failed boolean := nullif(p ->> 'error', '') is not null;
  v_auto text := nullif(p ->> 'auto_kind', '');
  v_settings public.inbox_settings;
  v_after int;
  v_id uuid;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select * into v_conv from public.inbox_conversations where id = (p ->> 'conversation_id')::uuid;
  if v_conv.id is null then
    raise exception 'NOT_FOUND: conversation not found' using errcode = 'P0001';
  end if;
  insert into public.inbox_messages (conversation_id, direction, external_id, body, attachments, reply_to_id, sender_name, sent_by, status, error, auto_kind, private_reply)
  values (v_conv.id, 'OUT', nullif(p ->> 'external_id', ''), left(p ->> 'body', 8000), v_attach,
    nullif(p ->> 'reply_to_id', '')::uuid,
    case v_auto when 'AUTO_REPLY' then 'Auto reply' when 'FOLLOW_UP' then 'Auto follow-up' else (select full_name from public.profiles where id = p_actor) end,
    p_actor, case when v_failed then 'FAILED' else 'SENT' end, left(p ->> 'error', 500), v_auto, coalesce((p ->> 'private_reply')::boolean, false))
  on conflict (conversation_id, external_id) where external_id is not null do nothing
  returning id into v_id;
  if not v_failed then
    -- A person's reply may start the automatic follow-up (Auto Replies → Auto follow-up).
    v_settings := public._inbox_settings();
    v_after := least(greatest(coalesce((v_settings.follow_up ->> 'after_minutes')::int, 180), 15), 1380);
    update public.inbox_conversations set last_message_at = now(), last_message_preview = public._inbox_preview(p ->> 'body', v_attach),
      last_message_direction = 'OUT', unread_count = case when v_auto is null then 0 else unread_count end,
      awaiting_since = case when v_auto is null or kind = 'COMMENT' then null else awaiting_since end,
      auto_follow_up_at = case
        when v_auto is not null or kind <> 'MESSAGE' then auto_follow_up_at
        when auto_follow_up_by is not null then auto_follow_up_at
        when coalesce((v_settings.follow_up ->> 'enabled')::boolean, false)
             and last_customer_message_at > now() + make_interval(mins => v_after) - interval '23 hours 50 minutes'
          then now() + make_interval(mins => v_after)
        else auto_follow_up_at end,
      auto_follow_up_text = case
        when v_auto is not null or kind <> 'MESSAGE' or auto_follow_up_by is not null then auto_follow_up_text
        when coalesce((v_settings.follow_up ->> 'enabled')::boolean, false)
             and last_customer_message_at > now() + make_interval(mins => v_after) - interval '23 hours 50 minutes'
          then coalesce(nullif(trim(v_settings.follow_up ->> 'text'), ''), public._inbox_follow_up_default())
        else auto_follow_up_text end,
      updated_at = now()
    where id = v_conv.id;
  end if;
  return jsonb_build_object('message_id', v_id);
end;
$$;

-- The details of a post or ad (fetched from Meta when its first comment arrives).
create or replace function public.inbox_post_save(p jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  insert into public.inbox_posts (channel_id, external_id, caption, image_url, permalink, media_type, is_ad, posted_at, likes, shares, comments, fetched_at, fetch_error)
  values ((p ->> 'channel_id')::uuid, left(p ->> 'external_id', 200), left(nullif(p ->> 'caption', ''), 4000), left(nullif(p ->> 'image_url', ''), 2000),
    left(nullif(p ->> 'permalink', ''), 1000), left(nullif(p ->> 'media_type', ''), 40), coalesce((p ->> 'is_ad')::boolean, false),
    (p ->> 'posted_at')::timestamptz, (p ->> 'likes')::int, (p ->> 'shares')::int, (p ->> 'comments')::int, now(), left(nullif(p ->> 'error', ''), 300))
  on conflict (channel_id, external_id) do update set
    caption = coalesce(excluded.caption, inbox_posts.caption), image_url = coalesce(excluded.image_url, inbox_posts.image_url),
    permalink = coalesce(excluded.permalink, inbox_posts.permalink), media_type = coalesce(excluded.media_type, inbox_posts.media_type),
    is_ad = inbox_posts.is_ad or excluded.is_ad, posted_at = coalesce(excluded.posted_at, inbox_posts.posted_at),
    likes = coalesce(excluded.likes, inbox_posts.likes), shares = coalesce(excluded.shares, inbox_posts.shares),
    comments = coalesce(excluded.comments, inbox_posts.comments), fetched_at = now(), fetch_error = excluded.fetch_error, updated_at = now();
end;
$$;

-- What to do by itself with a new customer message: hide it (moderation) and/or answer it (auto reply).
create or replace function public.inbox_automation_plan(p_conversation uuid, p_message uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  c public.inbox_conversations;
  m public.inbox_messages;
  s public.inbox_settings;
  r public.inbox_auto_replies;
  v_reason text;
  v_rule uuid;
  v_first boolean;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select * into c from public.inbox_conversations where id = p_conversation;
  select * into m from public.inbox_messages where id = p_message and conversation_id = p_conversation;
  if c.id is null or m.id is null or m.direction <> 'IN' then
    return jsonb_build_object('replies', '[]'::jsonb);
  end if;
  s := public._inbox_settings();

  if c.kind = 'COMMENT' and coalesce((s.moderation ->> 'enabled')::boolean, false)
     and (cardinality(s.moderation_channels) = 0 or c.channel_id = any (s.moderation_channels)) then
    v_reason := public._inbox_moderation_reason(m.body, s.moderation);
    if v_reason is not null then
      return jsonb_build_object('moderate', jsonb_build_object('hide', true, 'reason', v_reason), 'replies', '[]'::jsonb);
    end if;
  end if;

  if not (c.channel_id = any (s.auto_reply_channels)) then
    return jsonb_build_object('replies', '[]'::jsonb);
  end if;
  -- Comments: answer the comment itself, not every reply in its thread.
  if c.kind = 'COMMENT' and m.external_id is distinct from c.thread_key then
    return jsonb_build_object('replies', '[]'::jsonb);
  end if;
  v_rule := public._inbox_rule_for(m.body, c.kind, c.channel_id, c.post_external_id);
  if v_rule is null then
    v_first := case when c.kind = 'MESSAGE'
      then not exists (select 1 from public.inbox_messages x where x.conversation_id = c.id and x.id <> m.id)
      else c.customer_external_id is null or not exists (select 1 from public.inbox_conversations o
        where o.channel_id = c.channel_id and o.kind = 'COMMENT' and o.id <> c.id and o.customer_external_id = c.customer_external_id and o.created_at < c.created_at) end;
    if v_first then
      select id into v_rule from public.inbox_auto_replies
      where is_default and enabled and applies_to in (c.kind, 'BOTH') and (cardinality(channel_ids) = 0 or c.channel_id = any (channel_ids));
    end if;
  end if;
  if v_rule is null then
    return jsonb_build_object('replies', '[]'::jsonb);
  end if;
  select * into r from public.inbox_auto_replies where id = v_rule;
  if exists (select 1 from public.inbox_automation_log l where l.conversation_id = c.id and l.rule_id = r.id and l.status = 'SENT'
             and (r.once_per_customer or l.created_at > now() - interval '10 minutes')) then
    return jsonb_build_object('replies', '[]'::jsonb, 'skipped', r.name);
  end if;
  return jsonb_build_object('replies', jsonb_build_array(jsonb_build_object(
    'rule_id', r.id, 'name', r.name, 'reply_text', nullif(trim(coalesce(r.reply_text, '')), ''),
    'private_text', case when c.kind = 'COMMENT' then nullif(trim(coalesce(r.private_text, '')), '') end,
    'like', c.kind = 'COMMENT' and r.like_comment)));
end;
$$;

-- The outcome of something that ran by itself (or a comment action that failed).
-- p: {kind, status, rule_id, conversation_id, message_id, detail, actor}
create or replace function public.inbox_automation_record(p jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rule uuid := nullif(p ->> 'rule_id', '')::uuid;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  insert into public.inbox_automation_log (kind, status, rule_id, conversation_id, message_id, detail, actor)
  values (p ->> 'kind', p ->> 'status', v_rule, nullif(p ->> 'conversation_id', '')::uuid, nullif(p ->> 'message_id', '')::uuid,
    left(nullif(p ->> 'detail', ''), 500), nullif(p ->> 'actor', '')::uuid);
  if p ->> 'kind' = 'AUTO_REPLY' and p ->> 'status' = 'SENT' and v_rule is not null then
    update public.inbox_auto_replies set sent_count = sent_count + 1, last_sent_at = now() where id = v_rule;
  end if;
  if p ->> 'kind' = 'MODERATION' and p ->> 'status' = 'DONE' and nullif(p ->> 'message_id', '') is not null then
    update public.inbox_messages set hidden = true, filtered = left(coalesce(nullif(p ->> 'detail', ''), 'Moderation'), 120)
    where id = (p ->> 'message_id')::uuid;
  end if;
end;
$$;

-- A like, hide or delete Meta accepted. p: {hidden, liked, removed, detail}
create or replace function public.inbox_message_flags(p_message uuid, p jsonb, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  m public.inbox_messages;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.inbox_messages set
    hidden = coalesce((p ->> 'hidden')::boolean, hidden),
    liked = coalesce((p ->> 'liked')::boolean, liked),
    removed_at = case when coalesce((p ->> 'removed')::boolean, false) then now() else removed_at end,
    filtered = case when (p ->> 'hidden')::boolean is false then null else filtered end
  where id = p_message
  returning * into m;
  if m.id is null then
    raise exception 'NOT_FOUND: message not found' using errcode = 'P0001';
  end if;
  -- A deleted comment no longer waits for an answer.
  if coalesce((p ->> 'removed')::boolean, false) then
    update public.inbox_conversations c set awaiting_since = null
    where c.id = m.conversation_id and c.thread_key = m.external_id;
  end if;
  insert into public.inbox_automation_log (kind, status, conversation_id, message_id, detail, actor)
  values ('COMMENT_ACTION', 'DONE', m.conversation_id, m.id, left(nullif(p ->> 'detail', ''), 500), p_actor);
end;
$$;

-- Follow-ups that are due in this store: claimed (so they go once) and returned to send.
create or replace function public.inbox_follow_ups_claim(p_limit int default 50)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  v_out jsonb := '[]'::jsonb;
  v_default text := coalesce(nullif(trim((public._inbox_settings()).follow_up ->> 'text'), ''), public._inbox_follow_up_default());
  v_skip text;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  for r in
    select c.id, c.auto_follow_up_text, c.last_message_direction, c.last_customer_message_at, ch.status as channel_status
    from public.inbox_conversations c join public.inbox_channels ch on ch.id = c.channel_id
    where c.auto_follow_up_at <= now()
    order by c.auto_follow_up_at
    limit least(greatest(coalesce(p_limit, 50), 1), 200)
    for update of c skip locked
  loop
    update public.inbox_conversations set auto_follow_up_at = null, auto_follow_up_text = null, auto_follow_up_by = null where id = r.id;
    v_skip := case
      when r.last_message_direction = 'IN' then 'The customer answered first'
      when r.last_customer_message_at is null or r.last_customer_message_at < now() - interval '23 hours 55 minutes'
        then 'More than 24 hours since the customer wrote: Meta does not allow it'
      when r.channel_status = 'DISCONNECTED' then 'The channel is disconnected' end;
    if v_skip is not null then
      insert into public.inbox_automation_log (kind, status, conversation_id, detail) values ('FOLLOW_UP', 'SKIPPED', r.id, v_skip);
    else
      v_out := v_out || jsonb_build_object('conversation_id', r.id, 'text', coalesce(nullif(trim(r.auto_follow_up_text), ''), v_default));
    end if;
  end loop;
  return v_out;
end;
$$;

-- What the schedulers check before calling the inbox function (any store).
create or replace function public.inbox_automation_due()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.inbox_conversations where auto_follow_up_at <= now())
$$;

revoke all on function public.inbox_post_save(jsonb), public.inbox_automation_plan(uuid, uuid), public.inbox_automation_record(jsonb),
  public.inbox_message_flags(uuid, jsonb, uuid), public.inbox_follow_ups_claim(int), public.inbox_automation_due() from public, anon, authenticated;
grant execute on function public.inbox_post_save(jsonb), public.inbox_automation_plan(uuid, uuid), public.inbox_automation_record(jsonb),
  public.inbox_message_flags(uuid, jsonb, uuid), public.inbox_follow_ups_claim(int), public.inbox_automation_due() to service_role;

-- ---------------------------------------------------------------- staff: inbox
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
    -- Chats (comments have their own page and counts).
    'counts', (select jsonb_build_object(
      'open', count(*) filter (where status = 'OPEN'),
      'follow_up', count(*) filter (where status = 'FOLLOW_UP'),
      'done', count(*) filter (where status = 'DONE'),
      'unread', count(*) filter (where unread_count > 0 and status <> 'DONE'),
      'awaiting', count(*) filter (where awaiting_since is not null and status <> 'DONE'),
      'mine', count(*) filter (where assigned_to = auth.uid() and status <> 'DONE'),
      'unassigned', count(*) filter (where assigned_to is null and status <> 'DONE'),
      'starred', count(*) filter (where starred))
      from public.inbox_conversations where kind = 'MESSAGE'),
    'comments', (select jsonb_build_object(
      'awaiting', count(*) filter (where awaiting_since is not null and not no_reply_needed and status <> 'DONE'),
      'unread', count(*) filter (where unread_count > 0))
      from public.inbox_conversations where kind = 'COMMENT'),
    'labels', coalesce((select jsonb_agg(l order by l) from (select distinct unnest(labels) l from public.inbox_conversations) x), '[]'::jsonb));
end;
$$;

-- p: {status, platform, kind, unread, awaiting, has_order, tagged, assigned: me|none, label, starred, q, sort: recent|oldest|waiting, limit, offset}
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
  v_sort text := coalesce(nullif(p ->> 'sort', ''), 'recent');
begin
  perform public.require_permission('inbox.view');
  return (
    with rows as (
      select c.*, ch.platform, ch.name as channel_name, pr.full_name as assigned_name,
        (c.linked_order_id is not null or (c.customer_id is not null and exists (select 1 from public.orders o where o.customer_id = c.customer_id))) as has_order
      from public.inbox_conversations c
      join public.inbox_channels ch on ch.id = c.channel_id
      left join public.profiles pr on pr.id = c.assigned_to
      where (nullif(p ->> 'status', '') is null or c.status = p ->> 'status')
        and (nullif(p ->> 'platform', '') is null or ch.platform = p ->> 'platform')
        and (nullif(p ->> 'kind', '') is null or c.kind = p ->> 'kind')
        and (coalesce((p ->> 'unread')::boolean, false) = false or c.unread_count > 0)
        and (coalesce((p ->> 'awaiting')::boolean, false) = false or c.awaiting_since is not null)
        and (coalesce((p ->> 'tagged')::boolean, false) = false or cardinality(c.labels) > 0)
        and (coalesce((p ->> 'starred')::boolean, false) = false or c.starred)
        and (p ->> 'assigned' is distinct from 'me' or c.assigned_to = auth.uid())
        and (p ->> 'assigned' is distinct from 'none' or c.assigned_to is null)
        and (nullif(p ->> 'label', '') is null or (p ->> 'label') = any (c.labels))
        and (v_q is null or c.customer_name ilike '%' || v_q || '%' or c.customer_phone ilike '%' || v_q || '%'
             or c.last_message_preview ilike '%' || v_q || '%'
             or exists (select 1 from public.inbox_messages m where m.conversation_id = c.id and m.body ilike '%' || v_q || '%'))
    ), picked as (
      select * from rows where coalesce((p ->> 'has_order')::boolean, false) = false or has_order
    )
    select jsonb_build_object(
      'total', (select count(*) from picked),
      'items', coalesce((select jsonb_agg(jsonb_build_object(
          'id', r.id, 'channel_id', r.channel_id, 'platform', r.platform, 'channel_name', r.channel_name, 'kind', r.kind,
          'customer_name', r.customer_name, 'customer_avatar', r.customer_avatar, 'customer_phone', r.customer_phone, 'customer_id', r.customer_id,
          'status', r.status, 'starred', r.starred, 'labels', to_jsonb(r.labels), 'assigned_to', r.assigned_to, 'assigned_name', r.assigned_name,
          'unread_count', r.unread_count, 'last_message_at', r.last_message_at, 'last_message_preview', r.last_message_preview,
          'last_message_direction', r.last_message_direction, 'linked_order_id', r.linked_order_id, 'has_order', r.has_order,
          'awaiting_since', r.awaiting_since, 'last_customer_message_at', r.last_customer_message_at,
          'auto_follow_up_at', r.auto_follow_up_at, 'remind_at', r.remind_at, 'no_reply_needed', r.no_reply_needed,
          'post_title', r.post ->> 'title') order by r.ord)
        from (select *, row_number() over (order by
                case when v_sort = 'waiting' then awaiting_since end asc nulls last,
                case when v_sort = 'oldest' then last_message_at end asc nulls last,
                last_message_at desc nulls last, created_at desc) as ord
              from picked
              order by ord limit v_limit offset v_offset) r), '[]'::jsonb))
  );
end;
$$;

-- One conversation with its newest messages (p_before pages back), notes, the customer's
-- orders, the post a comment is on and what happened to it (auto replies, actions).
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
        'channel_avatar', ch.avatar_url, 'channel_status', ch.status, 'assigned_name', pr.full_name, 'follow_up_by_name', fu.full_name)
      from public.inbox_channels ch left join public.profiles pr on pr.id = v_conv.assigned_to
        left join public.profiles fu on fu.id = v_conv.auto_follow_up_by
      where ch.id = v_conv.channel_id),
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
        or (v_conv.customer_external_id is not null and c.customer_external_id = v_conv.customer_external_id))), '[]'::jsonb),
    'post_detail', (select to_jsonb(ip) - 'merchant_id' from public.inbox_posts ip
      where v_conv.kind = 'COMMENT' and ip.channel_id = v_conv.channel_id and ip.external_id = v_conv.post_external_id),
    'history', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'kind', l.kind, 'status', l.status, 'detail', l.detail,
        'rule_name', r.name, 'actor_name', pr.full_name, 'created_at', l.created_at) order by l.created_at desc)
      from (select * from public.inbox_automation_log where conversation_id = p_id order by created_at desc limit 50) l
      left join public.inbox_auto_replies r on r.id = l.rule_id left join public.profiles pr on pr.id = l.actor), '[]'::jsonb)
  );
end;
$$;

-- Several conversations at once. p: any of {status, read, no_reply_needed, assigned_to, add_label}
create or replace function public.inbox_bulk(p_ids uuid[], p jsonb)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n int;
begin
  perform public.require_permission('inbox.reply');
  if cardinality(coalesce(p_ids, '{}')) = 0 then
    return 0;
  end if;
  if cardinality(p_ids) > 500 then
    raise exception 'VALIDATION: pick at most 500 at a time' using errcode = '22023';
  end if;
  if p ? 'status' and (p ->> 'status') not in ('OPEN', 'FOLLOW_UP', 'DONE') then
    raise exception 'VALIDATION: unknown status' using errcode = '22023';
  end if;
  if nullif(p ->> 'assigned_to', '') is not null and not exists (select 1 from public.profiles where id = (p ->> 'assigned_to')::uuid) then
    raise exception 'VALIDATION: unknown staff member' using errcode = '22023';
  end if;
  update public.inbox_conversations set
    status = case when p ? 'status' then p ->> 'status' else status end,
    unread_count = case when coalesce((p ->> 'read')::boolean, false) then 0 else unread_count end,
    no_reply_needed = case when p ? 'no_reply_needed' then coalesce((p ->> 'no_reply_needed')::boolean, false) else no_reply_needed end,
    awaiting_since = case when coalesce((p ->> 'no_reply_needed')::boolean, false) then null
                          when (p ->> 'no_reply_needed')::boolean is false and last_message_direction = 'IN' then coalesce(awaiting_since, last_customer_message_at)
                          else awaiting_since end,
    assigned_to = case when p ? 'assigned_to' then nullif(p ->> 'assigned_to', '')::uuid else assigned_to end,
    labels = case when nullif(trim(p ->> 'add_label'), '') is not null and not (left(trim(p ->> 'add_label'), 40) = any (labels)) and cardinality(labels) < 20
                  then labels || left(trim(p ->> 'add_label'), 40) else labels end,
    updated_at = now()
  where id = any (p_ids);
  get diagnostics v_n = row_count;
  if p ? 'no_reply_needed' then
    insert into public.inbox_automation_log (kind, status, conversation_id, detail, actor)
    select 'COMMENT_ACTION', 'DONE', id, case when (p ->> 'no_reply_needed')::boolean then 'Marked: no reply needed' else 'Marked: needs a reply' end, auth.uid()
    from public.inbox_conversations where id = any (p_ids);
  end if;
  return v_n;
end;
$$;

-- An automatic message if the customer does not answer (null minutes cancels).
create or replace function public.inbox_follow_up_set(p_id uuid, p_minutes int, p_text text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c public.inbox_conversations;
  v_at timestamptz;
begin
  perform public.require_permission('inbox.reply');
  select * into c from public.inbox_conversations where id = p_id;
  if c.id is null then
    raise exception 'NOT_FOUND: conversation not found' using errcode = 'P0001';
  end if;
  if p_minutes is null then
    update public.inbox_conversations set auto_follow_up_at = null, auto_follow_up_text = null, auto_follow_up_by = null where id = p_id;
    if c.auto_follow_up_at is not null then
      insert into public.inbox_automation_log (kind, status, conversation_id, detail, actor) values ('FOLLOW_UP', 'CANCELLED', p_id, 'Follow-up cancelled', auth.uid());
    end if;
    return;
  end if;
  if c.kind <> 'MESSAGE' then
    raise exception 'VALIDATION: follow-ups are for chats, not comments' using errcode = '22023';
  end if;
  if p_minutes < 5 or p_minutes > 1440 then
    raise exception 'VALIDATION: pick between 5 minutes and 24 hours' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_text, ''))) = 0 or length(p_text) > 2000 then
    raise exception 'VALIDATION: write the follow-up message (up to 2000 characters)' using errcode = '22023';
  end if;
  v_at := now() + make_interval(mins => p_minutes);
  if c.last_customer_message_at is null or v_at > c.last_customer_message_at + interval '23 hours 55 minutes' then
    raise exception 'VALIDATION: Meta allows messages only within 24 hours of the customer''s last message; pick an earlier time' using errcode = '22023';
  end if;
  update public.inbox_conversations set auto_follow_up_at = v_at, auto_follow_up_text = trim(p_text), auto_follow_up_by = auth.uid() where id = p_id;
  insert into public.inbox_automation_log (kind, status, conversation_id, detail, actor)
  values ('FOLLOW_UP', 'SCHEDULED', p_id, 'Follow-up at ' || to_char(v_at at time zone 'Asia/Dhaka', 'DD Mon HH12:MI AM'), auth.uid());
end;
$$;

-- A reminder for staff; null clears it.
create or replace function public.inbox_reminder_set(p_id uuid, p_at timestamptz, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('inbox.reply');
  update public.inbox_conversations set remind_at = p_at, remind_note = case when p_at is null then null else left(nullif(trim(p_note), ''), 300) end,
    status = case when p_at is not null then 'FOLLOW_UP' else status end, updated_at = now()
  where id = p_id;
  if not found then
    raise exception 'NOT_FOUND: conversation not found' using errcode = 'P0001';
  end if;
end;
$$;

-- "Send order status" / "Send invoice": the text to put in the message box.
create or replace function public.inbox_order_message(p_order uuid, p_kind text default 'STATUS')
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  o public.orders;
  v_items text;
  v_ship record;
  v_store text;
  v_due numeric;
begin
  perform public.require_permission('inbox.reply');
  select * into o from public.orders where id = p_order;
  if o.id is null then
    raise exception 'NOT_FOUND: order not found' using errcode = 'P0001';
  end if;
  select string_agg('• ' || i.product_name || coalesce(' (' || nullif(i.variant_title, '') || ')', '') || ' × ' || i.quantity
      || case when p_kind = 'INVOICE' then ' = ' || public._inbox_money(i.line_total) else '' end, E'\n' order by i.created_at)
    into v_items from public.order_items i where i.order_id = o.id;
  select c.name as courier, coalesce(s.tracking_number, s.consignment_id) as tracking,
      case when c.tracking_url_template is not null and s.tracking_number is not null then replace(c.tracking_url_template, '{tracking}', s.tracking_number) end as url
    into v_ship from public.shipments s join public.couriers c on c.id = s.courier_id where s.order_id = o.id and s.is_active limit 1;
  select name into v_store from public.merchants where id = public.current_merchant_id();
  v_due := greatest(o.total_amount - o.amount_paid + o.amount_refunded, 0);
  if p_kind = 'INVOICE' then
    return concat_ws(E'\n',
      'Invoice: order ' || o.order_number,
      'Date: ' || to_char(o.created_at at time zone 'Asia/Dhaka', 'DD Mon YYYY'),
      o.customer_name || ' · ' || o.customer_phone,
      o.shipping_address,
      '',
      coalesce(v_items, ''),
      '',
      'Subtotal: ' || public._inbox_money(o.subtotal),
      case when o.discount_total > 0 then 'Discount: −' || public._inbox_money(o.discount_total) end,
      'Delivery: ' || public._inbox_money(greatest(o.delivery_charge - o.delivery_discount, 0)),
      'Total: ' || public._inbox_money(o.total_amount),
      case when o.amount_paid > 0 then 'Paid: ' || public._inbox_money(o.amount_paid) end,
      'To pay on delivery: ' || public._inbox_money(v_due),
      '',
      'Thank you for shopping with ' || coalesce(v_store, 'us') || '!');
  end if;
  return concat_ws(E'\n',
    'Your order ' || o.order_number || ' is ' || lower(replace(o.status::text, '_', ' ')) || '.',
    coalesce(v_items, ''),
    'Total: ' || public._inbox_money(o.total_amount) || case when v_due > 0 and v_due < o.total_amount then ' · due ' || public._inbox_money(v_due) else '' end,
    case when v_ship.courier is not null then 'Courier: ' || v_ship.courier || coalesce(' · tracking ' || v_ship.tracking, '') end,
    v_ship.url,
    'Thank you!');
end;
$$;

-- ---------------------------------------------------------------- staff: comments
-- Whether a comment conversation (with its own comment r) is in a Comments tab.
create or replace function public._inbox_comment_state(c public.inbox_conversations, r public.inbox_messages, p_state text)
returns boolean
language sql
stable
as $$
  select case coalesce(nullif(p_state, ''), 'all')
    when 'awaiting' then c.awaiting_since is not null and not c.no_reply_needed and c.status <> 'DONE' and r.removed_at is null
    when 'replied' then exists (select 1 from public.inbox_messages o where o.conversation_id = c.id and o.direction = 'OUT' and o.status <> 'FAILED')
    when 'no_reply' then c.no_reply_needed
    when 'unread' then c.unread_count > 0
    when 'liked' then coalesce(r.liked, false)
    when 'hidden' then coalesce(r.hidden, false)
    when 'deleted' then r.removed_at is not null
    when 'filtered' then r.filtered is not null
    else true end
$$;
revoke all on function public._inbox_comment_state(public.inbox_conversations, public.inbox_messages, text) from public, anon, authenticated;

-- Counts and the posts that have comments. p: {platform, state, q}
create or replace function public.inbox_comments_overview(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_q text := nullif(trim(p ->> 'q'), '');
begin
  perform public.require_permission('inbox.view');
  return (
    with base as (
      select c, x.r, ch.platform, ch.name as channel_name
      from public.inbox_conversations c
      join public.inbox_channels ch on ch.id = c.channel_id
      left join lateral (select m as r from public.inbox_messages m where m.conversation_id = c.id
        order by (m.external_id = c.thread_key) desc nulls last, m.created_at limit 1) x on true
      where c.kind = 'COMMENT'
        and (nullif(p ->> 'platform', '') is null or ch.platform = p ->> 'platform')
        and (v_q is null or c.customer_name ilike '%' || v_q || '%' or (x.r).body ilike '%' || v_q || '%' or (x.r).sender_name ilike '%' || v_q || '%')
    ), matching as (
      select * from base b where public._inbox_comment_state(b.c, b.r, p ->> 'state')
    ), flat as (
      select (b.c).channel_id as channel_id, (b.c).post_external_id as post_id, (b.c).last_message_at as last_at, b.*
      from matching b
    )
    select jsonb_build_object(
      'counts', jsonb_build_object(
        'all', (select count(*) from base),
        'awaiting', (select count(*) from base b where public._inbox_comment_state(b.c, b.r, 'awaiting')),
        'unread', (select count(*) from base b where (b.c).unread_count > 0),
        'matching', (select count(*) from matching)),
      'posts', coalesce((select jsonb_agg(y.x order by y.last_at desc nulls last) from (
        select max(f.last_at) as last_at, jsonb_build_object(
          'channel_id', f.channel_id, 'post_id', f.post_id, 'platform', min(f.platform), 'channel_name', min(f.channel_name),
          'caption', coalesce(min(ip.caption), min((f.c).post ->> 'title')), 'image_url', min(ip.image_url),
          'permalink', coalesce(min(ip.permalink), min((f.c).post ->> 'url')), 'posted_at', min(ip.posted_at), 'is_ad', bool_or(coalesce(ip.is_ad, false)),
          'media_type', coalesce(min(ip.media_type), min((f.c).post ->> 'type')), 'likes', min(ip.likes), 'shares', min(ip.shares), 'meta_comments', min(ip.comments),
          'matching', count(*), 'awaiting', count(*) filter (where public._inbox_comment_state(f.c, f.r, 'awaiting')),
          'total', (select count(*) from public.inbox_conversations t where t.channel_id = f.channel_id and t.kind = 'COMMENT'
                    and t.post_external_id is not distinct from f.post_id),
          'latest', (array_agg(coalesce((f.r).sender_name, (f.c).customer_name, '') || ': ' || left(coalesce((f.r).body, ''), 80) order by f.last_at desc nulls last))[1],
          'last_at', max(f.last_at)) as x
        from flat f
        left join public.inbox_posts ip on ip.channel_id = f.channel_id and ip.external_id = f.post_id
        group by f.channel_id, f.post_id
        order by max(f.last_at) desc nulls last
        limit 200) y), '[]'::jsonb)));
end;
$$;

-- The comments themselves. p: {platform, state, q, channel_id, post_id, limit, offset}
create or replace function public.inbox_comments(p jsonb default '{}'::jsonb)
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
      select c, x.r, ch.platform, ch.name as channel_name, pr.full_name as assigned_name
      from public.inbox_conversations c
      join public.inbox_channels ch on ch.id = c.channel_id
      left join public.profiles pr on pr.id = c.assigned_to
      left join lateral (select m as r from public.inbox_messages m where m.conversation_id = c.id
        order by (m.external_id = c.thread_key) desc nulls last, m.created_at limit 1) x on true
      where c.kind = 'COMMENT'
        and (nullif(p ->> 'platform', '') is null or ch.platform = p ->> 'platform')
        and (nullif(p ->> 'channel_id', '') is null or c.channel_id = (p ->> 'channel_id')::uuid)
        and (not (p ? 'post_id') or c.post_external_id is not distinct from nullif(p ->> 'post_id', ''))
        and (v_q is null or c.customer_name ilike '%' || v_q || '%' or (x.r).body ilike '%' || v_q || '%' or (x.r).sender_name ilike '%' || v_q || '%')
        and public._inbox_comment_state(c, x.r, p ->> 'state')
    )
    select jsonb_build_object(
      'total', (select count(*) from rows),
      'items', coalesce((select jsonb_agg(jsonb_build_object(
          'id', (w.c).id, 'channel_id', (w.c).channel_id, 'platform', w.platform, 'channel_name', w.channel_name,
          'post_id', (w.c).post_external_id, 'post_caption', left(coalesce(ip.caption, (w.c).post ->> 'title'), 140), 'post_image', ip.image_url,
          'customer_name', coalesce((w.c).customer_name, (w.r).sender_name), 'customer_avatar', (w.c).customer_avatar,
          'customer_external_id', (w.c).customer_external_id, 'status', (w.c).status, 'no_reply_needed', (w.c).no_reply_needed,
          'unread_count', (w.c).unread_count, 'awaiting_since', (w.c).awaiting_since, 'labels', to_jsonb((w.c).labels),
          'assigned_to', (w.c).assigned_to, 'assigned_name', w.assigned_name, 'last_message_at', (w.c).last_message_at,
          'comment', jsonb_build_object('id', (w.r).id, 'external_id', (w.r).external_id, 'body', (w.r).body, 'attachments', (w.r).attachments,
            'sender_name', (w.r).sender_name, 'created_at', (w.r).created_at, 'hidden', (w.r).hidden, 'liked', (w.r).liked,
            'removed_at', (w.r).removed_at, 'filtered', (w.r).filtered),
          'replies', (select count(*) from public.inbox_messages o where o.conversation_id = (w.c).id and o.id <> (w.r).id),
          'replied', exists (select 1 from public.inbox_messages o where o.conversation_id = (w.c).id and o.direction = 'OUT' and o.status <> 'FAILED'),
          'last_reply', (select jsonb_build_object('body', public._inbox_preview(o.body, o.attachments), 'direction', o.direction, 'sender_name', o.sender_name,
              'created_at', o.created_at, 'auto_kind', o.auto_kind, 'private_reply', o.private_reply, 'status', o.status)
            from public.inbox_messages o where o.conversation_id = (w.c).id and o.id <> (w.r).id order by o.created_at desc limit 1))
          order by (w.c).last_message_at desc nulls last)
        from (select * from rows order by (c).last_message_at desc nulls last limit v_limit offset v_offset) w
        left join public.inbox_posts ip on ip.channel_id = (w.c).channel_id and ip.external_id = (w.c).post_external_id), '[]'::jsonb)));
end;
$$;

-- ---------------------------------------------------------------- staff: auto replies
create or replace function public.inbox_automation()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  s public.inbox_settings;
begin
  perform public.require_permission('inbox.view');
  s := public._inbox_settings();
  return jsonb_build_object(
    'settings', jsonb_build_object('auto_reply_channels', to_jsonb(s.auto_reply_channels), 'moderation', s.moderation,
      'moderation_channels', to_jsonb(s.moderation_channels),
      'follow_up', s.follow_up || jsonb_build_object('default_text', public._inbox_follow_up_default())),
    'rules', coalesce((select jsonb_agg(to_jsonb(r) - 'merchant_id' order by r.is_default desc, r.sort_order, r.created_at) from public.inbox_auto_replies r), '[]'::jsonb),
    'channels', coalesce((select jsonb_agg(jsonb_build_object('id', ch.id, 'platform', ch.platform, 'name', ch.name, 'status', ch.status,
        'receive_comments', ch.receive_comments, 'auto_reply', ch.id = any (s.auto_reply_channels),
        'moderation', cardinality(s.moderation_channels) = 0 or ch.id = any (s.moderation_channels)) order by ch.created_at)
      from public.inbox_channels ch where ch.status <> 'DISCONNECTED'), '[]'::jsonb),
    'limit', 100,
    'stats', (select jsonb_build_object(
      'sent_today', count(*) filter (where kind = 'AUTO_REPLY' and status = 'SENT' and created_at >= date_trunc('day', now() at time zone 'Asia/Dhaka') at time zone 'Asia/Dhaka'),
      'sent_7d', count(*) filter (where kind = 'AUTO_REPLY' and status = 'SENT'),
      'follow_ups_7d', count(*) filter (where kind = 'FOLLOW_UP' and status = 'SENT'),
      'hidden_7d', count(*) filter (where kind = 'MODERATION' and status = 'DONE'),
      'failed_7d', count(*) filter (where status = 'FAILED'))
      from public.inbox_automation_log where created_at > now() - interval '7 days'));
end;
$$;

create or replace function public.inbox_settings_save(p jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_auto uuid[];
  v_mod uuid[];
  v_keywords jsonb;
  v_after int;
begin
  perform public.require_permission('inbox.manage');
  if p ? 'auto_reply_channels' then
    select coalesce(array_agg(distinct x::uuid), '{}') into v_auto from jsonb_array_elements_text(coalesce(p -> 'auto_reply_channels', '[]')) x;
    if exists (select 1 from unnest(v_auto) u where not exists (select 1 from public.inbox_channels ch where ch.id = u)) then
      raise exception 'VALIDATION: unknown channel' using errcode = '22023';
    end if;
  end if;
  if p ? 'moderation_channels' then
    select coalesce(array_agg(distinct x::uuid), '{}') into v_mod from jsonb_array_elements_text(coalesce(p -> 'moderation_channels', '[]')) x;
    if exists (select 1 from unnest(v_mod) u where not exists (select 1 from public.inbox_channels ch where ch.id = u)) then
      raise exception 'VALIDATION: unknown channel' using errcode = '22023';
    end if;
  end if;
  if p ? 'moderation' then
    if jsonb_typeof(p -> 'moderation') <> 'object' then
      raise exception 'VALIDATION: moderation settings are not valid' using errcode = '22023';
    end if;
    select coalesce(jsonb_agg(distinct left(lower(trim(k)), 60)) filter (where trim(k) <> ''), '[]'::jsonb) into v_keywords
    from jsonb_array_elements_text(case when jsonb_typeof(p -> 'moderation' -> 'keywords') = 'array' then p -> 'moderation' -> 'keywords' else '[]'::jsonb end) k;
    if jsonb_array_length(v_keywords) > 100 then
      raise exception 'VALIDATION: at most 100 hidden words' using errcode = '22023';
    end if;
  end if;
  if p ? 'follow_up' then
    v_after := coalesce((p -> 'follow_up' ->> 'after_minutes')::int, 180);
    if v_after < 15 or v_after > 1380 then
      raise exception 'VALIDATION: send the follow-up between 15 minutes and 23 hours after your reply' using errcode = '22023';
    end if;
    if length(coalesce(p -> 'follow_up' ->> 'text', '')) > 2000 then
      raise exception 'VALIDATION: the follow-up can be 2000 characters at most' using errcode = '22023';
    end if;
  end if;
  insert into public.inbox_settings (merchant_id) values (public.current_merchant_id()) on conflict (merchant_id) do nothing;
  update public.inbox_settings set
    auto_reply_channels = case when p ? 'auto_reply_channels' then v_auto else auto_reply_channels end,
    moderation_channels = case when p ? 'moderation_channels' then v_mod else moderation_channels end,
    moderation = case when p ? 'moderation' then jsonb_build_object(
      'enabled', coalesce((p -> 'moderation' ->> 'enabled')::boolean, false),
      'hide_phone', coalesce((p -> 'moderation' ->> 'hide_phone')::boolean, true),
      'hide_links', coalesce((p -> 'moderation' ->> 'hide_links')::boolean, true),
      'keywords', v_keywords) else moderation end,
    follow_up = case when p ? 'follow_up' then jsonb_build_object(
      'enabled', coalesce((p -> 'follow_up' ->> 'enabled')::boolean, false), 'after_minutes', v_after,
      'text', nullif(trim(p -> 'follow_up' ->> 'text'), '')) else follow_up end,
    updated_by = auth.uid(), updated_at = now()
  where merchant_id = public.current_merchant_id();
end;
$$;

create or replace function public.inbox_auto_reply_save(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_default boolean := coalesce((p ->> 'is_default')::boolean, false);
  v_keywords text[];
  v_channels uuid[];
  v_posts text[];
begin
  perform public.require_permission('inbox.manage');
  if length(trim(coalesce(p ->> 'name', ''))) = 0 then
    raise exception 'VALIDATION: give the auto reply a name' using errcode = '22023';
  end if;
  if coalesce(p ->> 'applies_to', 'BOTH') not in ('MESSAGE', 'COMMENT', 'BOTH') or coalesce(p ->> 'match', 'CONTAINS') not in ('CONTAINS', 'EXACT') then
    raise exception 'VALIDATION: unknown option' using errcode = '22023';
  end if;
  if length(trim(coalesce(p ->> 'reply_text', ''))) = 0 and length(trim(coalesce(p ->> 'private_text', ''))) = 0
     and not coalesce((p ->> 'like_comment')::boolean, false) then
    raise exception 'VALIDATION: write the reply' using errcode = '22023';
  end if;
  if length(coalesce(p ->> 'reply_text', '')) > 2000 or length(coalesce(p ->> 'private_text', '')) > 2000 then
    raise exception 'VALIDATION: a reply can be 2000 characters at most' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct left(trim(k), 80)) filter (where trim(k) <> ''), '{}') into v_keywords
  from jsonb_array_elements_text(case when jsonb_typeof(p -> 'keywords') = 'array' then p -> 'keywords' else '[]'::jsonb end) k;
  if cardinality(v_keywords) > 30 then
    raise exception 'VALIDATION: at most 30 keywords' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct x::uuid), '{}') into v_channels
  from jsonb_array_elements_text(case when jsonb_typeof(p -> 'channel_ids') = 'array' then p -> 'channel_ids' else '[]'::jsonb end) x;
  if exists (select 1 from unnest(v_channels) u where not exists (select 1 from public.inbox_channels ch where ch.id = u)) then
    raise exception 'VALIDATION: unknown channel' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct left(trim(x), 200)) filter (where trim(x) <> ''), '{}') into v_posts
  from jsonb_array_elements_text(case when jsonb_typeof(p -> 'post_ids') = 'array' then p -> 'post_ids' else '[]'::jsonb end) x;
  if not v_default and cardinality(v_keywords) = 0 and cardinality(v_posts) = 0 then
    raise exception 'VALIDATION: add at least one keyword (or make it the default first reply)' using errcode = '22023';
  end if;
  if v_default and exists (select 1 from public.inbox_auto_replies where is_default and id is distinct from v_id) then
    raise exception 'VALIDATION: there is already a default first reply; edit that one' using errcode = '22023';
  end if;
  if v_id is null then
    if (select count(*) from public.inbox_auto_replies) >= 100 then
      raise exception 'VALIDATION: you can have 100 auto replies' using errcode = '22023';
    end if;
    insert into public.inbox_auto_replies (name, enabled, is_default, applies_to, keywords, match, channel_ids, post_ids, reply_text, private_text,
      like_comment, once_per_customer, sort_order, created_by)
    values (left(trim(p ->> 'name'), 80), coalesce((p ->> 'enabled')::boolean, true), v_default, coalesce(p ->> 'applies_to', 'BOTH'),
      case when v_default then '{}' else v_keywords end, coalesce(p ->> 'match', 'CONTAINS'), v_channels, v_posts,
      nullif(trim(p ->> 'reply_text'), ''), nullif(trim(p ->> 'private_text'), ''), coalesce((p ->> 'like_comment')::boolean, false),
      coalesce((p ->> 'once_per_customer')::boolean, true), coalesce((p ->> 'sort_order')::int, 0), auth.uid())
    returning id into v_id;
  else
    update public.inbox_auto_replies set name = left(trim(p ->> 'name'), 80), enabled = coalesce((p ->> 'enabled')::boolean, enabled),
      is_default = v_default, applies_to = coalesce(p ->> 'applies_to', applies_to), keywords = case when v_default then '{}' else v_keywords end,
      match = coalesce(p ->> 'match', match), channel_ids = v_channels, post_ids = v_posts,
      reply_text = nullif(trim(p ->> 'reply_text'), ''), private_text = nullif(trim(p ->> 'private_text'), ''),
      like_comment = coalesce((p ->> 'like_comment')::boolean, false), once_per_customer = coalesce((p ->> 'once_per_customer')::boolean, true),
      sort_order = coalesce((p ->> 'sort_order')::int, sort_order), updated_at = now()
    where id = v_id;
    if not found then
      raise exception 'NOT_FOUND: auto reply not found' using errcode = 'P0001';
    end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.inbox_auto_reply_toggle(p_id uuid, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('inbox.manage');
  update public.inbox_auto_replies set enabled = p_enabled, updated_at = now() where id = p_id;
  if not found then
    raise exception 'NOT_FOUND: auto reply not found' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.inbox_auto_reply_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('inbox.manage');
  delete from public.inbox_auto_replies where id = p_id;
end;
$$;

-- "Try a message": what would happen to it (nothing is sent).
create or replace function public.inbox_auto_reply_try(p_text text, p_kind text default 'MESSAGE', p_channel uuid default null, p_first boolean default true)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  s public.inbox_settings;
  v_rule uuid;
  v_default boolean := false;
  v_reason text;
  r public.inbox_auto_replies;
begin
  perform public.require_permission('inbox.view');
  s := public._inbox_settings();
  if p_kind = 'COMMENT' then
    v_reason := public._inbox_moderation_reason(p_text, s.moderation);
  end if;
  v_rule := public._inbox_rule_for(p_text, coalesce(p_kind, 'MESSAGE'), p_channel, null);
  if v_rule is null and coalesce(p_first, true) then
    select id into v_rule from public.inbox_auto_replies
    where is_default and enabled and applies_to in (coalesce(p_kind, 'MESSAGE'), 'BOTH') and (p_channel is null or cardinality(channel_ids) = 0 or p_channel = any (channel_ids));
    v_default := v_rule is not null;
  end if;
  select * into r from public.inbox_auto_replies where id = v_rule;
  return jsonb_build_object(
    'moderation', case when v_reason is not null then jsonb_build_object('reason', v_reason,
      'active', coalesce((s.moderation ->> 'enabled')::boolean, false)) end,
    'rule', case when r.id is not null then jsonb_build_object('id', r.id, 'name', r.name, 'reply_text', r.reply_text,
      'private_text', case when p_kind = 'COMMENT' then r.private_text end, 'default', v_default) end,
    'running', p_channel is null or p_channel = any (s.auto_reply_channels));
end;
$$;

-- Activity. p: {kind, status, limit, offset}
create or replace function public.inbox_activity(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit int := least(greatest(coalesce((p ->> 'limit')::int, 50), 1), 200);
  v_offset int := greatest(coalesce((p ->> 'offset')::int, 0), 0);
begin
  perform public.require_permission('inbox.view');
  return (
    with rows as (
      select l.* from public.inbox_automation_log l
      where (nullif(p ->> 'kind', '') is null or l.kind = p ->> 'kind')
        and (nullif(p ->> 'status', '') is null or l.status = p ->> 'status')
    )
    select jsonb_build_object(
      'total', (select count(*) from rows),
      'items', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'kind', l.kind, 'status', l.status, 'detail', l.detail, 'created_at', l.created_at,
          'rule_name', r.name, 'actor_name', pr.full_name, 'conversation_id', l.conversation_id,
          'customer_name', c.customer_name, 'conversation_kind', c.kind, 'platform', ch.platform,
          'message', (select public._inbox_preview(m.body, m.attachments) from public.inbox_messages m where m.id = l.message_id)) order by l.created_at desc)
        from (select * from rows order by created_at desc limit v_limit offset v_offset) l
        left join public.inbox_auto_replies r on r.id = l.rule_id
        left join public.profiles pr on pr.id = l.actor
        left join public.inbox_conversations c on c.id = l.conversation_id
        left join public.inbox_channels ch on ch.id = c.channel_id), '[]'::jsonb)));
end;
$$;

revoke all on function public.inbox_bulk(uuid[], jsonb), public.inbox_follow_up_set(uuid, int, text), public.inbox_reminder_set(uuid, timestamptz, text),
  public.inbox_order_message(uuid, text), public.inbox_comments_overview(jsonb), public.inbox_comments(jsonb), public.inbox_automation(),
  public.inbox_settings_save(jsonb), public.inbox_auto_reply_save(jsonb), public.inbox_auto_reply_toggle(uuid, boolean), public.inbox_auto_reply_delete(uuid),
  public.inbox_auto_reply_try(text, text, uuid, boolean), public.inbox_activity(jsonb) from public, anon;
grant execute on function public.inbox_bulk(uuid[], jsonb), public.inbox_follow_up_set(uuid, int, text), public.inbox_reminder_set(uuid, timestamptz, text),
  public.inbox_order_message(uuid, text), public.inbox_comments_overview(jsonb), public.inbox_comments(jsonb), public.inbox_automation(),
  public.inbox_settings_save(jsonb), public.inbox_auto_reply_save(jsonb), public.inbox_auto_reply_toggle(uuid, boolean), public.inbox_auto_reply_delete(uuid),
  public.inbox_auto_reply_try(text, text, uuid, boolean), public.inbox_activity(jsonb) to authenticated;

-- A full store reset also removes the auto replies, settings and their log.
do $$
declare
  v_def text := replace(pg_get_functiondef('public.platform_store_reset(uuid, text, text, text)'::regprocedure), E'\r', '');
  v_anchor text := $a$delete from public.inbox_saved_replies where merchant_id = p_merchant;$a$;
begin
  if position('inbox_auto_replies' in v_def) > 0 then
    return; -- already applied
  end if;
  if position(v_anchor in v_def) = 0 then
    raise exception 'platform_store_reset: expected the inbox step; apply 20261116001900 first';
  end if;
  v_def := replace(v_def, v_anchor, v_anchor || $b$
    delete from public.inbox_automation_log where merchant_id = p_merchant;
    delete from public.inbox_auto_replies where merchant_id = p_merchant;
    delete from public.inbox_settings where merchant_id = p_merchant;$b$);
  execute v_def;
end $$;

-- Follow-ups every minute, only while one is due (the function sends them for each store).
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') or not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise notice 'pg_cron or pg_net missing: inbox-automation not scheduled';
    return;
  end if;
  perform cron.unschedule(jobid) from cron.job where jobname = 'inbox-automation';
  perform cron.schedule('inbox-automation', '* * * * *', $job$
  select net.http_post(
    url := 'https://fullfilio.com/functions/v1/inbox',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{"action": "automation_cron"}'::jsonb,
    timeout_milliseconds := 60000)
  where public.inbox_automation_due()
$job$);
end $$;

select public._tenancy_own_functions();
