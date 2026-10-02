// Storefront checkout (public). Two actions:
//   quote — prices the cart server-side and, once a phone number is known,
//           runs the fraud check to tell the customer whether an advance is
//           needed (never revealing scores).
//   place — creates the order atomically with the risk decision and stock
//           reservation. Prices, discounts and delivery come from the database.
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
      if (input.phone && input.district) {
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
      return json(req, { quote, payment_requirement: input.phone && input.district ? requirement : null })
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
      dispatchNotificationsInBackground()
      return json(req, { order }, 201)
    }

    throw new HttpError(400, 'Unknown action', 'UNKNOWN_ACTION')
  }),
)
