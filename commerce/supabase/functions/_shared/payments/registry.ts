import type { SupabaseClient } from '@supabase/supabase-js'
import { env } from '../env.ts'
import { HttpError } from '../http.ts'
import { logEvent } from '../monitoring.ts'
import { BkashProvider, type BkashTokenStore } from './bkash.ts'
import { PaystationProvider } from './paystation.ts'
import { ManualPaymentProvider, SslCommerzProvider } from './providers.ts'
import type { PaymentProvider } from './types.ts'

export interface ProviderSettings {
  enabled?: boolean
  sandbox?: boolean
  instructions?: string
  pay_with_charge?: boolean
  accounts?: Array<{ channel: string; label: string; number: string }>
}

export interface PaymentSettings {
  providers?: Record<string, ProviderSettings>
}

/** Gateways whose credentials are saved from Settings → Payments (Vault). */
export const GATEWAYS = ['bkash', 'paystation'] as const
export type Gateway = (typeof GATEWAYS)[number]
export const gatewaySecret = (code: Gateway) => `payments.${code}`

export interface BkashCredentials { app_key?: string; app_secret?: string; username?: string; password?: string; base_url?: string }
export interface PaystationCredentials { merchant_id?: string; password?: string; token?: string; base_url?: string }

/** The bKash token shared through Vault. A failure here only costs an extra token grant, so it is logged, not thrown. */
function bkashTokenStore(admin: SupabaseClient): BkashTokenStore {
  const warn = (message: string, error: unknown) =>
    void logEvent({ level: 'WARN', category: 'PAYMENT', source: 'bkash', message, error })
  return {
    async get() {
      const { data, error } = await admin.rpc('gateway_token_get', { p_key: 'bkash' })
      if (error) warn('Could not read the shared bKash token', error)
      return (data as Awaited<ReturnType<BkashTokenStore['get']>>) ?? null
    },
    async set(value) {
      const { error } = await admin.rpc('gateway_token_put', { p_key: 'bkash', p_value: value })
      if (error) warn('Could not share the bKash token', error)
    },
  }
}

/** Builds a gateway from credentials (Vault first, then function secrets). Throws 503 when none are set. */
export function gatewayFromCredentials(
  code: Gateway,
  config: ProviderSettings,
  creds: Record<string, string | undefined> | null,
  admin?: SupabaseClient,
): PaymentProvider {
  if (code === 'bkash') {
    const c = (creds ?? {}) as BkashCredentials
    const appKey = c.app_key ?? env('BKASH_APP_KEY')
    const appSecret = c.app_secret ?? env('BKASH_APP_SECRET')
    const username = c.username ?? env('BKASH_USERNAME')
    const password = c.password ?? env('BKASH_PASSWORD')
    if (!appKey || !appSecret || !username || !password) {
      throw new HttpError(503, 'bKash payment is temporarily unavailable', 'PROVIDER_NOT_CONFIGURED')
    }
    return new BkashProvider(
      { appKey, appSecret, username, password, sandbox: config.sandbox !== false, baseUrl: c.base_url || env('BKASH_BASE_URL') },
      fetch, Date.now, admin ? bkashTokenStore(admin) : undefined,
    )
  }
  const c = (creds ?? {}) as PaystationCredentials
  const merchantId = c.merchant_id ?? env('PAYSTATION_MERCHANT_ID')
  const password = c.password ?? env('PAYSTATION_PASSWORD')
  if (!merchantId || !password) {
    throw new HttpError(503, 'Online payment is temporarily unavailable', 'PROVIDER_NOT_CONFIGURED')
  }
  return new PaystationProvider({
    merchantId, password, token: c.token ?? env('PAYSTATION_TOKEN'), baseUrl: c.base_url || env('PAYSTATION_BASE_URL'),
    payWithCharge: config.pay_with_charge === true,
  })
}

async function savedCredentials(admin: SupabaseClient, code: Gateway): Promise<Record<string, string> | null> {
  const { data, error } = await admin.rpc('integration_secret_get', { p_key: gatewaySecret(code) })
  if (error) throw new Error(`Could not load the ${code} credentials: ${error.message}`)
  return (data as Record<string, string> | null) ?? null
}

/** Returns an enabled provider, ready to use. Add new gateways here. */
export async function loadPaymentProvider(admin: SupabaseClient, code: string, settings: PaymentSettings, opts: { allowDisabled?: boolean } = {}): Promise<PaymentProvider> {
  const config = settings.providers?.[code] ?? {}
  if (!config.enabled && !opts.allowDisabled) throw new HttpError(422, 'This payment method is not available', 'PROVIDER_DISABLED')
  switch (code) {
    case 'manual':
      return new ManualPaymentProvider(config)
    case 'sslcommerz': {
      const storeId = env('SSLCOMMERZ_STORE_ID')
      const storePassword = env('SSLCOMMERZ_STORE_PASSWORD')
      if (!storeId || !storePassword) {
        throw new HttpError(503, 'Online payment is temporarily unavailable', 'PROVIDER_NOT_CONFIGURED')
      }
      return new SslCommerzProvider({ storeId, storePassword, sandbox: config.sandbox !== false })
    }
    case 'bkash':
    case 'paystation':
      return gatewayFromCredentials(code, config, await savedCredentials(admin, code), admin)
    default:
      throw new HttpError(422, 'Unknown payment method', 'UNKNOWN_PROVIDER')
  }
}
