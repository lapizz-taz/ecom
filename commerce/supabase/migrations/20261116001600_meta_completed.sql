-- Meta Ads: a campaign, ad set or ad past its end date shows as Completed, not active.
-- Meta keeps its status ACTIVE after the schedule ends, so ended campaigns looked like
-- running ones with no spend. Ended items with nothing in the period drop out of the list.

create or replace function public.report_meta_ads(p_from date, p_to date, p_level text default 'campaign', p_parent text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz text := public.store_timezone();
begin
  if current_setting('app.core_report', true) is distinct from 'on' then
    perform public.require_feature('reports');
  end if;
  perform public.require_permission('marketing.view');
  if p_level not in ('campaign', 'adset', 'ad') then
    raise exception 'VALIDATION: unknown level %', p_level using errcode = '22023';
  end if;
  return coalesce((
    with ins as (
      select case p_level when 'campaign' then i.campaign_id when 'adset' then i.adset_id else i.ad_id end as id,
             sum(i.cost) as spend, sum(i.spend) as spend_account, sum(i.impressions) as impressions, sum(i.clicks) as clicks,
             sum(i.link_clicks) as link_clicks, sum(i.purchases) as purchases, round(sum(i.purchase_value * public._meta_rate(i.account_id)), 2) as purchase_value
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
      -- Meta keeps an ended campaign / ad set "ACTIVE": past its end date it is Completed here.
      select x.id, x.name, x.status,
             case when coalesce(x.effective_status, x.status) = 'ACTIVE' and x.ended then 'COMPLETED' else x.effective_status end as effective_status,
             x.parent, x.thumbnail_url, x.title, x.daily_budget
      from (
        select c.id, c.name, c.status, c.effective_status, null::text as parent, null::text as thumbnail_url, null::text as title, c.daily_budget,
               (c.stop_time is not null and c.stop_time < now())
                 or (exists (select 1 from public.meta_adsets s where s.campaign_id = c.id)
                     and not exists (select 1 from public.meta_adsets s where s.campaign_id = c.id and (s.end_time is null or s.end_time >= now()))) as ended
        from public.meta_campaigns c where p_level = 'campaign'
        union all
        select s.id, s.name, s.status, s.effective_status, s.campaign_id, null, null, s.daily_budget,
               (s.end_time is not null and s.end_time < now())
                 or exists (select 1 from public.meta_campaigns c where c.id = s.campaign_id and c.stop_time < now())
        from public.meta_adsets s where p_level = 'adset' and (p_parent is null or s.campaign_id = p_parent)
        union all
        select a.id, a.name, a.status, a.effective_status, a.adset_id, a.thumbnail_url, a.title, null,
               exists (select 1 from public.meta_adsets s where s.id = a.adset_id and s.end_time < now())
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
