// Super Admin → PBX Setup: VoiceDrive lines per merchant and the shared gateway.
// The database checks platform PBX access for every call; secrets go through
// the platform-admin edge function and are never returned.
import { invokeFunction } from '@/lib/functions'
import { type MerchantRef, platformRpc } from '@/services/platform'
import type { LineProblem } from '@/services/voicedrive'

export interface PbxLine {
  id: string; code: number; name: string; did: string | null; caller_id: string | null
  trunk_host: string | null; trunk_port: number; trunk_transport: 'udp' | 'tcp' | 'tls'; trunk_user: string | null; trunk_register: boolean
  trunk_secret_set: boolean; trunk_secret_hint: string | null; dial_format: 'LOCAL' | 'E164' | 'E164_NO_PLUS'; max_call_minutes: number
  pbx_enabled: boolean; bridge_ready: boolean; bridge_ready_at: string | null; provisioned_at: string | null
  limits: { active: boolean; agents: number; channels: number; expiresAt: string | null; packageCode: string | null; packageName: string | null }
  balance_tk: number; problems: LineProblem[]; agents: number
  trunk: { reported: string | null; gateway_online: boolean; gateway_seen_at: string | null }
}
export interface FeatureState { name: string; state: string; enabled: boolean }
export interface ClickToCall { enabled: boolean; provider: string | null; mode: string | null; api_host: string | null; extensions: number; has_secret: boolean; calls_7d: number }
export interface VoiceDriveConfig {
  sip_domain: string | null; wss_url: string | null; stun_urls: string[]; turn_urls: string[]; turn_ttl_seconds: number; credential_ttl_seconds: number
  rate_tk_per_min: number; vat_percent: number; min_topup_tk: number; max_topup_tk: number; extra_agent_tk: number; extra_channel_tk: number
  maintenance: { starts_at: string | null; until: string | null; message: string | null }
}
export interface PbxPackage { id: string; code: string; name: string; monthly_price_tk: number | null; agent_limit: number | null; concurrent_channels: number | null; is_custom: boolean; active: boolean }
export interface PbxOverview {
  merchants: Array<{ merchant: MerchantRef & { status: string; is_demo: boolean }; feature: FeatureState | null; business: PbxLine | null; calls_7d: number; last_call_at: string | null; click_to_call: ClickToCall | null }>
  gateway: { last_seen_at: string | null; version: string | null; online: boolean; softphones_online: number | null; active_calls: number | null
    trunk_sync: { at: string; trunks: number; error?: string } | null; trunks: Array<{ name: string; state: string }> | null } | null
  settings: VoiceDriveConfig
  secrets: { gateway_token: { hint: string; at: string } | null; turn_secret: { hint: string; at: string } | null }
  packages: PbxPackage[]
  can: { edit: boolean; manage: boolean }
}
export interface PbxMerchant {
  merchant: MerchantRef & { status: string }
  feature: FeatureState | null
  business: PbxLine | null
  click_to_call: ClickToCall | null
  agents: Array<{ id: string; extension: string; sip_username: string; active: boolean; inbound_enabled: boolean; ring_group_id: string | null; profile_id: string; name: string; online: boolean }>
  ring_groups: Array<{ id: string; name: string; strategy: 'RING_ALL' | 'LONGEST_IDLE'; ring_seconds: number; is_default: boolean; active: boolean }>
  staff: Array<{ id: string; name: string; email: string }>
  subscriptions: Array<{ id: string; package: string; agents: number; channels: number; months: number; amount_tk: number; starts_at: string; expires_at: string; status: string; source: string; note: string | null }>
  ledger: Array<{ id: string; kind: string; amount_tk: number; balance_after_tk: number; note: string | null; created_at: string }>
  payments: Array<{ reference: string; type: string; amount_tk: number; status: string; trx_id: string | null; created_at: string; completed_at: string | null; failure_reason: string | null }>
  calls: { total: number; answered: number; missed: number; minutes: number; charged_tk: number }
  history: Array<{ action: string; actor: string | null; reason: string | null; result: string; created_at: string }>
  can: { edit: boolean; manage: boolean }
}
export interface PbxCheck { ok: boolean; at: string; checks: Array<{ key: string; ok: boolean; detail: string }> }

export const pbxOverview = () => platformRpc<PbxOverview>('platform_pbx_overview')
export const pbxMerchant = (merchant: string) => platformRpc<PbxMerchant>('platform_pbx_merchant', { p_merchant: merchant })
export const pbxSetup = (merchant: string, p: Record<string, unknown>, reason?: string) => platformRpc<PbxLine>('platform_pbx_setup', { p_merchant: merchant, p, p_reason: reason ?? null })
export const pbxSetEnabled = (merchant: string, enabled: boolean, reason: string) => platformRpc<PbxLine>('platform_pbx_set_enabled', { p_merchant: merchant, p_enabled: enabled, p_reason: reason })
export const pbxBridgeReady = (merchant: string, ready: boolean) => platformRpc<PbxLine>('platform_pbx_bridge_ready', { p_merchant: merchant, p_ready: ready, p_reason: null })
export const pbxCheck = (merchant: string) => platformRpc<PbxCheck>('platform_pbx_check', { p_merchant: merchant })
export const pbxGrantPackage = (merchant: string, p: { package_id: string; months: number; extra_agents?: number; extra_channels?: number; agents?: number; channels?: number; amount_tk?: number }, reason: string) =>
  platformRpc('platform_pbx_grant_package', { p_merchant: merchant, p, p_reason: reason })
export const pbxAdjustBalance = (merchant: string, amount: number, reason: string) => platformRpc<{ balanceTk: number }>('platform_pbx_adjust_balance', { p_merchant: merchant, p_amount: amount, p_reason: reason })
export const pbxSaveAgent = (merchant: string, p: { id?: string; profile_id?: string; extension?: string; ring_group_id?: string | null; active?: boolean; remove?: boolean }) =>
  platformRpc('platform_pbx_agent_save', { p_merchant: merchant, p })
export const pbxSaveRingGroup = (merchant: string, p: { id?: string; name?: string; strategy?: string; ring_seconds?: number; active?: boolean }) =>
  platformRpc('platform_pbx_ring_group_save', { p_merchant: merchant, p })
export const pbxSaveSettings = (p: Partial<VoiceDriveConfig>, reason?: string) => platformRpc<VoiceDriveConfig>('platform_pbx_settings_save', { p, p_reason: reason ?? null })
export const pbxTrunkSecret = (merchant: string, password: string) => invokeFunction<{ ok: boolean; business: PbxLine }>('platform-admin', { action: 'pbx_trunk_secret', merchant_id: merchant, password })
export const pbxTurnSecret = (secret: string) => invokeFunction<{ ok: boolean; hint: string }>('platform-admin', { action: 'pbx_turn_secret', secret })
export const pbxGatewayToken = () => invokeFunction<{ token: string; hint: string }>('platform-admin', { action: 'pbx_gateway_token' })
