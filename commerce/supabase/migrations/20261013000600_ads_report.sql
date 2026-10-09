-- =============================================================================
-- Ads hub report: every ad campaign judged by what its orders actually did
--   orders → delivered / returned / cancelled / still on the way, delivered
--   revenue, cost of goods, courier cost and ad spend → profit, cost per
--   delivered order, ROAS on delivered revenue, a quality score and a verdict
--   (Scale / Keep / Fix / Stop, or Wait while too few orders have settled).
-- Orders count for a campaign only through the campaign their link carried;
-- paid traffic without a campaign shows as "campaign unknown", never guessed.
-- =============================================================================

-- META / TIKTOK / GOOGLE / OTHER for a campaign key (or, without one, the traffic source).
create or replace function public._campaign_platform(p_key text, p_source text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    case when p_key is null then null
         when exists (select 1 from public.meta_campaigns m where m.id = p_key) then 'META'
         when p_key like 'mc:%' then (select c.platform::text from public.marketing_campaigns c where c.id::text = substr(p_key, 4))
         else (select c.platform::text from public.marketing_campaigns c where c.external_id = p_key and c.source = 'API' limit 1) end,
    case when p_source ~* '(facebook|instagram|messenger|meta)' then 'META'
         when p_source ~* 'tiktok' then 'TIKTOK'
         when p_source ~* 'google' then 'GOOGLE'
         else 'OTHER' end)
$$;

