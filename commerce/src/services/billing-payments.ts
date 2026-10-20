// Billing & Payments: what a store buys online (SMS credits at a price per
// credit, balance top-ups), its payment history and receipts, and the Super
// Admin's view of every payment. Prices are worked out by the database from
// the quantity; nothing here sends an amount to pay.
import { invokeFunction } from '@/lib/functions'
import { supabase } from '@/lib/supabase'
import { platformRpc } from '@/services/platform'
import type { PlatformGateway } from './credits'

export type PaymentStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED' | 'REFUND_PENDING' | 'REFUNDED'
export type PaymentPurpose = 'SUBSCRIPTION' | 'SMS' | 'COURIER' | 'BALANCE' | 'ADDON' | 'OTHER'
export type BuyType = 'SMS' | 'COURIER' | 'BALANCE'

export const PAYMENT_STATUS: Record<PaymentStatus, { label: string; variant: 'success' | 'warning' | 'danger' | 'neutral' | 'info' }> = {
  PENDING: { label: 'Pending', variant: 'warning' },
  SUCCEEDED: { label: 'Paid', variant: 'success' },
  FAILED: { label: 'Failed', variant: 'danger' },
  REJECTED: { label: 'Rejected', variant: 'danger' },
  CANCELLED: { label: 'Cancelled', variant: 'neutral' },
  EXPIRED: { label: 'Expired', variant: 'neutral' },
  REFUND_PENDING: { label: 'Refund pending', variant: 'info' },
  REFUNDED: { label: 'Refunded', variant: 'info' },
}

export const PURPOSE_LABEL: Record<PaymentPurpose, string> = {
  SUBSCRIPTION: 'Subscription', SMS: 'SMS credits', COURIER: 'Courier checks', BALANCE: 'Balance top-up', ADDON: 'Add-on', OTHER: 'Other',
}

export interface Pricing { enabled: boolean; unit_price?: number; min: number; max: number; presets: number[] }

export interface MyPayment {
  id: string
  reference: string
  amount: number
  currency: string
  status: PaymentStatus
  purpose: PaymentPurpose | null
  method: string
  provider: string | null
  refunded_amount: number
  status_reason: string | null
  transaction: string | null
  created_at: string
  verified_at: string | null
  invoice: { id: string; number: string; kind: string; status: string; description: string | null }
}

export interface MyBilling {
  can_pay: boolean
  gateways: PlatformGateway[]
  purposes: Partial<Record<PaymentPurpose, boolean>>
  max_payment_tk: number
  pricing: { SMS: Pricing; COURIER: Pricing; BALANCE: Pricing }
  payments: MyPayment[]
}

export interface Receipt {
  payment: { reference: string; amount: number; currency: string; status: PaymentStatus; method: string; provider: string | null; transaction: string | null
    paid_at: string; refunded_amount: number; purpose: PaymentPurpose | null }
  invoice: { number: string; kind: string; lines: Array<{ label: string; amount: number; credits?: number; quantity?: number; unit_price?: number }>; total: number
    period_start: string | null; period_end: string | null }
  store: { name: string; number: number; email: string | null; phone: string | null }
  issuer: string
}

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn as never, args as never)
  if (error) throw error
  return data as unknown as T
}

export const myBilling = () => rpc<MyBilling>('my_billing')
export const billingReceipt = (paymentId: string) => rpc<Receipt>('billing_receipt', { p_payment: paymentId })
/** An invoice for this many credits (or Tk of balance), priced by the database. */
export const buyCredits = (type: BuyType, quantity: number) =>
  rpc<{ id: string; number: string; total: number }>('credits_buy', { p_type: type, p_quantity: quantity })

/** Whole poisha, so 1,000 × ৳0.36 shows as ৳360.00 exactly; the database works it out again. */
export function priceFor(quantity: number, unitPrice: number): number {
  return Math.round(quantity * Math.round(unitPrice * 100)) / 100
}

// ---- Super Admin
export interface BillingRow {
  id: string
  reference: string
  amount: number
  currency: string
  status: PaymentStatus
  purpose: PaymentPurpose | null
  method: string
  provider: string | null
  transaction: string | null
  refunded_amount: number
  needs_review: boolean
  review_note: string | null
  invoice_number: string
  created_at: string
  verified_at: string | null
  merchant: { id: string; name: string; number: number }
}

