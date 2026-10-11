// Super Admin → System Health, Incident Management, Automation Rules and
// Notifications (announcements to merchants). Every call is checked by the
// database against the employee's platform permissions.
import { invokeFunction } from '@/lib/functions'
import { supabase } from '@/lib/supabase'
import { type MerchantRef, platformRpc } from '@/services/platform'

// ------------------------------------------------------------------ health

export type HealthStatus = 'ok' | 'warn' | 'down' | 'idle' | 'unknown'
export interface CronJob { name: string; schedule: string; active: boolean; last_status: string | null; last_end: string | null; last_message: string | null; runs_24h: number; failed_24h: number }
export interface HealthComponent {
  key: string; group: string; name: string; status: HealthStatus; detail: string; check: string; at: string | null
  retry?: 'store_jobs' | 'courier_webhooks'; retryable?: number; jobs?: CronJob[]
}
export interface PlatformHealth { checked_at: string; components: HealthComponent[]; incidents: { open: number; critical: number }; can: { manage: boolean } }
export interface SystemLog {
  id: number; level: 'ERROR' | 'WARN' | 'INFO'; category: string; source: string; message: string; context: Record<string, unknown>; occurrences: number
  first_seen_at: string; last_seen_at: string; resolved_at: string | null; merchant: MerchantRef | null
}
export interface EdgeHealth {
  at: string; runtime: { ok: boolean; version: string }; checks: Array<{ name: string; ok: boolean; ms: number; detail: string }>
  settings: { required: Record<string, boolean>; optional: Record<string, boolean> }
}
export interface RetryResult { kind: string; count: number; merchants: MerchantRef[]; preview: boolean }

export const platformHealth = () => platformRpc<PlatformHealth>('platform_health')
export const systemLogs = (filters: Record<string, unknown>, limit: number, offset: number) =>
  platformRpc<{ total: number; rows: SystemLog[]; by_category: Record<string, number> }>('platform_system_logs', { p: filters, p_limit: limit, p_offset: offset })
export const resolveLogs = (ids: number[], note?: string) => platformRpc<number>('platform_system_logs_resolve', { p_ids: ids, p_note: note ?? null })
export const healthRetry = (kind: string, preview: boolean, reason?: string) =>
  platformRpc<RetryResult>('platform_health_retry', { p_kind: kind, p_preview: preview, p_reason: reason ?? null })

/** Times a real request to the edge runtime (it checks its database and auth access too). */
export async function edgeHealth(): Promise<EdgeHealth & { round_trip_ms: number }> {
  const started = performance.now()
  const out = await invokeFunction<EdgeHealth>('platform-admin', { action: 'health' })
  return { ...out, round_trip_ms: Math.round(performance.now() - started) }
}

/** Times a trivial database call from this browser (the same path every screen uses). */
export async function databasePing(): Promise<number> {
  const started = performance.now()
  const { error } = await supabase.rpc('platform_me' as never)
  if (error) throw error
  return Math.round(performance.now() - started)
}

// --------------------------------------------------------------- incidents

export type IncidentSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
export type IncidentStatus = 'INVESTIGATING' | 'IDENTIFIED' | 'MONITORING' | 'RESOLVED'
export const INCIDENT_INTEGRATIONS = [
  { value: 'shopify', label: 'Shopify' }, { value: 'woocommerce', label: 'WooCommerce' }, { value: 'sms', label: 'SMS' },
  { value: 'bd_courier', label: 'BD Courier (courier history)' }, { value: 'pbx', label: 'PBX calling' }, { value: 'payments', label: 'Payments' },
  { value: 'couriers', label: 'Courier booking' }, { value: 'ads', label: 'Ads' }, { value: 'platform', label: 'The whole platform' },
] as const
// Integrations the feature system can show as "temporarily unavailable".
export const UNAVAILABLE_CAPABLE = ['shopify', 'woocommerce', 'sms', 'bd_courier', 'pbx']

