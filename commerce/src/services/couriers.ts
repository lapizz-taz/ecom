import { invokeFunction } from '@/lib/functions'
import { fromJson } from '@/lib/json'
import { supabase } from '@/lib/supabase'
import type { Enums, TablesInsert } from '@/types/database'
import type { CodReceivableItem } from '@/types/domain'

export async function listCouriers(activeOnly = false) {
  let query = supabase.from('couriers').select('*').order('name')
  if (activeOnly) query = query.eq('is_active', true)
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}
export type CourierRow = Awaited<ReturnType<typeof listCouriers>>[number]

export async function saveCourier(values: TablesInsert<'couriers'> & { id?: string }) {
  const { id, ...rest } = values
  const { error } = id ? await supabase.from('couriers').update(rest).eq('id', id) : await supabase.from('couriers').insert(rest)
  if (error) throw error
}

export async function listShipments(f: { courierId?: string; status?: Enums<'shipment_status'> | ''; q?: string; page: number; pageSize: number }) {
  let query = supabase
    .from('shipments')
    .select('*, couriers(name, provider), orders(id, order_number, customer_name, status, total_amount, amount_paid)', { count: 'exact' })
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .range((f.page - 1) * f.pageSize, f.page * f.pageSize - 1)
  if (f.courierId) query = query.eq('courier_id', f.courierId)
  if (f.status) query = query.eq('status', f.status)
  if (f.q) query = query.ilike('tracking_number', `%${f.q.replace(/[%,()]/g, '')}%`)
  const { data, error, count } = await query
  if (error) throw error
  return { items: data ?? [], total: count ?? 0 }
}
export type ShipmentRow = Awaited<ReturnType<typeof listShipments>>['items'][number]

export async function codReceivable(courierId?: string): Promise<CodReceivableItem[]> {
  const { data, error } = await supabase.rpc('admin_cod_receivable', { p_courier_id: courierId })
  if (error) throw error
  return fromJson<CodReceivableItem[]>(data) ?? []
}

export async function settleCod(shipmentIds: string[], reference?: string, note?: string) {
  const { data, error } = await supabase.rpc('record_cod_settlement', { p_shipment_ids: shipmentIds, p_reference: reference || undefined, p_note: note || undefined })
  if (error) throw error
  return fromJson<{ settled: number; amount: number; skipped: unknown[] }>(data)
}

export function testCourierConnection(courierId: string) {
  return invokeFunction<{ ok: boolean; message: string }>('courier', { action: 'test_connection', courier_id: courierId })
}

export function syncShipment(shipmentId: string) {
  return invokeFunction<{ provider_status: string; status: string }>('courier', { action: 'sync_status', shipment_id: shipmentId })
}

export function syncAllShipments(courierId?: string) {
  return invokeFunction<{ synced: number }>('courier', { action: 'sync_all', courier_id: courierId })
}

export type CourierProviderCode = 'steadfast' | 'pathao' | 'redx'

/** Tests the credentials with the courier, then stores them server-side (Vault). */
export function connectCourier(input: { courier_id?: string; provider: CourierProviderCode; name?: string; credentials: Record<string, string | boolean> }) {
  return invokeFunction<{ courier_id: string; ok: boolean; message: string }>('courier', { action: 'connect', ...input })
}

export function disconnectCourier(courierId: string) {
  return invokeFunction<{ ok: boolean }>('courier', { action: 'disconnect', courier_id: courierId })
}

export function bookShipments(orderIds: string[], courierId: string) {
  return invokeFunction<{ booked: number; results: Array<{ order_id: string; ok: boolean; tracking_number?: string | null; error?: string }> }>(
    'courier', { action: 'create_shipments', order_ids: orderIds, courier_id: courierId })
}

// ------------------------------------------------------------------ webhooks

/** The address a courier posts status updates to. */
export function courierWebhookUrl(courierId: string): string {
  return `${String(import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/$/, '')}/functions/v1/courier-webhook?courier=${courierId}`
}

