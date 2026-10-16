import type { CheckoutFieldMode, StoreConfig } from '@/types/domain'

/** Checkout fields a store can switch on or off. Name, mobile number, address and district are always asked. */
export const CHECKOUT_FIELDS = [
  { key: 'last_name', label: 'Last name', hint: 'Off: one "Full name" box instead of first and last name', fallback: 'optional' },
  { key: 'email', label: 'Email', hint: 'For order updates by email', fallback: 'optional' },
  { key: 'apartment', label: 'Apartment, suite, etc.', hint: 'A second address line', fallback: 'optional' },
  { key: 'area', label: 'Area / Thana', hint: 'Helps the courier find the address', fallback: 'optional' },
  { key: 'postal_code', label: 'Postal code', hint: '', fallback: 'optional' },
  { key: 'note', label: 'Order note', hint: 'e.g. "call before coming"', fallback: 'hidden' },
] as const satisfies ReadonlyArray<{ key: string; label: string; hint: string; fallback: CheckoutFieldMode }>

export type CheckoutFieldKey = (typeof CHECKOUT_FIELDS)[number]['key']
export type CheckoutFieldModes = Record<CheckoutFieldKey, CheckoutFieldMode>

const MODES: CheckoutFieldMode[] = ['hidden', 'optional', 'required']

/** The store's choice for every field, with the defaults filled in. */
export function checkoutFieldModes(saved: StoreConfig['storefront']['checkout_fields'] | undefined): CheckoutFieldModes {
  return Object.fromEntries(CHECKOUT_FIELDS.map((f) => {
    const v = saved?.[f.key]
    return [f.key, v && MODES.includes(v) ? v : f.fallback]
  })) as CheckoutFieldModes
}
