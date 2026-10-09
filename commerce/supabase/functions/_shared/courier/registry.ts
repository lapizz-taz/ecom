import type { SupabaseClient } from '@supabase/supabase-js'
import { env } from '../env.ts'
import { HttpError } from '../http.ts'
import { ManualCourierProvider, PathaoProvider, RedxProvider, SteadfastProvider } from './providers.ts'
import type { CourierProvider } from './types.ts'

export interface CourierRow {
  id: string
  name: string
  provider: string
  api_enabled: boolean
  tracking_url_template: string | null
}

export type CourierCredentials = Record<string, string | boolean | number | null | undefined>

/** Fields each courier needs to connect, in the order the admin form shows them. */
export const COURIER_FIELDS: Record<string, string[]> = {
  steadfast: ['api_key', 'secret_key'],
  pathao: ['client_id', 'client_secret', 'username', 'password', 'store_id'],
  redx: ['access_token'],
}

/**
 * Optional merchant-panel login (account email + password) kept with the keys,
 * encrypted like them. Pathao already needs its login to issue API tokens.
 */
export const COURIER_OPTIONAL_FIELDS: Record<string, string[]> = {
  steadfast: ['panel_email', 'panel_password'],
  redx: ['panel_email', 'panel_password'],
}

export const COURIER_TRACKING: Record<string, string> = {
  steadfast: 'https://steadfast.com.bd/t/{tracking}',
  pathao: 'https://merchant.pathao.com/tracking?consignment_id={tracking}',
  redx: 'https://redx.com.bd/track-parcel/?trackingId={tracking}',
}

const text = (v: unknown) => (v === undefined || v === null ? '' : String(v).trim())

export function missingCredentialFields(provider: string, creds: CourierCredentials): string[] {
  const missing = (COURIER_FIELDS[provider] ?? []).filter((f) => !text(creds[f]))
  // The optional login is all or nothing.
  const optional = COURIER_OPTIONAL_FIELDS[provider] ?? []
  if (optional.some((f) => text(creds[f]))) missing.push(...optional.filter((f) => !text(creds[f])))
  return missing
}

/** Problems with the values themselves (e.g. a login email that is not an email). */
export function invalidCredentialFields(provider: string, creds: CourierCredentials): string[] {
  const email = text(creds[provider === 'pathao' ? 'username' : 'panel_email'])
  return email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? ['account email'] : []
}

/** Masks an email for display: ra•••@shop.com. */
export function maskEmail(email: string): string {
  const [user, domain] = email.split('@')
  return domain ? `${user.slice(0, 2)}•••@${domain}` : '•••'
}

/** Masked hint shown in the admin ("••••3f9a · ra•••@shop.com"); never the secret itself. */
export function credentialHint(provider: string, creds: CourierCredentials): string {
  const main = text(creds[COURIER_FIELDS[provider]?.[0] ?? ''])
  const email = text(creds[provider === 'pathao' ? 'username' : 'panel_email'])
  return [main ? `••••${main.slice(-4)}` : '••••', email ? maskEmail(email) : null].filter(Boolean).join(' · ')
}

/** Builds a provider from explicit credentials (used to test before saving). */
export function buildCourierProvider(provider: string, creds: CourierCredentials, trackingTemplate?: string | null): CourierProvider {
  const sandbox = creds.sandbox === true || creds.sandbox === 'true'
  switch (provider) {
    case 'steadfast':
      return new SteadfastProvider({
        apiKey: text(creds.api_key), secretKey: text(creds.secret_key),
        baseUrl: text(creds.base_url) || env('STEADFAST_BASE_URL'), trackingTemplate,
      })
    case 'pathao':
      return new PathaoProvider({
        clientId: text(creds.client_id), clientSecret: text(creds.client_secret), username: text(creds.username),
        password: text(creds.password), storeId: text(creds.store_id), sandbox, trackingTemplate,
      })
    case 'redx':
      return new RedxProvider({ accessToken: text(creds.access_token), sandbox, trackingTemplate })
    default:
      return new ManualCourierProvider(trackingTemplate ?? null)
  }
}

/** Credentials from function secrets (older setups and local development). */
function envCredentials(provider: string): CourierCredentials | null {
  const creds: CourierCredentials = provider === 'steadfast'
    ? { api_key: env('STEADFAST_API_KEY'), secret_key: env('STEADFAST_SECRET_KEY') }
    : provider === 'pathao'
      ? { client_id: env('PATHAO_CLIENT_ID'), client_secret: env('PATHAO_CLIENT_SECRET'), username: env('PATHAO_USERNAME'),
          password: env('PATHAO_PASSWORD'), store_id: env('PATHAO_STORE_ID'), sandbox: env('PATHAO_SANDBOX') === 'true' }
      : provider === 'redx'
        ? { access_token: env('REDX_ACCESS_TOKEN'), sandbox: env('REDX_SANDBOX') === 'true' }
        : {}
  return COURIER_FIELDS[provider] && missingCredentialFields(provider, creds).length === 0 ? creds : null
}

/**
 * CourierService factory. Credentials come from Vault (saved from the admin
 * "Connect courier" form through the service role) or function secrets.
 */
export async function courierProviderFor(admin: SupabaseClient, courier: CourierRow): Promise<CourierProvider> {
  if (!courier.api_enabled || courier.provider === 'manual' || !COURIER_FIELDS[courier.provider]) {
    return new ManualCourierProvider(courier.tracking_url_template)
  }
  const { data, error } = await admin.rpc('courier_credentials_get', { p_courier_id: courier.id })
  if (error) console.error('Could not load courier credentials', error)
  const creds = (data as CourierCredentials | null) ?? envCredentials(courier.provider)
  if (!creds || missingCredentialFields(courier.provider, creds).length) {
    throw new HttpError(503, `${courier.name} is not connected. Connect it under Couriers.`, 'PROVIDER_NOT_CONFIGURED')
  }
  return buildCourierProvider(courier.provider, creds, courier.tracking_url_template)
}
