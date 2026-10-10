import { env } from '@/lib/env'
import { invokeFunction } from '@/lib/functions'
import { supabase } from '@/lib/supabase'
import type { Tables } from '@/types/database'

async function rpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name as never, args as never)
  if (error) throw error
  return data as T
}

// ------------------------------------------------------------ support tickets

export type Ticket = Tables<'support_tickets'>
export type TicketMessage = Tables<'support_ticket_messages'>
export type TicketKind = 'BUG' | 'FEEDBACK'
export type TicketStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED'

export const TICKET_STATUS: Record<TicketStatus, { label: string; variant: 'info' | 'warning' | 'success' | 'neutral' }> = {
  OPEN: { label: 'Open', variant: 'info' },
  IN_PROGRESS: { label: 'In progress', variant: 'warning' },
  RESOLVED: { label: 'Resolved', variant: 'success' },
  CLOSED: { label: 'Closed', variant: 'neutral' },
}
export const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const
export const BUG_CATEGORIES = [
  { value: 'ORDERS', label: 'Orders' }, { value: 'COURIER', label: 'Courier & parcels' }, { value: 'INVENTORY', label: 'Products & stock' },
  { value: 'PAYMENTS', label: 'Payments & finance' }, { value: 'STORE_SYNC', label: 'Shopify / store sync' }, { value: 'SMS', label: 'SMS & messages' },
  { value: 'PRINTING', label: 'Labels & printing' }, { value: 'GENERAL', label: 'Something else' },
] as const
export const FEEDBACK_CATEGORIES = [
  { value: 'FEATURE', label: 'New feature idea' }, { value: 'IMPROVEMENT', label: 'Make something better' },
  { value: 'DESIGN', label: 'Design & ease of use' }, { value: 'PRAISE', label: 'Something I like' }, { value: 'GENERAL', label: 'Other' },
] as const

export async function listTickets(kind: TicketKind, scope: 'mine' | 'all', userId: string): Promise<Ticket[]> {
  let q = supabase.from('support_tickets').select('*').eq('kind', kind).order('created_at', { ascending: false }).limit(200)
  if (scope === 'mine') q = q.eq('created_by', userId)
  const { data, error } = await q
  if (error) throw error
  return data ?? []
}
export async function ticketMessages(ticketId: string): Promise<TicketMessage[]> {
  const { data, error } = await supabase.from('support_ticket_messages').select('*').eq('ticket_id', ticketId).order('created_at')
  if (error) throw error
  return data ?? []
}
export const createTicket = (p: { kind: TicketKind; category: string; subject: string; body: string; rating?: number | null; priority?: string; context?: Record<string, string> }) =>
  rpc<Ticket>('support_ticket_create', { p })
export const replyTicket = (id: string, body: string) => rpc<TicketMessage>('support_ticket_reply', { p_id: id, p_body: body })
export const updateTicket = (id: string, p: { status?: TicketStatus; priority?: string }) => rpc<Ticket>('support_ticket_update', { p_id: id, p })

/** Page, browser and screen size attached to a bug report. */
export function pageContext(): Record<string, string> {
  return { page: location.pathname + location.search, browser: navigator.userAgent, screen: `${window.innerWidth}×${window.innerHeight}` }
}

// ------------------------------------------------------------ devices

export type DeviceStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'REVOKED'
export interface StaffDevice {
  id: string; profile_id: string; name: string; email: string; role: string; role_name: string; is_active: boolean
  label: string | null; user_agent: string | null; ip: string | null; status: DeviceStatus; note: string | null
  decided_by: string | null; decided_at: string | null; first_seen_at: string; last_seen_at: string; sessions: number; is_current: boolean
}
export interface DeviceSettings { enabled: boolean; auto_approve_first: boolean }
export const DEVICE_STATUS: Record<DeviceStatus, { label: string; variant: 'warning' | 'success' | 'danger' | 'neutral' }> = {
  PENDING: { label: 'Waiting', variant: 'warning' },
  APPROVED: { label: 'Approved', variant: 'success' },
  REJECTED: { label: 'Rejected', variant: 'danger' },
  REVOKED: { label: 'Revoked', variant: 'neutral' },
}
export const listDevices = () => rpc<{ settings: DeviceSettings; devices: StaffDevice[] }>('device_list')
export const decideDevice = (id: string, action: 'approve' | 'reject' | 'revoke', note?: string) =>
  rpc('device_decide', { p_id: id, p_action: action, p_note: note || undefined })
