// Super Admin → Other Integrations: every merchant's connections and the
// platform's own services. Merchant credentials never leave the merchant;
// only state, last success and errors are shown.
import { type MerchantRef, platformRpc } from '@/services/platform'

export interface IntegrationsOverview {
  stores: Array<{ id: string; merchant: MerchantRef; platform: 'SHOPIFY' | 'WOOCOMMERCE'; name: string; domain: string; status: string; last_sync_at: string | null
    last_order_at: string | null; last_error: string | null; orders: number; failed_jobs: number; overdue_jobs: number; webhook_errors_24h: number }>
  couriers: Array<{ id: string; merchant: MerchantRef; name: string; provider: string | null; api_enabled: boolean; api_status: string | null; is_active: boolean
    last_event_at: string | null; failed_events_24h: number; failed_bookings_7d: number }>
  payments: Array<{ merchant: MerchantRef; providers: string[]; events_24h: number; last_event_at: string | null; errors_24h: number }>
  ads: Array<{ merchant: MerchantRef; platform: string; name: string | null; status: string; last_error: string | null; at: string | null }>
  platform: {
    sms: { connected: boolean; provider: string | null; balance: number | null; balance_checked_at: string | null; failed_24h: number; sent_24h: number; last_error: string | null }
    bd_courier: { connected: boolean; service: string | null; last_test_at: string | null; last_test_ok: boolean | null; last_error: string | null; failed_24h: number; succeeded_24h: number }
    billing_gateways: Record<string, { enabled?: boolean; connected?: boolean; sandbox?: boolean; hint?: string | null }>
    pbx: { last_seen_at: string | null; online: boolean; version: string | null } | null
    ai: { present: boolean; note: string }
  }
  can: { edit: boolean; manage: boolean }
}
export const integrationsOverview = () => platformRpc<IntegrationsOverview>('platform_integrations_overview')
export const retryIntegration = (kind: 'store_jobs' | 'courier_events', id: string, reason?: string) =>
  platformRpc<{ requeued?: number; retried?: number; results?: Record<string, number> }>('platform_integration_retry', { p_kind: kind, p_id: id, p_reason: reason ?? null })
