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
  const items = data ?? []
  // Which of these rows already have a reversal entry (reversals are separate, immutable rows).
  const reversed = new Set<string>()
  if (items.length) {
    const { data: rev, error: revError } = await supabase.from('finance_transactions').select('reverses_id').in('reverses_id', items.map((t) => t.id))
    if (revError) throw revError
    for (const r of rev ?? []) if (r.reverses_id) reversed.add(r.reverses_id)
  }
  return { items: items.map((t) => ({ ...t, reversed: reversed.has(t.id) })), total: count ?? 0 }
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

// ---------------------------------------------------------------- income & expense ledger
export type LedgerType = 'EXPENSE' | 'INCOME'
export interface LedgerCategory {
  id: string; code: string; name: string; color: string; manual: boolean; subcategories: string[]; total: number; count: number
}
export interface LedgerDay { date: string; total: number; cells: Record<string, { amount: number; count: number; usd: number | null }> }
export interface Ledger { total: number; count: number; usd_total: number | null; categories: LedgerCategory[]; days: LedgerDay[] }

export async function financeLedger(type: LedgerType, from: string, to: string): Promise<Ledger> {
  const { data, error } = await supabase.rpc('finance_ledger', { p_type: type, p_from: from, p_to: to })
  if (error) throw error
  return fromJson<Ledger>(data)
}

export interface LedgerEntry {
  id: string; txn_number: string; type: LedgerType; date: string; amount: number
  foreign_amount: number | null; foreign_currency: string | null; exchange_rate: number | null
  category: { id: string; name: string; code: string; color: string }
  sub_category: string | null; account: { id: string; name: string } | null
  notes: string | null; reference: string | null; source: string; order_number: string | null
  reversed: boolean; is_reversal: boolean; editable: boolean; created_by: string | null; created_at: string
}
export interface EntryFilters {
  type?: LedgerType; category_id?: string; sub_category?: string; account_id?: string; q?: string
  from?: string; to?: string; show_reversed?: boolean; limit?: number; offset?: number
}

export async function financeEntries(f: EntryFilters): Promise<{ total: number; sum: number; items: LedgerEntry[] }> {
  const clean = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined && v !== ''))
  const { data, error } = await supabase.rpc('finance_entries', { p: asJson(clean) })
  if (error) throw error
  return fromJson(data)
}

export interface EntryInput {
  type: LedgerType; category_id: string; amount?: number; txn_date: string; sub_category?: string | null
  account_id?: string | null; notes?: string | null; reference?: string | null
  foreign_amount?: number | null; foreign_currency?: string | null; exchange_rate?: number | null
}

export async function createEntry(input: EntryInput) {
  const { data, error } = await supabase.rpc('create_finance_transaction', { p: asJson(input) })
  if (error) throw error
  return data
}

export async function updateEntry(id: string, input: EntryInput, reason?: string) {
  const { data, error } = await supabase.rpc('finance_entry_update', { p_id: id, p: asJson(input), p_reason: reason })
  if (error) throw error
  return data
}

export interface LedgerOverview {
  income: number; expense: number; income_count: number; expense_count: number
  series: Array<{ date: string; income: number; expense: number }>
  by_category: Array<{ type: LedgerType; name: string; color: string; total: number }>
  by_account: Array<{ name: string; income: number | null; expense: number | null }>
}

export async function financeLedgerOverview(from: string, to: string): Promise<LedgerOverview> {
  const { data, error } = await supabase.rpc('finance_ledger_overview', { p_from: from, p_to: to })
  if (error) throw error
  return fromJson<LedgerOverview>(data)
}

export async function updateCategoryLook(id: string, patch: { name?: string; color?: string; subcategories?: string[]; is_active?: boolean }) {
  const { error } = await supabase.from('finance_categories').update(patch).eq('id', id)
  if (error) throw error
}
