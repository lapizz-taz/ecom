-- Custom domains, from an audit with many stores and domains:
--  * A store's www twin could open another store that had connected www.www.<domain>: the
--    lookups matched three names (the host, the host without www., www.+host) instead of the
--    one twin the guard keeps on the same store.
--  * "shop.com." (what a browser sends for a name typed with a final dot) opened the wrong site.
--  * A domain one store removed could never be connected by another store.
--  * A closed store's domain showed the platform's website; it still got new certificates.
--  * A re-check that landed after the domain was removed brought it back to life.
--  * store_domain_save did not enforce the guard's rules itself (platform names, twins).
--  * Two stores adding shop.com and www.shop.com at the same moment could both pass.

/** The one other name that serves the same store: www.<d> for <d>, and <d> for www.<d>. */
create or replace function public._store_domain_twin(p_domain text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case when p_domain like 'www.%' then substr(p_domain, 5) else 'www.' || p_domain end
$$;

/** A host name as compared: lower case, no spaces, no port, no final dot. */
create or replace function public._store_host(p_host text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select regexp_replace(regexp_replace(lower(trim(coalesce(p_host, ''))), ':[0-9]+$', ''), '\.$', '')
$$;

-- Frees a name another store removed, so this store can connect it (rows of other stores are
-- hidden from tenant functions by row security, so this one is exempt).
create or replace function public._store_domain_release(p_domain text, p_merchant uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  delete from public.store_domains
  where domain = lower(trim(coalesce(p_domain, ''))) and status = 'REMOVED' and merchant_id <> p_merchant
$$;
revoke all on function public._store_domain_release(text, uuid) from public, anon, authenticated;

insert into public.tenancy_exempt_functions (name, reason)
values ('_store_domain_release', 'Custom domains: frees a name another store removed, so a new store can connect it')
on conflict (name) do nothing;

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
    -- www.example.com and example.com serve the same store, so both belong to one store.
    if public._store_domain_taken(public._store_domain_twin(v_d), v_mid) then
      raise exception 'DUPLICATE: That domain is already connected to another store' using errcode = 'P0001';
    end if;
    -- Removed by another store: it serves nobody, so this store may connect it.
    perform public._store_domain_release(v_d, v_mid);
    insert into public.store_domains(domain, status)
    values (v_d, 'PENDING')
    on conflict (domain) do nothing;
    -- Removed earlier by this store: bring it back.
    update public.store_domains
       set status = 'PENDING', is_primary = false
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

create or replace function public.store_domain_save(p_domain text, p jsonb, p_actor uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_d text := lower(trim(coalesce(p_domain, '')));
  v_status text := coalesce(p ->> 'status', 'PENDING');
  v_row public.store_domains;
  v_next uuid;
begin
  perform public._require_system();
  -- The guard's rules hold here too: never a platform name, never the twin of another store's domain.
  if v_status <> 'REMOVED' then
    if public._store_domain_reserved(v_d) then
      raise exception 'DOMAIN_REJECTED: That is the platform''s own domain' using errcode = 'P0001';
    end if;
    if public._store_domain_taken(public._store_domain_twin(v_d), public.current_merchant_id()) then
      raise exception 'DUPLICATE: That domain is already connected to another store' using errcode = 'P0001';
    end if;
  end if;
  insert into public.store_domains(domain, status, records, detail, diagnostics, created_by, checked_at, is_primary)
  values (v_d, v_status, coalesce(p -> 'records', '[]'::jsonb), p ->> 'detail', p -> 'diagnostics', p_actor, now(),
          v_status <> 'REMOVED'
            and not exists (select 1 from public.store_domains x where x.is_primary and x.status <> 'REMOVED'))
  on conflict (domain) do update set
    status = coalesce(p ->> 'status', store_domains.status), records = coalesce(p -> 'records', store_domains.records),
    detail = case when p ? 'detail' then p ->> 'detail' else store_domains.detail end,
    diagnostics = case when p ? 'diagnostics' then p -> 'diagnostics' else store_domains.diagnostics end,
    is_primary = case when coalesce(p ->> 'status', store_domains.status) = 'REMOVED' then false
                      else store_domains.is_primary
                        or not exists (select 1 from public.store_domains x where x.is_primary and x.status <> 'REMOVED' and x.id <> store_domains.id) end,
    checked_at = now()
  -- Removed meanwhile (a re-check that finished after the store removed it): it stays removed.
  -- Adding it again goes through the guard, which moves it off REMOVED first.
  where store_domains.status <> 'REMOVED' or coalesce(p ->> 'status', '') = 'REMOVED'
  returning * into v_row;
  if not found then
    return null;
  end if;
  if v_row.status = 'REMOVED' and not exists (select 1 from public.store_domains x where x.is_primary and x.status <> 'REMOVED') then
    select id into v_next from public.store_domains where status <> 'REMOVED' order by (status = 'ACTIVE') desc, created_at, id limit 1;
    if v_next is not null then
      update public.store_domains set is_primary = true where id = v_next;
    end if;
  end if;
  if p_actor is not null then
    perform public.log_audit('store_domain.' || lower(v_row.status), 'store_domain', v_row.id::text, null,
      jsonb_build_object('domain', v_row.domain, 'status', v_row.status));
  end if;
  return to_jsonb(v_row);
end;
$$;

-- The root proxy asks this before getting a certificate: a connected domain (or its one twin)
-- of a store that is not closed.
create or replace function public.store_domain_known(p_domain text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- A certificate name as the proxy sends it (no port); a final dot is the same name.
  with asked as (select regexp_replace(lower(trim(coalesce(p_domain, ''))), '\.$', '') as d)
  select a.d <> '' and not public._store_domain_reserved(a.d)
     and exists (select 1 from public.store_domains s join public.merchants m on m.id = s.merchant_id
                 where s.domain in (a.d, public._store_domain_twin(a.d))
                   and s.status <> 'REMOVED' and m.status <> 'CLOSED' and not public._store_domain_reserved(s.domain))
  from asked a
$$;

revoke all on function public.store_domain_known(text) from public, anon, authenticated;
grant execute on function public.store_domain_known(text) to service_role;

/**
 * What a web address shows: a store (custom domain or <slug>.<root domain>),
 * the platform's own website ("platform"), or a store that does not exist or
 * is switched off ("missing"). The www/root twin of a connected domain opens
 * the same store and moves on to the primary domain, else to the connected one;
 * a domain the store removed, or of a closed store, shows "store not available".
 */
create or replace function public.storefront_resolve(p_host text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_host text := public._store_host(p_host);
  v_twin text := public._store_domain_twin(public._store_host(p_host));
  v_id uuid;
  v_found text;
  v_m public.merchants;
  v_primary text;
  v_root text := public._store_root_domain();
  v_sub text;
  v_main text := coalesce((select value ->> 'main_site' from public.platform_settings where key = 'store_domains'), 'store');
begin
  if v_host <> '' then
    select merchant_id, domain into v_id, v_found from public.store_domains
    where domain in (v_host, v_twin) and status <> 'REMOVED'
      and not public._store_domain_reserved(domain)
    order by (domain = v_host) desc limit 1;
    if v_id is not null then
      select domain into v_primary from public.store_domains
      where merchant_id = v_id and is_primary and status = 'ACTIVE' and domain <> v_host;
      -- Only the twin is connected: open the store there.
      if v_primary is null and v_found <> v_host
         and exists (select 1 from public.store_domains where domain = v_found and status = 'ACTIVE') then
        v_primary := v_found;
      end if;
    end if;
    -- A store's domain that was removed: "store not available", never the platform's own website.
    if v_id is null and exists (select 1 from public.store_domains
                                where domain in (v_host, v_twin) and status = 'REMOVED'
                                  and not public._store_domain_reserved(domain)) then
      return jsonb_build_object('kind', 'missing');
    end if;
  end if;

  if v_id is null and v_root is not null and v_host like '%.' || v_root then
    v_sub := left(v_host, length(v_host) - length(v_root) - 1);
    if v_sub not in ('www', 'app') and position('.' in v_sub) = 0 then
      select m.* into v_m from public.merchants m
      where m.slug = v_sub and m.status <> 'CLOSED'
        and coalesce((select s.value ->> 'mode' from public.settings s where s.merchant_id = m.id and s.key = 'storefront'), 'OWN') = 'OWN';
      if v_m.id is null then
        return jsonb_build_object('kind', 'missing');
      end if;
      return public._store_json(v_m);
    end if;
  end if;

  if v_id is null then
    if v_main = 'marketing' then
      return jsonb_build_object('kind', 'platform');
    end if;
    select nullif(value ->> 'default_merchant_id', '')::uuid into v_id from public.platform_settings where key = 'storefront';
  end if;
  select * into v_m from public.merchants where id = v_id and status <> 'CLOSED';
  if v_m.id is null then
    -- A closed store's own domain: "store not available", not the platform's website.
    return case when v_found is not null then jsonb_build_object('kind', 'missing')
                when v_main = 'marketing' then jsonb_build_object('kind', 'platform') end;
  end if;
  return public._store_json(v_m, v_primary);
end;
$$;

grant execute on function public.storefront_resolve(text) to anon, authenticated;

select public._tenancy_own_functions();
