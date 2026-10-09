import { asJson } from '@/lib/json'
import { invokeFunction } from '@/lib/functions'
import { supabase } from '@/lib/supabase'
import type { Json, TablesInsert } from '@/types/database'

export async function getSettings(): Promise<Record<string, Record<string, unknown>>> {
  const { data, error } = await supabase.from('settings').select('key, value')
  if (error) throw error
  return Object.fromEntries((data ?? []).map((r) => [r.key, r.value as Record<string, unknown>]))
}

export async function updateSetting(key: string, value: Record<string, unknown>) {
  const { error } = await supabase.rpc('admin_update_setting', { p_key: key, p_value: asJson(value) })
  if (error) throw error
}

export async function listDeliveryZones() {
  const { data, error } = await supabase.from('delivery_zones').select('*').order('sort_order')
  if (error) throw error
  return data ?? []
}
export type DeliveryZone = Awaited<ReturnType<typeof listDeliveryZones>>[number]

export async function saveDeliveryZone(values: TablesInsert<'delivery_zones'> & { id?: string }) {
  const { id, ...rest } = values
  const { error } = id ? await supabase.from('delivery_zones').update(rest).eq('id', id) : await supabase.from('delivery_zones').insert(rest)
  if (error) throw error
}

export async function deleteDeliveryZone(id: string) {
  const { error } = await supabase.from('delivery_zones').delete().eq('id', id)
  if (error) throw error
}

export async function listFraudRules() {
  const { data, error } = await supabase.from('fraud_rules').select('*, fraud_rule_actions(*)').order('priority')
  if (error) throw error
  return data ?? []
}
export type FraudRule = Awaited<ReturnType<typeof listFraudRules>>[number]

export async function saveFraudRule(rule: Record<string, unknown>) {
  const { error } = await supabase.rpc('admin_save_fraud_rule', { p_rule: asJson(rule) })
  if (error) throw error
}

export async function toggleFraudRule(id: string, active: boolean) {
  const { error } = await supabase.from('fraud_rules').update({ is_active: active }).eq('id', id)
  if (error) throw error
}

export async function deleteFraudRule(id: string) {
  const { error } = await supabase.from('fraud_rules').delete().eq('id', id)
  if (error) throw error
}

export async function listNotificationTemplates() {
  // SMS automations live on the SMS page.
  const { data, error } = await supabase.from('notifications').select('*').neq('channel', 'SMS').neq('event', 'ADVANCE_RECEIVED')
    .order('event').order('channel')
  if (error) throw error
  return data ?? []
}

export async function updateNotificationTemplate(id: string, values: { is_enabled?: boolean; subject?: string | null; template?: string }) {
  const { error } = await supabase.from('notifications').update(values).eq('id', id)
  if (error) throw error
}

export async function listNotificationLogs(limit = 100) {
  const { data, error } = await supabase.from('notification_logs').select('*, orders(order_number)').neq('channel', 'SMS')
    .order('created_at', { ascending: false }).limit(limit)
  if (error) throw error
  return data ?? []
}

export async function retryNotification(id: string) {
  const { error } = await supabase.rpc('retry_notification', { p_id: id })
  if (error) throw error
}

export type { Json }

// ---------------------------------------------------------------------------
// Courier-history check (key saved in Vault by the fraud-check function)
// ---------------------------------------------------------------------------
export interface CourierHistoryLine {
  courier: string
  orders: number
  cancelled: number
  delivered: number
  name?: string
  /** The courier's own rate (BD Courier); null when it has no parcels. */
  success_ratio?: number | null
  /** Only a rate and a range such as "50+" are known (Steadfast). */
  rate_only?: boolean
  parcel_range?: string | null
  notice?: string | null
}

export interface CourierHistoryResult {
  couriers: CourierHistoryLine[]
  total: number
  delivered: number
  cancelled: number
  success_ratio: number | null
  /** 'provider': the service's own overall rate (BD Courier averages each courier's rate). */
  ratio_source?: 'provider' | 'counts'
  calculation_note?: string | null
  verdict?: { label: string | null; level: string | null; action: string | null; reasons: string[] } | null
  parcel_floor?: number
  name_on_record: string | null
  service?: CourierHistoryService
  /** Fraud reports other merchants filed against the number (BD Courier). */
  reports?: Array<{ name: string | null; details: string | null; courier: string | null; created_at: string | null }>
}

export type CourierHistoryService = 'bdcourier' | 'llcg'

export const COURIER_HISTORY_SERVICES: Record<CourierHistoryService, { label: string; url: string; keyHint: string }> = {
  bdcourier: { label: 'BD Courier', url: 'https://api.bdcourier.com', keyHint: 'app.courier.com.bd → Developer/API → API Key' },
  llcg: { label: 'LLCG courier fraud checker', url: 'https://llcgteam.com/courier-fraud-checker', keyHint: 'From your LLCG fraud-checker account' },
}

export interface CourierHistoryStatus {
  /** saved = key saved from this page; server_secret = BDCOURIER_API_KEY / COURIER_HISTORY_API_KEY function secret. */
  source: 'saved' | 'server_secret' | null
  service: CourierHistoryService | null
  enabled: boolean
}

export function courierHistoryStatus() {
  return invokeFunction<CourierHistoryStatus>('fraud-check', { action: 'courier_history_status' })
}

export interface IntegrationStatus {
  connected: boolean
  hint: string | null
  connected_at: string
  connected_by_name: string | null
}

export async function integrationStatus(): Promise<Record<string, IntegrationStatus>> {
  const { data, error } = await supabase.rpc('admin_integration_status')
  if (error) throw error
  return (data ?? {}) as unknown as Record<string, IntegrationStatus>
}

export function connectCourierHistory(input: { service: CourierHistoryService; api_key: string; base_url?: string; test_phone: string }) {
  return invokeFunction<{ ok: boolean; hint: string; providers: string[]; result: CourierHistoryResult }>(
    'fraud-check', { action: 'connect_courier_history', ...input })
}

export function testCourierHistory(testPhone: string) {
  return invokeFunction<{ ok: boolean; result: CourierHistoryResult }>('fraud-check', { action: 'test_courier_history', test_phone: testPhone })
}

export function disconnectCourierHistory() {
  return invokeFunction<{ ok: boolean; providers: string[] }>('fraud-check', { action: 'disconnect_courier_history' })
}

export type Gateway = 'bkash' | 'paystation'
export interface GatewayCredentials {
  app_key?: string
  app_secret?: string
  username?: string
  password?: string
  merchant_id?: string
  token?: string
  base_url?: string
}

/** Tests the credentials with the gateway, then saves them in Vault and turns the gateway on. */
export function connectGateway(provider: Gateway, credentials: GatewayCredentials, sandbox?: boolean) {
  return invokeFunction<{ ok: boolean; message: string; hint: string }>('payments', { action: 'connect_gateway', provider, credentials, sandbox })
}

export function testGateway(provider: Gateway) {
  return invokeFunction<{ ok: boolean; message: string }>('payments', { action: 'test_gateway', provider })
}

export function disconnectGateway(provider: Gateway) {
  return invokeFunction<{ ok: boolean }>('payments', { action: 'disconnect_gateway', provider })
}
