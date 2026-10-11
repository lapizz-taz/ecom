-- Fullfilio: last step of "Delete merchant". Paste ALL of this into Supabase → SQL Editor → Run.
create or replace function public._platform_merchant_delete(a public.platform_approvals) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.merchants; v_logins uuid[]; v_reset jsonb; r public.store_resets; v_tables text[]; v_left text[]; v_kept jsonb := '{}'::jsonb; v_counts jsonb := '{}'::jsonb; t text; n int; v_pass int := 0; v_progress boolean;
begin
  select * into m from public.merchants where id = a.merchant_id for update;
  if not found then raise exception 'NOT_FOUND: merchant not found' using errcode = 'P0002'; end if;
  if m.deleted_at is not null then raise exception 'VALIDATION: this merchant was already deleted' using errcode = '22023'; end if;
  if public._platform_merchant_recent_export(m.id) is null then
    raise exception 'VALIDATION: download a full export of this merchant (Data Management → Export) within 24 hours before approving' using errcode = '22023'; end if;
  perform public._platform_in_merchant(m.id);
  select coalesce(array_agg(p.id), '{}') into v_logins from public.profiles p where p.merchant_id = m.id and not exists (select 1 from public.platform_staff s where s.user_id = p.id);
  update public.profiles set is_active = false where merchant_id = m.id and is_active;
  v_reset := public.platform_store_reset(m.id, 'EVERYTHING', m.name, 'Merchant deleted: ' || a.reason);
  insert into public.store_resets (merchant_id, scope, reason, export_id, requested_by, requested_by_email, txid)
  values (m.id, 'EVERYTHING', left('Merchant deleted: ' || a.reason, 2000), public._platform_merchant_recent_export(m.id), auth.uid(), (select email from public.platform_staff where user_id = auth.uid()), txid_current()) returning * into r;
  perform set_config('app.store_reset', r.id::text, true);
  perform public._platform_in_merchant(m.id);
  set local lock_timeout = '20s';
  select coalesce(array_agg(c.relname::text order by c.relname), '{}') into v_tables from pg_class c
  where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname <> all (public._merchant_delete_kept_tables())
    and exists (select 1 from pg_attribute at where at.attrelid = c.oid and at.attname = 'merchant_id' and not at.attisdropped);
  loop
    v_pass := v_pass + 1; v_progress := false; v_left := '{}';
    foreach t in array v_tables loop
      begin
        execute format('delete from public.%I where merchant_id = $1', t) using m.id;
        get diagnostics n = row_count;
        if n > 0 then v_counts := v_counts || jsonb_build_object(t, coalesce((v_counts ->> t)::int, 0) + n); v_progress := true; end if;
      exception when foreign_key_violation then v_left := v_left || t; when others then v_kept := v_kept || jsonb_build_object(t, sqlerrm);
      end;
    end loop;
    v_tables := v_left;
    exit when cardinality(v_tables) = 0 or not v_progress or v_pass >= 12;
  end loop;
  foreach t in array v_tables loop v_kept := v_kept || jsonb_build_object(t, 'still referenced by a record that stays'); end loop;
  update public.store_resets set status = 'DONE', counts = v_counts, finished_at = now() where id = r.id;
  perform set_config('app.store_reset', '', true);
  update public.billing_payments set raw = '{}'::jsonb, note = null where merchant_id = m.id;
  update public.pbx_bkash_transactions set raw = '{}'::jsonb where merchant_id = m.id;
  update public.pbx_businesses set name = format('Deleted merchant #%s', m.number) where merchant_id = m.id;
  update public.merchants set name = format('Deleted merchant #%s', m.number), slug = null, phone = null, address = null, website = null, notes = null, owner_email = null,
    business_type = null, onboarding = '{}'::jsonb, account_manager_id = null, status = 'CLOSED', status_reason = left('Deleted: ' || a.reason, 500),
    status_changed_at = now(), status_changed_by = auth.uid(), deleted_at = now() where id = m.id;
  update public.support_sessions set ended_at = now(), end_reason = 'Merchant deleted' where merchant_id = m.id and ended_at is null;
  insert into public.account_removals (user_id, from_merchant, reason) select u, m.id, 'Merchant deleted' from unnest(v_logins) u;
  perform public._platform_log('merchants.deleted', m.id, 'merchant', m.id::text, a.reason, jsonb_build_object('name', m.name, 'number', m.number),
    jsonb_build_object('reset', v_reset -> 'counts', 'deleted', v_counts, 'kept', v_kept, 'logins', cardinality(v_logins), 'approval', a.id));
  return jsonb_build_object('merchant_id', m.id, 'deleted', v_counts, 'kept', v_kept, 'logins_removed', cardinality(v_logins));
end; $$;
revoke execute on function public._platform_merchant_delete(public.platform_approvals) from public, anon, authenticated;
insert into public.tenancy_exempt_functions (name, reason) values ('_platform_merchant_delete', 'Merchant deletion: one named merchant at a time; only from an approved request') on conflict (name) do nothing;
