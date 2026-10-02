import { invokeFunction } from '@/lib/functions'
import { asJson, fromJson } from '@/lib/json'
import { supabase } from '@/lib/supabase'
import type { Enums } from '@/types/database'
import type {
  CheckoutLead, FraudQueueItem, FulfillmentSummary, OrderListItem, OrderStatus, Paged, QueueCounts, Quote, ReviewStatus, ScanAction, ScanResult,
} from '@/types/domain'

export interface OrderFilters {
  q?: string
  statuses?: OrderStatus[]
  payment_status?: string
  payment_method?: string
  fraud_status?: string
  risk_level?: string
  source?: string
  courier_id?: string
  district?: string
  customer_id?: string
  date_from?: string
  date_to?: string
  has_due?: boolean
  duplicates?: boolean
  label?: 'printed' | 'not_printed'
  queue?: 'web' | 'approved'
  review_status?: string
  stage?: string
  follow_up_due?: boolean
}

export async function searchOrders(filters: OrderFilters, sort = 'created_at', direction: 'asc' | 'desc' = 'desc', limit = 25, offset = 0): Promise<Paged<OrderListItem>> {
  const clean = Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0)))
  const { data, error } = await supabase.rpc('admin_search_orders', { p_filters: asJson(clean), p_sort: sort, p_direction: direction, p_limit: limit, p_offset: offset })
  if (error) throw error
  return fromJson<Paged<OrderListItem>>(data)
}

/** Fetches up to `max` matching orders page by page (for CSV export). */
export async function exportOrders(filters: OrderFilters, max = 5000): Promise<OrderListItem[]> {
  const rows: OrderListItem[] = []
  for (let offset = 0; offset < max; offset += 200) {
    const page = await searchOrders(filters, 'created_at', 'desc', 200, offset)
    rows.push(...page.items)
    if (rows.length >= page.total || page.items.length === 0) break
  }
  return rows
}

export async function statusCounts(): Promise<Record<string, number>> {
  const { data, error } = await supabase.rpc('admin_order_status_counts')
  if (error) throw error
  return fromJson<Record<string, number>>(data) ?? {}
}

export async function getOrder(id: string) {
  const { data, error } = await supabase
    .from('orders')
    .select(`*,
      order_items(*),
      order_notes(*),
      order_status_history(*),
      order_payments(*),
      payments(*),
      shipments(*, couriers(id, name, provider, api_enabled, tracking_url_template), shipment_events(*)),
      production_orders(*, production_items(*)),
      fraud_check:fraud_checks!orders_fraud_check_fk(*),
      fraud_reviews(*),
      customer:customers(id, full_name, phone, email, segment, status, risk_level, total_orders, delivered_orders, cancelled_orders, returned_orders, failed_deliveries, total_spent),
      delivery_zone:delivery_zones(name, charge, return_charge),
      attribution:order_attributions(*)`)
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  return data
}
export type OrderDetail = NonNullable<Awaited<ReturnType<typeof getOrder>>>

export async function transitionOrder(id: string, to: OrderStatus, note?: string) {
  const { data, error } = await supabase.rpc('transition_order_status', { p_order_id: id, p_to: to, p_note: note || undefined })
  if (error) throw error
  return data
}

export async function bulkTransition(ids: string[], to: OrderStatus, note?: string) {
  const { data, error } = await supabase.rpc('bulk_transition_orders', { p_order_ids: ids, p_to: to, p_note: note || undefined })
  if (error) throw error
  return fromJson<{ updated: number; failed: Array<{ order_number: string; error: string }> }>(data)
}

export async function updateOrder(id: string, changes: Record<string, unknown>) {
  const { data, error } = await supabase.rpc('admin_update_order', { p_order_id: id, p_changes: asJson(changes) })
  if (error) throw error
  return data
}

export async function setOrderItems(id: string, items: Array<{ variant_id: string; quantity: number; unit_price?: number }>) {
  const { data, error } = await supabase.rpc('admin_set_order_items', { p_order_id: id, p_items: asJson(items) })
  if (error) throw error
  return data
}

export async function duplicateOrder(id: string) {
  const { data, error } = await supabase.rpc('admin_duplicate_order', { p_order_id: id })
  if (error) throw error
  return data
}

