-- =============================================================================
-- Super Admin → Income & Expenses → Ads report: which of Fullfilio's own Meta
-- campaigns bring leads that become paying stores.
--
--   * Campaigns, ad sets, ads and daily numbers per ad (spend, reach, clicks
--     and what Meta counts as leads, registrations and messages), synced with
--     the daily spend by the platform-admin function.
--   * Leads are Fullfilio's own: WhatsApp sign-up requests, self sign-ups and
--     sales messages from the website. The website keeps how the visitor
--     arrived (UTM / campaign_id / fbclid); that touch is stored with the lead.
--   * A lead pays when its store has a verified payment; what it paid is the
--     revenue that campaign brought.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Campaign structure and daily numbers per ad
-- -----------------------------------------------------------------------------
create table public.platform_meta_campaigns (
  id text primary key,
  account_id text not null,
  name text not null,
  status text,
  effective_status text,
  objective text,
  daily_budget numeric(14, 2),
  lifetime_budget numeric(14, 2),
  start_time timestamptz,
  stop_time timestamptz,
  synced_at timestamptz not null default now()
);
create table public.platform_meta_adsets (
  id text primary key,
  campaign_id text,
  name text not null,
  status text,
  effective_status text,
  daily_budget numeric(14, 2),
  lifetime_budget numeric(14, 2),
  start_time timestamptz,
  end_time timestamptz,
  synced_at timestamptz not null default now()
);
create table public.platform_meta_ads (
  id text primary key,
  adset_id text,
  campaign_id text,
  name text not null,
  status text,
  effective_status text,
  thumbnail_url text,
  title text,
  synced_at timestamptz not null default now()
);
create table public.platform_meta_insights (
  ad_id text not null,
  date date not null,
  account_id text not null,
  campaign_id text,
  adset_id text,
  -- In the ad account's currency, and in taka at the account's rate.
  spend numeric(14, 2) not null default 0,
  cost numeric(14, 2) not null default 0,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  link_clicks bigint not null default 0,
  leads int not null default 0,
  registrations int not null default 0,
  messages int not null default 0,
  purchases int not null default 0,
  primary key (ad_id, date)
);
create index platform_meta_insights_account_idx on public.platform_meta_insights (account_id, date);
create index platform_meta_insights_campaign_idx on public.platform_meta_insights (campaign_id, date);

-- How each lead arrived (the website's first and last touch), first write wins.
create table public.platform_lead_touches (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('WHATSAPP_SIGNUP', 'SELF_SIGNUP', 'CONTACT')),
  ref text not null,
  attribution jsonb not null,
  created_at timestamptz not null default now(),
  unique (kind, ref)
);

do $$
declare
  t text;
