-- =============================================================================
-- Super Admin: delete one person of a merchant.
--
-- The person's login is blocked for good and removed from the sign-in service
-- (Clerk) by the account-removals job; their e-mail address is freed. Their
-- staff profile stays, switched off and marked deleted, so the orders, notes
-- and logs they wrote still show who did it. A deleted person cannot be
-- switched on again; the business adds them again as a new member instead.
-- =============================================================================

alter table public.profiles add column if not exists deleted_at timestamptz;

-- A deleted person stays deleted and switched off.
create or replace function public._profiles_deleted_stay_off()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.deleted_at := old.deleted_at;
  if new.is_active then
    raise exception 'VALIDATION: this person was deleted; add them again as a new member instead' using errcode = '22023';
  end if;
  return new;
end;
$$;
create or replace trigger profiles_deleted_stay_off before update on public.profiles
  for each row when (old.deleted_at is not null) execute function public._profiles_deleted_stay_off();

create or replace function public.platform_merchant_user_delete(p_merchant uuid, p_user uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  p public.profiles;
  v_role text;
begin
  perform public._platform_require('merchants', 'manage', p_merchant);
  if coalesce(length(trim(p_reason)), 0) < 5 then
    raise exception 'VALIDATION: explain why (at least 5 characters)' using errcode = '22023';
  end if;
  perform public._platform_in_merchant(p_merchant);
  select * into p from public.profiles where id = p_user and merchant_id = p_merchant for update;
  if not found then
    raise exception 'NOT_FOUND: this person is not in this merchant' using errcode = 'P0002';
  end if;
  if p.deleted_at is not null then
    raise exception 'VALIDATION: this person was already deleted' using errcode = '22023';
  end if;
  if p_user = auth.uid() then
    raise exception 'VALIDATION: you cannot delete your own login' using errcode = '22023';
  end if;
  if exists (select 1 from public.platform_staff s where s.user_id = p_user) then
    raise exception 'VALIDATION: this person is on the platform team; switch them off under Employees instead' using errcode = '22023';
  end if;
  select r.code into v_role from public.roles r where r.id = p.role_id;
  if v_role = 'OWNER' and p.is_active and not exists (
    select 1 from public.profiles o join public.roles r on r.id = o.role_id
    where o.merchant_id = p_merchant and o.id <> p_user and o.is_active and o.deleted_at is null and r.code = 'OWNER') then
    raise exception 'VALIDATION: this is the merchant''s only owner; make someone else owner first, or delete the merchant' using errcode = '22023';
  end if;

  update public.profiles set is_active = false, deleted_at = now() where id = p_user;
  insert into public.account_removals (user_id, from_merchant, reason) values (p_user, p_merchant, 'Deleted by Super Admin');
  perform public._platform_log('merchants.user_deleted', p_merchant, 'profile', p_user::text, trim(p_reason),
    jsonb_build_object('email', p.email, 'full_name', p.full_name, 'role', v_role, 'is_active', p.is_active), null);
  return jsonb_build_object('deleted', true, 'user_id', p_user);
end;
$$;
revoke execute on function public.platform_merchant_user_delete(uuid, uuid, text) from public, anon;
grant execute on function public.platform_merchant_user_delete(uuid, uuid, text) to authenticated;

-- The merchant's staff list in Super Admin says who was deleted.
do $$
declare
  v_def text := pg_get_functiondef('public.platform_merchant_get(uuid)'::regprocedure);
  v_new text;
begin
  if position('''deleted_at'', p.deleted_at' in v_def) = 0 then
    v_new := replace(v_def, '''last_seen_at'', p.last_seen_at)', '''last_seen_at'', p.last_seen_at, ''deleted_at'', p.deleted_at)');
    if v_new = v_def then
      raise exception 'platform_merchant_get: staff list not found';
    end if;
    execute v_new;
  end if;
end;
$$;

-- Reads platform staff and writes the removal queue; permission-checked.
insert into public.tenancy_exempt_functions (name, reason)
values ('platform_merchant_user_delete', 'Super Admin deletes one person of one merchant: permission-checked, logged')
on conflict (name) do nothing;

select public._tenancy_own_functions();
