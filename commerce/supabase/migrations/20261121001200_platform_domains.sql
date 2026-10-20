-- Super Admin → Domains: every store's custom domains in one place.
--
-- Lists the domains of the merchants the employee may see (merchants.view), with the store,
-- the status, the last check and its issues. Checking again and removing go through the
-- domains function (it talks to the hosting), which asks platform_can('merchants', 'manage')
-- for that merchant and records the action in the audit log.

-- Where a domain stands, in the buckets the page filters by.
create or replace function public._platform_domain_bucket(p_status text, p_diagnostics jsonb)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_status = 'REMOVED' then 'REMOVED'
    when p_status = 'MANUAL' then 'MANUAL'
    when p_status = 'ERROR'
      or exists (select 1 from jsonb_array_elements(coalesce(p_diagnostics -> 'issues', '[]'::jsonb)) i
                 where i ->> 'severity' = 'error' and i ->> 'code' <> 'CHECK_FAILED') then 'ISSUES'
    when p_status = 'ACTIVE' then 'LIVE'
    else 'WAITING'
  end
$$;

create or replace function public.platform_store_domains_list(p_search text default null, p_bucket text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_q text := nullif(lower(trim(coalesce(p_search, ''))), '');
  v_bucket text := nullif(upper(trim(coalesce(p_bucket, ''))), '');
begin
  perform public._platform_require('merchants', 'view');
  if v_bucket is not null and v_bucket not in ('LIVE', 'WAITING', 'ISSUES', 'MANUAL', 'REMOVED') then
    raise exception 'VALIDATION: unknown filter' using errcode = '22023';
  end if;
  return (
    with scoped as (
      select d.*, m.name as merchant_name, m.number as merchant_number, m.status as merchant_status, m.slug as merchant_slug,
        public._platform_domain_bucket(d.status, d.diagnostics) as bucket
      from public.store_domains d
      join public.merchants m on m.id = d.merchant_id
      where d.merchant_id in (select public._platform_merchant_ids())
    ),
    found as (
      select * from scoped
      where (v_q is null or position(v_q in domain) > 0 or position(v_q in lower(merchant_name)) > 0 or merchant_number::text = v_q)
    ),
    shown as (
      select * from found
      where (v_bucket is null and bucket <> 'REMOVED') or bucket = v_bucket
      order by case bucket when 'ISSUES' then 0 when 'WAITING' then 1 when 'MANUAL' then 2 when 'LIVE' then 3 else 4 end,
        coalesce(status_changed_at, created_at) desc
      limit 300
    )
    select jsonb_build_object(
      'domains', coalesce((select jsonb_agg(
          (to_jsonb(s) - 'verify_code' - 'merchant_name' - 'merchant_number' - 'merchant_status' - 'merchant_slug' - 'created_by')
          || jsonb_build_object('merchant', jsonb_build_object('id', s.merchant_id, 'name', s.merchant_name, 'number', s.merchant_number,
               'status', s.merchant_status, 'slug', s.merchant_slug),
             'issues', coalesce((select count(*) from jsonb_array_elements(coalesce(s.diagnostics -> 'issues', '[]'::jsonb)) i
                                 where i ->> 'severity' in ('error', 'warning')), 0),
             'can_manage', public.platform_can('merchants', 'manage', s.merchant_id))
          order by case s.bucket when 'ISSUES' then 0 when 'WAITING' then 1 when 'MANUAL' then 2 when 'LIVE' then 3 else 4 end,
            coalesce(s.status_changed_at, s.created_at) desc) from shown s), '[]'::jsonb),
      'counts', jsonb_build_object(
        'ALL', (select count(*) from found where bucket <> 'REMOVED'),
        'LIVE', (select count(*) from found where bucket = 'LIVE'),
        'WAITING', (select count(*) from found where bucket = 'WAITING'),
        'ISSUES', (select count(*) from found where bucket = 'ISSUES'),
        'MANUAL', (select count(*) from found where bucket = 'MANUAL'),
        'REMOVED', (select count(*) from found where bucket = 'REMOVED')),
      'stores', (select count(distinct merchant_id) from scoped where bucket <> 'REMOVED'),
      'can_manage', public.platform_can('merchants', 'manage')));
end;
$$;

revoke execute on function public._platform_domain_bucket(text, jsonb) from public, anon, authenticated;
revoke execute on function public.platform_store_domains_list(text, text) from public, anon;
grant execute on function public.platform_store_domains_list(text, text) to authenticated;

insert into public.tenancy_exempt_functions (name, reason)
values ('platform_store_domains_list', 'Super Admin → Domains: custom domains of the merchants the employee may see, permission-checked')
on conflict (name) do nothing;

select public._tenancy_own_functions();
