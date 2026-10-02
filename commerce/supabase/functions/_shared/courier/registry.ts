import { env } from '../env.ts'
import { HttpError } from '../http.ts'
import { ManualCourierProvider, SteadfastProvider } from './providers.ts'
import type { CourierProvider } from './types.ts'

export interface CourierRow {
  id: string
  name: string
  provider: string
  api_enabled: boolean
  tracking_url_template: string | null
}

/**
 * CourierService factory. Credentials are per provider code, from secrets:
 *   steadfast → STEADFAST_API_KEY, STEADFAST_SECRET_KEY
 * Add a provider by implementing CourierProvider and registering it here.
 */
export function courierProvider(courier: CourierRow): CourierProvider {
  if (!courier.api_enabled || courier.provider === 'manual') {
    return new ManualCourierProvider(courier.tracking_url_template)
  }
  switch (courier.provider) {
    case 'steadfast': {
      const apiKey = env('STEADFAST_API_KEY')
      const secretKey = env('STEADFAST_SECRET_KEY')
      if (!apiKey || !secretKey) {
        throw new HttpError(503, 'Steadfast API keys are not configured (STEADFAST_API_KEY / STEADFAST_SECRET_KEY)', 'PROVIDER_NOT_CONFIGURED')
      }
      return new SteadfastProvider({ apiKey, secretKey, baseUrl: env('STEADFAST_BASE_URL'), trackingTemplate: courier.tracking_url_template })
    }
    default:
      return new ManualCourierProvider(courier.tracking_url_template)
  }
}
