import type { FraudCheckInput, FraudProvider, FraudProviderResult } from './types.ts'

type FetchFn = typeof fetch

/**
 * Courier-history lookup used by Bangladeshi COD stores (the LLCG courier
 * fraud checker, the service behind the `fraud_checker` library): for a phone
 * number it returns how many parcels each courier (Pathao, Steadfast, RedX,
 * Paperfly…) carried and how many were cancelled at the door.
 *
 * The API key is the store's own and comes from Vault or a function secret;
 * it is sent only from the server and never logged.
 */
export const COURIER_HISTORY_URL = 'https://llcgteam.com/courier-fraud-checker'

export interface CourierHistoryConfig {
  apiKey: string
  baseUrl?: string
  timeoutMs?: number
}

export interface CourierLine {
  courier: string
  orders: number
  cancelled: number
  delivered: number
}

export interface CourierHistorySummary {
  couriers: CourierLine[]
  total: number
  delivered: number
  cancelled: number
  /** Delivered ÷ total parcels, 0–100; null when the number has no parcels. */
  success_ratio: number | null
  name_on_record: string | null
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

export class CourierHistoryProvider implements FraudProvider {
  readonly name = 'courier_history'

  constructor(private readonly config: CourierHistoryConfig, private readonly fetchFn: FetchFn = fetch) {}

  async lookup(phone: string): Promise<CourierHistorySummary> {
    const mobile = bdMobile(phone)
    if (!mobile) throw new Error('Not a Bangladeshi mobile number')
    const url = new URL(`${(this.config.baseUrl || COURIER_HISTORY_URL).replace(/\/+$/, '')}/fatch.php`)
    url.searchParams.set('api_key', this.config.apiKey)
    url.searchParams.set('term', mobile)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 5000)
    try {
      const response = await this.fetchFn(url, { headers: { Accept: 'application/json' }, signal: controller.signal })
      const body = await response.json().catch(() => null)
      if (!response.ok) throw new Error(`Courier history service answered HTTP ${response.status}`)
      const summary = summarizeCourierHistory(body)
      if (!summary) {
        const message = (body as { message?: unknown; error?: unknown } | null)
        const detail = typeof message?.message === 'string' ? message.message : typeof message?.error === 'string' ? message.error : null
        throw new Error(detail ? `Courier history service: ${detail.slice(0, 160)}` : 'Courier history service returned an unexpected answer')
      }
      return summary
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw new Error('Courier history service timed out')
      if (error instanceof TypeError) throw new Error('Could not reach the courier history service')
      // Never let the key (it travels in the query string) reach a log or a person.
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
        raw: summary,
      }
    } catch (error) {
      return { provider: this.name, ok: false, counts: {}, error: (error as Error).message }
    }
  }
}