export async function addOrderNote(id: string, body: string, visibility: Enums<'note_visibility'> = 'INTERNAL', kind: Enums<'note_kind'> = 'NOTE') {
  const { data, error } = await supabase.rpc('add_order_note', { p_order_id: id, p_body: body, p_visibility: visibility, p_kind: kind })
  if (error) throw error
  return data
}

export interface ManualOrderPayload {
  customer: { full_name: string; phone: string; email?: string | null }
  shipping: { address: string; area?: string | null; city?: string | null; district: string; postal_code?: string | null }
  items: Array<{ variant_id: string; quantity: number; unit_price?: number }>
  delivery_method: string
  payment_method: Enums<'payment_method'>
  coupon_code?: string | null
  manual_discount?: number
  delivery_charge?: number | null
  customer_note?: string | null
  internal_note?: string | null
}

export async function createManualOrder(payload: ManualOrderPayload, confirm: boolean) {
  const { data, error } = await supabase.rpc('admin_create_order', { p_payload: asJson(payload), p_confirm: confirm })
  if (error) throw error
  return data
}

export async function adminQuote(items: Array<{ variant_id: string; quantity: number; unit_price?: number }>, district: string, area?: string, method = 'standard', coupon?: string, phone?: string): Promise<Quote> {
  const { data, error } = await supabase.rpc('admin_quote_order', {
    p_items: asJson(items), p_district: district, p_area: area || undefined, p_delivery_method: method,
    p_coupon_code: coupon || undefined, p_phone: phone || undefined,
  })
  if (error) throw error
  return fromJson<Quote>(data)
}

export async function recordPayment(input: { orderId: string; kind: Enums<'order_payment_kind'>; channel: Enums<'payment_channel'>; amount: number; reference?: string; note?: string; idempotencyKey: string }) {
  const { data, error } = await supabase.rpc('record_order_payment', {
    p_order_id: input.orderId, p_kind: input.kind, p_channel: input.channel, p_amount: input.amount,
    p_reference: input.reference || undefined, p_note: input.note || undefined, p_idempotency_key: input.idempotencyKey,
  })
  if (error) throw error
  return data
}

export async function verifyManualPayment(paymentId: string, approve: boolean, note?: string) {
  const { data, error } = await supabase.rpc('verify_manual_payment', { p_payment_id: paymentId, p_approve: approve, p_note: note || undefined })
  if (error) throw error
  return data
}

export async function refundOrder(input: { orderId: string; amount: number; channel: Enums<'payment_channel'>; reason: string; idempotencyKey: string }) {
  const { data, error } = await supabase.rpc('refund_order', {
    p_order_id: input.orderId, p_amount: input.amount, p_channel: input.channel, p_reason: input.reason, p_idempotency_key: input.idempotencyKey,
  })
  if (error) throw error
  return data
}

export async function retainAdvance(orderId: string, note: string) {
  const { data, error } = await supabase.rpc('retain_order_advance', { p_order_id: orderId, p_note: note })
  if (error) throw error
  return data
}

export async function processReturn(orderId: string, items: Array<{ order_item_id: string; quantity: number; condition: 'RESTOCK' | 'DAMAGED' }>, note?: string) {
  const { data, error } = await supabase.rpc('process_order_return', { p_order_id: orderId, p_items: asJson(items), p_note: note || undefined })
  if (error) throw error
  return data
}

export async function assignCourier(input: { orderId: string; courierId: string; trackingNumber?: string; shippingCost?: number | null; note?: string }) {
  const { data, error } = await supabase.rpc('assign_courier', {
    p_order_id: input.orderId, p_courier_id: input.courierId, p_tracking_number: input.trackingNumber || undefined,
    p_shipping_cost: input.shippingCost ?? undefined, p_note: input.note || undefined,
  })
  if (error) throw error
  return data
}

export function bookWithCourierApi(orderId: string, courierId: string, note?: string) {
  return invokeFunction<{ shipment: unknown }>('courier', { action: 'create_shipment', order_id: orderId, courier_id: courierId, note })
}

