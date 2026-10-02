import { supabase } from '@/lib/supabase'
import type { Enums } from '@/types/database'

export async function listProduction(statuses: Enums<'production_status'>[]) {
  let query = supabase
    .from('production_orders')
    .select('*, orders(id, order_number, customer_name, status, created_at), production_items(*)')
    .order('priority', { ascending: false })
    .order('deadline', { ascending: true, nullsFirst: false })
    .limit(300)
  if (statuses.length) query = query.in('status', statuses)
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}
export type ProductionRow = Awaited<ReturnType<typeof listProduction>>[number]

export async function getProduction(id: string) {
  const { data, error } = await supabase
    .from('production_orders')
    .select('*, orders(id, order_number, customer_name, customer_phone, status, customer_note, shipping_district), production_items(*), production_status_history(*)')
    .eq('id', id)
    .order('created_at', { referencedTable: 'production_status_history' })
    .maybeSingle()
  if (error) throw error
  return data
}
export type ProductionDetail = NonNullable<Awaited<ReturnType<typeof getProduction>>>

export type ProductionAction = 'START' | 'PAUSE' | 'RESUME' | 'SEND_TO_QC' | 'APPROVE' | 'REJECT' | 'MOVE_TO_PACKING' | 'MARK_READY'

export async function productionAction(id: string, action: ProductionAction, note?: string) {
  const { error } = await supabase.rpc('production_action', { p_production_id: id, p_action: action, p_note: note || undefined })
  if (error) throw error
}

export async function updateProduction(id: string, values: { assigned_to: string | null; priority: Enums<'production_priority'>; deadline: string | null; notes: string | null }) {
  const { error } = await supabase.rpc('production_update', {
    p_production_id: id, p_assigned_to: values.assigned_to as string, p_priority: values.priority,
    p_deadline: values.deadline as string, p_notes: values.notes as string,
  })
  if (error) throw error
}

export async function createProductionOrder(orderId: string) {
  const { error } = await supabase.rpc('admin_create_production_order', { p_order_id: orderId })
  if (error) throw error
}

/** Which actions make sense for each production status. */
export const PRODUCTION_ACTIONS: Record<Enums<'production_status'>, Array<{ action: ProductionAction; label: string; needsNote?: boolean; variant?: 'default' | 'outline' | 'destructive' }>> = {
  WAITING: [{ action: 'START', label: 'Start production' }, { action: 'MOVE_TO_PACKING', label: 'Skip to packing', variant: 'outline' }],
  IN_PRODUCTION: [{ action: 'SEND_TO_QC', label: 'Send to quality check' }, { action: 'PAUSE', label: 'Pause', variant: 'outline' }, { action: 'MOVE_TO_PACKING', label: 'Move to packing', variant: 'outline' }],
  PAUSED: [{ action: 'RESUME', label: 'Resume' }],
  QUALITY_CHECK: [{ action: 'APPROVE', label: 'Approve' }, { action: 'REJECT', label: 'Reject → production', needsNote: true, variant: 'destructive' }],
  PACKING: [{ action: 'MARK_READY', label: 'Mark ready to ship' }],
  READY: [],
  CANCELLED: [],
}
