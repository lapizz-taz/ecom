-- =============================================================================
-- 0800 · Marketing spend, notifications, storefront read API, customers admin
-- =============================================================================

create table public.marketing_campaigns (
  id uuid primary key default gen_random_uuid(),
  platform public.marketing_platform not null,
  name text not null check (length(trim(name)) > 0),
  external_id text,
  utm_campaign text,
  status public.campaign_status not null default 'ACTIVE',
  start_date date,
  end_date date,
  budget numeric(12,2) check (budget is null or budget >= 0),
  notes text,
  source public.data_source not null default 'MANUAL',
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (platform, external_id)
);
create index marketing_campaigns_utm_idx on public.marketing_campaigns(utm_campaign);
create trigger marketing_campaigns_updated_at before update on public.marketing_campaigns
  for each row execute function public.set_updated_at();

create table public.marketing_spend (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.marketing_campaigns(id) on delete restrict,
  spend_date date not null,
  spend numeric(12,2) not null check (spend >= 0),
  impressions int check (impressions is null or impressions >= 0),
  clicks int check (clicks is null or clicks >= 0),
  orders int not null default 0 check (orders >= 0),
  revenue numeric(12,2) not null default 0 check (revenue >= 0),
  notes text,
  source public.data_source not null default 'MANUAL',
  external_ref text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, spend_date)
);
create index marketing_spend_date_idx on public.marketing_spend(spend_date desc);
create trigger marketing_spend_updated_at before update on public.marketing_spend
  for each row execute function public.set_updated_at();

-- Ad spend is an advertising expense: post it (and every correction) to the
-- ledger automatically so nobody enters it twice.
create or replace function public.marketing_spend_to_finance()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_delta numeric;
  v_row public.marketing_spend := coalesce(new, old);
  v_campaign text;
begin
  if not public.setting_bool('finance', array['post_ad_spend_to_expenses'], true) then
    return coalesce(new, old);
  end if;
  v_delta := case tg_op when 'INSERT' then new.spend when 'DELETE' then -old.spend else new.spend - old.spend end;
  if v_delta = 0 then
    return coalesce(new, old);
  end if;
  select platform || ' · ' || name into v_campaign from public.marketing_campaigns where id = v_row.campaign_id;
  perform public._post_finance('EXPENSE', 'ADVERTISING', v_delta, v_row.spend_date, true, null, null, null,
    v_campaign, case tg_op when 'INSERT' then 'Ad spend' else 'Ad spend correction' end,
    'marketing_spend:' || v_row.id || ':' || case tg_op when 'INSERT' then 'initial' else gen_random_uuid()::text end,
    null);
  return coalesce(new, old);
end;
$$;
create trigger marketing_spend_finance after insert or update of spend or delete on public.marketing_spend
  for each row execute function public.marketing_spend_to_finance();

create or replace view public.marketing_campaign_performance
with (security_invoker = true) as
select
  c.id as campaign_id,
  c.platform,
  c.name,
  c.status,
  c.utm_campaign,
  c.start_date,
  c.end_date,
  coalesce(s.spend, 0) as spend,
  coalesce(s.orders, 0) as reported_orders,
  coalesce(s.revenue, 0) as reported_revenue,
  coalesce(a.orders, 0) as attributed_orders,
  coalesce(a.revenue, 0) as attributed_revenue,
  coalesce(a.gross_profit, 0) as attributed_gross_profit,
  case when coalesce(s.spend, 0) > 0 then round(coalesce(s.revenue, 0) / s.spend, 2) end as roas,
  case when coalesce(s.orders, 0) > 0 then round(s.spend / s.orders, 2) end as cpa,
  case when coalesce(s.orders, 0) + coalesce(a.orders, 0) > 0
    then round(coalesce(s.spend, 0) / greatest(coalesce(s.orders, 0), coalesce(a.orders, 0)), 2) end as cost_per_order,
  case when coalesce(s.spend, 0) > 0 and a.revenue is not null then round(a.revenue / s.spend, 2) end as attributed_roas,
  coalesce(a.gross_profit, 0) - coalesce(s.spend, 0) as profit_after_ad_spend
