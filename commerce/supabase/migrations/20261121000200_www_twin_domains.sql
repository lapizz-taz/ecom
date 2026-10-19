-- www.example.com works by itself once example.com is connected (and the other way round),
-- the way Shopify does it: the root-domain proxy may get a certificate for the twin, and
-- visiting the twin opens the store on the connected domain. store_domain_guard already
-- keeps both names on the same store, so a twin never leads to another store.

create or replace function public.store_domain_known(p_domain text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with asked as (select lower(trim(coalesce(p_domain, ''))) as d)
  select not public._store_domain_reserved(a.d)
     and exists (select 1 from public.store_domains s
                 where s.domain in (a.d, regexp_replace(a.d, '^www\.', ''), 'www.' || a.d)
                   and s.status <> 'REMOVED' and not public._store_domain_reserved(s.domain))
  from asked a
$$;

revoke all on function public.store_domain_known(text) from public, anon, authenticated;
grant execute on function public.store_domain_known(text) to service_role;

/**
 * What a web address shows: a store (custom domain or <slug>.<root domain>),
 * the platform's own website ("platform"), or a store that does not exist or
 * is switched off ("missing"). The www/root twin of a connected domain opens
 * the same store and moves on to the primary domain, else to the connected one.
 */
create or replace function public.storefront_resolve(p_host text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_host text := regexp_replace(lower(trim(coalesce(p_host, ''))), ':[0-9]+$', '');
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
    where domain in (v_host, regexp_replace(v_host, '^www\.', ''), 'www.' || v_host) and status <> 'REMOVED'
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
    return case when v_main = 'marketing' then jsonb_build_object('kind', 'platform') end;
  end if;
  return public._store_json(v_m, v_primary);
end;
$$;

grant execute on function public.storefront_resolve(text) to anon, authenticated;

select public._tenancy_own_functions();
