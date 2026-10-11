-- external-api part 2 of 5: run the parts in order
create or replace function public.admin_api_key_revoke(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('settings.manage');
  update public.api_keys set revoked_at = now(), revoked_by = auth.uid() where id = p_id and revoked_at is null;
  if not found then
    raise exception 'NOT_FOUND: key not found or already turned off' using errcode = 'P0002';
  end if;
  perform public.log_audit('api_key.revoke', 'api_key', p_id::text, null, null);
end;
$$;
create or replace function public.admin_api_logs(p_limit int default 100, p_key uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('settings.view');
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc) from (
    select l.id, l.key_id, k.name as key_name, l.method, l.path, l.status, l.duration_ms, l.error_code, l.created_at
    from public.api_request_logs l left join public.api_keys k on k.id = l.key_id
    where p_key is null or l.key_id = p_key
    order by l.created_at desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) x), '[]'::jsonb);
end;
$$;
create or replace function public.api_key_merchant(p_hash text)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select k.merchant_id from public.api_keys k join public.merchants m on m.id = k.merchant_id
  where k.key_hash = p_hash and k.revoked_at is null and (k.expires_at is null or k.expires_at > now()) and m.status <> 'CLOSED'
$$;
create or replace function public.api_key_check(p_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.api_keys;
begin
  perform public._require_system();
  update public.api_keys set last_used_at = now(), request_count = request_count + 1
  where key_hash = p_hash and revoked_at is null and (expires_at is null or expires_at > now())
  returning * into v_row;
  if not found then
    return null;
  end if;
  return jsonb_build_object('id', v_row.id, 'name', v_row.name, 'scopes', to_jsonb(v_row.scopes),
    'feature', public.feature_enabled('external_api'));
end;
$$;
create or replace function public.api_request_log(p_key uuid, p_method text, p_path text, p_status int, p_duration_ms int, p_ip text, p_error text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._require_system();
  insert into public.api_request_logs (key_id, method, path, status, duration_ms, ip, error_code)
  values (p_key, left(p_method, 10), left(p_path, 300), p_status, p_duration_ms, left(p_ip, 64), left(p_error, 60));
end;
$$;
create or replace function public._api_require(p_key uuid, p_scope text)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._require_system();
  if not exists (select 1 from public.api_keys where id = p_key and revoked_at is null and (expires_at is null or expires_at > now())) then
    raise exception 'PERMISSION_DENIED: this API key is not valid or has been turned off' using errcode = '42501';
  end if;
  if not exists (select 1 from public.api_keys where id = p_key and p_scope = any(scopes)) then
    raise exception 'PERMISSION_DENIED: this API key does not have the % permission', p_scope using errcode = '42501';
  end if;
  perform public.require_feature('external_api');
end;
$$;
