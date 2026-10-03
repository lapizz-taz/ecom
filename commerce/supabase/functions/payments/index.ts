// Payment endpoints (verify_jwt = false; staff actions check the session themselves):
//   POST {action: 'initiate'}       start a payment for the amount the database says is due
//   POST {action: 'submit_manual'}  report a bKash/Nagad Send Money transaction ID
//   GET/POST ?callback=…&provider=… browser return from bKash / PayStation / SSLCommerz;
//        verified server-to-server, then redirected to the storefront
//   Staff (Settings → Payments, order page):
//   POST {action: 'connect_gateway' | 'test_gateway' | 'disconnect_gateway'}  (settings.manage)
//   POST {action: 'check_payment'}  ask the gateway about a pending payment (payments.verify)
import { z } from 'zod'
import { env, requireEnv } from '../_shared/env.ts'
import { clientIp, handle, HttpError, json, rateLimit, readJson } from '../_shared/http.ts'
import { logEvent } from '../_shared/monitoring.ts'
import { formOrQuery, reconcilePayment, recordVerifiedPayment } from '../_shared/payment-flow.ts'
import {
  type Gateway, GATEWAYS, gatewayFromCredentials, gatewaySecret, loadPaymentProvider, type PaymentSettings,
} from '../_shared/payments/registry.ts'
import { initiatePaymentSchema, manualPaymentSchema, parse } from '../_shared/schemas.ts'
import { adminClient, getSettings, requireStaff, rpc } from '../_shared/supabase.ts'

function storefrontUrl(path: string): string {
  const base = (env('STOREFRONT_URL') ?? 'http://localhost:5173').replace(/\/$/, '')
  return `${base}${path}`
}

const credential = (max = 200) => z.string().trim().min(1).max(max)

const staffSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('connect_gateway'),
    provider: z.enum(GATEWAYS),
    sandbox: z.boolean().optional(),
    credentials: z.object({
      app_key: credential().optional(),
      app_secret: credential().optional(),
      username: credential().optional(),
      password: credential().optional(),
      merchant_id: credential(80).optional(),
      token: credential().optional(),
      base_url: z.union([z.url({ protocol: /^https?$/ }), z.literal('')]).optional(),
    }),
  }),
  z.object({ action: z.literal('test_gateway'), provider: z.enum(GATEWAYS) }),
  z.object({ action: z.literal('disconnect_gateway'), provider: z.enum(GATEWAYS) }),
  z.object({ action: z.literal('check_payment'), payment_id: z.uuid() }),
])

const REQUIRED: Record<Gateway, string[]> = {
  bkash: ['app_key', 'app_secret', 'username', 'password'],
  paystation: ['merchant_id', 'password'],
}