export const approveRecentDevices = (days: number) => rpc<number>('device_approve_recent', { p_days: days })
export const saveDeviceSettings = (p: Partial<DeviceSettings>) => rpc<DeviceSettings>('device_settings_save', { p })

// ------------------------------------------------------------ integrations & status

export interface IntegrationsOverview {
  channels: Array<{ name: string; platform: string; status: string; domain: string; last_sync_at: string | null; last_order_at: string | null; last_error: string | null; orders: number }>
  couriers: Array<{ name: string; provider: string; hint: string; at: string; last_event_at: string | null }>
  ads: Array<{ platform: string; name: string | null; status: string; last_error: string | null; at: string }>
  credentials: Record<string, { hint: string; at: string }>
  sms: { provider: string | null; enabled: boolean | null } | null
  site_keys: number
  domains: Array<{ domain: string; status: string }>
  pbx: { enabled: boolean | null; provider: string | null; mode: string | null; calls_7d: number; last_call_at: string | null } | null
}
export const integrationsOverview = () => rpc<IntegrationsOverview>('integrations_overview')

export type HealthState = 'ok' | 'warn' | 'down' | 'idle'
export interface StatusComponent { key: string; name: string; status: HealthState; detail: string; at: string | null }
export const systemStatus = () => rpc<{ checked_at: string; components: StatusComponent[] }>('system_status')

/** Edge functions answer a CORS preflight when they are deployed and running. */
export async function pingFunction(name: string): Promise<{ ok: boolean; ms: number }> {
  const url = `${env.supabaseUrl}/functions/v1/${name}`
  const started = performance.now()
  try {
    const res = await fetch(url, { method: 'OPTIONS', signal: AbortSignal.timeout(8000) })
    return { ok: res.ok, ms: Math.round(performance.now() - started) }
  } catch {
    return { ok: false, ms: Math.round(performance.now() - started) }
  }
}

// ------------------------------------------------------------ PBX

export interface PbxSettings {
  enabled: boolean; provider: string; click_mode: 'tel' | 'api'; api_method: 'GET' | 'POST'
  api_url_template: string; api_body_template: string; extensions: Array<{ profile_id: string; extension: string }>
}
export type PbxCall = Tables<'pbx_calls'>

export async function pbxSettings(): Promise<PbxSettings> {
  const { data, error } = await supabase.from('settings').select('value').eq('key', 'pbx').maybeSingle()
  if (error) throw error
  const v = (data?.value ?? {}) as Partial<PbxSettings>
  return {
    enabled: !!v.enabled, provider: v.provider ?? 'VoiceDrive', click_mode: v.click_mode ?? 'tel', api_method: v.api_method ?? 'GET',
    api_url_template: v.api_url_template ?? '', api_body_template: v.api_body_template ?? '', extensions: v.extensions ?? [],
  }
}
export const savePbxSettings = (p: Partial<PbxSettings>) => rpc<PbxSettings>('pbx_settings_save', { p })
export const pbxStatus = () => invokeFunction<{ has_api_secret: boolean; has_webhook: boolean; api_secret_hint: string | null }>('pbx', { action: 'status' })
export const pbxWebhookUrl = () => invokeFunction<{ url: string | null }>('pbx', { action: 'webhook_url' })
export const savePbxSecret = (p: { api_secret?: string; clear_api_secret?: boolean; rotate_webhook?: boolean }) =>
  invokeFunction<{ ok: true; has_api_secret: boolean; url: string }>('pbx', { action: 'save', ...p })
export const pbxCall = (phone: string, orderId?: string) => invokeFunction<{ ok: true; call_id: string; extension: string }>('pbx', { action: 'call', phone, order_id: orderId })

export async function listPbxCalls(filter: { phone?: string; limit?: number } = {}): Promise<PbxCall[]> {
  let q = supabase.from('pbx_calls').select('*').order('received_at', { ascending: false }).limit(filter.limit ?? 100)
  if (filter.phone) q = q.ilike('customer_phone', `%${filter.phone.replace(/\D/g, '').slice(-10)}%`)
  const { data, error } = await q
  if (error) throw error
  return data ?? []
}