export interface BillingDashboard {
  range: { from: string; to: string }
  totals: {
    collected: number; succeeded_count: number; pending: number; pending_count: number; failed: number; failed_count: number
    cancelled_count: number; expired_count: number; refunded: number; refunded_count: number; review_count: number
  }
  by_purpose: Partial<Record<PaymentPurpose, number>>
  by_day: Array<{ day: string; collected: number }>
  count: number
  rows: BillingRow[]
  can_manage: boolean
  can_refund: boolean
}

export interface BillingFilters { from?: string; to?: string; q?: string; status?: string; purpose?: string; provider?: string; review?: boolean; limit?: number; offset?: number }

export interface BillingPaymentDetail {
  payment: BillingRow & { status_reason: string | null; provider_session: string | null; provider_txn_id: string | null; note: string | null; invoice_id: string }
  gateway_answer: unknown
  merchant: { id: string; name: string; number: number }
  invoice: { id: string; number: string; kind: string; status: string; lines: Array<{ label: string; amount: number; credits?: number }>; total: number; amount_paid: number
    period_start: string | null; period_end: string | null; paid_at: string | null }
  checks: Array<{ id: number; source: string; outcome: string; gateway_status: string | null; amount: number | null; txn: string | null; detail: Record<string, unknown>; created_at: string }>
  refunds: Array<{ id: string; amount: number; reason: string; method: 'GATEWAY' | 'MANUAL'; status: 'PROCESSING' | 'SUCCEEDED' | 'FAILED'; credits_reversed: number
    credits_short: number; provider_refund_id: string | null; error: string | null; requested_by: string | null; created_at: string; completed_at: string | null }>
  credits: Array<{ id: number; credit_type: string; kind: string; amount: number; balance_after: number; reason: string; created_at: string }>
  subscription_events: Array<{ event: string; created_at: string }>
  can_manage: boolean
  can_refund: boolean
}

export interface BillingControls {
  purposes: Record<'SUBSCRIPTION' | 'SMS' | 'COURIER' | 'BALANCE', boolean>
  max_payment_tk: number
  pricing: {
    SMS: { enabled: boolean; unit_poisha: number; min: number; max: number; presets: number[] }
    COURIER: { enabled: boolean; unit_poisha: number; min: number; max: number; presets: number[] }
    BALANCE: { enabled: boolean; min_tk: number; max_tk: number; presets: number[] }
  }
}

export const billingDashboard = (filters: BillingFilters) => platformRpc<BillingDashboard>('platform_billing_dashboard', { p: filters })
export const billingPayment = (id: string) => platformRpc<BillingPaymentDetail>('platform_billing_payment', { p_payment: id })
export const resolveBillingReview = (id: string, note: string) => platformRpc('platform_billing_review_resolve', { p_payment: id, p_note: note })
export const billingControls = () => platformRpc<{ controls: BillingControls; can_manage: boolean }>('platform_billing_controls')
export const saveBillingControls = (controls: BillingControls, reason: string) =>
  platformRpc<BillingControls>('platform_billing_controls_save', { p: controls, p_reason: reason })

export interface RecheckRow { reference: string; before: string; gateway: string; result: string }
export const recheckPayment = (paymentId: string) => invokeFunction<RecheckRow>('platform-admin', { action: 'billing_recheck', payment_id: paymentId })
export const reconcilePayments = (from: string, to: string) =>
  invokeFunction<{ checked: number; more: boolean; counts: Record<string, number>; rows: RecheckRow[] }>('platform-admin', { action: 'billing_reconcile', from, to })
export const refundPayment = (input: { payment_id: string; amount: number; reason: string; manual: boolean; reverse_credits: boolean }) =>
  invokeFunction<{ status: string; refund_id: string; message?: string; credits_reversed?: number; credits_short?: number; error?: string }>(
    'platform-admin', { action: 'billing_refund', ...input })
export const checkRefund = (refundId: string) =>
  invokeFunction<{ status: string; refund_id: string; message?: string }>('platform-admin', { action: 'billing_refund_check', refund_id: refundId })