export async function updateShipment(shipmentId: string, changes: Record<string, unknown>) {
  const { data, error } = await supabase.rpc('update_shipment', { p_shipment_id: shipmentId, p_changes: asJson(changes) })
  if (error) throw error
  return data
}

export async function applyShipmentStatus(shipmentId: string, status: Enums<'shipment_status'>, description?: string) {
  const { data, error } = await supabase.rpc('apply_shipment_status', { p_shipment_id: shipmentId, p_status: status, p_description: description || undefined })
  if (error) throw error
  return data
}

export function runFraudCheck(orderId: string, apply = true) {
  return invokeFunction<{ check: Record<string, unknown>; order: unknown }>('fraud-check', { order_id: orderId, apply })
}

export async function fraudReviewDecide(orderId: string, action: 'APPROVE' | 'REQUEST_ADVANCE' | 'REJECT', opts: { advance?: number; note?: string; blockCustomer?: boolean } = {}) {
  const { data, error } = await supabase.rpc('fraud_review_decide', {
    p_order_id: orderId, p_action: action, p_advance_amount: opts.advance, p_note: opts.note || undefined, p_block_customer: opts.blockCustomer ?? false,
  })
  if (error) throw error
  return data
}

export async function fraudQueue(statuses: OrderStatus[], risk?: Enums<'risk_level'>, limit = 25, offset = 0): Promise<Paged<FraudQueueItem>> {
  const { data, error } = await supabase.rpc('admin_fraud_queue', { p_statuses: statuses, p_risk_level: risk, p_limit: limit, p_offset: offset })
  if (error) throw error
  return fromJson<Paged<FraudQueueItem>>(data)
}

// -----------------------------------------------------------------------------
// Fulfilment: duplicates, labels, scanning
// -----------------------------------------------------------------------------
export async function fulfillmentSummary(): Promise<FulfillmentSummary> {
  const { data, error } = await supabase.rpc('admin_fulfillment_summary')
  if (error) throw error
  return fromJson<FulfillmentSummary>(data)
}

export async function mergeOrders(orderId: string, intoOrderId: string) {
  const { data, error } = await supabase.rpc('admin_merge_orders', { p_order_id: orderId, p_into_order_id: intoOrderId })
  if (error) throw error
  return data
}

export async function getOrderBrief(id: string) {
  const { data, error } = await supabase.from('orders')
    .select('id, order_number, status, total_amount, created_at, customer_name, shipping_address').eq('id', id).maybeSingle()
  if (error) throw error
  return data
}

export async function dismissDuplicate(orderId: string) {
  const { error } = await supabase.rpc('admin_dismiss_duplicate', { p_order_id: orderId })
  if (error) throw error
}

export async function markLabelsPrinted(orderIds: string[], format: string) {
  const { data, error } = await supabase.rpc('mark_labels_printed', { p_order_ids: orderIds, p_format: format })
  if (error) throw error
  return fromJson<{ printed: number; reprinted: number; skipped: Array<{ order_number: string; reason: string }> }>(data)
}

/** Everything a shipping label needs, for up to 200 orders. */
export async function labelOrders(ids: string[]) {
  const { data, error } = await supabase
    .from('orders')
    .select(`id, order_number, status, created_at, customer_name, customer_phone, shipping_address, shipping_area, shipping_city,
      shipping_district, shipping_postal_code, total_amount, amount_paid, cod_amount, payment_method, customer_note,
      label_printed_at, label_print_count,
      order_items(product_name, variant_title, sku, quantity),
      shipments(is_active, tracking_number, consignment_id, couriers(name))`)
    .in('id', ids.slice(0, 200))
  if (error) throw error
  const order = new Map(ids.map((id, i) => [id, i]))
  return (data ?? []).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
}
export type LabelOrder = Awaited<ReturnType<typeof labelOrders>>[number]

export async function scanParcel(code: string, action: ScanAction, courierId?: string | null): Promise<ScanResult> {
  const { data, error } = await supabase.rpc('scan_parcel', { p_code: code, p_action: action, p_courier_id: courierId || undefined })
  if (error) throw error
  return fromJson<ScanResult>(data)
}

export async function recentScans(limit = 50) {
  const { data, error } = await supabase
    .from('parcel_scans')
    .select('id, code, action, order_id, order_number, result, message, from_status, to_status, scanned_by_name, created_at')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return data ?? []
}
export type ScanLogRow = Awaited<ReturnType<typeof recentScans>>[number]

