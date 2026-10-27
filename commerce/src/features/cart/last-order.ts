import { storeKey } from '@/lib/merchant'
import type { MergedCheckout } from '@/services/storefront'

/** The order just placed, for the thank-you page (per store: see storeKey). */
export const lastOrderKey = () => storeKey('last_order')

/** A checkout that joined an earlier order: its own lines, for the thank-you page. */
export type MergedLines = Pick<MergedCheckout, 'items' | 'subtotal'>
export const mergedOrderKey = () => storeKey('last_merged')

export function readMergedLines(): MergedLines | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(mergedOrderKey()) ?? 'null') as MergedLines | null
    return v && Array.isArray(v.items) ? v : null
  } catch {
    return null
  }
}
