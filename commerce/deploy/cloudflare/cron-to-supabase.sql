-- Rollback for cron-to-worker.sql: the scheduled jobs call the Supabase Edge
-- Functions again (which stay deployed). Change v_site to the address used in
-- cron-to-worker.sql and run in Supabase → SQL Editor.
do $$
declare
  v_site text := 'https://YOUR-DOMAIN';
  v_to text := 'https://tcjdgiohmhjqppzwoztj.supabase.co/functions/v1/';
  v_from text;
  r record;
  v_moved int := 0;
begin
  if v_site like '%YOUR-DOMAIN%' then
    raise exception 'Set v_site to the Worker address first';
  end if;
  v_from := rtrim(v_site, '/') || '/functions/v1/';
  for r in select jobid, jobname, command from cron.job where command like '%' || v_from || '%' loop
    perform cron.alter_job(r.jobid, command := replace(replace(r.command, v_from, v_to), ', timeout_milliseconds := 120000)', ')'));
    v_moved := v_moved + 1;
    raise notice 'moved back %', r.jobname;
  end loop;
  raise notice '% job(s) call Supabase again', v_moved;
end $$;

select jobname, schedule, substring(command from 'url := ''([^'']+)''') as calls from cron.job where command like '%net.http_post%' order by jobid;
