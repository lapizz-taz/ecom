import { supabase } from '@/lib/supabase'
import type { Enums } from '@/types/database'

export interface StockFilters {
  q?: string
  status?: 'LOW_STOCK' | 'OUT_OF_STOCK' | 'IN_STOCK' | ''
  page: number
  pageSize: number
}

export async function listStock(f: StockFilters) {
  let query = supabase
    .from('inventory_overview')
    .select('*', { count: 'exact' })
    .eq('variant_active', true)
    .eq('track_inventory', true)
    .order('available', { ascending: true })
    .order('product_name')
    .range((f.page - 1) * f.pageSize, f.page * f.pageSize - 1)
  if (f.q) query = query.or(`product_name.ilike.%${f.q.replace(/[%,()]/g, ' ')}%,sku.ilike.%${f.q.replace(/[%,()]/g, ' ')}%`)
  if (f.status) query = query.eq('stock_status', f.status)
  const { data, error, count } = await query
  if (error) throw error
  return { items: data ?? [], total: count ?? 0 }
}
export type StockRow = Awaited<ReturnType<typeof listStock>>['items'][number]

export interface MovementFilters {
  type?: Enums<'inventory_movement_type'> | ''
  types?: Enums<'inventory_movement_type'>[]
  variantId?: string
  from?: string
  to?: string
  page: number
  pageSize: number
}

export async function listMovements(f: MovementFilters) {
  let query = supabase
    .from('inventory_movements')
    .select('*, products(name), product_variants(sku, title)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range((f.page - 1) * f.pageSize, f.page * f.pageSize - 1)
  if (f.type) query = query.eq('movement_type', f.type)
  if (f.types?.length) query = query.in('movement_type', f.types)
  if (f.variantId) query = query.eq('variant_id', f.variantId)
  if (f.from) query = query.gte('created_at', new Date(`${f.from}T00:00:00`).toISOString())
  if (f.to) query = query.lte('created_at', new Date(`${f.to}T23:59:59.999`).toISOString())
  const { data, error, count } = await query
  if (error) throw error
  return { items: data ?? [], total: count ?? 0 }
}
export type MovementRow = Awaited<ReturnType<typeof listMovements>>['items'][number]

export async function adjustStock(input: {
  variantId: string
  type: Enums<'inventory_movement_type'>
  quantity: number
  note: string
  mode?: 'ADD' | 'REMOVE' | 'SET'
  unitCost?: number | null
}) {
  const { data, error } = await supabase.rpc('adjust_stock', {
    p_variant_id: input.variantId, p_type: input.type, p_quantity: input.quantity, p_note: input.note,
    p_mode: input.mode ?? 'ADD', p_unit_cost: input.unitCost ?? undefined,
  })
  if (error) throw error
  return data
}
