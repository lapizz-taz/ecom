-- A store could hold any domain (and its www twin) forever by adding it and never proving it,
-- so the real owner's store got "already connected to another store". Now a claim nobody
-- proved within 7 days is released like a removed one, for the name and for its twin, and a
-- store can hold at most 10 unproven domains at a time.

create or replace function public._store_domain_release(p_domain text, p_merchant uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  delete from public.store_domains
  where domain in (lower(trim(coalesce(p_domain, ''))), public._store_domain_twin(lower(trim(coalesce(p_domain, '')))))
    and merchant_id <> p_merchant
    and (status = 'REMOVED' or (verified_at is null and created_at < now() - interval '7 days'))
$$;
revoke all on function public._store_domain_release(text, uuid) from public, anon, authenticated;

create or replace function public.store_domain_guard(p_domain text, p_action text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mid uuid := public.current_merchant_id();
  v_d text := lower(trim(coalesce(p_domain, '')));
begin
  if not public.is_system_context() then
    perform public.require_permission('settings.manage');
  end if;
  if v_mid is null then
    raise exception 'No merchant in context' using errcode = '42501';
  end if;
  if p_action = 'add' then
    perform public.require_feature('custom_domains');
    if public._store_domain_reserved(v_d) then
      raise exception 'DOMAIN_REJECTED: That is the platform''s own domain; use your store address or a domain you own' using errcode = 'P0001';
    end if;
    -- One store at a time per name pair: two stores adding shop.com and www.shop.com at once
    -- would otherwise both pass the twin check.
    perform pg_advisory_xact_lock(hashtext('store_domain:' || regexp_replace(v_d, '^www\.', '')));
    -- Removed by another store, or claimed and never proven for a week: it serves nobody, so
    -- this store may connect it (the name and its twin).
    perform public._store_domain_release(v_d, v_mid);
    -- www.example.com and example.com serve the same store, so both belong to one store.
    if public._store_domain_taken(public._store_domain_twin(v_d), v_mid) then
      raise exception 'DUPLICATE: That domain is already connected to another store' using errcode = 'P0001';
    end if;
    if (select count(*) from public.store_domains
        where merchant_id = v_mid and status <> 'REMOVED' and verified_at is null and domain <> v_d) >= 10 then
      raise exception 'LIMIT_REACHED: Prove the domains you added (their TXT record) or remove some before adding more' using errcode = 'P0001';
    end if;
    insert into public.store_domains(domain, status, verify_code)
    values (v_d, 'PENDING', replace(gen_random_uuid()::text, '-', ''))
    on conflict (domain) do nothing;
    -- Removed earlier by this store: bring it back (it proves ownership again; same code).
    update public.store_domains
       set status = 'PENDING', is_primary = false, verified_at = null,
           verify_code = coalesce(verify_code, replace(gen_random_uuid()::text, '-', ''))
     where domain = v_d and merchant_id = v_mid and status = 'REMOVED';
    if not exists (select 1 from public.store_domains
                   where domain = v_d and merchant_id = v_mid and status <> 'REMOVED') then
      raise exception 'DUPLICATE: That domain is already connected to another store' using errcode = 'P0001';
    end if;
  else
    if not exists (select 1 from public.store_domains
                   where domain = v_d and merchant_id = v_mid and status <> 'REMOVED') then
      raise exception 'NOT_FOUND: That domain is not on this store' using errcode = 'P0001';
    end if;
  end if;
end;
$$;

select public._tenancy_own_functions();
