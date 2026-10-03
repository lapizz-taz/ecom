import type { SupabaseClient } from '@supabase/supabase-js'
import { isSmsProvider, type SmsCredentials, SmsError, type SmsProvider, type SmsProviderCode, smsProviderFromCredentials } from './providers.ts'

/** The SMS settings row (no secrets: credentials are in Vault). */
export interface SmsConfig {
  enabled?: boolean
  connected?: boolean
  provider?: string | null
  sender_id?: string
  cost_per_sms?: number
}

export const smsSecretKey = (code: SmsProviderCode) => `sms.${code}`

export async function loadSmsConfig(admin: SupabaseClient): Promise<SmsConfig> {
  const { data, error } = await admin.rpc('sms_dispatch_config')
  if (error) throw new Error(`Could not read the SMS settings: ${error.message}`)
  return (data ?? {}) as SmsConfig
}

export async function loadSmsCredentials(admin: SupabaseClient, code: SmsProviderCode): Promise<SmsCredentials | null> {
  const { data, error } = await admin.rpc('integration_secret_get', { p_key: smsSecretKey(code) })
  if (error) throw new Error(`Could not read the SMS credentials: ${error.message}`)
  return (data as SmsCredentials | null) ?? null
}

/** The connected gateway and sender ID. Throws a permanent SmsError when nothing is connected. */
export async function connectedSmsProvider(admin: SupabaseClient): Promise<{ provider: SmsProvider; senderId: string | null; config: SmsConfig }> {
  const config = await loadSmsConfig(admin)
  if (!config.connected || !isSmsProvider(config.provider)) {
    throw new SmsError('No SMS provider is connected. Connect one on the SMS page.', true)
  }
  const creds = await loadSmsCredentials(admin, config.provider)
  if (!creds) throw new SmsError('The SMS provider credentials are missing. Connect the provider again on the SMS page.', true)
  return { provider: smsProviderFromCredentials(config.provider, creds), senderId: config.sender_id?.trim() || null, config }
}
