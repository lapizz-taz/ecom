-- =============================================================================
-- Delete a merchant from Super Admin, and keep sign-in (Clerk) in step.
--
-- Deleting a merchant takes two people: one asks (typing the merchant's name,
-- with a reason, after downloading a full export), another approves. Approval
-- removes the business and all its data: everything a full store reset removes,
-- then every other table that belongs to the merchant (staff, roles, settings,
-- HR, phone system set-up, ...). Money records stay for the accounts: plan
-- subscriptions and invoices, billing payments, credits and their ledger,
-- order fees, metered usage, the phone system's ledger and bKash payments,
-- and the audit trails. Those keep pointing at the merchant row, which stays
-- as "Deleted merchant #N" (closed, every contact detail removed).
--
-- Logins that belonged only to the deleted business are queued in
-- account_removals; the clerk-auth function (every minute) blocks them here,
-- frees their e-mail address and deletes them from Clerk.
-- =============================================================================

alter table public.merchants add column if not exists deleted_at timestamptz;

-- -----------------------------------------------------------------------------
-- 1. Logins to remove from the sign-in service
-- -----------------------------------------------------------------------------
create table if not exists public.account_removals (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  from_merchant uuid references public.merchants(id),
  reason text not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'DONE', 'FAILED')),
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  done_at timestamptz
);
create index if not exists account_removals_pending on public.account_removals (created_at) where status = 'PENDING';
alter table public.account_removals enable row level security;
revoke all on public.account_removals from anon, authenticated;
grant select, insert, update on public.account_removals to service_role;
-- No policies: only the server (service role) reads it.

create or replace function public._tenancy_global_tables()
returns text[]
language sql
immutable
as $$
  select array['permissions', 'order_status_transitions', 'pbx_packages', 'pbx_gateway_status',
               'merchants', 'platform_staff', 'support_sessions', 'tenancy_exempt_functions',
               'platform_settings', 'platform_audit_logs', 'platform_credentials',
               'platform_modules', 'platform_roles', 'platform_role_permissions', 'platform_staff_merchants',
               'merchant_notes', 'platform_approvals', 'config_versions', 'features', 'plans', 'plan_addons',
               'credit_types', 'credit_packages', 'platform_notifications', 'support_ticket_events', 'platform_cost_entries',
               'platform_incidents', 'platform_incident_merchants', 'platform_incident_updates', 'platform_announcements',
               'platform_announcement_deliveries', 'platform_announcement_reads', 'platform_automation_rules', 'platform_automation_runs',
               'platform_data_exports', 'merchant_deletion_requests', 'platform_restore_tests',
               'platform_contact_messages', 'account_removals']
$$;

-- Service role only: the login linked to a Clerk account (sign-in bridge, Clerk webhook).
create or replace function public.find_auth_user_by_clerk(p_clerk_id text)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select id from auth.users where raw_app_meta_data ->> 'clerk_user_id' = p_clerk_id order by created_at limit 1
$$;
revoke execute on function public.find_auth_user_by_clerk(text) from public, anon, authenticated;
grant execute on function public.find_auth_user_by_clerk(text) to service_role;

-- -----------------------------------------------------------------------------
-- 2. Delete a merchant
-- -----------------------------------------------------------------------------

-- Tables whose rows stay when a merchant is deleted: money records and audit trails.
create or replace function public._merchant_delete_kept_tables()
returns text[]
language sql
immutable
as $$
  select array['billing_invoices', 'billing_payments', 'subscriptions', 'subscription_addons', 'subscription_events',
               'credit_balances', 'credit_ledger', 'credit_lots', 'credit_lot_usage', 'merchant_order_fees', 'order_fee_charges',
               'service_usage', 'pbx_ledger', 'pbx_bkash_transactions', 'pbx_outgoing_balances', 'pbx_subscriptions', 'pbx_businesses',
               'audit_logs', 'store_resets', 'platform_approvals', 'platform_audit_logs', 'platform_data_exports',
               'merchant_deletion_requests', 'account_removals', 'support_sessions', 'support_tickets', 'support_ticket_messages',
               'support_ticket_events', 'platform_notifications', 'platform_incident_merchants', 'platform_automation_runs',
               'platform_announcement_deliveries', 'platform_announcement_reads', 'merchant_notes', 'platform_staff_merchants']
$$;

-- The latest full export of the merchant's data, if made in the last 24 hours.
create or replace function public._platform_merchant_recent_export(p_merchant uuid)
returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select id from public.platform_data_exports
  where merchant_id = p_merchant and kind = 'MERCHANT_DATA' and created_at > now() - interval '24 hours'
  order by created_at desc limit 1
$$;