export interface Incident {
  id: string; number: number; title: string; description: string | null; severity: IncidentSeverity; status: IncidentStatus
  integration: string | null; mark_unavailable: boolean; scope: 'ALL' | 'SELECTED' | 'NONE'; source: 'MANUAL' | 'AUTOMATION'
  assigned: { user_id: string; name: string; email: string } | null; merchants: MerchantRef[] | null
  started_at: string; resolved_at: string | null; resolution: string | null; created_at: string; updated_at: string; minutes_open: number
}
export interface IncidentDetail extends Incident {
  updates: Array<{ id: number; kind: string; body: string | null; data: Record<string, unknown>; actor: string | null; created_at: string }>
  rule: { id: string; name: string } | null
}
export interface IncidentList {
  rows: Incident[]
  summary: { open: number; critical: number; unavailable: string[]; resolved_30d: number; avg_minutes_30d: number | null }
  staff: Array<{ user_id: string; name: string }>
  can: { create: boolean; edit: boolean; manage: boolean }
}
export const listIncidents = (view: 'open' | 'resolved' | 'all') => platformRpc<IncidentList>('platform_incidents_list', { p: { view } })
export const getIncident = (id: string) => platformRpc<IncidentDetail>('platform_incident_get', { p_id: id })
export const createIncident = (p: Record<string, unknown>) => platformRpc<Incident>('platform_incident_create', { p })
export const updateIncident = (id: string, p: Record<string, unknown>) => platformRpc<Incident>('platform_incident_update', { p_id: id, p })
export const noteIncident = (id: string, body: string) => platformRpc<Incident>('platform_incident_note', { p_id: id, p_body: body })

// ----------------------------------------------------------- announcements

export type AnnouncementKind = 'MAINTENANCE' | 'FEATURE' | 'SUBSCRIPTION' | 'INTEGRATION' | 'USAGE' | 'RECHARGE' | 'GENERAL'
export const ANNOUNCEMENT_KINDS: Array<{ value: AnnouncementKind; label: string; hint: string }> = [
  { value: 'MAINTENANCE', label: 'Maintenance', hint: 'Planned work or downtime' },
  { value: 'INTEGRATION', label: 'Integration problem', hint: 'A connection is failing or degraded' },
  { value: 'SUBSCRIPTION', label: 'Subscription & billing', hint: 'Plans, prices, invoices' },
  { value: 'USAGE', label: 'Usage limit', hint: 'Limits reached or about to be' },
  { value: 'RECHARGE', label: 'Recharge reminder', hint: 'Low credits — merchants may turn these off' },
  { value: 'FEATURE', label: 'Feature release', hint: 'What is new — merchants may turn these off' },
  { value: 'GENERAL', label: 'General', hint: 'Anything else — merchants may turn these off' },
]
export interface Audience { type: 'ALL' | 'PLANS' | 'STATUSES' | 'MERCHANTS'; plans?: string[]; statuses?: string[]; merchants?: string[]; include_demo?: boolean }
export interface Announcement {
  id: string; number: number; kind: AnnouncementKind; severity: 'INFO' | 'WARN' | 'CRITICAL'; title: string; body: string; link: string | null
  audience: Audience; status: 'DRAFT' | 'SCHEDULED' | 'SENT' | 'CANCELLED'; publish_at: string | null; expires_at: string | null; sent_at: string | null
  recipients: number | null; source: 'MANUAL' | 'AUTOMATION' | 'INCIDENT'; incident_id: string | null; created_at: string
  delivered?: number; muted?: number; read_merchants?: number; readers?: number; created_by_email?: string | null
}
export interface AnnouncementList {
  rows: Announcement[]; plans: Array<{ code: string; name: string }>; optional_kinds: AnnouncementKind[]; can: { create: boolean; manage: boolean }
}
export interface AudiencePreview { count: number; muted: number; sample: Array<MerchantRef & { muted: boolean }> }
export const listAnnouncements = () => platformRpc<AnnouncementList>('platform_announcements_list', { p_limit: 200 })
export const getAnnouncement = (id: string) => platformRpc<Announcement & {
  deliveries: Array<{ merchant: MerchantRef; status: 'DELIVERED' | 'MUTED'; delivered_at: string; first_read_at: string | null; readers: number }>
}>('platform_announcement_get', { p_id: id })
export const previewAudience = (audience: Audience, kind: AnnouncementKind) => platformRpc<AudiencePreview>('platform_announcement_preview', { p_audience: audience, p_kind: kind })
export const saveAnnouncement = (p: Record<string, unknown>) => platformRpc<Announcement>('platform_announcement_save', { p })
export const sendAnnouncement = (id: string, expected: number, reason?: string) =>
  platformRpc<Announcement & { delivered: number }>('platform_announcement_send', { p_id: id, p_expected: expected, p_reason: reason ?? null })
