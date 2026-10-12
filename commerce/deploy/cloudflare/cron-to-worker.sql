-- Points the scheduled jobs (pg_cron + pg_net) at the Cloudflare Worker.
--
-- Run this only on Workers Paid, after the Worker is live on your domain and
-- SUPABASE_FUNCTIONS is "" there (on Workers Free the long jobs must stay on
-- Supabase: leave the jobs as they are). Paste into Supabase → SQL Editor and
-- run (the address is set to https://fullfilio.com). Undo: cron-to-supabase.sql.
--
-- Nothing else changes: the jobs keep their schedule, their "only when there
-- is work" conditions and their secret. Each call may now take up to two
-- minutes (Workers stop work when the caller hangs up, so pg_net must wait).
do $$
declare
  v_site text := 'https://fullfilio.com';                                -- the Worker's address, no trailing slash
  v_from text := 'https://tcjdgiohmhjqppzwoztj.supabase.co/functions/v1/'; -- where the jobs call today
  v_to text;
  r record;
  v_cmd text;
  v_moved int := 0;
begin
  v_to := rtrim(v_site, '/') || '/functions/v1/';
  for r in select jobid, jobname, command from cron.job where command like '%' || v_from || '%' loop
    v_cmd := replace(r.command, v_from, v_to);
    if v_cmd not like '%timeout_milliseconds%' then
      v_cmd := regexp_replace(v_cmd, '::jsonb\)', '::jsonb, timeout_milliseconds := 120000)');
    end if;
    perform cron.alter_job(r.jobid, command := v_cmd);
    v_moved := v_moved + 1;
    raise notice 'moved %', r.jobname;
  end loop;
  raise notice '% job(s) now call %', v_moved, v_to;
end $$;

-- Check: every HTTP job names the Worker.
select jobname, schedule, substring(command from 'url := ''([^'']+)''') as calls from cron.job where command like '%net.http_post%' order by jobid;
