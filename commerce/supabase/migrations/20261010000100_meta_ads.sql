-- =============================================================================
-- Meta Ads sync, marketing attribution report, finance cost breakdown
--   * one Meta ad account connected from the admin (access token in Vault);
--     campaigns, ad sets, ads and daily insights per ad and placement
--     (Facebook / Instagram / Messenger / Audience Network) are synced
--   * spend is converted to the store currency (exchange rate + VAT/fees %)
--     and flows into Marketing → campaign spend → Finance (Advertising)
--   * orders are matched to campaigns / ad sets / ads only through the ids
--     their tracked link carried (or an exact campaign name); everything
--     else stays Unknown — spend is never spread over unattributed orders
--   * payment gateway fees (a % per gateway) are posted to Finance
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Settings, finance category
-- -----------------------------------------------------------------------------
insert into public.settings(key, is_public, description, value) values
('meta_ads', false, 'Meta Ads connection (access token lives in Vault) and spend conversion', jsonb_build_object(
  'connected', false,
  'ad_account_id', null,
  'ad_account_name', null,
  'account_currency', null,
  'account_timezone', null,
  'page_id', null,
  'page_name', null,
  'instagram_id', null,
  'instagram_username', null,
  'hint', null,
  'exchange_rate', 1,
  'tax_percent', 0,
  'connected_at', null,
  'last_sync_at', null,
  'last_sync_status', null,
  'last_sync_error', null,
  'last_sync_since', null,
  'last_sync_until', null
))
on conflict (key) do nothing;

insert into public.finance_categories(code, name, type, pnl_group, is_system, allow_manual, sort_order, description) values
  ('PAYMENT_FEES', 'Payment gateway fees', 'EXPENSE', 'OPERATING_EXPENSE', true, true, 145,
   'Fees on online payments, posted automatically from the % set per gateway in Settings → Payments')
on conflict (code) do nothing;

-- -----------------------------------------------------------------------------
-- Synced Meta structure and insights
-- -----------------------------------------------------------------------------
create table public.meta_campaigns (
  id text primary key check (id ~ '^[0-9]{1,32}$'),
  account_id text,
  name text not null,
  status text,
  effective_status text,
  objective text,
  daily_budget numeric(14,2),
  lifetime_budget numeric(14,2),
  start_time timestamptz,
  stop_time timestamptz,
  created_time timestamptz,
  updated_time timestamptz,
  marketing_campaign_id uuid references public.marketing_campaigns(id) on delete set null,
  synced_at timestamptz not null default now()
);

create table public.meta_adsets (
  id text primary key check (id ~ '^[0-9]{1,32}$'),
  campaign_id text,
  name text not null,
  status text,
  effective_status text,
  daily_budget numeric(14,2),
  lifetime_budget numeric(14,2),
  start_time timestamptz,
  end_time timestamptz,
  synced_at timestamptz not null default now()
);
create index meta_adsets_campaign_idx on public.meta_adsets(campaign_id);

create table public.meta_ads (
  id text primary key check (id ~ '^[0-9]{1,32}$'),
  adset_id text,
  campaign_id text,
  name text not null,
  status text,
  effective_status text,
  creative_id text,
  creative_name text,
  thumbnail_url text,
  title text,
  body text,
  synced_at timestamptz not null default now()
);
create index meta_ads_adset_idx on public.meta_ads(adset_id);
create index meta_ads_campaign_idx on public.meta_ads(campaign_id);

-- One row per ad, day and placement. spend / purchase_value are in the ad
-- account currency; cost is what it cost the store (converted, incl. VAT/fees).
create table public.meta_ad_insights (
  ad_id text not null,
  date date not null,
  platform text not null check (platform in ('facebook', 'instagram', 'messenger', 'audience_network', 'unknown')),
  campaign_id text,
  adset_id text,
  spend numeric(14,2) not null default 0 check (spend >= 0),
  cost numeric(14,2) not null default 0 check (cost >= 0),
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  link_clicks bigint not null default 0,
  purchases int not null default 0,
  purchase_value numeric(14,2) not null default 0,
  synced_at timestamptz not null default now(),
  primary key (ad_id, date, platform)
);
create index meta_ad_insights_date_idx on public.meta_ad_insights(date);
create index meta_ad_insights_campaign_idx on public.meta_ad_insights(campaign_id, date);
create index meta_ad_insights_adset_idx on public.meta_ad_insights(adset_id, date);

alter table public.meta_campaigns enable row level security;
alter table public.meta_adsets enable row level security;
alter table public.meta_ads enable row level security;
alter table public.meta_ad_insights enable row level security;
revoke all on public.meta_campaigns, public.meta_adsets, public.meta_ads, public.meta_ad_insights from anon, authenticated;
grant select on public.meta_campaigns, public.meta_adsets, public.meta_ads, public.meta_ad_insights to authenticated;
grant all on public.meta_campaigns, public.meta_adsets, public.meta_ads, public.meta_ad_insights to service_role;
create policy meta_campaigns_read on public.meta_campaigns for select to authenticated
  using ((select public.has_permission('marketing.view')));
create policy meta_adsets_read on public.meta_adsets for select to authenticated
  using ((select public.has_permission('marketing.view')));
create policy meta_ads_read on public.meta_ads for select to authenticated
  using ((select public.has_permission('marketing.view')));
create policy meta_ad_insights_read on public.meta_ad_insights for select to authenticated
  using ((select public.has_permission('marketing.view')));

-- -----------------------------------------------------------------------------
-- Sync (meta-ads edge function, service role)
-- -----------------------------------------------------------------------------
create or replace function public._meta_cost(p_spend numeric)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select round(coalesce(p_spend, 0)
    * coalesce(nullif(public.setting_numeric('meta_ads', array['exchange_rate'], 1), 0), 1)
    * (1 + greatest(public.setting_numeric('meta_ads', array['tax_percent'], 0), 0) / 100), 2)
$$;

