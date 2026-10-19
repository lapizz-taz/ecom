-- Menu badges: Inbox counts unread direct messages, Comments counts unread comments, and
-- Messaging shows both. inbox_unread_count() counted comments too, so Inbox showed a number
-- while its list (messages only) was empty.

create or replace function public.inbox_unread_counts()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when public.has_permission('inbox.view') then (
    select jsonb_build_object(
      'messages', count(*) filter (where kind = 'MESSAGE'),
      'comments', count(*) filter (where kind = 'COMMENT'))
    from public.inbox_conversations where unread_count > 0 and status <> 'DONE')
  else jsonb_build_object('messages', 0, 'comments', 0) end
$$;

revoke all on function public.inbox_unread_counts() from public, anon;
grant execute on function public.inbox_unread_counts() to authenticated;

select public._tenancy_own_functions();