from public.marketing_campaigns c
left join (
  select campaign_id, sum(spend) as spend, sum(orders) as orders, sum(revenue) as revenue
  from public.marketing_spend group by campaign_id
) s on s.campaign_id = c.id
left join (
  select o.utm_campaign, count(*) as orders, sum(o.total_amount) as revenue,
         sum(o.subtotal - o.discount_total - o.cost_total) as gross_profit
  from public.orders o
  where o.utm_campaign is not null and o.status in ('DELIVERED', 'RETURN_REQUESTED') and o.delivered_at is not null
  group by o.utm_campaign
) a on a.utm_campaign = c.utm_campaign;

-- -----------------------------------------------------------------------------
-- Notifications (provider-agnostic). Templates per event + channel; every
-- message is queued in notification_logs and sent by the dispatch function.
-- -----------------------------------------------------------------------------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  event public.notification_event not null,
  channel public.notification_channel not null,
  is_enabled boolean not null default false,
  subject text,
  template text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event, channel)
);
create trigger notifications_updated_at before update on public.notifications
  for each row execute function public.set_updated_at();
create trigger notifications_audit after insert or update or delete on public.notifications
  for each row execute function public.audit_row_change();

create table public.notification_logs (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid references public.notifications(id) on delete set null,
  event public.notification_event not null,
  channel public.notification_channel not null,
  recipient text not null,
  subject text,
  body text not null,
  status public.notification_status not null default 'QUEUED',
  provider text,
  provider_message_id text,
  error text,
  attempts int not null default 0,
  order_id uuid references public.orders(id) on delete set null,
  customer_id uuid references public.customers(id) on delete set null,
  next_attempt_at timestamptz not null default now(),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index notification_logs_queue_idx on public.notification_logs(next_attempt_at) where status = 'QUEUED';
create index notification_logs_order_idx on public.notification_logs(order_id);
create index notification_logs_created_idx on public.notification_logs(created_at desc);
create trigger notification_logs_updated_at before update on public.notification_logs
  for each row execute function public.set_updated_at();

create or replace function public.render_template(p_template text, p_vars jsonb)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_out text := coalesce(p_template, '');
  v_key text;
begin
  for v_key in select jsonb_object_keys(coalesce(p_vars, '{}'::jsonb)) loop
    v_out := replace(v_out, '{{' || v_key || '}}', coalesce(p_vars ->> v_key, ''));
  end loop;
  return regexp_replace(v_out, '\{\{[a-z_]+\}\}', '', 'g');
end;
$$;

create or replace function public._enqueue_order_notification(p_order_id uuid, p_event public.notification_event)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_tpl public.notifications;
  v_vars jsonb;
  v_recipient text;
  v_count int := 0;
  v_symbol text := public.setting_text('store', array['currency_symbol'], '৳');
  v_ship record;
begin
  if not public.setting_bool('notifications', array['enabled'], true) then
    return 0;
  end if;
  select * into v_order from public.orders where id = p_order_id;
  if not found then
    return 0;
  end if;
  select s.tracking_number, c.name as courier_name,
         case when c.tracking_url_template is not null and s.tracking_number is not null
              then replace(c.tracking_url_template, '{tracking}', s.tracking_number) end as tracking_url
  into v_ship
  from public.shipments s join public.couriers c on c.id = s.courier_id
  where s.order_id = p_order_id and s.is_active;

  v_vars := jsonb_build_object(
    'store_name', public.setting_text('store', array['name'], 'Our store'),
    'store_phone', public.setting_text('store', array['phone'], ''),
    'order_number', v_order.order_number,
    'customer_name', v_order.customer_name,
    'total', v_symbol || trim(to_char(v_order.total_amount, 'FM999,999,990.##')),
    'advance_amount', v_symbol || trim(to_char(greatest(v_order.advance_required - v_order.amount_paid, 0), 'FM999,999,990.##')),
    'cod_amount', v_symbol || trim(to_char(v_order.cod_amount, 'FM999,999,990.##')),
    'tracking_number', coalesce(v_ship.tracking_number, ''),
    'courier_name', coalesce(v_ship.courier_name, ''),
    'tracking_url', coalesce(v_ship.tracking_url, ''),
    'track_order_url', public.setting_text('store', array['website_url'], '') || '/track-order?order=' || v_order.order_number
  );

  for v_tpl in select * from public.notifications where event = p_event and is_enabled loop
    if not public.setting_bool('notifications', array['channels', lower(v_tpl.channel::text), 'enabled'], false) then
      continue;
    end if;
    v_recipient := case v_tpl.channel when 'EMAIL' then v_order.customer_email else v_order.customer_phone end;
    if v_recipient is null then
      continue;
    end if;
    insert into public.notification_logs(notification_id, event, channel, recipient, subject, body, order_id, customer_id,
                                         provider)
    values (v_tpl.id, p_event, v_tpl.channel, v_recipient, public.render_template(v_tpl.subject, v_vars),
            public.render_template(v_tpl.template, v_vars), p_order_id, v_order.customer_id,
            public.setting_text('notifications', array['channels', lower(v_tpl.channel::text), 'provider'], 'console'));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Dispatcher API (service role): claim a batch, then report each result.
create or replace function public.claim_notifications(p_limit int default 20)
returns setof public.notification_logs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query
  update public.notification_logs n set status = 'SENDING', attempts = attempts + 1
  where n.id in (
    select id from public.notification_logs
    where status = 'QUEUED' and next_attempt_at <= now()
    order by next_attempt_at
    limit least(greatest(p_limit, 1), 100)
    for update skip locked
  )
  returning n.*;
end;
$$;

create or replace function public.complete_notification(
  p_id uuid, p_success boolean, p_provider text, p_provider_message_id text, p_error text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_system_context() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.notification_logs set
    status = case when p_success then 'SENT' when attempts >= 3 then 'FAILED' else 'QUEUED' end::public.notification_status,
    provider = coalesce(p_provider, provider),
    provider_message_id = p_provider_message_id,
    error = case when p_success then null else left(p_error, 1000) end,
    sent_at = case when p_success then now() else sent_at end,
    next_attempt_at = case when p_success then next_attempt_at else now() + make_interval(mins => 5 * attempts) end
  where id = p_id;
end;
$$;

create or replace function public.retry_notification(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('settings.manage');
  update public.notification_logs set status = 'QUEUED', next_attempt_at = now(), attempts = 0, error = null
  where id = p_id and status in ('FAILED', 'SKIPPED');
end;
$$;

-- -----------------------------------------------------------------------------
-- Storefront support tables
-- -----------------------------------------------------------------------------
create table public.contact_messages (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 2 and 120),
  phone text,
  email text,
  subject text,
  message text not null check (length(message) between 5 and 4000),
  is_resolved boolean not null default false,
  created_at timestamptz not null default now()
);
create index contact_messages_created_idx on public.contact_messages(created_at desc);

-- Lightweight first-party analytics for conversion rate.
create table public.storefront_events (
  id bigint generated always as identity primary key,
  session_id text not null check (length(session_id) between 8 and 64),
  event_type text not null check (event_type in ('PAGE_VIEW', 'VIEW_PRODUCT', 'ADD_TO_CART', 'BEGIN_CHECKOUT', 'PURCHASE')),
  product_id uuid,
  order_id uuid,
  utm_source text,
  utm_campaign text,
  created_at timestamptz not null default now()
);
create index storefront_events_created_idx on public.storefront_events(created_at, event_type);

create or replace function public.track_storefront_event(
  p_session_id text, p_event_type text, p_product_id uuid default null,
  p_utm_source text default null, p_utm_campaign text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_session_id is null or length(p_session_id) not between 8 and 64 then
    return;
  end if;
  -- One page view per session per minute keeps the table small.
  if p_event_type = 'PAGE_VIEW' and exists (
    select 1 from public.storefront_events
    where session_id = p_session_id and event_type = 'PAGE_VIEW' and created_at > now() - interval '1 minute') then
    return;
  end if;
  insert into public.storefront_events(session_id, event_type, product_id, utm_source, utm_campaign)
  values (p_session_id, p_event_type, p_product_id, left(p_utm_source, 100), left(p_utm_campaign, 100));
end;
$$;

create or replace function public.submit_contact_message(p_name text, p_phone text, p_email text, p_subject text, p_message text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if length(trim(coalesce(p_name, ''))) < 2 or length(trim(coalesce(p_message, ''))) < 5 then
    raise exception 'VALIDATION: please enter your name and a message' using errcode = '22023';
  end if;
  if coalesce(p_phone, '') = '' and coalesce(p_email, '') = '' then
    raise exception 'VALIDATION: please enter a phone number or email so we can reply' using errcode = '22023';
  end if;
  insert into public.contact_messages(name, phone, email, subject, message)
  values (trim(p_name), nullif(public.clean_phone(p_phone), ''), nullif(lower(trim(coalesce(p_email, ''))), ''),
          nullif(trim(coalesce(p_subject, '')), ''), trim(p_message));
end;
$$;

-- -----------------------------------------------------------------------------
-- Storefront read API (anon). Only public fields — never cost prices.
-- -----------------------------------------------------------------------------
create or replace function public._storefront_product_card(p public.products)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', p.id,
    'name', p.name,
    'slug', p.slug,
    'brand', p.brand,
    'tags', to_jsonb(p.tags),
    'category', (select jsonb_build_object('name', c.name, 'slug', c.slug) from public.categories c where c.id = p.category_id),
    'price', coalesce((select min(coalesce(v.price, p.price)) from public.product_variants v where v.product_id = p.id and v.is_active), p.price),
    'max_price', coalesce((select max(coalesce(v.price, p.price)) from public.product_variants v where v.product_id = p.id and v.is_active), p.price),
    'compare_at_price', coalesce(
      (select max(coalesce(v.compare_at_price, p.compare_at_price)) from public.product_variants v where v.product_id = p.id and v.is_active),
      p.compare_at_price),
    'image', (select jsonb_build_object('url', i.url, 'alt', coalesce(i.alt, p.name))
              from public.product_images i where i.product_id = p.id order by i.is_primary desc, i.position limit 1),
    'in_stock', (not p.track_inventory) or public.allow_overselling() or exists (
      select 1 from public.product_variants v join public.inventory inv on inv.variant_id = v.id
      where v.product_id = p.id and v.is_active and inv.available > 0),
    'is_featured', p.is_featured,
    'created_at', p.created_at
  )
$$;

create or replace function public.storefront_list_products(
  p_category text default null,
  p_search text default null,
  p_sort text default 'newest',
  p_min_price numeric default null,
  p_max_price numeric default null,
  p_in_stock boolean default false,
  p_tag text default null,
  p_featured boolean default false,
  p_limit int default 24,
  p_offset int default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
  v_q text := nullif(trim(coalesce(p_search, '')), '');
begin
  with base as (
    select p.*, coalesce((select min(coalesce(v.price, p.price)) from public.product_variants v
                          where v.product_id = p.id and v.is_active), p.price) as eff_price
    from public.products p
    left join public.categories c on c.id = p.category_id
    where p.status = 'ACTIVE'
      and (p_category is null or c.slug = p_category
           or c.parent_id in (select id from public.categories where slug = p_category))
      and (v_q is null or p.name ilike '%' || v_q || '%' or p.brand ilike '%' || v_q || '%'
           or exists (select 1 from unnest(p.tags) t where t ilike v_q || '%')
           or exists (select 1 from public.product_variants v where v.product_id = p.id and v.is_active and v.sku ilike v_q || '%'))
      and (p_tag is null or p_tag = any(p.tags))
      and (not p_featured or p.is_featured)
  ), filtered as (
    select * from base b
    where (p_min_price is null or b.eff_price >= p_min_price)
      and (p_max_price is null or b.eff_price <= p_max_price)
      and (not p_in_stock or not b.track_inventory or exists (
        select 1 from public.product_variants v join public.inventory inv on inv.variant_id = v.id
        where v.product_id = b.id and v.is_active and inv.available > 0))
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered),
    'items', coalesce((
      select jsonb_agg(public._storefront_product_card(pr) order by x.rn)
      from (
        select f.id, row_number() over (order by
          case when p_sort = 'price_asc' then f.eff_price end asc,
          case when p_sort = 'price_desc' then f.eff_price end desc,
          case when p_sort = 'name' then f.name end asc,
          case when p_sort = 'featured' then f.is_featured end desc,
          f.created_at desc) as rn
        from filtered f
        order by rn
        limit least(greatest(p_limit, 1), 60) offset greatest(p_offset, 0)
      ) x
      join public.products pr on pr.id = x.id
    ), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

create or replace function public.storefront_get_product(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_p public.products;
  v_overselling boolean := public.allow_overselling();
begin
  select * into v_p from public.products where slug = p_slug and status = 'ACTIVE';
  if not found then
    return null;
  end if;
  return public._storefront_product_card(v_p) || jsonb_build_object(
    'description', v_p.description,
    'sku', v_p.sku,
    'option_names', to_jsonb(v_p.option_names),
    'seo_title', v_p.seo_title,
    'seo_description', v_p.seo_description,
    'track_inventory', v_p.track_inventory,
    'max_quantity', public.setting_numeric('orders', array['max_quantity_per_item'], 50),
    'images', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'url', i.url, 'alt', coalesce(i.alt, v_p.name),
                          'variant_id', i.variant_id) order by i.is_primary desc, i.position)
                        from public.product_images i where i.product_id = v_p.id), '[]'::jsonb),
    'variants', coalesce((select jsonb_agg(jsonb_build_object(
        'id', v.id, 'sku', v.sku, 'title', v.title, 'size', v.size, 'color', v.color,
        'option_values', v.option_values,
        'price', coalesce(v.price, v_p.price),
        'compare_at_price', coalesce(v.compare_at_price, v_p.compare_at_price),
        'available', case when not v_p.track_inventory or v_overselling then null else greatest(coalesce(inv.available, 0), 0) end,
        'in_stock', not v_p.track_inventory or v_overselling or coalesce(inv.available, 0) > 0
      ) order by v.position, v.created_at)
      from public.product_variants v left join public.inventory inv on inv.variant_id = v.id
      where v.product_id = v_p.id and v.is_active), '[]'::jsonb),
    'related', coalesce((select jsonb_agg(public._storefront_product_card(r)) from (
        select * from public.products r
        where r.status = 'ACTIVE' and r.id <> v_p.id
          and (r.category_id = v_p.category_id or r.tags && v_p.tags)
        order by (r.category_id = v_p.category_id) desc, r.created_at desc
        limit 4) r), '[]'::jsonb)
  );
end;
$$;

create or replace function public.storefront_categories()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'name', c.name, 'slug', c.slug, 'description', c.description, 'image_url', c.image_url,
    'parent_id', c.parent_id,
    'product_count', (select count(*) from public.products p where p.category_id = c.id and p.status = 'ACTIVE')
  ) order by c.sort_order, c.name), '[]'::jsonb)
  from public.categories c
  where c.is_active
