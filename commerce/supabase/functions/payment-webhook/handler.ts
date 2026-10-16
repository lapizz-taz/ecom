// Server-to-server payment notifications and the reconcile job.
//   POST ?provider=…   gateway notification (IPN). Safe to receive any number of
//                      times: verified with the gateway and deduplicated by
//                      (provider, event id) inside confirm_payment().
//   POST ?reconcile=1  (pg_cron; x-cron-secret is CRON_SECRET or Vault's
//                      'cron_secret') finishes bKash / PayStation payments
//                      whose customer never came back to the store.
import { isCronRequest } from '../_shared/cron.ts'
import { handle, HttpError, json } from '../_shared/http.ts'
import { logEvent } from '../_shared/monitoring.ts'
import { formOrQuery, type PendingGatewayPayment, reconcilePayment, recordVerifiedPayment } from '../_shared/payment-flow.ts'
import { loadPaymentProvider, type PaymentSettings } from '../_shared/payments/registry.ts'
import type { PaymentProvider } from '../_shared/payments/types.ts'
import { adminClient, forEachMerchant, getSettings, merchantFor, merchantOf, rpc } from '../_shared/supabase.ts'

export default (
  handle(async (req) => {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
    const url = new URL(req.url)

    if (url.searchParams.get('reconcile')) {
      if (!(await isCronRequest(req, adminClient()))) throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED')
      // Each merchant's pending payments are checked with that merchant's own gateway account.
      const run = await forEachMerchant('payment-webhook', async (admin) => {
        const settings = await getSettings<PaymentSettings>(admin, 'payments')
        const pending = await rpc<PendingGatewayPayment[]>(admin, 'gateway_payments_to_reconcile', { p_limit: 50 })
        const providers = new Map<string, PaymentProvider>()
        const counts: Record<string, number> = { checked: pending?.length ?? 0 }
        for (const payment of pending ?? []) {
          try {
            if (!providers.has(payment.provider)) {
              providers.set(payment.provider, await loadPaymentProvider(admin, payment.provider, settings, { allowDisabled: true }))
            }
            const result = await reconcilePayment(admin, providers.get(payment.provider)!, payment)
            counts[result.status] = (counts[result.status] ?? 0) + 1
          } catch (error) {
            counts.error = (counts.error ?? 0) + 1
            void logEvent({ level: 'WARN', category: 'PAYMENT', source: 'payment-webhook', message: `Could not reconcile a ${payment.provider} payment`,
              error, context: { reference: payment.reference }, merchantId: merchantOf(admin) })
          }
        }
        return counts
      })
      return json(req, run)
    }

    const providerCode = url.searchParams.get('provider') ?? ''
    const params = await formOrQuery(req)
    const session = providerCode === 'bkash' ? params.paymentID : providerCode === 'paystation' ? params.invoice_number : params.tran_id
    // The payment decides the merchant, and so whose gateway account verifies the notification.
    const merchantId = await merchantFor('payment_session', `${providerCode}:${session || params.reference || ''}`)
    if (!merchantId) {
      // Acknowledged so the gateway stops retrying, but logged.
      void logEvent({ level: 'WARN', category: 'WEBHOOK', source: 'payment-webhook', message: `${providerCode} notification for an unknown payment`,
        context: { session: session ?? null } })
      return json(req, { received: true, status: 'unknown_payment' })
    }
    const admin = adminClient(merchantId)
    const settings = await getSettings<PaymentSettings>(admin, 'payments')
    const provider = await loadPaymentProvider(admin, providerCode, settings, { allowDisabled: true })
    if (!provider.verifyCallback) throw new HttpError(400, 'Provider does not send webhooks', 'UNSUPPORTED')

    if (session && !params.reference) {
      const found = await rpc<{ reference: string | null } | null>(admin, 'find_gateway_payment', { p_provider: providerCode, p_session: session })
      if (found?.reference) params.reference = found.reference
    }
    const verified = await provider.verifyCallback(params)
    const result = await recordVerifiedPayment(admin, providerCode, verified, session || undefined)
    // Unknown references are acknowledged so the gateway stops retrying, but logged.
    if (result.status === 'unknown_payment') {
      void logEvent({ level: 'WARN', category: 'WEBHOOK', source: 'payment-webhook', message: `${providerCode} notification for an unknown payment`,
        context: { reference: verified.reference }, merchantId })
    }
    return json(req, { received: true, status: result.status })
  })
)
