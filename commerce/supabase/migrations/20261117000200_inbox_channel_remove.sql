-- =============================================================================
-- Messaging → Channels: remove a Page, Instagram account or WhatsApp number
-- from the store for good (Disconnect only stops it; the row stays in the list).
-- Its conversations and messages go with it. The `inbox` function clears the
-- saved token and stops Meta's webhooks for the Page first, then calls this.
-- =============================================================================

create or replace function public.inbox_channel_remove(p_id uuid, p_actor uuid default null)
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
  select count(*)::int into v_conversations from public.inbox_conversations where channel_id = p_id;
  delete from public.inbox_channels where id = p_id;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, old_values)
  values (p_actor, 'inbox_channel.removed', 'inbox_channel', v_row.id,
    jsonb_build_object('platform', v_row.platform, 'name', v_row.name, 'external_id', v_row.external_id, 'conversations', v_conversations));
  return jsonb_build_object('removed', true, 'conversations', v_conversations);
end;
$$;

revoke all on function public.inbox_channel_remove(uuid, uuid) from public, anon, authenticated;
grant execute on function public.inbox_channel_remove(uuid, uuid) to service_role;

select public._tenancy_own_functions();
