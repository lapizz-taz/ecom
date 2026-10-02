-- =============================================================================
-- 1700 · Order source / marketing attribution and incomplete checkouts
--   * the storefront keeps the first touch and the last non-direct touch
--     (UTM tags, ad ids, click ids, referrer, landing page) and sends both
--     with the order; the database classifies them (Facebook Ads, Organic,
--     Direct, …) so every report uses the same rules
--   * an order without tracking data is "Unknown" — never a guessed ad source
--   * the visitor's journey (visits, product views, add to cart, checkout) is
--     summarised on the order
--   * checkouts that stop after the phone number are kept as incomplete orders
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Visitor journey events
-- -----------------------------------------------------------------------------
alter table public.storefront_events
  add column visitor_id text check (visitor_id is null or length(visitor_id) between 8 and 64),
  add column page_path text check (page_path is null or length(page_path) <= 300);
create index storefront_events_visitor_idx on public.storefront_events(visitor_id, created_at) where visitor_id is not null;

create or replace function public.track_visit_event(
  p_visitor_id text, p_session_id text, p_event_type text, p_product_id uuid default null, p_page text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_session_id is null or length(p_session_id) not between 8 and 64
     or p_visitor_id is null or length(p_visitor_id) not between 8 and 64
     or p_event_type not in ('PAGE_VIEW', 'VIEW_PRODUCT', 'ADD_TO_CART', 'BEGIN_CHECKOUT', 'PURCHASE') then
    return;
  end if;
  -- One page view per visit per page per minute keeps the table small.
  if p_event_type = 'PAGE_VIEW' and exists (
    select 1 from public.storefront_events
    where session_id = p_session_id and event_type = 'PAGE_VIEW' and page_path is not distinct from left(p_page, 300)
      and created_at > now() - interval '1 minute') then
    return;
  end if;
  insert into public.storefront_events(session_id, visitor_id, event_type, product_id, page_path)
  values (p_session_id, p_visitor_id, p_event_type, p_product_id, left(p_page, 300));
end;
$$;

-- -----------------------------------------------------------------------------
-- Touch classification (shared by checkout, reports and re-classification)
-- -----------------------------------------------------------------------------
create or replace function public.classify_touch(p_touch jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  p jsonb := coalesce(p_touch -> 'params', '{}'::jsonb);
  src text := lower(trim(coalesce(p ->> 'utm_source', '')));
  med text := lower(trim(coalesce(p ->> 'utm_medium', '')));
  site text := lower(coalesce(p ->> 'site_source_name', ''));
  placement text := lower(coalesce(p ->> 'placement', ''));
  host text := lower(coalesce(substring(p_touch ->> 'referrer' from '^[a-z0-9+.-]+://([^/:?#]+)'), ''));
  paid boolean := med ~ '^(cpc|ppc|paid|paid[_ -]?social|paid[_ -]?search|ads?|cpm|cpv|cpa|display|sponsored|boost(ed)?|retargeting|remarketing)$';
  meta_ids boolean := p ? 'ad_id' or p ? 'adset_id' or p ? 'campaign_id';
  meta_src boolean := src in ('facebook', 'fb', 'meta', 'ig', 'instagram', 'an', 'msg', 'messenger', 'audience_network');
  insta boolean := src in ('ig', 'instagram') or site = 'ig' or placement like 'instagram%';
  v_channel text;
  v_label text;
  v_medium text;
  v_paid boolean;
  v_platform text;
  v_click_type text := case when p ? 'fbclid' then 'fbclid' when p ? 'gclid' then 'gclid' when p ? 'gbraid' then 'gbraid'
    when p ? 'wbraid' then 'wbraid' when p ? 'ttclid' then 'ttclid' when p ? 'msclkid' then 'msclkid'
    when p ? 'srsltid' then 'srsltid' end;
begin
  if p_touch is null or jsonb_typeof(p_touch) <> 'object' then
    return jsonb_build_object('channel', 'unknown', 'source', 'Unknown', 'medium', 'Unknown', 'is_paid', null, 'platform', null);
  end if;

  if (meta_src and (paid or meta_ids)) or (p ? 'fbclid' and (paid or meta_ids)) then
    v_channel := 'paid_social'; v_paid := true; v_platform := 'META'; v_medium := 'Paid';
    v_label := case when insta then 'Instagram Ads' when site = 'msg' then 'Messenger Ads' else 'Facebook Ads' end;
  elsif p ? 'gclid' or p ? 'gbraid' or p ? 'wbraid' or (src in ('google', 'adwords', 'googleads', 'google_ads') and paid) then
    v_channel := 'paid_search'; v_paid := true; v_platform := 'GOOGLE'; v_medium := 'Paid'; v_label := 'Google Ads';
  elsif p ? 'ttclid' or (src in ('tiktok', 'tt') and paid) then
    v_channel := 'paid_social'; v_paid := true; v_platform := 'TIKTOK'; v_medium := 'Paid'; v_label := 'TikTok Ads';
  elsif p ? 'msclkid' or (src in ('bing', 'microsoft') and paid) then
    v_channel := 'paid_search'; v_paid := true; v_platform := 'OTHER'; v_medium := 'Paid'; v_label := 'Microsoft Ads';
  elsif paid and src <> '' then
    v_channel := 'paid_other'; v_paid := true; v_platform := 'OTHER'; v_medium := 'Paid'; v_label := initcap(src) || ' Ads';
  elsif p ? 'srsltid' then
    -- Google adds srsltid to free listings and organic results: organic, not an ad.
    v_channel := 'organic_search'; v_paid := false; v_medium := 'Organic'; v_label := 'Google';
  elsif src <> '' then
    v_paid := false;
    if meta_src then
      v_channel := 'organic_social'; v_medium := 'Organic'; v_label := case when insta then 'Instagram' when src in ('msg', 'messenger') then 'Messenger' else 'Facebook' end;
    elsif src in ('whatsapp', 'wa') then v_channel := 'messaging'; v_medium := 'Messaging'; v_label := 'WhatsApp';
    elsif src in ('google', 'bing', 'yahoo', 'duckduckgo', 'yandex') then v_channel := 'organic_search'; v_medium := 'Organic'; v_label := initcap(src);
    elsif src in ('email', 'newsletter', 'mailchimp', 'klaviyo') or med = 'email' then v_channel := 'email'; v_medium := 'Email'; v_label := 'Email';
    elsif src = 'sms' or med = 'sms' then v_channel := 'sms'; v_medium := 'SMS'; v_label := 'SMS';
    elsif src in ('tiktok', 'youtube', 'twitter', 'x', 'linkedin', 'pinterest', 'threads') then
      v_channel := 'organic_social'; v_medium := 'Organic'; v_label := case src when 'x' then 'X' when 'tiktok' then 'TikTok' when 'youtube' then 'YouTube' else initcap(src) end;
    else v_channel := 'referral'; v_medium := 'Referral'; v_label := initcap(src);
    end if;
  elsif p ? 'fbclid' then
    -- Facebook adds fbclid to every outbound link, ads and posts alike: without
    -- ad tags we only know it came from Facebook, not that it was an ad.
    v_channel := 'social'; v_paid := null; v_medium := 'Social (paid or organic)'; v_label := 'Facebook';
  elsif host <> '' then
    v_paid := false;
    if host ~ '(^|\.)(facebook\.com|fb\.com|fb\.me)$' or host like '%com.facebook.%' then v_channel := 'organic_social'; v_medium := 'Organic'; v_label := 'Facebook';
    elsif host ~ '(^|\.)instagram\.com$' or host like '%com.instagram.%' then v_channel := 'organic_social'; v_medium := 'Organic'; v_label := 'Instagram';
    elsif host ~ '(^|\.)(messenger\.com|m\.me)$' then v_channel := 'messaging'; v_medium := 'Messaging'; v_label := 'Messenger';
    elsif host ~ '(^|\.)(whatsapp\.com|wa\.me)$' then v_channel := 'messaging'; v_medium := 'Messaging'; v_label := 'WhatsApp';
    elsif host ~ '(^|\.)google\.[a-z.]+$' or host like '%com.google.%' then v_channel := 'organic_search'; v_medium := 'Organic'; v_label := 'Google';
    elsif host ~ '(^|\.)(bing\.com|duckduckgo\.com|search\.yahoo\.com|yandex\.[a-z]+|baidu\.com)$' then
      v_channel := 'organic_search'; v_medium := 'Organic'; v_label := initcap(split_part(regexp_replace(host, '^(www|search)\.', ''), '.', 1));
    elsif host ~ '(^|\.)(youtube\.com|youtu\.be)$' then v_channel := 'organic_social'; v_medium := 'Organic'; v_label := 'YouTube';
    elsif host ~ '(^|\.)tiktok\.com$' then v_channel := 'organic_social'; v_medium := 'Organic'; v_label := 'TikTok';
    elsif host ~ '(^|\.)(t\.co|twitter\.com|x\.com)$' then v_channel := 'organic_social'; v_medium := 'Organic'; v_label := 'X';
    else v_channel := 'referral'; v_medium := 'Referral'; v_label := regexp_replace(host, '^www\.', '');
    end if;
  else
    v_channel := 'direct'; v_paid := false; v_medium := 'Direct'; v_label := 'Direct';
  end if;

  return jsonb_build_object(
    'channel', v_channel, 'source', v_label, 'medium', v_medium, 'is_paid', v_paid, 'platform', v_platform,
    'click_id_type', v_click_type, 'click_id', case when v_click_type is not null then left(p ->> v_click_type, 200) end,
    'campaign', nullif(coalesce(p ->> 'campaign_name', p ->> 'utm_campaign'), ''),
    'adset', nullif(coalesce(p ->> 'adset_name', case when v_channel = 'paid_social' then p ->> 'utm_term' end), ''),
    'ad', nullif(coalesce(p ->> 'ad_name', case when v_channel = 'paid_social' then p ->> 'utm_content' end), ''),
    'campaign_id', nullif(p ->> 'campaign_id', ''), 'adset_id', nullif(p ->> 'adset_id', ''), 'ad_id', nullif(p ->> 'ad_id', ''),
    'referrer_host', nullif(host, ''));
end;
$$;

-- -----------------------------------------------------------------------------
-- Order attribution
-- -----------------------------------------------------------------------------
create table public.order_attributions (
  order_id uuid primary key references public.orders(id) on delete cascade,
  channel text not null default 'unknown',
  source text not null default 'Unknown',
  medium text,
  is_paid boolean,
  platform public.marketing_platform,
  campaign text,
  adset text,
  ad text,
  campaign_id text,
  adset_id text,
  ad_id text,
  click_id_type text,
  click_id text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  landing_page text,
  referrer_host text,
  first_channel text,
  first_source text,
  first_touch jsonb,
  last_touch jsonb,
  first_touch_at timestamptz,
  last_touch_at timestamptz,
  visitor_id text,
  session_id text,
  journey jsonb not null default '{}'::jsonb,
  marketing_campaign_id uuid references public.marketing_campaigns(id) on delete set null,
  recorded_by text not null default 'STOREFRONT' check (recorded_by in ('STOREFRONT', 'STAFF', 'SYSTEM')),
  note text,
  attributed_at timestamptz not null default now()
);
create index order_attributions_channel_idx on public.order_attributions(channel, source);
create index order_attributions_campaign_idx on public.order_attributions(platform, campaign_id) where campaign_id is not null;
create index order_attributions_ad_idx on public.order_attributions(ad_id) where ad_id is not null;
create index order_attributions_visitor_idx on public.order_attributions(visitor_id) where visitor_id is not null;

-- Stores attribution for an order from what the storefront collected.
-- p_attribution: { visitor_id, session_id, first_touch, last_touch }
create or replace function public.record_order_attribution(p_order_id uuid, p_attribution jsonb)
returns public.order_attributions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.order_attributions;
  v_first jsonb := case when jsonb_typeof(p_attribution -> 'first_touch') = 'object' then p_attribution -> 'first_touch' end;
  v_last jsonb := case when jsonb_typeof(p_attribution -> 'last_touch') = 'object' then p_attribution -> 'last_touch' end;
  v_visitor text := nullif(left(p_attribution ->> 'visitor_id', 64), '');
  v_session text := nullif(left(p_attribution ->> 'session_id', 64), '');
  v_c jsonb;
  v_fc jsonb;
  v_params jsonb;
  v_journey jsonb := '{}'::jsonb;
  v_order public.orders;
  v_campaign uuid;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select * into v_order from public.orders where id = p_order_id;
  if not found then
    raise exception 'NOT_FOUND: order not found' using errcode = 'P0002';
  end if;
  if length(coalesce(p_attribution, '{}'::jsonb)::text) > 20000 then
    raise exception 'VALIDATION: attribution data is too large' using errcode = '22023';
  end if;

  -- No ad, tagged link or referral within the window: a known visitor is direct;
  -- no data at all is unknown.
  v_c := case
    when v_last is not null then public.classify_touch(v_last)
    when v_first is not null or v_visitor is not null then public.classify_touch(jsonb_build_object('params', '{}'::jsonb))
    else public.classify_touch(null) end;
  v_fc := case when v_first is not null then public.classify_touch(v_first) end;
  v_params := coalesce(v_last -> 'params', '{}'::jsonb);

  if v_visitor is not null then
    select jsonb_build_object(
      'visits', count(distinct session_id),
      'page_views', count(*) filter (where event_type = 'PAGE_VIEW'),
      'product_views', count(*) filter (where event_type = 'VIEW_PRODUCT'),
      'add_to_cart', count(*) filter (where event_type = 'ADD_TO_CART'),
      'checkouts', count(*) filter (where event_type = 'BEGIN_CHECKOUT'),
      'first_seen_at', min(created_at),
      'last_seen_at', max(created_at))
    into v_journey
    from public.storefront_events
    where visitor_id = v_visitor and created_at between v_order.created_at - interval '30 days' and v_order.created_at + interval '5 minutes';
  end if;

  if v_c ->> 'campaign_id' is not null then
    select id into v_campaign from public.marketing_campaigns
    where platform = (v_c ->> 'platform')::public.marketing_platform and external_id = v_c ->> 'campaign_id';
  end if;
  if v_campaign is null and v_c ->> 'campaign' is not null then
    select id into v_campaign from public.marketing_campaigns where utm_campaign = v_c ->> 'campaign' limit 1;
  end if;

  insert into public.order_attributions(
    order_id, channel, source, medium, is_paid, platform, campaign, adset, ad, campaign_id, adset_id, ad_id,
    click_id_type, click_id, utm_source, utm_medium, utm_campaign, utm_content, utm_term, landing_page, referrer_host,
    first_channel, first_source, first_touch, last_touch, first_touch_at, last_touch_at, visitor_id, session_id,
    journey, marketing_campaign_id, recorded_by
  ) values (
    p_order_id, v_c ->> 'channel', v_c ->> 'source', v_c ->> 'medium', (v_c ->> 'is_paid')::boolean,
    (v_c ->> 'platform')::public.marketing_platform, left(v_c ->> 'campaign', 200), left(v_c ->> 'adset', 200), left(v_c ->> 'ad', 200),
    left(v_c ->> 'campaign_id', 64), left(v_c ->> 'adset_id', 64), left(v_c ->> 'ad_id', 64),
    v_c ->> 'click_id_type', v_c ->> 'click_id',
    left(v_params ->> 'utm_source', 120), left(v_params ->> 'utm_medium', 120), left(v_params ->> 'utm_campaign', 200),
    left(v_params ->> 'utm_content', 200), left(v_params ->> 'utm_term', 200),
    left(coalesce(v_last ->> 'landing', v_first ->> 'landing'), 300), v_c ->> 'referrer_host',
    coalesce(v_fc ->> 'channel', v_c ->> 'channel'), coalesce(v_fc ->> 'source', v_c ->> 'source'), v_first, v_last,
    (v_first ->> 'at')::timestamptz, (v_last ->> 'at')::timestamptz, v_visitor, v_session,
    coalesce(v_journey, '{}'::jsonb), v_campaign, 'STOREFRONT'
  )
  on conflict (order_id) do nothing
  returning * into v_row;

  if v_row.order_id is not null then
    update public.orders set
      utm_source = coalesce(utm_source, left(v_params ->> 'utm_source', 120)),
      utm_medium = coalesce(utm_medium, left(v_params ->> 'utm_medium', 120)),
      utm_campaign = coalesce(utm_campaign, left(v_params ->> 'utm_campaign', 200))
    where id = p_order_id;
  else
    select * into v_row from public.order_attributions where order_id = p_order_id;
  end if;
  return v_row;
end;
$$;

-- Staff set the source of an order they took by phone, chat or in person.
create or replace function public.admin_set_order_source(p_order_id uuid, p_source text, p_note text default null)
returns public.order_attributions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.order_attributions;
  v_channel text;
  v_label text;
  v_old jsonb;
begin
  perform public.require_permission('orders.update');
  select case p_source
      when 'MESSENGER' then 'messaging' when 'WHATSAPP' then 'messaging' when 'PHONE' then 'phone'
      when 'FACEBOOK_COMMENT' then 'organic_social' when 'INSTAGRAM_DM' then 'messaging' when 'WALK_IN' then 'offline'
      when 'REFERRAL' then 'referral' when 'REPEAT_CUSTOMER' then 'direct' when 'OTHER' then 'other' end,
    case p_source
      when 'MESSENGER' then 'Messenger' when 'WHATSAPP' then 'WhatsApp' when 'PHONE' then 'Phone call'
      when 'FACEBOOK_COMMENT' then 'Facebook' when 'INSTAGRAM_DM' then 'Instagram' when 'WALK_IN' then 'Walk-in'
      when 'REFERRAL' then 'Referral' when 'REPEAT_CUSTOMER' then 'Repeat customer' when 'OTHER' then 'Other' end
  into v_channel, v_label;
  if v_channel is null then
    raise exception 'VALIDATION: choose where this order came from' using errcode = '22023';
  end if;
  select to_jsonb(a) into v_old from public.order_attributions a where order_id = p_order_id;
  if v_old is not null and v_old ->> 'recorded_by' = 'STOREFRONT' and v_old ->> 'channel' not in ('unknown', 'direct') then
    raise exception 'VALIDATION: this order already has tracked source data (%)', v_old ->> 'source' using errcode = '22023';
  end if;
  insert into public.order_attributions(order_id, channel, source, medium, is_paid, recorded_by, note, first_channel, first_source)
  values (p_order_id, v_channel, v_label, 'Manual', false, 'STAFF', left(p_note, 300), v_channel, v_label)
  on conflict (order_id) do update set channel = excluded.channel, source = excluded.source, medium = excluded.medium,
    is_paid = excluded.is_paid, recorded_by = 'STAFF', note = excluded.note, attributed_at = now()
  returning * into v_row;
  perform public._order_log(p_order_id, 'SOURCE_SET', format('Order source set to %s', v_label), null, null,
    jsonb_build_object('source', v_label, 'note', p_note));
  perform public.log_audit('order.source_set', 'order', p_order_id::text, v_old, to_jsonb(v_row));
  return v_row;
end;
$$;

-- Existing orders: what their UTM columns say, otherwise unknown.
insert into public.order_attributions(order_id, channel, source, medium, is_paid, platform, campaign, utm_source, utm_medium,
  utm_campaign, recorded_by)
select o.id, c ->> 'channel', c ->> 'source', c ->> 'medium', (c ->> 'is_paid')::boolean, (c ->> 'platform')::public.marketing_platform,
  c ->> 'campaign', o.utm_source, o.utm_medium, o.utm_campaign, 'SYSTEM'
from public.orders o
cross join lateral (select case when o.utm_source is not null or o.utm_campaign is not null
  then public.classify_touch(jsonb_build_object('params', jsonb_strip_nulls(jsonb_build_object(
    'utm_source', o.utm_source, 'utm_medium', o.utm_medium, 'utm_campaign', o.utm_campaign))))
  else public.classify_touch(null) end as c) x
on conflict (order_id) do nothing;

-- -----------------------------------------------------------------------------
-- Incomplete checkouts (customer typed a phone number but did not order)
-- -----------------------------------------------------------------------------
update public.settings set value = value || jsonb_build_object('capture_incomplete', true)
where key = 'orders' and not (value ? 'capture_incomplete');
update public.settings set value = value || jsonb_build_object('whatsapp', '')
where key = 'store' and not (value ? 'whatsapp');

create table public.checkout_leads (
  id uuid primary key default gen_random_uuid(),
  visitor_id text not null check (length(visitor_id) between 8 and 64),
  phone text not null check (phone ~ '^[0-9]{6,15}$'),
  customer_name text,
  address text,
  district text,
  area text,
  items jsonb not null default '[]'::jsonb,
  subtotal numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  attribution jsonb,
  source text,
  status text not null default 'OPEN' check (status in ('OPEN', 'CONTACTED', 'CONVERTED', 'DISMISSED')),
  order_id uuid references public.orders(id) on delete set null,
  contact_count int not null default 0,
  last_contacted_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index checkout_leads_open_visitor_idx on public.checkout_leads(visitor_id) where status in ('OPEN', 'CONTACTED');
create index checkout_leads_status_idx on public.checkout_leads(status, updated_at desc);
create index checkout_leads_phone_idx on public.checkout_leads(phone);

-- Saved from the checkout as the customer fills it in (service role only).
create or replace function public.capture_checkout_lead(p_input jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_visitor text := nullif(left(p_input ->> 'visitor_id', 64), '');
  v_phone text := public.clean_phone(p_input ->> 'phone');
  v_id uuid;
  v_items jsonb := coalesce(p_input -> 'items', '[]'::jsonb);
  v_source text;
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if not public.setting_bool('orders', array['capture_incomplete'], true)
     or v_visitor is null or length(v_visitor) < 8 or v_phone is null
     or jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) = 0 or jsonb_array_length(v_items) > 50 then
    return null;
  end if;
  -- Already ordered a moment ago: not an abandoned checkout.
  if exists (select 1 from public.orders where customer_phone = v_phone and created_at > now() - interval '30 minutes') then
    return null;
  end if;
  v_source := case when jsonb_typeof(p_input -> 'attribution' -> 'last_touch') = 'object'
    then public.classify_touch(p_input -> 'attribution' -> 'last_touch') ->> 'source' else 'Direct' end;

  insert into public.checkout_leads(visitor_id, phone, customer_name, address, district, area, items, subtotal, total, attribution, source)
  values (v_visitor, v_phone, left(nullif(trim(p_input ->> 'customer_name'), ''), 100), left(nullif(trim(p_input ->> 'address'), ''), 300),
    left(nullif(trim(p_input ->> 'district'), ''), 60), left(nullif(trim(p_input ->> 'area'), ''), 80), v_items,
    coalesce((p_input ->> 'subtotal')::numeric, 0), coalesce((p_input ->> 'total')::numeric, 0),
    case when length(coalesce(p_input -> 'attribution', 'null'::jsonb)::text) <= 20000 then p_input -> 'attribution' end, v_source)
  on conflict (visitor_id) where status in ('OPEN', 'CONTACTED') do update set
    phone = excluded.phone,
    customer_name = coalesce(excluded.customer_name, public.checkout_leads.customer_name),
    address = coalesce(excluded.address, public.checkout_leads.address),
    district = coalesce(excluded.district, public.checkout_leads.district),
    area = coalesce(excluded.area, public.checkout_leads.area),
    items = excluded.items, subtotal = excluded.subtotal, total = excluded.total,
    attribution = coalesce(excluded.attribution, public.checkout_leads.attribution),
    source = excluded.source, updated_at = now()
  returning id into v_id;
  return v_id;
end;
$$;

-- Marks the visitor's (or phone's) open incomplete checkout as converted.
create or replace function public.convert_checkout_lead(p_visitor_id text, p_phone text, p_order_id uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int;
begin
  if not (public.is_system_context() or public.has_permission('orders.create')) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.checkout_leads set status = 'CONVERTED', order_id = p_order_id, updated_at = now()
  where status in ('OPEN', 'CONTACTED')
    and (visitor_id = p_visitor_id or (phone = public.clean_phone(p_phone) and updated_at > now() - interval '7 days'));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Staff: call log and status for an incomplete checkout.
create or replace function public.admin_update_checkout_lead(p_id uuid, p_status text, p_note text default null)
returns public.checkout_leads
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.checkout_leads;
begin
  perform public.require_permission('orders.update');
  if p_status not in ('OPEN', 'CONTACTED', 'DISMISSED') then
    raise exception 'VALIDATION: unknown status' using errcode = '22023';
  end if;
  update public.checkout_leads set
    status = p_status,
    contact_count = contact_count + case when p_status = 'CONTACTED' then 1 else 0 end,
    last_contacted_at = case when p_status = 'CONTACTED' then now() else last_contacted_at end,
    notes = case when nullif(trim(p_note), '') is null then notes
      else concat_ws(E'\n', notes, to_char(now() at time zone public.store_timezone(), 'DD Mon HH24:MI') || ' — ' || trim(p_note)) end,
    updated_at = now()
  where id = p_id and status <> 'CONVERTED'
  returning * into v_row;
  if not found then
    raise exception 'NOT_FOUND: incomplete checkout not found or already ordered' using errcode = 'P0002';
  end if;
  perform public.log_audit('checkout_lead.updated', 'checkout_lead', p_id::text, null, jsonb_build_object('status', p_status));
  return v_row;
end;
$$;

-- -----------------------------------------------------------------------------
-- RLS and grants
-- -----------------------------------------------------------------------------
alter table public.order_attributions enable row level security;
alter table public.checkout_leads enable row level security;
create policy order_attributions_read on public.order_attributions for select to authenticated
  using ((select public.has_permission('orders.view')));
create policy checkout_leads_read on public.checkout_leads for select to authenticated
  using ((select public.has_permission('orders.view')));
revoke all on public.order_attributions, public.checkout_leads from anon, authenticated;
grant select on public.order_attributions, public.checkout_leads to authenticated;
grant all on public.order_attributions, public.checkout_leads to service_role;

revoke execute on function public.track_visit_event(text, text, text, uuid, text), public.classify_touch(jsonb),
  public.record_order_attribution(uuid, jsonb), public.admin_set_order_source(uuid, text, text),
  public.capture_checkout_lead(jsonb), public.convert_checkout_lead(text, text, uuid),
  public.admin_update_checkout_lead(uuid, text, text)
from public, anon, authenticated;
grant execute on function public.track_visit_event(text, text, text, uuid, text), public.classify_touch(jsonb),
  public.record_order_attribution(uuid, jsonb), public.admin_set_order_source(uuid, text, text),
  public.capture_checkout_lead(jsonb), public.convert_checkout_lead(text, text, uuid),
  public.admin_update_checkout_lead(uuid, text, text)
to service_role;
grant execute on function public.track_visit_event(text, text, text, uuid, text) to anon, authenticated;
grant execute on function public.classify_touch(jsonb), public.admin_set_order_source(uuid, text, text),
  public.convert_checkout_lead(text, text, uuid), public.admin_update_checkout_lead(uuid, text, text) to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.checkout_leads;
  end if;
end $$;
