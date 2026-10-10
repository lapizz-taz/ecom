-- A change that arrives while the job for the same item is already running is
-- no longer folded into that run (the run has already read the store, so the
-- change was lost: e.g. Shopify's count moved again a moment after we set it,
-- and the difference stayed on the Stock tab). Such a job is marked "rerun"
-- and goes back in the queue as soon as the current run ends.
create or replace function public.channel_job_enqueue(p_channel_id uuid, p_kind text, p_ref_id uuid, p_payload jsonb default '{}'::jsonb, p_delay_seconds int default 0)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into public.channel_sync_jobs(channel_id, kind, ref_id, payload, next_attempt_at)
  values (p_channel_id, p_kind, p_ref_id, coalesce(p_payload, '{}'::jsonb), now() + make_interval(secs => greatest(p_delay_seconds, 0)))
  on conflict (channel_id, kind, ref_id) where status in ('PENDING', 'RUNNING') do update
    set payload = channel_sync_jobs.payload || excluded.payload
          || case when channel_sync_jobs.status = 'RUNNING' then '{"rerun": true}'::jsonb else '{}'::jsonb end,
        next_attempt_at = least(channel_sync_jobs.next_attempt_at, excluded.next_attempt_at)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.channel_job_finish(p_id uuid, p_outcome text, p_error text default null, p_result jsonb default null, p_delay_seconds int default null)
returns public.channel_sync_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.channel_sync_jobs;
begin
  perform public._require_system();
  select * into v_job from public.channel_sync_jobs where id = p_id for update;
  if not found then
    raise exception 'NOT_FOUND: job not found' using errcode = 'P0002';
  end if;
  if p_outcome = 'RETRY' and v_job.attempts < v_job.max_attempts then
    update public.channel_sync_jobs set status = 'PENDING', locked_until = null, last_error = left(p_error, 1000), result = p_result,
      payload = payload - 'rerun',
      next_attempt_at = now() + make_interval(secs => coalesce(p_delay_seconds, least(30 * power(2, v_job.attempts - 1), 21600)::int))
    where id = p_id returning * into v_job;
  elsif v_job.payload ? 'rerun' then
    -- Something changed during this run: look again with fresh data.
    update public.channel_sync_jobs set status = 'PENDING', locked_until = null, attempts = 0, payload = payload - 'rerun',
      last_error = case when p_outcome = 'DONE' then null else left(coalesce(p_error, 'Failed'), 1000) end, result = p_result,
      next_attempt_at = now() + interval '10 seconds'
    where id = p_id returning * into v_job;
  elsif p_outcome = 'DONE' then
    update public.channel_sync_jobs set status = 'DONE', done_at = now(), last_error = null, result = p_result, locked_until = null
    where id = p_id returning * into v_job;
  else
    update public.channel_sync_jobs set status = 'FAILED', locked_until = null, last_error = left(coalesce(p_error, 'Failed'), 1000), result = p_result
    where id = p_id returning * into v_job;
  end if;
  return v_job;
end;
$$;