export const MANUAL_SOURCES = [
  { value: 'MESSENGER', label: 'Messenger' },
  { value: 'WHATSAPP', label: 'WhatsApp' },
  { value: 'PHONE', label: 'Phone call' },
  { value: 'FACEBOOK_COMMENT', label: 'Facebook comment' },
  { value: 'INSTAGRAM_DM', label: 'Instagram DM' },
  { value: 'WALK_IN', label: 'Walk-in' },
  { value: 'REFERRAL', label: 'Referral' },
  { value: 'REPEAT_CUSTOMER', label: 'Repeat customer' },
  { value: 'OTHER', label: 'Other' },
] as const

export async function setOrderSource(orderId: string, source: string, note?: string) {
  const { data, error } = await supabase.rpc('admin_set_order_source', { p_order_id: orderId, p_source: source, p_note: note || undefined })
  if (error) throw error
  return data
}

// ------------------------------------------------------------ web / approved

export async function listReviewStatuses(includeInactive = false): Promise<ReviewStatus[]> {
  let query = supabase.from('order_review_statuses').select('*').order('sort_order').order('label')
  if (!includeInactive) query = query.eq('is_active', true)
  const { data, error } = await query
  if (error) throw error
  return data
}

export async function saveReviewStatus(input: Partial<ReviewStatus> & { label: string }) {
  const { data, error } = await supabase.rpc('admin_save_review_status', { p: asJson(input) })
  if (error) throw error
  return data
}

type BatchResult = { failed: Array<{ order_id: string; order_number: string; error: string }> }

export async function setWebOrderStatus(ids: string[], status: string, note?: string, followUpAt?: string | null) {
  const { data, error } = await supabase.rpc('set_web_order_status', {
    p_order_ids: ids, p_status: status, p_note: note || undefined, p_follow_up_at: followUpAt || undefined,
  })
  if (error) throw error
  return fromJson<BatchResult & { updated: number }>(data)
}

export async function approveOrders(ids: string[], note?: string) {
  const { data, error } = await supabase.rpc('approve_orders', { p_order_ids: ids, p_note: note || undefined })
  if (error) throw error
  return fromJson<BatchResult & { approved: number }>(data)
}

export async function queueCounts(): Promise<QueueCounts> {
  const { data, error } = await supabase.rpc('admin_order_queue_counts')
  if (error) throw error
  return fromJson<QueueCounts>(data)
}

export async function recordPartialDelivery(orderId: string, items: Array<{ order_item_id: string; quantity: number }>, note?: string) {
  const { data, error } = await supabase.rpc('record_partial_delivery', { p_order_id: orderId, p_items: asJson(items), p_note: note || undefined })
  if (error) throw error
  return data
}

export async function listCheckoutLeads(statuses: string[] = ['OPEN', 'CONTACTED'], q = '', limit = 25, offset = 0): Promise<Paged<CheckoutLead>> {
  let query = supabase.from('checkout_leads').select('*', { count: 'exact' }).in('status', statuses)
    .order('updated_at', { ascending: false }).range(offset, offset + limit - 1)
  const term = q.trim().replace(/[%,()]/g, '')
  if (term) query = query.or(`phone.ilike.%${term}%,customer_name.ilike.%${term}%`)
  const { data, error, count } = await query
  if (error) throw error
  return { items: data, total: count ?? 0 }
}

export async function getCheckoutLead(id: string): Promise<CheckoutLead | null> {
  const { data, error } = await supabase.from('checkout_leads').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return data
}

export async function updateCheckoutLead(id: string, status: 'OPEN' | 'CONTACTED' | 'DISMISSED', note?: string) {
  const { data, error } = await supabase.rpc('admin_update_checkout_lead', { p_id: id, p_status: status, p_note: note || undefined })
  if (error) throw error
  return data
}

export async function linkCheckoutLead(leadId: string, orderId: string) {
  const { data, error } = await supabase.rpc('admin_link_checkout_lead', { p_lead_id: leadId, p_order_id: orderId })
  if (error) throw error
  return data
}
