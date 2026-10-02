// Staff courier operations through the CourierService abstraction:
//   create_shipment, cancel_shipment, sync_status, sync_all, tracking,
//   delivery_cost, test_connection
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { env } from '../_shared/env.ts'
import { courierProvider, type CourierRow } from '../_shared/courier/registry.ts'
import { CourierNotSupportedError } from '../_shared/courier/types.ts'
import { handle, HttpError, json, readJson } from '../_shared/http.ts'
import { parse } from '../_shared/schemas.ts'
import { adminClient, requireStaff, rpc } from '../_shared/supabase.ts'

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create_shipment'), order_id: z.uuid(), courier_id: z.uuid(), note: z.string().max(300).optional() }),
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
])

const COURIER_COLUMNS = 'id, name, provider, api_enabled, tracking_url_template'
const SYNCABLE = ['BOOKED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'ON_HOLD', 'RETURNING']

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
  const provider = courierProvider(shipment.courier)
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
    const client = isCron && input.action === 'sync_all'
      ? adminClient()
      : (await requireStaff(req, input.action === 'test_connection' ? 'couriers.manage' : 'shipments.manage')).client

    try {
      switch (input.action) {
        case 'create_shipment': {
          const { data: order, error } = await client
            .from('orders')
            .select('id, order_number, status, customer_name, customer_phone, shipping_address, shipping_area, shipping_district, cod_amount, order_items(quantity)')
            .eq('id', input.order_id)
            .maybeSingle()
          if (error || !order) throw new HttpError(404, 'Order not found', 'NOT_FOUND')
          if (!['PACKING', 'READY_TO_SHIP', 'PROCESSING', 'CONFIRMED'].includes(order.status)) {
            throw new HttpError(409, `A ${order.status} order cannot be booked with a courier`, 'INVALID_STATE')
          }
          const { data: courier } = await client.from('couriers').select(COURIER_COLUMNS).eq('id', input.courier_id).maybeSingle()
          if (!courier) throw new HttpError(404, 'Courier not found', 'NOT_FOUND')
          const provider = courierProvider(courier as CourierRow)
          const created = await provider.createShipment({
            orderNumber: order.order_number,
            recipientName: order.customer_name,
            recipientPhone: order.customer_phone,
            recipientAddress: order.shipping_address,
            district: order.shipping_district,
            area: order.shipping_area,
            codAmount: Number(order.cod_amount),
            itemCount: (order.order_items as Array<{ quantity: number }>).reduce((s, i) => s + i.quantity, 0),
            note: input.note ?? null,
          })
          const shipment = await rpc(client, 'assign_courier', {
            p_order_id: order.id,
            p_courier_id: input.courier_id,
            p_tracking_number: created.trackingNumber,
            p_shipping_cost: created.cost ?? null,
            p_note: input.note ?? null,
            p_consignment_id: created.consignmentId,
            p_provider_payload: created.raw as Record<string, unknown>,
          })
          return json(req, { shipment })
        }
        case 'cancel_shipment': {
          const shipment = await loadShipment(client, input.shipment_id)
          await courierProvider(shipment.courier).cancelShipment({
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
          const tracking = await courierProvider(shipment.courier).getTracking({
            consignmentId: shipment.consignment_id,
            trackingNumber: shipment.tracking_number,
            orderNumber: shipment.orderNumber,
          })
          return json(req, { tracking })
        }
        case 'delivery_cost': {
          const { data: courier } = await client.from('couriers').select(COURIER_COLUMNS).eq('id', input.courier_id).maybeSingle()
          if (!courier) throw new HttpError(404, 'Courier not found', 'NOT_FOUND')
          const cost = await courierProvider(courier as CourierRow).getDeliveryCost({
            district: input.district, area: input.area, weightGrams: input.weight_grams, codAmount: input.cod_amount ?? 0,
          })
          if (cost !== null) return json(req, { cost, source: 'courier' })
          const zone = await rpc<{ charge: number } | null>(adminClient(), 'resolve_delivery_zone', {
            p_district: input.district, p_area: input.area ?? null,
          })
          return json(req, { cost: zone?.charge ?? null, source: 'zone' })
        }
        case 'test_connection': {
          const { data: courier } = await client.from('couriers').select(COURIER_COLUMNS).eq('id', input.courier_id).maybeSingle()
          if (!courier) throw new HttpError(404, 'Courier not found', 'NOT_FOUND')
          let result: { ok: boolean; message: string }
          try {
            result = await courierProvider({ ...(courier as CourierRow), api_enabled: true }).testConnection()
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