begin
  foreach t in array array['platform_meta_campaigns', 'platform_meta_adsets', 'platform_meta_ads', 'platform_meta_insights', 'platform_lead_touches'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- 2. Sync (platform-admin function, service role)
-- -----------------------------------------------------------------------------
create or replace function public.platform_meta_apply_sync(p_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a public.platform_ad_accounts;
  v_since date := (p ->> 'since')::date;
  v_until date := (p ->> 'until')::date;
  v_rate numeric;
  v_rows int;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select * into a from public.platform_ad_accounts where id = p_id;
  if a.id is null then
    raise exception 'NOT_FOUND: ad account not found' using errcode = 'P0002';
  end if;
  if v_since is null or v_until is null or v_until < v_since or v_until - v_since > 92 then
    raise exception 'VALIDATION: bad sync window' using errcode = '22023';
  end if;
  v_rate := case when upper(coalesce(a.currency, '')) = 'BDT' then 1 else a.usd_rate end;

  insert into public.platform_meta_campaigns (id, account_id, name, status, effective_status, objective, daily_budget, lifetime_budget, start_time, stop_time, synced_at)
  select c ->> 'id', a.ad_account_id, coalesce(c ->> 'name', c ->> 'id'), c ->> 'status', c ->> 'effective_status', c ->> 'objective',
         nullif(c ->> 'daily_budget', '')::numeric / 100, nullif(c ->> 'lifetime_budget', '')::numeric / 100,
         nullif(c ->> 'start_time', '')::timestamptz, nullif(c ->> 'stop_time', '')::timestamptz, now()
  from jsonb_array_elements(coalesce(p -> 'campaigns', '[]'::jsonb)) c where c ->> 'id' is not null
  on conflict (id) do update set account_id = excluded.account_id, name = excluded.name, status = excluded.status,
    effective_status = excluded.effective_status, objective = excluded.objective, daily_budget = excluded.daily_budget,
    lifetime_budget = excluded.lifetime_budget, start_time = excluded.start_time, stop_time = excluded.stop_time, synced_at = now();

  insert into public.platform_meta_adsets (id, campaign_id, name, status, effective_status, daily_budget, lifetime_budget, start_time, end_time, synced_at)
  select s ->> 'id', s ->> 'campaign_id', coalesce(s ->> 'name', s ->> 'id'), s ->> 'status', s ->> 'effective_status',
         nullif(s ->> 'daily_budget', '')::numeric / 100, nullif(s ->> 'lifetime_budget', '')::numeric / 100,
         nullif(s ->> 'start_time', '')::timestamptz, nullif(s ->> 'end_time', '')::timestamptz, now()
  from jsonb_array_elements(coalesce(p -> 'adsets', '[]'::jsonb)) s where s ->> 'id' is not null
  on conflict (id) do update set campaign_id = excluded.campaign_id, name = excluded.name, status = excluded.status,
    effective_status = excluded.effective_status, daily_budget = excluded.daily_budget, lifetime_budget = excluded.lifetime_budget,
    start_time = excluded.start_time, end_time = excluded.end_time, synced_at = now();

  insert into public.platform_meta_ads (id, adset_id, campaign_id, name, status, effective_status, thumbnail_url, title, synced_at)
  select d ->> 'id', d ->> 'adset_id', d ->> 'campaign_id', coalesce(d ->> 'name', d ->> 'id'), d ->> 'status', d ->> 'effective_status',
         d #>> '{creative,thumbnail_url}', coalesce(d #>> '{creative,title}', d #>> '{creative,name}'), now()
  from jsonb_array_elements(coalesce(p -> 'ads', '[]'::jsonb)) d where d ->> 'id' is not null
  on conflict (id) do update set adset_id = excluded.adset_id, campaign_id = excluded.campaign_id, name = excluded.name,
    status = excluded.status, effective_status = excluded.effective_status, thumbnail_url = excluded.thumbnail_url,
    title = excluded.title, synced_at = now();

  -- The window is replaced as a whole: Meta revises recent days.
  delete from public.platform_meta_insights where account_id = a.ad_account_id and date between v_since and v_until;
  insert into public.platform_meta_insights (ad_id, date, account_id, campaign_id, adset_id, spend, cost, impressions, clicks, link_clicks,
    leads, registrations, messages, purchases)
  select i ->> 'ad_id', (i ->> 'date')::date, a.ad_account_id, i ->> 'campaign_id', i ->> 'adset_id',
         round(sum(coalesce((i ->> 'spend')::numeric, 0)), 2), round(sum(coalesce((i ->> 'spend')::numeric, 0)) * v_rate, 2),
         sum(coalesce((i ->> 'impressions')::bigint, 0)), sum(coalesce((i ->> 'clicks')::bigint, 0)), sum(coalesce((i ->> 'link_clicks')::bigint, 0)),
         sum(coalesce((i ->> 'leads')::int, 0)), sum(coalesce((i ->> 'registrations')::int, 0)), sum(coalesce((i ->> 'messages')::int, 0)),
         sum(coalesce((i ->> 'purchases')::int, 0))
  from jsonb_array_elements(coalesce(p -> 'insights', '[]'::jsonb)) i
  where i ->> 'ad_id' is not null and (i ->> 'date')::date between v_since and v_until
  group by i ->> 'ad_id', (i ->> 'date')::date, i ->> 'campaign_id', i ->> 'adset_id';
  get diagnostics v_rows = row_count;
  return jsonb_build_object('insights', v_rows);
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Where a lead came from
-- -----------------------------------------------------------------------------
-- Only the parts of a touch the report reads, in a bounded size.
create or replace function public._platform_lead_touch_one(t jsonb)
returns jsonb
language sql
immutable
as $$
  select case when t is null or jsonb_typeof(t) <> 'object' then null else jsonb_strip_nulls(jsonb_build_object(
    'at', left(t ->> 'at', 40), 'landing', left(t ->> 'landing', 300), 'referrer', left(t ->> 'referrer', 300),
    'params', coalesce((select jsonb_object_agg(k, left(v, 200)) from jsonb_each_text(case when jsonb_typeof(t -> 'params') = 'object' then t -> 'params' else '{}'::jsonb end) e(k, v)
                        where k in ('utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id', 'fbclid', 'gclid', 'ttclid',
                                    'campaign_id', 'adset_id', 'ad_id', 'campaign_name', 'adset_name', 'ad_name', 'placement', 'site_source_name', 'ref')),
                       '{}'::jsonb))) end
$$;

create or replace function public._platform_lead_touch_clean(p jsonb)
returns jsonb
language sql
immutable
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'first_touch', public._platform_lead_touch_one(p -> 'first_touch'),
    'last_touch', public._platform_lead_touch_one(p -> 'last_touch'),
    'visitor_id', left(p ->> 'visitor_id', 64)))
