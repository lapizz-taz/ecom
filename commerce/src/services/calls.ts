// Call tracking: which staff member tapped Call, set a call status or approved, and when.
// Recording a tap is open to anyone who can see the order; reading needs calls.view (Owner and Admins).
import { fromJson } from '@/lib/json'
import { supabase } from '@/lib/supabase'

export type CallEventKind = 'TAP' | 'STATUS' | 'APPROVED'

export interface CallEvent {
  kind: CallEventKind
  status: string | null
  status_label: string | null
  source: string | null
  at: string
  actor_id: string | null
  actor_name: string | null
}

export interface OrderCallHistory {
  taps: number
  statuses: number
  not_reached: number
  events: CallEvent[]
}

export interface StaffCalls {
  user_id: string
  name: string | null
  role: string | null
  taps: number
  orders_called: number
  statuses: number
  not_reached: number
  approved: number
  closed: number
  without_call: number
}

export interface CallsReport {
  from: string
  to: string
  staff: StaffCalls[]
  automatic_approvals: number
  without_call: Array<{ order_id: string; order_number: string; customer_name: string; outcome: string; actor_name: string | null; at: string }>
  never_called: { count: number; items: Array<{ order_id: string; order_number: string; customer_name: string; created_at: string; status: string }> }
}

/**
 * Notes that Call was tapped for an order. Never in the way: it does not wait, and a failure
 * (no connection, a read-only account) is ignored, so the phone opens either way.
 */
export function recordCallTap(orderId: string | null | undefined, source: string): void {
  if (!orderId) return
  void Promise.resolve(supabase.rpc('order_call_tap', { p_order: orderId, p_source: source })).catch(() => undefined)
}

export async function orderCallHistory(orderId: string): Promise<OrderCallHistory> {
  const { data, error } = await supabase.rpc('order_call_history', { p_order: orderId })
  if (error) throw error
  return fromJson<OrderCallHistory>(data)
}

export async function callsReport(range: { from: string; to: string }): Promise<CallsReport> {
  const { data, error } = await supabase.rpc('calls_report', { p: range })
  if (error) throw error
  return fromJson<CallsReport>(data)
}
