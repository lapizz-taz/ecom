// Formatting helpers. Currency comes from store settings (set at boot by the
// store config query), never hard-coded in components.

interface CurrencyConfig {
  symbol: string
  code: string
  locale: string
}

let currency: CurrencyConfig = { symbol: '৳', code: 'BDT', locale: 'en-BD' }

export function configureCurrency(next: Partial<CurrencyConfig>): void {
  currency = { ...currency, ...Object.fromEntries(Object.entries(next).filter(([, v]) => v)) }
}

export function currencySymbol(): string {
  return currency.symbol
}

const numberFormatters = new Map<string, Intl.NumberFormat>()
function nf(decimals: number): Intl.NumberFormat {
  const key = `${currency.locale}:${decimals}`
  let f = numberFormatters.get(key)
  if (!f) {
    f = new Intl.NumberFormat(currency.locale, { minimumFractionDigits: 0, maximumFractionDigits: decimals })
    numberFormatters.set(key, f)
  }
  return f
}

export function toNumber(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

/** ৳1,250 or -৳80.50 */
export function formatMoney(value: unknown, opts: { signed?: boolean } = {}): string {
  const n = toNumber(value)
  const abs = nf(2).format(Math.abs(n))
  const sign = n < 0 ? '-' : opts.signed && n > 0 ? '+' : ''
  return `${sign}${currency.symbol}${abs}`
}

export function formatNumber(value: unknown, decimals = 0): string {
  return nf(decimals).format(toNumber(value))
}

export function formatPercent(value: unknown, decimals = 1): string {
  if (value === null || value === undefined) return '—'
  return `${nf(decimals).format(toNumber(value))}%`
}

const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
const dateTimeFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })
const shortFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })

/** Date-only strings ("2026-10-01") are calendar dates, not UTC midnight. */
function toDate(value: string | Date): Date {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number)
    return new Date(y, m - 1, d)
  }
  return new Date(value)
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—'
  return dateFmt.format(toDate(value))
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—'
  return dateTimeFmt.format(new Date(value))
}

export function formatShortDate(value: string | Date | null | undefined): string {
  if (!value) return '—'
  return shortFmt.format(toDate(value))
}

export function timeAgo(value: string | Date | null | undefined): string {
  if (!value) return '—'
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return formatDate(value)
}

/** Like Shopify: "Today at 9:05 pm", "Yesterday at 11:25 pm", "Friday at 10:54 pm", "3 Oct at 2:10 pm". */
export function calendarTime(value: string | Date | null | undefined, now = new Date()): string {
  if (!value) return '—'
  const d = new Date(value)
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase()
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(now) - day(d)) / 86_400_000)
  if (diff === 0) return `Today at ${time}`
  if (diff === 1) return `Yesterday at ${time}`
  if (diff > 1 && diff < 7) return `${d.toLocaleDateString('en-US', { weekday: 'long' })} at ${time}`
  const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })
  return `${date} at ${time}`
}

export function titleCase(value: string | null | undefined): string {
  if (!value) return ''
  return value.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function initials(name: string | null | undefined): string {
  return (name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || '?'
}

export function slugify(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

export function isoDateToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
