// Customer payment endpoints (public, verify_jwt = false):
//   POST {action: 'initiate'}       start a payment for the amount the database says is due
//   POST {action: 'submit_manual'}  report a bKash/Nagad Send Money transaction ID
//   POST/GET ?callback=success|fail|cancel&provider=…  browser return from a hosted
//        checkout; verified server-to-server, then redirected to the storefront
import { env, requireEnv } from '../_shared/env.ts'
import { clientIp, handle, HttpError, json, rateLimit, readJson } from '../_shared/http.ts'
import { formOrQuery, recordVerifiedPayment } from '../_shared/payment-flow.ts'
import { paymentProvider } from '../_shared/payments/registry.ts'
import { initiatePaymentSchema, manualPaymentSchema, parse } from '../_shared/schemas.ts'
import { adminClient, getSettings, rpc } from '../_shared/supabase.ts'

function storefrontUrl(path: string): string {
  const base = (env('STOREFRONT_URL') ?? 'http://localhost:5173').replace(/\/$/, '')
  return `${base}${path}`
}

Deno.serve(
  handle(async (req) => {
    const url = new URL(req.url)
    const admin = adminClient()
    const callback = url.searchParams.get('callback')

    if (callback) {
      const providerCode = url.searchParams.get('provider') ?? ''
      const params = await formOrQuery(req)
      let orderNumber: string | null = null
      let outcome = callback === 'success' ? 'pending' : callback
      try {
        const settings = await getSettings<{ providers?: Record<string, { enabled?: boolean }> }>(admin, 'payments')
        const provider = paymentProvider(providerCode, settings)
        if (provider.verifyCallback) {
          const verified = await provider.verifyCallback(params)
          const result = await recordVerifiedPayment(admin, providerCode, verified)
          orderNumber = result.orderNumber
          outcome = ['succeeded', 'already_succeeded'].includes(result.status) ? 'success'
            : result.status === 'amount_mismatch' ? 'review' : 'failed'
        }
      } catch (error) {
        console.error('Payment callback could not be verified', error)
        outcome = 'review'
      }
      const target = storefrontUrl(
        `/order-success?${new URLSearchParams({ order: orderNumber ?? params.value_a ?? '', payment: outcome })}`,
      )
      return new Response(null, { status: 303, headers: { Location: target } })
    }

    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
    const body = await readJson<{ action?: string }>(req)
    const ip = clientIp(req)

    if (body.action === 'initiate') {
      rateLimit(`pay:${ip}`, 10)
      const input = parse(initiatePaymentSchema, body)
      const settings = await getSettings<{ providers?: Record<string, { enabled?: boolean }> }>(admin, 'payments')
      const provider = paymentProvider(input.provider, settings)

      if (provider.code === 'manual') {
        // Manual transfers create a payment record only when the customer
        // submits a transaction ID; here we just return the instructions.
        const tracked = await rpc<{ amount_due_now: number; total_amount: number; amount_paid: number } | null>(
          admin, 'track_order', { p_order_number: input.order_number, p_phone: input.phone })
        if (!tracked) throw new HttpError(404, 'Order not found', 'NOT_FOUND')
        const due = input.purpose === 'ADVANCE' ? Number(tracked.amount_due_now)
          : Number(tracked.total_amount) - Number(tracked.amount_paid)
        if (due <= 0) throw new HttpError(422, 'Nothing is due on this order', 'VALIDATION')
        const result = await provider.initiate({} as never)
        const store = await getSettings<{ currency?: string }>(admin, 'store')
        return json(req, { payment: { reference: null, amount: due, currency: store.currency ?? 'BDT' }, ...result })
      }

      const payment = await rpc<{ id: string; reference: string; amount: number; currency: string; purpose: string; order_id: string }>(
        admin,
        'start_order_payment',
        {
          p_order_number: input.order_number,
          p_phone: input.phone,
          p_purpose: input.purpose,
          p_provider: input.provider,
          p_channel: input.provider === 'manual' ? 'BKASH' : 'GATEWAY',
        },
      )
      const { data: order, error } = await admin
        .from('orders')
        .select('order_number, customer_name, customer_phone, customer_email, shipping_address, shipping_district')
        .eq('id', payment.order_id)
        .single()
      if (error || !order) throw new HttpError(404, 'Order not found', 'NOT_FOUND')

      const functionsBase = `${requireEnv('SUPABASE_URL')}/functions/v1`
      const result = await provider.initiate({
        payment: { ...payment, amount: Number(payment.amount) },
        order,
        urls: {
          success: `${functionsBase}/payments?callback=success&provider=${provider.code}`,
          fail: `${functionsBase}/payments?callback=failed&provider=${provider.code}`,
          cancel: `${functionsBase}/payments?callback=cancelled&provider=${provider.code}`,
          ipn: `${functionsBase}/payment-webhook?provider=${provider.code}`,
        },
      })
      if (result.redirectUrl || result.providerData) {
        await rpc(admin, 'attach_payment_provider_data', {
          p_payment_id: payment.id,
          p_redirect_url: result.redirectUrl ?? null,
          p_metadata: result.providerData ?? {},
        })
      }
      return json(req, {
        payment: { reference: payment.reference, amount: Number(payment.amount), currency: payment.currency },
        ...result,
      })
    }

    if (body.action === 'submit_manual') {
      rateLimit(`manual-pay:${ip}`, 5)
      const input = parse(manualPaymentSchema, body)
      const payment = await rpc<{ reference: string; status: string; amount: number }>(admin, 'submit_manual_payment', {
        p_order_number: input.order_number,
        p_phone: input.phone,
        p_channel: input.channel,
        p_sender_phone: input.sender_phone,
        p_transaction_id: input.transaction_id,
        p_amount: input.amount,
      })
      return json(req, { payment: { reference: payment.reference, status: payment.status, amount: payment.amount } }, 201)
    }

    throw new HttpError(400, 'Unknown action', 'UNKNOWN_ACTION')
  }),
)
