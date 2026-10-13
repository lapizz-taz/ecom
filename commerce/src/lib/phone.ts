// Mirrors public.normalize_phone() so the checkout can validate as you type.
// The database normalises and validates again.
export function normalizePhone(input: string, countryCode = '880'): string {
  const d = input.replace(/\D/g, '')
  if (!d) return ''
  if (d.startsWith(`00${countryCode}`)) return `0${d.slice(countryCode.length + 2)}`
  if (d.startsWith(countryCode) && d.length > countryCode.length + 8) return `0${d.slice(countryCode.length)}`
  return d
}

export function isValidPhone(input: string, pattern: string, countryCode = '880'): boolean {
  try {
    return new RegExp(pattern).test(normalizePhone(input, countryCode))
  } catch {
    return normalizePhone(input, countryCode).length >= 8
  }
}

/** A WhatsApp number as sign-up stores it: Bangladesh mobiles as 01XXXXXXXXX, others as +<country><number>. */
export function normalizeWhatsapp(input: string): string {
  const raw = input.replace(/[^0-9+]/g, '')
  if (!raw) return ''
  if (/^\+?8801[3-9]\d{8}$/.test(raw)) return `0${raw.replace(/^\+?880/, '')}`
  if (/^01[3-9]\d{8}$/.test(raw)) return raw
  return raw.startsWith('+') ? raw : `+${raw}`
}
export const isValidWhatsapp = (v: string) => /^01[3-9]\d{8}$/.test(v) || /^\+[1-9]\d{7,14}$/.test(v)
