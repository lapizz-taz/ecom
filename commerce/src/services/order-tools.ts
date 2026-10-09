import { fromJson } from '@/lib/json'
import { supabase } from '@/lib/supabase'
import type { Enums } from '@/types/database'

// --- Block list ------------------------------------------------------------------
export type BlockKind = 'PHONE' | 'IP' | 'ADDRESS'
export type BlockState = 'PERMANENT' | 'TEMPORARY' | 'EXPIRED' | 'LIFTED'
export interface BlockRow {
  id: string; kind: BlockKind; value: string; reason: string; expires_at: string | null; is_active: boolean; created_at: string
  lifted_at: string | null; lift_reason: string | null; source_order_id: string | null; source_order_number: string | null
  created_by_name: string | null; lifted_by_name: string | null; state: BlockState
  orders: number; delivered: number; returned: number; cancelled: number; customer_id: string | null; customer_name: string | null
}

export async function listBlocks(f: { status: string; kind?: BlockKind | ''; q?: string; page: number; pageSize: number }) {
  const { data, error } = await supabase.rpc('admin_block_list', {
    p_status: f.status, p_kind: f.kind || undefined, p_q: f.q || undefined, p_limit: f.pageSize, p_offset: (f.page - 1) * f.pageSize,
  })
  if (error) throw error
  return fromJson<{ total: number; items: BlockRow[] }>(data)
}

export async function addBlock(input: { kind: BlockKind; value?: string; reason: string; expiresAt?: string | null; orderId?: string | null }) {
  const { error } = await supabase.rpc('admin_block_add', {
    p_kind: input.kind, p_value: input.value ?? '', p_reason: input.reason,
    p_expires_at: input.expiresAt || undefined, p_order_id: input.orderId || undefined,
  })
  if (error) throw error
}

export async function liftBlock(id: string, reason?: string) {
  const { error } = await supabase.rpc('admin_block_lift', { p_id: id, p_reason: reason || undefined })
  if (error) throw error
}

// --- Auto Pick / assignment --------------------------------------------------------
export interface AutoPickSettings { enabled: boolean; mode: 'round_robin' | 'least_open'; agent_ids: string[]; max_open: number }
export interface AutoPickAgent { id: string; name: string; role: string; open: number; assigned_today: number; approved_today: number; callbacks_due: number }
export interface AutoPickOverview { settings: AutoPickSettings; unassigned: number; agents: AutoPickAgent[] }

export async function autoPickOverview() {
  const { data, error } = await supabase.rpc('auto_pick_overview')
  if (error) throw error
  return fromJson<AutoPickOverview>(data)
}

export async function saveAutoPick(settings: AutoPickSettings) {
  const { error } = await supabase.rpc('auto_pick_update', { p: settings as never })
  if (error) throw error
}

export async function runAutoPick() {
  const { data, error } = await supabase.rpc('auto_pick_run')
  if (error) throw error
  return data as number
}

export async function assignOrders(orderIds: string[], agentId: string | null) {
  const { data, error } = await supabase.rpc('assign_orders', { p_order_ids: orderIds, p_agent: agentId as string })
  if (error) throw error
  return data as number
}

// --- Call queue ------------------------------------------------------------------------
export type CallScope = 'mine' | 'unassigned' | 'all'
export async function nextCall(scope: CallScope, skip: string[]) {
  const { data, error } = await supabase.rpc('call_queue_next', { p_scope: scope, p_skip: skip })
  if (error) throw error
  return fromJson<{ order_id: string | null; counts: Record<CallScope, number> }>(data)
}

// --- Super Edit -----------------------------------------------------------------------
export interface OverrideChanges {
  status?: Enums<'order_status'>
  shipment?: {
    courier_id?: string; tracking_number?: string; consignment_id?: string; status?: Enums<'shipment_status'>
    shipping_cost?: number; cod_amount?: number; return_charge?: number
  }
}

export async function overrideOrder(orderId: string, changes: OverrideChanges, reason: string, force: boolean, notify: boolean) {
  const { data, error } = await supabase.rpc('admin_override_order', {
    p_order_id: orderId, p_changes: changes as never, p_reason: reason, p_force: force, p_notify: notify,
  })
  if (error) throw error
  return fromJson<{ mode: 'steps' | 'forced' | null; path: string[] | null; messages_skipped: number; order: { status: Enums<'order_status'> } }>(data)
}

export interface OverrideEntry {
  id: string; created_at: string; order_id: string; order_number: string | null; reason: string | null; mode: string | null
  old_values: Record<string, unknown> | null; new_values: Record<string, unknown> | null; actor_name: string | null; actor_email: string | null
}
export async function overrideHistory() {
  const { data, error } = await supabase.rpc('admin_override_history', { p_limit: 30 })
  if (error) throw error
  return fromJson<OverrideEntry[]>(data)
}

// --- Orders dashboard -------------------------------------------------------------------
export interface OrdersDashboard {
  daily: Array<{ day: string; approved: number; shipped: number; delivered: number; returned: number; cancelled: number }>
  totals: { approved: number; shipped: number; delivered: number; returned: number; cancelled: number; approved_value: number; delivered_value: number }
  by_courier: Array<{ courier: string; courier_id: string | null; total: number; pending: number; rts: number; shipped: number; pending_return: number; pending_cancel: number; cod_open: number }>
  aging: { pending_over_2d: number; rts_over_1d: number; shipped_over_7d: number; return_over_7d: number; unbooked: number }
  by_agent: Array<{ name: string; approved: number; value: number }>
}
export async function ordersDashboard(from: string, to: string) {
  const { data, error } = await supabase.rpc('orders_dashboard', { p_from: from, p_to: to })
  if (error) throw error
  return fromJson<OrdersDashboard>(data)
}
