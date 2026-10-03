// Staff courier operations through the CourierService abstraction:
//   connect, disconnect, test_connection, set_webhook_secret, create_shipment,
//   create_shipments, cancel_shipment, sync_status, sync_all, tracking, delivery_cost
// Credentials entered in "Connect courier" are tested against the courier,
// then stored in Vault by the service role; they never come back to a browser.
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { env } from '../_shared/env.ts'
import {
  buildCourierProvider, COURIER_FIELDS, COURIER_TRACKING, type CourierCredentials, courierProviderFor, type CourierRow,
  credentialHint, missingCredentialFields,
} from '../_shared/courier/registry.ts'
import { CourierNotSupportedError } from '../_shared/courier/types.ts'
import { handle, HttpError, json, readJson } from '../_shared/http.ts'
import { parse } from '../_shared/schemas.ts'
import { adminClient, requireStaff, rpc } from '../_shared/supabase.ts'

const credential = z.union([z.string().trim().max(500), z.boolean(), z.number()])

const schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('connect'),
    courier_id: z.uuid().optional(),
    provider: z.enum(['steadfast', 'pathao', 'redx']),
    name: z.string().trim().min(2).max(60).optional(),
    credentials: z.record(z.string().regex(/^[a-z_]+$/), credential),
  }),
  z.object({ action: z.literal('disconnect'), courier_id: z.uuid() }),
  z.object({ action: z.literal('create_shipment'), order_id: z.uuid(), courier_id: z.uuid(), note: z.string().max(300).optional() }),
  z.object({ action: z.literal('create_shipments'), order_ids: z.array(z.uuid()).min(1).max(50), courier_id: z.uuid() }),
  z.object({ action: z.literal('cancel_shipment'), shipment_id: z.uuid() }),
  z.object({ action: z.literal('sync_status'), shipment_id: z.uuid() }),
  z.object({ action: z.literal('sync_all'), courier_id: z.uuid().optional() }),
  z.object({ action: z.literal('tracking'), shipment_id: z.uuid() }),
  z.object({
    action: z.literal('delivery_cost'),
    courier_id: z.uuid(),
    district: z.string().min(2).max(60),
    area: z.string().max(80).optional(),
    weight_grams: z.number().int().positive().optional(),
    cod_amount: z.number().nonnegative().optional(),
  }),
  z.object({ action: z.literal('test_connection'), courier_id: z.uuid() }),
  z.object({ action: z.literal('set_webhook_secret'), courier_id: z.uuid(), secret: z.string().trim().min(16).max(200) }),
])

