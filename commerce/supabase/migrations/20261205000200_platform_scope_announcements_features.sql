-- =============================================================================
-- Platform employees limited to some stores (Super Admin → staff → "assigned stores only") stay
-- within them in announcements and the bulk feature switch.
--
-- Found by the round-4 audit (idor-sweep.test.ts):
--   * the announcement preview listed every store the audience matched, with name and number,
--     to an employee limited to other stores, and such an employee could send an announcement to
--     every store ("all", by plan or by status);
--   * the bulk feature preview showed the name, number and current state of a store the employee
--     may not change (it was already skipped when applied).
-- Now the preview counts and lists only the employee's own stores; an employee limited to some
-- stores sends only to a list of their own stores (an audience by plan, status or "all" can grow
-- past them before a scheduled announcement goes out); and the bulk preview names only the stores
-- the employee may change. Employees who see every store are not affected.
--
-- Patched in place (CREATE OR REPLACE keeps owner and grants), every line written as a one-line E''
-- string so the script still matches when it is pasted into the SQL Editor by hand. Safe to re-run.
-- =============================================================================

do $$
declare
  v_old text := replace(pg_get_functiondef('public.platform_announcement_preview(jsonb,text)'::regprocedure), E'\r', '');
  v_from text := E'with a as (select id from public._platform_announcement_audience(p_audience) id),';
begin
  if position('_platform_merchant_ids' in v_old) > 0 then
    return; -- already patched
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'platform scope: platform_announcement_preview has changed';
  end if;
  execute replace(v_old, v_from,
    E'with a as (select id from public._platform_announcement_audience(p_audience) id where id in (select public._platform_merchant_ids())),');
end $$;

do $$
declare
  v_old text := replace(pg_get_functiondef('public.platform_announcement_send(uuid,integer,text)'::regprocedure), E'\r', '');
  v_from text := E'  select count(*) into v_count from public._platform_announcement_audience(a.audience);\n';
begin
  if position('assigned to you' in v_old) > 0 then
    return; -- already patched
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'platform scope: platform_announcement_send has changed';
  end if;
  execute replace(v_old, v_from, v_from
    || E'  -- An employee limited to some stores sends only to a list of their own stores (an audience by plan,\n'
    || E'  -- status or "all" can grow past them before a scheduled announcement goes out).\n'
    || E'  if exists (select 1 from public.platform_staff s join public.platform_roles r on r.id = s.role_id\n'
    || E'             where s.user_id = auth.uid() and not r.is_super and s.merchant_scope = ''ASSIGNED'')\n'
    || E'     and (coalesce(a.audience ->> ''type'', ''ALL'') <> ''MERCHANTS''\n'
    || E'          or exists (select 1 from public._platform_announcement_audience(a.audience) x(id)\n'
    || E'                     where x.id not in (select public._platform_merchant_ids()))) then\n'
    || E'    raise exception ''PERMISSION_DENIED: you can send announcements only to the stores assigned to you, chosen one by one'' using errcode = ''42501'';\n'
    || E'  end if;\n');
end $$;

do $$
declare
  v_old text := replace(pg_get_functiondef('public.platform_feature_bulk_preview(uuid[],text,boolean)'::regprocedure), E'\r', '');
  v_from text := E'jsonb_agg(jsonb_build_object(''id'', m.id, ''number'', m.number, ''name'', m.name,\n'
    || E'        ''now'', public.merchant_entitlements(m.id) -> p_code ->> ''state'', ''allowed'', public.platform_can(''features'', ''edit'', m.id)) order by m.number)';
begin
  if position('''allowed'', false' in v_old) > 0 then
    return; -- already patched
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'platform scope: platform_feature_bulk_preview has changed';
  end if;
  execute replace(v_old, v_from,
    E'jsonb_agg(case when public.platform_can(''features'', ''edit'', m.id)\n'
    || E'        then jsonb_build_object(''id'', m.id, ''number'', m.number, ''name'', m.name, ''now'', public.merchant_entitlements(m.id) -> p_code ->> ''state'', ''allowed'', true)\n'
    || E'        else jsonb_build_object(''id'', m.id, ''allowed'', false) end order by m.number)');
end $$;

select public._tenancy_own_functions();
