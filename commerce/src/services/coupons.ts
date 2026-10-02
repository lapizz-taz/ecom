import { supabase } from '@/lib/supabase'
import type { TablesInsert } from '@/types/database'

export async function listCoupons() {
  const { data, error } = await supabase.from('coupons').select('*').order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
}
export type CouponRow = Awaited<ReturnType<typeof listCoupons>>[number]

export async function saveCoupon(values: TablesInsert<'coupons'> & { id?: string }) {
  const { id, ...rest } = values
  const payload = { ...rest, code: rest.code.trim().toUpperCase() }
  const { error } = id ? await supabase.from('coupons').update(payload).eq('id', id) : await supabase.from('coupons').insert(payload)
  if (error) throw error
}

export async function couponUsage(couponId: string) {
  const { data, error } = await supabase.from('coupon_usage').select('*, orders(order_number, status)').eq('coupon_id', couponId).order('created_at', { ascending: false }).limit(100)
  if (error) throw error
  return data ?? []
}
