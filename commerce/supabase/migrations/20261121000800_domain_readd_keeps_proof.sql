-- Removing a proven domain and adding it back took the store offline until a TXT record was
-- added (a domain proven before the TXT rule had none). Now a removed row keeps its proof and
-- notes when it was removed: added back by the same store within 7 days, it is still proven.
-- Another store's claim still deletes the removed row first (proof and all), so the proof never
-- passes to anyone else.

alter table public.store_domains add column if not exists removed_at timestamptz;
update public.store_domains set removed_at = updated_at where status = 'REMOVED' and removed_at is null;

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
    -- Removed earlier by this store: bring it back with the same code. Proven before and removed
    -- less than 7 days ago, it is still proven (no outage for a remove and re-add); otherwise it
    -- proves ownership again.
    update public.store_domains
       set status = 'PENDING', is_primary = false,
           verified_at = case when removed_at > now() - interval '7 days' then verified_at end,
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

-- Domains already re-added after the proof was cleared (live in the last 7 days, same row, so the
-- same store): proven again, as the rule above would have kept them.
update public.store_domains s set verified_at = now()
 where s.status <> 'REMOVED' and s.verified_at is null
   and exists (select 1 from public.audit_logs l
               where l.entity_type = 'store_domain' and l.entity_id = s.id::text
                 and l.action = 'store_domain.active' and l.merchant_id = s.merchant_id
                 and l.created_at > now() - interval '7 days');

select public._tenancy_own_functions();
