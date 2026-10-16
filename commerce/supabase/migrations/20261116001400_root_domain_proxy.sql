-- Root domains (shop.com) through our own proxy server (deploy/root-proxy): an A record to a
-- fixed address that works at every DNS company. The proxy gets an HTTPS certificate on the
-- first visit to a domain, and asks first whether that domain belongs to a store, so nobody
-- can point a stranger's domain at it to make it issue certificates.

create or replace function public.store_domain_known(p_domain text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.store_domains
                 where domain = lower(trim(coalesce(p_domain, ''))) and status <> 'REMOVED')
$$;

revoke all on function public.store_domain_known(text) from public, anon, authenticated;
grant execute on function public.store_domain_known(text) to service_role;

insert into public.tenancy_exempt_functions (name, reason) values
  ('store_domain_known', 'Says whether a web address is connected to any store, before any merchant is known (root-domain proxy certificates)')
on conflict (name) do nothing;