export const cancelAnnouncement = (id: string, reason: string) => platformRpc<Announcement>('platform_announcement_cancel', { p_id: id, p_reason: reason })

// -------------------------------------------------------------- automation

export type AutomationTrigger = 'integration_failures' | 'payment_problems' | 'onboarding_incomplete' | 'usage_limit' | 'ticket_overdue' | 'credentials_expiring' | 'service_down'
export type AutomationActionType = 'notify_staff' | 'notify_account_manager' | 'escalate_ticket' | 'create_incident' | 'notify_merchant'
export interface AutomationAction {
  type: AutomationActionType; module?: string; action?: string; severity?: string; kind?: AnnouncementKind; title?: string; body?: string; link?: string
}
export interface AutomationRule {
  id: string; name: string; description: string | null; trigger: AutomationTrigger; conditions: Record<string, number>; actions: AutomationAction[]
  enabled: boolean; cooldown_minutes: number; max_actions_per_run: number; last_run_at: string | null
  last_result: { acted: number; failed: number; skipped: number; manual: boolean } | null; runs_7d: number; failed_7d: number; created_at: string
}
export interface AutomationCatalogEntry { name: string; subject: string; help: string; conditions: Record<string, number>; actions: AutomationActionType[] }
export interface AutomationRules {
  rules: AutomationRule[]; catalog: Record<AutomationTrigger, AutomationCatalogEntry>
  modules: Array<{ code: string; name: string; actions: string[] }>
  can: { create: boolean; edit: boolean; delete: boolean; manage: boolean }
}
export interface AutomationRun {
  id: number; rule: { id: string; name: string }; subject: string; merchant: MerchantRef | null; title: string | null
  status: 'ACTED' | 'FAILED'; actions: Array<Record<string, unknown>>; error: string | null; manual: boolean; created_at: string
}
export interface AutomationDryRun {
  matches: number; would_act: number; subjects: Array<{ key: string; title: string; detail: string | null; in_cooldown: boolean }>; actions: AutomationAction[]
}
export const listAutomationRules = () => platformRpc<AutomationRules>('platform_automation_rules_list')
export const listAutomationRuns = (rule?: string | null) => platformRpc<AutomationRun[]>('platform_automation_runs_list', { p_rule: rule ?? null, p_limit: 100 })
export const saveAutomationRule = (p: Record<string, unknown>, reason?: string) => platformRpc<AutomationRule>('platform_automation_rule_save', { p, p_reason: reason ?? null })
export const archiveAutomationRule = (id: string, reason: string) => platformRpc<AutomationRule>('platform_automation_rule_archive', { p_id: id, p_reason: reason })
export const testAutomationRule = (p: Record<string, unknown>) => platformRpc<AutomationDryRun>('platform_automation_test', { p })
export const runAutomationRule = (id: string) =>
  platformRpc<Array<{ rule: string; name: string; acted: number; failed: number; skipped: number }>>('platform_automation_run', { p_rule: id })

// --------------------------------------------------- the merchant's side

export interface MyAnnouncement {
  id: string; kind: AnnouncementKind; severity: 'INFO' | 'WARN' | 'CRITICAL'; title: string; body: string; link: string | null
  sent_at: string; expires_at: string | null; read: boolean
}
export interface MyAnnouncements { items: MyAnnouncement[]; muted: AnnouncementKind[]; optional_kinds: AnnouncementKind[] }

async function rpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name as never, args as never)
  if (error) throw error
  return data as T
}
export const myAnnouncements = () => rpc<MyAnnouncements>('my_announcements')
export const markAnnouncementRead = (id: string) => rpc<void>('announcement_mark_read', { p_id: id })
export const saveAnnouncementPreferences = (muted: AnnouncementKind[]) => rpc<{ muted: AnnouncementKind[] }>('announcement_preferences_save', { p_muted: muted })
