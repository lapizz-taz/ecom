import { invokeFunction } from '@/lib/functions'
import { fromJson } from '@/lib/json'
import { supabase } from '@/lib/supabase'

export type AdPlatform = 'tiktok' | 'google'

export interface AdApp {
  configured?: boolean
  hint?: string | null
  app_id?: string | null
  client_id?: string | null
  login_customer_id?: string | null
}
export interface AdConnection {
  id: string; external_user: string | null; display_name: string | null; token_hint: string | null
  status: 'CONNECTED' | 'FAILED' | 'DISCONNECTED'; last_error: string | null; connected_at: string; connected_by_name: string | null
}
export interface AdAccount {
  id: string; connection_id: string; external_id: string; login_customer_id: string | null; name: string | null
  currency: string | null; timezone: string | null; is_manager: boolean; is_selected: boolean; usd_rate: number; tax_percent: number
  last_sync_at: string | null; last_sync_status: string | null; last_sync_error: string | null
  last_sync_since: string | null; last_sync_until: string | null; cost_30d: number
}
export interface AdPlatformOverview { app: AdApp | null; store_currency: string; connections: AdConnection[]; accounts: AdAccount[] }

export interface AdCampaignRow {
  id: string; name: string; status: 'ACTIVE' | 'PAUSED' | 'ENDED'; account: string | null; account_id: string
  cost: number; spend_account: number; currency: string | null; impressions: number; clicks: number; ctr: number | null; cpc: number | null
  conversions: number; conversion_value: number; orders: number; delivered: number; cancelled: number; returned: number; revenue: number
  cost_per_order: number | null; roas: number | null
}
export interface AdDayRow {
  date: string; account: string | null; account_id: string; cost: number; spend_account: number; currency: string | null
  impressions: number; clicks: number; conversions: number
}
export interface AdPlatformReport { campaigns: AdCampaignRow[]; days: AdDayRow[] }

export async function adPlatformOverview(platform: AdPlatform) {
  const { data, error } = await supabase.rpc('ad_platform_overview', { p_platform: platform })
  if (error) throw error
  return fromJson<AdPlatformOverview>(data)
}

export async function adPlatformReport(platform: AdPlatform, from: string, to: string) {
  const { data, error } = await supabase.rpc('ad_platform_report', { p_platform: platform, p_from: from, p_to: to })
  if (error) throw error
  return fromJson<AdPlatformReport>(data)
}

export async function updateAdAccount(id: string, patch: { is_selected?: boolean; usd_rate?: number; tax_percent?: number }) {
  const { error } = await supabase.rpc('ad_account_update', { p_id: id, p: patch as never })
  if (error) throw error
}

export type SaveAdAppInput =
  | { platform: 'tiktok'; app_id: string; secret: string }
  | { platform: 'google'; client_id: string; client_secret: string; developer_token: string; login_customer_id: string }

export const saveAdApp = (input: SaveAdAppInput) =>
  invokeFunction<{ ok: boolean; app: AdApp; redirect_uri: string }>('ad-platforms', { action: 'save_app', ...input })

/** The platform's consent screen; staff come back to `returnTo`. */
export const adAuthUrl = (platform: AdPlatform, returnTo: string) =>
  invokeFunction<{ url: string; redirect_uri: string }>('ad-platforms', { action: 'auth_url', platform, return_to: returnTo })

export const disconnectAdConnection = (platform: AdPlatform, connectionId: string) =>
  invokeFunction<{ ok: boolean }>('ad-platforms', { action: 'disconnect', platform, connection_id: connectionId })

export const syncAdPlatform = (platform: AdPlatform, days = 7, accountId?: string) =>
  invokeFunction<{ ok: boolean; accounts: Array<{ id: string; name: string | null; ok: boolean; error?: string }>; rows: number; cost: number }>(
    'ad-platforms', { action: 'sync', platform, days, account_id: accountId })

/** Where the platform must send staff back (register it on the developer app). */
export function adRedirectUri(platform: AdPlatform): string {
  return `${String(import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '')}/functions/v1/ad-platforms/callback/${platform}`
}
