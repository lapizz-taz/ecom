import type { Condition, SmsEvent } from '@/features/sms/sms-text'
import { invokeFunction } from '@/lib/functions'
import { fromJson } from '@/lib/json'
import { supabase } from '@/lib/supabase'
import type { Enums } from '@/types/database'

export type SmsProviderCode = 'smsnetbd' | 'bulksmsbd' | 'sslwireless' | 'http'
export type MessageStatus = Enums<'notification_status'>
export type DeliveryStatus = 'PENDING' | 'DELIVERED' | 'FAILED' | 'UNKNOWN'

export interface SmsSettings {
  enabled: boolean
  connected: boolean
  provider: SmsProviderCode | null
  hint: string | null
  sender_id: string
  cost_per_sms: number
  currency_text: string
  balance: number | null
  balance_checked_at: string | null
  connected_at: string | null
}

export interface SmsOverview {
  settings: SmsSettings
  totals: {
    sent: number; failed: number; waiting: number; skipped: number; parts: number; cost: number
    delivered: number; undelivered: number; awaiting_report: number; orders: number
  }
  by_event: Array<{ event: string; sent: number; failed: number; parts: number; cost: number }>
  active_rules: number
}

export async function smsOverview(from: string, to: string) {
  const { data, error } = await supabase.rpc('sms_overview', { p_from: from, p_to: to })
  if (error) throw error
  return fromJson<SmsOverview>(data)
}

export async function updateSmsSettings(values: { enabled?: boolean; senderId?: string; costPerSms?: number; currencyText?: string }) {
  const { error } = await supabase.rpc('sms_update_settings', {
    p_enabled: values.enabled, p_sender_id: values.senderId, p_cost_per_sms: values.costPerSms, p_currency_text: values.currencyText,
  })
  if (error) throw error
}

// --- Provider (sms edge function: credentials go to Vault) -------------------
export function connectSms(provider: SmsProviderCode, credentials: Record<string, string>, senderId: string) {
  return invokeFunction<{ ok: boolean; message: string; balance: number | null }>('sms', {
    action: 'connect', provider, credentials, sender_id: senderId || undefined,
  })
}
export const disconnectSms = () => invokeFunction<{ ok: boolean }>('sms', { action: 'disconnect' })
export const refreshSmsBalance = () => invokeFunction<{ balance: number | null; supported: boolean }>('sms', { action: 'balance' })
export const sendTestSms = (to: string, message: string) =>
  invokeFunction<{ ok: boolean; parts: number; message_id: string | null }>('sms', { action: 'send_test', to, message })

// --- Automations -------------------------------------------------------------
export async function listSmsRules() {
  const { data, error } = await supabase.from('notifications').select('*').eq('channel', 'SMS').order('created_at').order('id')
  if (error) throw error
  return (data ?? []).map((r) => ({ ...r, conditions: (r.conditions ?? []) as unknown as Condition[] }))
}
export type SmsRule = Awaited<ReturnType<typeof listSmsRules>>[number]

export async function saveSmsRule(rule: { id?: string; event: SmsEvent; name: string; template: string; conditions: Condition[]; enabled: boolean }) {
  const { error } = await supabase.rpc('sms_rule_save', {
    p_id: rule.id ?? (null as unknown as string), p_event: rule.event, p_name: rule.name, p_template: rule.template,
    p_conditions: rule.conditions as never, p_enabled: rule.enabled,
  })
  if (error) throw error
}

export async function setSmsRuleEnabled(rule: SmsRule, enabled: boolean) {
  await saveSmsRule({
    id: rule.id, event: rule.event as SmsEvent, name: rule.name ?? '', template: rule.template, conditions: rule.conditions, enabled,
  })
}

export async function deleteSmsRule(id: string) {
  const { error } = await supabase.rpc('sms_rule_delete', { p_id: id })
  if (error) throw error
}

// --- Messages ----------------------------------------------------------------
const MESSAGE_COLUMNS = '*, orders(id, order_number)'

export async function listSmsMessages(f: { status?: MessageStatus | ''; event?: string; q?: string; page: number; pageSize: number }) {
  let query = supabase
    .from('notification_logs')
    .select(MESSAGE_COLUMNS, { count: 'exact' })
    .eq('channel', 'SMS')
    .order('created_at', { ascending: false })
    .range((f.page - 1) * f.pageSize, f.page * f.pageSize - 1)
  if (f.status) query = query.eq('status', f.status)
  if (f.event === 'TEST') query = query.is('event', null)
  else if (f.event) query = query.eq('event', f.event as Enums<'notification_event'>)
  const q = (f.q ?? '').trim()
  if (q) {
    const digits = q.replace(/\D/g, '')
    if (/^[\d\s+-]+$/.test(q) && digits.length >= 3) {
      query = query.ilike('recipient', `%${digits.replace(/^0/, '')}%`)
    } else {
      const { data: orders } = await supabase.from('orders').select('id').ilike('order_number', `%${q.replace(/[%,()]/g, '')}%`).limit(50)
      query = query.in('order_id', (orders ?? []).map((o) => o.id).concat('00000000-0000-0000-0000-000000000000'))
    }
  }
  const { data, error, count } = await query
  if (error) throw error
  return { items: data ?? [], total: count ?? 0 }
}
export type SmsMessageRow = Awaited<ReturnType<typeof listSmsMessages>>['items'][number]

/** Every customer message for one order (SMS, WhatsApp, email). */
export async function listOrderMessages(orderId: string) {
  const { data, error } = await supabase.from('notification_logs').select('*').eq('order_id', orderId).order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

export async function retryMessage(id: string) {
  const { error } = await supabase.rpc('retry_notification', { p_id: id })
  if (error) throw error
}