$$;

-- Everything the storefront needs at boot, in one round trip.
create or replace function public.storefront_config()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'store', public.get_setting('store') - 'phone_pattern',
    'storefront', public.get_setting('storefront'),
    'policies', public.get_setting('policies'),
    'delivery', jsonb_build_object(
      'methods', coalesce((select jsonb_agg(m) from jsonb_array_elements(coalesce(public.get_setting('delivery') -> 'methods', '[]'::jsonb)) m
                           where coalesce((m ->> 'active')::boolean, true)), '[]'::jsonb),
      'districts', coalesce(public.get_setting('delivery') -> 'districts', '[]'::jsonb),
      'free_delivery_threshold', public.get_setting('delivery') -> 'free_delivery_threshold',
      'zones', coalesce((select jsonb_agg(jsonb_build_object('name', z.name, 'charge', z.charge, 'districts', to_jsonb(z.districts),
                           'estimated_days', z.estimated_days, 'is_default', z.is_default) order by z.sort_order)
                         from public.delivery_zones z where z.is_active), '[]'::jsonb)
    ),
    'payments', jsonb_build_object(
      'cod_enabled', public.setting_bool('payments', array['cod_enabled'], true),
      'advance_enabled', public.setting_bool('payments', array['advance_enabled'], true),
      'full_payment_enabled', public.setting_bool('payments', array['full_payment_enabled'], true),
      'providers', coalesce((select jsonb_agg(jsonb_build_object('code', k, 'label', v ->> 'label', 'type', v ->> 'type',
                               'instructions', v ->> 'instructions', 'accounts', coalesce(v -> 'accounts', '[]'::jsonb)))
                             from jsonb_each(coalesce(public.get_setting('payments') -> 'providers', '{}'::jsonb)) as e(k, v)
                             where coalesce((v ->> 'enabled')::boolean, false)), '[]'::jsonb),
      'voluntary_advance', public.get_setting('payments') -> 'voluntary_advance'
    ),
    'phone_pattern', public.setting_text('store', array['phone_pattern'], '^01[3-9][0-9]{8}$')
  )