-- Campaign-day spend for Marketing (and through it Finance). Upserts only:
-- a day that lost its spend is set to 0, which posts the correction.
create or replace function public._meta_refresh_marketing_spend(p_campaign_ids text[], p_since date, p_until date)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rate numeric := coalesce(nullif(public.setting_numeric('meta_ads', array['exchange_rate'], 1), 0), 1);
  v_count int := 0;
begin
  -- Each Meta campaign has a marketing campaign (platform META, external id).
  insert into public.marketing_campaigns(platform, name, external_id, utm_campaign, status, start_date, end_date, source)
  select 'META', left(mc.name, 200), mc.id, left(mc.name, 200),
         case when coalesce(mc.effective_status, mc.status) = 'ACTIVE' then 'ACTIVE'
              when coalesce(mc.effective_status, mc.status) in ('PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED') then 'PAUSED'
              else 'ENDED' end::public.campaign_status,
         (mc.start_time at time zone public.store_timezone())::date,
         (mc.stop_time at time zone public.store_timezone())::date,
         'API'
  from public.meta_campaigns mc
  where mc.id = any(p_campaign_ids)
  on conflict (platform, external_id) do update set
    name = excluded.name, utm_campaign = excluded.utm_campaign, status = excluded.status,
    start_date = excluded.start_date, end_date = excluded.end_date, updated_at = now();

  update public.meta_campaigns mc set marketing_campaign_id = c.id
  from public.marketing_campaigns c
  where c.platform = 'META' and c.external_id = mc.id and mc.id = any(p_campaign_ids)
    and mc.marketing_campaign_id is distinct from c.id;

  with agg as (
    select c.id as campaign_uuid, i.date,
           sum(i.cost) as cost, sum(i.impressions) as impressions, sum(i.link_clicks) as clicks,
           sum(i.purchases) as purchases, round(sum(i.purchase_value) * v_rate, 2) as revenue
    from public.meta_ad_insights i
    join public.marketing_campaigns c on c.platform = 'META' and c.external_id = i.campaign_id
    where i.campaign_id = any(p_campaign_ids) and i.date between p_since and p_until
    group by c.id, i.date
  ), up as (
    insert into public.marketing_spend(campaign_id, spend_date, spend, impressions, clicks, orders, revenue, source, external_ref, notes)
    select campaign_uuid, date, cost, least(impressions, 2147483647)::int, least(clicks, 2147483647)::int, purchases, revenue,
           'API', 'meta', 'Synced from Meta Ads'
    from agg
    on conflict (campaign_id, spend_date) do update set
      spend = excluded.spend, impressions = excluded.impressions, clicks = excluded.clicks,
      orders = excluded.orders, revenue = excluded.revenue, source = 'API', external_ref = 'meta'
    where (marketing_spend.spend, marketing_spend.impressions, marketing_spend.clicks, marketing_spend.orders, marketing_spend.revenue)
      is distinct from (excluded.spend, excluded.impressions, excluded.clicks, excluded.orders, excluded.revenue)
    returning 1
  )
  select count(*) into v_count from up;

  -- Synced days that no longer have any spend in Meta.
  update public.marketing_spend s set spend = 0, impressions = 0, clicks = 0, orders = 0, revenue = 0
  from public.marketing_campaigns c
  where c.id = s.campaign_id and c.platform = 'META' and c.external_id = any(p_campaign_ids)
    and s.source = 'API' and s.spend_date between p_since and p_until and s.spend > 0
    and not exists (select 1 from public.meta_ad_insights i
                    where i.campaign_id = c.external_id and i.date = s.spend_date and i.cost > 0);
  return v_count;
end;
$$;

