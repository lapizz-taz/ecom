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
export interface MetaSyncResult { ok: boolean; since: string; until: string; campaigns?: number; ads?: number; insights?: number; cost?: number; payments?: number; status?: string; error?: string }

export interface MetaAdAccount {
  id: string; name: string; app_id: string | null; ad_account_id: string; usd_rate: number
  payment_account_id: string | null; payment_account_name: string | null; payments_from: string | null; is_active: boolean
  meta_name: string | null; currency: string | null; timezone: string | null; token_hint: string | null; has_app_secret: boolean
  token_expires_at: string | null; connection_status: 'UNTESTED' | 'OK' | 'FAILED' | 'DISCONNECTED'; connection_error: string | null
  tested_at: string | null; last_sync_at: string | null; last_sync_status: string | null; last_sync_error: string | null
  last_sync_since: string | null; last_sync_until: string | null; created_at: string
  cost_30d: number; spend_30d: number; paid_total: number
}
export interface MetaAccountsOverview { tax_percent: number; store_currency: string; accounts: MetaAdAccount[] }

export async function metaAdAccounts() {
  const { data, error } = await supabase.rpc('meta_accounts_list')
  if (error) throw error
  return fromJson<MetaAccountsOverview>(data)
}

/** What the form sends. Secrets left empty when editing keep the saved ones. */
export interface MetaAccountInput {
  id?: string; name: string; appId: string; appSecret: string; accessToken: string; adAccountId: string
  usdRate: number; paymentAccountId: string | null; isActive: boolean
}
export interface MetaTestResult {
  ok: boolean
  account: { id: string; name: string; currency: string; timezone: string | null; status: number | null }
  token: { valid: boolean; appId: string | null; expiresAt: string | null; scopes: string[] } | null
  warnings: string[]
}

const credentialsBody = (i: MetaAccountInput) => ({
  id: i.id, app_id: i.appId.trim() || undefined, app_secret: i.appSecret.trim() || undefined,
  access_token: i.accessToken.trim() || undefined, ad_account_id: i.adAccountId.trim().replace(/^act_/, ''),
})
export const testMetaAccount = (input: MetaAccountInput) =>
  invokeFunction<MetaTestResult>('meta-ads', { action: 'test', ...credentialsBody(input) })
export const saveMetaAccount = (input: MetaAccountInput) =>
  invokeFunction<{ ok: boolean; account: MetaAdAccount; warnings: string[]; sync: MetaSyncResult | null }>('meta-ads', {
    action: 'save', ...credentialsBody(input), name: input.name.trim(), usd_rate: input.usdRate,
    payment_account_id: input.paymentAccountId, is_active: input.isActive,
  })
export const disconnectMetaAccount = (id: string) => invokeFunction<{ ok: boolean }>('meta-ads', { action: 'disconnect', id })
export const syncMeta = (days: number, id?: string) =>
  invokeFunction<{ ok: boolean; accounts: (MetaSyncResult & { id: string; name: string })[]; insights: number; cost: number }>('meta-ads', { action: 'sync', days, id })

export async function setMetaTax(taxPercent: number) {
  const { error } = await supabase.rpc('meta_ads_set_tax', { p_tax_percent: taxPercent })
  if (error) throw error
}

// --- Payment accounts (Finance) -----------------------------------------------
export type FinanceAccountKind = 'CASH' | 'BANK' | 'MOBILE_WALLET' | 'CARD' | 'OTHER'
export interface FinanceAccount {
  id: string; name: string; kind: FinanceAccountKind; is_active: boolean; notes: string | null
  /** Only for staff who can see Finance. */
  opening_balance?: number | null; balance?: number | null; movements?: number | null; last_movement_at?: string | null
  meta_accounts: { id: string; name: string }[]
}
export interface FinanceMovement {
  id: string; amount: number; movement_date: string; description: string; source: 'MANUAL' | 'META_ADS'
  spend_date: string | null; created_at: string; created_by_name: string | null; meta_account_name: string | null
}

export async function financeAccounts() {
  const { data, error } = await supabase.rpc('finance_accounts_list')
  if (error) throw error
  return fromJson<FinanceAccount[]>(data)
}
export async function saveFinanceAccount(input: { id?: string; name: string; kind: FinanceAccountKind; opening_balance: number; is_active: boolean; notes?: string }) {
  const { data, error } = await supabase.rpc('finance_account_save', { p: input as never })
  if (error) throw error
  return data
}
export async function moveFinanceAccount(accountId: string, amount: number, date: string, description: string) {
  const { error } = await supabase.rpc('finance_account_move', { p_account_id: accountId, p_amount: amount, p_date: date, p_description: description })
  if (error) throw error
}
export async function financeMovements(accountId: string, page: number, pageSize: number) {
  const { data, error } = await supabase.rpc('finance_account_movements_list', { p_account_id: accountId, p_limit: pageSize, p_offset: (page - 1) * pageSize })
  if (error) throw error
  return fromJson<{ total: number; items: FinanceMovement[] }>(data)
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
