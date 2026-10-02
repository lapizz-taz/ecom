import { asJson } from '@/lib/json'
import { supabase } from '@/lib/supabase'
import type { Enums, TablesInsert } from '@/types/database'

export async function listSuppliers() {
  const { data, error } = await supabase.from('suppliers').select('*').order('name')
  if (error) throw error
  return data ?? []
}

export async function saveSupplier(values: TablesInsert<'suppliers'> & { id?: string }) {
  const { id, ...rest } = values
  const { error } = id ? await supabase.from('suppliers').update(rest).eq('id', id) : await supabase.from('suppliers').insert(rest)
  if (error) throw error
}

export async function listPurchaseOrders(status?: string) {
  let query = supabase
    .from('purchase_orders')
    .select('*, suppliers(name), purchase_order_items(quantity, received_quantity)')
    .order('created_at', { ascending: false })
    .limit(200)
  if (status) query = query.eq('status', status as Enums<'purchase_status'>)
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}
export type PurchaseOrderRow = Awaited<ReturnType<typeof listPurchaseOrders>>[number]

export async function getPurchaseOrder(id: string) {
  const { data, error } = await supabase
    .from('purchase_orders')
    .select('*, suppliers(*), purchase_order_items(*, products(name), product_variants(sku, title)), finance_transactions(id, txn_number, amount, txn_date, payment_channel, reference)')
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  return data
}
export type PurchaseOrderDetail = NonNullable<Awaited<ReturnType<typeof getPurchaseOrder>>>

export interface PurchaseOrderPayload {
  id?: string
  supplier_id: string
  status?: Enums<'purchase_status'>
  order_date?: string
  expected_date?: string | null
  shipping_cost?: number
  notes?: string | null
  items: Array<{ variant_id: string; quantity: number; unit_cost: number }>
}

export async function savePurchaseOrder(payload: PurchaseOrderPayload) {
  const { data, error } = await supabase.rpc('admin_save_purchase_order', { p: asJson(payload) })
  if (error) throw error
  return data
}

export async function setPurchaseOrderStatus(id: string, status: Enums<'purchase_status'>) {
  const { error } = await supabase.rpc('purchase_order_set_status', { p_id: id, p_status: status })
  if (error) throw error
}

export async function receivePurchaseOrder(id: string, items: Array<{ item_id: string; quantity: number }> | null, note?: string) {
  const { error } = await supabase.rpc('receive_purchase_order', { p_id: id, p_items: items ? asJson(items) : undefined, p_note: note || undefined })
  if (error) throw error
}

export async function recordPurchasePayment(id: string, amount: number, channel: Enums<'payment_channel'>, date?: string, reference?: string, note?: string) {
  const { error } = await supabase.rpc('record_purchase_payment', {
    p_id: id, p_amount: amount, p_channel: channel, p_date: date || undefined, p_reference: reference || undefined, p_note: note || undefined,
  })
  if (error) throw error
}
