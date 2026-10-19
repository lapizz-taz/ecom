-- =============================================================================
-- Security audit (run 3): the open leads.
--
-- 1. Courier lookups started from a public checkout are capped per visitor and per
--    store (checkout_lookup_allowed). The cap counted finished checks, so lookups
--    running at the same moment all passed it, and the WooCommerce checkout did
--    not use it at all. Each allowed lookup now takes a slot under a per-store lock
--    first; both checkouts call it.
-- 2. The storefront's ad beacon sends events with the store's own tokens: it now
--    learns the store's own addresses and its active products' prices
--    (ad_track_scope) to drop events of other sites and invented products/prices.
-- 3. WhatsApp sign-up: a few requests per network address an hour, so one caller
--    cannot use up the platform-wide hourly allowance and lock everyone else out.
-- 4. The store's phone pattern (a regular expression staff can edit) may not
--    repeat a group that can itself match in several ways, like (a+)+.
-- Safe to re-run.
-- =============================================================================

create or replace function pg_temp.patch_fn(p_fn text, p_marker text, p_from text, p_to text)
returns void
language plpgsql as $$
declare
  v_old text := replace(pg_get_functiondef(p_fn::regprocedure), E'\r', '');
  v_hits int;
begin
  if position(p_marker in v_old) > 0 then
    return; -- already patched
  end if;
  -- Pasted into an editor on Windows the text arrives with CRLF line ends: compare without them.
  p_from := replace(p_from, E'\r', '');
  p_to := replace(p_to, E'\r', '');
  v_hits := (length(v_old) - length(replace(v_old, p_from, ''))) / length(p_from);
  if v_hits <> 1 then
    raise exception 'audit run 3 leads: % has changed (% matches for "%")', p_fn, v_hits, left(p_from, 60);
  end if;
  execute replace(v_old, p_from, p_to);
end $$;

create or replace function pg_temp.patch_fn_many(p_fn text, p_marker text, p_pairs text[])
returns void
language plpgsql as $$
declare
  v_old text := replace(pg_get_functiondef(p_fn::regprocedure), E'\r', '');
  v_new text;
  v_hits int;
  i int;
begin
  if position(p_marker in v_old) > 0 then
    return; -- already patched
  end if;
  v_new := v_old;
  -- Pasted into an editor on Windows the text arrives with CRLF line ends: compare without them.
  p_pairs := array(select replace(x, E'\r', '') from unnest(p_pairs) with ordinality u(x, o) order by o);
  for i in 1 .. array_length(p_pairs, 1) by 2 loop
    v_hits := (length(v_old) - length(replace(v_old, p_pairs[i], ''))) / length(p_pairs[i]);
    if v_hits <> 1 then
      raise exception 'audit run 3 leads: % has changed (% matches for "%")', p_fn, v_hits, left(p_pairs[i], 60);
    end if;
    v_new := replace(v_new, p_pairs[i], p_pairs[i + 1]);
  end loop;
  execute v_new;
end $$;

-- -----------------------------------------------------------------------------
-- 1. Checkout lookups: a slot is taken before the lookup starts.
-- -----------------------------------------------------------------------------

create table if not exists public.checkout_lookup_slots (
  id bigint generated always as identity primary key,
  merchant_id uuid not null default public.current_merchant_id() references public.merchants(id) on delete cascade,
  ip_hash text not null check (length(ip_hash) = 64),
  created_at timestamptz not null default now()
);
create index if not exists checkout_lookup_slots_recent_idx on public.checkout_lookup_slots (merchant_id, created_at desc);
create index if not exists checkout_lookup_slots_ip_idx on public.checkout_lookup_slots (merchant_id, ip_hash, created_at desc);

alter table public.checkout_lookup_slots enable row level security;
drop policy if exists tenant_isolation on public.checkout_lookup_slots;
create policy tenant_isolation on public.checkout_lookup_slots as restrictive for all to public
  using (merchant_id = (select public.current_merchant_id()))
  with check (merchant_id = (select public.current_merchant_id()));
drop policy if exists app_owner_all on public.checkout_lookup_slots;
create policy app_owner_all on public.checkout_lookup_slots for all to app_owner using (true) with check (true);
revoke all on public.checkout_lookup_slots from anon, authenticated;

