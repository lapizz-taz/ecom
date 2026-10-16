-- Deleting a staff member. Their name stays on the orders, notes and audit entries they
-- made (the profile row is kept for that), but they leave the staff list for good and
-- cannot sign in. Only a deactivated member can be deleted, never yourself, and the same
-- rank rules as changing a role apply. Adding the same e-mail again brings them back.

alter table public.profiles add column if not exists removed_at timestamptz;

create or replace function public.admin_staff_remove(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
  v_my_role text := public.current_role_code();
  v_target record;
begin
  perform public.require_permission('users.manage');
  if p_user_id = v_me then
    raise exception 'PERMISSION_DENIED: you cannot delete yourself' using errcode = '42501';
  end if;
  select p.id, p.email, p.is_active, p.removed_at, r.code as role, r.rank
    into v_target
    from public.profiles p join public.roles r on r.id = p.role_id
   where p.id = p_user_id and p.merchant_id = public.current_merchant_id()
   for update of p;
  if not found or v_target.removed_at is not null then
    raise exception 'NOT_FOUND: staff member not found' using errcode = 'P0001';
  end if;
  if v_target.is_active then
    raise exception 'VALIDATION: deactivate this person first, then delete' using errcode = 'P0001';
  end if;
  if v_target.role = 'OWNER' and v_my_role <> 'OWNER' then
    raise exception 'PERMISSION_DENIED: only an owner can delete another owner' using errcode = '42501';
  end if;
  if v_my_role <> 'OWNER' and v_target.rank > coalesce((select rank from public.roles where code = v_my_role), 0) then
    raise exception 'PERMISSION_DENIED: you cannot delete someone with a higher role than yours' using errcode = '42501';
  end if;

  update public.profiles set removed_at = now() where id = p_user_id;
  insert into public.audit_logs(actor_id, actor_email, action, entity_type, entity_id, metadata)
  values (v_me, (select email from public.profiles where id = v_me), 'staff.deleted', 'profiles', p_user_id::text,
          jsonb_build_object('email', v_target.email, 'role', v_target.role));
end;
$$;

revoke all on function public.admin_staff_remove(uuid) from public, anon;
grant execute on function public.admin_staff_remove(uuid) to authenticated, service_role;

-- Given a role again (the same e-mail added back): they are on the list again.
create or replace function public._profile_unremove()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.is_active and old.removed_at is not null then
    new.removed_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_unremove on public.profiles;
create trigger profiles_unremove before update of is_active on public.profiles
  for each row execute function public._profile_unremove();
