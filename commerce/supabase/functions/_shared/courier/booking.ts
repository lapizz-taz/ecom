import type { SupabaseClient } from '@supabase/supabase-js'
import { rpc } from '../supabase.ts'

/**
 * Asks the courier for a parcel only while this request holds the order's booking claim
 * (shipment_booking_claim): a second booking of the same order, from another tab, another staff
 * member or a bulk booking started again, is refused instead of creating a second parcel. Saving
 * the parcel (assign_courier) ends the claim; a courier that refuses releases it at once.
 */
export async function withBookingClaim<T>(client: SupabaseClient, orderId: string, courierId: string, book: () => Promise<T>): Promise<T> {
  await rpc(client, 'shipment_booking_claim', { p_order_id: orderId, p_courier_id: courierId })
  try {
    return await book()
  } catch (error) {
    await rpc(client, 'shipment_booking_release', { p_order_id: orderId }).catch(() => undefined)
    throw error
  }
}
