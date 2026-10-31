import { asJson, fromJson } from '@/lib/json'
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

// --- Auto Order Dashboard ------------------------------------------------------------
export type CallQueue = 'processing' | 'incomplete' | 'good_no_response' | 'no_response' | 'advance_payment' | 'on_hold'
export interface CallClaim { kind: 'ORDER' | 'LEAD'; id: string; queue: CallQueue }
export interface AutoOrderDashboard {
  queues: Record<CallQueue, number>
  /** Held back for now: called under 30 minutes ago, or a call-back still ahead. */
  waiting?: Partial<Record<CallQueue, { count: number; next_at: string | null }>>
  report: { taken: number; approved: number; shipped: number; delivered: number; returned: number }
  claim: (CallClaim & { expires_at: string }) | null
}

export async function autoOrderDashboard(): Promise<AutoOrderDashboard> {
  const { data, error } = await supabase.rpc('auto_order_dashboard')
  if (error) throw error
  return fromJson<AutoOrderDashboard>(data)
}

/** Claims the next customer in a queue for me (nobody else gets them while I have them open). */
export async function openNextInQueue(queue: CallQueue, skip: string[] = []): Promise<CallClaim | null> {
  const { data, error } = await supabase.rpc('auto_order_open_next', { p_queue: queue, p_skip: skip })
  if (error) throw error
  return fromJson<CallClaim | null>(data)
}

export async function releaseCallClaim() {
  const { error } = await supabase.rpc('auto_order_release')
  if (error) throw error
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

// --- Orders dashboard list: every order with its status now (supabase/migrations/20261211000100_orders_board.sql) ---
/** What the Orders Dashboard's filter panel sends; every key is optional. */
export interface BoardFilters {
  /** The date the date range and the time range look at. */
  date_by?: 'approved' | 'order' | 'shipped' | 'delivered'
  date_from?: string
  date_to?: string
  /** Minutes after midnight, in the store's time zone. */
  time_from?: number
  time_to?: number
  /** Product name, variant or SKU. */
  product?: string
  source?: string
  /** A courier's id, or "none" for orders not booked with one. */
  courier_id?: string
  taken_by?: string
  courier_payment?: CourierPayment
  /** Order number, web reference, store number, tracking or consignment number, or courier statement number. */
  invoice?: string
  /** Approved stages (PENDING, RTS, …), WEB:<call status>, or WEB for every web order. */
  statuses?: string[]
  tags?: string[]
  district?: string
  sort?: 'newest' | 'oldest' | 'amount'
}
export type CourierPayment = 'paid' | 'unpaid' | 'none'
export interface BoardOrder {
  id: string
  order_number: string
  web_number: string | null
  store_number: string | null
  channel: string | null
  /** An approved stage (PENDING, RTS, SHIPPED, …) or WEB:<call status> for a web order. */
  status_key: string
  status: Enums<'order_status'>
  review_status: string | null
  /** The date the list is filtered by (null when the order has none yet). */
  date: string | null
  created_at: string
  confirmed_at: string | null
  shipped_at: string | null
  delivered_at: string | null
  returned_at: string | null
  cancelled_at: string | null
  customer_name: string
  customer_phone: string
  district: string | null
  total_amount: number
  amount_paid: number
  cod_amount: number
  item_count: number
  items: string | null
  courier: { name: string; number: string | null; status: Enums<'shipment_status'>; tracking_url: string | null } | null
  courier_payment: CourierPayment
  courier_paid: { amount: number; at: string | null; statement: string | null }
  taken_by: string | null
  source: string | null
  tags: string[]
  contact_attempts: number
  follow_up_at: string | null
}
export interface OrdersBoard {
  total: number
  value: number
  /** Orders in each status for the same filters, the status filter left out. */
  counts: Array<{ key: string; n: number; value: number }>
  items: BoardOrder[]
}
export interface OrdersBoardOptions {
  couriers: Array<{ id: string; name: string; active: boolean }>
  staff: Array<{ id: string; name: string; active: boolean }>
  sources: string[]
  districts: string[]
  tags: Array<{ name: string; color: string }>
  call_statuses: Array<{ code: string; label: string; color: string }>
}
export async function ordersBoard(filters: BoardFilters, limit = 50, offset = 0) {
  const clean = Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0)))
  const { data, error } = await supabase.rpc('orders_board', { p_filters: asJson(clean), p_limit: limit, p_offset: offset })
  if (error) throw error
  return fromJson<OrdersBoard>(data)
}
export async function ordersBoardOptions() {
  const { data, error } = await supabase.rpc('orders_board_options')
  if (error) throw error
  return fromJson<OrdersBoardOptions>(data)
}
