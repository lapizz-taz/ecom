import type { FraudCheckInput, FraudProvider, FraudProviderResult } from './types.ts'

type FetchFn = typeof fetch

/**
 * Courier-history lookup used by Bangladeshi COD stores: for a phone number
 * it returns how many parcels each courier (Pathao, Steadfast, RedX,
 * Paperfly…) carried and how many were cancelled at the door. Two services
 * are supported:
 *   bdcourier  BD Courier (app.courier.com.bd → Developer/API):
 *              POST https://api.bdcourier.com/courier-check, Bearer key
 *   llcg       the LLCG courier fraud checker (the `fraud_checker` library)
 *
 * The API key is the store's own and comes from Vault or a function secret;
 * it is sent only from the server and never logged.
 */
export type CourierHistoryService = 'bdcourier' | 'llcg'

export const COURIER_HISTORY_SERVICES: Record<CourierHistoryService, { label: string; url: string }> = {
  bdcourier: { label: 'BD Courier', url: 'https://api.bdcourier.com' },
  llcg: { label: 'LLCG courier fraud checker', url: 'https://llcgteam.com/courier-fraud-checker' },
}

/** @deprecated kept for older imports; the LLCG address. */
export const COURIER_HISTORY_URL = COURIER_HISTORY_SERVICES.llcg.url

export interface CourierHistoryConfig {
  apiKey: string
  /** Which service the key belongs to (default: BD Courier). */
  service?: CourierHistoryService
  baseUrl?: string
  timeoutMs?: number
}

export interface CourierLine {
  courier: string
  orders: number
  cancelled: number
  delivered: number
  /** Display name as the service writes it, e.g. "SteadFast". */
  name?: string
  /** The courier's own success rate, 0–100, when the service reports one. */
  success_ratio?: number | null
  /** Only a rate (and maybe a parcel range) is known, not parcel counts. */
  rate_only?: boolean
  /** e.g. "50+" when the courier only reports a range. */
  parcel_range?: string | null
  notice?: string | null
}

/** The service's own verdict for the number (BD Courier). Staff only. */
export interface CourierVerdict {
  label: string | null
  level: string | null
  action: string | null
  reasons: string[]
}

export interface FraudReport {
  name: string | null
  details: string | null
  courier: string | null
  created_at: string | null
}

export interface CourierHistorySummary {
  service?: CourierHistoryService
  couriers: CourierLine[]
  total: number
  delivered: number
  cancelled: number
  /** Delivered ÷ total parcels, 0–100; null when the number has no parcels. */
  success_ratio: number | null
  name_on_record: string | null
  /** Fraud reports other merchants filed against the number (BD Courier). Staff only. */
  reports?: FraudReport[]
  /** 'provider' when success_ratio is the service's own figure (it may average couriers' rates). */
  ratio_source?: 'provider' | 'counts'
  /** How the service worked out its rate, in its own words. */
  calculation_note?: string | null
  verdict?: CourierVerdict | null
  /**
   * Fewest parcels the number certainly has: counted parcels plus the lower end
   * of any reported range ("50+" → 50). Used only for the "enough history" check.
   */
  parcel_floor?: number
}

/** 01XXXXXXXXX for a Bangladeshi mobile number (+880 / 880 / 0 prefixes), else null. */
export function bdMobile(phone: string): string | null {
  let d = String(phone ?? '').replace(/\D/g, '')
  if (d.startsWith('00880')) d = d.slice(2)
  if (d.startsWith('880')) d = `0${d.slice(3)}`
  else if (d.length === 10 && d.startsWith('1')) d = `0${d}`
  return /^01[3-9]\d{8}$/.test(d) ? d : null
}

function count(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[,\s]/g, ''))
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** Reads the API's `courierData` list into per-courier lines and totals. */
export function summarizeCourierHistory(body: unknown): CourierHistorySummary | null {
  const data = body as { courierData?: unknown; user_name?: unknown } | null
  if (!data || !Array.isArray(data.courierData)) return null
  const couriers = data.courierData
    .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
    .map((row) => {
      const orders = count(row.order ?? row.orders ?? row.total)
      const cancelled = Math.min(count(row.cancell ?? row.cancel ?? row.cancelled), orders)
      return { courier: String(row.label ?? row.name ?? 'courier').trim().toLowerCase(), orders, cancelled, delivered: orders - cancelled }
    })
  const total = couriers.reduce((s, c) => s + c.orders, 0)
  const cancelled = couriers.reduce((s, c) => s + c.cancelled, 0)
  const delivered = total - cancelled
  const name = typeof data.user_name === 'string' && data.user_name.trim() ? data.user_name.trim().slice(0, 120) : null
  return {
    couriers,
    total,
    delivered,
    cancelled,
    success_ratio: total > 0 ? Math.round((delivered / total) * 10000) / 100 : null,
    name_on_record: name,
  }
}

