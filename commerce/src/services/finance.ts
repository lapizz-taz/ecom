import { asJson, fromJson } from '@/lib/json'
import { supabase } from '@/lib/supabase'
import type { Enums, TablesInsert } from '@/types/database'
import type { CashFlow, FinanceOverview, ProfitLoss } from '@/types/domain'

export async function financeOverview(from: string, to: string): Promise<FinanceOverview> {
  const { data, error } = await supabase.rpc('finance_overview', { p_from: from, p_to: to })
  if (error) throw error
  return fromJson<FinanceOverview>(data)
}

export async function profitLoss(from: string, to: string): Promise<ProfitLoss> {
  const { data, error } = await supabase.rpc('report_profit_loss', { p_from: from, p_to: to })
  if (error) throw error
  return fromJson<ProfitLoss>(data)
}

export async function cashFlow(from: string, to: string, granularity = 'day'): Promise<CashFlow> {
  const { data, error } = await supabase.rpc('report_cash_flow', { p_from: from, p_to: to, p_granularity: granularity })
  if (error) throw error
  return fromJson<CashFlow>(data)
}

export async function expensesByCategory(from: string, to: string) {
  const { data, error } = await supabase.rpc('report_expenses_by_category', { p_from: from, p_to: to })
  if (error) throw error
  return fromJson<Array<{ code: string; name: string; pnl_group: string; amount: number }>>(data) ?? []
}

export async function listCategories(type?: Enums<'finance_type'>) {
  let query = supabase.from('finance_categories').select('*').order('type').order('sort_order')
  if (type) query = query.eq('type', type)
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}
export type FinanceCategory = Awaited<ReturnType<typeof listCategories>>[number]

export async function saveCategory(values: TablesInsert<'finance_categories'> & { id?: string }) {
  const { id, ...rest } = values
  const { error } = id ? await supabase.from('finance_categories').update({ name: rest.name, is_active: rest.is_active, description: rest.description }).eq('id', id)
    : await supabase.from('finance_categories').insert(rest)
  if (error) throw error
}

export interface TransactionFilters {
  type?: Enums<'finance_type'> | ''
  categoryId?: string
  from?: string
  to?: string
  q?: string
  page: number
  pageSize: number
}

export async function listTransactions(f: TransactionFilters) {
  let query = supabase
    .from('finance_transactions')
    .select('*, finance_categories(code, name, pnl_group), orders(order_number), suppliers(name)', { count: 'exact' })
    .order('txn_date', { ascending: false })
    .order('created_at', { ascending: false })
    .range((f.page - 1) * f.pageSize, f.page * f.pageSize - 1)
  if (f.type) query = query.eq('type', f.type)
  if (f.categoryId) query = query.eq('category_id', f.categoryId)
  if (f.from) query = query.gte('txn_date', f.from)
  if (f.to) query = query.lte('txn_date', f.to)
  if (f.q) {
    const term = f.q.replace(/[%,()]/g, ' ')
    query = query.or(`txn_number.ilike.%${term}%,reference.ilike.%${term}%,notes.ilike.%${term}%`)
  }
  const { data, error, count } = await query
  if (error) throw error
  return { items: data ?? [], total: count ?? 0 }
}
export type TransactionRow = Awaited<ReturnType<typeof listTransactions>>['items'][number]

export async function createTransaction(values: {
  type: Enums<'finance_type'>
  category_id: string
  amount: number
  txn_date: string
  payment_channel?: Enums<'payment_channel'> | null
  reference?: string | null
  notes?: string | null
  supplier_id?: string | null
  is_cash?: boolean
}) {
  const { data, error } = await supabase.rpc('create_finance_transaction', { p: asJson(values) })
  if (error) throw error
  return data
}

export async function reverseTransaction(id: string, reason: string) {
  const { error } = await supabase.rpc('reverse_finance_transaction', { p_id: id, p_reason: reason })
  if (error) throw error
}

export async function listRefunds(page: number, pageSize: number) {
  const { data, error, count } = await supabase
    .from('order_payments')
    .select('*, orders(id, order_number, customer_name, status)', { count: 'exact' })
    .eq('kind', 'REFUND')
    .order('created_at', { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1)
  if (error) throw error
  return { items: data ?? [], total: count ?? 0 }
}

export async function ordersAwaitingAdvanceResolution() {
  const { data, error } = await supabase
    .from('orders')
    .select('id, order_number, customer_name, status, amount_paid, cancelled_at, returned_at')
    .in('status', ['CANCELLED', 'REJECTED_FRAUD', 'RETURNED'])
    .is('delivered_at', null)
    .is('advance_resolution', null)
    .gt('amount_paid', 0)
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) throw error
  return data ?? []
}
