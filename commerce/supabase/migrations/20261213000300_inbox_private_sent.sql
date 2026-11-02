-- =============================================================================
-- Comments: Meta allows one private message per comment (within 7 days of it). A second one failed
-- with Meta's "(#-1) The comment you are trying to reply to, already has a reply". inbox_comments()
-- now says whether it was sent (private_sent), so the Comments page shows "Private message sent"
-- and stops offering another. A failed attempt does not count. Safe to re-run.
-- =============================================================================

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
  $a$'replied', exists (select 1 from public.inbox_messages o where o.conversation_id = (w.c).id and o.direction = 'OUT' and o.status <> 'FAILED'),$a$,
  $b$'replied', exists (select 1 from public.inbox_messages o where o.conversation_id = (w.c).id and o.direction = 'OUT' and o.status <> 'FAILED'), 'private_sent', exists (select 1 from public.inbox_messages o where o.conversation_id = (w.c).id and o.direction = 'OUT' and o.private_reply and o.status <> 'FAILED'),$b$);

select public._tenancy_own_functions();