const COURIER_COLUMNS = 'id, name, provider, api_enabled, tracking_url_template'
const SYNCABLE = ['BOOKED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'ON_HOLD', 'RETURNING']
const BOOKABLE = ['CONFIRMED', 'PROCESSING', 'PACKING', 'READY_TO_SHIP']
const PERMISSION: Record<string, string> = {
  connect: 'couriers.manage', disconnect: 'couriers.manage', test_connection: 'couriers.manage', set_webhook_secret: 'couriers.manage',
}

async function loadCourier(client: SupabaseClient, id: string): Promise<CourierRow> {
  const { data } = await client.from('couriers').select(COURIER_COLUMNS).eq('id', id).maybeSingle()
  if (!data) throw new HttpError(404, 'Courier not found', 'NOT_FOUND')
  return data as CourierRow
}

async function loadShipment(client: SupabaseClient, id: string) {
  const { data, error } = await client
    .from('shipments')
    .select(`id, order_id, tracking_number, consignment_id, status, couriers(${COURIER_COLUMNS}), orders(order_number)`)
    .eq('id', id)
    .maybeSingle()
  if (error || !data) throw new HttpError(404, 'Shipment not found', 'NOT_FOUND')
  return {
    ...data,
    courier: data.couriers as unknown as CourierRow,
    orderNumber: (data.orders as unknown as { order_number: string }).order_number,
  }
}

async function syncOne(client: SupabaseClient, shipmentId: string) {
  const shipment = await loadShipment(client, shipmentId)
  const provider = await courierProviderFor(adminClient(), shipment.courier)
  const result = await provider.getShipmentStatus({
    consignmentId: shipment.consignment_id,
    trackingNumber: shipment.tracking_number,
    orderNumber: shipment.orderNumber,
  })
  if (result.status && result.status !== shipment.status) {
    await rpc(client, 'apply_shipment_status', {
      p_shipment_id: shipment.id,
      p_status: result.status,
      p_description: `Courier status: ${result.providerStatus}`,
      p_location: null,
      p_occurred_at: null,
      p_source: 'API',
      p_raw: result.raw,
      p_event_key: `${provider.code}:${shipment.consignment_id ?? shipment.tracking_number}:${result.providerStatus}`,
    })
  }
  return { shipment_id: shipment.id, provider_status: result.providerStatus, status: result.status ?? shipment.status }
}

/** Books one order with the courier's API and records the shipment. */
async function bookOrder(client: SupabaseClient, orderId: string, courier: CourierRow, note?: string | null) {
  const { data: order, error } = await client
    .from('orders')
    .select('id, order_number, status, customer_name, customer_phone, shipping_address, shipping_area, shipping_district, cod_amount, order_items(quantity), shipments(id, courier_id, tracking_number, is_active)')
    .eq('id', orderId)
    .maybeSingle()
  if (error || !order) throw new HttpError(404, 'Order not found', 'NOT_FOUND')
  if (!BOOKABLE.includes(order.status)) {
    throw new HttpError(409, `${order.order_number} is ${order.status.toLowerCase().replace(/_/g, ' ')} and cannot be booked`, 'INVALID_STATE')
  }
  const active = (order.shipments as Array<{ courier_id: string; tracking_number: string | null; is_active: boolean }>)
    .find((s) => s.is_active)
  if (active?.tracking_number) {
    throw new HttpError(409, `${order.order_number} is already booked (${active.tracking_number})`, 'ALREADY_BOOKED')
  }
  const provider = await courierProviderFor(adminClient(), courier)
  const created = await provider.createShipment({
    orderNumber: order.order_number,
    recipientName: order.customer_name,
    recipientPhone: order.customer_phone,
    recipientAddress: order.shipping_address,
    district: order.shipping_district,
    area: order.shipping_area,
    codAmount: Number(order.cod_amount),
    itemCount: (order.order_items as Array<{ quantity: number }>).reduce((s, i) => s + i.quantity, 0),
    note: note ?? null,
  })
  return rpc(client, 'assign_courier', {
    p_order_id: order.id,
    p_courier_id: courier.id,
    p_tracking_number: created.trackingNumber,
    p_shipping_cost: created.cost ?? null,
    p_note: note ?? null,
    p_consignment_id: created.consignmentId,
    p_provider_payload: created.raw as Record<string, unknown>,
  })
}

function notSupported(error: unknown): never {
  if (error instanceof CourierNotSupportedError) throw new HttpError(422, error.message, 'NOT_SUPPORTED')
  throw error
}

Deno.serve(
  handle(async (req) => {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
    const body = await readJson<{ action?: string }>(req)

    // pg_cron can trigger a periodic sync with the shared cron secret.
    const isCron = !!env('CRON_SECRET') && req.headers.get('x-cron-secret') === env('CRON_SECRET')
    const input = parse(schema, body)
    const staff = isCron && input.action === 'sync_all' ? null : await requireStaff(req, PERMISSION[input.action] ?? 'shipments.manage')
    const client = staff?.client ?? adminClient()

    try {
      switch (input.action) {
        case 'connect': {
          const missing = missingCredentialFields(input.provider, input.credentials as CourierCredentials)
          if (missing.length) throw new HttpError(422, `Fill in: ${missing.join(', ').replace(/_/g, ' ')}`, 'VALIDATION')
          // Only the known fields are kept (plus the sandbox switch).
          const creds: CourierCredentials = Object.fromEntries(
            [...COURIER_FIELDS[input.provider], 'sandbox'].filter((k) => k in input.credentials).map((k) => [k, input.credentials[k]]))
          const test = await buildCourierProvider(input.provider, creds).testConnection()
          if (!test.ok) throw new HttpError(422, `Could not connect: ${test.message}`, 'CONNECTION_FAILED')

          let courierId = input.courier_id
          if (!courierId) {
            const { data, error } = await client.from('couriers').insert({
              name: input.name ?? input.provider[0].toUpperCase() + input.provider.slice(1),
              provider: input.provider,
              tracking_url_template: COURIER_TRACKING[input.provider],
            }).select('id').single()
            if (error || !data) throw new HttpError(500, 'Could not create the courier', 'INTERNAL')
            courierId = data.id
          } else {
            await loadCourier(client, courierId)
          }
          await rpc(adminClient(), 'courier_credentials_store', {
            p_courier_id: courierId,
            p_provider: input.provider,
            p_credentials: creds,
            p_hint: credentialHint(input.provider, creds),
            p_actor: staff!.user.id,
          })
          return json(req, { courier_id: courierId, ok: true, message: test.message })
        }
        case 'disconnect': {
          await loadCourier(client, input.courier_id)
          await rpc(adminClient(), 'courier_credentials_clear', { p_courier_id: input.courier_id, p_actor: staff!.user.id })
          return json(req, { ok: true })
        }
        case 'create_shipment': {
          const courier = await loadCourier(client, input.courier_id)
          return json(req, { shipment: await bookOrder(client, input.order_id, courier, input.note) })
        }
        case 'create_shipments': {
          const courier = await loadCourier(client, input.courier_id)
          const results: Array<{ order_id: string; ok: boolean; tracking_number?: string | null; error?: string }> = []
          for (const orderId of input.order_ids) {
            try {
              const shipment = await bookOrder(client, orderId, courier) as { tracking_number: string | null }
              results.push({ order_id: orderId, ok: true, tracking_number: shipment.tracking_number })
            } catch (e) {
              results.push({ order_id: orderId, ok: false, error: e instanceof HttpError || e instanceof Error ? e.message : String(e) })
            }
          }
          return json(req, { booked: results.filter((r) => r.ok).length, results })
        }
        case 'cancel_shipment': {
          const shipment = await loadShipment(client, input.shipment_id)
          await (await courierProviderFor(adminClient(), shipment.courier)).cancelShipment({
            consignmentId: shipment.consignment_id,
            trackingNumber: shipment.tracking_number,
            orderNumber: shipment.orderNumber,
          })
          const updated = await rpc(client, 'apply_shipment_status', {
            p_shipment_id: shipment.id, p_status: 'CANCELLED', p_description: 'Cancelled with courier',
            p_location: null, p_occurred_at: null, p_source: 'API', p_raw: null, p_event_key: null,
          })
          return json(req, { shipment: updated })
        }
        case 'sync_status':
          return json(req, await syncOne(client, input.shipment_id))
        case 'sync_all': {
          let query = client
            .from('shipments')
            .select('id, couriers!inner(api_enabled)')
            .eq('is_active', true)
            .eq('couriers.api_enabled', true)
            .in('status', SYNCABLE)
            .limit(50)
          if (input.courier_id) query = query.eq('courier_id', input.courier_id)
          const { data, error } = await query
          if (error) throw new HttpError(500, 'Could not load shipments', 'INTERNAL')
          const results = []
          for (const row of data ?? []) {
            try {
              results.push(await syncOne(client, row.id))
            } catch (e) {
              results.push({ shipment_id: row.id, error: (e as Error).message })
            }
          }
          return json(req, { synced: results.length, results })
        }
        case 'tracking': {
          const shipment = await loadShipment(client, input.shipment_id)
          const tracking = await (await courierProviderFor(adminClient(), shipment.courier)).getTracking({
            consignmentId: shipment.consignment_id,
            trackingNumber: shipment.tracking_number,
            orderNumber: shipment.orderNumber,
          })
          return json(req, { tracking })
        }
        case 'delivery_cost': {
          const courier = await loadCourier(client, input.courier_id)
          const cost = await (await courierProviderFor(adminClient(), courier)).getDeliveryCost({
            district: input.district, area: input.area, weightGrams: input.weight_grams, codAmount: input.cod_amount ?? 0,
          })
          if (cost !== null) return json(req, { cost, source: 'courier' })
          const zone = await rpc<{ charge: number } | null>(adminClient(), 'resolve_delivery_zone', {
            p_district: input.district, p_area: input.area ?? null,
          })
          return json(req, { cost: zone?.charge ?? null, source: 'zone' })
        }
        case 'set_webhook_secret': {
          await loadCourier(client, input.courier_id)
          await rpc(adminClient(), 'courier_webhook_secret_set', {
            p_courier_id: input.courier_id, p_secret: input.secret, p_actor: staff!.user.id,
          })
          return json(req, { ok: true, hint: `••••${input.secret.slice(-4)}` })
        }
        case 'test_connection': {
          const courier = await loadCourier(client, input.courier_id)
          let result: { ok: boolean; message: string }
          try {
            result = await (await courierProviderFor(adminClient(), { ...courier, api_enabled: true })).testConnection()
          } catch (e) {
            result = { ok: false, message: (e as Error).message }
          }
          await client.from('couriers').update({
            api_status: result.ok ? 'CONNECTED' : 'ERROR',
            api_checked_at: new Date().toISOString(),
          }).eq('id', input.courier_id)
          return json(req, result)
        }
      }
    } catch (error) {
      notSupported(error)
    }
  }),
)
