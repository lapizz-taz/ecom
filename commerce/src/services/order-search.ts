import { supabase } from '@/lib/supabase'
import type { Enums } from '@/types/database'

// The Search page: find orders by one field (invoice, phone, name, courier
// tracking ID, payment transaction) or all of them. Runs as the signed-in
// staff member, so row-level security keeps it to their own business.

export type SearchField = 'all' | 'invoice' | 'phone' | 'name' | 'tracking' | 'transaction'

export interface OrderHit {
  id: string
  order_number: string
  created_at: string
  confirmed_at: string | null
  customer_name: string
  customer_phone: string
  shipping_address: string
  shipping_district: string | null
  status: Enums<'order_status'>
  payment_status: Enums<'payment_status'>
  total_amount: number
  /** Why it matched: the field and the value that matched. */
  matched: Array<{ field: Exclude<SearchField, 'all'>; value: string }>
  parcel?: { courier: string; tracking: string | null; status: Enums<'shipment_status'> } | null
}

const ORDER_COLUMNS = 'id, order_number, created_at, confirmed_at, customer_name, customer_phone, shipping_address, shipping_district, status, payment_status, total_amount'
const LIMIT = 50

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
/** For .or() filters, where commas and brackets would split the expression. */
const orLike = (q: string) => like(q.replace(/[,()]/g, ' ').trim())
/** Digits of a phone number as stored (01XXXXXXXXX), accepting +880 / 880. */
export function phoneDigits(q: string): string {
  let d = q.replace(/[০-৯]/g, (c) => String('০১২৩৪৫৬৭৮৯'.indexOf(c))).replace(/\D/g, '')
  if (d.startsWith('880')) d = `0${d.slice(3)}`
  return d
}

type Row = Omit<OrderHit, 'matched' | 'parcel'>

export async function searchOrders(field: SearchField, raw: string): Promise<OrderHit[]> {
  const q = raw.trim()
  if (q.length < 2) return []
  const hits = new Map<string, OrderHit>()
  const add = (rows: Row[] | null, f: Exclude<SearchField, 'all'>, value: (r: Row) => string) => {
    for (const r of rows ?? []) {
      const hit = hits.get(r.id) ?? { ...r, total_amount: Number(r.total_amount), matched: [] }
      if (!hit.matched.some((m) => m.field === f)) hit.matched.push({ field: f, value: value(r) })
      hits.set(r.id, hit)
    }
  }
  const want = (f: Exclude<SearchField, 'all'>) => field === 'all' || field === f
  const jobs: Array<Promise<void>> = []
  const digits = phoneDigits(q)

  if (want('invoice')) {
    jobs.push((async () => {
      const { data, error } = await supabase.from('orders').select(ORDER_COLUMNS).or(`order_number.ilike.${orLike(q)},external_order_number.ilike.${orLike(q)}`).is('merged_into', null).order('created_at', { ascending: false }).limit(LIMIT)
      if (error) throw error
      add(data as Row[], 'invoice', (r) => r.order_number)
    })())
  }
  if (want('phone') && digits.length >= 4) {
    jobs.push((async () => {
      const { data, error } = await supabase.from('orders').select(ORDER_COLUMNS).like('customer_phone', `%${digits}%`).is('merged_into', null).order('created_at', { ascending: false }).limit(LIMIT)
      if (error) throw error
      add(data as Row[], 'phone', (r) => r.customer_phone)
    })())
  }
  if (want('name') && /\p{L}/u.test(q)) {
    jobs.push((async () => {
      const { data, error } = await supabase.from('orders').select(ORDER_COLUMNS).ilike('customer_name', like(q)).is('merged_into', null).order('created_at', { ascending: false }).limit(LIMIT)
      if (error) throw error
      add(data as Row[], 'name', (r) => r.customer_name)
    })())
  }
  if (want('tracking')) {
    jobs.push((async () => {
      const { data, error } = await supabase.from('shipments').select(`tracking_number, consignment_id, orders!inner(${ORDER_COLUMNS})`)
        .or(`tracking_number.ilike.${orLike(q)},consignment_id.ilike.${orLike(q)}`).order('created_at', { ascending: false }).limit(LIMIT)
      if (error) throw error
      for (const s of (data ?? []) as unknown as Array<{ tracking_number: string | null; consignment_id: string | null; orders: Row }>) {
        add([s.orders], 'tracking', () => s.tracking_number ?? s.consignment_id ?? '')
      }
    })())
  }
  if (want('transaction')) {
    jobs.push((async () => {
      const { data, error } = await supabase.from('payments').select(`provider_transaction_id, reference, orders!inner(${ORDER_COLUMNS})`)
        .or(`provider_transaction_id.ilike.${orLike(q)},reference.ilike.${orLike(q)}`).order('created_at', { ascending: false }).limit(LIMIT)
      if (error) throw error
      for (const p of (data ?? []) as unknown as Array<{ provider_transaction_id: string | null; reference: string; orders: Row }>) {
        add([p.orders], 'transaction', () => p.provider_transaction_id ?? p.reference)
      }
    })())
  }
  await Promise.all(jobs)

  const list = [...hits.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, LIMIT)
  if (list.length) {
    const { data } = await supabase.from('shipments').select('order_id, tracking_number, consignment_id, status, couriers(name)')
      .in('order_id', list.map((o) => o.id)).eq('is_active', true)
    const parcels = new Map((data ?? []).map((s) => [s.order_id, s]))
    for (const o of list) {
      const s = parcels.get(o.id) as { tracking_number: string | null; consignment_id: string | null; status: Enums<'shipment_status'>; couriers: { name: string } | null } | undefined
      o.parcel = s ? { courier: s.couriers?.name ?? 'Courier', tracking: s.tracking_number ?? s.consignment_id, status: s.status } : null
    }
  }
  return list
}
