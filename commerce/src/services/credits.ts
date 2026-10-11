// Credits, metered services (SMS, BD Courier) and the platform's own service
// accounts. The database checks every call; secrets never come back to the browser.
import { formatMoney, formatNumber } from '@/lib/format'
import { invokeFunction } from '@/lib/functions'
import { supabase } from '@/lib/supabase'
import type { SmsProviderCode } from '@/services/sms'
import { platformRpc } from '@/services/platform'

export type CreditType = 'SMS' | 'COURIER' | 'AI' | 'BALANCE'

/** The store balance is kept in poisha (100 = 1 Tk); other credits are counted one by one. */
export const isMoneyCredit = (type: string) => type === 'BALANCE'
export const formatCredits = (type: string, amount: number) => (isMoneyCredit(type) ? formatMoney(amount / 100) : formatNumber(amount))
export type Service = 'SMS' | 'BD_COURIER'
export type LedgerKind = 'RECHARGE' | 'PROMO' | 'ADJUSTMENT' | 'USAGE' | 'REFUND' | 'EXPIRY'

export const LEDGER_KIND: Record<LedgerKind, { label: string; variant: 'success' | 'info' | 'violet' | 'neutral' | 'warning' | 'danger' }> = {
  RECHARGE: { label: 'Bought', variant: 'success' },
  PROMO: { label: 'Promotional', variant: 'violet' },
  ADJUSTMENT: { label: 'Adjustment', variant: 'info' },
  USAGE: { label: 'Used', variant: 'neutral' },
  REFUND: { label: 'Refunded', variant: 'success' },
  EXPIRY: { label: 'Expired', variant: 'warning' },
}

export interface LedgerEntry {
  id: number
  credit_type: CreditType
  kind: LedgerKind
  amount: number
  balance_after: number
  reason: string | null
  actor?: string | null
  expires_at?: string | null
  created_at: string
  merchant?: { id: string; number: number; name: string }
}

export interface CreditPackage { id: string; credit_type: CreditType; name: string; credits: number; bonus_credits: number; price: number; currency: string; status?: 'ACTIVE' | 'ARCHIVED'; sort_order?: number }

export interface UsageState {
  service: Service
  feature_state: string
  feature_enabled: boolean
  plan: string | null
  subscription_status: string | null
  access_mode: string
  unmetered: boolean
  unit: 'SEGMENT' | 'MESSAGE' | 'LOOKUP'
  free: { eligible: boolean; limit: number; used: number; remaining: number; period: 'ONCE' | 'MONTH'; merchant_limit: number | null }
  month_used: number
  monthly_cap: number | null
  after_free: 'CREDITS' | 'BLOCK'
  credits_per_unit: number
  credit_type: CreditType
  credits_available: number
  sender_id: string | null
}

export interface UsagePolicy {
  free: { enabled: boolean; limit: number; period: 'ONCE' | 'MONTH'; plans: string[]; statuses: string[] }
  unit: 'SEGMENT' | 'MESSAGE' | 'LOOKUP'
  after_free: 'CREDITS' | 'BLOCK'
  credits_per_unit: number
  monthly_cap: number | null
  unmetered_plans: string[]
  refund_undelivered?: boolean
  hold_hours?: number
}

export interface ServiceStatus {
  config: { connected: boolean; provider?: string | null; service?: string | null; hint: string | null; sender_id?: string; sender_ids?: string[]
    cost_per_segment?: number; balance?: number | null; balance_checked_at?: string | null; connected_at?: string | null
    last_test_at?: string | null; last_test_ok?: boolean | null; last_error?: string | null }
  credential: { hint: string; updated_at: string; updated_by: string | null } | null
  policy: UsagePolicy
  feature: { code: string; name: string; globally_enabled: boolean; release_stage: string } | null
  plans: Array<{ code: string; name: string; includes: boolean }>
  overrides: Array<{ merchant: { id: string; number: number; name: string }; free_limit: number | null; monthly_cap: number | null; sender_id: string | null; reason: string; set_at: string }>
  exceptions: Array<{ merchant: { id: string; number: number; name: string }; enabled: boolean | null; reason: string | null; expires_at: string | null }>
  can: { edit: boolean; manage: boolean }
}

export interface UsageMetrics {
  attempted: number; denied: number; succeeded: number; failed: number; in_progress: number; delivered: number; undelivered: number
  units: number; free_units: number; plan_units: number; credits: number; credits_refunded: number; provider_cost: number; estimated_cost: number
}
export interface UsageReport {
  service: Service
  range: { from: string; to: string }
  totals: Partial<UsageMetrics> & { merchants?: number }
  merchants: Array<UsageMetrics & { merchant_id: string; number: number; name: string }>
  daily: Array<{ day: string; attempted: number; succeeded: number; failed: number; denied: number }>
  denied_reasons: Record<string, number>
  recent: Array<{ id: string; merchant: { id: string; number: number; name: string }; status: string; charge: string; units: number; credits: number
    refunded: boolean; outcome: string | null; reason: string | null; error: string | null; reference: string | null; created_at: string }>
}

