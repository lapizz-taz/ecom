// Plans, subscriptions, invoices, features and platform settings. The database
// checks every call (platform permissions, merchant assignment, second-person
// payment verification); the screens only hide what cannot be used.
import { supabase } from '@/lib/supabase'
import { platformRpc } from '@/services/platform'

export const LIMIT_KEYS = ['stores', 'staff', 'products', 'orders_per_month'] as const
export type LimitKey = (typeof LIMIT_KEYS)[number]
export const LIMIT_LABEL: Record<LimitKey, string> = { stores: 'Stores', staff: 'Staff logins', products: 'Products', orders_per_month: 'Orders a month' }
export type Limits = Partial<Record<LimitKey, number>>

export interface Plan {
  id: string
  code: string
  name: string
  description: string | null
  status: 'ACTIVE' | 'ARCHIVED'
  is_public: boolean
  price: number
  currency: string
  billing_interval: 'MONTH' | 'YEAR'
  trial_days: number
  limits: Limits
  overage: { order_price?: number }
  features: Record<string, boolean>
  sort_order: number
  subscribers?: number
  mrr?: number
}

export interface Addon { id: string; code: string; name: string; description: string | null; price: number; grants: Limits; status: 'ACTIVE' | 'ARCHIVED' }

export interface Feature {
  code: string
  name: string
  description: string | null
  category: string
  is_core: boolean
  globally_enabled: boolean
  release_stage: 'GA' | 'BETA' | 'INTERNAL'
  depends_on: string | null
  sort_order: number
  updated_at: string
}

export type EntitlementState = 'ENABLED' | 'CORE' | 'DISABLED_GLOBALLY' | 'DISABLED_FOR_MERCHANT' | 'NOT_IN_PLAN' | 'BETA_NOT_ENROLLED' | 'UNAVAILABLE'
export interface Entitlement { name: string; state: EntitlementState; enabled: boolean; limit: number | null; override: boolean | null; override_reason: string | null }

/** What each state means, in the words shown to the platform team and to merchants. */
export const ENTITLEMENT: Record<EntitlementState, { label: string; variant: 'success' | 'neutral' | 'warning' | 'danger' | 'info' | 'violet'; explain: string }> = {
  ENABLED: { label: 'On', variant: 'success', explain: 'Included and working' },
  CORE: { label: 'Always on', variant: 'neutral', explain: 'Part of the order workflow; cannot be switched off' },
  DISABLED_GLOBALLY: { label: 'Off for everyone', variant: 'danger', explain: 'Switched off by the platform for all merchants' },
  DISABLED_FOR_MERCHANT: { label: 'Off by admin', variant: 'danger', explain: 'Switched off for this merchant by the platform team' },
  NOT_IN_PLAN: { label: 'Not in plan', variant: 'neutral', explain: 'The current plan does not include it' },
  BETA_NOT_ENROLLED: { label: 'Early access', variant: 'violet', explain: 'In early access; not opened to this merchant' },
  UNAVAILABLE: { label: 'Temporarily unavailable', variant: 'warning', explain: 'Allowed, but the connection it needs is reporting errors or the platform team reported an outage' },
}

export type SubscriptionStatus = 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'PAUSED' | 'CANCELLED' | 'EXPIRED'
export const SUBSCRIPTION_STATUS: Record<SubscriptionStatus, { label: string; variant: 'success' | 'neutral' | 'warning' | 'danger' | 'info' }> = {
  TRIALING: { label: 'Trial', variant: 'info' },
  ACTIVE: { label: 'Active', variant: 'success' },
  PAST_DUE: { label: 'Past due', variant: 'warning' },
  PAUSED: { label: 'Paused', variant: 'neutral' },
  CANCELLED: { label: 'Cancelled', variant: 'neutral' },
  EXPIRED: { label: 'Expired', variant: 'danger' },
}

export type AccessMode = 'FULL' | 'READ_ONLY' | 'BLOCKED'
export const ACCESS_MODE: Record<AccessMode, { label: string; variant: 'success' | 'warning' | 'danger' }> = {
  FULL: { label: 'Full access', variant: 'success' },
  READ_ONLY: { label: 'Read-only', variant: 'warning' },
  BLOCKED: { label: 'Blocked', variant: 'danger' },
}

export interface Subscription {
  id: string
  merchant_id: string
  plan_id: string
  status: SubscriptionStatus
  price: number
  currency: string
  billing_interval: 'MONTH' | 'YEAR'
  started_at: string
  trial_ends_at: string | null
  current_period_start: string | null
  current_period_end: string | null
  grace_until: string | null
  cancel_at_period_end: boolean
  paused_at: string | null
  cancelled_at: string | null
}

export interface InvoiceLine { label: string; amount: number; kind: 'plan' | 'addon' | 'overage' | string }
export interface Invoice {
  id: string
  number: string
  merchant_id: string
  kind: 'SUBSCRIPTION' | 'CREDITS' | 'ADDON' | 'OTHER'
  period_start: string | null
  period_end: string | null
  lines: InvoiceLine[]
  total: number
  amount_paid: number
  currency: string
  status: 'OPEN' | 'PAID' | 'VOID'
  due_at: string
  paid_at: string | null
  void_reason: string | null
  created_at: string
  merchant_name?: string
  merchant_number?: number
}

