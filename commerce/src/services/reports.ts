import { asJson, fromJson } from '@/lib/json'
import { supabase } from '@/lib/supabase'
import type { DashboardOverview, TimeseriesPoint } from '@/types/domain'

export async function dashboardOverview(from: string, to: string): Promise<DashboardOverview> {
  const { data, error } = await supabase.rpc('dashboard_overview', { p_from: from, p_to: to })
  if (error) throw error
  return fromJson<DashboardOverview>(data)
}

export async function timeseries(from: string, to: string, granularity: string, filters: Record<string, string> = {}): Promise<TimeseriesPoint[]> {
  const { data, error } = await supabase.rpc('report_timeseries', { p_from: from, p_to: to, p_granularity: granularity, p_filters: asJson(filters) })
  if (error) throw error
  return fromJson<TimeseriesPoint[]>(data) ?? []
}

async function call<T>(fn: Parameters<typeof supabase.rpc>[0], args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args as never)
  if (error) throw error
  return fromJson<T>(data)
}

export interface ProductPerformanceRow {
  product_id: string
  product_name: string
  category_name: string | null
  ordered_qty: number
  sold_qty: number
  returned_qty: number
  revenue: number
  cogs: number | null
  gross_profit: number | null
  margin_pct: number | null
}

export const reports = {
  productPerformance: (from: string, to: string, filters: Record<string, string> = {}) =>
    call<ProductPerformanceRow[]>('report_product_performance', { p_from: from, p_to: to, p_filters: filters, p_limit: 500 }),
  customers: (from: string, to: string) => call<{
    segments: Record<string, number>
    new_customers: number
    repeat_customers: number
    top_customers: Array<{ id: string; full_name: string; phone: string; segment: string; district: string | null; orders: number; delivered_value: number; cancelled: number; returned_or_failed: number }>
    by_district: Array<{ district: string; orders: number; customers: number; delivered_value: number }>
  }>('report_customers', { p_from: from, p_to: to, p_limit: 100 }),
  couriers: (from: string, to: string) => call<Array<{
    courier_id: string; courier_name: string; provider: string; shipments: number; delivered: number; failed_or_returned: number; in_transit: number
    success_rate: number | null; avg_shipping_cost: number; total_shipping_cost: number; total_return_charges: number; cod_collected: number; cod_pending: number; avg_delivery_hours: number | null
  }>>('report_couriers', { p_from: from, p_to: to }),
  cancellationsReturns: (from: string, to: string) => call<{
    cancel_reasons: Array<{ reason: string; orders: number; value: number }>
    returned_products: Array<{ product_name: string; restocked: number; damaged: number }>
    by_district: Array<{ district: string; cancelled: number; returned_or_failed: number; orders: number }>
  }>('report_cancellations_returns', { p_from: from, p_to: to }),
  fraud: (from: string, to: string) => call<{
    checks: number; provider_errors: number; decisions: Record<string, number>; risk_levels: Record<string, number>
    outcomes_by_risk: Array<{ risk_level: string; orders: number; delivered: number; cancelled_or_rejected: number; failed: number }>
    reviews: Record<string, number>; rejected_value: number
  }>('report_fraud', { p_from: from, p_to: to }),
  advancePayments: (from: string, to: string) => call<{
    orders_requiring_advance: number; advance_required_total: number; orders_paid: number; advance_collected: number
    expired_unpaid: number; awaiting_payment: number; payment_rate: number | null; delivered_after_advance: number; by_channel: Record<string, number>
  }>('report_advance_payments', { p_from: from, p_to: to }),
  inventoryValuation: () => call<{
    totals: { units_on_hand: number; units_reserved: number; units_damaged: number; value_at_cost: number; value_at_retail: number; damaged_value: number; low_stock_variants: number; out_of_stock_variants: number }
    by_category: Array<{ category: string; units: number; value_at_cost: number; value_at_retail: number }>
    items: Array<{ product_name: string; variant_title: string; sku: string; on_hand: number; reserved: number; available: number; damaged: number; unit_cost: number; unit_price: number; value_at_cost: number; stock_status: string }>
  }>('report_inventory_valuation', {}),
  production: (from: string, to: string) => call<{
    created: number; completed: number; in_progress: number; cancelled: number; qc_rejections: number; overdue: number
    avg_cycle_hours: number | null; by_status: Record<string, number>; by_assignee: Array<{ assignee: string; orders: number; completed: number }>
  }>('report_production', { p_from: from, p_to: to }),
}