// ---- Super Admin
export const creditsOverview = (q?: string, type?: string) =>
  platformRpc<{
    types: Array<{ code: CreditType; name: string; unit: string; description: string; used_by: string | null; outstanding: number; merchants_with_balance: number; added_30d: number; used_30d: number }>
    merchants: Array<{ id: string; number: number; name: string; status: string; balances: Partial<Record<CreditType, number>> | null }>
    recent: LedgerEntry[]
    packages: CreditPackage[]
    settings: { approval_threshold?: number; balance_approval_threshold_tk?: number }
  }>('platform_credits_overview', { p_q: q || null, p_type: type || null, p_limit: 200 })
export const merchantCredits = (merchant: string) =>
  platformRpc<{
    balances: Array<{ code: CreditType; name: string; unit: string; balance: number; available: number; expiring_30d: number }>
    lots: Array<{ id: number; credit_type: CreditType; granted: number; remaining: number; expires_at: string | null; kind: LedgerKind; reason: string | null; created_at: string }>
    ledger: LedgerEntry[]
    usage: { sms: UsageState; bd_courier: UsageState }
    overrides: Array<{ service: Service; free_limit: number | null; monthly_cap: number | null; sender_id: string | null; reason: string }>
  }>('platform_merchant_credits', { p_merchant: merchant })
export const adjustCredits = (input: { merchant: string; type: CreditType; amount: number; kind: 'PROMO' | 'ADJUSTMENT'; reason: string; expiresAt?: string | null; requestId: string }) =>
  platformRpc<LedgerEntry & { pending_approval?: string }>('platform_credit_adjust', {
    p_merchant: input.merchant, p_type: input.type, p_amount: input.amount, p_kind: input.kind, p_reason: input.reason,
    p_expires_at: input.expiresAt ?? null, p_request_id: input.requestId,
  })
export const savePackage = (p: Record<string, unknown>) => platformRpc<CreditPackage>('platform_credit_package_save', { p })
export const serviceStatus = (service: Service) => platformRpc<ServiceStatus>('platform_service_status', { p_service: service })
export const saveUsagePolicy = (service: Service, policy: UsagePolicy, reason: string) =>
  platformRpc<UsagePolicy>('platform_usage_policy_save', { p_service: service, p_policy: policy, p_reason: reason })
export const setServiceOverride = (merchant: string, service: Service, v: { freeLimit: number | null; monthlyCap: number | null; senderId?: string | null; reason: string }) =>
  platformRpc<UsageState>('platform_service_override_set', {
    p_merchant: merchant, p_service: service, p_free_limit: v.freeLimit, p_monthly_cap: v.monthlyCap, p_sender_id: v.senderId ?? null, p_reason: v.reason,
  })
export const saveSmsSettings = (p: { sender_ids?: string[]; sender_id?: string; cost_per_segment?: number }, reason?: string) =>
  platformRpc('platform_sms_settings_save', { p, p_reason: reason ?? null })
export const usageReport = (service: Service, from: string, to: string, merchant?: string | null) =>
  platformRpc<UsageReport>('platform_usage_report', { p_service: service, p_from: from, p_to: to, p_merchant: merchant ?? null })
export const billingGateways = () =>
  platformRpc<{ gateways: Record<'bkash' | 'paystation', { enabled?: boolean; connected?: boolean; hint?: string | null; sandbox?: boolean; connected_at?: string | null }>; can_manage: boolean }>(
    'platform_billing_gateways')
export const toggleBillingGateway = (provider: 'bkash' | 'paystation', enabled: boolean) => platformRpc('platform_billing_gateway_toggle', { p_provider: provider, p_enabled: enabled })

// Platform service accounts (edge function; credentials go to Vault)
export const connectPlatformSms = (provider: SmsProviderCode, credentials: Record<string, string>, senderId: string) =>
  invokeFunction<{ ok: boolean; message: string; balance: number | null }>('platform-admin', { action: 'sms_connect', provider, credentials, sender_id: senderId || undefined })
export const disconnectPlatformSms = () => invokeFunction<{ ok: boolean }>('platform-admin', { action: 'sms_disconnect' })
export const platformSmsBalance = () => invokeFunction<{ balance: number | null; supported: boolean }>('platform-admin', { action: 'sms_balance' })
export const platformSmsTest = (to: string, message: string) => invokeFunction<{ ok: boolean; message_id: string | null }>('platform-admin', { action: 'sms_send_test', to, message })
export const connectBdCourier = (input: { service: 'bdcourier' | 'llcg'; api_key: string; base_url?: string; test_phone: string }) =>
  invokeFunction<{ ok: boolean; hint: string; result: unknown }>('platform-admin', { action: 'bd_courier_connect', ...input })