Deno.serve(
  handle(async (req) => {
    const url = new URL(req.url)
    const admin = adminClient()
    const callback = url.searchParams.get('callback')

    if (callback) {
      const providerCode = url.searchParams.get('provider') ?? ''
      const params = await formOrQuery(req)
      // Which of our payments this return is about.
      const session = providerCode === 'bkash' ? params.paymentID : providerCode === 'paystation' ? params.invoice_number : params.tran_id
      const found = session
        ? await rpc<{ id: string | null; reference: string; order_id: string } | null>(admin, 'find_gateway_payment', { p_provider: providerCode, p_session: session })
            .catch(() => null)
        : null
      if (found?.reference) params.reference = found.reference
      let orderNumber: string | null = null
      if (found?.order_id) {
        const { data } = await admin.from('orders').select('order_number').eq('id', found.order_id).maybeSingle()
        orderNumber = data?.order_number ?? null
      }
      let outcome = callback === 'success' ? 'pending' : callback
      try {
        const settings = await getSettings<PaymentSettings>(admin, 'payments')
        const provider = await loadPaymentProvider(admin, providerCode, settings, { allowDisabled: true })
        if (provider.verifyCallback) {
          const verified = await provider.verifyCallback(params)
          const result = await recordVerifiedPayment(admin, providerCode, verified)
          orderNumber = result.orderNumber ?? orderNumber
          outcome = ['succeeded', 'already_succeeded'].includes(result.status) ? 'success'
            : result.status === 'amount_mismatch' ? 'review'
            : verified.eventType.includes('cancel') ? 'cancelled' : 'failed'
          if (result.status === 'amount_mismatch' || result.status === 'unknown_payment') {
            void logEvent({ level: 'WARN', category: 'PAYMENT', source: 'payments', message: `${providerCode} payment ${result.status.replace('_', ' ')}`,
              context: { reference: verified.reference, order_number: orderNumber } })
          }
        }
      } catch (error) {
        // Not confirmed yet: the order page keeps polling and the reconcile job checks again.
        void logEvent({ level: 'WARN', category: 'PAYMENT', source: 'payments', message: `Could not verify a ${providerCode || 'gateway'} return`, error,
          context: { order_number: orderNumber } })
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
      const settings = await getSettings<PaymentSettings>(admin, 'payments')
      const provider = await loadPaymentProvider(admin, input.provider, settings)

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
          p_channel: input.provider === 'bkash' ? 'BKASH' : 'GATEWAY',
        },
      )
      const { data: order, error } = await admin
        .from('orders')
        .select('order_number, customer_name, customer_phone, customer_email, shipping_address, shipping_district')
        .eq('id', payment.order_id)
        .single()
      if (error || !order) throw new HttpError(404, 'Order not found', 'NOT_FOUND')

      const functionsBase = `${requireEnv('SUPABASE_URL')}/functions/v1`
      let result
      try {
        result = await provider.initiate({
          payment: { ...payment, amount: Number(payment.amount) },
          order,
          urls: {
            success: `${functionsBase}/payments?callback=success&provider=${provider.code}`,
            fail: `${functionsBase}/payments?callback=failed&provider=${provider.code}`,
            cancel: `${functionsBase}/payments?callback=cancelled&provider=${provider.code}`,
            ipn: `${functionsBase}/payment-webhook?provider=${provider.code}`,
          },
        })
      } catch (error) {
        void logEvent({ level: 'ERROR', category: 'PAYMENT', source: 'payments', message: `${provider.code} could not start a payment`, error,
          context: { order_number: order.order_number, amount: payment.amount } })
        throw new HttpError(502, 'The payment page could not be opened. Please try again, or pay by Send Money.', 'GATEWAY_ERROR')
      }
      await rpc(admin, 'attach_gateway_session', {
        p_payment_id: payment.id,
        p_redirect_url: result.redirectUrl ?? null,
        p_session: result.session ?? null,
        p_metadata: result.providerData ?? {},
      })
      return json(req, {
        payment: { reference: payment.reference, amount: Number(payment.amount), currency: payment.currency },
        type: result.type,
        redirectUrl: result.redirectUrl,
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

    // ------------------------------------------------------------- staff
    const input = parse(staffSchema, body)
    const settings = await getSettings<PaymentSettings>(admin, 'payments')

    if (input.action === 'check_payment') {
      await requireStaff(req, 'payments.verify')
      const { data: payment } = await admin.from('payments')
        .select('id, provider, reference, status, metadata, created_at').eq('id', input.payment_id).maybeSingle()
      if (!payment) throw new HttpError(404, 'Payment not found', 'NOT_FOUND')
      if (!['bkash', 'paystation'].includes(payment.provider)) throw new HttpError(422, 'Only bKash and PayStation payments can be checked', 'UNSUPPORTED')
      if (payment.status === 'SUCCEEDED') return json(req, { status: 'already_succeeded' })
      const provider = await loadPaymentProvider(admin, payment.provider, settings, { allowDisabled: true })
      try {
        const result = await reconcilePayment(admin, provider, {
          id: payment.id, provider: payment.provider, reference: payment.reference,
          sessions: ((payment.metadata as { sessions?: string[] } | null)?.sessions ?? []),
          age_minutes: Math.round((Date.now() - new Date(payment.created_at).getTime()) / 60_000),
        })
        return json(req, { status: result.status })
      } catch (error) {
        throw new HttpError(502, `Could not reach ${payment.provider === 'bkash' ? 'bKash' : 'PayStation'}: ${(error as Error).message}`, 'GATEWAY_ERROR')
      }
    }

    const staff = await requireStaff(req, 'settings.manage')
    const code = input.provider

    if (input.action === 'connect_gateway') {
      const creds = Object.fromEntries(Object.entries(input.credentials).filter(([, v]) => v)) as Record<string, string>
      const missing = REQUIRED[code].filter((k) => !creds[k])
      if (missing.length) throw new HttpError(422, `Enter ${missing.join(', ').replace(/_/g, ' ')}`, 'VALIDATION')
      // Credentials travel to this address: never in clear text (a local mock can opt out).
      if (creds.base_url && !creds.base_url.startsWith('https://') && env('ALLOW_INSECURE_GATEWAY_URL') !== 'true') {
        throw new HttpError(422, 'The API address must start with https://', 'VALIDATION')
      }
      const provider = gatewayFromCredentials(code, { ...settings.providers?.[code], sandbox: input.sandbox }, creds, admin)
      let message: string
      try {
        message = await provider.test!()
      } catch (error) {
        throw new HttpError(422, (error as Error).message, 'GATEWAY_REJECTED')
      }
      const hint = code === 'bkash' ? `App key ••••${creds.app_key.slice(-4)}` : `Merchant ${creds.merchant_id}`
      await rpc(admin, 'integration_secret_store', { p_key: gatewaySecret(code), p_value: creds, p_hint: hint, p_actor: staff.user.id })
      const config = await rpc(admin, 'payment_set_provider', { p_code: code, p_enabled: true, p_sandbox: code === 'bkash' ? input.sandbox ?? true : null })
      return json(req, { ok: true, message, hint, config })
    }

    if (input.action === 'test_gateway') {
      const provider = await loadPaymentProvider(admin, code, settings, { allowDisabled: true })
      try {
        return json(req, { ok: true, message: await provider.test!() })
      } catch (error) {
        throw new HttpError(422, (error as Error).message, 'GATEWAY_REJECTED')
      }
    }

    await rpc(admin, 'integration_secret_clear', { p_key: gatewaySecret(code), p_actor: staff.user.id })
    const config = await rpc(admin, 'payment_set_provider', { p_code: code, p_enabled: false, p_sandbox: null })
    return json(req, { ok: true, config })
  }),
)