$$;

-- Price/delivery/coupon preview for the cart and checkout (no risk check).
create or replace function public.storefront_quote(
  p_items jsonb, p_district text default null, p_area text default null,
  p_delivery_method text default 'standard', p_coupon_code text default null, p_phone text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb;
begin
  v := public.calculate_order_quote(p_items, p_district, p_area, p_delivery_method, p_coupon_code, p_phone, false, false);
  -- Hide cost data from the public response.
  return (v - 'cost_total') || jsonb_build_object(
    'lines', (select coalesce(jsonb_agg(l - 'unit_cost'), '[]'::jsonb) from jsonb_array_elements(v -> 'lines') l));
end;
$$;

-- -----------------------------------------------------------------------------
-- Customer admin
-- -----------------------------------------------------------------------------
create or replace function public.admin_update_customer(p_customer_id uuid, p_changes jsonb)
returns public.customers
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old public.customers;
  v_new public.customers;
begin
  perform public.require_permission('customers.manage');
  select * into v_old from public.customers where id = p_customer_id for update;
  if not found then
    raise exception 'NOT_FOUND: customer not found' using errcode = 'P0002';
  end if;
  if p_changes ? 'status' and (p_changes ->> 'status') = 'BLOCKED' and length(trim(coalesce(p_changes ->> 'blocked_reason', ''))) = 0 then
    raise exception 'VALIDATION: a reason is required to block a customer' using errcode = '22023';
  end if;
  update public.customers set
    full_name = coalesce(nullif(trim(p_changes ->> 'full_name'), ''), full_name),
    email = case when p_changes ? 'email' then nullif(lower(trim(p_changes ->> 'email')), '') else email end,
    address = case when p_changes ? 'address' then nullif(trim(p_changes ->> 'address'), '') else address end,
    area = case when p_changes ? 'area' then nullif(trim(p_changes ->> 'area'), '') else area end,
    city = case when p_changes ? 'city' then nullif(trim(p_changes ->> 'city'), '') else city end,
    district = case when p_changes ? 'district' then nullif(trim(p_changes ->> 'district'), '') else district end,
    notes = case when p_changes ? 'notes' then nullif(trim(p_changes ->> 'notes'), '') else notes end,
    tags = case when p_changes ? 'tags' then coalesce(array(select jsonb_array_elements_text(p_changes -> 'tags')), '{}') else tags end,
    status = coalesce(nullif(p_changes ->> 'status', '')::public.customer_status, status),
    blocked_reason = case when (p_changes ->> 'status') = 'BLOCKED' then trim(p_changes ->> 'blocked_reason')
                          when (p_changes ->> 'status') = 'ACTIVE' then null else blocked_reason end
  where id = p_customer_id returning * into v_new;
  perform public.refresh_customer_stats(p_customer_id);
  perform public.log_audit(case when v_new.status <> v_old.status then 'customer.status_changed' else 'customer.updated' end,
    'customer', p_customer_id::text,
    (select jsonb_object_agg(k, to_jsonb(v_old) -> k) from jsonb_object_keys(p_changes) k where to_jsonb(v_old) ? k),
    (select jsonb_object_agg(k, to_jsonb(v_new) -> k) from jsonb_object_keys(p_changes) k where to_jsonb(v_new) ? k));
  select * into v_new from public.customers where id = p_customer_id;
  return v_new;
end;
$$;

create or replace function public.admin_create_customer(p jsonb)
returns public.customers
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_phone text := public.clean_phone(p ->> 'phone');
  v_row public.customers;
begin
  perform public.require_permission('customers.manage');
  if v_phone is null or v_phone !~ public.setting_text('store', array['phone_pattern'], '^01[3-9][0-9]{8}$') then
    raise exception 'VALIDATION: enter a valid mobile number' using errcode = '22023';
  end if;
  if length(trim(coalesce(p ->> 'full_name', ''))) < 2 then
    raise exception 'VALIDATION: name is required' using errcode = '22023';
  end if;
  insert into public.customers(full_name, phone, email, address, area, city, district, notes)
  values (trim(p ->> 'full_name'), v_phone, nullif(lower(trim(coalesce(p ->> 'email', ''))), ''),
          nullif(trim(coalesce(p ->> 'address', '')), ''), nullif(trim(coalesce(p ->> 'area', '')), ''),
          nullif(trim(coalesce(p ->> 'city', '')), ''), nullif(trim(coalesce(p ->> 'district', '')), ''),
          nullif(trim(coalesce(p ->> 'notes', '')), ''))
  returning * into v_row;
  perform public.log_audit('customer.created', 'customer', v_row.id::text, null, jsonb_build_object('phone', v_phone));
  return v_row;
exception when unique_violation then
  raise exception 'DUPLICATE: a customer with this phone number already exists' using errcode = '23505';
end;
$$;

-- Customer financial history: orders, payments, refunds in one call.
create or replace function public.admin_customer_summary(p_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_permission('customers.view');
  return jsonb_build_object(
    'payments', coalesce((select jsonb_agg(jsonb_build_object('id', op.id, 'order_number', o.order_number, 'kind', op.kind,
        'channel', op.channel, 'amount', op.amount, 'created_at', op.created_at) order by op.created_at desc)
      from public.order_payments op join public.orders o on o.id = op.order_id where o.customer_id = p_customer_id), '[]'::jsonb),
    'fraud_checks', coalesce((select jsonb_agg(jsonb_build_object('id', fc.id, 'risk_score', fc.risk_score,
        'risk_level', fc.risk_level, 'decision', fc.decision, 'provider', fc.provider, 'courier_score', fc.courier_score,
        'created_at', fc.created_at, 'order_id', fc.order_id) order by fc.created_at desc)
      from public.fraud_checks fc where fc.phone = (select phone from public.customers where id = p_customer_id)), '[]'::jsonb),
    'totals', (select jsonb_build_object(
        'paid', coalesce(sum(op.amount) filter (where op.kind <> 'REFUND'), 0),
        'refunded', coalesce(sum(op.amount) filter (where op.kind = 'REFUND'), 0))
      from public.order_payments op join public.orders o on o.id = op.order_id where o.customer_id = p_customer_id)
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table public.marketing_campaigns enable row level security;
alter table public.marketing_spend enable row level security;
alter table public.notifications enable row level security;
alter table public.notification_logs enable row level security;
alter table public.contact_messages enable row level security;
alter table public.storefront_events enable row level security;

create policy marketing_campaigns_read on public.marketing_campaigns for select to authenticated
  using ((select public.has_permission('marketing.view')));
create policy marketing_campaigns_manage on public.marketing_campaigns for all to authenticated
  using ((select public.has_permission('marketing.manage')))
  with check ((select public.has_permission('marketing.manage')));
create policy marketing_spend_read on public.marketing_spend for select to authenticated
  using ((select public.has_permission('marketing.view')));
create policy marketing_spend_manage on public.marketing_spend for all to authenticated
  using ((select public.has_permission('marketing.manage')))
  with check ((select public.has_permission('marketing.manage')));

create policy notifications_read on public.notifications for select to authenticated
  using ((select public.has_permission('settings.view')));
create policy notifications_manage on public.notifications for update to authenticated
  using ((select public.has_permission('settings.manage')))
  with check ((select public.has_permission('settings.manage')));
create policy notification_logs_read on public.notification_logs for select to authenticated
  using ((select public.has_permission('orders.view')) or (select public.has_permission('settings.view')));

create policy contact_messages_read on public.contact_messages for select to authenticated
  using ((select public.has_permission('customers.view')));
create policy contact_messages_update on public.contact_messages for update to authenticated
  using ((select public.has_permission('customers.manage')))
  with check ((select public.has_permission('customers.manage')));
create policy storefront_events_read on public.storefront_events for select to authenticated
  using ((select public.has_permission('reports.view')));
