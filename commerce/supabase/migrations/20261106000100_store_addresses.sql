-- =============================================================================
-- Store addresses: the platform's own address shows the Fullfilio website; a
-- business that sells with our online store gets a store address.
--
-- * Every business with the online store switched on (storefront mode OWN)
--   has a store name (merchants.slug). Its store opens at
--     https://<slug>.<root domain>   when the Super Admin has set a root domain
--                                    with wildcard DNS (platform setting
--                                    "store_domains"), and always at
--     <platform address>/s/<slug>.
--   A business that sells only on Shopify, WooCommerce or social media gets no
--   store name, so nothing is published for it.
-- * Custom domains work as before and take priority.
-- * storefront_resolve() says what an address is: a store, the platform
--   ("platform": the Fullfilio website) or an unknown store ("missing"). Until
--   the setting store_domains.main_site is "marketing", the platform address
--   keeps showing the default store, so the database can be updated before
--   the new web app goes live.
-- =============================================================================

insert into public.platform_settings (key, value, description) values
  ('store_domains', jsonb_build_object('root_domain', null, 'main_site', 'store'),
   'Store addresses: root domain for store subdomains (needs wildcard DNS) and what the platform address shows (marketing or the default store)')
on conflict (key) do nothing;

-- Names a store cannot take: they are, or may become, platform addresses.
create or replace function public._store_slug_reserved(p_slug text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_slug = any (array['www', 'app', 'admin', 'api', 'mail', 'smtp', 'ftp', 'super', 'superadmin', 'super-admin', 'root',
    'static', 'assets', 'cdn', 'status', 'help', 'support', 'docs', 'blog', 'store', 'shop', 's', 'start', 'login', 'signup',
    'fullfilio', 'dashboard', 'billing', 'pay', 'payment', 'payments', 'checkout', 'account', 'auth', 'ops', 'internal', 'test'])
$$;

/** Why a store name cannot be used (null when it can), ignoring p_merchant's own name. */
create or replace function public._store_slug_problem(p_slug text, p_merchant uuid default null)
returns text
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  if p_slug is null or p_slug !~ '^[a-z0-9][a-z0-9-]{1,40}$' or p_slug like '%-' or p_slug like '%--%' then
    return 'Use 2 to 41 lower-case letters, numbers and single dashes, starting with a letter or number';
  end if;
  if public._store_slug_reserved(p_slug) then
    return 'This name is reserved';
  end if;
  if exists (select 1 from public.merchants where slug = p_slug and id is distinct from p_merchant) then
    return 'This store name is taken';
  end if;
  return null;
end;
$$;

/** A free store name made from the business name ("Nadia Crafts" -> nadia-crafts, nadia-crafts-2, …). */
create or replace function public._store_slug_from(p_name text, p_merchant uuid)
returns text
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_base text := trim(both '-' from left(regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', '-', 'g'), 30));
  v_try text;
  v_n int := 1;
begin
  if length(v_base) < 2 then v_base := 'my-shop'; end if;
  if public._store_slug_reserved(v_base) then v_base := v_base || '-shop'; end if;
  v_try := v_base;
  while public._store_slug_problem(v_try, p_merchant) is not null loop
    v_n := v_n + 1;
    v_try := trim(both '-' from left(v_base, 34)) || '-' || v_n;
  end loop;
  return v_try;
end;
$$;

-- A business that turns the online store on gets a store name (once).
create or replace function public._settings_store_slug()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.key = 'storefront' and coalesce(new.value ->> 'mode', 'OWN') = 'OWN' then
    update public.merchants m set slug = public._store_slug_from(m.name, m.id)
    where m.id = new.merchant_id and m.slug is null;
  end if;
  return new;
end;
$$;
revoke execute on function public._settings_store_slug() from public, anon, authenticated;
drop trigger if exists settings_store_slug on public.settings;
create trigger settings_store_slug after insert or update of value on public.settings
  for each row when (new.key = 'storefront') execute function public._settings_store_slug();

-- Existing businesses that use the online store get their name now.
do $$
declare
  r record;
begin
  for r in
    select m.id, m.name from public.merchants m
    where m.slug is null and m.status <> 'CLOSED'
      and coalesce((select s.value ->> 'mode' from public.settings s where s.merchant_id = m.id and s.key = 'storefront'), 'OWN') = 'OWN'
    order by m.created_at, m.id
  loop
    update public.merchants set slug = public._store_slug_from(r.name, r.id) where id = r.id;
  end loop;
end $$;

/** Sign-up page: can this store name be used? */
create or replace function public.store_slug_check(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_slug text := lower(trim(coalesce(p_slug, '')));
  v_problem text := public._store_slug_problem(v_slug);
begin
  return jsonb_build_object('slug', v_slug, 'available', v_problem is null, 'reason', v_problem, 'root_domain', public._store_root_domain());
end;
$$;

/** Sign-up page: a suggested store name for a business name. */
create or replace function public.store_slug_suggest(p_name text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$ select public._store_slug_from(p_name, null) $$;

-- The platform's root domain for store subdomains, when it is a valid domain.
create or replace function public._store_root_domain()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select d from (select lower(trim(value ->> 'root_domain')) as d from public.platform_settings where key = 'store_domains') x
  where d ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
$$;

create or replace function public._store_json(p_m public.merchants, p_redirect text default null)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object('kind', 'store', 'merchant_id', p_m.id, 'name', p_m.name, 'status', p_m.status, 'slug', p_m.slug, 'redirect_to', p_redirect)
$$;

/**
 * What a web address shows: a store (custom domain or <slug>.<root domain>),
 * the platform's own website ("platform"), or a store that does not exist or
 * is switched off ("missing").
 */
create or replace function public.storefront_resolve(p_host text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_host text := regexp_replace(lower(trim(coalesce(p_host, ''))), ':[0-9]+$', '');
  v_id uuid;
  v_m public.merchants;
  v_primary text;
  v_root text := public._store_root_domain();
  v_sub text;
  v_main text := coalesce((select value ->> 'main_site' from public.platform_settings where key = 'store_domains'), 'store');
begin
  if v_host <> '' then
    select merchant_id into v_id from public.store_domains
    where domain in (v_host, regexp_replace(v_host, '^www\.', ''), 'www.' || v_host) and status <> 'REMOVED'
    order by (domain = v_host) desc limit 1;
    if v_id is not null then
      select domain into v_primary from public.store_domains
      where merchant_id = v_id and is_primary and status = 'ACTIVE' and domain <> v_host;
    end if;
  end if;

  if v_id is null and v_root is not null and v_host like '%.' || v_root then
    v_sub := left(v_host, length(v_host) - length(v_root) - 1);
    if v_sub not in ('www', 'app') and position('.' in v_sub) = 0 then
      select m.* into v_m from public.merchants m
      where m.slug = v_sub and m.status <> 'CLOSED'
        and coalesce((select s.value ->> 'mode' from public.settings s where s.merchant_id = m.id and s.key = 'storefront'), 'OWN') = 'OWN';
      if v_m.id is null then
        return jsonb_build_object('kind', 'missing');
      end if;
      return public._store_json(v_m);
    end if;
  end if;

  if v_id is null then
    if v_main = 'marketing' then
      return jsonb_build_object('kind', 'platform');
    end if;
    select nullif(value ->> 'default_merchant_id', '')::uuid into v_id from public.platform_settings where key = 'storefront';
  end if;
  select * into v_m from public.merchants where id = v_id and status <> 'CLOSED';
  if v_m.id is null then
    return case when v_main = 'marketing' then jsonb_build_object('kind', 'platform') end;
  end if;
  return public._store_json(v_m, v_primary);
end;
$$;

/** The store at <platform address>/s/<slug>, which works without any DNS. */
create or replace function public.storefront_resolve_slug(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_m public.merchants;
begin
  select * into v_m from public.merchants where slug = lower(trim(coalesce(p_slug, ''))) and status <> 'CLOSED';
  if v_m.id is null
     or coalesce((select s.value ->> 'mode' from public.settings s where s.merchant_id = v_m.id and s.key = 'storefront'), 'OWN') <> 'OWN' then
    return jsonb_build_object('kind', 'missing');
  end if;
  return public._store_json(v_m);
end;
$$;

/** Staff: where their store is published. */
create or replace function public.merchant_store_address()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := public.current_merchant_id();
  v_m public.merchants;
  v_mode text;
  v_root text := public._store_root_domain();
begin
  if not public.is_staff() then
    raise exception 'PERMISSION_DENIED: staff only' using errcode = '42501';
  end if;
  select * into v_m from public.merchants where id = v_id;
  select coalesce(value ->> 'mode', 'OWN') into v_mode from public.settings where merchant_id = v_id and key = 'storefront';
  return jsonb_build_object(
    'mode', coalesce(v_mode, 'OWN'),
    'slug', v_m.slug,
    'root_domain', v_root,
    'subdomain', case when coalesce(v_mode, 'OWN') = 'OWN' and v_m.slug is not null and v_root is not null then v_m.slug || '.' || v_root end,
    'custom_domain', (select domain from public.store_domains where merchant_id = v_id and is_primary and status = 'ACTIVE' limit 1));
end;
$$;

/** Staff: rename the store's address (the online store must be on). */
create or replace function public.admin_set_store_slug(p_slug text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := public.current_merchant_id();
  v_slug text := lower(trim(coalesce(p_slug, '')));
  v_old text;
  v_problem text;
begin
  perform public.require_permission('settings.manage');
  if coalesce((select value ->> 'mode' from public.settings where merchant_id = v_id and key = 'storefront'), 'OWN') <> 'OWN' then
    raise exception 'VALIDATION: turn on the online store first' using errcode = '22023';
  end if;
  v_problem := public._store_slug_problem(v_slug, v_id);
  if v_problem is not null then
    raise exception 'VALIDATION: %', v_problem using errcode = '22023';
  end if;
  select slug into v_old from public.merchants where id = v_id for update;
  update public.merchants set slug = v_slug where id = v_id;
  perform public.log_audit('store.address', 'merchant', v_id::text, jsonb_build_object('slug', v_old), jsonb_build_object('slug', v_slug));
  return public.merchant_store_address();
end;
$$;

/** Super Admin: the root domain for store subdomains and what the platform address shows. */
create or replace function public.platform_store_domains_save(p_value jsonb, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_root text := nullif(lower(trim(coalesce(p_value ->> 'root_domain', ''))), '');
  v_main text := coalesce(nullif(p_value ->> 'main_site', ''), 'marketing');
  v_before jsonb;
  v_after jsonb;
begin
  perform public._platform_require('settings', 'edit');
  if v_root is not null and v_root !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' then
    raise exception 'VALIDATION: enter a domain like fullfilio.com (no https:// or slashes)' using errcode = '22023';
  end if;
  if v_main not in ('marketing', 'store') then
    raise exception 'VALIDATION: the main address shows the website (marketing) or the default store (store)' using errcode = '22023';
  end if;
  select value into v_before from public.platform_settings where key = 'store_domains' for update;
  v_after := jsonb_build_object('root_domain', v_root, 'main_site', v_main);
  insert into public.platform_settings (key, value, description) values ('store_domains', v_after, 'Store addresses')
  on conflict (key) do update set value = excluded.value;
  perform public._platform_log('settings.store_domains', null, 'platform_setting', 'store_domains', p_reason, v_before, v_after);
  return v_after;
end;
$$;

-- Sign-up: "Do you want a Fullfilio online store?" — yes reserves the store
-- name (the one asked for, or one made from the business name); no switches
-- the storefront off and publishes nothing.
do $$
declare
  v_def text := pg_get_functiondef('public.merchant_self_onboard(jsonb)'::regprocedure);
  v_new text;
begin
  v_new := replace(v_def,
    $o$  perform public._merchant_seed_defaults(v_id);$o$,
    $n$  perform public._merchant_seed_defaults(v_id);
  -- Online store or not (a missing answer keeps the store on, as before).
  if coalesce(p ->> 'online_store', 'true') = 'false' then
    update public.settings set value = value || jsonb_build_object('mode', 'OFF') where merchant_id = v_id and key = 'storefront';
    update public.merchants set slug = null where id = v_id;
  elsif nullif(trim(coalesce(p ->> 'store_slug', '')), '') is not null then
    if public._store_slug_problem(lower(trim(p ->> 'store_slug')), v_id) is not null then
      raise exception 'VALIDATION: store address: %', public._store_slug_problem(lower(trim(p ->> 'store_slug')), v_id) using errcode = '22023';
    end if;
    update public.merchants set slug = lower(trim(p ->> 'store_slug')) where id = v_id;
  end if;$n$);
  if v_new = v_def then
    raise exception 'store addresses: merchant_self_onboard() has changed; update this migration';
  end if;
  execute v_new;
end $$;

-- Helpers run with their caller's rights (the definer functions above them).
revoke execute on function public._store_slug_reserved(text), public._store_slug_problem(text, uuid), public._store_slug_from(text, uuid),
  public._store_root_domain(), public._store_json(public.merchants, text) from public, anon, authenticated;
grant execute on function public._store_slug_reserved(text), public._store_slug_problem(text, uuid), public._store_slug_from(text, uuid),
  public._store_root_domain(), public._store_json(public.merchants, text) to app_owner;
revoke execute on function public.store_slug_check(text), public.store_slug_suggest(text), public.storefront_resolve_slug(text),
  public.merchant_store_address(), public.admin_set_store_slug(text), public.platform_store_domains_save(jsonb, text) from public;
grant execute on function public.store_slug_check(text), public.store_slug_suggest(text), public.storefront_resolve_slug(text) to anon, authenticated;
grant execute on function public.merchant_store_address(), public.admin_set_store_slug(text), public.platform_store_domains_save(jsonb, text) to authenticated;

insert into public.tenancy_exempt_functions (name, reason) values
  ('_settings_store_slug', 'Gives a business its unique store name when the online store is turned on'),
  ('store_slug_check', 'Sign-up page: is a store name free (no merchant data)'),
  ('store_slug_suggest', 'Sign-up page: a free store name for a business name'),
  ('_store_root_domain', 'Reads the platform domain setting for store addresses (not merchant data)'),
  ('storefront_resolve_slug', 'Maps a store address to a merchant before any merchant is known'),
  ('admin_set_store_slug', 'Store names are unique across all businesses; the caller''s own merchant is changed'),
  ('platform_store_domains_save', 'Platform setting, not merchant data')
on conflict (name) do nothing;

select public._tenancy_own_functions();
