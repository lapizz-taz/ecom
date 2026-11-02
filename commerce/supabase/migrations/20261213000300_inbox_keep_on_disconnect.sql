-- =============================================================================
-- Messaging: a store's chats stay when it disconnects a Page; a message the customer deletes is erased.
--
-- Meta Platform Terms 3.d: a Tech Provider deletes Platform Data when a User or the Client asks, or
-- when keeping it is no longer necessary for a legitimate business purpose.
--
--   * Disconnect (Messaging → Channels) ends the connection, not the store's records: the access
--     token is deleted and Meta stops sending events, while the Page's chats and comments stay in the
--     inbox (as the Disconnect dialog and the privacy policy say). Connecting the same Page again
--     carries on in the same chats. "Delete its messages" on a disconnected account removes them
--     for good (inbox_channel_remove, unchanged): the store asking for deletion.
--   * A customer who deletes (unsends) a Messenger or Instagram message, or whose Facebook comment
--     is removed on Facebook, asked for it to go: its words and files are erased here too, and a
--     mobile number that only it carried leaves the chat's contact details. The
--     row stays as "deleted" (who and when) so the conversation still reads in order. A comment the
--     store deleted from Fullfilio keeps its text as the store's moderation record, under Deleted.
--
-- New: inbox_messages.erased_at, inbox_channel_disconnect(), inbox_message_erase(); inbox_comments()
-- returns erased_at with each comment. Safe to re-run.
-- =============================================================================

alter table public.inbox_messages
  add column if not exists erased_at timestamptz;

-- Disconnect: stop the connection, keep the conversations.
create or replace function public.inbox_channel_disconnect(p_id uuid, p_actor uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.inbox_channels;
  v_conversations int;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select * into v_row from public.inbox_channels where id = p_id;
  if v_row.id is null then
    raise exception 'NOT_FOUND: Channel not found' using errcode = 'P0002';
  end if;
  update public.inbox_channels
    set status = 'DISCONNECTED', status_error = null, token_hint = null, updated_at = now()
    where id = p_id;
  -- Nothing more goes out on its own from an account that is no longer connected.
  update public.inbox_conversations set auto_follow_up_at = null, auto_follow_up_text = null, auto_follow_up_by = null
    where channel_id = p_id and auto_follow_up_at is not null;
  select count(*)::int into v_conversations from public.inbox_conversations where channel_id = p_id;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, old_values, new_values)
  values (p_actor, 'inbox_channel.disconnected', 'inbox_channel', v_row.id,
    jsonb_build_object('platform', v_row.platform, 'name', v_row.name, 'status', v_row.status),
    jsonb_build_object('status', 'DISCONNECTED', 'conversations_kept', v_conversations));
  return jsonb_build_object('disconnected', true, 'conversations', v_conversations);
end;
$$;
revoke all on function public.inbox_channel_disconnect(uuid, uuid) from public, anon, authenticated;
grant execute on function public.inbox_channel_disconnect(uuid, uuid) to service_role;

-- The customer deleted it on Facebook or Instagram: erase its words and files here too.
-- A comment the store already deleted from Fullfilio keeps its text (removed_at set first).
create or replace function public.inbox_message_erase(p_channel uuid, p_external_id text)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
  v_phone text;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_channel is null or coalesce(p_external_id, '') = '' then
    return 0;
  end if;
  -- A mobile number typed in it may have filled the chat's number (inbox_ingest): that goes too.
  select array_agg(distinct m.conversation_id), max(public._inbox_bd_phone(m.body)) into v_ids, v_phone
    from public.inbox_messages m
    join public.inbox_conversations c on c.id = m.conversation_id
    where c.channel_id = p_channel and m.external_id = p_external_id and m.erased_at is null and m.removed_at is null;
  if v_ids is null then
    return 0;
  end if;
  update public.inbox_messages
    set body = null, attachments = '[]'::jsonb, erased_at = now(), removed_at = now()
    where conversation_id = any (v_ids) and external_id = p_external_id and erased_at is null and removed_at is null;
  -- The list shows the latest message: say it was deleted instead of quoting it.
  update public.inbox_conversations c
    set last_message_preview = (select case when m.erased_at is not null then 'Message deleted'
                                            else public._inbox_preview(m.body, m.attachments) end
                                from public.inbox_messages m where m.conversation_id = c.id order by m.created_at desc limit 1)
    where c.id = any (v_ids);
  if v_phone is not null then
    update public.inbox_conversations c set customer_phone = null, updated_at = now()
      where c.id = any (v_ids) and c.customer_phone = v_phone
        and not exists (select 1 from public.inbox_messages m
                        where m.conversation_id = c.id and m.direction = 'IN' and public._inbox_bd_phone(m.body) = v_phone);
  end if;
  return cardinality(v_ids);
end;
$$;
revoke all on function public.inbox_message_erase(uuid, text) from public, anon, authenticated;
grant execute on function public.inbox_message_erase(uuid, text) to service_role;

-- Comments: say which ones the customer deleted (their text is gone).
create or replace function pg_temp.patch_fn(p_fn text, p_from text, p_to text)
returns void
language plpgsql as $$
declare
  v_old text := replace(pg_get_functiondef(p_fn::regprocedure), E'\r', '');
  v_hits int;
begin
  if position(p_to in v_old) > 0 then
    return; -- already patched
  end if;
  v_hits := (length(v_old) - length(replace(v_old, p_from, ''))) / length(p_from);
  if v_hits <> 1 then
    raise exception 'inbox: % has changed (% matches for "%")', p_fn, v_hits, left(p_from, 60);
  end if;
  execute replace(v_old, p_from, p_to);
end $$;

-- Single-line texts only: an SQL editor may send its own line breaks, which would never match.
select pg_temp.patch_fn('public.inbox_comments(jsonb)',
  $a$'removed_at', (w.r).removed_at, 'filtered', (w.r).filtered)$a$,
  $b$'removed_at', (w.r).removed_at, 'erased_at', (w.r).erased_at, 'filtered', (w.r).filtered)$b$);

select public._tenancy_own_functions();
