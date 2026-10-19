-- A domain removed and added again came back as "redirects to the primary domain" even when
-- the store had no other domain: adding it back (store_domain_guard) already moved it off
-- REMOVED, so the save never saw a returning domain. Now any save makes the domain primary
-- while the store has no other primary, the same as the first time it was added.

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
    is_primary = case when coalesce(p ->> 'status', store_domains.status) = 'REMOVED' then false
                      else store_domains.is_primary
                        or not exists (select 1 from public.store_domains x where x.is_primary and x.status <> 'REMOVED' and x.id <> store_domains.id) end,
    checked_at = now()
  returning * into v_row;
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

select public._tenancy_own_functions();
