import { fromJson } from '@/lib/json'
import { supabase } from '@/lib/supabase'
import type { Enums } from '@/types/database'

export interface GlobalSearchResult {
  orders?: Array<{ id: string; order_number: string; customer_name: string; customer_phone: string; status: Enums<'order_status'>; total_amount: number; created_at: string; approved: boolean }>
  parcels?: Array<{ id: string; order_id: string; order_number: string; tracking_number: string | null; consignment_id: string | null; status: Enums<'shipment_status'>; courier: string }>
  customers?: Array<{ id: string; full_name: string; phone: string; status: string; total_orders: number }>
  products?: Array<{ id: string; name: string; status: string; sku: string | null }>
  invoices?: Array<{ id: string; invoice_number: string; invoice_date: string | null; courier: string; status: Enums<'courier_invoice_status'> }>
}

/** Orders, parcels, customers, products and courier invoices matching a term (only the groups the user may see). */
export async function globalSearch(q: string): Promise<GlobalSearchResult> {
  const { data, error } = await supabase.rpc('admin_global_search', { p_q: q, p_limit: 6 })
  if (error) throw error
  return fromJson<GlobalSearchResult>(data) ?? {}
}

/** Support → Report issue: saved to the System log for owners and admins. */
export async function reportIssue(message: string, context: { page: string; browser: string; screen: string }) {
  const { error } = await supabase.rpc('report_issue', { p_message: message, p_context: context })
  if (error) throw error
}
