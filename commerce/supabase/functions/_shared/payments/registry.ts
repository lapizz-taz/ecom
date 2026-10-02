import { env } from '../env.ts'
import { HttpError } from '../http.ts'
import { ManualPaymentProvider, SslCommerzProvider } from './providers.ts'
import type { PaymentProvider } from './types.ts'

interface ProviderSettings {
  enabled?: boolean
  sandbox?: boolean
  instructions?: string
  accounts?: Array<{ channel: string; label: string; number: string }>
}

/** Returns an enabled provider. Add new gateways here. */
export function paymentProvider(code: string, settings: { providers?: Record<string, ProviderSettings> }): PaymentProvider {
  const config = settings.providers?.[code]
  if (!config?.enabled) throw new HttpError(422, 'This payment method is not available', 'PROVIDER_DISABLED')
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
    default:
      throw new HttpError(422, 'Unknown payment method', 'UNKNOWN_PROVIDER')
  }
}