-- Asks for a merchant to be deleted; someone else approves it (Approvals).
create or replace function public.platform_merchant_delete_request(p_merchant uuid, p_confirm_name text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  m public.merchants;
  v_id uuid;
begin
  perform public._platform_require('merchants', 'manage', p_merchant);
  perform public._platform_in_merchant(p_merchant);
  select * into m from public.merchants where id = p_merchant;
  if not found then
    raise exception 'NOT_FOUND: merchant not found' using errcode = 'P0002';
  end if;
  if m.deleted_at is not null then
    raise exception 'VALIDATION: this merchant was already deleted' using errcode = '22023';
  end if;
  if lower(trim(coalesce(p_confirm_name, ''))) <> lower(trim(m.name)) then
    raise exception 'VALIDATION: type the merchant''s name exactly as shown to confirm' using errcode = '22023';
  end if;
  if coalesce(length(trim(p_reason)), 0) < 10 then
    raise exception 'VALIDATION: explain why (at least 10 characters)' using errcode = '22023';
  end if;
  if public._platform_merchant_recent_export(p_merchant) is null then
    raise exception 'VALIDATION: download a full export of this merchant first (Data Management → Export), then ask within 24 hours'
      using errcode = '22023';
  end if;
  v_id := public.platform_request_approval('merchants', 'merchant_delete', m.id,
    format('Delete merchant #%s %s and all its data', m.number, m.name), jsonb_build_object('merchant_id', m.id, 'name', m.name), trim(p_reason));
  return jsonb_build_object('approval_id', v_id);
end;
$$;

-- Carries out an approved deletion (called from the approvals flow only).
create or replace function public._platform_merchant_delete(a public.platform_approvals)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  m public.merchants;
  v_logins uuid[];
  v_reset jsonb;
  r public.store_resets;
  v_tables text[];
  v_left text[];
  v_kept jsonb := '{}'::jsonb;
  v_counts jsonb := '{}'::jsonb;
  t text;
  n int;
  v_pass int := 0;
  v_progress boolean;
begin
  select * into m from public.merchants where id = a.merchant_id for update;
  if not found then
    raise exception 'NOT_FOUND: merchant not found' using errcode = 'P0002';
  end if;
  if m.deleted_at is not null then
    raise exception 'VALIDATION: this merchant was already deleted' using errcode = '22023';
  end if;
  if public._platform_merchant_recent_export(m.id) is null then
    raise exception 'VALIDATION: download a full export of this merchant (Data Management → Export) within 24 hours before approving'
      using errcode = '22023';
  end if;

  perform public._platform_in_merchant(m.id);
  -- Logins that belong only to this business (platform staff keep theirs).
  select coalesce(array_agg(p.id), '{}') into v_logins from public.profiles p
  where p.merchant_id = m.id and not exists (select 1 from public.platform_staff s where s.user_id = p.id);
  update public.profiles set is_active = false where merchant_id = m.id and is_active;

  -- Everything a full store reset removes (orders, customers, products, connections and their keys, ...).
  v_reset := public.platform_store_reset(m.id, 'EVERYTHING', m.name, 'Merchant deleted: ' || a.reason);

  -- Then every other table of the merchant, except money records and audit trails.
  insert into public.store_resets (merchant_id, scope, reason, export_id, requested_by, requested_by_email, txid)
  values (m.id, 'EVERYTHING', left('Merchant deleted: ' || a.reason, 2000), public._platform_merchant_recent_export(m.id), auth.uid(),
          (select email from public.platform_staff where user_id = auth.uid()), txid_current())
  returning * into r;
  perform set_config('app.store_reset', r.id::text, true);
  perform public._platform_in_merchant(m.id);
  set local lock_timeout = '20s';

  select coalesce(array_agg(c.relname::text order by c.relname), '{}') into v_tables
  from pg_class c
  where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
    and exists (select 1 from pg_attribute at where at.attrelid = c.oid and at.attname = 'merchant_id' and not at.attisdropped)
    and c.relname <> all (public._merchant_delete_kept_tables());

  -- Tables point at each other; delete in passes until nothing more can go.
  loop
    v_pass := v_pass + 1;
    v_progress := false;
    v_left := '{}';
    foreach t in array v_tables loop
      begin
        execute format('delete from public.%I where merchant_id = $1', t) using m.id;
        get diagnostics n = row_count;
        if n > 0 then
          v_counts := v_counts || jsonb_build_object(t, coalesce((v_counts ->> t)::int, 0) + n);
          v_progress := true;
        end if;
      exception
        when foreign_key_violation then
          v_left := v_left || t;
        when others then
          -- A record the database refuses to delete (e.g. immutable history) stays.
          v_kept := v_kept || jsonb_build_object(t, sqlerrm);
      end;
    end loop;
    v_tables := v_left;
    exit when cardinality(v_tables) = 0 or not v_progress or v_pass >= 12;
  end loop;
  foreach t in array v_tables loop
    v_kept := v_kept || jsonb_build_object(t, 'still referenced by a record that stays');
  end loop;

  update public.store_resets set status = 'DONE', counts = v_counts, finished_at = now() where id = r.id;
  perform set_config('app.store_reset', '', true);

  -- What stays carries no contact details.
  update public.billing_payments set raw = '{}'::jsonb, note = null where merchant_id = m.id;
  update public.pbx_bkash_transactions set raw = '{}'::jsonb where merchant_id = m.id;
  update public.pbx_businesses set name = format('Deleted merchant #%s', m.number) where merchant_id = m.id;
  update public.merchants set name = format('Deleted merchant #%s', m.number), slug = null, phone = null, address = null,
    website = null, notes = null, owner_email = null, business_type = null, onboarding = '{}'::jsonb, account_manager_id = null,
    status = 'CLOSED', status_reason = left('Deleted: ' || a.reason, 500), status_changed_at = now(), status_changed_by = auth.uid(),
    deleted_at = now()
  where id = m.id;
  update public.support_sessions set ended_at = now(), end_reason = 'Merchant deleted' where merchant_id = m.id and ended_at is null;

  insert into public.account_removals (user_id, from_merchant, reason)
  select u, m.id, 'Merchant deleted' from unnest(v_logins) u;

  perform public._platform_log('merchants.deleted', m.id, 'merchant', m.id::text, a.reason,
    jsonb_build_object('name', m.name, 'number', m.number),
    jsonb_build_object('reset', v_reset -> 'counts', 'deleted', v_counts, 'kept', v_kept, 'logins', cardinality(v_logins), 'approval', a.id));
  return jsonb_build_object('merchant_id', m.id, 'deleted', v_counts, 'kept', v_kept, 'logins_removed', cardinality(v_logins));
end;
$$;

-- Finance categories are never deleted, except with the whole business (while
-- its deletion runs in this very transaction).
create or replace function public.finance_categories_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if public._store_reset_active(old.merchant_id::text) then
      return old;
    end if;
    raise exception 'VALIDATION: finance categories cannot be deleted; deactivate them instead' using errcode = '22023';
  end if;
  if old.is_system and (new.code <> old.code or new.type <> old.type or new.pnl_group <> old.pnl_group
                        or new.is_system <> old.is_system or new.allow_manual <> old.allow_manual) then
    raise exception 'VALIDATION: system category % can only be renamed', old.code using errcode = '22023';
  end if;
  return new;
end;
$$;

create or replace function public._platform_execute_approval_more(a public.platform_approvals)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e public.credit_ledger;
begin
  case a.action
    when 'credit_adjust' then
      e := public._credit_post(a.merchant_id, a.payload ->> 'credit_type', (a.payload ->> 'amount')::int, a.payload ->> 'kind', a.reason,
        a.requested_by, 'PLATFORM', 'platform_approval', a.id::text, a.payload ->> 'key', (a.payload ->> 'expires_at')::timestamptz,
        jsonb_build_object('approved_by', auth.uid()));
      perform public._platform_log('credits.' || lower(a.payload ->> 'kind'), a.merchant_id, 'credit_ledger', e.id::text, a.reason, null,
        jsonb_build_object('credit_type', e.credit_type, 'amount', e.amount, 'balance_after', e.balance_after, 'approval', a.id));
      return jsonb_build_object('entry_id', e.id, 'balance_after', e.balance_after);
    when 'merchant_delete' then
      return public._platform_merchant_delete(a);
    else
      raise exception 'VALIDATION: unknown approval action %', a.action using errcode = '22023';
  end case;
end;
$$;

revoke execute on function public.platform_merchant_delete_request(uuid, text, text) from public, anon;
grant execute on function public.platform_merchant_delete_request(uuid, text, text) to authenticated;
revoke execute on function public._platform_merchant_delete(public.platform_approvals) from public, anon, authenticated;
revoke execute on function public._platform_merchant_recent_export(uuid) from public, anon, authenticated;

-- These read logins and platform staff, and delete one named merchant's rows in every table.
insert into public.tenancy_exempt_functions (name, reason)
select f, 'Merchant deletion and sign-in sync: one named merchant or login at a time; permission-checked or service role only'
from unnest(array['_platform_merchant_delete', '_platform_merchant_recent_export', 'find_auth_user_by_clerk']) f
on conflict (name) do nothing;

select public._tenancy_own_functions();
