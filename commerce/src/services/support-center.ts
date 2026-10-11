// Super Admin: support tickets, customer-view sessions and the staff
// notification inbox. The database checks every call (platform permissions
// and merchant assignment).
import { supabase } from '@/lib/supabase'
import { type MerchantRef, platformRpc } from '@/services/platform'

export type TicketStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED'
export type TicketPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT'
export type TicketView = 'active' | 'mine' | 'unassigned' | 'overdue' | 'waiting' | 'escalated' | 'resolved' | 'all'

export const TICKET_PRIORITY: Record<TicketPriority, { label: string; variant: 'neutral' | 'info' | 'warning' | 'danger' }> = {
  LOW: { label: 'Low', variant: 'neutral' },
  NORMAL: { label: 'Normal', variant: 'info' },
  HIGH: { label: 'High', variant: 'warning' },
  URGENT: { label: 'Urgent', variant: 'danger' },
}

export interface PlatformTicket {
  id: string
  number: number
  kind: 'BUG' | 'FEEDBACK'
  category: string
  subject: string
  status: TicketStatus
  priority: TicketPriority
  internal: boolean
  source: 'MERCHANT' | 'PLATFORM'
  merchant: MerchantRef & { status: string }
  reporter: { name: string; email: string; platform: boolean } | null
  assigned: { user_id: string; name: string; email: string } | null
  due_at: string | null
  overdue: boolean
  response_due_at: string
  first_response_at: string | null
  escalation_level: number
  escalated_at: string | null
  replies: number
  last_reply_at: string | null
  last_reply_from: 'MERCHANT' | 'PLATFORM' | null
  created_at: string
  updated_at: string
  resolved_at: string | null
}

export interface SupportSettings {
  sla_hours: Record<TicketPriority, number>
  response_hours: Record<TicketPriority, number>
  session_default_minutes: number
  session_max_minutes: number
  team_name: string
}

export interface TicketSummary {
  active: number; mine: number; unassigned: number; overdue: number; waiting: number; escalated: number; resolved_7d: number
  avg_resolution_hours_30d: number | null; avg_first_response_hours_30d: number | null; resolved_on_time_30d: number; resolved_30d: number
}

export interface TicketEvent {
  id: number
  kind: 'CREATED' | 'NOTE' | 'ASSIGNED' | 'STATUS' | 'PRIORITY' | 'DUE' | 'ESCALATED' | 'REPLY' | 'MERCHANT_REPLY' | 'SESSION'
  body: string | null
  data: Record<string, unknown>
  actor: string | null
  created_at: string
}

export interface SupportSession {
  id: string
  mode: 'VIEW' | 'ASSIST'
  reason: string
  staff: { user_id: string; name: string; email: string } | null
  merchant: MerchantRef
  ticket: { id: string; number: number; subject: string } | null
  started_at: string
  expires_at: string
  ended_at: string | null
  end_reason: string | null
  ended_by: string | null
  status: 'ACTIVE' | 'ENDED' | 'EXPIRED'
  minutes: number
}

export interface TicketDetail extends PlatformTicket {
  body: string
  rating: number | null
  context: Record<string, string>
  merchant_detail: MerchantRef & { status: string; owner_email: string | null; phone: string | null; is_demo: boolean; access_mode: string
    plan: { code: string; name: string; status: string } | null; account_manager: string | null }
  messages: Array<{ id: string; body: string; created_at: string; from: 'MERCHANT' | 'PLATFORM'; author: string | null; label: string | null }>
  events: TicketEvent[]
  logs: Array<{ id: number; level: string; category: string; source: string; message: string; occurrences: number; last_seen_at: string; resolved: boolean }>
  sessions: SupportSession[]
  other_open: Array<{ id: string; number: number; subject: string; status: TicketStatus; priority: TicketPriority; created_at: string }>
  assignable: Array<{ user_id: string; name: string; email: string }>
  can: { edit: boolean; manage: boolean; view_as: boolean }
}