export const PAYMENT_METHODS = ['BANK', 'BKASH', 'NAGAD', 'CASH', 'OTHER'] as const
export interface BillingPayment {
  id: string
  merchant_id: string
  invoice_id: string
  amount: number
  method: string
  reference: string | null
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'REJECTED'
  recorded_by: string | null
  verified_by: string | null
  verified_at: string | null
  note: string | null
  created_at: string
  invoice_number?: string
  merchant?: string
  can_verify?: boolean
}

export interface MerchantBilling {
  subscription: (Subscription & { plan: Plan }) | null
  access_mode: AccessMode
  limits: Limits
  usage: Record<LimitKey, number>
  entitlements: Record<string, Entitlement>
  addons: Array<{ id: string; name: string; quantity: number; price: number; grants: Limits }>
  invoices: Invoice[]
  payments: BillingPayment[]
  events: Array<{ id: number; event: string; detail: Record<string, unknown>; created_at: string }>
}

export interface ConfigVersion { id: number; kind: string; ref: string; data: Record<string, unknown>; note: string | null; changed_at: string; changed_by: string | null }

export const listPlans = () => platformRpc<{ plans: Plan[]; addons: Addon[]; features: Feature[] }>('platform_plans_list')
export const savePlan = (p: Record<string, unknown>) => platformRpc<Plan>('platform_plan_save', { p })
export const setPlanStatus = (id: string, status: 'ACTIVE' | 'ARCHIVED') => platformRpc('platform_plan_set_status', { p_id: id, p_status: status })
export const saveAddon = (p: Record<string, unknown>) => platformRpc<Addon>('platform_addon_save', { p })
export const saveFeature = (code: string, p: Record<string, unknown>) => platformRpc<Feature>('platform_feature_save', { p_code: code, p })
export const setMerchantFeature = (merchant: string, code: string, enabled: boolean | null, reason: string, expiresAt?: string | null) =>
  platformRpc<Entitlement>('platform_merchant_feature_set', { p_merchant: merchant, p_code: code, p_enabled: enabled, p_reason: reason, p_limit: null, p_expires_at: expiresAt ?? null })
export const previewFeatureBulk = (merchants: string[], code: string, enabled: boolean | null) =>
  platformRpc<{ items: Array<{ id: string; number: number; name: string; now: EntitlementState; allowed: boolean }>; token: string }>('platform_feature_bulk_preview', { p_merchants: merchants, p_code: code, p_enabled: enabled })
export const applyFeatureBulk = (merchants: string[], code: string, enabled: boolean | null, reason: string, token: string) =>
  platformRpc<{ changed: number }>('platform_feature_bulk_apply', { p_merchants: merchants, p_code: code, p_enabled: enabled, p_reason: reason, p_token: token })
export const merchantBilling = (merchant: string) => platformRpc<MerchantBilling>('platform_merchant_billing', { p_merchant: merchant })
export const subscriptionAction = (merchant: string, action: string, p: Record<string, unknown>) =>
  platformRpc<MerchantBilling>('platform_subscription_action', { p_merchant: merchant, p_action: action, p })
export const listInvoices = (filters: { status?: string; overdue?: boolean }, page: number, pageSize: number) =>
  platformRpc<{ total: number; items: Invoice[]; pending_payments: BillingPayment[] }>('platform_invoices_list', { p_filters: filters, p_limit: pageSize, p_offset: (page - 1) * pageSize })
export const recordPayment = (invoice: string, p: { amount: number; method: string; reference: string; note?: string }) =>
  platformRpc<BillingPayment>('platform_payment_record', { p_invoice: invoice, p })
export const verifyPayment = (payment: string, approve: boolean, note?: string) =>
  platformRpc<{ payment: BillingPayment; invoice: Invoice | null }>('platform_payment_verify', { p_payment: payment, p_approve: approve, p_note: note ?? null })
export const voidInvoice = (invoice: string, reason: string) => platformRpc('platform_invoice_void', { p_invoice: invoice, p_reason: reason })
export const platformSettings = () => platformRpc<Record<string, { value: Record<string, unknown>; description: string | null; updated_at: string }>>('platform_settings_get')
export const savePlatformSetting = (key: string, value: Record<string, unknown>, reason?: string) =>
  platformRpc('platform_setting_save', { p_key: key, p_value: value, p_reason: reason ?? null })
export const configHistory = (kind?: string | null, ref?: string | null, limit = 100) =>
  platformRpc<ConfigVersion[]>('platform_config_history', { p_kind: kind ?? null, p_ref: ref ?? null, p_limit: limit })
export const rollbackConfig = (version: number, reason: string) => platformRpc<{ rolled_back_to: number }>('platform_config_rollback', { p_version: version, p_reason: reason })

/** The signed-in merchant's own plan, limits, features and invoices. */
export interface MyPlan {
  merchant: { name: string; status: string; status_reason: string | null }
  access_mode: AccessMode
  subscription: {
    status: SubscriptionStatus; price: number; currency: string; billing_interval: 'MONTH' | 'YEAR'; trial_ends_at: string | null
    current_period_end: string | null; grace_until: string | null; cancel_at_period_end: boolean; plan: { name: string; code: string; description: string | null }
  } | null
  limits: Limits
  usage: Record<LimitKey, number>
  features: Record<string, Entitlement>
  invoices: Array<Pick<Invoice, 'id' | 'number' | 'total' | 'amount_paid' | 'currency' | 'status' | 'due_at' | 'paid_at' | 'period_start' | 'period_end' | 'lines'>>
}

export async function myPlan(): Promise<MyPlan> {
  const { data, error } = await supabase.rpc('my_plan' as never)
  if (error) throw error
  return data as unknown as MyPlan
}
