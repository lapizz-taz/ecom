// Payments merchants make to the platform (subscription invoices, credit
// packages) go to the platform's own gateway accounts, saved from the Super
// Admin panel. They never use a merchant's gateway account.
import type { SupabaseClient } from '@supabase/supabase-js'
import { env, requireEnv } from './env.ts'
import { HttpError } from './http.ts'
import { type Gateway, gatewayFromCredentials } from './payments/registry.ts'
import type { PaymentProvider } from './payments/types.ts'
import { adminClient } from './supabase.ts'

export const PLATFORM_GATEWAYS = ['bkash', 'paystation'] as const
export const platformGatewaySecret = (code: Gateway) => `gateway.${code}`

interface GatewaySettings { enabled?: boolean; connected?: boolean; sandbox?: boolean }

/**
 * The platform's gateway. Uses a client without a merchant, so the bKash
 * token is the platform's (shared by every merchant's payment), not a merchant's.
 */
export async function platformGateway(code: Gateway, opts: { allowDisabled?: boolean; credentials?: Record<string, string>; sandbox?: boolean } = {}): Promise<PaymentProvider> {
  const platform = adminClient()
  const { data: settings, error } = await platform.rpc('platform_billing_gateways_config')
  if (error) throw new HttpError(500, `Could not read the payment settings: ${error.message}`, 'SETTINGS_READ_FAILED')
  const config = ((settings ?? {}) as Record<string, GatewaySettings>)[code] ?? {}
  if (!opts.credentials && !config.enabled && !opts.allowDisabled) throw new HttpError(422, 'This payment method is not available', 'PROVIDER_DISABLED')
  let creds = opts.credentials ?? null
  if (!creds) {
    const { data, error: secretError } = await platform.rpc('platform_secret_get', { p_key: platformGatewaySecret(code) })
    if (secretError) throw new HttpError(500, `Could not load the ${code} account: ${secretError.message}`, 'SECRET_READ_FAILED')
    creds = (data as Record<string, string> | null) ?? null
    if (!creds) throw new HttpError(503, 'Online payment is not set up yet', 'PROVIDER_NOT_CONFIGURED')
  }
  return gatewayFromCredentials(code, { enabled: true, sandbox: opts.sandbox ?? config.sandbox !== false }, creds, platform)
}

/** Where the admin app lives, for returning merchants after a payment. */
export function panelBase(req?: Request): string {
  return (env('PLATFORM_URL') ?? env('STOREFRONT_URL') ?? req?.headers.get('origin') ?? 'http://localhost:5173').replace(/\/+$/, '')
}

/** The billing function's own address (gateway returns and IPNs). */
export function billingCallbackBase(): string {
  return `${requireEnv('SUPABASE_URL').replace(/\/+$/, '')}/functions/v1/billing`
}

export type { SupabaseClient }
