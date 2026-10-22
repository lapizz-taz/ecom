import { storeKey } from '@/lib/merchant'

/** The order just placed, for the thank-you page (per store: see storeKey). */
export const lastOrderKey = () => storeKey('last_order')
