-- The domains re-check also runs while a live domain still shows a problem (the function decides who is due).
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise notice 'pg_cron or pg_net missing: domains-recheck not scheduled';
    return;
  end if;
  perform cron.unschedule(jobid) from cron.job where jobname = 'domains-recheck';
  perform cron.schedule('domains-recheck', '*/10 * * * *', $job$
  select net.http_post(
    url := 'https://fullfilio.com/functions/v1/domains',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{"action": "recheck_all"}'::jsonb,
    timeout_milliseconds := 120000)
  where exists (select 1 from public.store_domains where status <> 'REMOVED')
$job$);
end $$;