/** Saves the secret the courier sends with each webhook (kept in Vault). */
export function setCourierWebhookSecret(courierId: string, secret: string) {
  return invokeFunction<{ ok: boolean; hint: string }>('courier', { action: 'set_webhook_secret', courier_id: courierId, secret })
}

export type WebhookResult = 'PROCESSED' | 'IGNORED' | 'UNMATCHED' | 'FAILED' | 'RECEIVED'

export async function listWebhookEvents(f: { result?: WebhookResult | ''; courierId?: string; q?: string; page: number; pageSize: number }) {
  let query = supabase
    .from('courier_webhook_events')
    .select('*, couriers(name), orders(id, order_number)', { count: 'exact' })
    .order('received_at', { ascending: false })
    .range((f.page - 1) * f.pageSize, f.page * f.pageSize - 1)
  if (f.result) query = query.eq('result', f.result)
  if (f.courierId) query = query.eq('courier_id', f.courierId)
  if (f.q) query = query.or(`consignment_id.ilike.%${f.q.replace(/[%,()]/g, '')}%,order_ref.ilike.%${f.q.replace(/[%,()]/g, '')}%`)
  const { data, error, count } = await query
  if (error) throw error
  return { items: data ?? [], total: count ?? 0 }
}
export type WebhookEventRow = Awaited<ReturnType<typeof listWebhookEvents>>['items'][number]

export async function retryWebhookEvent(eventId: string) {
  const { data, error } = await supabase.rpc('retry_courier_webhook', { p_event_id: eventId })
  if (error) throw error
  return fromJson<{ status: string; error?: string }>(data)
}

// ------------------------------------------------------------------ performance

export interface CourierMetrics {
  id: string
  name: string
  provider: string
  api_enabled: boolean
  booked: number
  shipped: number
  delivered: number
  partial: number
  returned: number
  cancelled: number
  in_transit: number
  delivery_rate: number | null
  return_rate: number | null
  delivery_cost: number
  return_cost: number
  cod_fees: number
  other_costs: number
  total_cost: number
  avg_cost_per_order: number | null
  cod_expected: number
  cod_settled: number
  avg_delivery_hours: number | null
}

export async function courierMetrics(from: string, to: string): Promise<CourierMetrics[]> {
  const { data, error } = await supabase.rpc('courier_metrics', { p_from: from, p_to: to })
  if (error) throw error
  return fromJson<CourierMetrics[]>(data) ?? []
}

// ------------------------------------------------------------------ statements

export type CourierInvoiceStatus = Enums<'courier_invoice_status'>

export async function listCourierInvoices(f: { courierId?: string; status?: CourierInvoiceStatus | ''; page: number; pageSize: number }) {
  let query = supabase
    .from('courier_invoices')
    .select('*, couriers(name)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range((f.page - 1) * f.pageSize, f.page * f.pageSize - 1)
  if (f.courierId) query = query.eq('courier_id', f.courierId)
  if (f.status) query = query.eq('status', f.status)
  const { data, error, count } = await query
  if (error) throw error
  return { items: data ?? [], total: count ?? 0 }
}
export type CourierInvoiceRow = Awaited<ReturnType<typeof listCourierInvoices>>['items'][number]

/** Totals across statements for the invoice page header. */
export async function courierInvoiceSummary() {
  const { data, error } = await supabase.from('courier_invoices').select('difference, status, payout_reported, line_count, matched_count').limit(2000)
  if (error) throw error
  const rows = data ?? []
  const diff = (r: { difference: number | null }) => Number(r.difference ?? 0)
  return {
    statements: rows.length,
    correct: rows.filter((r) => Math.abs(diff(r)) < 1).length,
    shortCount: rows.filter((r) => diff(r) <= -1).length,
    short: rows.filter((r) => diff(r) <= -1).reduce((s, r) => s - diff(r), 0),
    overCount: rows.filter((r) => diff(r) >= 1).length,
    over: rows.filter((r) => diff(r) >= 1).reduce((s, r) => s + diff(r), 0),
    received: rows.reduce((s, r) => s + Number(r.payout_reported ?? 0), 0),
    flagged: rows.reduce((s, r) => s + (r.line_count - r.matched_count), 0),
  }
}

export async function getCourierInvoice(id: string) {
  const { data, error } = await supabase
    .from('courier_invoices')
    .select('*, couriers(name), courier_invoice_lines(*, orders(id, order_number))')
    .eq('id', id)
    .order('line_no', { referencedTable: 'courier_invoice_lines' })
    .single()
  if (error) throw error
  return data
}
export type CourierInvoiceDetail = Awaited<ReturnType<typeof getCourierInvoice>>

/** Keeps the original statement file with the record (private bucket). */
export async function uploadStatementFile(courierId: string, file: File): Promise<string> {
  const path = `${courierId}/${Date.now()}-${file.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80)}`
  const { error } = await supabase.storage.from('courier-invoices').upload(path, file, { contentType: file.type || undefined })
  if (error) throw error
  return path
}

export async function statementFileUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from('courier-invoices').createSignedUrl(path, 300)
  if (error) throw error
  return data.signedUrl
}

