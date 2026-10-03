-- =============================================================================
-- Shared secret for pg_cron → edge function calls, kept in Vault.
-- Generated once per database (an existing 'cron_secret' — e.g. one created
-- with the CRON_SECRET value as the README describes — is kept), so scheduled
-- jobs work without copying a secret into the function settings by hand.
-- =============================================================================

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'cron_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'cron_secret',
      'Authenticates pg_cron calls to edge functions');
  end if;
end;
$$;

-- Edge functions check a scheduled call's x-cron-secret here; the secret never leaves the database.
create or replace function public.cron_secret_matches(p_secret text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_secret text;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_secret is null or length(p_secret) < 16 then
    return false;
  end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'cron_secret';
  return v_secret is not null
    and extensions.digest(v_secret, 'sha256') = extensions.digest(p_secret, 'sha256');
end;
$$;

revoke execute on function public.cron_secret_matches(text) from public, anon, authenticated;
grant execute on function public.cron_secret_matches(text) to service_role;
