-- =============================================================================
-- Super Admin → System Health loads in a moment again, and the scheduler's run history stays small.
--
-- pg_cron writes one row to cron.job_run_details for every run of every job and never removes
-- them. The table had grown to about 150 MB with no index on job or time, and platform_health()
-- read all of it three times per job (the latest run, runs in 24 h, failed runs in 24 h): about
-- 60 full reads, 4 to 8 seconds, so the page sat on its loading tiles. The new-order notification
-- check (every 15 seconds) makes the table grow faster.
--
--   * platform_health() now reads the history twice in total: the latest run of each job from the
--     last 7 days, and the counts for the last 24 hours. Same result, same shape.
--   * A nightly job keeps 7 days of run history ("cron-history-cleanup", 03:17 UTC).
--   * Run history older than 7 days is removed now, once.
--
-- platform_health is patched in place (CREATE OR REPLACE keeps its owner and grants). Safe to re-run.
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
    raise exception 'system health: % has changed (% matches for "%")', p_fn, v_hits, left(p_from, 60);
  end if;
  execute replace(v_old, p_from, p_to);
end $$;

-- Single-line texts only: an SQL editor may send its own line breaks, which would never match.
select pg_temp.patch_fn('public.platform_health()',
  $a$'runs_24h', (select count(*) from cron.job_run_details d where d.jobid = j.jobid and d.start_time > now() - interval '24 hours'),$a$,
  $b$'runs_24h', coalesce(a.runs_24h, 0),$b$);

select pg_temp.patch_fn('public.platform_health()',
  $a$'failed_24h', (select count(*) from cron.job_run_details d where d.jobid = j.jobid and d.start_time > now() - interval '24 hours' and d.status = 'failed'))$a$,
  $b$'failed_24h', coalesce(a.failed_24h, 0))$b$);

select pg_temp.patch_fn('public.platform_health()',
  $a$left join lateral (select d.status, d.end_time, d.return_message from cron.job_run_details d where d.jobid = j.jobid order by d.start_time desc limit 1) l on true$a$,
  $b$left join (select distinct on (d.jobid) d.jobid, d.status, d.end_time, d.return_message from cron.job_run_details d where d.start_time > now() - interval '7 days' order by d.jobid, d.start_time desc) l on l.jobid = j.jobid left join (select d.jobid, count(*) as runs_24h, count(*) filter (where d.status = 'failed') as failed_24h from cron.job_run_details d where d.start_time > now() - interval '24 hours' group by d.jobid) a on a.jobid = j.jobid$b$);

-- Keep 7 days of run history: nightly, and once now.
do $$
begin
  if to_regclass('cron.job_run_details') is null or not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron missing: no run history to keep small';
    return;
  end if;
  perform cron.unschedule(jobid) from cron.job where jobname = 'cron-history-cleanup';
  perform cron.schedule('cron-history-cleanup', '17 3 * * *',
    $job$delete from cron.job_run_details where start_time < now() - interval '7 days'$job$);
  execute $q$delete from cron.job_run_details where start_time < now() - interval '7 days'$q$;
  begin
    execute 'analyze cron.job_run_details';
  exception when others then
    null; -- not ours to analyze here: autovacuum does it
  end;
end $$;

select public._tenancy_own_functions();
