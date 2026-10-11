-- =============================================================================
-- Super Admin clean-up.
--
-- 1. Deleted merchants ("Deleted merchant #N") no longer show in the merchant
--    list, its counts or the overview. Their money records stay, and their
--    page still opens from the audit log or the billing screens.
-- 2. A switched-off employee can be removed for good: gone from the Employees
--    list, cannot be switched on again, and a login that belongs to nobody
--    else (no business) is blocked and removed from the sign-in service.
--    The record stays (marked removed) so audit logs keep their name.
-- =============================================================================

-- 1. Hide deleted merchants -----------------------------------------------------
do $$
declare
  f text;
  v_def text;
  v_new text;
begin
  foreach f in array array['public.platform_merchants_list(jsonb,text,text,integer,integer)', 'public.platform_overview(date,date)'] loop
    v_def := pg_get_functiondef(f::regprocedure);
    if position('deleted_at is null' in v_def) = 0 then
      v_new := replace(v_def, 'm.id in (select public._platform_merchant_ids())', 'm.id in (select public._platform_merchant_ids()) and m.deleted_at is null');
      v_new := replace(v_new, 'where id in (select public._platform_merchant_ids())', 'where id in (select public._platform_merchant_ids()) and deleted_at is null');
      if v_new = v_def then
        raise exception '%: merchant scope not found', f;
      end if;
      execute v_new;
    end if;
  end loop;
end;
$$;

-- 2. Remove an employee for good -----------------------------------------------
alter table public.platform_staff add column if not exists removed_at timestamptz;

create or replace function public.platform_staff_remove(p_user uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_staff public.platform_staff;
  v_is_super boolean;
  v_login boolean;
begin
  perform public._platform_require('employees', 'manage');
  if p_user = auth.uid() then
    raise exception 'VALIDATION: you cannot remove yourself' using errcode = '22023';
  end if;
  if coalesce(length(trim(p_reason)), 0) < 5 then
    raise exception 'VALIDATION: explain why (at least 5 characters)' using errcode = '22023';
  end if;
  select * into v_staff from public.platform_staff where user_id = p_user for update;
  if v_staff.user_id is null or v_staff.removed_at is not null then
    raise exception 'NOT_FOUND: employee not found' using errcode = 'P0002';
  end if;
  if v_staff.is_active then
    raise exception 'VALIDATION: switch this employee off first, then remove them' using errcode = '22023';
  end if;
  select is_super into v_is_super from public.platform_roles where id = v_staff.role_id;
  if v_is_super and not public._platform_is_super() then
    raise exception 'PERMISSION_DENIED: only a Super Admin can remove another Super Admin' using errcode = '42501';
  end if;

  update public.platform_staff set removed_at = now() where user_id = p_user;
  update public.support_sessions set ended_at = now(), ended_by = auth.uid(), end_reason = 'Employee removed'
  where staff_user_id = p_user and ended_at is null;
  -- A login used only for the platform goes too; one that also runs a business stays.
  v_login := not exists (select 1 from public.profiles p where p.id = p_user and p.deleted_at is null);
  if v_login then
    insert into public.account_removals (user_id, from_merchant, reason) values (p_user, null, 'Employee removed');
  end if;
  perform public._platform_log('employees.removed', null, 'platform_staff', p_user::text, trim(p_reason),
    jsonb_build_object('email', v_staff.email, 'full_name', v_staff.full_name, 'is_super', v_is_super), jsonb_build_object('login_removed', v_login));
  return jsonb_build_object('removed', true, 'login_removed', v_login);
end;
$$;
revoke execute on function public.platform_staff_remove(uuid, text) from public, anon;
grant execute on function public.platform_staff_remove(uuid, text) to authenticated;

insert into public.tenancy_exempt_functions (name, reason)
values ('platform_staff_remove', 'Super Admin removes one switched-off employee: permission-checked, logged')
on conflict (name) do nothing;

-- Removed employees leave the Employees list and role counts, and cannot be switched on again.
do $$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.platform_staff_list()'::regprocedure);
  if position('removed_at is null' in v_def) = 0 then
    v_new := replace(v_def, 'from public.platform_staff s join public.platform_roles r on r.id = s.role_id)',
                            'from public.platform_staff s join public.platform_roles r on r.id = s.role_id where s.removed_at is null)');
    if v_new = v_def then raise exception 'platform_staff_list: staff query not found'; end if;
    execute v_new;
  end if;

  v_def := pg_get_functiondef('public.platform_roles_list()'::regprocedure);
  if position('removed_at is null' in v_def) = 0 then
    v_new := replace(v_def, '(select count(*) from public.platform_staff s where s.role_id = r.id)',
                            '(select count(*) from public.platform_staff s where s.role_id = r.id and s.removed_at is null)');
    if v_new = v_def then raise exception 'platform_roles_list: staff count not found'; end if;
    execute v_new;
  end if;

  v_def := pg_get_functiondef('public.platform_staff_set_active(uuid,boolean,text)'::regprocedure);
  if position('removed_at' in v_def) = 0 then
    v_new := replace(v_def, '  select is_super into v_is_super from public.platform_roles where id = v_staff.role_id;',
      '  if v_staff.removed_at is not null then
    raise exception ''NOT_FOUND: employee not found'' using errcode = ''P0002'';
  end if;
  select is_super into v_is_super from public.platform_roles where id = v_staff.role_id;');
    if v_new = v_def then raise exception 'platform_staff_set_active: role lookup not found'; end if;
    execute v_new;
  end if;

  -- Adding a removed person again brings them back as a new, active employee.
  v_def := pg_get_functiondef('public.platform_staff_save(jsonb)'::regprocedure);
  if position('removed_at' in v_def) = 0 then
    v_new := replace(v_def, '    merchant_scope = coalesce(p ->> ''merchant_scope'', public.platform_staff.merchant_scope);',
      '    merchant_scope = coalesce(p ->> ''merchant_scope'', public.platform_staff.merchant_scope),
    is_active = public.platform_staff.is_active or public.platform_staff.removed_at is not null,
    removed_at = null;');
    if v_new = v_def then raise exception 'platform_staff_save: upsert not found'; end if;
    execute v_new;
  end if;
end;
$$;

select public._tenancy_own_functions();
