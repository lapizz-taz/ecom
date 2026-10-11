// Usage & Analytics: platform-wide usage, revenue and costs, merchant health.
// Figures are labelled actual / calculated / estimate by the database.
import type { MerchantRef } from '@/services/platform'
import { platformRpc } from '@/services/platform'

export interface UsageOverviewRow extends MerchantRef {
  is_demo: boolean
  sms_attempted: number; sms_sent: number; sms_delivered: number; sms_failed: number; sms_refused: number; sms_billable: number; sms_free: number; sms_credits: number
  bd_attempted: number; bd_succeeded: number; bd_failed: number; bd_refused: number; bd_billable: number; bd_credits: number
  sms_state: { free_remaining: number; credits: number; unmetered: boolean } | null
  bd_state: { free_remaining: number; credits: number; unmetered: boolean; month_used: number; monthly_cap: number | null } | null
}
export interface UsageOverview {
  range: { from: string; to: string }
  totals: Record<string, number>
  merchants: UsageOverviewRow[]
  daily: Array<{ day: string; sms: number; sms_failed: number; bd: number; bd_failed: number }>
}
export const usageOverview = (from: string, to: string) => platformRpc<UsageOverview>('platform_usage_overview', { p_from: from, p_to: to })

export interface BusinessReport {
  range: { from: string; to: string }
  mrr: { mrr: number; arr: number; at_risk: number; trialing: number; paying: number }
  mrr_by_plan: Array<{ code: string; name: string; active: number; trialing: number; mrr: number }>
  revenue: { total: number; subscriptions: number; credits: number; addons: number; other: number; payments: number
    by_plan: Array<{ code: string; name: string; amount: number }>; refunds: number; refunds_note: string }
  merchants: { new: number; active: number; total: number }
  subscriptions: { renewals: number; cancelled: number; expired: number; paying_at_start: number; churned: number; churn_rate: number | null }
  payments: { failed: number; failed_amount: number; awaiting_verification: number; overdue_invoices: number; overdue_amount: number }
  sms: { credit_sales: number; units: number; free_units: number; credits_used: number; provider_cost_reported: number; units_without_cost: number; provider_cost_estimated: number | null }
  bd_courier: { credit_sales: number; lookups: number; free_lookups: number; failed: number; credits_used: number; cost_estimated: number | null }
  ai: { metered: boolean; note: string }
  costs: { by_category: Record<string, number>; total: number; months_with_entries: number; months_in_range: number; provider_reported: number; estimated: number; payment_fees_estimated: number | null }
  margin: { revenue: number; known_costs: number; estimated_costs: number; contribution: number; complete: boolean; assumptions: string[]; missing: string[] }
  by_merchant: Array<MerchantRef & { revenue: number; sms_cost: number; bd_cost: number | null; bd_lookups: number }>
  monthly: Array<{ month: string; subscriptions: number; credits: number; costs: number; new_merchants: number; churned: number }>
  assumptions: { sms_per_part: number | null; bd_courier_per_lookup: number | null; payment_fee_percent: number | null }
}
export const businessReport = (from: string, to: string) => platformRpc<BusinessReport>('platform_business_report', { p_from: from, p_to: to })

export const COST_CATEGORIES = {
  INFRASTRUCTURE: 'Hosting & infrastructure', SMS_PROVIDER: 'SMS provider bill', COURIER_API: 'BD Courier API bill', PAYMENT_FEES: 'Payment gateway fees',
  AI: 'AI services', STAFF_TOOLS: 'Staff tools', OTHER: 'Other',
} as const
export type CostCategory = keyof typeof COST_CATEGORIES
export interface CostEntry { id: number; month: string; category: CostCategory; amount: number; currency: string; note: string; corrects: number | null; recorded_by_email: string | null; created_at: string }
export const costEntries = (from?: string, to?: string) =>
  platformRpc<{ entries: CostEntry[]; assumptions: BusinessReport['assumptions']; can_manage: boolean }>('platform_cost_entries_list', { p_from: from ?? null, p_to: to ?? null })
export const addCostEntry = (p: { month: string; category: CostCategory; amount: number; note: string; corrects?: number | null }) => platformRpc<CostEntry>('platform_cost_entry_add', { p })
export const saveCostAssumptions = (p: { bd_courier_per_lookup: number | null; payment_fee_percent: number | null }, reason?: string) =>
  platformRpc('platform_cost_assumptions_save', { p, p_reason: reason ?? null })

export type HealthBand = 'HEALTHY' | 'WATCH' | 'AT_RISK'
export type HealthNeed = 'onboarding' | 'technical' | 'billing' | 'activity'
export interface HealthRow extends MerchantRef {
  status: string; is_demo: boolean; account_manager: string | null; created_at: string; score: number; band: HealthBand
  signals: Array<{ key: string; need: HealthNeed; label: string; detail: string; points: number }>
  needs: HealthNeed[]
  facts: { orders_14d: number; orders_prior_14d: number; errors_7d: number; open_tickets: number; onboarding: { done: number; total: number }
    subscription: { status: string; plan: string; trial_ends_at: string | null; cancel_at_period_end: boolean } | null }
}
export const merchantHealth = (p: { need?: string; band?: string; q?: string; include_demo?: boolean }) =>
  platformRpc<{ summary: Record<string, number>; rows: HealthRow[]; method: string }>('platform_merchant_health', { p })

export interface OverviewBusiness {
  billing: { mrr: number; active: number; trialing: number; past_due: number; paused: number; trials_ending_7d: number; cancelling: number; cancelled_in_range: number
    revenue_in_range: number; subscription_revenue_in_range: number; overdue_invoices: number; failed_payments: number } | null
  credits: { sms_outstanding: number; courier_outstanding: number }
  metered: { sms_units: number; sms_free_units: number; bd_lookups: number; bd_failed: number; bd_refused: number; provider_cost_reported: number; provider_cost_estimated: number | null }
  services: { sms_connected: boolean; bd_courier_connected: boolean }
  support: { open: number; overdue: number; urgent: number }
  growth: Array<{ month: string; new: number; churned: number; active: number }>
}
export const overviewBusiness = (from: string, to: string) => platformRpc<OverviewBusiness>('platform_overview_business', { p_from: from, p_to: to })
