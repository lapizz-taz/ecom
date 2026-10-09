import { invokeFunction } from '@/lib/functions'
import { fromJson } from '@/lib/json'
import { supabase } from '@/lib/supabase'
import type { TablesInsert } from '@/types/database'

export async function campaignPerformance() {
  const { data, error } = await supabase.from('marketing_campaign_performance').select('*').order('spend', { ascending: false })
  if (error) throw error
  return data ?? []
}
export type CampaignPerformance = Awaited<ReturnType<typeof campaignPerformance>>[number]

export async function listCampaigns() {
  const { data, error } = await supabase.from('marketing_campaigns').select('*').order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

export async function saveCampaign(values: TablesInsert<'marketing_campaigns'> & { id?: string }) {
  const { id, ...rest } = values
  const { error } = id ? await supabase.from('marketing_campaigns').update(rest).eq('id', id) : await supabase.from('marketing_campaigns').insert(rest)
  if (error) throw error
}

export async function listSpend(campaignId?: string) {
  let query = supabase.from('marketing_spend').select('*, marketing_campaigns(name, platform)').order('spend_date', { ascending: false }).limit(200)
  if (campaignId) query = query.eq('campaign_id', campaignId)
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}
export type SpendRow = Awaited<ReturnType<typeof listSpend>>[number]

/** Upsert by (campaign, date). Ad spend is posted to Advertising expenses automatically. */
export async function saveSpend(values: TablesInsert<'marketing_spend'>) {
  const { error } = await supabase.from('marketing_spend').upsert(values, { onConflict: 'campaign_id,spend_date' })
  if (error) throw error
}

export async function deleteSpend(id: string) {
  const { error } = await supabase.from('marketing_spend').delete().eq('id', id)
  if (error) throw error
}

// --- Attribution report -------------------------------------------------------
export type AttributionGroup = 'source' | 'medium' | 'campaign' | 'adset' | 'ad' | 'date' | 'product'
export interface AttributionFilters { source?: string; medium?: string; campaign?: string; adset?: string; ad?: string; product?: string; status?: string }
export interface AttributionRow {
  key: string; label: string
  orders: number; approved: number; shipped: number; delivered: number; cancelled: number; returned: number
  order_value: number; revenue: number; product_cost: number; delivery_cost: number; return_cost: number
  ad_spend: number | null; impressions: number | null; clicks: number | null
  net_revenue: number; net_profit: number; cost_per_order: number | null; cost_per_delivered: number | null; roas: number | null
}
export interface AttributionReport {
  group: AttributionGroup
  spend_tracked: boolean
  rows: AttributionRow[]
  totals: { orders: number; delivered: number; cancelled: number; returned: number; revenue: number; order_value: number; unattributed: number; paid: number }
  spend: number | null
  costs: { delivery: number; returns: number; products: number }
}

export async function attributionReport(from: string, to: string, group: AttributionGroup, filters: AttributionFilters) {
  const clean = Object.fromEntries(Object.entries(filters).filter(([, v]) => v))
  const { data, error } = await supabase.rpc('report_attribution', { p_from: from, p_to: to, p_group: group, p_filters: clean as never })
  if (error) throw error
  return fromJson<AttributionReport>(data)
}

// --- Meta Ads ------------------------------------------------------------------
export interface MetaSettings {
  connected: boolean; ad_account_id: string | null; ad_account_name: string | null; account_currency: string | null
  account_timezone: string | null; page_id: string | null; page_name: string | null; instagram_id: string | null
  instagram_username: string | null; hint: string | null; exchange_rate: number; tax_percent: number
  connected_at: string | null; last_sync_at: string | null; last_sync_status: string | null; last_sync_error: string | null
  last_sync_since: string | null; last_sync_until: string | null
}
export interface MetaAccountChoice { id: string; name: string; currency: string; timezone: string | null; status: number | null }
export interface MetaPageChoice { id: string; name: string; instagram: { id: string; username: string | null } | null }
export interface MetaSyncResult { ok: boolean; since: string; until: string; campaigns?: number; ads?: number; insights?: number; cost?: number; status?: string; error?: string }

export async function metaSettings() {
  const { data, error } = await supabase.rpc('meta_ads_status')
  if (error) throw error
  return fromJson<MetaSettings>(data)
}

export const metaAccounts = (accessToken?: string) =>
  invokeFunction<{ accounts: MetaAccountChoice[]; pages: MetaPageChoice[] }>('meta-ads', { action: 'accounts', access_token: accessToken || undefined })
export const connectMeta = (input: { accessToken?: string; adAccountId: string; pageId?: string | null; instagramId?: string | null }) =>
  invokeFunction<{ ok: boolean; account: MetaAccountChoice; sync: MetaSyncResult }>('meta-ads', {
    action: 'connect', access_token: input.accessToken || undefined, ad_account_id: input.adAccountId,
    page_id: input.pageId || undefined, instagram_id: input.instagramId || undefined,
  })
export const disconnectMeta = () => invokeFunction<{ ok: boolean }>('meta-ads', { action: 'disconnect' })
export const syncMeta = (days: number) => invokeFunction<MetaSyncResult>('meta-ads', { action: 'sync', days })

export async function updateMetaSettings(exchangeRate: number, taxPercent: number) {
  const { error } = await supabase.rpc('meta_ads_update_settings', { p_exchange_rate: exchangeRate, p_tax_percent: taxPercent })
  if (error) throw error
}

export interface MetaPerformanceRow {
  id: string; name: string; status: string | null; effective_status: string | null; parent: string | null
  thumbnail_url: string | null; title: string | null; daily_budget: number | null
  spend: number; spend_account: number; impressions: number; clicks: number; ctr: number | null; cpc: number | null; cpm: number | null
  meta_purchases: number; meta_purchase_value: number
  orders: number; delivered: number; cancelled: number; returned: number; revenue: number; cost_per_order: number | null; roas: number | null
}

export async function metaPerformance(from: string, to: string, level: 'campaign' | 'adset' | 'ad', parent?: string) {
  const { data, error } = await supabase.rpc('report_meta_ads', { p_from: from, p_to: to, p_level: level, p_parent: parent || undefined })
  if (error) throw error
  return fromJson<MetaPerformanceRow[]>(data)
}
