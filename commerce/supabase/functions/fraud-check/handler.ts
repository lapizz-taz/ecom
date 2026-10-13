// Staff fraud tools:
//   check                   — run a fresh check for an order or phone (fraud.review),
//                             optionally applying the decision
//   lookup_courier_history  — look up one number on BD Courier (fraud.review); counted
//                             against the merchant's allowance like any lookup
//   courier_history_status  — whether the platform's BD Courier connection is available
//                             and this business uses it (settings.view)
// BD Courier runs on the platform's account (Super Admin → BD Courier Integration);
// merchants never enter or see an API key.
import { z } from 'zod'
import { COURIER_HISTORY_SERVICES, CourierHistoryProvider, type CourierHistorySummary } from '../_shared/fraud/courier-history.ts'
import {
  COURIER_PANEL_LABELS, COURIER_PANEL_LOGIN_FIELD, COURIER_PANEL_PROVIDERS, type CourierPanelCreds, CourierPanelProvider, panelAccounts,
} from '../_shared/fraud/courier-panel.ts'
import {
  checkProviderNames, courierHistoryConfig, databaseMeter, FraudDetectionService, type FraudSettings, loadFraudProviders,
  platformCourierHistorySecret, platformPanelCreds,
} from '../_shared/fraud/service.ts'
import { handle, HttpError, json, readJson } from '../_shared/http.ts'
import { parse, phoneSchema } from '../_shared/schemas.ts'
import { getSettings, requireStaff, rpc } from '../_shared/supabase.ts'
import type { SupabaseClient } from '@supabase/supabase-js'

const schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('check'),
    order_id: z.uuid().optional(),
    phone: phoneSchema.optional(),
    apply: z.boolean().default(false),
  }).refine((v) => v.order_id || v.phone, 'order_id or phone is required'),
  z.object({ action: z.literal('lookup_courier_history'), phone: phoneSchema }),
  z.object({ action: z.literal('courier_history_status') }),
  z.object({ action: z.literal('lookup_courier_panel'), phone: phoneSchema }),
  z.object({ action: z.literal('courier_panel_status') }),
])

const PERMISSION: Record<string, string> = {
  check: 'fraud.review',
  lookup_courier_history: 'fraud.review',
  courier_history_status: 'settings.view',
  lookup_courier_panel: 'fraud.review',
  courier_panel_status: 'settings.view',
}

const REVIEWABLE = ['PENDING', 'FRAUD_CHECK', 'FRAUD_REVIEW', 'ADVANCE_REQUIRED', 'CONFIRMATION_REQUIRED']

/** One metered lookup through the platform's BD Courier account. */
async function lookup(admin: SupabaseClient, phone: string, settings: FraudSettings): Promise<CourierHistorySummary> {
  const config = courierHistoryConfig(await platformCourierHistorySecret(admin), Math.max(settings.courier_history?.timeout_ms ?? 0, 10_000))
  if (!config) throw new HttpError(503, 'BD Courier checks are not available on the platform right now', 'NOT_CONNECTED')
  const meter = databaseMeter(admin)
  const gate = await meter.begin(phone)
  if (!gate.allowed || !gate.usageId) {
    throw new HttpError(gate.reason === 'FEATURE_OFF' ? 403 : 402, gate.message ?? 'This lookup is not allowed right now', gate.reason ?? 'NOT_ALLOWED')
  }
  try {
    const result = await new CourierHistoryProvider(config).lookup(phone)
    await meter.finish(gate.usageId, true)
    return result
  } catch (error) {
    await meter.finish(gate.usageId, false, (error as Error).message).catch(() => undefined)
    throw new HttpError(422, `Could not check the number: ${(error as Error).message}`, 'LOOKUP_FAILED')
  }
}

/** One metered lookup through the platform's courier merchant-panel accounts. */
async function panelLookup(admin: SupabaseClient, phone: string): Promise<CourierHistorySummary> {
  const provider = new CourierPanelProvider((await platformPanelCreds(admin) as CourierPanelCreds | null) ?? {})
  if (!provider.connected.length) throw new HttpError(503, 'Courier sign-in accounts are not connected on the platform', 'NOT_CONNECTED')
  const meter = databaseMeter(admin)
  const gate = await meter.begin(phone)
  if (!gate.allowed || !gate.usageId) {
    throw new HttpError(gate.reason === 'FEATURE_OFF' ? 403 : 402, gate.message ?? 'This lookup is not allowed right now', gate.reason ?? 'NOT_ALLOWED')
  }
  try {
    const result = await provider.lookup(phone)
    await meter.finish(gate.usageId, true)
    return result
  } catch (error) {
    await meter.finish(gate.usageId, false, (error as Error).message).catch(() => undefined)
    throw new HttpError(422, `Could not check the number: ${(error as Error).message}`, 'LOOKUP_FAILED')
  }
}

export default (
  handle(async (req) => {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
    const body = await readJson<Record<string, unknown>>(req)
    const input = parse(schema, { action: 'check', ...body })
    const staff = await requireStaff(req, PERMISSION[input.action], { supportView: input.action === 'courier_history_status' || input.action === 'courier_panel_status' })
    const admin = staff.admin
    const settings = await getSettings<FraudSettings>(admin, 'fraud')

    if (input.action === 'courier_history_status') {
      const config = courierHistoryConfig(await platformCourierHistorySecret(admin))
      return json(req, {
        provided_by_platform: true,
        connected: !!config,
        service: config ? COURIER_HISTORY_SERVICES[config.service ?? 'bdcourier'].label : null,
        enabled: checkProviderNames(settings).includes('courier_history') || checkProviderNames(settings).includes('courier_panel'),
      })
    }

    if (input.action === 'lookup_courier_history') {
      return json(req, { ok: true, result: await lookup(admin, input.phone, settings) })
    }

    // ---- the platform's courier merchant-panel logins (Super Admin, metered like BD Courier) ----
    if (input.action === 'courier_panel_status') {
      const creds = (await platformPanelCreds(admin) as CourierPanelCreds | null) ?? {}
      const providers = COURIER_PANEL_PROVIDERS.map((p) => {
        const accounts = panelAccounts(creds, p).length
        return { provider: p, label: COURIER_PANEL_LABELS[p], login_field: COURIER_PANEL_LOGIN_FIELD[p], connected: accounts > 0, accounts }
      })
      return json(req, {
        provided_by_platform: true,
        connected: providers.some((p) => p.connected),
        providers,
        enabled: checkProviderNames(settings).includes('courier_history') || checkProviderNames(settings).includes('courier_panel'),
      })
    }

    if (input.action === 'lookup_courier_panel') {
      return json(req, { ok: true, result: await panelLookup(admin, input.phone) })
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
  })
)
