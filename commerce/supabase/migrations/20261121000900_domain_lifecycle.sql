-- Round 3 (lifecycle): nothing a merchant normally does, and no failed background check, takes
-- a proven live domain offline.
--  * Switching between shop.com and www.shop.com (remove one, add the other) keeps the proof:
--    the same store's proven twin carries it, live or removed under 7 days ago.
--  * The cap of 10 unproven names only counts names that would wait for their proof.
--  * A full store reset marks the domains removed (proof cleared), so visitors there see "store
--    not available", never another store or the platform's website, and a check still running
--    then cannot bring them back (a removed row is never saved over).
--  * The ad beacon and the admin's "Your domain" follow the proof, not the last check's status.
--  * status_changed_at: the re-check runs every 10 minutes for 3 days after the status changed.

alter table public.store_domains add column if not exists status_changed_at timestamptz;
update public.store_domains set status_changed_at = coalesce(updated_at, created_at) where status_changed_at is null;
alter table public.store_domains alter column status_changed_at set default now();

create or replace function public.store_domain_save(p_domain text, p jsonb, p_actor uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_d text := lower(trim(coalesce(p_domain, '')));
  v_status text := coalesce(p ->> 'status', 'PENDING');
  v_verified boolean := coalesce(p ->> 'verified', '') = 'true';
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
  insert into public.store_domains(domain, status, records, detail, diagnostics, created_by, checked_at, is_primary, verify_code, verified_at, removed_at)
  values (v_d, v_status, coalesce(p -> 'records', '[]'::jsonb), p ->> 'detail', p -> 'diagnostics', p_actor, now(),
          v_status <> 'REMOVED'
            and not exists (select 1 from public.store_domains x where x.is_primary and x.status <> 'REMOVED'),
          replace(gen_random_uuid()::text, '-', ''),
          case when v_verified and v_status <> 'REMOVED' then now() end,
          case when v_status = 'REMOVED' then now() end)
  on conflict (domain) do update set
    status = coalesce(p ->> 'status', store_domains.status), records = coalesce(p -> 'records', store_domains.records),
    detail = case when p ? 'detail' then p ->> 'detail' else store_domains.detail end,
    diagnostics = case when p ? 'diagnostics' then p -> 'diagnostics' else store_domains.diagnostics end,
    is_primary = case when coalesce(p ->> 'status', store_domains.status) = 'REMOVED' then false
                      else store_domains.is_primary
                        or not exists (select 1 from public.store_domains x where x.is_primary and x.status <> 'REMOVED' and x.id <> store_domains.id) end,
    verify_code = coalesce(store_domains.verify_code, replace(gen_random_uuid()::text, '-', '')),
    -- Removing keeps the proof (no new proof while removing) and notes when: added back by this
    -- store within 7 days, it is still proven. Another store's claim deletes the row, proof and all.
    verified_at = case when coalesce(p ->> 'status', store_domains.status) = 'REMOVED' then store_domains.verified_at
                       when v_verified then coalesce(store_domains.verified_at, now())
                       else store_domains.verified_at end,
    removed_at = case when coalesce(p ->> 'status', store_domains.status) <> 'REMOVED' then null
                      when store_domains.status = 'REMOVED' then coalesce(store_domains.removed_at, now())
                      else now() end,
    status_changed_at = case when coalesce(p ->> 'status', store_domains.status) = store_domains.status then store_domains.status_changed_at else now() end,
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

create or replace function public.store_domain_guard(p_domain text, p_action text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mid uuid := public.current_merchant_id();
  v_d text := lower(trim(coalesce(p_domain, '')));
  v_twin text := public._store_domain_twin(lower(trim(coalesce(p_domain, ''))));
  v_mine boolean;
  v_back boolean;
  v_twin_proven boolean;
begin
  if not public.is_system_context() then
    perform public.require_permission('settings.manage');
  end if;
  if v_mid is null then
    raise exception 'No merchant in context' using errcode = '42501';
  end if;
  if p_action = 'add' then
    if public._store_domain_reserved(v_d) then
      raise exception 'DOMAIN_REJECTED: That is the platform''s own domain; use your store address or a domain you own' using errcode = 'P0001';
    end if;
    -- One store at a time per name pair: two stores adding shop.com and www.shop.com at once
    -- would otherwise both pass the twin check.
    perform pg_advisory_xact_lock(hashtext('store_domain:' || regexp_replace(v_d, '^www\.', '')));
    -- Removed by another store, or claimed and never proven for a week: it serves nobody, so
    -- this store may connect it (the name and its twin).
    perform public._store_domain_release(v_d, v_mid);
    -- Already this store's; or removed by it under 7 days ago while proven (it comes back proven);
    -- or its www twin / root is this store's and proven (live, or removed under 7 days ago): the
    -- same domain, so switching between shop.com and www.shop.com never asks for proof again.
    v_mine := exists (select 1 from public.store_domains where domain = v_d and merchant_id = v_mid and status <> 'REMOVED');
    v_back := exists (select 1 from public.store_domains where domain = v_d and merchant_id = v_mid and status = 'REMOVED'
                        and verified_at is not null and removed_at > now() - interval '7 days');
    v_twin_proven := exists (select 1 from public.store_domains where domain = v_twin and merchant_id = v_mid and verified_at is not null
                               and (status <> 'REMOVED' or removed_at > now() - interval '7 days'));
    if not v_mine then
      perform public.require_feature('custom_domains');
    end if;
    -- www.example.com and example.com serve the same store, so both belong to one store.
    if public._store_domain_taken(public._store_domain_twin(v_d), v_mid) then
      raise exception 'DUPLICATE: That domain is already connected to another store' using errcode = 'P0001';
    end if;
    -- The cap is for names that would wait for their proof, not for ones that come back proven.
    if not (v_mine or v_back or v_twin_proven) and (select count(*) from public.store_domains
        where merchant_id = v_mid and status <> 'REMOVED' and verified_at is null and domain <> v_d) >= 10 then
      raise exception 'LIMIT_REACHED: Prove the domains you added (their TXT record) or remove some before adding more' using errcode = 'P0001';
    end if;
    insert into public.store_domains(domain, status, verify_code, verified_at)
    values (v_d, 'PENDING', replace(gen_random_uuid()::text, '-', ''), case when v_twin_proven then now() end)
    on conflict (domain) do nothing;
    -- Removed earlier by this store: bring it back with the same code. Proven before and removed
    -- less than 7 days ago, it is still proven (no outage for a remove and re-add); otherwise it
    -- proves ownership again.
    update public.store_domains
       set status = 'PENDING', is_primary = false, status_changed_at = now(),
           verified_at = coalesce(case when removed_at > now() - interval '7 days' then verified_at end,
                                  case when v_twin_proven then now() end),
           removed_at = null,
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

create or replace function public.ad_track_scope(p_ids uuid[] default '{}')
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_mid uuid := public.current_merchant_id();
  v_root text := public._store_root_domain();
  v_slug text;
begin
  perform public._require_system();
  select slug into v_slug from public.merchants where id = v_mid;
  return jsonb_build_object(
    'hosts', coalesce((select jsonb_agg(distinct h) from (
        -- Its proven domains and their www twins (one bad re-check does not stop the events).
        select d.domain as h from public.store_domains d where d.merchant_id = v_mid and d.status <> 'REMOVED' and d.verified_at is not null
        union all
        select public._store_domain_twin(d.domain) from public.store_domains d where d.merchant_id = v_mid and d.status <> 'REMOVED' and d.verified_at is not null
        union all
        select v_slug || '.' || v_root where v_slug is not null and v_root is not null
      ) x where h is not null), '[]'::jsonb),
    'prices', coalesce((select jsonb_object_agg(p.id::text, (select max(coalesce(v.price, p.price)) from public.product_variants v where v.product_id = p.id and v.is_active))
      from public.products p
      where p.id = any (coalesce(p_ids, '{}')) and p.status = 'ACTIVE'
        and exists (select 1 from public.product_variants v where v.product_id = p.id and v.is_active)), '{}'::jsonb));
end;
$$;
revoke all on function public.ad_track_scope(uuid[]) from public, anon, authenticated;
grant execute on function public.ad_track_scope(uuid[]) to service_role;

create or replace function public.merchant_store_address()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := public.current_merchant_id();
  v_m public.merchants;
  v_front jsonb;
  v_mode text;
  v_root text := public._store_root_domain();
begin
  if not public.is_staff() then
    raise exception 'PERMISSION_DENIED: staff only' using errcode = '42501';
  end if;
  select * into v_m from public.merchants where id = v_id;
  select value into v_front from public.settings where merchant_id = v_id and key = 'storefront';
  v_mode := coalesce(v_front ->> 'mode', 'OWN');
  return jsonb_build_object(
    'mode', v_mode,
    'slug', v_m.slug,
    'root_domain', v_root,
    'subdomain', case when v_mode = 'OWN' and v_m.slug is not null and v_root is not null then v_m.slug || '.' || v_root end,
    'custom_domain', (select domain from public.store_domains where merchant_id = v_id and is_primary and status <> 'REMOVED' and verified_at is not null limit 1),
    -- Answered on the dashboard, or already selling somewhere (any mode but off).
    'asked', v_mode <> 'OFF' or coalesce((v_front ->> 'store_prompt_done')::boolean, false));
end;
$$;

-- The full store reset: its domains are removed (not deleted), with the proof cleared.
do $do$
declare
  v_def text;
  v_old text := 'delete from public.store_domains where merchant_id = p_merchant;';
begin
  select pg_get_functiondef(p.oid) into v_def from pg_proc p
  where p.proname = 'platform_store_reset' and p.pronamespace = 'public'::regnamespace;
  if v_def is not null and position('Removed by a full store reset' in v_def) > 0 then
    return;  -- already done
  end if;
  if v_def is null or position(v_old in v_def) = 0 then
    raise exception 'platform_store_reset: the domain step was not found';
  end if;
  v_def := replace(v_def, v_old, $r$update public.store_domains
       set status = 'REMOVED', is_primary = false, verified_at = null, removed_at = now(), status_changed_at = now(),
           records = '[]'::jsonb, detail = 'Removed by a full store reset'
     where merchant_id = p_merchant and status <> 'REMOVED';$r$);
  execute v_def;
end;
$do$;

select public._tenancy_own_functions();
