// Staff fraud tools:
//   check                      — run a fresh check for an order or phone (fraud.review),
//                                optionally applying the decision
//   connect_courier_history    — test the courier-history API key with a real
//                                lookup, then save it in Vault (settings.manage)
//   test_courier_history       — look up a number with the saved key
//   disconnect_courier_history — remove the key and stop using the service
// Keys are only ever handled here, with the service role; they never go back
// to a browser.
import { z } from 'zod'
import { COURIER_HISTORY_SERVICES, CourierHistoryProvider, type CourierHistorySummary } from '../_shared/fraud/courier-history.ts'
import {
  COURIER_HISTORY_SECRET, courierHistoryConfig, type FraudSecrets, FraudDetectionService, type FraudSettings, loadFraudProviders,
} from '../_shared/fraud/service.ts'
import { handle, HttpError, json, readJson } from '../_shared/http.ts'
import { parse, phoneSchema } from '../_shared/schemas.ts'
import { adminClient, getSettings, requireStaff, rpc } from '../_shared/supabase.ts'

const schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('check'),
    order_id: z.uuid().optional(),
    phone: phoneSchema.optional(),
    apply: z.boolean().default(false),
  }).refine((v) => v.order_id || v.phone, 'order_id or phone is required'),
  z.object({
    action: z.literal('connect_courier_history'),
    service: z.enum(['bdcourier', 'llcg']).default('bdcourier'),
    api_key: z.string().trim().min(6, 'Enter the API key').max(200).regex(/^\S+$/, 'The API key has no spaces — copy it again'),
    base_url: z.union([z.url({ protocol: /^https$/, error: 'Use an https:// address' }), z.literal('')]).optional(),
    test_phone: phoneSchema,
  }),
  z.object({ action: z.literal('test_courier_history'), test_phone: phoneSchema }),
  z.object({ action: z.literal('courier_history_status') }),
  z.object({ action: z.literal('disconnect_courier_history') }),
])

const PERMISSION: Record<string, string> = {
  check: 'fraud.review',
  connect_courier_history: 'settings.manage',
  test_courier_history: 'settings.manage',
  courier_history_status: 'settings.view',
  disconnect_courier_history: 'settings.manage',
}

const REVIEWABLE = ['PENDING', 'FRAUD_CHECK', 'FRAUD_REVIEW', 'ADVANCE_REQUIRED', 'CONFIRMATION_REQUIRED']

async function lookup(secret: FraudSecrets['courierHistory'], phone: string, settings: FraudSettings): Promise<CourierHistorySummary> {
  const config = courierHistoryConfig(secret, Math.max(settings.courier_history?.timeout_ms ?? 0, 10_000))
  if (!config) throw new HttpError(422, 'Connect the courier history service first', 'NOT_CONNECTED')
  try {
    return await new CourierHistoryProvider(config).lookup(phone)
  } catch (error) {
    throw new HttpError(422, `Could not check the number: ${(error as Error).message}`, 'LOOKUP_FAILED')
  }
}

Deno.serve(
  handle(async (req) => {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
    const body = await readJson<Record<string, unknown>>(req)
    const input = parse(schema, { action: 'check', ...body })
    const staff = await requireStaff(req, PERMISSION[input.action])
    const admin = adminClient()
    const settings = await getSettings<FraudSettings>(admin, 'fraud')

    if (input.action === 'connect_courier_history') {
      const secret = { service: input.service, api_key: input.api_key, ...(input.base_url ? { base_url: input.base_url } : {}) }
      const result = await lookup(secret, input.test_phone, settings)
      const hint = `${COURIER_HISTORY_SERVICES[input.service].label} ••••${input.api_key.slice(-4)}`
      await rpc(admin, 'integration_secret_store', { p_key: COURIER_HISTORY_SECRET, p_value: secret, p_hint: hint, p_actor: staff.user.id })
      const providers = await rpc<string[]>(admin, 'fraud_set_provider', { p_provider: 'courier_history', p_enabled: true })
      return json(req, { ok: true, hint, providers, result })
    }

    if (input.action === 'courier_history_status') {
      // Which key the checks use: one saved here (Vault) or a function secret. Never the key itself.
      const { data, error } = await admin.rpc('integration_secret_get', { p_key: COURIER_HISTORY_SECRET })
      if (error) throw new HttpError(500, `Could not read the saved key: ${error.message}`, 'SECRET_READ_FAILED')
      const config = courierHistoryConfig(data as FraudSecrets['courierHistory'])
      return json(req, {
        source: !config ? null : (data as FraudSecrets['courierHistory'])?.api_key ? 'saved' : 'server_secret',
        service: config?.service ?? null,
        enabled: (settings.providers ?? []).includes('courier_history'),
      })
    }

    if (input.action === 'test_courier_history') {
      const { data, error } = await admin.rpc('integration_secret_get', { p_key: COURIER_HISTORY_SECRET })
      if (error) throw new HttpError(500, `Could not read the saved key: ${error.message}`, 'SECRET_READ_FAILED')
      return json(req, { ok: true, result: await lookup(data as FraudSecrets['courierHistory'], input.test_phone, settings) })
    }

    if (input.action === 'disconnect_courier_history') {
      await rpc(admin, 'integration_secret_clear', { p_key: COURIER_HISTORY_SECRET, p_actor: staff.user.id })
      const providers = await rpc<string[]>(admin, 'fraud_set_provider', { p_provider: 'courier_history', p_enabled: false })
      return json(req, { ok: true, providers })
    }

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

    const payload = await new FraudDetectionService(await loadFraudProviders(admin, settings)).check(
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