-- Applies one sync: structure (campaigns, ad sets, ads) and the insights for
-- [since, until]. With "complete": true, insight rows in that window that
-- Meta no longer reports are zeroed (never deleted).
create or replace function public.meta_ads_apply_sync(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_since date := (p ->> 'since')::date;
  v_until date := (p ->> 'until')::date;
  v_account text := nullif(p ->> 'account_id', '');
  v_campaigns int;
  v_adsets int;
  v_ads int;
  v_insights int;
  v_zeroed int := 0;
  v_ids text[];
  v_spend_rows int;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if v_since is null or v_until is null or v_until < v_since or v_until - v_since > 120 then
    raise exception 'VALIDATION: sync window must be 1 to 120 days' using errcode = '22023';
  end if;

  insert into public.meta_campaigns(id, account_id, name, status, effective_status, objective, daily_budget, lifetime_budget,
    start_time, stop_time, created_time, updated_time, synced_at)
  select c ->> 'id', v_account, left(coalesce(nullif(c ->> 'name', ''), 'Campaign ' || (c ->> 'id')), 300),
         c ->> 'status', c ->> 'effective_status', c ->> 'objective',
         nullif(c ->> 'daily_budget', '')::numeric / 100, nullif(c ->> 'lifetime_budget', '')::numeric / 100,
         nullif(c ->> 'start_time', '')::timestamptz, nullif(c ->> 'stop_time', '')::timestamptz,
         nullif(c ->> 'created_time', '')::timestamptz, nullif(c ->> 'updated_time', '')::timestamptz, now()
  from jsonb_array_elements(coalesce(p -> 'campaigns', '[]'::jsonb)) c
  where c ->> 'id' ~ '^[0-9]{1,32}$'
  on conflict (id) do update set
    account_id = coalesce(excluded.account_id, meta_campaigns.account_id), name = excluded.name, status = excluded.status,
    effective_status = excluded.effective_status, objective = excluded.objective, daily_budget = excluded.daily_budget,
    lifetime_budget = excluded.lifetime_budget, start_time = excluded.start_time, stop_time = excluded.stop_time,
    created_time = excluded.created_time, updated_time = excluded.updated_time, synced_at = now();
  get diagnostics v_campaigns = row_count;

  insert into public.meta_adsets(id, campaign_id, name, status, effective_status, daily_budget, lifetime_budget, start_time, end_time, synced_at)
  select s ->> 'id', s ->> 'campaign_id', left(coalesce(nullif(s ->> 'name', ''), 'Ad set ' || (s ->> 'id')), 300),
         s ->> 'status', s ->> 'effective_status',
         nullif(s ->> 'daily_budget', '')::numeric / 100, nullif(s ->> 'lifetime_budget', '')::numeric / 100,
         nullif(s ->> 'start_time', '')::timestamptz, nullif(s ->> 'end_time', '')::timestamptz, now()
  from jsonb_array_elements(coalesce(p -> 'adsets', '[]'::jsonb)) s
  where s ->> 'id' ~ '^[0-9]{1,32}$'
  on conflict (id) do update set
    campaign_id = excluded.campaign_id, name = excluded.name, status = excluded.status, effective_status = excluded.effective_status,
    daily_budget = excluded.daily_budget, lifetime_budget = excluded.lifetime_budget, start_time = excluded.start_time,
    end_time = excluded.end_time, synced_at = now();
  get diagnostics v_adsets = row_count;

  insert into public.meta_ads(id, adset_id, campaign_id, name, status, effective_status, creative_id, creative_name,
    thumbnail_url, title, body, synced_at)
  select a ->> 'id', a ->> 'adset_id', a ->> 'campaign_id', left(coalesce(nullif(a ->> 'name', ''), 'Ad ' || (a ->> 'id')), 300),
         a ->> 'status', a ->> 'effective_status', a #>> '{creative,id}', left(a #>> '{creative,name}', 300),
         case when a #>> '{creative,thumbnail_url}' ~ '^https://' then left(a #>> '{creative,thumbnail_url}', 2000) end,
         left(a #>> '{creative,title}', 300), left(a #>> '{creative,body}', 2000), now()
  from jsonb_array_elements(coalesce(p -> 'ads', '[]'::jsonb)) a
  where a ->> 'id' ~ '^[0-9]{1,32}$'
  on conflict (id) do update set
    adset_id = excluded.adset_id, campaign_id = excluded.campaign_id, name = excluded.name, status = excluded.status,
    effective_status = excluded.effective_status, creative_id = excluded.creative_id, creative_name = excluded.creative_name,
    thumbnail_url = excluded.thumbnail_url, title = excluded.title, body = excluded.body, synced_at = now();
  get diagnostics v_ads = row_count;

  -- Archived or deleted items only appear in insights: keep their names.
  insert into public.meta_campaigns(id, account_id, name)
  select distinct on (i ->> 'campaign_id') i ->> 'campaign_id', v_account,
         left(coalesce(nullif(i ->> 'campaign_name', ''), 'Campaign ' || (i ->> 'campaign_id')), 300)
  from jsonb_array_elements(coalesce(p -> 'insights', '[]'::jsonb)) i
  where i ->> 'campaign_id' ~ '^[0-9]{1,32}$'
  on conflict (id) do nothing;
  insert into public.meta_adsets(id, campaign_id, name)
  select distinct on (i ->> 'adset_id') i ->> 'adset_id', i ->> 'campaign_id',
         left(coalesce(nullif(i ->> 'adset_name', ''), 'Ad set ' || (i ->> 'adset_id')), 300)
  from jsonb_array_elements(coalesce(p -> 'insights', '[]'::jsonb)) i
  where i ->> 'adset_id' ~ '^[0-9]{1,32}$'
  on conflict (id) do nothing;
  insert into public.meta_ads(id, adset_id, campaign_id, name)
  select distinct on (i ->> 'ad_id') i ->> 'ad_id', i ->> 'adset_id', i ->> 'campaign_id',
         left(coalesce(nullif(i ->> 'ad_name', ''), 'Ad ' || (i ->> 'ad_id')), 300)
  from jsonb_array_elements(coalesce(p -> 'insights', '[]'::jsonb)) i
  where i ->> 'ad_id' ~ '^[0-9]{1,32}$'
  on conflict (id) do nothing;

  with rows as (
    select i ->> 'ad_id' as ad_id, (i ->> 'date')::date as date,
           case when i ->> 'platform' in ('facebook', 'instagram', 'messenger', 'audience_network') then i ->> 'platform' else 'unknown' end as platform,
           i ->> 'campaign_id' as campaign_id, i ->> 'adset_id' as adset_id,
           greatest(coalesce(nullif(i ->> 'spend', '')::numeric, 0), 0) as spend,
           coalesce(nullif(i ->> 'impressions', '')::bigint, 0) as impressions,
           coalesce(nullif(i ->> 'clicks', '')::bigint, 0) as clicks,
           coalesce(nullif(i ->> 'link_clicks', '')::bigint, 0) as link_clicks,
           coalesce(nullif(i ->> 'purchases', '')::numeric, 0)::int as purchases,
           coalesce(nullif(i ->> 'purchase_value', '')::numeric, 0) as purchase_value
    from jsonb_array_elements(coalesce(p -> 'insights', '[]'::jsonb)) i
    where i ->> 'ad_id' ~ '^[0-9]{1,32}$' and (i ->> 'date')::date between v_since and v_until
  ), merged as (
    -- Meta can split one day into several rows; add them up.
    select ad_id, date, platform, max(campaign_id) as campaign_id, max(adset_id) as adset_id, sum(spend) as spend,
           sum(impressions) as impressions, sum(clicks) as clicks, sum(link_clicks) as link_clicks,
           sum(purchases) as purchases, sum(purchase_value) as purchase_value
    from rows group by ad_id, date, platform
  )
  insert into public.meta_ad_insights(ad_id, date, platform, campaign_id, adset_id, spend, cost, impressions, clicks, link_clicks,
    purchases, purchase_value, synced_at)
  select ad_id, date, platform, campaign_id, adset_id, round(spend, 2), public._meta_cost(spend), impressions, clicks, link_clicks,
         purchases, round(purchase_value, 2), now()
  from merged
  on conflict (ad_id, date, platform) do update set
    campaign_id = excluded.campaign_id, adset_id = excluded.adset_id, spend = excluded.spend, cost = excluded.cost,
    impressions = excluded.impressions, clicks = excluded.clicks, link_clicks = excluded.link_clicks,
    purchases = excluded.purchases, purchase_value = excluded.purchase_value, synced_at = now();
  get diagnostics v_insights = row_count;

  if coalesce((p ->> 'complete')::boolean, false) then
    with keep as (
      select distinct x ->> 'ad_id' as ad_id, (x ->> 'date')::date as date,
             case when x ->> 'platform' in ('facebook', 'instagram', 'messenger', 'audience_network') then x ->> 'platform' else 'unknown' end as platform
      from jsonb_array_elements(coalesce(p -> 'insights', '[]'::jsonb)) x
    )
    update public.meta_ad_insights i set spend = 0, cost = 0, impressions = 0, clicks = 0, link_clicks = 0, purchases = 0,
      purchase_value = 0, synced_at = now()
    where i.date between v_since and v_until and (i.spend > 0 or i.impressions > 0)
      and not exists (select 1 from keep k where k.ad_id = i.ad_id and k.date = i.date and k.platform = i.platform);
    get diagnostics v_zeroed = row_count;
  end if;

  select array_agg(distinct campaign_id) into v_ids from (
    select campaign_id from public.meta_ad_insights where date between v_since and v_until and campaign_id is not null
    union select c ->> 'id' from jsonb_array_elements(coalesce(p -> 'campaigns', '[]'::jsonb)) c where c ->> 'id' ~ '^[0-9]{1,32}$'
  ) x;
  v_spend_rows := public._meta_refresh_marketing_spend(coalesce(v_ids, '{}'), v_since, v_until);

  return jsonb_build_object('campaigns', v_campaigns, 'adsets', v_adsets, 'ads', v_ads, 'insights', v_insights,
    'zeroed', v_zeroed, 'spend_days_changed', v_spend_rows,
    'cost', (select coalesce(sum(cost), 0) from public.meta_ad_insights where date between v_since and v_until));
end;
$$;

-- Connection state, saved by the meta-ads edge function after the token was tested.
create or replace function public.meta_ads_set_connection(p jsonb, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_value jsonb;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p is null then
    update public.settings set value = value || jsonb_build_object('connected', false, 'hint', null, 'connected_at', null),
      updated_by = p_actor
    where key = 'meta_ads' returning value into v_value;
  else
    update public.settings set value = value || jsonb_build_object(
      'connected', true,
      'ad_account_id', p ->> 'ad_account_id', 'ad_account_name', p ->> 'ad_account_name',
      'account_currency', p ->> 'account_currency', 'account_timezone', p ->> 'account_timezone',
      'page_id', p ->> 'page_id', 'page_name', p ->> 'page_name',
      'instagram_id', p ->> 'instagram_id', 'instagram_username', p ->> 'instagram_username',
      'hint', p ->> 'hint', 'connected_at', now(), 'last_sync_error', null),
      updated_by = p_actor
    where key = 'meta_ads' returning value into v_value;
  end if;
  insert into public.audit_logs(actor_id, actor_email, action, entity_type, entity_id, metadata)
  values (p_actor, (select email from public.profiles where id = p_actor),
          case when p is null then 'meta_ads.disconnected' else 'meta_ads.connected' end, 'integration', 'meta_ads',
          coalesce(p, '{}'::jsonb) - 'access_token');
  return v_value;
end;
$$;

create or replace function public.meta_ads_record_sync(p_status text, p_error text, p_since date, p_until date)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.settings set value = value || jsonb_build_object(
    'last_sync_at', now(), 'last_sync_status', p_status, 'last_sync_error', left(p_error, 500),
    'last_sync_since', p_since, 'last_sync_until', p_until)
    || case when p_status = 'TOKEN_INVALID' then jsonb_build_object('connected', false) else '{}'::jsonb end
  where key = 'meta_ads';
end;
$$;

create or replace function public.meta_ads_config()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return public.get_setting('meta_ads');
end;
$$;

-- Connection state for the Marketing page (no secrets are kept in it).
create or replace function public.meta_ads_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('marketing.view');
  return public.get_setting('meta_ads');
end;
$$;

-- Staff: exchange rate and VAT / card fee %. Recalculates every synced day,
-- so Marketing and Finance get one correction per changed day.
create or replace function public.meta_ads_update_settings(p_exchange_rate numeric default null, p_tax_percent numeric default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_value jsonb;
  v_ids text[];
  v_range record;
begin
  perform public.require_permission('marketing.manage');
  if p_exchange_rate is not null and (p_exchange_rate <= 0 or p_exchange_rate > 100000) then
    raise exception 'VALIDATION: the exchange rate must be more than 0' using errcode = '22023';
  end if;
  if p_tax_percent is not null and (p_tax_percent < 0 or p_tax_percent > 100) then
    raise exception 'VALIDATION: VAT and fees must be between 0 and 100%%' using errcode = '22023';
  end if;
  update public.settings set value = value
    || case when p_exchange_rate is null then '{}'::jsonb else jsonb_build_object('exchange_rate', p_exchange_rate) end
    || case when p_tax_percent is null then '{}'::jsonb else jsonb_build_object('tax_percent', p_tax_percent) end,
    updated_by = auth.uid()
  where key = 'meta_ads' returning value into v_value;

  update public.meta_ad_insights set cost = public._meta_cost(spend) where cost is distinct from public._meta_cost(spend);
  select min(date) as since, max(date) as until into v_range from public.meta_ad_insights;
  select array_agg(distinct campaign_id) into v_ids from public.meta_ad_insights where campaign_id is not null;
  if v_range.since is not null then
    perform public._meta_refresh_marketing_spend(coalesce(v_ids, '{}'), v_range.since, v_range.until);
  end if;
  perform public.log_audit('meta_ads.settings_changed', 'settings', 'meta_ads', null,
    jsonb_build_object('exchange_rate', p_exchange_rate, 'tax_percent', p_tax_percent));
  return v_value;
end;
$$;

-- -----------------------------------------------------------------------------
-- Reports
-- -----------------------------------------------------------------------------
-- How an order is attributed for reporting: source label, medium and the
-- campaign / ad set / ad it can be tied to (by id, or an exact campaign name).
create or replace view public.order_attribution_facts
with (security_invoker = true) as
select
  o.id as order_id,
  o.status,
  o.created_at,
  o.total_amount,
  o.confirmed_at,
  o.shipped_at,
  o.delivered_at,
  coalesce(a.source, 'Unknown') as source,
  coalesce(a.medium, 'Unknown') as medium,
  a.channel,
  a.is_paid,
  coalesce(a.campaign_id, mcn.id, case when mk.id is not null then 'mc:' || mk.id end) as campaign_key,
  coalesce(mc.name, mcn.name, mk.name, a.campaign) as campaign_name,
  a.adset_id as adset_key,
  coalesce(ms.name, a.adset) as adset_name,
  a.ad_id as ad_key,
  coalesce(ma.name, a.ad) as ad_name
from public.orders o
left join public.order_attributions a on a.order_id = o.id
left join public.meta_campaigns mc on mc.id = a.campaign_id
left join lateral (
  select m.id, m.name from public.meta_campaigns m
  where a.campaign_id is null and a.campaign is not null and lower(m.name) = lower(a.campaign)
  order by m.synced_at desc limit 1) mcn on true
left join lateral (
  select c.id, c.name from public.marketing_campaigns c
  where a.campaign_id is null and mcn.id is null and a.campaign is not null and c.source <> 'API'
    and lower(coalesce(c.utm_campaign, c.name)) = lower(a.campaign)
  order by c.created_at limit 1) mk on true
left join public.meta_adsets ms on ms.id = a.adset_id
left join public.meta_ads ma on ma.id = a.ad_id;

-- Ad spend in the store currency, by day, with the same keys orders use.
-- Meta placements map to the same source labels the storefront assigns.
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
  'mc:' || c.id, c.name, null, null, null, null,
  s.spend, coalesce(s.impressions, 0), coalesce(s.clicks, 0), s.orders
from public.marketing_spend s
join public.marketing_campaigns c on c.id = s.campaign_id
where c.source <> 'API';

-- Sales and costs grouped by source, medium, campaign, ad set, ad, date or
-- product, for orders placed in the period. Spend is shown only where it can
-- be tied to the group; ROAS uses delivered revenue.
create or replace function public.report_attribution(p_from date, p_to date, p_group text default 'source', p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz text := public.store_timezone();
  v_f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_source text := nullif(v_f ->> 'source', '');
  v_medium text := nullif(v_f ->> 'medium', '');
  v_campaign text := nullif(v_f ->> 'campaign', '');
  v_adset text := nullif(v_f ->> 'adset', '');
  v_ad text := nullif(v_f ->> 'ad', '');
  v_product uuid := nullif(v_f ->> 'product', '')::uuid;
  v_status text := nullif(v_f ->> 'status', '');
  v_spend_ok boolean := v_product is null and coalesce(p_group, 'source') <> 'product'
                        and (v_medium is null or v_medium = 'Paid');
  v_result jsonb;
begin
  perform public.require_permission('marketing.view');
  if p_group not in ('source', 'medium', 'campaign', 'adset', 'ad', 'date', 'product') then
    raise exception 'VALIDATION: unknown grouping %', p_group using errcode = '22023';
  end if;

  with o as (
    select f.*, (f.created_at at time zone v_tz)::date as d,
      f.status in ('DELIVERED', 'PARTIALLY_DELIVERED') or (f.delivered_at is not null and f.status not in ('RETURNING', 'RETURNED', 'LOST')) as is_delivered,
      f.status in ('CANCELLED', 'REJECTED_FRAUD') as is_cancelled,
      f.status in ('RETURN_REQUESTED', 'RETURNING', 'RETURNED') as is_returned
    from public.order_attribution_facts f
    where (f.created_at at time zone v_tz)::date between p_from and p_to
      and (v_source is null or f.source = v_source)
      and (v_medium is null or f.medium = v_medium)
      and (v_campaign is null or f.campaign_key = v_campaign)
      and (v_adset is null or f.adset_key = v_adset)
      and (v_ad is null or f.ad_key = v_ad)
      and (v_product is null or exists (select 1 from public.order_items oi where oi.order_id = f.order_id and oi.product_id = v_product))
      and (v_status is null
           or (v_status = 'delivered' and f.status in ('DELIVERED', 'PARTIALLY_DELIVERED'))
           or (v_status = 'cancelled' and f.status in ('CANCELLED', 'REJECTED_FRAUD'))
           or (v_status = 'returned' and f.status in ('RETURN_REQUESTED', 'RETURNING', 'RETURNED'))
           or (v_status = 'open' and f.status not in ('DELIVERED', 'PARTIALLY_DELIVERED', 'CANCELLED', 'REJECTED_FRAUD',
                                                      'RETURN_REQUESTED', 'RETURNING', 'RETURNED', 'LOST'))
           or f.status::text = v_status)
  ), costs as (
    select ft.order_id,
           sum(ft.amount) filter (where c.code in ('COURIER', 'COD_FEES')) as delivery_cost,
           sum(ft.amount) filter (where c.code = 'RETURNS') as return_cost
    from public.finance_transactions ft
    join public.finance_categories c on c.id = ft.category_id
    where ft.order_id in (select order_id from o) and c.code in ('COURIER', 'COD_FEES', 'RETURNS')
    group by ft.order_id
  ), ok as (
    -- one row per order and group (products can put an order in several groups)
    select o.*, coalesce(k.delivery_cost, 0) as delivery_cost, coalesce(k.return_cost, 0) as return_cost,
      g.key, g.label, g.revenue_part
    from o
    left join costs k on k.order_id = o.order_id
    cross join lateral (
      select case p_group
               when 'source' then o.source when 'medium' then o.medium
               when 'campaign' then coalesce(o.campaign_key, '-')
               when 'adset' then coalesce(o.adset_key, '-')
               when 'ad' then coalesce(o.ad_key, '-')
               else o.d::text end as key,
             case p_group
               when 'source' then o.source when 'medium' then o.medium
               when 'campaign' then coalesce(o.campaign_name, case when o.campaign_key is null then 'No campaign' else 'Campaign ' || o.campaign_key end)
               when 'adset' then coalesce(o.adset_name, case when o.adset_key is null then 'No ad set' else 'Ad set ' || o.adset_key end)
               when 'ad' then coalesce(o.ad_name, case when o.ad_key is null then 'No ad' else 'Ad ' || o.ad_key end)
               else o.d::text end as label,
             null::numeric as revenue_part
      where p_group <> 'product'
      union all
      select oi.product_id::text, max(oi.product_name), sum(oi.line_total)
      from public.order_items oi where p_group = 'product' and oi.order_id = o.order_id
      group by oi.product_id
    ) g
  ), s as (
    select case p_group
             when 'source' then a.source when 'medium' then 'Paid'
             when 'campaign' then a.campaign_key when 'adset' then a.adset_key when 'ad' then a.ad_key
             else a.date::text end as key,
           case p_group
             when 'source' then a.source when 'medium' then 'Paid'
             when 'campaign' then a.campaign_name when 'adset' then a.adset_name when 'ad' then a.ad_name
             else a.date::text end as label,
           sum(a.cost) as spend, sum(a.impressions) as impressions, sum(a.clicks) as clicks
    from public.ad_spend_facts a
    where v_spend_ok and a.date between p_from and p_to
      and (v_source is null or a.source = v_source)
      and (v_campaign is null or a.campaign_key = v_campaign)
      and (v_adset is null or a.adset_key = v_adset)
      and (v_ad is null or a.ad_key = v_ad)
    group by 1, 2
  ), g as (
    select key, max(label) as label,
      count(distinct order_id) as orders,
      count(distinct order_id) filter (where confirmed_at is not null) as approved,
      count(distinct order_id) filter (where shipped_at is not null) as shipped,
      count(distinct order_id) filter (where is_delivered) as delivered,
      count(distinct order_id) filter (where is_cancelled) as cancelled,
      count(distinct order_id) filter (where is_returned) as returned,
      sum(coalesce(revenue_part, total_amount)) filter (where not is_cancelled) as order_value,
      sum(coalesce(revenue_part, total_amount)) filter (where is_delivered) as revenue,
      sum(delivery_cost) filter (where p_group <> 'product') as delivery_cost,
      sum(return_cost) filter (where p_group <> 'product') as return_cost
    from ok group by key
  ), j as (
    select coalesce(g.key, s.key) as key, coalesce(g.label, s.label) as label,
      coalesce(g.orders, 0) as orders, coalesce(g.approved, 0) as approved, coalesce(g.shipped, 0) as shipped,
      coalesce(g.delivered, 0) as delivered, coalesce(g.cancelled, 0) as cancelled, coalesce(g.returned, 0) as returned,
      coalesce(g.order_value, 0) as order_value, coalesce(g.revenue, 0) as revenue,
      coalesce(g.delivery_cost, 0) as delivery_cost, coalesce(g.return_cost, 0) as return_cost,
      s.spend, s.impressions, s.clicks
    from g full join s on s.key = g.key
  )
  select jsonb_build_object(
    'group', p_group,
    'spend_tracked', v_spend_ok,
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'key', key, 'label', label, 'orders', orders, 'approved', approved, 'shipped', shipped, 'delivered', delivered,
        'cancelled', cancelled, 'returned', returned, 'order_value', order_value, 'revenue', revenue,
        'delivery_cost', delivery_cost, 'return_cost', return_cost, 'ad_spend', spend,
        'impressions', impressions, 'clicks', clicks,
        'net_revenue', revenue - delivery_cost - return_cost - coalesce(spend, 0),
        'cost_per_order', case when spend is not null and orders > 0 then round(spend / orders, 2) end,
        'cost_per_delivered', case when spend is not null and delivered > 0 then round(spend / delivered, 2) end,
        'roas', case when spend > 0 then round(revenue / spend, 2) end)
      order by (case when p_group = 'date' then key end), revenue desc, orders desc, spend desc nulls last, label) from j), '[]'::jsonb),
    'totals', (select jsonb_build_object(
        'orders', count(distinct order_id),
        'delivered', count(distinct order_id) filter (where is_delivered),
        'cancelled', count(distinct order_id) filter (where is_cancelled),
        'returned', count(distinct order_id) filter (where is_returned),
        'revenue', coalesce(sum(total_amount) filter (where is_delivered), 0),
        'order_value', coalesce(sum(total_amount) filter (where not is_cancelled), 0),
        'unattributed', count(distinct order_id) filter (where source = 'Unknown'),
        'paid', count(distinct order_id) filter (where is_paid))
      from o),
    'spend', case when v_spend_ok then (select coalesce(sum(spend), 0) from s) end,
    'costs', (select jsonb_build_object('delivery', coalesce(sum(delivery_cost), 0), 'returns', coalesce(sum(return_cost), 0))
              from (select distinct order_id, delivery_cost, return_cost from ok) x)
  ) into v_result;
  return v_result;
end;
$$;

-- Meta campaigns, ad sets or ads with Meta's numbers and the orders their links brought.
create or replace function public.report_meta_ads(p_from date, p_to date, p_level text default 'campaign', p_parent text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz text := public.store_timezone();
  v_rate numeric := coalesce(nullif(public.setting_numeric('meta_ads', array['exchange_rate'], 1), 0), 1);
begin
  perform public.require_permission('marketing.view');
  if p_level not in ('campaign', 'adset', 'ad') then
    raise exception 'VALIDATION: unknown level %', p_level using errcode = '22023';
  end if;
  return coalesce((
    with ins as (
      select case p_level when 'campaign' then i.campaign_id when 'adset' then i.adset_id else i.ad_id end as id,
             sum(i.cost) as spend, sum(i.spend) as spend_account, sum(i.impressions) as impressions, sum(i.clicks) as clicks,
             sum(i.link_clicks) as link_clicks, sum(i.purchases) as purchases, round(sum(i.purchase_value) * v_rate, 2) as purchase_value
      from public.meta_ad_insights i
      where i.date between p_from and p_to
        and (p_parent is null or (p_level = 'adset' and i.campaign_id = p_parent) or (p_level = 'ad' and i.adset_id = p_parent))
      group by 1
    ), ord as (
      select case p_level when 'campaign' then f.campaign_key when 'adset' then f.adset_key else f.ad_key end as id,
             count(*) as orders,
             count(*) filter (where f.status in ('DELIVERED', 'PARTIALLY_DELIVERED')) as delivered,
             count(*) filter (where f.status in ('CANCELLED', 'REJECTED_FRAUD')) as cancelled,
             count(*) filter (where f.status in ('RETURN_REQUESTED', 'RETURNING', 'RETURNED')) as returned,
             coalesce(sum(f.total_amount) filter (where f.status in ('DELIVERED', 'PARTIALLY_DELIVERED')), 0) as revenue
      from public.order_attribution_facts f
      where (f.created_at at time zone v_tz)::date between p_from and p_to
        and (p_parent is null
             or (p_level = 'adset' and f.campaign_key = p_parent)
             or (p_level = 'ad' and f.adset_key = p_parent))
      group by 1
    ), items as (
      select x.id, x.name, x.status, x.effective_status, x.parent, x.thumbnail_url, x.title, x.daily_budget
      from (
        select c.id, c.name, c.status, c.effective_status, null::text as parent, null::text as thumbnail_url, null::text as title, c.daily_budget
        from public.meta_campaigns c where p_level = 'campaign'
        union all
        select s.id, s.name, s.status, s.effective_status, s.campaign_id, null, null, s.daily_budget
        from public.meta_adsets s where p_level = 'adset' and (p_parent is null or s.campaign_id = p_parent)
        union all
        select a.id, a.name, a.status, a.effective_status, a.adset_id, a.thumbnail_url, a.title, null
        from public.meta_ads a where p_level = 'ad' and (p_parent is null or a.adset_id = p_parent)
      ) x
    )
    select jsonb_agg(jsonb_build_object(
      'id', it.id, 'name', it.name, 'status', it.status, 'effective_status', it.effective_status, 'parent', it.parent,
      'thumbnail_url', it.thumbnail_url, 'title', it.title, 'daily_budget', it.daily_budget,
      'spend', coalesce(ins.spend, 0), 'spend_account', coalesce(ins.spend_account, 0),
      'impressions', coalesce(ins.impressions, 0), 'clicks', coalesce(ins.link_clicks, 0),
      'ctr', case when ins.impressions > 0 then round(100.0 * ins.link_clicks / ins.impressions, 2) end,
      'cpc', case when ins.link_clicks > 0 then round(ins.spend / ins.link_clicks, 2) end,
      'cpm', case when ins.impressions > 0 then round(1000 * ins.spend / ins.impressions, 2) end,
      'meta_purchases', coalesce(ins.purchases, 0), 'meta_purchase_value', coalesce(ins.purchase_value, 0),
      'orders', coalesce(ord.orders, 0), 'delivered', coalesce(ord.delivered, 0), 'cancelled', coalesce(ord.cancelled, 0),
      'returned', coalesce(ord.returned, 0), 'revenue', coalesce(ord.revenue, 0),
      'cost_per_order', case when ord.orders > 0 and ins.spend > 0 then round(ins.spend / ord.orders, 2) end,
      'roas', case when ins.spend > 0 then round(coalesce(ord.revenue, 0) / ins.spend, 2) end)
      order by coalesce(ins.spend, 0) desc, coalesce(ord.orders, 0) desc, it.name)
    from items it
    left join ins on ins.id = it.id
    left join ord on ord.id = it.id
    where ins.id is not null or ord.id is not null
       or coalesce(it.effective_status, it.status) in ('ACTIVE', 'IN_PROCESS', 'WITH_ISSUES')
  ), '[]'::jsonb);
end;
$$;

-- -----------------------------------------------------------------------------
-- Payment gateway fees
-- -----------------------------------------------------------------------------
create or replace function public._order_payment_gateway_fee()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.payments;
  v_pct numeric;
  v_order public.orders;
begin
  if new.payment_id is null then
    return null;
  end if;
  select * into v_payment from public.payments where id = new.payment_id;
  if not found or v_payment.channel <> 'GATEWAY' then
    return null;
  end if;
  v_pct := public.setting_numeric('payments', array['providers', v_payment.provider, 'fee_percent'], 0);
  if coalesce(v_pct, 0) <= 0 then
    return null;
  end if;
  select * into v_order from public.orders where id = new.order_id;
  perform public._post_finance('EXPENSE', 'PAYMENT_FEES', round(new.amount * least(v_pct, 20) / 100, 2),
    (now() at time zone public.store_timezone())::date, true, new.order_id, v_order.customer_id, null,
    v_order.order_number, format('%s%% fee on %s payment %s', v_pct, v_payment.provider, new.reference),
    'payment_fee:' || new.id, 'GATEWAY');
  return null;
end;
$$;

create or replace trigger order_payments_gateway_fee after insert on public.order_payments
  for each row execute function public._order_payment_gateway_fee();

-- -----------------------------------------------------------------------------
-- Finance overview: costs by kind, collections
-- -----------------------------------------------------------------------------
create or replace function public.finance_overview(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_pnl jsonb;
  v_cash jsonb;
  v_by jsonb;
begin
  perform public.require_permission('finance.view');
  v_pnl := public.report_profit_loss(p_from, p_to);
  v_cash := public.report_cash_flow(p_from, p_to, 'day');
  select coalesce(jsonb_object_agg(code, amount), '{}'::jsonb) into v_by from (
    select c.code, sum(ft.amount) as amount
    from public.finance_transactions ft join public.finance_categories c on c.id = ft.category_id
    where ft.txn_date between p_from and p_to group by c.code) x;
  return v_pnl || jsonb_build_object(
    'total_expenses', (v_pnl ->> 'cogs')::numeric + (v_pnl ->> 'operating_expenses')::numeric,
    'cash_in', v_cash -> 'cash_in',
    'cash_out', v_cash -> 'cash_out',
    'net_cash_flow', v_cash -> 'net_cash_flow',
    'cash_series', v_cash -> 'series',
    -- What each kind of cost came to in the period
    'delivery_costs', coalesce((v_by ->> 'COURIER')::numeric, 0) + coalesce((v_by ->> 'COD_FEES')::numeric, 0) + coalesce((v_by ->> 'RETURNS')::numeric, 0),
    'courier_charges', coalesce((v_by ->> 'COURIER')::numeric, 0),
    'courier_cod_fees', coalesce((v_by ->> 'COD_FEES')::numeric, 0),
    'return_charges', coalesce((v_by ->> 'RETURNS')::numeric, 0),
    'marketing_costs', coalesce((v_by ->> 'ADVERTISING')::numeric, 0),
    'sms_costs', coalesce((v_by ->> 'SMS')::numeric, 0),
    'payment_fees', coalesce((v_by ->> 'PAYMENT_FEES')::numeric, 0),
    'other_expenses', (v_pnl ->> 'operating_expenses')::numeric
      - coalesce((v_by ->> 'COURIER')::numeric, 0) - coalesce((v_by ->> 'COD_FEES')::numeric, 0) - coalesce((v_by ->> 'RETURNS')::numeric, 0)
      - coalesce((v_by ->> 'ADVERTISING')::numeric, 0) - coalesce((v_by ->> 'SMS')::numeric, 0) - coalesce((v_by ->> 'PAYMENT_FEES')::numeric, 0),
    'discounts', coalesce((select sum(o.discount_total) from public.orders o
      where o.delivered_at is not null and (o.delivered_at at time zone public.store_timezone())::date between p_from and p_to
        and o.status in ('DELIVERED', 'PARTIALLY_DELIVERED', 'RETURN_REQUESTED')), 0),
    'gross_sales', coalesce((v_pnl ->> 'product_revenue')::numeric, 0) + coalesce((select sum(o.discount_total) from public.orders o
      where o.delivered_at is not null and (o.delivered_at at time zone public.store_timezone())::date between p_from and p_to
        and o.status in ('DELIVERED', 'PARTIALLY_DELIVERED', 'RETURN_REQUESTED')), 0),
    'order_value', coalesce((select sum(o.total_amount) from public.orders o
      where (o.created_at at time zone public.store_timezone())::date between p_from and p_to
        and o.status not in ('CANCELLED', 'REJECTED_FRAUD')), 0),
    'cod_collected', coalesce((v_by ->> 'COD_COLLECTIONS')::numeric, 0),
    'online_collected', coalesce((v_by ->> 'ONLINE_PAYMENTS')::numeric, 0) + coalesce((v_by ->> 'ADVANCE_PAYMENTS')::numeric, 0),
    'advance_payments', coalesce((v_by ->> 'ADVANCE_PAYMENTS')::numeric, 0),
    -- Point-in-time balances (not limited to the period)
    'cod_receivable', coalesce((select sum(total_amount - amount_paid) from public.orders
      where delivered_at is not null and status in ('DELIVERED', 'PARTIALLY_DELIVERED', 'RETURN_REQUESTED')
        and total_amount > amount_paid), 0),
    'outstanding_amount', coalesce((select sum(total_amount - amount_paid) from public.orders
      where status in ('CONFIRMED', 'PRE_ORDER', 'PROCESSING', 'PRODUCTION', 'QUALITY_CHECK', 'PACKING', 'READY_TO_SHIP', 'SHIPPED')
        and total_amount > amount_paid), 0),
    'supplier_payables', coalesce((select sum(total_cost - amount_paid) from public.purchase_orders
      where status in ('ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED') and total_cost > amount_paid), 0),
    'unresolved_advances', coalesce((select sum(amount_paid) from public.orders
      where status in ('CANCELLED', 'REJECTED_FRAUD', 'RETURNED') and delivered_at is null
        and amount_paid > 0 and advance_resolution is null), 0)
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Access
-- -----------------------------------------------------------------------------
revoke execute on function
  public._meta_cost(numeric),
  public._meta_refresh_marketing_spend(text[], date, date),
  public.meta_ads_apply_sync(jsonb),
  public.meta_ads_set_connection(jsonb, uuid),
  public.meta_ads_record_sync(text, text, date, date),
  public.meta_ads_config(),
  public.meta_ads_status(),
  public.meta_ads_update_settings(numeric, numeric),
  public.report_attribution(date, date, text, jsonb),
  public.report_meta_ads(date, date, text, text),
  public._order_payment_gateway_fee(),
  public.finance_overview(date, date)
from public, anon, authenticated;

grant execute on function
  public.meta_ads_status(),
  public.meta_ads_update_settings(numeric, numeric),
  public.report_attribution(date, date, text, jsonb),
  public.report_meta_ads(date, date, text, text),
  public.finance_overview(date, date)
to authenticated;
grant execute on function
  public.meta_ads_apply_sync(jsonb),
  public.meta_ads_set_connection(jsonb, uuid),
  public.meta_ads_record_sync(text, text, date, date),
  public.meta_ads_config()
to service_role;

revoke all on public.order_attribution_facts, public.ad_spend_facts from anon;
grant select on public.order_attribution_facts, public.ad_spend_facts to authenticated, service_role;