export interface ImportStatementInput {
  courier_id: string
  invoice_number?: string
  invoice_date?: string
  period_start?: string
  period_end?: string
  payout_reported?: number | null
  file_path?: string
  file_name?: string
  notes?: string
  lines: Array<Record<string, string | number | null | undefined>>
}

export async function importCourierInvoice(input: ImportStatementInput) {
  const { data, error } = await supabase.rpc('import_courier_invoice', { p: input as never })
  if (error) throw error
  return fromJson<{ invoice_id: string; status: CourierInvoiceStatus; lines: number; matched: number; mismatched: number;
    unmatched: number; duplicates: number; payout_expected: number; payout_reported: number; difference: number }>(data)
}

export async function setCourierInvoiceStatus(id: string, status: CourierInvoiceStatus, opts: { note?: string; amountPaid?: number; reference?: string } = {}) {
  const { error } = await supabase.rpc('set_courier_invoice_status', {
    p_invoice_id: id, p_status: status, p_note: opts.note || undefined, p_amount_paid: opts.amountPaid, p_reference: opts.reference || undefined,
  })
  if (error) throw error
}

// Courier Management --------------------------------------------------------------
export type ParcelTab = 'all' | 'pending_entry' | 'assigned' | 'cancelled' | 'return_pending' | 'returned' | 'damage_lost' | 'delivered'
export interface Parcel {
  id: string; order_number: string; created_at: string; status: string; tab: ParcelTab
  customer: { name: string; phone: string; address: string; area: string | null; district: string | null }
  customer_note: string | null; total: number; cod_amount: number; amount_paid: number
  products: Array<{ name: string; variant: string | null; qty: number; image: string | null; damaged: number; returned: number }>
  item_count: number
  courier: { id: string; name: string; provider: string | null; tracking_url_template: string | null } | null
  shipment: { id: string; status: string; consignment_id: string | null; tracking_number: string | null; booked_at: string; shipping_cost: number | null; cod_collected: number | null; delivered_at: string | null } | null
  attempts: number; rider: { name?: string; phone?: string } | null; rider_note: string | null; last_update_at: string | null
  tags: string[]; in_charge: { id: string; name: string } | null
}
export interface ParcelPage { counts: Record<ParcelTab, number>; total: number; items: Parcel[] }

export async function courierParcels(f: { tab: ParcelTab; q?: string; courierId?: string; page: number; pageSize: number }): Promise<ParcelPage> {
  const { data, error } = await supabase.rpc('courier_parcels', {
    p: { tab: f.tab, q: f.q || null, courier_id: f.courierId || null, limit: f.pageSize, offset: (f.page - 1) * f.pageSize },
  })
  if (error) throw error
  return data as unknown as ParcelPage
}
