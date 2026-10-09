-- =============================================================================
-- TikTok Ads and Google Ads
--   * the store's own developer app for each platform (TikTok app ID and
--     secret; Google OAuth client, client secret and developer token) is kept
--     in Vault ("ads.<platform>.app"); only non-secret parts are in settings
--   * staff connect with the platform's OAuth screen; the access / refresh
--     token of each connection is kept in Vault ("ads.<platform>.<id>")
--   * ad accounts (TikTok advertisers, Google customer accounts) are listed;
--     the selected ones are synced: campaigns and daily spend, impressions,
--     clicks and conversions per campaign
--   * spend is converted with each account's rate (+ VAT %) and becomes
--     marketing spend, which posts to Advertising in Finance; orders are tied
--     to a campaign only when their link carried its ID
-- =============================================================================

insert into public.settings(key, is_public, description, value) values
  ('ad_platforms', false, 'TikTok / Google Ads developer apps (non-secret parts; secrets live in Vault)', jsonb_build_object(
    'tiktok', jsonb_build_object('app_id', null, 'configured', false, 'hint', null),
    'google', jsonb_build_object('client_id', null, 'login_customer_id', null, 'configured', false, 'hint', null)))
on conflict (key) do nothing;

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------
create table if not exists public.ad_connections (
  id uuid primary key default gen_random_uuid(),
  platform text not null check (platform in ('TIKTOK', 'GOOGLE')),
  external_user text,
  display_name text,
  token_hint text,
  status text not null default 'CONNECTED' check (status in ('CONNECTED', 'FAILED', 'DISCONNECTED')),
  last_error text,
  connected_by uuid references public.profiles(id),
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists ad_connections_user_uq on public.ad_connections(platform, lower(external_user))
  where status <> 'DISCONNECTED' and external_user is not null;
create trigger ad_connections_updated_at before update on public.ad_connections
  for each row execute function public.set_updated_at();

create table if not exists public.ad_accounts (
  id uuid primary key default gen_random_uuid(),
  platform text not null check (platform in ('TIKTOK', 'GOOGLE')),
  connection_id uuid references public.ad_connections(id),
  external_id text not null check (external_id ~ '^[0-9]{3,32}$'),
  /** Google: the manager account the customer is reached through. */
  login_customer_id text check (login_customer_id is null or login_customer_id ~ '^[0-9]{3,32}$'),
  name text,
  currency text,
  timezone text,
  is_manager boolean not null default false,
  is_selected boolean not null default false,
  usd_rate numeric(12,4) not null default 110 check (usd_rate > 0 and usd_rate <= 100000),
  tax_percent numeric(5,2) not null default 0 check (tax_percent >= 0 and tax_percent <= 100),
  last_sync_at timestamptz,
  last_sync_status text,
  last_sync_error text,
  last_sync_since date,
  last_sync_until date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (platform, external_id)
);
create trigger ad_accounts_updated_at before update on public.ad_accounts
  for each row execute function public.set_updated_at();

-- Daily numbers per campaign as the platform reports them (account currency).
create table if not exists public.ad_platform_stats (
  account_id uuid not null references public.ad_accounts(id),
  campaign_id text not null check (campaign_id ~ '^[0-9]{1,32}$'),
  date date not null,
  spend numeric(14,2) not null default 0 check (spend >= 0),
  cost numeric(14,2) not null default 0 check (cost >= 0),
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  conversions numeric(14,2) not null default 0,
  conversion_value numeric(14,2) not null default 0,
  synced_at timestamptz not null default now(),
  primary key (account_id, campaign_id, date)
);
create index if not exists ad_platform_stats_date_idx on public.ad_platform_stats(date);

-- One-time OAuth "state" values: the callback must bring one back.
create table if not exists public.ad_oauth_states (
  state text primary key check (length(state) between 32 and 128),
  platform text not null check (platform in ('TIKTOK', 'GOOGLE')),
  created_by uuid not null references public.profiles(id),
  return_to text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.marketing_campaigns add column if not exists ad_account_id uuid references public.ad_accounts(id);

alter table public.ad_connections enable row level security;
alter table public.ad_accounts enable row level security;
alter table public.ad_platform_stats enable row level security;
alter table public.ad_oauth_states enable row level security;
revoke all on public.ad_connections, public.ad_accounts, public.ad_platform_stats, public.ad_oauth_states from anon, authenticated;
grant select on public.ad_connections, public.ad_accounts, public.ad_platform_stats to authenticated;
grant all on public.ad_connections, public.ad_accounts, public.ad_platform_stats, public.ad_oauth_states to service_role;
create policy ad_connections_read on public.ad_connections for select to authenticated using ((select public.has_permission('marketing.view')));
create policy ad_accounts_read on public.ad_accounts for select to authenticated using ((select public.has_permission('marketing.view')));
create policy ad_platform_stats_read on public.ad_platform_stats for select to authenticated using ((select public.has_permission('marketing.view')));

-- -----------------------------------------------------------------------------
-- Used by the ad-platforms edge function (service role)
-- -----------------------------------------------------------------------------
create or replace function public._require_system()
returns void
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
end;
$$;

-- Non-secret app details shown on the page (the secrets are in Vault).
create or replace function public.ad_app_set(p_platform text, p jsonb, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key text := lower(p_platform);
  v_value jsonb;
begin
  perform public._require_system();
  if v_key not in ('tiktok', 'google') then
    raise exception 'VALIDATION: unknown platform' using errcode = '22023';
  end if;
  update public.settings set value = jsonb_set(value, array[v_key], coalesce(value -> v_key, '{}'::jsonb) || coalesce(p, '{}'::jsonb)),
    updated_by = p_actor
  where key = 'ad_platforms' returning value into v_value;
  insert into public.audit_logs(actor_id, actor_email, action, entity_type, entity_id, new_values)
  values (p_actor, (select email from public.profiles where id = p_actor), 'ad_app.saved', 'integration', 'ads.' || v_key, p);
  return v_value -> v_key;
end;
$$;

create or replace function public.ad_oauth_state_create(p_platform text, p_state text, p_actor uuid, p_return_to text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._require_system();
  if p_return_to !~ '^https?://[^/]+/admin(/|$|\?)' then
    raise exception 'VALIDATION: invalid return address' using errcode = '22023';
  end if;
  insert into public.ad_oauth_states(state, platform, created_by, return_to, expires_at)
  values (p_state, upper(p_platform), p_actor, p_return_to, now() + interval '15 minutes');
end;
$$;

-- Takes a state once: unknown, used, expired or for another platform → null.
create or replace function public.ad_oauth_state_take(p_platform text, p_state text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.ad_oauth_states;
begin
  perform public._require_system();
  update public.ad_oauth_states set used_at = now()
  where state = p_state and platform = upper(p_platform) and used_at is null and expires_at > now()
  returning * into v_row;
  if not found then
    return null;
  end if;
  return jsonb_build_object('created_by', v_row.created_by, 'return_to', v_row.return_to);
end;
$$;

-- A connection and the ad accounts it can see. New TikTok advertisers are
-- synced straight away; Google accounts wait to be chosen (unless there is
-- only one), as the platform's own flow does.
create or replace function public.ad_connection_save(p_platform text, p jsonb, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_platform text := upper(p_platform);
  v_conn public.ad_connections;
  v_accounts jsonb := coalesce(p -> 'accounts', '[]'::jsonb);
  v_auto boolean;
begin
  perform public._require_system();
  select * into v_conn from public.ad_connections
  where platform = v_platform and status <> 'DISCONNECTED' and lower(external_user) = lower(p ->> 'external_user');
  if found then
    update public.ad_connections set display_name = coalesce(p ->> 'display_name', display_name), token_hint = p ->> 'token_hint',
      status = 'CONNECTED', last_error = null, connected_by = p_actor, connected_at = now()
    where id = v_conn.id returning * into v_conn;
  else
    insert into public.ad_connections(platform, external_user, display_name, token_hint, connected_by)
    values (v_platform, nullif(p ->> 'external_user', ''), p ->> 'display_name', p ->> 'token_hint', p_actor)
    returning * into v_conn;
  end if;

  v_auto := v_platform = 'TIKTOK'
    or (select count(*) from jsonb_array_elements(v_accounts) a where not coalesce((a ->> 'is_manager')::boolean, false)) = 1;
  insert into public.ad_accounts(platform, connection_id, external_id, login_customer_id, name, currency, timezone, is_manager, is_selected)
  select v_platform, v_conn.id, regexp_replace(a ->> 'external_id', '\D', '', 'g'), nullif(regexp_replace(coalesce(a ->> 'login_customer_id', ''), '\D', '', 'g'), ''),
         left(a ->> 'name', 200), upper(a ->> 'currency'), a ->> 'timezone', coalesce((a ->> 'is_manager')::boolean, false),
         v_auto and not coalesce((a ->> 'is_manager')::boolean, false)
  from jsonb_array_elements(v_accounts) a
  where regexp_replace(coalesce(a ->> 'external_id', ''), '\D', '', 'g') ~ '^[0-9]{3,32}$'
  on conflict (platform, external_id) do update set
    connection_id = excluded.connection_id, login_customer_id = excluded.login_customer_id,
    name = coalesce(excluded.name, ad_accounts.name), currency = coalesce(excluded.currency, ad_accounts.currency),
    timezone = coalesce(excluded.timezone, ad_accounts.timezone), is_manager = excluded.is_manager;

  insert into public.audit_logs(actor_id, actor_email, action, entity_type, entity_id, new_values)
  values (p_actor, (select email from public.profiles where id = p_actor), 'ad_connection.connected', 'ad_connection', v_conn.id::text,
          jsonb_build_object('platform', v_platform, 'user', v_conn.external_user, 'accounts', jsonb_array_length(v_accounts)));
  return to_jsonb(v_conn);
end;
$$;

create or replace function public.ad_connection_disconnect(p_id uuid, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._require_system();
  update public.ad_connections set status = 'DISCONNECTED', token_hint = null where id = p_id;
  if not found then
    raise exception 'NOT_FOUND: connection not found' using errcode = 'P0002';
  end if;
  update public.ad_accounts set is_selected = false where connection_id = p_id;
  insert into public.audit_logs(actor_id, actor_email, action, entity_type, entity_id)
  values (p_actor, (select email from public.profiles where id = p_actor), 'ad_connection.disconnected', 'ad_connection', p_id::text);
end;
$$;

create or replace function public.ad_connection_failed(p_id uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._require_system();
  update public.ad_connections set status = 'FAILED', last_error = left(p_error, 500) where id = p_id and status <> 'DISCONNECTED';
end;
$$;

-- Selected accounts to sync (one, or all of a platform), with their connection.
create or replace function public.ad_accounts_for_sync(p_platform text default null, p_account_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._require_system();
  return coalesce((select jsonb_agg(to_jsonb(a) || jsonb_build_object('connection_status', c.status) order by a.created_at)
    from public.ad_accounts a join public.ad_connections c on c.id = a.connection_id
    where c.status <> 'DISCONNECTED'
      and (p_account_id is null and a.is_selected and not a.is_manager
           and (p_platform is null or a.platform = upper(p_platform)) or a.id = p_account_id)), '[]'::jsonb);
end;
$$;

create or replace function public.ad_account_record_sync(p_id uuid, p_status text, p_error text, p_since date, p_until date)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._require_system();
  update public.ad_accounts set last_sync_at = now(), last_sync_status = p_status, last_sync_error = left(p_error, 500),
    last_sync_since = p_since, last_sync_until = p_until
  where id = p_id;
end;
$$;

-- 1 unit of the account's currency in the store currency, VAT included.
create or replace function public._ad_account_factor(p_account public.ad_accounts)
returns numeric
language sql
stable
set search_path = public, pg_temp
as $$
  select (case when upper(coalesce(p_account.currency, 'USD')) = upper(public.setting_text('store', array['currency'], 'BDT')) then 1
               else p_account.usd_rate end) * (1 + p_account.tax_percent / 100)
$$;

-- Daily campaign rows → marketing spend (and through it Advertising in Finance).
create or replace function public._ad_refresh_marketing_spend(p_account_id uuid, p_since date, p_until date)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_acc public.ad_accounts;
  v_rate numeric;
  v_count int := 0;
begin
  select * into v_acc from public.ad_accounts where id = p_account_id;
  v_rate := case when upper(coalesce(v_acc.currency, 'USD')) = upper(public.setting_text('store', array['currency'], 'BDT')) then 1 else v_acc.usd_rate end;
  with agg as (
    select c.id as campaign_uuid, s.date, sum(s.cost) as cost, sum(s.impressions) as impressions, sum(s.clicks) as clicks,
           round(sum(s.conversions))::int as orders, round(sum(s.conversion_value) * v_rate, 2) as revenue
    from public.ad_platform_stats s
    join public.marketing_campaigns c on c.platform = v_acc.platform::public.marketing_platform and c.external_id = s.campaign_id
    where s.account_id = p_account_id and s.date between p_since and p_until
    group by c.id, s.date
  ), up as (
    insert into public.marketing_spend(campaign_id, spend_date, spend, impressions, clicks, orders, revenue, source, external_ref, notes)
    select campaign_uuid, date, cost, least(impressions, 2147483647)::int, least(clicks, 2147483647)::int, greatest(orders, 0), revenue,
           'API', lower(v_acc.platform), 'Synced from ' || initcap(lower(v_acc.platform)) || ' Ads'
    from agg
    on conflict (campaign_id, spend_date) do update set
      spend = excluded.spend, impressions = excluded.impressions, clicks = excluded.clicks,
      orders = excluded.orders, revenue = excluded.revenue, source = 'API', external_ref = excluded.external_ref
    where (marketing_spend.spend, marketing_spend.impressions, marketing_spend.clicks, marketing_spend.orders, marketing_spend.revenue)
      is distinct from (excluded.spend, excluded.impressions, excluded.clicks, excluded.orders, excluded.revenue)
    returning 1
  )
  select count(*) into v_count from up;
  -- Days that no longer have spend on the platform.
  update public.marketing_spend m set spend = 0, impressions = 0, clicks = 0, orders = 0, revenue = 0
  from public.marketing_campaigns c
  where c.id = m.campaign_id and c.ad_account_id = p_account_id and m.source = 'API'
    and m.spend_date between p_since and p_until and m.spend > 0
    and not exists (select 1 from public.ad_platform_stats s where s.account_id = p_account_id and s.campaign_id = c.external_id
                    and s.date = m.spend_date and s.cost > 0);
  return v_count;
end;
$$;

-- One sync window for one account:
--   { account_id, since, until, campaigns: [{id, name, status}],
--     days: [{campaign_id, date, spend, impressions, clicks, conversions, conversion_value}] }
-- Days in the window the platform no longer reports are zeroed, never removed.
create or replace function public.ad_platform_apply_sync(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_acc public.ad_accounts;
  v_since date := (p ->> 'since')::date;
  v_until date := (p ->> 'until')::date;
  v_factor numeric;
  v_campaigns int;
  v_rows int;
  v_zeroed int;
  v_spend_rows int;
begin
  perform public._require_system();
  select * into v_acc from public.ad_accounts where id = (p ->> 'account_id')::uuid;
  if not found then
    raise exception 'NOT_FOUND: ad account not found' using errcode = 'P0002';
  end if;
  if v_since is null or v_until is null or v_until < v_since or v_until - v_since > 120 then
    raise exception 'VALIDATION: sync window must be 1 to 120 days' using errcode = '22023';
  end if;
  v_factor := public._ad_account_factor(v_acc);

  insert into public.marketing_campaigns(platform, name, external_id, utm_campaign, status, source, ad_account_id)
  select v_acc.platform::public.marketing_platform, left(coalesce(nullif(c ->> 'name', ''), 'Campaign ' || (c ->> 'id')), 200), c ->> 'id',
         left(coalesce(nullif(c ->> 'name', ''), c ->> 'id'), 200),
         case when upper(coalesce(c ->> 'status', '')) in ('ENABLE', 'ENABLED', 'ACTIVE', 'CAMPAIGN_STATUS_ENABLE') then 'ACTIVE'
              when upper(coalesce(c ->> 'status', '')) in ('DISABLE', 'PAUSED', 'CAMPAIGN_STATUS_DISABLE') then 'PAUSED'
              else 'ENDED' end::public.campaign_status,
         'API', v_acc.id
  from (select distinct on (x ->> 'id') x from jsonb_array_elements(coalesce(p -> 'campaigns', '[]'::jsonb)) x
        where x ->> 'id' ~ '^[0-9]{1,32}$') d(c)
  on conflict (platform, external_id) do update set
    name = excluded.name, utm_campaign = excluded.utm_campaign, status = excluded.status, ad_account_id = excluded.ad_account_id,
    source = 'API', updated_at = now();
  get diagnostics v_campaigns = row_count;

  -- Campaigns only seen in the numbers (deleted since) keep a name.
  insert into public.marketing_campaigns(platform, name, external_id, utm_campaign, status, source, ad_account_id)
  select distinct v_acc.platform::public.marketing_platform, 'Campaign ' || (d ->> 'campaign_id'), d ->> 'campaign_id', d ->> 'campaign_id',
         'ENDED'::public.campaign_status, 'API'::public.data_source, v_acc.id
  from jsonb_array_elements(coalesce(p -> 'days', '[]'::jsonb)) d
  where d ->> 'campaign_id' ~ '^[0-9]{1,32}$'
  on conflict (platform, external_id) do nothing;

  with rows as (
    select d ->> 'campaign_id' as campaign_id, (d ->> 'date')::date as date,
           sum(greatest(coalesce(nullif(d ->> 'spend', '')::numeric, 0), 0)) as spend,
           sum(coalesce(nullif(d ->> 'impressions', '')::numeric, 0))::bigint as impressions,
           sum(coalesce(nullif(d ->> 'clicks', '')::numeric, 0))::bigint as clicks,
           sum(coalesce(nullif(d ->> 'conversions', '')::numeric, 0)) as conversions,
           sum(coalesce(nullif(d ->> 'conversion_value', '')::numeric, 0)) as conversion_value
    from jsonb_array_elements(coalesce(p -> 'days', '[]'::jsonb)) d
    where d ->> 'campaign_id' ~ '^[0-9]{1,32}$' and (d ->> 'date')::date between v_since and v_until
    group by 1, 2
  )
  insert into public.ad_platform_stats(account_id, campaign_id, date, spend, cost, impressions, clicks, conversions, conversion_value, synced_at)
  select v_acc.id, campaign_id, date, round(spend, 2), round(spend * v_factor, 2), impressions, clicks, round(conversions, 2), round(conversion_value, 2), now()
  from rows
  on conflict (account_id, campaign_id, date) do update set
    spend = excluded.spend, cost = excluded.cost, impressions = excluded.impressions, clicks = excluded.clicks,
    conversions = excluded.conversions, conversion_value = excluded.conversion_value, synced_at = now();
  get diagnostics v_rows = row_count;

  with keep as (
    select distinct d ->> 'campaign_id' as campaign_id, (d ->> 'date')::date as date
    from jsonb_array_elements(coalesce(p -> 'days', '[]'::jsonb)) d
  )
  update public.ad_platform_stats s set spend = 0, cost = 0, impressions = 0, clicks = 0, conversions = 0, conversion_value = 0, synced_at = now()
  where s.account_id = v_acc.id and s.date between v_since and v_until and (s.spend > 0 or s.impressions > 0)
    and not exists (select 1 from keep k where k.campaign_id = s.campaign_id and k.date = s.date);
  get diagnostics v_zeroed = row_count;

  v_spend_rows := public._ad_refresh_marketing_spend(v_acc.id, v_since, v_until);
  return jsonb_build_object('campaigns', v_campaigns, 'rows', v_rows, 'zeroed', v_zeroed, 'spend_days_changed', v_spend_rows,
    'cost', (select coalesce(sum(cost), 0) from public.ad_platform_stats where account_id = v_acc.id and date between v_since and v_until));
end;
$$;

-- -----------------------------------------------------------------------------
-- Staff
-- -----------------------------------------------------------------------------
create or replace function public.ad_platform_overview(p_platform text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_platform text := upper(p_platform);
  v_from date := public._local_date(now()) - 29;
begin
  perform public.require_permission('marketing.view');
  return jsonb_build_object(
    'app', public.get_setting('ad_platforms') -> lower(v_platform),
    'store_currency', public.setting_text('store', array['currency'], 'BDT'),
    'connections', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'external_user', c.external_user, 'display_name', c.display_name,
        'token_hint', c.token_hint, 'status', c.status, 'last_error', c.last_error, 'connected_at', c.connected_at,
        'connected_by_name', (select coalesce(nullif(full_name, ''), email) from public.profiles where id = c.connected_by)) order by c.connected_at desc)
      from public.ad_connections c where c.platform = v_platform and c.status <> 'DISCONNECTED'), '[]'::jsonb),
    'accounts', coalesce((select jsonb_agg(r order by r.is_selected desc, r.name) from (
      select a.id, a.connection_id, a.external_id, a.login_customer_id, a.name, a.currency, a.timezone, a.is_manager, a.is_selected,
             a.usd_rate, a.tax_percent, a.last_sync_at, a.last_sync_status, a.last_sync_error, a.last_sync_since, a.last_sync_until,
             coalesce((select sum(s.cost) from public.ad_platform_stats s where s.account_id = a.id and s.date >= v_from), 0) as cost_30d
      from public.ad_accounts a join public.ad_connections c on c.id = a.connection_id
      where a.platform = v_platform and c.status <> 'DISCONNECTED') r), '[]'::jsonb));
end;
$$;

-- Choose accounts to sync, and their rate / VAT. A new rate re-costs synced days.
create or replace function public.ad_account_update(p_id uuid, p jsonb)
returns public.ad_accounts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old public.ad_accounts;
  v_row public.ad_accounts;
  v_range record;
begin
  perform public.require_permission('marketing.manage');
  select * into v_old from public.ad_accounts where id = p_id for update;
  if not found then
    raise exception 'NOT_FOUND: ad account not found' using errcode = 'P0002';
  end if;
  if v_old.is_manager and coalesce((p ->> 'is_selected')::boolean, false) then
    raise exception 'VALIDATION: a manager account has no campaigns of its own; choose its client accounts' using errcode = '22023';
  end if;
  if (p ? 'usd_rate') and coalesce((p ->> 'usd_rate')::numeric, 0) <= 0 then
    raise exception 'VALIDATION: the rate must be more than 0' using errcode = '22023';
  end if;
  if (p ? 'tax_percent') and ((p ->> 'tax_percent')::numeric < 0 or (p ->> 'tax_percent')::numeric > 100) then
    raise exception 'VALIDATION: VAT must be between 0 and 100%%' using errcode = '22023';
  end if;
  update public.ad_accounts set
    is_selected = coalesce((p ->> 'is_selected')::boolean, is_selected),
    usd_rate = coalesce((p ->> 'usd_rate')::numeric, usd_rate),
    tax_percent = coalesce((p ->> 'tax_percent')::numeric, tax_percent)
  where id = p_id returning * into v_row;

  if (v_old.usd_rate, v_old.tax_percent) is distinct from (v_row.usd_rate, v_row.tax_percent) then
    update public.ad_platform_stats set cost = round(spend * public._ad_account_factor(v_row), 2) where account_id = p_id;
    select min(date) as since, max(date) as until into v_range from public.ad_platform_stats where account_id = p_id;
    if v_range.since is not null then
      perform public._ad_refresh_marketing_spend(p_id, v_range.since, v_range.until);
    end if;
  end if;
  perform public.log_audit('ad_account.updated', 'ad_account', p_id::text, to_jsonb(v_old), to_jsonb(v_row), '{}'::jsonb);
  return v_row;
end;
$$;

-- Campaigns with the platform's numbers next to the orders their links brought
-- ("actual results"), plus daily spend per account (expenses).
create or replace function public.ad_platform_report(p_platform text, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_platform text := upper(p_platform);
  v_tz text := public.store_timezone();
begin
  perform public.require_permission('marketing.view');
  return jsonb_build_object(
    'campaigns', coalesce((
      with st as (
        select s.campaign_id, sum(s.cost) as cost, sum(s.spend) as spend, sum(s.impressions) as impressions, sum(s.clicks) as clicks,
               sum(s.conversions) as conversions, sum(s.conversion_value) as conversion_value
        from public.ad_platform_stats s join public.ad_accounts a on a.id = s.account_id
        where a.platform = v_platform and s.date between p_from and p_to
        group by s.campaign_id
      ), ord as (
        select f.campaign_key as id, count(*) as orders,
               count(*) filter (where f.status in ('DELIVERED', 'PARTIALLY_DELIVERED')) as delivered,
               count(*) filter (where f.status in ('CANCELLED', 'REJECTED_FRAUD')) as cancelled,
               count(*) filter (where f.status in ('RETURN_REQUESTED', 'RETURNING', 'RETURNED')) as returned,
               coalesce(sum(f.total_amount) filter (where f.status in ('DELIVERED', 'PARTIALLY_DELIVERED')), 0) as revenue
        from public.order_attribution_facts f
        where (f.created_at at time zone v_tz)::date between p_from and p_to and f.campaign_key is not null
        group by f.campaign_key
      )
      select jsonb_agg(jsonb_build_object(
        'id', c.external_id, 'name', c.name, 'status', c.status, 'account', a.name, 'account_id', a.id,
        'cost', coalesce(st.cost, 0), 'spend_account', coalesce(st.spend, 0), 'currency', a.currency,
        'impressions', coalesce(st.impressions, 0), 'clicks', coalesce(st.clicks, 0),
        'ctr', case when st.impressions > 0 then round(100.0 * st.clicks / st.impressions, 2) end,
        'cpc', case when st.clicks > 0 then round(st.cost / st.clicks, 2) end,
        'conversions', coalesce(st.conversions, 0), 'conversion_value', coalesce(st.conversion_value, 0),
        'orders', coalesce(ord.orders, 0), 'delivered', coalesce(ord.delivered, 0), 'cancelled', coalesce(ord.cancelled, 0),
        'returned', coalesce(ord.returned, 0), 'revenue', coalesce(ord.revenue, 0),
        'cost_per_order', case when ord.orders > 0 and st.cost > 0 then round(st.cost / ord.orders, 2) end,
        'roas', case when st.cost > 0 then round(coalesce(ord.revenue, 0) / st.cost, 2) end)
        order by coalesce(st.cost, 0) desc, coalesce(ord.orders, 0) desc, c.name)
      from public.marketing_campaigns c
      join public.ad_accounts a on a.id = c.ad_account_id
      left join st on st.campaign_id = c.external_id
      left join ord on ord.id = c.external_id
      where c.platform = v_platform::public.marketing_platform and c.source = 'API'
        and (st.campaign_id is not null or ord.id is not null or c.status = 'ACTIVE')), '[]'::jsonb),
    'days', coalesce((
      select jsonb_agg(jsonb_build_object('date', d.date, 'account', d.account, 'account_id', d.account_id, 'cost', d.cost, 'spend_account', d.spend,
        'currency', d.currency, 'impressions', d.impressions, 'clicks', d.clicks, 'conversions', d.conversions) order by d.date desc, d.account)
      from (
        select s.date, a.name as account, a.id as account_id, a.currency, sum(s.cost) as cost, sum(s.spend) as spend,
               sum(s.impressions) as impressions, sum(s.clicks) as clicks, sum(s.conversions) as conversions
        from public.ad_platform_stats s join public.ad_accounts a on a.id = s.account_id
        where a.platform = v_platform and s.date between p_from and p_to
        group by s.date, a.id, a.name, a.currency
        having sum(s.cost) > 0 or sum(s.impressions) > 0) d), '[]'::jsonb));
end;
$$;

-- -----------------------------------------------------------------------------
-- Attribution report: TikTok / Google spend lines carry the platform's
-- campaign ID, the key orders get from the campaign_id their link carried.
-- -----------------------------------------------------------------------------
create or replace view public.ad_spend_facts
with (security_invoker = true) as
select
  i.date,
  case i.platform when 'instagram' then 'Instagram Ads' when 'messenger' then 'Messenger Ads' else 'Facebook Ads' end as source,
  i.campaign_id as campaign_key,
  coalesce(mc.name, 'Campaign ' || i.campaign_id) as campaign_name,
  i.adset_id as adset_key,
  coalesce(ms.name, 'Ad set ' || i.adset_id) as adset_name,
  i.ad_id as ad_key,
  coalesce(ma.name, 'Ad ' || i.ad_id) as ad_name,
  i.cost,
  i.impressions,
  i.link_clicks as clicks,
  i.purchases
from public.meta_ad_insights i
left join public.meta_campaigns mc on mc.id = i.campaign_id
left join public.meta_adsets ms on ms.id = i.adset_id
left join public.meta_ads ma on ma.id = i.ad_id
where i.cost > 0 or i.impressions > 0
union all
select
  s.spend_date,
  case c.platform when 'GOOGLE' then 'Google Ads' when 'TIKTOK' then 'TikTok Ads' when 'META' then 'Facebook Ads' else 'Other ads' end,
  case when c.source = 'API' then c.external_id else 'mc:' || c.id end, c.name, null, null, null, null,
  s.spend, coalesce(s.impressions, 0), coalesce(s.clicks, 0), s.orders
from public.marketing_spend s
join public.marketing_campaigns c on c.id = s.campaign_id
where not (c.platform = 'META' and c.source = 'API');

-- -----------------------------------------------------------------------------
-- Access
-- -----------------------------------------------------------------------------
revoke all on function public._require_system(), public.ad_app_set(text, jsonb, uuid),
  public.ad_oauth_state_create(text, text, uuid, text), public.ad_oauth_state_take(text, text),
  public.ad_connection_save(text, jsonb, uuid), public.ad_connection_disconnect(uuid, uuid), public.ad_connection_failed(uuid, text),
  public.ad_accounts_for_sync(text, uuid), public.ad_account_record_sync(uuid, text, text, date, date),
  public._ad_account_factor(public.ad_accounts), public._ad_refresh_marketing_spend(uuid, date, date),
  public.ad_platform_apply_sync(jsonb), public.ad_platform_overview(text), public.ad_account_update(uuid, jsonb),
  public.ad_platform_report(text, date, date)
from public, anon, authenticated;
grant execute on function public.ad_platform_overview(text), public.ad_account_update(uuid, jsonb), public.ad_platform_report(text, date, date)
to authenticated;
grant execute on function public.ad_app_set(text, jsonb, uuid), public.ad_oauth_state_create(text, text, uuid, text),
  public.ad_oauth_state_take(text, text), public.ad_connection_save(text, jsonb, uuid), public.ad_connection_disconnect(uuid, uuid),
  public.ad_connection_failed(uuid, text), public.ad_accounts_for_sync(text, uuid), public.ad_account_record_sync(uuid, text, text, date, date),
  public.ad_platform_apply_sync(jsonb)
to service_role;
