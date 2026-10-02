// Staff: run a fresh fraud check for an order or phone number and optionally
// apply the decision. Requires fraud.review; the database re-checks it.
import { z } from 'zod'
import { FraudDetectionService, type FraudSettings, providersFromSettings } from '../_shared/fraud/service.ts'
import { handle, HttpError, json, readJson } from '../_shared/http.ts'
import { parse, phoneSchema } from '../_shared/schemas.ts'
import { getSettings, requireStaff, rpc } from '../_shared/supabase.ts'

const schema = z.object({
  order_id: z.uuid().optional(),
  phone: phoneSchema.optional(),
  apply: z.boolean().default(false),
}).refine((v) => v.order_id || v.phone, 'order_id or phone is required')

const REVIEWABLE = ['PENDING', 'FRAUD_CHECK', 'FRAUD_REVIEW', 'ADVANCE_REQUIRED', 'CONFIRMATION_REQUIRED']

Deno.serve(
  handle(async (req) => {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
    const staff = await requireStaff(req, 'fraud.review')
    const input = parse(schema, await readJson(req))

    let phone = input.phone ?? ''
    let context: Record<string, unknown> = {}
    let status: string | null = null
    if (input.order_id) {
      const { data: order, error } = await staff.client
        .from('orders')
        .select('id, status, customer_phone, total_amount, subtotal, delivery_charge, return_charge, shipping_district, shipping_area, payment_method, source')
        .eq('id', input.order_id)
        .maybeSingle()
      if (error || !order) throw new HttpError(404, 'Order not found', 'NOT_FOUND')
      phone = order.customer_phone
      status = order.status
      context = {
        order_value: Number(order.total_amount),
        subtotal: Number(order.subtotal),
        delivery_charge: Number(order.delivery_charge),
        return_charge: Number(order.return_charge),
        district: order.shipping_district,
        area: order.shipping_area,
        payment_method: order.payment_method,
        source: order.source,
      }
    }

    const settings = await getSettings<FraudSettings>(staff.client, 'fraud')
    const payload = await new FraudDetectionService(providersFromSettings(settings)).check(
      { phone, district: context.district as string | undefined, orderValue: context.order_value as number | undefined },
      { orderId: input.order_id, context },
    )
    const check = await rpc<Record<string, unknown>>(staff.client, 'record_fraud_check', { p_input: payload })

    let order: unknown = null
    if (input.apply && input.order_id && status && REVIEWABLE.includes(status)) {
      order = await rpc(staff.client, 'apply_fraud_decision', { p_order_id: input.order_id, p_fraud_check_id: check.id })
    }
    return json(req, { check, order })
  }),
)
