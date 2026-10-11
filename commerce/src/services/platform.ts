// Super Admin panel API. Every call is checked by the database (platform
// permissions and merchant assignment); the panel only hides what the
// signed-in employee cannot use.
import { invokeFunction } from '@/lib/functions'
import { supabase } from '@/lib/supabase'

export interface PlatformModule { code: string; name: string; actions: string[] }

export interface PlatformMe {
  user_id: string
  email: string
  full_name: string
  title: string | null
  role: { id: string; code: string; name: string; is_super: boolean }
  merchant_scope: 'ALL' | 'ASSIGNED'
  merchant_ids: string[] | null
  permissions: string[]
  modules: PlatformModule[]
  merchant_staff: boolean
  pending_approvals: number
  unread_notifications: number
  /** The employee's open customer-view session, if any. */
  support_session: import('@/services/support-center').SupportSession | null
  /** When this sign-in started and when the panel will ask to sign in again. */
  session?: { started_at: string | null; expires_at: string | null }
  /** The sign-in is older than the platform's session limit (or was signed out elsewhere). */
  session_expired?: boolean
}

export interface MerchantRef { id: string; number: number; name: string }

export interface OnboardingState { steps: Array<{ key: string; label: string; done: boolean }>; done: number; total: number }

export interface MerchantListItem {
  id: string
  number: number
  name: string
  slug: string | null
  status: MerchantStatus
  status_reason: string | null
  is_demo: boolean
  owner_email: string | null
  phone: string | null
  created_at: string
  onboarded_at: string | null
  account_manager: { id: string; name: string } | null
  stores: number
  store_platforms: string[]
  orders_total: number
  orders_30d: number
  last_order_at: string | null
  staff: number
  onboarding: OnboardingState
}

export type MerchantStatus = 'ONBOARDING' | 'ACTIVE' | 'SUSPENDED' | 'CLOSED'

export interface MerchantDetail {
  merchant: MerchantListItem & { website: string | null; address: string | null; business_type: string | null; notes: string | null; timezone: string; status_changed_at: string | null }
  account_manager: { id: string; name: string; email: string } | null
  onboarding: OnboardingState
  staff: Array<{ id: string; email: string; full_name: string; role: string; is_active: boolean; last_seen_at: string | null; deleted_at?: string | null }>
  stores: Array<{ id: string; platform: string; name: string; shop_domain: string; status: string; last_sync_at: string | null; last_error: string | null; orders_imported: number }>
  couriers: Array<{ id: string; name: string; provider: string | null; api_enabled: boolean; api_status: string | null; is_active: boolean }>
  activity: {
    orders_total: number; orders_30d: number; order_value_30d: number; returns_30d: number; last_order_at: string | null
    products: number; stock_units: number; shipments_30d: number; sms_sent_30d: number; courier_checks_30d: number
  }
  errors: Array<{ id: number; level: string; category: string; source: string; message: string; occurrences: number; last_seen_at: string }>
  recent_activity: Array<{ action: string; entity_type: string; actor_email: string | null; created_at: string }>
  notes: Array<{ id: string; body: string; pinned: boolean; author: string | null; created_at: string }>
  platform_log: Array<{ action: string; actor_email: string | null; reason: string | null; result: string; created_at: string }>
  can: { edit: boolean; manage: boolean }
}

export interface PlatformEmployee {
  user_id: string
  email: string
  full_name: string
  title: string | null
  phone: string | null
  is_active: boolean
  last_seen_at: string | null
  created_at: string
  role: { id: string; code: string; name: string; is_super: boolean }
  merchant_scope: 'ALL' | 'ASSIGNED'
  merchants: MerchantRef[]
  managed_merchants: number
}

export interface PlatformRole {
  id: string
  code: string
  name: string
  description: string | null
  is_system: boolean
  is_super: boolean
  staff: number
  permissions: string[]
}

export interface Approval {
  id: string
  action: string
  module: string
  summary: string
  reason: string
  status: 'PENDING' | 'EXECUTED' | 'REJECTED' | 'FAILED' | 'CANCELLED' | 'EXPIRED'
  merchant: MerchantRef | null
  requested_by: { id: string; name: string } | null
  decided_by: { id: string; name: string } | null
  requested_at: string
  expires_at: string
  decided_at: string | null
  decision_note: string | null
  error: string | null
  mine: boolean
  can_decide: boolean
  self_approved?: boolean
}

export interface PlatformAuditRow {
  id: number
  action: string
  result: 'SUCCESS' | 'FAILED' | 'DENIED' | 'REQUESTED'
  actor_email: string | null
  actor_id: string | null
  merchant: MerchantRef | null
  entity_type: string | null
  entity_id: string | null
  reason: string | null
  before: unknown
  after: unknown
  metadata: Record<string, unknown>
  request_id: string | null
  created_at: string
}

export interface PlatformSearchResult {
  merchants: Array<{ id: string; number: number; name: string; status: string; owner_email: string | null }>
  employees: Array<{ id: string; name: string; email: string; is_active: boolean }>
  stores: Array<{ id: string; platform: string; name: string; shop_domain: string; status: string; merchant_id: string; merchant: string }>
  orders: Array<{ id: string; order_number: string; external_order_number: string | null; status: string; merchant_id: string; merchant: string; created_at: string }>
  errors: Array<{ id: number; level: string; category: string; message: string; merchant_id: string | null; last_seen_at: string }>
  audit: Array<{ id: number; action: string; entity_id: string | null; actor_email: string | null; created_at: string }>
  tickets: Array<{ id: string; number: number; subject: string; status: string; merchant_id: string; merchant: string }>
}

