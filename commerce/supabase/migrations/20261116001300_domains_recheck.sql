-- Custom domains go live by themselves: every 10 minutes the domains function checks each
-- domain still waiting for its DNS (as if its owner pressed Check), attaches it to the
-- hosting if needed and saves what it found. Nobody has to come back and press Check.
--
-- The domains function runs on the site (Cloudflare Worker), which holds the hosting keys,
-- so the job calls the site's address. It only calls when a domain is waiting.
-- Skipped where pg_cron / pg_net are not installed (local tests); the Worker runs the same
-- job itself when it hosts the database.
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
  where exists (select 1 from public.store_domains where status in ('PENDING', 'VERIFYING', 'MANUAL', 'ERROR'))
$job$);
end $$;
