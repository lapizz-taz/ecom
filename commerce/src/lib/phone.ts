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