-- Courier lookups started by a public checkout (the hosted storefront before the order is
-- placed, and the WooCommerce order shield) spend the store's lookups: at most 10 an hour per
-- visitor and, by default, 300 an hour per store (Settings → Fraud: checkout_lookups). The
-- answer takes a slot when it says yes, under a lock per store, so lookups running at the same
-- time are counted too. A visitor over the limit still gets a decision when the order is placed.
create or replace function public.checkout_lookup_allowed(p_ip text)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_mid uuid := public.current_merchant_id();
  v_hash text := encode(sha256(convert_to(coalesce(nullif(p_ip, ''), 'unknown'), 'UTF8')), 'hex');
begin
  perform public._require_system();
  if v_mid is null then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('checkout_lookup:' || v_mid::text, 0));
  delete from public.checkout_lookup_slots where merchant_id = v_mid and created_at < now() - interval '2 hours';
  if (select count(*) from public.checkout_lookup_slots
      where merchant_id = v_mid and ip_hash = v_hash and created_at > now() - interval '1 hour')
       >= public.setting_numeric('fraud', array['checkout_lookups', 'per_visitor'], 10)
     or (select count(*) from public.checkout_lookup_slots
         where merchant_id = v_mid and created_at > now() - interval '1 hour')
       >= public.setting_numeric('fraud', array['checkout_lookups', 'per_hour'], 300) then
    return false;
  end if;
  insert into public.checkout_lookup_slots (merchant_id, ip_hash) values (v_mid, v_hash);
  return true;
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. The ad beacon: this store's addresses, and the catalog price of its active products.
-- -----------------------------------------------------------------------------

create or replace function public.ad_track_scope(p_ids uuid[] default '{}')
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_mid uuid := public.current_merchant_id();
  v_root text := public._store_root_domain();
  v_slug text;
begin
  perform public._require_system();
  select slug into v_slug from public.merchants where id = v_mid;
  return jsonb_build_object(
    'hosts', coalesce((select jsonb_agg(distinct h) from (
        select d.domain as h from public.store_domains d where d.merchant_id = v_mid and d.status = 'ACTIVE'
        union all
        select v_slug || '.' || v_root where v_slug is not null and v_root is not null
      ) x where h is not null), '[]'::jsonb),
    'prices', coalesce((select jsonb_object_agg(p.id::text, (select max(coalesce(v.price, p.price)) from public.product_variants v where v.product_id = p.id and v.is_active))
      from public.products p
      where p.id = any (coalesce(p_ids, '{}')) and p.status = 'ACTIVE'
        and exists (select 1 from public.product_variants v where v.product_id = p.id and v.is_active)), '{}'::jsonb));
end;
$$;
revoke all on function public.ad_track_scope(uuid[]) from public, anon, authenticated;
grant execute on function public.ad_track_scope(uuid[]) to service_role;

-- -----------------------------------------------------------------------------
-- 3. WhatsApp sign-up: a few requests per network address an hour.
-- -----------------------------------------------------------------------------

-- The caller's address as the API gateway passed it (Cloudflare's header first, which a
-- client cannot set; then the gateway's own), or null outside an API request.
create or replace function public._request_ip()
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select nullif(trim(coalesce(h ->> 'cf-connecting-ip', h ->> 'x-real-ip', split_part(h ->> 'x-forwarded-for', ',', 1))), '')
  from (select nullif(current_setting('request.headers', true), '')::jsonb as h) x
$$;

alter table public.signup_requests add column if not exists ip_hash text check (ip_hash is null or length(ip_hash) = 64);
create index if not exists signup_requests_ip_idx on public.signup_requests (ip_hash, created_at desc) where ip_hash is not null;

