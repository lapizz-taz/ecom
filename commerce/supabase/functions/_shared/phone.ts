/**
 * Phone numbers as people type them, cleaned to one form. The same rules as public.normalize_phone()
 * in the database (migration 20261208000100_phone_forms.sql), so the checkout, the backend functions
 * and the database accept exactly the same numbers. For Bangladesh (country code 880):
 *
 *   +880 1711-000000, 8801711000000, 008801711000000    → 01711000000
 *   +880 01711000000, +88 01711000000 (an extra 0)       → 01711000000
 *   1711000000 (the 0 left off), +88 1711000000          → 01711000000
 *   ০১৭১১০০০০০০ (Bangla digits)                          → 01711000000
 *   "01711-000000 / 01811-000000" (two numbers)           → 01711000000 (the first one)
 *
 * Anything else keeps its digits, so the caller's own check refuses it with the number shown.
 */

// Bangla, Arabic-Indic and Persian digits, in order 0-9 (each is a single UTF-16 unit).
const LOCAL_DIGITS = '০১২৩৪৫৬৭৮৯٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹'
const BD_MOBILE = /^01[3-9]\d{8}$/
// A mobile number inside longer text, separators allowed between its digits.
const FIRST_MOBILE = /(?:^|[^0-9+])(\+?(?:00)?(?:88)?[ -]?0?1[3-9](?:[ -]?[0-9]){8})(?:[^0-9]|$)/

function asciiDigits(input: string): string {
  return input.replace(/[০-৯٠-٩۰-۹]/g, (c) => String(LOCAL_DIGITS.indexOf(c) % 10))
}

/** Digits only, in the country's local trunk form (0 then the national number). */
function localDigits(d: string, cc: string): string {
  if (!d) return ''
  if (d.startsWith(`00${cc}`)) return `0${d.slice(cc.length + 2).replace(/^0+/, '')}`
  if (d.startsWith(cc) && d.length > cc.length + 8) return `0${d.slice(cc.length).replace(/^0+/, '')}`
  if (cc === '880' && /^881[3-9]\d{8}$/.test(d)) return `0${d.slice(2)}`
  if (cc === '880' && /^0*1[3-9]\d{8}$/.test(d)) return `0${d.replace(/^0+/, '')}`
  return d
}

export function normalizePhone(input: unknown, countryCode = '880'): string {
  const text = asciiDigits(String(input ?? ''))
  const whole = localDigits(text.replace(/\D/g, ''), countryCode)
  if (!whole || countryCode !== '880' || BD_MOBILE.test(whole)) return whole
  const m = FIRST_MOBILE.exec(text)
  const first = m ? localDigits(m[1].replace(/\D/g, ''), countryCode) : ''
  return BD_MOBILE.test(first) ? first : whole
}

/** 01XXXXXXXXX for a Bangladeshi mobile number, else null. */
export function bdMobile(input: unknown): string | null {
  const v = normalizePhone(input, '880')
  return BD_MOBILE.test(v) ? v : null
}

/** 8801XXXXXXXXX (country code, no +: Meta, WhatsApp and SMS gateways), else ''. */
export function bdMobileIntl(input: unknown): string {
  const v = bdMobile(input)
  return v ? `88${v}` : ''
}

/** The first of several phone fields that holds a Bangladeshi mobile number, else the first one filled in. */
export function pickPhone(...candidates: Array<string | null | undefined>): string | null {
  const filled = candidates.map((c) => (typeof c === 'string' ? c.trim() : '')).filter(Boolean)
  return filled.find((c) => bdMobile(c)) ?? filled[0] ?? null
}
