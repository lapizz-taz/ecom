-- Custom domains as a feature in Super Admin → Features & Access, switched off for now.
-- While it is off nobody can add a new domain (the database refuses it); domains already
-- connected keep working and can still be checked, made primary or removed.
-- Every plan includes it, so the global switch alone decides.

insert into public.features (code, name, description, category, is_core, globally_enabled, release_stage, sort_order)
values ('custom_domains', 'Custom domains', 'Connect your own domain to the online store', 'store', false, false, 'GA', 15)
on conflict (code) do nothing;

update public.plans set features = features || jsonb_build_object('custom_domains', true)
where not features ? 'custom_domains';

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
    perform public.require_feature('custom_domains');
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