const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

/** A 0–100 rate, or null. */
function ratio(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[%,\s]/g, ''))
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 100) / 100 : null
}

/** Lower end of a parcel range: "50+" → 50, "10-49" → 10, "7" → 7. */
export function rangeFloor(range: unknown): number {
  const m = /(\d+)/.exec(String(range ?? ''))
  return m ? Number(m[1]) : 0
}

/**
 * Reads a BD Courier `/courier-check` answer:
 *   { status: 'success', data: { pathao: { total_parcel, success_parcel, cancelled_parcel, … }, …, summary }, reports: [] }
 * Parcels still on the way are neither delivered nor cancelled, so they are
 * left out of both counts.
 */
export function summarizeBdCourier(body: unknown): CourierHistorySummary | null {
  const root = body as { status?: unknown; data?: unknown; reports?: unknown } | null
  if (!root || typeof root.data !== 'object' || root.data === null || Array.isArray(root.data)) return null
  if (typeof root.status === 'string' && root.status.toLowerCase() !== 'success') return null
  const data = root.data as Record<string, unknown>
  const couriers: CourierLine[] = []
  for (const [key, value] of Object.entries(data)) {
    if (key === 'summary' || !value || typeof value !== 'object' || Array.isArray(value)) continue
    const row = value as Record<string, unknown>
    // data also carries non-courier entries (risk_verdict…): couriers have parcel fields.
    if (!('total_parcel' in row) && !('success_ratio' in row) && row.rate_only !== true) continue
    const orders = count(row.total_parcel)
    const delivered = Math.min(count(row.success_parcel), orders)
    const cancelled = Math.min(count(row.cancelled_parcel), orders - delivered)
    // Some couriers (Steadfast) only report a success rate and a range like "50+".
    const rateOnly = row.rate_only === true
    const range = text(row.parcel_range, 20)
    couriers.push({
      courier: key.trim().toLowerCase(), orders, cancelled, delivered,
      name: text(row.name, 40) ?? undefined,
      success_ratio: orders > 0 || rateOnly ? ratio(row.success_ratio) : null,
      rate_only: rateOnly,
      parcel_range: range,
      notice: text(row.notice, 300),
    })
  }
  const sum = (k: 'orders' | 'delivered' | 'cancelled') => couriers.reduce((s, c) => s + c[k], 0)
  const summary = (data.summary ?? {}) as Record<string, unknown>
  const total = data.summary ? count(summary.total_parcel) : sum('orders')
  const delivered = Math.min(data.summary ? count(summary.success_parcel) : sum('delivered'), total)
  const cancelled = Math.min(data.summary ? count(summary.cancelled_parcel) : sum('cancelled'), total - delivered)
  // BD Courier's own overall rate averages each courier's rate, so a rate-only
  // courier counts; use it as is (it is what their app shows).
  const providerRatio = data.summary ? ratio(summary.success_ratio) : null
  const hasHistory = total > 0 || couriers.some((c) => c.rate_only && c.success_ratio !== null)
  const verdictRaw = (data.risk_verdict ?? root.risk_verdict) as Record<string, unknown> | undefined
  const verdict = verdictRaw && typeof verdictRaw === 'object'
    ? {
      label: text(verdictRaw.label, 40), level: text(verdictRaw.level, 20), action: text(verdictRaw.action, 200),
      reasons: (Array.isArray(verdictRaw.reasons) ? verdictRaw.reasons : []).map((r) => text(r, 200)).filter((r): r is string => !!r).slice(0, 5),
    }
    : null
  const reports = (Array.isArray(root.reports) ? root.reports : [])
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .slice(0, 20)
    .map((r) => ({ name: text(r.name, 120), details: text(r.details, 500), courier: text(r.courierName, 60), created_at: text(r.created_at, 40) }))
  return {
    service: 'bdcourier',
    couriers: couriers.sort((a, b) => b.orders - a.orders),
    total,
    delivered,
    cancelled,
    success_ratio: !hasHistory ? null : providerRatio ?? (total > 0 ? Math.round((delivered / total) * 10000) / 100 : null),
    ratio_source: hasHistory && providerRatio !== null ? 'provider' : 'counts',
    name_on_record: null,
    reports,
    calculation_note: text(summary.calculation_note, 600),
    verdict,
    parcel_floor: total + couriers.filter((c) => c.rate_only).reduce((s, c) => s + rangeFloor(c.parcel_range), 0),
  }
}

