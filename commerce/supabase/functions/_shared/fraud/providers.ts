import type { FraudCheckInput, FraudProvider, FraudProviderResult, OutcomeCounts } from './types.ts'

type FetchFn = typeof fetch

/**
 * The store's own history. The database already counts our orders for the
 * phone inside record_fraud_check(), so this provider contributes nothing
 * extra — it exists so "internal only" is an explicit, valid configuration.
 */
export class InternalHistoryProvider implements FraudProvider {
  readonly name = 'internal'
  checkCustomer(): Promise<FraudProviderResult> {
    return Promise.resolve({ provider: this.name, ok: true, counts: {} })
  }
}

export interface HttpProviderConfig {
  /** URL with a {phone} placeholder, e.g. https://api.example.com/check?phone={phone} */
  urlTemplate: string
  apiKey?: string
  authHeader?: string
  authScheme?: string
  method?: 'GET' | 'POST'
  timeoutMs?: number
  /** Dot paths into the JSON response (configured in Settings → Fraud). */
  mapping: {
    total?: string | null
    delivered?: string | null
    cancelled?: string | null
    returned?: string | null
    failed?: string | null
    success_ratio?: string | null
    risk_score?: string | null
    recommendation?: string | null
  }
}

export function readPath(source: unknown, path: string | null | undefined): unknown {
  if (!path) return undefined
  return path.split('.').reduce<unknown>((value, key) => {
    if (value && typeof value === 'object' && key in (value as Record<string, unknown>)) {
      return (value as Record<string, unknown>)[key]
    }
    return undefined
  }, source)
}

function toNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[%,\s]/g, ''))
  return Number.isFinite(n) ? n : undefined
}

/**
 * Generic adapter for courier-history / fraud-check APIs (common in markets
 * where COD refusals are tracked across couriers). Field locations are
 * configuration, so switching vendors needs no code change.
 */
export class HttpCourierHistoryProvider implements FraudProvider {
  readonly name = 'http'

  constructor(private readonly config: HttpProviderConfig, private readonly fetchFn: FetchFn = fetch) {}

  async checkCustomer(input: FraudCheckInput): Promise<FraudProviderResult> {
    const { config } = this
    const url = config.urlTemplate.replace('{phone}', encodeURIComponent(input.phone))
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (config.apiKey) {
      headers[config.authHeader ?? 'Authorization'] =
        config.authScheme === '' ? config.apiKey : `${config.authScheme ?? 'Bearer'} ${config.apiKey}`
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 6000)
    try {
      const response = await this.fetchFn(url, {
        method: config.method ?? 'GET',
        headers: config.method === 'POST' ? { ...headers, 'Content-Type': 'application/json' } : headers,
        body: config.method === 'POST' ? JSON.stringify({ phone: input.phone }) : undefined,
        signal: controller.signal,
      })
      const body = await response.json().catch(() => null)
      if (!response.ok || body === null) {
        return { provider: this.name, ok: false, counts: {}, raw: body, error: `HTTP ${response.status}` }
      }
      const m = config.mapping
      const counts: OutcomeCounts = {
        total: toNumber(readPath(body, m.total)),
        delivered: toNumber(readPath(body, m.delivered)),
        cancelled: toNumber(readPath(body, m.cancelled)),
        returned: toNumber(readPath(body, m.returned)),
        failed: toNumber(readPath(body, m.failed)),
      }
      // Many APIs report total + delivered + "cancelled" (= refused/returned).
      if (counts.failed === undefined && counts.returned === undefined && counts.total !== undefined && counts.delivered !== undefined) {
        const notDelivered = Math.max(counts.total - counts.delivered - (counts.cancelled ?? 0), 0)
        if (notDelivered > 0) counts.failed = notDelivered
      }
      return {
        provider: this.name,
        ok: true,
        counts,
        courierScore: toNumber(readPath(body, m.success_ratio)),
        riskScore: toNumber(readPath(body, m.risk_score)),
        recommendation: (readPath(body, m.recommendation) as string | undefined) ?? undefined,
        raw: body,
      }
    } catch (error) {
      return {
        provider: this.name,
        ok: false,
        counts: {},
        error: (error as Error).name === 'AbortError' ? 'Timed out' : (error as Error).message,
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
