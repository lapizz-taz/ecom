-- =============================================================================
-- Look-only businesses: the shared demo account.
--
-- demo@gmail.com is handed to anyone who wants to see Fullfilio. Its business (Demo) becomes
-- look-only: every page opens, nothing changes.
--  * merchants.view_only puts the business in read-only mode: staff keep *.view and *.export, every
--    change is refused by has_permission (and so by every table, database function and backend
--    function), and the admin hides the buttons that change things. The store front keeps working.
--  * The account itself cannot be taken over: its name and phone, password, email and phone sign-in,
--    and two-step sign-in cannot be changed (a password reset sent to that address cannot be used
--    either). The platform team can still change them from the SQL editor after
--      set local app.view_only_unlock = 'on';
--  * is_demo (kept out of the Super Admin figures) is a different flag and is left as it is.
-- To fill the demo with sample data, switch it off for a while:
--   update public.merchants set view_only = false where name = 'Demo';
-- Safe to re-run.
-- =============================================================================

alter table public.merchants add column if not exists view_only boolean not null default false;
comment on column public.merchants.view_only is
  'Look-only business (the shared demo account): read-only access mode, and its accounts'' sign-in details are locked.';

create or replace function public.merchant_access_mode(p_merchant uuid default null)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := case when public.is_system_context() or public.is_platform_staff() then coalesce(p_merchant, public.current_merchant_id()) else public.current_merchant_id() end;
  v_rules jsonb := coalesce((select value from public.platform_settings where key = 'access_rules'), '{}'::jsonb);
  v_status text;
  v_view_only boolean;
  s public.subscriptions;
  v_sub_key text;
  v_a text;
  v_b text;
begin
  if v_id is null then
    return 'BLOCKED';
  end if;
  select status, view_only into v_status, v_view_only from public.merchants where id = v_id;
  if v_status is null or v_status = 'CLOSED' then
    return 'BLOCKED';
  end if;
  if (select onboarding ->> 'activation' from public.merchants where id = v_id) in ('awaiting_payment', 'awaiting_whatsapp') then
    return 'BLOCKED';
  end if;
  v_a := case v_status when 'SUSPENDED' then coalesce(v_rules ->> 'MERCHANT_SUSPENDED', 'BLOCKED')
                       when 'ONBOARDING' then coalesce(v_rules ->> 'MERCHANT_ONBOARDING', 'FULL') else 'FULL' end;
  -- A look-only business (the demo) can be viewed, never changed.
  if v_view_only and v_a <> 'BLOCKED' then
    v_a := 'READ_ONLY';
  end if;
  -- The current subscription; when none, the last one that ended (expired or
  -- cancelled accounts stay restricted). NO_SUBSCRIPTION only if there never was one.
  select * into s from public.subscriptions where merchant_id = v_id
  order by (ended_at is null) desc, ended_at desc nulls last, created_at desc limit 1;
  v_sub_key := case
    when s.id is null then 'NO_SUBSCRIPTION'
    when s.status = 'PAST_DUE' and s.intro_until is not null
         and (s.current_period_end is null or s.current_period_end <= s.intro_until) then 'TRIAL_ENDED'
    when s.status = 'PAST_DUE' and s.grace_until is not null and s.grace_until < now() then 'PAST_DUE_AFTER_GRACE'
    else s.status end;
  v_b := coalesce(v_rules ->> v_sub_key, case when v_sub_key = 'TRIAL_ENDED' then 'BLOCKED' else 'FULL' end);
  -- The stricter of the two wins.
  return case when 'BLOCKED' in (v_a, v_b) then 'BLOCKED' when 'READ_ONLY' in (v_a, v_b) then 'READ_ONLY' else 'FULL' end;
end;
$$;

-- The admin learns it is a look-only business (to say "demo" instead of "renew your plan").
do $$
declare
  v_old text := replace(pg_get_functiondef('public.get_my_access()'::regprocedure), E'\r', '');
  v_from text := E'''access_mode'', public.merchant_access_mode(v_p.merchant_id),';
  v_to text := E'''access_mode'', public.merchant_access_mode(v_p.merchant_id),\n    ''view_only'', coalesce((select m.view_only from public.merchants m where m.id = v_p.merchant_id), false),';
begin
  if position('''view_only''' in v_old) > 0 then
    return; -- already patched
  end if;
  if (length(v_old) - length(replace(v_old, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'view-only: get_my_access has changed';
  end if;
  execute replace(v_old, v_from, v_to);
end $$;

create or replace function public.update_my_profile(p_full_name text, p_phone text default null)
returns public.profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles;
begin
  if exists (select 1 from public.profiles p join public.merchants m on m.id = p.merchant_id where p.id = auth.uid() and m.view_only) then
    raise exception 'PERMISSION_DENIED: This is a demo account: its name and phone cannot be changed.' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_full_name, ''))) = 0 then
    raise exception 'VALIDATION: name is required' using errcode = '22023';
  end if;
  update public.profiles
  set full_name = trim(p_full_name), phone = nullif(trim(coalesce(p_phone, '')), ''), last_seen_at = now()
  where id = auth.uid()
  returning * into v_profile;
  if not found then
    raise exception 'NOT_FOUND: no staff profile for current user' using errcode = 'P0002';
  end if;
  return v_profile;
end;
$$;

-- Sign-in details of a look-only business's accounts stay as they are. Supabase Auth writes them
-- (password change, password reset, email or phone change, a new second factor), so the guard sits
-- on its tables. It reads profiles and merchants without a merchant in context, so it stays owned
-- by postgres and is listed with the exempt functions.
create or replace function public._view_only_account_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := case when tg_table_name = 'mfa_factors' then (to_jsonb(new) ->> 'user_id')::uuid else new.id end;
  v_new jsonb;
  v_old jsonb;
begin
  if coalesce(current_setting('app.view_only_unlock', true), '') = 'on' then
    return new;
  end if;
  if not exists (select 1 from public.profiles p join public.merchants m on m.id = p.merchant_id where p.id = v_user and m.view_only) then
    return new;
  end if;
  if tg_table_name = 'mfa_factors' then
    raise exception 'This is a demo account: two-step sign-in cannot be added.' using errcode = '42501';
  end if;
  v_new := to_jsonb(new);
  v_old := to_jsonb(old);
  if (v_new ->> 'encrypted_password') is distinct from (v_old ->> 'encrypted_password')
     or (v_new ->> 'email') is distinct from (v_old ->> 'email')
     or coalesce(v_new ->> 'email_change', '') <> coalesce(v_old ->> 'email_change', '')
     or (v_new ->> 'phone') is distinct from (v_old ->> 'phone')
     or coalesce(v_new ->> 'phone_change', '') <> coalesce(v_old ->> 'phone_change', '') then
    raise exception 'This is a demo account: its sign-in details cannot be changed.' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public._view_only_account_guard() from public, anon, authenticated;
insert into public.tenancy_exempt_functions (name, reason)
values ('_view_only_account_guard', 'Look-only demo: keeps the sign-in details of its accounts as they are (Supabase Auth writes them)')
on conflict (name) do nothing;

drop trigger if exists view_only_account_guard on auth.users;
create trigger view_only_account_guard before update on auth.users
  for each row execute function public._view_only_account_guard();
drop trigger if exists view_only_account_guard on auth.mfa_factors;
create trigger view_only_account_guard before insert on auth.mfa_factors
  for each row execute function public._view_only_account_guard();

-- The shared demo business on fullfilio.com (no-op anywhere else).
update public.merchants set view_only = true where id = '725814d5-4cb6-4574-9016-b7f2403d586e';

select public._tenancy_own_functions();
