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
