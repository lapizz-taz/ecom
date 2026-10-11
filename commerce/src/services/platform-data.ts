// Super Admin → Security Center (access review, sign-out), Data Management
// (backups, exports, retention, deletion requests, import errors, restore
// tests) and Global Settings. Every call is permission-checked by the database.
import { invokeFunction } from '@/lib/functions'
import { supabase } from '@/lib/supabase'
import { type MerchantRef, platformRpc } from '@/services/platform'

// ---------------------------------------------------------------- security

export interface StaffAccess {
  user_id: string; email: string; name: string; active: boolean; role: { code: string; name: string; is_super: boolean }
  scope: 'ALL' | 'ASSIGNED'; privileged: boolean; last_sign_in_at: string | null; last_seen_at: string | null
  sessions: number; oldest_session_at: string | null; second_factors: number; last_action_at: string | null; denied_7d: number
}
export interface SecurityOverview {
  settings: { staff_session_hours?: number | null }
  staff: StaffAccess[]
  credentials: Array<{ key: string; hint: string | null; updated_at: string; age_days: number; updated_by: string | null }>
  counts: { denied_24h: number; pending_approvals: number; support_sessions_open: number }
  sensitive: Array<{ id: number; action: string; actor: string | null; reason: string | null; result: string; created_at: string; merchant: MerchantRef | null }>
  can: { manage: boolean }
}
export const securityOverview = () => platformRpc<SecurityOverview>('platform_security_overview')
export const signOutStaff = (user: string, reason: string) => platformRpc<{ sessions_ended: number }>('platform_staff_sign_out', { p_user: user, p_reason: reason })

// -------------------------------------------------------------------- data

export type DeletionStatus = 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'COMPLETED'
export interface DeletionRequest {
  id: string; number: number; merchant: MerchantRef & { status: string }; source: 'MERCHANT' | 'PLATFORM'; reason: string; status: DeletionStatus
  requested_by_email: string | null; decided_by_name: string | null; decided_at: string | null; decision_note: string | null
  erase_after: string | null; completed_by_name: string | null; completed_at: string | null; result: Record<string, number> | null
  exports: number; ready: boolean; created_at: string
}
export interface DataExport { id: number; kind: string; actor: string | null; reason: string | null; detail: Record<string, unknown>; created_at: string; merchant: MerchantRef | null }
export interface RestoreTest {
  id: number; tested_at: string; backup_taken_at: string | null; environment: string; result: 'PASSED' | 'PARTIAL' | 'FAILED'
  duration_minutes: number | null; checks: Record<string, unknown>; notes: string | null; recorded_by_email: string | null
}
export interface ImportError {
  id: string; external_number: string; error: string | null; warnings: string[] | null; attempts: number; received_via: string; updated_at: string
  channel: { id: string; name: string; platform: string }; merchant: MerchantRef
}
export interface DataOverview {
  database: { size: string; tables: Record<string, number>; at: string }
  retention: {
    policy: { system_logs_days?: number; notifications_days?: number; deletion_cooling_days?: number }
    last_run: { last_run_at: string; system_logs_removed: number; notifications_removed: number } | null
    due: { system_logs: number; notifications: number }
  }
  exports: DataExport[]
  deletion_requests: DeletionRequest[]
  restore_tests: RestoreTest[]
  imports: { failed_30d: number; rows: ImportError[] }
  can: { export: boolean; manage: boolean; approve: boolean }
}
export interface BackupStatus {
  configured: boolean; ref: string; ok?: boolean; status?: number; error?: string; region?: string | null; pitr_enabled?: boolean
  last_completed?: string | null; backups?: Array<{ status: string | null; inserted_at: string | null; physical: boolean }>
}

