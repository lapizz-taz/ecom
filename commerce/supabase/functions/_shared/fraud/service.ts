import type { SupabaseClient } from '@supabase/supabase-js'
import { env } from '../env.ts'
import { type CourierHistoryConfig, CourierHistoryProvider, type CourierHistoryService } from './courier-history.ts'
import { type CourierPanelCreds, CourierPanelProvider } from './courier-panel.ts'
import { CourierSourcesProvider } from './courier-sources.ts'
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
  courierHistory?: { api_key?: string; base_url?: string; service?: CourierHistoryService } | null
  /** The merchant's own courier merchant-panel logins (Steadfast, Pathao, RedX, Carrybee, Paperfly). */
  panel?: CourierPanelCreds | null
}

/**
 * The platform's BD Courier (courier-history) key, saved from the Super Admin
 * panel → BD Courier Integration. Merchants never hold their own key.
 */
export const PLATFORM_BD_COURIER_SECRET = 'bd_courier'

/**
 * The platform's courier merchant-panel logins, saved from Super Admin → BD
 * Courier Integration → Courier sign-in accounts. One set for every merchant.
 */
export const PLATFORM_COURIER_PANEL_SECRET = 'courier_panel'

/**
 * The courier-history connection: the platform key from the Super Admin panel,
 * else a function secret (BDCOURIER_API_KEY, or COURIER_HISTORY_API_KEY for
 * LLCG). Keys saved before BD Courier was supported carry no service and are LLCG keys.
 */
export function courierHistoryConfig(saved: FraudSecrets['courierHistory'], timeoutMs?: number): CourierHistoryConfig | null {
  const urlFor = (service: CourierHistoryService) => env(service === 'bdcourier' ? 'BDCOURIER_API_URL' : 'COURIER_HISTORY_URL')
  if (saved?.api_key) {
    const service = saved.service ?? 'llcg'
    return { apiKey: saved.api_key, service, baseUrl: saved.base_url || urlFor(service), timeoutMs }
  }
  const bd = env('BDCOURIER_API_KEY')
  if (bd) return { apiKey: bd, service: 'bdcourier', baseUrl: urlFor('bdcourier'), timeoutMs }
  const llcg = env('COURIER_HISTORY_API_KEY')
  if (llcg) return { apiKey: llcg, service: 'llcg', baseUrl: urlFor('llcg'), timeoutMs }
  return null
}

/**
 * Every BD Courier lookup is first allowed (and counted) by the platform's
 * usage policy, then reported done or failed (failures are not charged).
 */
export interface UsageMeter {
  begin(phone: string): Promise<{ allowed: boolean; usageId: string | null; reason?: string; message?: string }>
  finish(usageId: string, ok: boolean, error?: string): Promise<void>
}

/** The meter in the database (courier_lookup_begin / courier_lookup_finish), for the merchant named on the client. */
export function databaseMeter(admin: SupabaseClient): UsageMeter {
  return {
    async begin(phone) {
      const { data, error } = await admin.rpc('courier_lookup_begin', { p_phone: phone, p_key: crypto.randomUUID() })
      if (error) throw new Error(`Could not check the courier lookup allowance: ${error.message}`)
      const r = data as { allowed: boolean; usage_id: string | null; reason?: string; message?: string }
      return { allowed: r.allowed, usageId: r.usage_id, reason: r.reason, message: r.message }
    },
    async finish(usageId, ok, error) {
      const { error: e } = await admin.rpc('courier_lookup_finish', { p_usage: usageId, p_success: ok, p_error: error ?? null })
      if (e) throw new Error(`Could not record the courier lookup: ${e.message}`)
    },
  }
}

/** Wraps a provider so it runs only when the usage policy allows, and records the outcome. */
export class MeteredProvider implements FraudProvider {
  constructor(private readonly inner: FraudProvider, private readonly meter: UsageMeter) {}

  get name() {
    return this.inner.name
  }

  async checkCustomer(input: FraudCheckInput): Promise<FraudProviderResult> {
    let gate: Awaited<ReturnType<UsageMeter['begin']>>
    try {
      gate = await this.meter.begin(input.phone)
    } catch (error) {
      return { provider: this.name, ok: false, counts: {}, error: (error as Error).message }
    }
    if (!gate.allowed || !gate.usageId) {
      return { provider: this.name, ok: false, counts: {}, skipped: gate.reason ?? 'NOT_ALLOWED', error: gate.message }
    }
    const result = await this.inner.checkCustomer(input)
      .catch((error: Error): FraudProviderResult => ({ provider: this.name, ok: false, counts: {}, error: error.message }))
    await this.meter.finish(gate.usageId, result.ok, result.error)
      .catch((error: Error) => console.error('Courier lookup outcome not recorded:', error.message))
    return result
  }
}

