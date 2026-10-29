// The same phone rules as public.normalize_phone() and the backend functions
// (supabase/functions/_shared/phone.ts), so the checkout can validate as you type.
// The database normalises and validates again.
import { bdMobile, normalizePhone } from '../../supabase/functions/_shared/phone.ts'

export { bdMobile, normalizePhone }

export function isValidPhone(input: string, pattern: string, countryCode = '880'): boolean {
  try {
    return new RegExp(pattern).test(normalizePhone(input, countryCode))
  } catch {
    return normalizePhone(input, countryCode).length >= 8
  }
}

/** A WhatsApp number as sign-up stores it: Bangladesh mobiles as 01XXXXXXXXX, others as +<country><number>. */
export function normalizeWhatsapp(input: string): string {
  const bd = bdMobile(input)
  if (bd) return bd
  const raw = input.replace(/[^0-9+]/g, '')
  if (!raw) return ''
  return raw.startsWith('+') ? raw : `+${raw}`
}
export const isValidWhatsapp = (v: string) => /^01[3-9]\d{8}$/.test(v) || /^\+[1-9]\d{7,14}$/.test(v)