export const listTickets = (filters: { view?: TicketView; q?: string; merchant?: string; priority?: string; assigned?: string }, limit = 50, offset = 0) =>
  platformRpc<{ total: number; rows: PlatformTicket[]; summary: TicketSummary; settings: SupportSettings; can: { create: boolean; edit: boolean; manage: boolean } }>(
    'platform_tickets_list', { p: filters, p_limit: limit, p_offset: offset })
export const getTicket = (id: string) => platformRpc<TicketDetail>('platform_ticket_get', { p_id: id })
export const createTicket = (p: { merchant: string; subject: string; body: string; priority: TicketPriority; category?: string; internal?: boolean; assign_to?: string | null }) =>
  platformRpc<PlatformTicket>('platform_ticket_create', { p })
export const replyTicket = (id: string, body: string) => platformRpc<PlatformTicket>('platform_ticket_reply', { p_id: id, p_body: body })
export const noteTicket = (id: string, body: string) => platformRpc<PlatformTicket>('platform_ticket_note', { p_id: id, p_body: body })
export const escalateTicket = (id: string, reason: string) => platformRpc<PlatformTicket>('platform_ticket_escalate', { p_id: id, p_reason: reason })
export const updateTicket = (id: string, p: { status?: TicketStatus; priority?: TicketPriority; due_at?: string; assigned_to?: string | null; reason?: string }) =>
  platformRpc<PlatformTicket>('platform_ticket_update', { p_id: id, p })
export const saveSupportSettings = (p: Partial<SupportSettings>, reason?: string) =>
  platformRpc<SupportSettings>('platform_support_settings_save', { p, p_reason: reason ?? null })

export const listSupportSessions = (filters: { merchant?: string; active?: boolean } = {}, limit = 100) =>
  platformRpc<{ mine: SupportSession | null; rows: SupportSession[]; settings: { default_minutes: number; max_minutes: number }; can: { start: boolean; manage: boolean } }>(
    'platform_support_sessions', { p: filters, p_limit: limit })
export const startSupportSession = (merchant: string, reason: string, minutes: number, ticket?: string | null) =>
  platformRpc<SupportSession>('platform_support_session_start', { p_merchant: merchant, p_reason: reason, p_minutes: minutes, p_ticket: ticket ?? null })
export const endSupportSession = (id?: string | null, reason?: string) =>
  platformRpc<SupportSession | null>('platform_support_session_end', { p_id: id ?? null, p_reason: reason ?? null })

export interface PlatformNotification {
  id: number
  kind: string
  severity: 'INFO' | 'WARN' | 'CRITICAL'
  title: string
  body: string | null
  link: string | null
  read: boolean
  created_at: string
  merchant: MerchantRef | null
}
export const listNotifications = (limit = 30) => platformRpc<{ unread: number; items: PlatformNotification[] }>('platform_notifications_list', { p_limit: limit })
export const markNotificationsRead = (ids?: number[]) => platformRpc<number>('platform_notifications_read', { p_ids: ids ?? null })

// ---- The merchant side: who from the platform looked at this account
export interface SupportAccessEntry { id: string; mode: string; reason: string; staff: string; ticket_number: number | null; started_at: string; ended_at: string; active: boolean }
export async function supportAccessLog(): Promise<SupportAccessEntry[]> {
  const { data, error } = await supabase.rpc('support_access_log' as never)
  if (error) throw error
  return (data ?? []) as unknown as SupportAccessEntry[]
}

/** Messages sent from the website contact form (Super Admin). */
export interface ContactMessage {
  id: number; name: string; email: string | null; phone: string | null; business: string | null
  topic: 'SALES' | 'SUPPORT' | 'PARTNERSHIP' | 'GENERAL'; message: string; page: string | null
  status: 'NEW' | 'REPLIED' | 'CLOSED'; note: string | null; handled_at: string | null; created_at: string
}
export const listContactMessages = (status: ContactMessage['status'] | null) =>
  platformRpc<{ items: ContactMessage[]; new: number }>('platform_contact_messages_list', { p_status: status })
export const updateContactMessage = (id: number, status: ContactMessage['status'], note?: string) =>
  platformRpc<ContactMessage>('platform_contact_message_update', { p_id: id, p_status: status, p_note: note ?? null })
