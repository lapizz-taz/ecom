// Payments merchants make to the platform: subscription invoices and SMS /
// courier-check credit packages, through the platform's own gateway account.
//   POST {action: 'checkout', invoice_id, provider}  owner or settings manager of the business;
//        returns the gateway page to send the browser to
//   GET/POST ?callback=…&provider=…   browser return from bKash / PayStation; verified with
//        the gateway server to server, then back to Plan & Billing
//   POST ?reconcile=1  (pg_cron, x-cron-secret) finishes attempts whose browser never came back
// Credits and paid invoices change only in billing_gateway_confirm(), after the
// gateway confirms the payment and the amount matches.
import { z } from 'zod'
import { isCronRequest } from '../_shared/cron.ts'
import { clientIp, handle, HttpError, json, rateLimit, readJson } from '../_shared/http.ts'
import { logEvent } from '../_shared/monitoring.ts'
import { formOrQuery } from '../_shared/payment-flow.ts'
import type { PaymentProvider, VerifiedPayment } from '../_shared/payments/types.ts'
import { billingCallbackBase, panelBase, PLATFORM_GATEWAYS, platformGateway } from '../_shared/platform-billing.ts'
import { parse } from '../_shared/schemas.ts'
import { adminClient, optionalUser, rpc, userClient } from '../_shared/supabase.ts'

const checkoutSchema = z.object({ action: z.literal('checkout'), invoice_id: z.uuid(), provider: z.enum(PLATFORM_GATEWAYS) })

interface Created {
  payment_id: string
  reference: string
  amount: number
  currency: string
  invoice_number: string
  kind: string
  merchant: { name: string; phone: string; email: string | null; address: string }
}
interface Found { payment_id: string; merchant_id: string; reference: string; status: string; invoice_id: string }
interface Pending { payment_id: string; merchant_id: string; provider: string; reference: string; session: string; age_minutes: number }

/** Records what the gateway said, for the payment's merchant. */
async function confirm(merchantId: string, provider: string, expectedReference: string, verified: VerifiedPayment) {
  if (verified.reference && verified.reference !== expectedReference) {
    void logEvent({ level: 'ERROR', category: 'PAYMENT', source: 'billing', message: `${provider} confirmed a different payment than the one returned`,
      context: { expected: expectedReference, reported: verified.reference }, merchantId })
    return { status: 'reference_mismatch' }
  }
  return rpc<{ status: string; invoice_id: string; kind?: string }>(adminClient(merchantId), 'billing_gateway_confirm', {
    p_reference: expectedReference, p_provider: provider, p_txn: verified.providerTransactionId, p_amount: verified.amount,
    p_success: verified.success, p_payload: { raw: verified.raw, event: verified.eventId, reason: verified.reason ?? null },
  })
}

