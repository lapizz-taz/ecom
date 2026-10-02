// Server-to-server payment notifications (IPN). Safe to receive any number of
// times: every event is verified with the provider and deduplicated by
// (provider, event id) inside confirm_payment().
import { handle, HttpError, json } from '../_shared/http.ts'
import { formOrQuery, recordVerifiedPayment } from '../_shared/payment-flow.ts'
import { paymentProvider } from '../_shared/payments/registry.ts'
import { adminClient, getSettings } from '../_shared/supabase.ts'

Deno.serve(
  handle(async (req) => {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
    const providerCode = new URL(req.url).searchParams.get('provider') ?? ''
    const admin = adminClient()
    const settings = await getSettings<{ providers?: Record<string, { enabled?: boolean }> }>(admin, 'payments')
    const provider = paymentProvider(providerCode, settings)
    if (!provider.verifyCallback) throw new HttpError(400, 'Provider does not send webhooks', 'UNSUPPORTED')

    const params = await formOrQuery(req)
    const verified = await provider.verifyCallback(params)
    const result = await recordVerifiedPayment(admin, providerCode, verified)
    // Unknown references are acknowledged so the provider stops retrying, but logged.
    if (result.status === 'unknown_payment') console.warn('Webhook for unknown payment reference', verified.reference)
    return json(req, { received: true, status: result.status })
  }),
)