export const dataOverview = () => platformRpc<DataOverview>('platform_data_overview')
export const backupStatus = () => invokeFunction<BackupStatus>('platform-admin', { action: 'backups' })
export const runRetention = (reason: string) => platformRpc<{ system_logs_removed: number; notifications_removed: number }>('platform_retention_run_now', { p_reason: reason })
export const exportMerchantData = (merchant: string, reason: string) =>
  platformRpc<{ exported_at: string; export_id: number; rows: Record<string, number>; capped_at: number; data: Record<string, unknown> }>('platform_merchant_export', { p_merchant: merchant, p_reason: reason })
/** Records a download made in the browser (lists, audit log, usage). */
export const recordExport = (kind: 'MERCHANTS' | 'AUDIT' | 'USAGE' | 'REVENUE', detail: Record<string, unknown>) =>
  platformRpc<number>('platform_export_record', { p_kind: kind, p_detail: detail, p_merchant: null })
export type ResetScope = 'ORDERS' | 'EVERYTHING'
export interface StoreReset { id: string; scope: ResetScope; reason: string; status: 'RUNNING' | 'DONE'; requested_by_email: string | null; counts: Record<string, number> | null; created_at: string; finished_at: string | null }
export const storeResets = (merchant: string) =>
  platformRpc<{ resets: StoreReset[]; last_export_at: string | null; export_valid_until: string | null }>('platform_store_resets', { p_merchant: merchant })
export const resetStore = (merchant: string, scope: ResetScope, confirmName: string, reason: string) =>
  platformRpc<{ reset_id: string; scope: ResetScope; counts: Record<string, number> }>('platform_store_reset',
    { p_merchant: merchant, p_scope: scope, p_confirm_name: confirmName, p_reason: reason })
export const createDeletionRequest = (merchant: string, reason: string) => platformRpc<DeletionRequest>('platform_deletion_request_create', { p_merchant: merchant, p_reason: reason })
export const decideDeletionRequest = (id: string, approve: boolean, note: string) =>
  platformRpc<DeletionRequest>('platform_deletion_request_decide', { p_id: id, p_approve: approve, p_note: note })
export const cancelDeletionRequest = (id: string, reason: string) => platformRpc<DeletionRequest>('platform_deletion_request_cancel', { p_id: id, p_reason: reason })
export const executeDeletionRequest = (id: string, confirm: string) => platformRpc<DeletionRequest>('platform_deletion_request_execute', { p_id: id, p_confirm: confirm })
export const recordRestoreTest = (p: Record<string, unknown>) => platformRpc<RestoreTest>('platform_restore_test_record', { p })

// --------------------------------------------------------- global settings

export interface GlobalSettings {
  settings: Record<string, { value: Record<string, unknown>; description: string | null; updated_at: string
    last_change: { id: number; at: string; note: string | null; by: string | null } | null }>
  releases: Array<{ code: string; name: string; stage: 'GA' | 'BETA' | 'INTERNAL'; globally_enabled: boolean; enrolled: number; enrolled_demo: number }>
  demo_merchants: number
  can: { edit: boolean; security: boolean; data: boolean }
}
export const globalSettings = () => platformRpc<GlobalSettings>('platform_global_settings')

// ------------------------------------------------------- the merchant side

export interface MyDeletionRequest { id: string; number: number; status: DeletionStatus; reason: string; created_at: string; erase_after: string | null; decision_note: string | null; is_owner: boolean }
async function rpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name as never, args as never)
  if (error) throw error
  return data as T
}
export const myDeletionRequest = () => rpc<MyDeletionRequest | null>('my_data_deletion_request')
export const requestDataDeletion = (reason: string) => rpc<{ id: string; number: number }>('merchant_data_deletion_request', { p_reason: reason })
export const cancelDataDeletion = () => rpc<void>('merchant_data_deletion_cancel')

/** Super Admin: the root domain for store subdomains and what the platform address shows. */
export async function saveStoreDomains(value: { root_domain: string | null; main_site: 'marketing' | 'store' }, reason: string) {
  const { error } = await supabase.rpc('platform_store_domains_save', { p_value: value, p_reason: reason })
  if (error) throw error
}
