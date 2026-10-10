import { asJson, fromJson } from '@/lib/json'
import { supabase } from '@/lib/supabase'
import type { Enums } from '@/types/database'

export interface CustomerFilters {
  q?: string
  segment?: Enums<'customer_segment'> | ''
  sort?: 'recent' | 'spent' | 'orders' | 'newest'
  page: number
  pageSize: number
}

export async function listCustomers(f: CustomerFilters) {
  let query = supabase.from('customers').select('*', { count: 'exact' }).range((f.page - 1) * f.pageSize, f.page * f.pageSize - 1)
  const sort = f.sort ?? 'recent'
  query = sort === 'spent' ? query.order('total_spent', { ascending: false })
    : sort === 'orders' ? query.order('total_orders', { ascending: false })
    : sort === 'newest' ? query.order('created_at', { ascending: false })
    : query.order('last_order_at', { ascending: false, nullsFirst: false })
  if (f.q) {
    const term = f.q.replace(/[%,()]/g, ' ').trim()
    const digits = term.replace(/\D/g, '')
    query = query.or([`full_name.ilike.%${term}%`, `email.ilike.%${term}%`, digits.length >= 4 ? `phone.ilike.%${digits.slice(-10)}%` : null].filter(Boolean).join(','))
  }
  if (f.segment) query = query.eq('segment', f.segment)
  const { data, error, count } = await query
  if (error) throw error
  return { items: data ?? [], total: count ?? 0 }
}
export type CustomerRow = Awaited<ReturnType<typeof listCustomers>>['items'][number]

export async function getCustomer(id: string) {
  const { data, error } = await supabase.from('customers').select('*, customer_addresses(*)').eq('id', id).maybeSingle()
  if (error) throw error
  return data
}
export type CustomerDetail = NonNullable<Awaited<ReturnType<typeof getCustomer>>>

export interface CustomerSummary {
  payments: Array<{ id: string; order_number: string; kind: string; channel: string; amount: number; created_at: string }>
  fraud_checks: Array<{ id: string; risk_score: number; risk_level: string; decision: string; provider: string; courier_score: number | null; created_at: string; order_id: string | null }>
  totals: { paid: number; refunded: number }
}

export async function customerSummary(id: string): Promise<CustomerSummary> {
  const { data, error } = await supabase.rpc('admin_customer_summary', { p_customer_id: id })
  if (error) throw error
  return fromJson<CustomerSummary>(data)
}

export async function updateCustomer(id: string, changes: Record<string, unknown>) {
  const { error } = await supabase.rpc('admin_update_customer', { p_customer_id: id, p_changes: asJson(changes) })
  if (error) throw error
}

export async function createCustomer(values: Record<string, unknown>) {
  const { data, error } = await supabase.rpc('admin_create_customer', { p: asJson(values) })
  if (error) throw error
  return data
}

export async function listContactMessages() {
  const { data, error } = await supabase.from('contact_messages').select('*').order('created_at', { ascending: false }).limit(100)
  if (error) throw error
  return data ?? []
}

export async function resolveContactMessage(id: string, resolved: boolean) {
  const { error } = await supabase.from('contact_messages').update({ is_resolved: resolved }).eq('id', id)
  if (error) throw error
}

export interface DistrictStat { district: string; orders: number; customers: number; delivered: number; returned: number; revenue: number; order_value: number; success_rate: number | null }
export interface DistrictStats {
  districts: DistrictStat[]
  totals: { orders: number; customers: number; revenue: number; order_value: number; unassigned_customers: number; unassigned_orders: number }
}
export interface UnassignedCustomer { phone: string; name: string | null; address: string | null; district_text: string | null; orders: number; last_order_at: string; suggestion: string | null }

/** Orders, customers and value per district (server-side). */
export async function districtStats(days: number | null): Promise<DistrictStats> {
  const { data, error } = await supabase.rpc('customer_district_stats', { p_days: days ?? undefined })
  if (error) throw error
  return data as unknown as DistrictStats
}
export async function customersNeedingDistrict(limit = 100): Promise<UnassignedCustomer[]> {
  const { data, error } = await supabase.rpc('customers_needing_district', { p_limit: limit })
  if (error) throw error
  return (data ?? []) as unknown as UnassignedCustomer[]
}
export async function assignCustomerDistrict(phone: string, district: string) {
  const { data, error } = await supabase.rpc('assign_customer_district', { p_phone: phone, p_district: district })
  if (error) throw error
  return data as unknown as { orders: number; district: string }
}
export async function autoAssignDistricts() {
  const { data, error } = await supabase.rpc('auto_assign_districts')
  if (error) throw error
  return data as unknown as { customers: number; orders: number; left: number }
}
