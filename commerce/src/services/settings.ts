import { asJson } from '@/lib/json'
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
  const { data, error } = await supabase.from('notifications').select('*').order('event').order('channel')
  if (error) throw error
  return data ?? []
}

export async function updateNotificationTemplate(id: string, values: { is_enabled?: boolean; subject?: string | null; template?: string }) {
  const { error } = await supabase.from('notifications').update(values).eq('id', id)
  if (error) throw error
}

export async function listNotificationLogs(limit = 100) {
  const { data, error } = await supabase.from('notification_logs').select('*, orders(order_number)').order('created_at', { ascending: false }).limit(limit)
  if (error) throw error
  return data ?? []
}

export async function retryNotification(id: string) {
  const { error } = await supabase.rpc('retry_notification', { p_id: id })
  if (error) throw error
}

export type { Json }
