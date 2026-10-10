// The storefront checkout, shared by the hosted store (checkout function) and
// custom-coded websites (site-api function with an API key):
//   quoteCart  — prices the cart server-side and, once a valid phone number is
//                entered, runs the fraud / delivery-success check to say whether
//                cash on delivery is available or an advance is needed (never
//                revealing scores or rates).
//   placeOrder — creates the order atomically with the risk decision and stock
//                reservation (or adds it to the customer's order from a minute
//                ago). Prices, discounts and delivery come from the database.
import type { SupabaseClient } from '@supabase/supabase-js'
import { FraudDetectionService, type FraudSettings, loadFraudProviders } from './fraud/service.ts'
import { HttpError } from './http.ts'
import { logEvent } from './monitoring.ts'
import type { placeOrderSchema, quoteSchema } from './schemas.ts'
import { getSettings, rpc } from './supabase.ts'
import type { z } from 'zod'

type QuoteInput = z.infer<typeof quoteSchema>
type PlaceInput = z.infer<typeof placeOrderSchema>
export interface PlaceContext { ip: string; userAgent?: string | null; userId?: string | null; siteKeyId?: string | null }

interface FraudCheckRow {
  id: string | null
}

export async function fraudCheckFor(admin: SupabaseClient, phone: string, context: Record<string, unknown>): Promise<string | null> {
  const settings = await getSettings<FraudSettings>(admin, 'fraud')
  if (settings.enabled === false) return null
  const cached = await rpc<FraudCheckRow | null>(admin, 'recent_fraud_check', { p_phone: phone })
  if (cached?.id) return cached.id
  const payload = await new FraudDetectionService(await loadFraudProviders(admin, settings)).check(
    { phone, district: context.district as string | undefined, orderValue: context.order_value as number | undefined },
    { context },
  )
  if (payload.status !== 'SUCCESS') {
    void logEvent({
      level: 'WARN', category: 'FRAUD', source: 'checkout',
      message: `Courier history lookup ${payload.status === 'ERROR' ? 'failed' : 'partly failed'}: ${payload.error ?? 'no detail'}`,
      context: { providers: payload.providers },
    })
  }
  const check = await rpc<FraudCheckRow>(admin, 'record_fraud_check', { p_input: payload })
  return check.id
}

export async function quoteCart(admin: SupabaseClient, input: QuoteInput) {
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
      void logEvent({ level: 'ERROR', category: 'FRAUD', source: 'checkout', message: 'Fraud check failed during quote', error })
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
  // Keep what the customer typed so staff can follow up if they don't order.
  if (input.phone && input.attribution?.visitor_id) {
    await rpc(admin, 'capture_checkout_lead', {
      p_input: {
        visitor_id: input.attribution.visitor_id,
        phone: input.phone,
        customer_name: input.lead?.customer_name ?? null,
        address: input.lead?.address ?? null,
        district: input.district ?? null,
        area: input.area ?? null,
        items: (quote.lines as Array<Record<string, unknown>> | undefined)?.map((l) => ({
          variant_id: l.variant_id, quantity: l.quantity, name: l.product_name, variant: l.variant_title, price: l.unit_price,
        })) ?? input.items,
        subtotal: quote.subtotal,
        total: quote.total,
        attribution: input.attribution,
      },
    }).catch((error) => logEvent({ level: 'WARN', category: 'FUNCTION', source: 'checkout', message: 'Could not save the incomplete checkout', error }))
  }
  return { quote, payment_requirement: input.phone ? requirement : null }
}

export async function placeOrder(admin: SupabaseClient, input: PlaceInput, ctx: PlaceContext) {
  // Block list: phone and address are also checked by the database; the IP only here.
  const blocked = await rpc<Record<string, unknown> | null>(admin, 'order_block_match', {
    p_phone: input.customer.phone, p_ip: ctx.ip === 'unknown' ? null : ctx.ip, p_address: input.shipping.address,
  })
  if (blocked) {
    const settings = await getSettings<{ messages?: { blocked?: string } }>(admin, 'fraud')
    void logEvent({ level: 'INFO', category: 'FRAUD', source: 'checkout', message: `Blocked order attempt (${blocked.kind})`, context: { block_id: blocked.id } })
    throw new HttpError(403, settings.messages?.blocked ?? 'We are unable to accept this order online. Please contact us to complete your purchase.', 'ORDER_BLOCKED')
  }
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
    void logEvent({ level: 'ERROR', category: 'FRAUD', source: 'checkout', message: 'Fraud check failed while placing an order', error })
    return null
  })

  const payload = {
    customer: { ...input.customer, email: input.customer.email || null },
    shipping: input.shipping,
    items: input.items,
    delivery_method: input.delivery_method,
    payment_method: input.payment_method,
    coupon_code: input.coupon_code || null,
    customer_note: input.customer_note ?? null,
    idempotency_key: input.idempotency_key,
    utm: input.utm ?? (input.attribution?.last_touch?.params ? {
      source: input.attribution.last_touch.params.utm_source ?? null,
      medium: input.attribution.last_touch.params.utm_medium ?? null,
      campaign: input.attribution.last_touch.params.utm_campaign ?? null,
    } : null),
    auth_user_id: ctx.userId ?? null,
  }
  // A website's API key goes through the same checkout, tagged with the site.
  const order = ctx.siteKeyId
    ? await rpc<Record<string, unknown>>(admin, 'site_api_place_order', { p_key_id: ctx.siteKeyId, p_payload: payload, p_fraud_check_id: checkId })
    : await rpc<Record<string, unknown>>(admin, 'place_storefront_order', { p_payload: payload, p_fraud_check_id: checkId })
  await rpc(admin, 'record_order_client', { p_order_id: order.id, p_ip: ctx.ip, p_user_agent: ctx.userAgent ?? null })
    .catch((error) => logEvent({ level: 'WARN', category: 'FUNCTION', source: 'checkout', message: 'Could not save the order IP', error }))
  // Where the sale came from (kept with the original order when merged).
  if (!order.merged) {
    await rpc(admin, 'record_order_attribution', { p_order_id: order.id, p_attribution: input.attribution ?? {} })
      .catch((error) => logEvent({ level: 'ERROR', category: 'FUNCTION', source: 'checkout', message: 'Could not record the order source', error, context: { order_number: order.order_number } }))
  }
  if (input.attribution?.visitor_id || input.customer.phone) {
    await rpc(admin, 'convert_checkout_lead', {
      p_visitor_id: input.attribution?.visitor_id ?? '', p_phone: input.customer.phone, p_order_id: order.id,
    }).catch((error) => logEvent({ level: 'WARN', category: 'FUNCTION', source: 'checkout', message: 'Could not close the incomplete checkout', error }))
  }
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
      }).catch((e) => logEvent({ level: 'ERROR', category: 'PAYMENT', source: 'checkout', message: 'Could not save the payment note', error: e }))
      void logEvent({ level: 'WARN', category: 'PAYMENT', source: 'checkout', message: `Advance payment at checkout not recorded: ${paymentError}`, context: { order_number: order.order_number } })
    }
  }
  return {
    order: payment ? { ...order, pending_payment_verification: true } : order,
    payment: payment ? { status: payment.status, amount: payment.amount } : null,
    payment_error: paymentError,
  }
}