$$;

-- Website forms call this right after the lead is saved (the WhatsApp request id
-- is only known to the browser that sent it; a self sign-up is the caller's own store).
create or replace function public.public_lead_touch(p_kind text, p_ref text, p_attr jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_merchant uuid;
begin
  if p_attr is null or jsonb_typeof(p_attr) <> 'object' or length(p_attr::text) > 16000 then
    return;
  end if;
  if p_kind = 'WHATSAPP_SIGNUP' then
    if p_ref !~ '^[0-9a-f-]{36}$' or not exists (select 1 from public.signup_requests where id = p_ref::uuid and created_at > now() - interval '1 hour') then
      return;
    end if;
  elsif p_kind = 'SELF_SIGNUP' then
    select pr.merchant_id into v_merchant from public.profiles pr where pr.id = auth.uid();
    if v_merchant is null or v_merchant::text <> p_ref
       or not exists (select 1 from public.merchants m where m.id = v_merchant and m.created_at > now() - interval '2 days'
                        and coalesce(m.onboarding ->> 'self_signup', '') = 'true') then
      return;
    end if;
  else
    return;
  end if;
  insert into public.platform_lead_touches (kind, ref, attribution) values (p_kind, p_ref, public._platform_lead_touch_clean(p_attr))
  on conflict (kind, ref) do nothing;
end;
$$;

-- The website contact form, now keeping how the visitor arrived.
create or replace function public.platform_contact_submit(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text := trim(coalesce(p ->> 'name', ''));
  v_email text := nullif(lower(trim(coalesce(p ->> 'email', ''))), '');
  v_phone text := nullif(trim(coalesce(p ->> 'phone', '')), '');
  v_message text := trim(coalesce(p ->> 'message', ''));
  v_topic text := upper(coalesce(nullif(trim(p ->> 'topic'), ''), 'GENERAL'));
  v_id bigint;
begin
  if char_length(v_name) < 2 then
    raise exception 'VALIDATION: enter your name' using errcode = '22023';
  end if;
  if v_email is null and v_phone is null then
    raise exception 'VALIDATION: enter an e-mail address or a phone number so we can reply' using errcode = '22023';
  end if;
  if v_email is not null and v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'VALIDATION: this e-mail address does not look right' using errcode = '22023';
  end if;
  if v_phone is not null and v_phone !~ '^[+0-9 -]{6,20}$' then
    raise exception 'VALIDATION: this phone number does not look right' using errcode = '22023';
  end if;
  if char_length(v_message) < 10 then
    raise exception 'VALIDATION: tell us a little more (at least 10 characters)' using errcode = '22023';
  end if;
  if v_topic not in ('SALES', 'SUPPORT', 'PARTNERSHIP', 'GENERAL') then v_topic := 'GENERAL'; end if;
  -- Flood protection: per reply address, and overall.
  if (select count(*) from public.platform_contact_messages
      where created_at > now() - interval '1 hour'
        and ((v_email is not null and email = v_email) or (v_phone is not null and phone = v_phone))) >= 3
     or (select count(*) from public.platform_contact_messages where created_at > now() - interval '10 minutes') >= 60 then
    raise exception 'RATE_LIMITED: we already have your message; we will reply soon' using errcode = 'P0001';
  end if;
  insert into public.platform_contact_messages (name, email, phone, business, topic, message, page)
  values (left(v_name, 100), v_email, v_phone, nullif(left(trim(coalesce(p ->> 'business', '')), 120), ''), v_topic,
          left(v_message, 4000), nullif(left(trim(coalesce(p ->> 'page', '')), 200), ''))
  returning id into v_id;
  if jsonb_typeof(p -> 'attribution') = 'object' and length((p -> 'attribution')::text) <= 16000 then
    insert into public.platform_lead_touches (kind, ref, attribution) values ('CONTACT', v_id::text, public._platform_lead_touch_clean(p -> 'attribution'))
    on conflict (kind, ref) do nothing;
  end if;
  return jsonb_build_object('id', v_id);
end;
$$;

-- Source of a touch: Meta ads, another paid source, organic Facebook, a referral, direct.
create or replace function public._platform_lead_source(attr jsonb)
returns text
language sql
immutable
as $$
  with t as (
    select coalesce(case when attr #> '{last_touch,params}' <> '{}'::jsonb or attr #>> '{last_touch,referrer}' is not null then attr -> 'last_touch' end,
                    attr -> 'first_touch') as touch
  ), x as (
    select coalesce(touch -> 'params', '{}'::jsonb) as p, lower(coalesce(touch ->> 'referrer', '')) as ref from t
  )
  select case
    when attr is null then 'UNKNOWN'
    when p ? 'fbclid' or p ? 'campaign_id' or p ? 'ad_id'
      or (lower(coalesce(p ->> 'utm_source', '')) in ('facebook', 'fb', 'meta', 'instagram', 'ig', 'an', 'messenger')
          and lower(coalesce(p ->> 'utm_medium', 'paid')) not in ('organic', 'social', 'post', 'bio')) then 'META_ADS'
    when p ? 'gclid' or lower(coalesce(p ->> 'utm_source', '')) = 'google' then 'GOOGLE'
    when p ? 'ttclid' or lower(coalesce(p ->> 'utm_source', '')) = 'tiktok' then 'TIKTOK'
    when p <> '{}'::jsonb then 'OTHER_CAMPAIGN'
    when ref ~ '(facebook|instagram|fb)\.com' or ref ~ '(^|\.)(l\.)?facebook' then 'FACEBOOK_ORGANIC'
    when ref <> '' then 'REFERRAL'
    else 'DIRECT' end
  from x
$$;

-- Every lead in a period, with how it arrived and whether its store paid.
create or replace function public._platform_leads(p_from date, p_to date)
returns table (
  kind text, ref text, created_at timestamptz, name text, business text, phone text, email text, status text,
  merchant_id uuid, merchant text, source text, campaign_id text, adset_id text, ad_id text, utm_campaign text, landing text,
  paying boolean, revenue numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with bounds as (
    select (p_from::timestamp at time zone 'Asia/Dhaka') as t_from, ((p_to + 1)::timestamp at time zone 'Asia/Dhaka') as t_to
  ), leads as (
    select 'WHATSAPP_SIGNUP'::text as kind, r.id::text as ref, r.created_at, r.full_name as name, r.business_name as business, r.phone, r.email,
           r.status, r.merchant_id
    from public.signup_requests r, bounds b where r.created_at >= b.t_from and r.created_at < b.t_to
    union all
    select 'SELF_SIGNUP', m.id::text, m.created_at, null, m.name, m.phone, m.owner_email, m.status, m.id
    from public.merchants m, bounds b
    where m.created_at >= b.t_from and m.created_at < b.t_to and not m.is_demo and coalesce(m.onboarding ->> 'self_signup', '') = 'true'
    union all
    select 'CONTACT', c.id::text, c.created_at, c.name, c.business, c.phone, c.email, c.status, null
    from public.platform_contact_messages c, bounds b
    where c.created_at >= b.t_from and c.created_at < b.t_to and c.topic in ('SALES', 'GENERAL', 'PARTNERSHIP')
  ), touched as (
    select l.*, t.attribution,
           coalesce(case when t.attribution #> '{last_touch,params}' <> '{}'::jsonb then t.attribution #> '{last_touch,params}' end,
                    t.attribution #> '{first_touch,params}', '{}'::jsonb) as p,
           coalesce(t.attribution #>> '{last_touch,landing}', t.attribution #>> '{first_touch,landing}') as landing
    from leads l left join public.platform_lead_touches t on t.kind = l.kind and t.ref = l.ref
  )
  select x.kind, x.ref, x.created_at, x.name, x.business, x.phone, x.email, x.status, x.merchant_id, m.name,
         public._platform_lead_source(x.attribution) as source,
         case when public._platform_lead_source(x.attribution) = 'META_ADS' then coalesce(nullif(x.p ->> 'campaign_id', ''),
           (select c.id from public.platform_meta_campaigns c where c.id = x.p ->> 'utm_campaign' or lower(c.name) = lower(x.p ->> 'utm_campaign')
            or lower(c.name) = lower(x.p ->> 'campaign_name') order by c.synced_at desc limit 1)) end,
         case when public._platform_lead_source(x.attribution) = 'META_ADS' then coalesce(nullif(x.p ->> 'adset_id', ''),
           (select s.id from public.platform_meta_adsets s where s.id = x.p ->> 'utm_term' or lower(s.name) = lower(x.p ->> 'utm_term')
            or lower(s.name) = lower(x.p ->> 'adset_name') order by s.synced_at desc limit 1)) end,
         case when public._platform_lead_source(x.attribution) = 'META_ADS' then coalesce(nullif(x.p ->> 'ad_id', ''),
           (select d.id from public.platform_meta_ads d where d.id = x.p ->> 'utm_content' or lower(d.name) = lower(x.p ->> 'utm_content')
            or lower(d.name) = lower(x.p ->> 'ad_name') order by d.synced_at desc limit 1)) end,
         coalesce(x.p ->> 'utm_campaign', x.p ->> 'campaign_name'), x.landing,
         coalesce(pay.total, 0) > 0, coalesce(pay.total, 0)
  from touched x
  left join public.merchants m on m.id = x.merchant_id
  left join lateral (select sum(bp.amount) as total from public.billing_payments bp
                     where bp.merchant_id = x.merchant_id and bp.status = 'SUCCEEDED') pay on x.merchant_id is not null
$$;

-- -----------------------------------------------------------------------------
-- 4. The report
-- -----------------------------------------------------------------------------
create or replace function public.platform_ads_report(p_from date, p_to date, p_level text default 'campaign', p_parent text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._platform_require('finance', 'view');
  perform public._platform_finance_range(p_from, p_to);
  if p_level not in ('campaign', 'adset', 'ad') then
    raise exception 'VALIDATION: unknown level %', p_level using errcode = '22023';
  end if;
  return (
    with ins as (
      select case p_level when 'campaign' then i.campaign_id when 'adset' then i.adset_id else i.ad_id end as id,
             sum(i.cost) as cost, sum(i.spend) as spend, sum(i.impressions) as impressions, sum(i.clicks) as clicks,
             sum(i.link_clicks) as link_clicks, sum(i.leads) as meta_leads, sum(i.registrations) as registrations, sum(i.messages) as messages
      from public.platform_meta_insights i
      where i.date between p_from and p_to
        and (p_parent is null or (p_level = 'adset' and i.campaign_id = p_parent) or (p_level = 'ad' and i.adset_id = p_parent))
      group by 1
    ), lds as (
      select case p_level when 'campaign' then l.campaign_id when 'adset' then l.adset_id else l.ad_id end as id,
             count(*) as leads, count(*) filter (where l.paying) as paying, sum(l.revenue) as revenue
      from public._platform_leads(p_from, p_to) l
      where l.source = 'META_ADS'
        and (p_parent is null or (p_level = 'adset' and l.campaign_id = p_parent) or (p_level = 'ad' and l.adset_id = p_parent))
      group by 1
    ), items as (
      select c.id, c.name, c.status, c.effective_status, null::text as parent, null::text as thumbnail_url, c.objective, c.daily_budget
      from public.platform_meta_campaigns c where p_level = 'campaign'
      union all
      select s.id, s.name, s.status, s.effective_status, s.campaign_id, null, null, s.daily_budget
      from public.platform_meta_adsets s where p_level = 'adset' and (p_parent is null or s.campaign_id = p_parent)
      union all
      select d.id, d.name, d.status, d.effective_status, d.adset_id, d.thumbnail_url, null, null
      from public.platform_meta_ads d where p_level = 'ad' and (p_parent is null or d.adset_id = p_parent)
    ), rows as (
      select coalesce(it.id, ins.id, lds.id) as id, coalesce(it.name, coalesce(ins.id, lds.id)) as name, it.status, it.effective_status, it.parent,
             it.thumbnail_url, it.objective, it.daily_budget,
             coalesce(ins.cost, 0) as cost, coalesce(ins.spend, 0) as spend, coalesce(ins.impressions, 0) as impressions,
             coalesce(ins.clicks, 0) as clicks, coalesce(ins.link_clicks, 0) as link_clicks, coalesce(ins.meta_leads, 0) as meta_leads,
             coalesce(ins.registrations, 0) as registrations, coalesce(ins.messages, 0) as messages,
             coalesce(lds.leads, 0) as leads, coalesce(lds.paying, 0) as paying, coalesce(lds.revenue, 0) as revenue
      from items it
      full join ins on ins.id = it.id
      full join lds on lds.id = coalesce(it.id, ins.id)
      where coalesce(it.id, ins.id, lds.id) is not null
    ), shown as (
      select r.* from rows r where r.cost > 0 or r.leads > 0 or r.impressions > 0 or coalesce(r.effective_status, '') = 'ACTIVE'
    ), all_leads as (
      select * from public._platform_leads(p_from, p_to)
    )
    select jsonb_build_object(
      'rows', coalesce((select jsonb_agg(jsonb_build_object(
          'id', s.id, 'name', s.name, 'status', s.status, 'effective_status', s.effective_status, 'parent', s.parent,
          'thumbnail_url', s.thumbnail_url, 'objective', s.objective, 'daily_budget', s.daily_budget,
          'cost', s.cost, 'spend', s.spend, 'impressions', s.impressions, 'clicks', s.clicks, 'link_clicks', s.link_clicks,
          'meta_leads', s.meta_leads, 'registrations', s.registrations, 'messages', s.messages,
          'leads', s.leads, 'paying', s.paying, 'revenue', s.revenue,
          'cpl', case when s.leads > 0 then round(s.cost / s.leads, 2) end,
          'cost_per_paying', case when s.paying > 0 then round(s.cost / s.paying, 2) end,
          'roas', case when s.cost > 0 then round(s.revenue / s.cost, 2) end,
          'ctr', case when s.impressions > 0 then round(100.0 * s.link_clicks / s.impressions, 2) end,
          'cpc', case when s.link_clicks > 0 then round(s.cost / s.link_clicks, 2) end,
          'cpm', case when s.impressions > 0 then round(1000 * s.cost / s.impressions, 2) end)
        order by s.cost desc, s.leads desc, s.name) from shown s), '[]'::jsonb),
      'totals', (select jsonb_build_object(
          'cost', coalesce(sum(i.cost), 0), 'spend', coalesce(sum(i.spend), 0), 'impressions', coalesce(sum(i.impressions), 0),
          'clicks', coalesce(sum(i.clicks), 0), 'link_clicks', coalesce(sum(i.link_clicks), 0),
          'meta_leads', coalesce(sum(i.leads), 0), 'registrations', coalesce(sum(i.registrations), 0), 'messages', coalesce(sum(i.messages), 0))
        from public.platform_meta_insights i where i.date between p_from and p_to),
      'leads', (select jsonb_build_object(
          'total', count(*), 'meta', count(*) filter (where source = 'META_ADS'),
          'meta_paying', count(*) filter (where source = 'META_ADS' and paying),
          'meta_revenue', coalesce(sum(revenue) filter (where source = 'META_ADS'), 0),
          'meta_unmatched', count(*) filter (where source = 'META_ADS' and campaign_id is null),
          'paying', count(*) filter (where paying), 'revenue', coalesce(sum(revenue), 0),
          'by_source', coalesce((select jsonb_object_agg(src, n) from (select source as src, count(*) as n from all_leads group by source) z), '{}'::jsonb),
          'by_kind', coalesce((select jsonb_object_agg(k, n) from (select kind as k, count(*) as n from all_leads group by kind) z), '{}'::jsonb))
        from all_leads),
      'currency', (select string_agg(distinct a.currency, ',') from public.platform_ad_accounts a where a.currency is not null))
  );
end;
$$;

create or replace function public.platform_ads_leads(p_from date, p_to date, p_source text default null, p_campaign text default null, p_limit int default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._platform_require('finance', 'view');
  perform public._platform_finance_range(p_from, p_to);
  return coalesce((
    select jsonb_agg(jsonb_build_object('kind', l.kind, 'ref', l.ref, 'created_at', l.created_at, 'name', l.name, 'business', l.business,
             'phone', l.phone, 'email', l.email, 'status', l.status, 'merchant_id', l.merchant_id, 'merchant', l.merchant, 'source', l.source,
             'campaign_id', l.campaign_id, 'campaign', c.name, 'adset', s.name, 'ad', d.name, 'utm_campaign', l.utm_campaign, 'landing', l.landing,
             'paying', l.paying, 'revenue', l.revenue)
           order by l.created_at desc)
    from (select * from public._platform_leads(p_from, p_to) x
          where (p_source is null or x.source = p_source) and (p_campaign is null or x.campaign_id = p_campaign)
          order by x.created_at desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) l
    left join public.platform_meta_campaigns c on c.id = l.campaign_id
    left join public.platform_meta_adsets s on s.id = l.adset_id
    left join public.platform_meta_ads d on d.id = l.ad_id), '[]'::jsonb);
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Grants, global tables, exemptions
-- -----------------------------------------------------------------------------
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
               'platform_contact_messages', 'account_removals', 'signup_requests',
               'platform_finance_categories', 'platform_finance_entries', 'platform_ad_accounts',
               'platform_meta_campaigns', 'platform_meta_adsets', 'platform_meta_ads', 'platform_meta_insights', 'platform_lead_touches']
$$;

do $$
declare
  f text;
begin
  foreach f in array array['platform_ads_report(date,date,text,text)', 'platform_ads_leads(date,date,text,text,integer)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  execute 'revoke execute on function public.platform_meta_apply_sync(uuid,jsonb) from public, anon, authenticated';
  execute 'grant execute on function public.platform_meta_apply_sync(uuid,jsonb) to service_role';
  foreach f in array array['_platform_leads(date,date)', '_platform_lead_source(jsonb)', '_platform_lead_touch_clean(jsonb)', '_platform_lead_touch_one(jsonb)'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
  execute 'revoke execute on function public.public_lead_touch(text,text,jsonb) from public';
  execute 'grant execute on function public.public_lead_touch(text,text,jsonb) to anon, authenticated';
end $$;

insert into public.tenancy_exempt_functions (name, reason)
select f, 'Super Admin ads report: Fullfilio''s own campaigns and website leads (platform data), permission-checked'
from unnest(array['platform_meta_apply_sync', '_platform_lead_touch_clean', '_platform_lead_touch_one', '_platform_lead_source', '_platform_leads',
  'platform_ads_report', 'platform_ads_leads']) f
on conflict (name) do nothing;
insert into public.tenancy_exempt_functions (name, reason) values
  ('public_lead_touch', 'Website: how a visitor arrived, kept with their sign-up request or their own new store (platform data)')
on conflict (name) do nothing;

select public._tenancy_own_functions();
