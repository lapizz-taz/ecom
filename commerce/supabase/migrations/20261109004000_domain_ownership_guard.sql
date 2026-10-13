-- Security run-2 (HIGH, edge-authz-01): cross-tenant custom-domain takeover/DoS.
--
-- domains/handler.ts calls the SHARED Cloudflare zone / Vercel project
-- (removeCloudflare, addCloudflare, Vercel add/remove) directly on the
-- staffer-supplied domain BEFORE store_domain_save does any merchant scoping.
-- A merchant-A staffer with settings.manage could therefore detach (or probe,
-- or attempt to re-attach) merchant-B's live custom domain from the shared
-- provider — a cross-tenant denial of service, and the first step toward
-- hijacking the hostname.
--
-- store_domains.domain is GLOBALLY unique and each row is owned by one
-- merchant_id. This guard compares merchant_id to current_merchant_id()
-- EXPLICITLY (not relying on ambient RLS), so it is correct whether the
-- deployed function is re-owned to app_owner (RLS applies) or stays
-- postgres-owned (RLS bypassed) — the same discipline the exempt Vault
-- functions use. current_merchant_id() resolves from the staff profile (the
-- trusted path), never from a caller-supplied header, so it cannot be spoofed.
-- The handler must call it before touching any provider:
--   * 'add'  : claim the domain for this merchant (insert-on-conflict-do-nothing;
--              the global-unique domain means a row held by another merchant
--              blocks the claim) -> if we do not then own it, reject.
--   * else   : the domain must already be a non-removed row owned by this
--              merchant, or we refuse before the provider call.

create or replace function public.store_domain_guard(p_domain text, p_action text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mid uuid := public.current_merchant_id();
begin
  if not public.is_system_context() then
    perform public.require_permission('settings.manage');
  end if;
  if v_mid is null then
    raise exception 'No merchant in context' using errcode = '42501';
  end if;
  if p_action = 'add' then
    -- Claim it for this merchant if free; a no-op if we already hold it; the
    -- global-unique domain blocks the claim if another merchant holds it.
    insert into public.store_domains(domain, status)
    values (lower(p_domain), 'PENDING')
    on conflict (domain) do nothing;
    if not exists (select 1 from public.store_domains
                   where domain = lower(p_domain) and merchant_id = v_mid and status <> 'REMOVED') then
      raise exception 'That domain is already connected to another store'
        using errcode = '42501';
    end if;
  else
    if not exists (select 1 from public.store_domains
                   where domain = lower(p_domain) and merchant_id = v_mid and status <> 'REMOVED') then
      raise exception 'That domain is not on this store'
        using errcode = '42501';
    end if;
  end if;
end;
$$;

revoke all on function public.store_domain_guard(text, text) from public, anon, authenticated;
grant execute on function public.store_domain_guard(text, text) to authenticated, service_role;
