import type { SupabaseClient } from '@supabase/supabase-js'
import { env } from '../env.ts'
import { CourierHistoryProvider } from './courier-history.ts'
import { HttpCourierHistoryProvider, type HttpProviderConfig, InternalHistoryProvider } from './providers.ts'
import type { FraudCheckInput, FraudProvider, FraudProviderResult, OutcomeCounts, RecordFraudCheckPayload } from './types.ts'

export interface FraudSettings {
  enabled?: boolean
  providers?: string[]
  http?: { mapping?: HttpProviderConfig['mapping']; method?: 'GET' | 'POST'; timeout_ms?: number }
  courier_history?: { timeout_ms?: number }
}

/** Keys loaded from Vault by the service role (see loadFraudProviders). */
export interface FraudSecrets {
  courierHistory?: { api_key?: string; base_url?: string } | null
}

/** Vault entry for the courier-history API key, saved from Settings → Fraud. */
export const COURIER_HISTORY_SECRET = 'fraud.courier_history'

/** Builds the configured providers. Credentials come from Vault or secrets only. */
export function providersFromSettings(settings: FraudSettings, fetchFn: typeof fetch = fetch, secrets: FraudSecrets = {}): FraudProvider[] {
  const names = settings.providers?.length ? settings.providers : ['internal']
  const providers: FraudProvider[] = []
  for (const name of names) {
    if (name === 'internal') providers.push(new InternalHistoryProvider())
    if (name === 'courier_history') {
      const apiKey = secrets.courierHistory?.api_key ?? env('COURIER_HISTORY_API_KEY')
      if (!apiKey) {
        console.warn('Courier history check is enabled but no API key is connected; skipping it')
        continue
      }
      providers.push(new CourierHistoryProvider({
        apiKey,
        baseUrl: secrets.courierHistory?.base_url || env('COURIER_HISTORY_URL'),
        timeoutMs: settings.courier_history?.timeout_ms,
      }, fetchFn))
    }
    if (name === 'http') {
      const urlTemplate = env('FRAUD_API_URL')
      if (!urlTemplate) {
        console.warn('Fraud provider "http" is enabled but FRAUD_API_URL is not set; skipping it')
        continue
      }
      providers.push(
        new HttpCourierHistoryProvider(
          {
            urlTemplate,
            apiKey: env('FRAUD_API_KEY'),
            authHeader: env('FRAUD_API_AUTH_HEADER'),
            authScheme: env('FRAUD_API_AUTH_SCHEME'),
            method: settings.http?.method,
            timeoutMs: settings.http?.timeout_ms,
            mapping: settings.http?.mapping ?? {},
          },
          fetchFn,
        ),
      )
    }
  }
  return providers.length ? providers : [new InternalHistoryProvider()]
}

/** Providers for a check, with the courier-history key read from Vault. */
export async function loadFraudProviders(admin: SupabaseClient, settings: FraudSettings, fetchFn: typeof fetch = fetch): Promise<FraudProvider[]> {
  let courierHistory: FraudSecrets['courierHistory'] = null
  if (settings.providers?.includes('courier_history')) {
    const { data, error } = await admin.rpc('integration_secret_get', { p_key: COURIER_HISTORY_SECRET })
    if (error) console.error('Could not load the courier history key', error.message)
    courierHistory = (data as FraudSecrets['courierHistory']) ?? null
  }
  return providersFromSettings(settings, fetchFn, { courierHistory })
}

function maxDefined(values: Array<number | undefined>): number | undefined {
  const defined = values.filter((v): v is number => typeof v === 'number')
  return defined.length ? Math.max(...defined) : undefined
}

/**
 * FraudDetectionService: runs every configured provider in parallel and
 * merges their results into the payload for record_fraud_check(). The
 * database adds the store's own history, scores the result and evaluates the
 * configurable rules — business rules never live in this layer.
 */
export class FraudDetectionService {
  constructor(private readonly providers: FraudProvider[]) {}

  async check(input: FraudCheckInput, extras: { orderId?: string; context?: Record<string, unknown> } = {}): Promise<RecordFraudCheckPayload> {
    const results: FraudProviderResult[] = await Promise.all(
      this.providers.map((p) =>
        p.checkCustomer(input).catch((error: Error) => ({ provider: p.name, ok: false, counts: {}, error: error.message })),
      ),
    )
    const external = results.filter((r) => r.provider !== 'internal')
    const failed = external.filter((r) => !r.ok)
    const counts: OutcomeCounts = {}
    for (const key of ['total', 'delivered', 'cancelled', 'returned', 'failed'] as const) {
      const value = maxDefined(results.filter((r) => r.ok).map((r) => r.counts[key]))
      if (value !== undefined) counts[key] = value
    }

    return {
      phone: input.phone,
      order_id: extras.orderId,
      provider: external.find((r) => r.ok)?.provider ?? external[0]?.provider ?? 'internal',
      providers: results.map((r) => r.provider),
      status: failed.length === 0 ? 'SUCCESS' : failed.length === external.length ? 'ERROR' : 'PARTIAL',
      error: failed.map((r) => `${r.provider}: ${r.error}`).join('; ') || undefined,
      provider_risk_score: maxDefined(results.map((r) => r.riskScore)),
      provider_courier_score: maxDefined(results.map((r) => r.courierScore)),
      provider_counts: counts,
      provider_response: Object.fromEntries(results.map((r) => [r.provider, r.raw ?? (r.error ? { error: r.error } : null)])),
      recommendation: results.find((r) => r.recommendation)?.recommendation,
      context: extras.context,
    }
  }
}