/** Builds the configured providers. Credentials come from platform credentials or secrets only. */
export function providersFromSettings(settings: FraudSettings, fetchFn: typeof fetch = fetch, secrets: FraudSecrets = {}, meter?: UsageMeter): FraudProvider[] {
  const names = settings.providers?.length ? settings.providers : ['internal']
  const providers: FraudProvider[] = []
  let courierSourceAdded = false
  for (const name of names) {
    if (name === 'internal') providers.push(new InternalHistoryProvider())
    if (name === 'courier_history' || name === 'courier_panel') {
      // The platform's two courier sources work as one: turning on either asks both
      // (each only when connected), merged per courier and metered once per check.
      if (courierSourceAdded) continue
      courierSourceAdded = true
      const config = courierHistoryConfig(secrets.courierHistory, settings.courier_history?.timeout_ms)
      const history = config ? new CourierHistoryProvider(config, fetchFn) : null
      const signIns = secrets.panel ? new CourierPanelProvider(secrets.panel, { fetchFn }) : null
      const panel = signIns?.connected.length ? signIns : null
      if (!history && !panel) {
        console.warn('Courier checks are enabled but neither BD Courier nor a courier sign-in is connected; skipping them')
        continue
      }
      const provider = panel ? new CourierSourcesProvider(history, panel) : history!
      providers.push(meter ? new MeteredProvider(provider, meter) : provider)
    }
    if (name === 'http') {
      const urlTemplate = env('FRAUD_API_URL')
      if (!urlTemplate) {
        console.warn('Fraud provider "http" is enabled but FRAUD_API_URL is not set; skipping it')
        continue
      }
      const httpProvider = new HttpCourierHistoryProvider(
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
      )
      // Like courier_history, a paid external lookup: meter it so it can never
      // make unmetered operator-paid calls (e.g. from the public quote path).
      providers.push(meter ? new MeteredProvider(httpProvider, meter) : httpProvider)
    }
  }
  return providers.length ? providers : [new InternalHistoryProvider()]
}

/** The platform's courier-history key (service role only), or null. */
export async function platformCourierHistorySecret(admin: SupabaseClient): Promise<FraudSecrets['courierHistory']> {
  const { data, error } = await admin.rpc('platform_secret_get', { p_key: PLATFORM_BD_COURIER_SECRET })
  if (error) console.error('Could not load the BD Courier key', error.message)
  return (data as FraudSecrets['courierHistory']) ?? null
}

/** The platform's courier merchant-panel logins (service role only), or null. */
export async function platformPanelCreds(admin: SupabaseClient): Promise<FraudSecrets['panel']> {
  const { data, error } = await admin.rpc('platform_secret_get', { p_key: PLATFORM_COURIER_PANEL_SECRET })
  if (error) {
    console.error('Could not load courier panel logins', error.message)
    return null
  }
  return (data as FraudSecrets['panel']) ?? null
}

/** Providers for a check: the platform's BD Courier and courier sign-ins (together when either is on), metered for the merchant on `admin`. */
export async function loadFraudProviders(admin: SupabaseClient, settings: FraudSettings, fetchFn: typeof fetch = fetch): Promise<FraudProvider[]> {
  const couriers = settings.providers?.some((p) => p === 'courier_history' || p === 'courier_panel') ?? false
  const [courierHistory, panel] = couriers ? await Promise.all([platformCourierHistorySecret(admin), platformPanelCreds(admin)]) : [null, null]
  return providersFromSettings(settings, fetchFn, { courierHistory, panel }, databaseMeter(admin))
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
    // A lookup the usage policy refused is left out (the check uses the store's own history), not counted as a failure.
    const external = results.filter((r) => r.provider !== 'internal' && !r.skipped)
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
      provider_parcel_floor: maxDefined(results.filter((r) => r.ok).map((r) => r.parcelFloor)),
      provider_response: Object.fromEntries(results.map((r) => [r.provider, r.raw ?? (r.skipped ? { skipped: r.skipped, reason: r.error ?? null } : r.error ? { error: r.error } : null)])),
      recommendation: results.find((r) => r.recommendation)?.recommendation,
      context: extras.context,
    }
  }
}
