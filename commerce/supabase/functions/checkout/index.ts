// Storefront checkout (public). Two actions:
//   quote — prices the cart server-side and, as soon as a valid phone number
//           is entered, runs the fraud / delivery-success check to tell the
//           customer whether cash on delivery is available or an advance is
//           needed (never revealing scores or rates).
//   place — creates the order atomically with the risk decision and stock
//           reservation (or adds it to the customer's order from a minute ago).
//           Prices, discounts and delivery come from the database. A bKash /
//           Nagad advance sent at checkout is recorded for staff verification.
import type { SupabaseClient } from '@supabase/supabase-js'
import { FraudDetectionService, type FraudSettings, providersFromSettings } from '../_shared/fraud/service.ts'
import { clientIp, handle, HttpError, json, rateLimit, readJson } from '../_shared/http.ts'
import { parse, placeOrderSchema, quoteSchema } from '../_shared/schemas.ts'
import { adminClient, getSettings, optionalUser, rpc } from '../_shared/supabase.ts'
import { dispatchNotificationsInBackground } from '../_shared/dispatch.ts'

interface FraudCheckRow {
  id: string | null
}

async function fraudCheckFor(admin: SupabaseClient, phone: string, context: Record<string, unknown>): Promise<string | null> {
  const settings = await getSettings<FraudSettings>(admin, 'fraud')
  if (settings.enabled === false) return null
  const cached = await rpc<FraudCheckRow | null>(admin, 'recent_fraud_check', { p_phone: phone })
  if (cached?.id) return cached.id
  const payload = await new FraudDetectionService(providersFromSettings(settings)).check(
    { phone, district: context.district as string | undefined, orderValue: context.order_value as number | undefined },
    { context },
  )
  const check = await rpc<FraudCheckRow>(admin, 'record_fraud_check', { p_input: payload })
  return check.id
}

Deno.serve(
  handle(async (req) => {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
    const body = await readJson<{ action?: string }>(req)
    const ip = clientIp(req)
    const admin = adminClient()

    if (body.action === 'quote') {
      rateLimit(`quote:${ip}`, 60)
      const input = parse(quoteSchema, body)
      const quote = await rpc<Record<string, unknown>>(admin, 'storefront_quote', {
        p_items: input.items,
        p_district: input.district ?? null,
        p_area: input.area ?? null,
        p_delivery_method: input.delivery_method,
        p_coupon_code: input.coupon_code || null,
        p_phone: input.phone || null,
      })
      let checkId: string | null = null
      if (input.phone) {
        try {
          checkId = await fraudCheckFor(admin, input.phone, {
            order_value: quote.total,
            subtotal: quote.subtotal,
            delivery_charge: quote.delivery_charge,
            return_charge: quote.return_charge,
            district: input.district,
            area: input.area,
            payment_method: input.payment_method,
          })
        } catch (error) {
          // A risk check that cannot run must not block the price preview.
          console.error('Fraud check failed during quote', error)
        }
      }
      const requirement = await rpc(admin, 'checkout_risk_preview', {
        p_fraud_check_id: checkId,
        p_context: {
          order_value: quote.total,
          subtotal: quote.subtotal,
          delivery_charge: quote.delivery_charge,
          return_charge: quote.return_charge,
          district: input.district,
          area: input.area,
          payment_method: input.payment_method,
        },
        p_payment_method: input.payment_method,
      })
      return json(req, { quote, payment_requirement: input.phone ? requirement : null })
    }

    if (body.action === 'place') {
      rateLimit(`place:${ip}`, 8)
      const input = parse(placeOrderSchema, body)
      const user = await optionalUser(req)
      const preview = await rpc<Record<string, unknown>>(admin, 'storefront_quote', {
        p_items: input.items,
        p_district: input.shipping.district,
        p_area: input.shipping.area ?? null,
        p_delivery_method: input.delivery_method,
        p_coupon_code: input.coupon_code || null,
        p_phone: input.customer.phone,
      })
      const checkId = await fraudCheckFor(admin, input.customer.phone, {
        order_value: preview.total,
        delivery_charge: preview.delivery_charge,
        return_charge: preview.return_charge,
        district: input.shipping.district,
        payment_method: input.payment_method,
      }).catch((error) => {
        console.error('Fraud check failed during checkout', error)
        return null
      })

      const order = await rpc<Record<string, unknown>>(admin, 'place_storefront_order', {
        p_payload: {
          customer: { ...input.customer, email: input.customer.email || null },
          shipping: input.shipping,
          items: input.items,
          delivery_method: input.delivery_method,
          payment_method: input.payment_method,
          coupon_code: input.coupon_code || null,
          customer_note: input.customer_note ?? null,
          idempotency_key: input.idempotency_key,
          utm: input.utm ?? null,
          auth_user_id: user?.id ?? null,
        },
        p_fraud_check_id: checkId,
      })
      // Advance sent with bKash / Nagad at checkout: record it for verification.
      // It only counts once staff match it against the statement.
      let payment: Record<string, unknown> | null = null
      let paymentError: string | null = null
      const due = Number(order.amount_due_now ?? 0)
      if (input.advance_payment && due > 0 && !order.pending_payment_verification) {
        try {
          payment = await rpc<Record<string, unknown>>(admin, 'submit_manual_payment', {
            p_order_number: order.order_number,
            p_phone: input.customer.phone,
            p_channel: input.advance_payment.channel,
            p_sender_phone: input.advance_payment.sender_phone,
            p_transaction_id: input.advance_payment.transaction_id,
            p_amount: due,
          })
        } catch (error) {
          paymentError = error instanceof HttpError ? error.message : 'We could not record your payment details'
          // Keep what the customer sent so staff can still match it.
          await rpc(admin, 'add_order_note', {
            p_order_id: order.id,
            p_body: `Customer reported ${input.advance_payment.channel} advance at checkout — TrxID ${input.advance_payment.transaction_id} from ${input.advance_payment.sender_phone} (${due}). Not recorded automatically: ${paymentError}`,
            p_visibility: 'INTERNAL',
            p_kind: 'SYSTEM',
          }).catch((e) => console.error('Could not save payment note', e))
        }
      }
      dispatchNotificationsInBackground()
      return json(req, {
        order: payment ? { ...order, pending_payment_verification: true } : order,
        payment: payment ? { status: payment.status, amount: payment.amount } : null,
        payment_error: paymentError,
      }, 201)
    }

    throw new HttpError(400, 'Unknown action', 'UNKNOWN_ACTION')
  }),
)