/** A readable reason from an error body ({ message } / { error } / { errors }). */
function errorDetail(body: unknown): string | null {
  const b = body as { message?: unknown; error?: unknown; errors?: unknown } | null
  if (!b) return null
  if (typeof b.message === 'string') return b.message
  if (typeof b.error === 'string') return b.error
  if (b.errors && typeof b.errors === 'object') {
    const first = Object.values(b.errors as Record<string, unknown>).flat()[0]
    if (typeof first === 'string') return first
  }
  return null
}

export class CourierHistoryProvider implements FraudProvider {
  readonly name = 'courier_history'

  constructor(private readonly config: CourierHistoryConfig, private readonly fetchFn: FetchFn = fetch) {}

  get service(): CourierHistoryService {
    return this.config.service ?? 'bdcourier'
  }

  async lookup(phone: string): Promise<CourierHistorySummary> {
    const mobile = bdMobile(phone)
    if (!mobile) throw new Error('Not a Bangladeshi mobile number')
    const base = (this.config.baseUrl || COURIER_HISTORY_SERVICES[this.service].url).replace(/\/+$/, '')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 5000)
    const label = COURIER_HISTORY_SERVICES[this.service].label
    try {
      let response: Response
      if (this.service === 'bdcourier') {
        response = await this.fetchFn(`${base}/courier-check`, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.apiKey}` },
          body: JSON.stringify({ phone: mobile }),
          signal: controller.signal,
        })
      } else {
        const url = new URL(`${base}/fatch.php`)
        url.searchParams.set('api_key', this.config.apiKey)
        url.searchParams.set('term', mobile)
        response = await this.fetchFn(url, { headers: { Accept: 'application/json' }, signal: controller.signal })
      }
      const body = await response.json().catch(() => null)
      const detail = errorDetail(body)
      if (response.status === 401 || response.status === 403) {
        throw new Error(`${label} rejected the API key${detail ? ` (${detail.slice(0, 120)})` : ''}. Copy it again from your ${label} account.`)
      }
      if (response.status === 429) throw new Error(`${label}: daily limit reached for this plan. Try again later or upgrade the plan.`)
      if (!response.ok) throw new Error(`${label} answered HTTP ${response.status}${detail ? `: ${detail.slice(0, 160)}` : ''}`)
      const summary = this.service === 'bdcourier' ? summarizeBdCourier(body) : summarizeCourierHistory(body)
      if (!summary) {
        throw new Error(detail ? `${label}: ${detail.slice(0, 160)}` : `${label} returned an unexpected answer`)
      }
      return { ...summary, service: this.service }
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw new Error(`${label} did not answer in time`)
      if (error instanceof TypeError) throw new Error(`Could not reach ${label}`)
      // Never let the key reach a log or a person.
      throw new Error(String((error as Error).message ?? error).split(this.config.apiKey).join('[redacted]'))
    } finally {
      clearTimeout(timer)
    }
  }

  async checkCustomer(input: FraudCheckInput): Promise<FraudProviderResult> {
    try {
      const summary = await this.lookup(input.phone)
      return {
        provider: this.name,
        ok: true,
        // A parcel cancelled at the door counts as a return. The database merges
        // these counts with the store's own orders and works out the rate.
        counts: { total: summary.total, delivered: summary.delivered, returned: summary.cancelled },
        // The service's own overall rate (it counts rate-only couriers such as Steadfast).
        courierScore: summary.ratio_source === 'provider' && summary.success_ratio !== null ? summary.success_ratio : undefined,
        parcelFloor: summary.parcel_floor,
        raw: summary,
      }
    } catch (error) {
      return { provider: this.name, ok: false, counts: {}, error: (error as Error).message }
    }
  }
}