export interface PlatformOverview {
  range: { from: string; to: string }
  merchants: { total: number; demo: number; by_status: Partial<Record<MerchantStatus, number>>; new: number; onboarded: number; quiet_30d: number }
  stores: Record<string, { connected: number; error: number }>
  orders: { count: number; value: number }
  sms: { sent: number; failed: number; queued: number; segments: number }
  courier: { history_checks: number; accounts_connected: number; bookings: number; webhook_failures: number }
  integrations: { errors: number; webhook_errors: number; failed_jobs: number }
  support: { open: number }
  pbx: { gateway_seen_at: string | null; businesses: number }
  series: Array<{ day: string; orders: number; merchants: number }>
  approvals_pending: number
  [extra: string]: unknown
}

/** Calls a platform database function; a refusal is reported to the audit log. */
export async function platformRpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn as never, args as never)
  if (error) {
    if (/PERMISSION_DENIED|permission denied/i.test(error.message)) {
      // The refused request was rolled back; record that it was tried.
      void supabase.rpc('platform_report_denied' as never, { p_action: fn, p_detail: { args: Object.keys(args) } } as never)
    }
    throw error
  }
  return data as T
}

export const platformMe = () => platformRpc<PlatformMe | null>('platform_me')
export const platformOverview = (from: string, to: string) => platformRpc<PlatformOverview>('platform_overview', { p_from: from, p_to: to })
export const platformSearch = (q: string) => platformRpc<PlatformSearchResult>('platform_search', { p_q: q })

export function listMerchants(filters: Record<string, string>, sort: string, direction: string, page: number, pageSize: number) {
  return platformRpc<{ total: number; items: MerchantListItem[]; counts: Partial<Record<MerchantStatus, number>> | null }>('platform_merchants_list', {
    p_filters: filters, p_sort: sort, p_direction: direction, p_limit: pageSize, p_offset: (page - 1) * pageSize,
  })
}
export const getMerchant = (id: string) => platformRpc<MerchantDetail>('platform_merchant_get', { p_id: id })
export const updateMerchant = (id: string, patch: Record<string, unknown>) => platformRpc<MerchantListItem>('platform_merchant_update', { p_id: id, p: patch })
export const addMerchantNote = (id: string, body: string, pinned = false) => platformRpc('platform_merchant_note_add', { p_merchant: id, p_body: body, p_pinned: pinned })
export const previewMerchantStatus = (ids: string[], status: string) =>
  platformRpc<{ status: string; token: string; needs_approval: boolean; items: Array<MerchantRef & { status: MerchantStatus; changes: boolean; allowed: boolean; open_orders: number; stores: number; staff: number }> }>(
    'platform_merchant_status_preview', { p_ids: ids, p_status: status })
export const setMerchantStatus = (ids: string[], status: string, reason: string, token: string) =>
  platformRpc<{ changed: number; approval_requests: string[] }>('platform_merchant_set_status', { p_ids: ids, p_status: status, p_reason: reason, p_token: token })

export function createMerchant(input: { merchant: Record<string, unknown>; owner: { email: string; full_name: string; password?: string } }) {
  return invokeFunction<{ merchant_id: string; owner_invited: boolean }>('platform-admin', { action: 'create_merchant', ...input })
}
export function setMerchantOwner(merchantId: string, owner: { email: string; full_name: string; password?: string }) {
  return invokeFunction<{ ok: true; owner_invited: boolean }>('platform-admin', { action: 'set_owner', merchant_id: merchantId, ...owner })
}

export const listEmployees = () => platformRpc<PlatformEmployee[]>('platform_staff_list')
export const listRoles = () => platformRpc<PlatformRole[]>('platform_roles_list')
export const saveRole = (role: { id?: string; name: string; description?: string | null; permissions: string[] }) => platformRpc<PlatformRole>('platform_role_save', { p: role })
export const deleteRole = (id: string) => platformRpc('platform_role_delete', { p_id: id })
export const saveEmployee = (p: Record<string, unknown>) => platformRpc<{ pending_approval?: string }>('platform_staff_save', { p })
export const setEmployeeActive = (userId: string, active: boolean, reason: string) =>
  platformRpc('platform_staff_set_active', { p_user: userId, p_active: active, p_reason: reason })
/** Removes a switched-off employee for good (and their login, when it runs no business). */
export const removeEmployee = (userId: string, reason: string) =>
  platformRpc<{ removed: boolean; login_removed: boolean }>('platform_staff_remove', { p_user: userId, p_reason: reason })
export function inviteEmployee(input: { email: string; full_name: string; role_id: string; title?: string; merchant_scope: 'ALL' | 'ASSIGNED'; merchant_ids: string[]; password?: string; reason?: string }) {
  return invokeFunction<{ employee: PlatformEmployee | { pending_approval: string }; invited: boolean }>('platform-admin', { action: 'invite_employee', ...input })
}

export const listApprovals = (status: string | null) => platformRpc<Approval[]>('platform_approvals_list', { p_status: status })
export const decideApproval = (id: string, approve: boolean, note?: string) =>
  platformRpc<{ status: string; error?: string }>('platform_approval_decide', { p_id: id, p_approve: approve, p_note: note ?? null })

export const listPlatformAudit = (filters: Record<string, string>, page: number, pageSize: number) =>
  platformRpc<{ total: number; items: PlatformAuditRow[] }>('platform_audit_list', { p_filters: filters, p_limit: pageSize, p_offset: (page - 1) * pageSize })