create or replace function public.report_ads(p_from date, p_to date, p_platform text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz text := public.store_timezone();
  v_platform text := nullif(upper(p_platform), '');
begin
  perform public.require_permission('marketing.view');
  if p_to < p_from or p_to - p_from > 370 then
    raise exception 'VALIDATION: choose a range of up to a year' using errcode = '22023';
  end if;
  return (
    with ord as (
      select f.order_id, f.status, f.created_at, f.source,
             coalesce(f.campaign_key, '_paid_') as key,
             coalesce(f.campaign_name, 'Paid traffic — campaign unknown') as name,
             public._campaign_platform(f.campaign_key, f.source) as platform,
             f.status in ('DELIVERED', 'PARTIALLY_DELIVERED') as delivered,
             f.status in ('RETURN_REQUESTED', 'RETURNING', 'RETURNED', 'LOST') as returned,
             f.status in ('CANCELLED', 'REJECTED_FRAUD') as cancelled,
             case when f.status in ('DELIVERED', 'PARTIALLY_DELIVERED') then o.total_amount - coalesce(o.partial_return_amount, 0) else 0 end as revenue,
             case when f.status in ('DELIVERED', 'PARTIALLY_DELIVERED') then coalesce(o.cost_total, 0) else 0 end as cogs,
             coalesce((select sum(coalesce(s.shipping_cost, 0)
                                  + case when f.status in ('RETURN_REQUESTED', 'RETURNING', 'RETURNED') then coalesce(s.return_charge, 0) else 0 end)
                       from public.shipments s where s.order_id = f.order_id), 0) as courier_cost
      from public.order_attribution_facts f
      join public.orders o on o.id = f.order_id
      where (f.created_at at time zone v_tz)::date between p_from and p_to
        and (f.campaign_key is not null or coalesce(f.is_paid, false))
    ), ords as (
      select * from ord where v_platform is null or platform = v_platform
    ), spend as (
      select s.campaign_key as key, max(s.campaign_name) as name,
             case when s.source in ('Facebook Ads', 'Instagram Ads', 'Messenger Ads') then 'META' when s.source = 'TikTok Ads' then 'TIKTOK'
                  when s.source = 'Google Ads' then 'GOOGLE' else 'OTHER' end as platform,
             sum(s.cost) as cost, sum(s.impressions) as impressions, sum(s.clicks) as clicks
      from public.ad_spend_facts s
      where s.date between p_from and p_to
      group by 1, 3
    ), spends as (
      select * from spend where v_platform is null or platform = v_platform
    ), per as (
      select coalesce(o.key, s.key) as key, coalesce(o.name, s.name) as name, coalesce(o.platform, s.platform) as platform,
             coalesce(s.cost, 0) as spend, coalesce(s.impressions, 0) as impressions, coalesce(s.clicks, 0) as clicks,
             coalesce(o.orders, 0) as orders, coalesce(o.delivered, 0) as delivered, coalesce(o.returned, 0) as returned,
             coalesce(o.cancelled, 0) as cancelled, coalesce(o.revenue, 0) as revenue, coalesce(o.cogs, 0) as cogs,
             coalesce(o.courier_cost, 0) as courier_cost
      from (select key, max(name) as name, max(platform) as platform, count(*) as orders,
                   count(*) filter (where delivered) as delivered, count(*) filter (where returned) as returned,
                   count(*) filter (where cancelled) as cancelled, sum(revenue) as revenue, sum(cogs) as cogs, sum(courier_cost) as courier_cost
            from ords group by key) o
      full join spends s on s.key = o.key
    ), scored as (
      select p.*,
             p.orders - p.delivered - p.returned - p.cancelled as in_progress,
             p.revenue - p.cogs - p.courier_cost - p.spend as profit,
             case when p.delivered + p.returned > 0 then round(100.0 * p.delivered / (p.delivered + p.returned), 1) end as delivery_rate,
             case when p.orders > 0 then round(100.0 * p.returned / p.orders, 1) end as return_rate,
             case when p.orders > 0 then round(100.0 * p.cancelled / p.orders, 1) end as cancel_rate,
             case when p.orders > 0 and p.spend > 0 then round(p.spend / p.orders, 2) end as cost_per_order,
             case when p.delivered > 0 and p.spend > 0 then round(p.spend / p.delivered, 2) end as cost_per_delivered,
             case when p.spend > 0 then round(p.revenue / p.spend, 2) end as roas,
             case when p.delivered + p.returned >= 3 then round(
                 60.0 * p.delivered / (p.delivered + p.returned)
               + 20.0 * (1 - p.cancelled::numeric / greatest(p.orders, 1))
               + 20.0 * case when p.spend > 0 then least(p.revenue / p.spend / 4, 1) else 1 end) end as score
      from per p
    ), graded as (
      select s.*,
             case when s.score is null then null when s.score >= 80 then 'A' when s.score >= 65 then 'B' when s.score >= 50 then 'C' else 'D' end as grade
      from scored s
    )
    select jsonb_build_object(
      'totals', (select jsonb_build_object(
          'spend', coalesce(sum(spend), 0), 'impressions', coalesce(sum(impressions), 0), 'clicks', coalesce(sum(clicks), 0),
          'orders', coalesce(sum(orders), 0), 'delivered', coalesce(sum(delivered), 0), 'returned', coalesce(sum(returned), 0),
          'cancelled', coalesce(sum(cancelled), 0), 'in_progress', coalesce(sum(in_progress), 0),
          'revenue', coalesce(sum(revenue), 0), 'cogs', coalesce(sum(cogs), 0), 'courier_cost', coalesce(sum(courier_cost), 0),
          'profit', coalesce(sum(profit), 0),
          'unknown_campaign_orders', coalesce(sum(orders) filter (where key = '_paid_'), 0),
          'spend_usd', case when v_platform is null or v_platform in ('META', 'TIKTOK', 'GOOGLE') then (
            select coalesce(sum(usd), 0) from public._ad_spend_usd(p_from, p_to)) end) from graded),
      'platforms', coalesce((select jsonb_agg(jsonb_build_object('platform', platform, 'spend', spend, 'orders', orders, 'delivered', delivered,
                                  'returned', returned, 'cancelled', cancelled, 'revenue', revenue, 'profit', profit,
                                  'delivery_rate', case when delivered + returned > 0 then round(100.0 * delivered / (delivered + returned), 1) end,
                                  'roas', case when spend > 0 then round(revenue / spend, 2) end) order by spend desc)
                             from (select platform, sum(spend) as spend, sum(orders) as orders, sum(delivered) as delivered, sum(returned) as returned,
                                          sum(cancelled) as cancelled, sum(revenue) as revenue, sum(profit) as profit
                                   from graded group by platform) x), '[]'::jsonb),
      'campaigns', coalesce((select jsonb_agg(jsonb_build_object(
          'key', key, 'name', coalesce(name, 'Campaign ' || key), 'platform', platform, 'spend', spend, 'impressions', impressions, 'clicks', clicks,
          'orders', orders, 'delivered', delivered, 'returned', returned, 'cancelled', cancelled, 'in_progress', in_progress,
          'revenue', revenue, 'cogs', cogs, 'courier_cost', courier_cost, 'profit', profit,
          'delivery_rate', delivery_rate, 'return_rate', return_rate, 'cancel_rate', cancel_rate,
          'cost_per_order', cost_per_order, 'cost_per_delivered', cost_per_delivered, 'roas', roas,
          'score', score, 'grade', grade,
          'verdict', case when grade is null then 'WAIT'
                          when grade = 'D' or (profit < 0 and delivered + returned >= 10 and delivery_rate < 60) then 'STOP'
                          when grade = 'A' and profit > 0 then 'SCALE'
                          when grade in ('A', 'B') and profit >= 0 then 'KEEP'
                          else 'FIX' end,
          'unknown', key = '_paid_') order by spend desc, orders desc) from graded), '[]'::jsonb),
      'days', coalesce((select jsonb_agg(jsonb_build_object('date', d.day, 'spend', d.spend, 'orders', d.orders, 'delivered', d.delivered, 'revenue', d.revenue) order by d.day)
                        from (select g.day,
                                     coalesce((select sum(s.cost) from public.ad_spend_facts s
                                               where s.date = g.day and (v_platform is null or case when s.source in ('Facebook Ads', 'Instagram Ads', 'Messenger Ads') then 'META'
                                                     when s.source = 'TikTok Ads' then 'TIKTOK' when s.source = 'Google Ads' then 'GOOGLE' else 'OTHER' end = v_platform)), 0) as spend,
                                     (select count(*) from ords o where (o.created_at at time zone v_tz)::date = g.day) as orders,
                                     (select count(*) from ords o where (o.created_at at time zone v_tz)::date = g.day and o.delivered) as delivered,
                                     (select coalesce(sum(revenue), 0) from ords o where (o.created_at at time zone v_tz)::date = g.day) as revenue
                              from (select generate_series(p_from, p_to, interval '1 day')::date as day) g) d), '[]'::jsonb),
      'hours', coalesce((select jsonb_agg(jsonb_build_object('hour', h.hour, 'orders', coalesce(x.orders, 0), 'delivered', coalesce(x.delivered, 0)) order by h.hour)
                         from generate_series(0, 23) h(hour)
                         left join (select extract(hour from created_at at time zone v_tz)::int as hour, count(*) as orders, count(*) filter (where delivered) as delivered
                                    from ords group by 1) x on x.hour = h.hour), '[]'::jsonb),
      'products', coalesce((select jsonb_agg(p order by p.quantity desc) from (
          select oi.product_name as name, sum(oi.quantity) as quantity, count(distinct o.order_id) as orders,
                 count(distinct o.order_id) filter (where o.delivered) as delivered, count(distinct o.order_id) filter (where o.returned) as returned
          from ords o join public.order_items oi on oi.order_id = o.order_id
          group by oi.product_name order by 2 desc limit 10) p), '[]'::jsonb)
    ));
end;
$$;

revoke all on function public._campaign_platform(text, text), public.report_ads(date, date, text) from public, anon, authenticated;
grant execute on function public.report_ads(date, date, text) to authenticated;