select pg_temp.patch_fn_many('public.public_signup_request(jsonb)', 'too many sign-up requests from this network', array[
$a$  if (select count(*) from public.signup_requests where created_at > now() - interval '1 hour') >= 60 then
$a$,
$b$  v_ip_hash := (select encode(sha256(convert_to(ip, 'UTF8')), 'hex') from (select public._request_ip() as ip) x where ip is not null);
  if v_ip_hash is not null and (select count(*) from public.signup_requests where ip_hash = v_ip_hash and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'RATE_LIMITED: too many sign-up requests from this network; please try again later' using errcode = 'P0001';
  end if;
  if (select count(*) from public.signup_requests where created_at > now() - interval '1 hour') >= 200 then
$b$,
$a$  v_msg text;
$a$,
$b$  v_msg text;
  v_ip_hash text;
$b$,
$a$  insert into public.signup_requests (id, business_name, full_name, phone, whatsapp, email, business_type, website, sells_on, orders_per_month, plan_code, message)
  values (v_id, v_name, v_person, v_phone, v_wa, v_email, v_type, v_site, v_sells, v_orders, v_plan.code, v_msg)$a$,
$b$  insert into public.signup_requests (id, business_name, full_name, phone, whatsapp, email, business_type, website, sells_on, orders_per_month, plan_code, message, ip_hash)
  values (v_id, v_name, v_person, v_phone, v_wa, v_email, v_type, v_site, v_sells, v_orders, v_plan.code, v_msg, v_ip_hash)$b$]);

-- -----------------------------------------------------------------------------
-- 4. The store's phone pattern: no nested repetition.
-- -----------------------------------------------------------------------------

-- True when a pattern repeats a group that can itself match in more than one way: a group
-- with an inner unbounded quantifier repeated without bound (or more than ten times), like
-- (\d+)+ or (.*a){20}; or an alternation repeated without bound, like (a|a)*. Backtracking
-- engines (the browser's, and the Cloudflare database's) can take exponential time on those.
-- The same rule as nestedQuantifier() in worker/db/pg/builtins.ts.
create or replace function public._regex_nested_repetition(p text)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  n int := length(coalesce(p, ''));
  i int := 1;
  c text;
  in_class boolean := false;
  inner_q boolean[] := '{}';
  alt boolean[] := '{}';
  depth int := 0;
  g_inner boolean;
  g_alt boolean;
  q text;
  q_unbounded boolean;
  q_max numeric;
  m text[];
begin
  while i <= n loop
    c := substr(p, i, 1);
    if c = '\' then
      i := i + 2;
      continue;
    end if;
    if in_class then
      if c = ']' then in_class := false; end if;
      i := i + 1;
      continue;
    end if;
    if c = '[' then
      in_class := true;
    elsif c = '(' then
      depth := depth + 1;
      inner_q[depth] := false;
      alt[depth] := false;
    elsif c = '|' and depth > 0 then
      alt[depth] := true;
    elsif c = ')' and depth > 0 then
      g_inner := inner_q[depth];
      g_alt := alt[depth];
      depth := depth - 1;
      q := substr(p, i + 1, 1);
      q_unbounded := q in ('*', '+');
      q_max := case when q in ('*', '+') then 'Infinity'::numeric when q = '?' then 1 else null end;
      if q = '{' then
        m := regexp_match(substr(p, i + 1), '^\{(\d*)(,?)(\d*)\}');
        if m is not null then
          q_unbounded := m[2] = ',' and m[3] = '';
          q_max := case when q_unbounded then 'Infinity'::numeric else coalesce(nullif(m[3], ''), nullif(m[1], ''), '0')::numeric end;
        end if;
      end if;
      if q_max is not null and g_inner and (q_unbounded or q_max > 10) then
        return true;
      end if;
      if g_alt and q_unbounded then
        return true;
      end if;
      if depth > 0 and (g_inner or q_unbounded) then
        inner_q[depth] := true;
      end if;
    elsif c in ('*', '+') or (c = '{' and substr(p, i) ~ '^\{\d*,\}') then
      if depth > 0 then inner_q[depth] := true; end if;
    end if;
    i := i + 1;
  end loop;
  return false;
end;
$$;

create or replace function public._settings_check_phone_pattern()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_pattern text := new.value ->> 'phone_pattern';
begin
  if new.key = 'store' and v_pattern is not null then
    if length(v_pattern) > 200 then
      raise exception 'VALIDATION: the phone pattern is too long (200 characters at most)' using errcode = '22023';
    end if;
    if public._regex_nested_repetition(v_pattern) then
      raise exception 'VALIDATION: the phone pattern repeats a repeated group (like (\d+)+); write it without nested repetition' using errcode = '22023';
    end if;
    begin
      perform '' ~ v_pattern;
    exception when others then
      raise exception 'VALIDATION: the phone pattern is not a valid regular expression' using errcode = '22023';
    end;
  end if;
  return new;
end;
$$;

drop trigger if exists settings_phone_pattern on public.settings;
create trigger settings_phone_pattern before insert or update of value on public.settings
  for each row execute function public._settings_check_phone_pattern();

select public._tenancy_own_functions();
