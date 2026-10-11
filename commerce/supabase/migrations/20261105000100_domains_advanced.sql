-- =============================================================================
-- Custom domains, advanced status (like Shopify's domain page).
--
-- 1. The domains edge function now stores a full diagnosis with each check:
--    the DNS records it found and whether each points at the store, whether
--    every region resolves it, HTTPS, and issues such as a Cloudflare proxy.
-- 2. Domain type: one domain per business is the primary domain; the others
--    redirect to it once it is live. The first domain added becomes primary.
--    storefront_resolve() returns redirect_to for a non-primary address.
-- =============================================================================

alter table public.store_domains add column if not exists is_primary boolean not null default false;
alter table public.store_domains add column if not exists diagnostics jsonb;

-- A business that already has domains: its oldest live (else oldest) domain becomes primary.
update public.store_domains d set is_primary = true
where d.id in (
  select distinct on (merchant_id) id from public.store_domains
  where status <> 'REMOVED'
  order by merchant_id, (status = 'ACTIVE') desc, created_at, id)
  and not exists (select 1 from public.store_domains x where x.merchant_id = d.merchant_id and x.is_primary and x.status <> 'REMOVED');

create unique index if not exists store_domains_one_primary on public.store_domains (merchant_id) where is_primary and status <> 'REMOVED';

create or replace function public.store_domain_save(p_domain text, p jsonb, p_actor uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.store_domains;
  v_next uuid;
begin
  perform public._require_system();
  insert into public.store_domains(domain, status, records, detail, diagnostics, created_by, checked_at, is_primary)
  values (lower(p_domain), coalesce(p ->> 'status', 'PENDING'), coalesce(p -> 'records', '[]'::jsonb), p ->> 'detail', p -> 'diagnostics', p_actor, now(),
          coalesce(p ->> 'status', 'PENDING') <> 'REMOVED'
            and not exists (select 1 from public.store_domains x where x.is_primary and x.status <> 'REMOVED'))
  on conflict (domain) do update set
    status = coalesce(p ->> 'status', store_domains.status), records = coalesce(p -> 'records', store_domains.records),
    detail = case when p ? 'detail' then p ->> 'detail' else store_domains.detail end,
    diagnostics = case when p ? 'diagnostics' then p -> 'diagnostics' else store_domains.diagnostics end,
    -- Added again after removal: primary again only if the business has none.
    is_primary = case when coalesce(p ->> 'status', store_domains.status) = 'REMOVED' then false
                      when store_domains.status = 'REMOVED' then not exists (select 1 from public.store_domains x where x.is_primary and x.status <> 'REMOVED' and x.id <> store_domains.id)
                      else store_domains.is_primary end,
    checked_at = now()
  returning * into v_row;
  -- The primary domain was removed: the oldest remaining (live first) takes over.
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

-- Staff: make this domain the one the others redirect to.
create or replace function public.store_domain_set_primary(p_domain text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.store_domains;
  v_old text;
begin
  perform public.require_permission('settings.manage');
  select * into v_row from public.store_domains where domain = lower(trim(coalesce(p_domain, ''))) and status <> 'REMOVED' for update;
  if not found then
    raise exception 'NOT_FOUND: that domain is not connected to this store' using errcode = 'P0002';
  end if;
  if v_row.is_primary then
    return to_jsonb(v_row);
  end if;
  select domain into v_old from public.store_domains where is_primary and status <> 'REMOVED';
  update public.store_domains set is_primary = false where is_primary and status <> 'REMOVED';
  update public.store_domains set is_primary = true where id = v_row.id returning * into v_row;
  perform public.log_audit('store_domain.primary', 'store_domain', v_row.id::text,
    jsonb_build_object('primary', v_old), jsonb_build_object('primary', v_row.domain));
  return to_jsonb(v_row);
end;
$$;

revoke all on function public.store_domain_set_primary(text) from public, anon;
grant execute on function public.store_domain_set_primary(text) to authenticated;

-- The store a browser is looking at, and where a non-primary custom domain
-- should send the visitor (only once the primary domain is live).
create or replace function public.storefront_resolve(p_host text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_host text := lower(trim(coalesce(p_host, '')));
  v_id uuid;
  v_m public.merchants;
  v_primary text;
begin
  v_host := regexp_replace(v_host, ':[0-9]+$', '');
  if v_host <> '' then
    select merchant_id into v_id from public.store_domains
    where domain in (v_host, regexp_replace(v_host, '^www\.', ''), 'www.' || v_host) and status <> 'REMOVED'
    order by (domain = v_host) desc limit 1;
    if v_id is not null then
      select domain into v_primary from public.store_domains
      where merchant_id = v_id and is_primary and status = 'ACTIVE' and domain <> v_host;
    end if;
  end if;
  if v_id is null then
    select nullif(value ->> 'default_merchant_id', '')::uuid into v_id from public.platform_settings where key = 'storefront';
  end if;
  select * into v_m from public.merchants where id = v_id and status <> 'CLOSED';
  if v_m.id is null then
    return null;
  end if;
  return jsonb_build_object('merchant_id', v_m.id, 'name', v_m.name, 'status', v_m.status, 'redirect_to', v_primary);
end;
$$;

select public._tenancy_own_functions();
