-- A custom domain that was removed could never be added again: the add claimed the
-- domain with insert-on-conflict-do-nothing, the removed row stayed REMOVED, and the
-- guard then refused it as "connected to another store". That refusal used errcode
-- 42501, so the admin only saw "You do not have permission to do that".
--
-- A REMOVED row of this store is detached from the hosting and serves nobody, so adding it
-- again brings it back (store_domain_save already handles a REMOVED row coming back).
-- A domain another store still uses stays refused, now with its real reason.

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
    insert into public.store_domains(domain, status)
    values (lower(p_domain), 'PENDING')
    on conflict (domain) do nothing;
    -- Removed earlier by this store: bring it back.
    update public.store_domains
       set status = 'PENDING', is_primary = false
     where domain = lower(p_domain) and merchant_id = v_mid and status = 'REMOVED';
    if not exists (select 1 from public.store_domains
                   where domain = lower(p_domain) and merchant_id = v_mid and status <> 'REMOVED') then
      raise exception 'DUPLICATE: That domain is already connected to another store' using errcode = 'P0001';
    end if;
  else
    if not exists (select 1 from public.store_domains
                   where domain = lower(p_domain) and merchant_id = v_mid and status <> 'REMOVED') then
      raise exception 'NOT_FOUND: That domain is not on this store' using errcode = 'P0001';
    end if;
  end if;
end;
$$;

revoke all on function public.store_domain_guard(text, text) from public, anon, authenticated;
grant execute on function public.store_domain_guard(text, text) to authenticated, service_role;