export default (
  handle(async (req) => {
    const url = new URL(req.url)

    // ------------------------------------------------------------ gateway return
    const callback = url.searchParams.get('callback')
    if (callback) {
      const provider = url.searchParams.get('provider') ?? ''
      const params = await formOrQuery(req)
      const session = provider === 'bkash' ? params.paymentID : provider === 'paystation' ? params.invoice_number : undefined
      const found = session && (PLATFORM_GATEWAYS as readonly string[]).includes(provider)
        ? await rpc<Found | null>(adminClient(), 'billing_gateway_lookup', { p_provider: provider, p_session: session }).catch(() => null)
        : null
      const back = (outcome: string, invoice?: string) => {
        let base: string
        try { base = panelBase() } catch {
          // No PLATFORM_URL: show the result here instead of guessing an address.
          void logEvent({ level: 'ERROR', category: 'PAYMENT', source: 'billing', message: 'No app address to return the merchant to (set PLATFORM_URL)' })
          return new Response(
            '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Payment</title>' +
            `<p style="font-family:system-ui;max-width:30rem;margin:4rem auto">Payment ${outcome === 'success' ? 'confirmed' : outcome === 'pending' || outcome === 'review' ? 'being checked' : 'not completed'}. Return to Fullfilio → Settings → Billing to see your invoice.</p>`,
            { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
        }
        return new Response(null, {
          status: 303, headers: { Location: `${base}/admin/settings/billing?${new URLSearchParams({ payment: outcome, ...(invoice ? { invoice } : {}) })}` },
        })
      }
      if (!found) {
        void logEvent({ level: 'WARN', category: 'PAYMENT', source: 'billing', message: `${provider || 'Gateway'} return for a billing payment we do not know`,
          context: { session: session ?? null } })
        return back('unknown')
      }
      let outcome = callback === 'success' ? 'pending' : callback
      try {
        params.reference = found.reference
        const gateway = await platformGateway(provider as (typeof PLATFORM_GATEWAYS)[number], { allowDisabled: true })
        if (gateway.verifyCallback) {
          const verified = await gateway.verifyCallback(params)
          const result = await confirm(found.merchant_id, provider, found.reference, verified)
          outcome = ['succeeded', 'already_succeeded'].includes(result.status) ? 'success'
            : ['amount_mismatch', 'reference_mismatch', 'duplicate_transaction'].includes(result.status) ? 'review'
            : verified.eventType.includes('cancel') ? 'cancelled' : 'failed'
        }
      } catch (error) {
        // Not confirmed yet: the reconcile job asks the gateway again.
        void logEvent({ level: 'WARN', category: 'PAYMENT', source: 'billing', message: `Could not verify a ${provider} billing return`, error,
          context: { reference: found.reference }, merchantId: found.merchant_id })
        outcome = 'review'
      }
      return back(outcome, found.invoice_id)
    }

    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')

    // ------------------------------------------------------------ reconcile (cron)
    if (url.searchParams.get('reconcile')) {
      if (!(await isCronRequest(req, adminClient()))) throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED')
      const pending = await rpc<Pending[]>(adminClient(), 'billing_gateway_pending', { p_limit: 50 })
      const gateways = new Map<string, PaymentProvider>()
      const counts: Record<string, number> = { checked: pending.length }
      for (const p of pending) {
        try {
          if (!gateways.has(p.provider)) gateways.set(p.provider, await platformGateway(p.provider as (typeof PLATFORM_GATEWAYS)[number], { allowDisabled: true }))
          const gateway = gateways.get(p.provider)!
          if (!gateway.reconcile) continue
          const verified = await gateway.reconcile(p.session, p.reference, p.age_minutes)
          if (!verified) {
            counts.waiting = (counts.waiting ?? 0) + 1
            continue
          }
          const result = await confirm(p.merchant_id, p.provider, p.reference, verified)
          counts[result.status] = (counts[result.status] ?? 0) + 1
        } catch (error) {
          counts.error = (counts.error ?? 0) + 1
          void logEvent({ level: 'WARN', category: 'PAYMENT', source: 'billing', message: `Could not reconcile a ${p.provider} billing payment`, error,
            context: { reference: p.reference }, merchantId: p.merchant_id })
        }
      }
      return json(req, counts)
    }

    // ------------------------------------------------------------ checkout (merchant)
    const user = await optionalUser(req)
    if (!user) throw new HttpError(401, 'Please sign in', 'UNAUTHENTICATED')
    rateLimit(`billing:${user.id}:${clientIp(req)}`, 10)
    const input = parse(checkoutSchema, await readJson(req))
    const client = userClient(req)
    if (!(await rpc<boolean>(client, 'billing_can_pay'))) {
      throw new HttpError(403, 'Only the owner or staff who manage settings can pay for the business', 'PERMISSION_DENIED')
    }
    const access = await rpc<{ merchant_id: string } | null>(client, 'get_my_access')
    if (!access?.merchant_id) throw new HttpError(403, 'No business for this login', 'PERMISSION_DENIED')
    const admin = adminClient(access.merchant_id)
    const gateway = await platformGateway(input.provider)
    const created = await rpc<Created>(admin, 'billing_gateway_payment_create', { p_invoice: input.invoice_id, p_provider: input.provider })
    const base = billingCallbackBase()
    const init = await gateway.initiate({
      payment: { id: created.payment_id, reference: created.reference, amount: Number(created.amount), currency: created.currency || 'BDT', purpose: 'BILLING' },
      order: {
        order_number: created.invoice_number,
        customer_name: created.merchant.name,
        customer_phone: created.merchant.phone || created.reference,
        customer_email: created.merchant.email,
        shipping_address: created.merchant.address || created.merchant.name,
        shipping_district: 'Dhaka',
      },
      urls: {
        success: `${base}?callback=success&provider=${input.provider}`,
        fail: `${base}?callback=failed&provider=${input.provider}`,
        cancel: `${base}?callback=cancelled&provider=${input.provider}`,
        ipn: `${base}?callback=ipn&provider=${input.provider}`,
      },
    })
    if (init.type !== 'redirect' || !init.redirectUrl) throw new HttpError(502, 'The gateway did not return a payment page', 'GATEWAY_ERROR')
    await rpc(admin, 'billing_gateway_payment_session', { p_payment: created.payment_id, p_session: init.session ?? created.reference })
    return json(req, { redirect_url: init.redirectUrl, reference: created.reference })
  })
)