export const testBdCourier = (phone: string) => invokeFunction<{ ok: boolean; result: unknown }>('platform-admin', { action: 'bd_courier_test', test_phone: phone })
export const disconnectBdCourier = () => invokeFunction<{ ok: boolean }>('platform-admin', { action: 'bd_courier_disconnect' })
export const connectGateway = (provider: 'bkash' | 'paystation', sandbox: boolean, credentials: Record<string, string>) =>
  invokeFunction<{ ok: boolean; message: string }>('platform-admin', { action: 'gateway_connect', provider, sandbox, credentials })
export const disconnectGateway = (provider: 'bkash' | 'paystation') => invokeFunction<{ ok: boolean }>('platform-admin', { action: 'gateway_disconnect', provider })

// ---- Order fee (charged for each approved order, from the store balance)
export type OrderFeeCharge = 'CHARGED' | 'FREE' | 'EXEMPT' | 'UNPAID'
export interface OrderFeeSettings { enabled: boolean; fee: number; on_empty: 'BLOCK' | 'ALLOW'; free_per_month: number; unmetered_plans: string[]; low_balance_tk: number }
export interface OrderFeeState {
  enabled: boolean; fee: number; platform_fee: number; store_fee: number | null; exempt: boolean; override_reason: string | null
  plan: string | null; unmetered: boolean; on_empty: 'BLOCK' | 'ALLOW'; free_per_month: number; free_used: number; low_balance_tk: number
  balance_tk: number; orders_left: number | null; low_balance: boolean
  month: { approved: number; charged: number; free: number; unpaid: number; amount_tk: number }
}
export const ORDER_FEE_CHARGE: Record<OrderFeeCharge, { label: string; variant: 'success' | 'info' | 'neutral' | 'warning' }> = {
  CHARGED: { label: 'Charged', variant: 'neutral' },
  FREE: { label: 'Free', variant: 'success' },
  EXEMPT: { label: 'No fee', variant: 'info' },
  UNPAID: { label: 'Unpaid', variant: 'warning' },
}
export const orderFeeOverview = (q?: string) =>
  platformRpc<{
    settings: OrderFeeSettings
    plans: Array<{ code: string; name: string }>
    totals: { month_charged_tk: number; month_orders: number; unpaid_orders: number; unpaid_tk: number }
    stores: Array<OrderFeeState & { merchant_id: string; number: number; name: string; status: string }>
  }>('platform_order_fee_overview', { p_q: q || null, p_limit: 200 })
export const saveOrderFeeSettings = (p: OrderFeeSettings, reason: string) => platformRpc<OrderFeeSettings>('platform_order_fee_settings_save', { p, p_reason: reason })
export const setOrderFeeOverride = (merchant: string, fee: number | null, exempt: boolean, reason: string) =>
  platformRpc<OrderFeeState>('platform_order_fee_override_set', { p_merchant: merchant, p_fee: fee, p_exempt: exempt, p_reason: reason })
export const orderFeeCharges = (merchant: string) =>
  platformRpc<Array<{ id: number; order_id: string; order_number: string | null; fee: number; charge: OrderFeeCharge; created_at: string }>>(
    'platform_order_fee_charges', { p_merchant: merchant, p_limit: 100 })

// ---- The merchant's own credits
export interface MyCredits {
  balances: Array<{ code: CreditType; name: string; unit: string; description: string; available: number; expiring: Array<{ amount: number; expires_at: string }> }>
  packages: CreditPackage[]
  ledger: LedgerEntry[]
  usage: { sms: UsageState; bd_courier: UsageState }
  sms_policy: { refund_undelivered: boolean; hold_hours: number }
  recharges: Array<{ id: string; number: string; total: number; status: 'OPEN' | 'PAID' | 'VOID'; lines: Array<{ label: string; credits?: number }>; created_at: string; paid_at: string | null }>
  can_pay: boolean
  gateways: Array<'bkash' | 'paystation'>
  order_fee?: OrderFeeState
}

export async function myOrderFee(): Promise<OrderFeeState & { recent: Array<{ id: number; order_number: string | null; fee: number; charge: OrderFeeCharge; created_at: string }> }> {
  const { data, error } = await supabase.rpc('my_order_fee' as never)
  if (error) throw error
  return data as never
}

export async function myCredits(): Promise<MyCredits> {
  const { data, error } = await supabase.rpc('my_credits' as never)
  if (error) throw error
  return data as unknown as MyCredits
}
export async function startRecharge(packageId: string) {
  const { data, error } = await supabase.rpc('credits_start_recharge' as never, { p_package: packageId } as never)
  if (error) throw error
  return data as unknown as { id: string; number: string; total: number; gateways: string[] }
}
/** Sends the browser to the platform's gateway to pay one invoice (credits or subscription). */
export async function payInvoice(invoiceId: string, provider: 'bkash' | 'paystation') {
  const r = await invokeFunction<{ redirect_url: string }>('billing', { action: 'checkout', invoice_id: invoiceId, provider })
  window.location.assign(r.redirect_url)
}
