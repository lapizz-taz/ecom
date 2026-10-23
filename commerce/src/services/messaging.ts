// Email and WhatsApp modules: the store's customer emails and WhatsApp messages, how they are
// sent, and their log. Templates, settings and the log are read here; sending, mailbox passwords
// and Meta go through the messaging function.
import { invokeFunction } from '@/lib/functions'
import { fromJson } from '@/lib/json'
import { supabase } from '@/lib/supabase'
import type { Json, Tables } from '@/types/database'

export type MessageChannel = 'EMAIL' | 'WHATSAPP'
export type CustomerMessage = Tables<'notifications'>

export interface EmailSettings {
  enabled: boolean
  provider: 'smtp' | 'fullfilio' | 'none'
  from_name: string
  reply_to: string
  ready: boolean
  smtp_saved: boolean
  smtp: { host: string; port: number; security: 'ssl' | 'starttls'; username: string; from_email: string }
  design: { logo_url: string | null; accent_color: string }
  service: { available: boolean; from_email: string | null; daily_limit: number; sent_today: number }
  store: { name: string; email: string; logo_url: string | null }
  connected_at?: string
}

export interface WhatsappNumber { id: string; name: string; display_phone: string | null; waba_id: string | null; status: string }
export interface WhatsappSettings {
  enabled: boolean
  provider: 'meta' | 'none'
  channel_id: string | null
  language: 'en' | 'bn'
  numbers: WhatsappNumber[]
  ready: boolean
}

// ------------------------------------------------------------------ settings
export async function emailSettings() {
  const { data, error } = await supabase.rpc('email_settings')
  if (error) throw error
  return fromJson<EmailSettings>(data)
}

export async function saveEmailSettings(patch: Partial<Pick<EmailSettings, 'enabled' | 'provider' | 'from_name' | 'reply_to' | 'design'>>) {
  const { data, error } = await supabase.rpc('email_settings_save', { p: patch as unknown as Json })
  if (error) throw error
  return fromJson<EmailSettings>(data)
}

export interface MailboxInput { host: string; port: number; security: 'ssl' | 'starttls'; username: string; password?: string; from_email: string }
export const connectMailbox = (m: MailboxInput) => invokeFunction<{ ok: true; sent_to: string }>('messaging', { action: 'email_connect', ...m })
export const disconnectMailbox = () => invokeFunction<{ ok: true }>('messaging', { action: 'email_disconnect' })

export async function whatsappSettings() {
  const { data, error } = await supabase.rpc('whatsapp_settings')
  if (error) throw error
  return fromJson<WhatsappSettings>(data)
}

export async function saveWhatsappSettings(patch: Partial<Pick<WhatsappSettings, 'enabled' | 'channel_id' | 'language'>>) {
  const { data, error } = await supabase.rpc('whatsapp_settings_save', { p: patch as unknown as Json })
  if (error) throw error
  return fromJson<WhatsappSettings>(data)
}

// ------------------------------------------------------------------ messages
export async function listMessages(channel: MessageChannel) {
  const { data, error } = await supabase.from('notifications').select('*').eq('channel', channel).neq('event', 'ADVANCE_RECEIVED').order('created_at').order('id')
  if (error) throw error
  return data ?? []
}

export async function getMessage(id: string) {
  const { data, error } = await supabase.from('notifications').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return data
}

export async function messageDefault(channel: MessageChannel, event: string) {
  const { data, error } = await supabase.from('notification_defaults').select('subject, template').eq('channel', channel).eq('event', event as never).maybeSingle()
  if (error) throw error
  return data
}

export async function saveMessage(id: string, subject: string | null, template: string) {
  const { data, error } = await supabase.rpc('notification_message_save', { p_id: id, p_subject: subject as string, p_template: template })
  if (error) throw error
  return data
}

export async function setMessageEnabled(id: string, enabled: boolean) {
  const { error } = await supabase.rpc('notification_message_enable', { p_id: id, p_enabled: enabled })
  if (error) throw error
}

export async function resetMessage(id: string) {
  const { data, error } = await supabase.rpc('notification_message_reset', { p_id: id })
  if (error) throw error
  return data
}

/** A recent order of the store as an email sees it (null: none yet, or no access to orders). */
export async function previewData() {
  const { data, error } = await supabase.rpc('notification_preview_data', {})
  if (error) throw error
  return data ? fromJson<Record<string, unknown>>(data) : null
}

export const sendTestEmail = (id: string, draft: { subject?: string; template?: string; data?: Record<string, unknown> } = {}) =>
  invokeFunction<{ ok: true; sent_to: string }>('messaging', { action: 'email_test', notification_id: id, ...draft })

export const submitWhatsapp = (id: string) => invokeFunction<{ ok: true; name: string; status: string }>('messaging', { action: 'whatsapp_submit', notification_id: id })
export const syncWhatsapp = () => invokeFunction<{ ok: true; updated: number }>('messaging', { action: 'whatsapp_sync' })
export const testWhatsapp = (id: string, to: string) => invokeFunction<{ ok: true; sent_to: string }>('messaging', { action: 'whatsapp_test', notification_id: id, to })

// ------------------------------------------------------------------ log
export type MessageLog = Tables<'notification_logs'> & { orders: { id: string; order_number: string } | null }

export async function listMessageLogs(channel: MessageChannel, filter: { status?: string; search?: string } = {}, limit = 100) {
  let q = supabase.from('notification_logs').select('*, orders(id, order_number)').eq('channel', channel)
    .order('created_at', { ascending: false }).limit(limit)
  if (filter.status) q = q.eq('status', filter.status as never)
  if (filter.search?.trim()) q = q.ilike('recipient', `%${filter.search.trim().replace(/[%_]/g, '')}%`)
  const { data, error } = await q
  if (error) throw error
  return (data ?? []) as unknown as MessageLog[]
}

export async function retryMessage(id: string) {
  const { error } = await supabase.rpc('retry_notification', { p_id: id })
  if (error) throw error
}

// ------------------------------------------------------------------ orders
export interface OrderWhatsappMessages { phone: string | null; messages: Array<{ event: string; name: string; text: string }> }

/** The store's WhatsApp texts filled in for one order, for "Send on WhatsApp". */
export async function orderWhatsappMessages(orderId: string) {
  const { data, error } = await supabase.rpc('whatsapp_order_messages', { p_order_id: orderId })
  if (error) throw error
  return fromJson<OrderWhatsappMessages>(data)
}

/** A wa.me link that opens WhatsApp with the text written (staff press send). */
export const whatsappLink = (phone: string, text: string) => `https://wa.me/${phone.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`
