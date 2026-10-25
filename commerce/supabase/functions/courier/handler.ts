// Staff courier operations through the CourierService abstraction:
//   connect, save_options, courier_stores, disconnect, test_connection, set_webhook_secret, create_shipment,
//   create_shipments, cancel_shipment, sync_status, sync_all, tracking, delivery_cost,
//   force_check (a logged status check in batches, for the progress dialog)
// Credentials entered in "Connect courier" are tested against the courier,
// then stored in Vault by the service role; they never come back to a browser.
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import {
  buildCourierProvider, COURIER_FIELDS, COURIER_TRACKING, type CourierCredentials, courierProviderFor, type CourierRow,
  COURIER_OPTIONAL_FIELDS, type CourierOptions, courierOptions, credentialHint, invalidCredentialFields, itemDescription,
  missingCredentialFields,
} from '../_shared/courier/registry.ts'
import { withBookingClaim } from '../_shared/courier/booking.ts'
import { PathaoProvider, type PathaoStore, RedxProvider } from '../_shared/courier/providers.ts'
import { CourierNotSupportedError } from '../_shared/courier/types.ts'
import { isCronRequest } from '../_shared/cron.ts'
import { handle, HttpError, json, readJson } from '../_shared/http.ts'
import { parse } from '../_shared/schemas.ts'
import { adminClient, forEachMerchant, merchantOf, requireStaff, rpc } from '../_shared/supabase.ts'

const credential = z.union([z.string().trim().max(500), z.boolean(), z.number()])
const options = z.object({
  account_phone: z.string().trim().max(20).regex(/^[0-9+\- ]*$/, 'Use digits for the phone number').optional(),
  store_id: z.string().trim().regex(/^\d{0,12}$/, 'Store ID is a number').optional(),
  item_type: z.union([z.literal(1), z.literal(2)]).optional(),
  allow_without_zone: z.boolean().optional(),
  send_weight: z.boolean().optional(),
  default_note: z.string().trim().max(200).optional(),
  send_product_names: z.boolean().optional(),
}).strict()

const schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('connect'),
    courier_id: z.uuid().optional(),
    provider: z.enum(['steadfast', 'pathao', 'redx']),
    name: z.string().trim().min(2).max(60).optional(),
    credentials: z.record(z.string().regex(/^[a-z_]+$/), credential),
    options: options.optional(),
    is_active: z.boolean().optional(),
  }),
  z.object({ action: z.literal('save_options'), courier_id: z.uuid(), options, is_active: z.boolean().optional() }),
  // Pathao / RedX pickup stores, from the saved login (courier_id) or from keys being entered.
  z.object({
    action: z.literal('courier_stores'), courier_id: z.uuid().optional(), provider: z.enum(['pathao', 'redx']).default('pathao'),
    credentials: z.record(z.string().regex(/^[a-z_]+$/), credential).optional(),
  }),
  z.object({ action: z.literal('disconnect'), courier_id: z.uuid() }),
  z.object({
    action: z.literal('create_shipment'), order_id: z.uuid(), courier_id: z.uuid(), note: z.string().max(300).optional(),
    store_id: z.string().regex(/^\d{1,12}$/).optional(),
  }),
  z.object({ action: z.literal('create_shipments'), order_ids: z.array(z.uuid()).min(1).max(50), courier_id: z.uuid(), store_id: z.string().regex(/^\d{1,12}$/).optional() }),
  z.object({ action: z.literal('cancel_shipment'), shipment_id: z.uuid() }),
  z.object({ action: z.literal('sync_status'), shipment_id: z.uuid() }),
  z.object({ action: z.literal('sync_all'), courier_id: z.uuid().optional() }),
  z.object({
    action: z.literal('force_check'), courier_id: z.uuid().optional(), scope: z.enum(['all', 'shipped']).default('all'),
    run_id: z.uuid().optional(), after: z.uuid().optional(), batch: z.number().int().min(1).max(25).default(10),
  }),
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

const COURIER_COLUMNS = 'id, name, provider, api_enabled, tracking_url_template, config'
const SYNCABLE = ['BOOKED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'ON_HOLD', 'RETURNING']
const BOOKABLE = ['CONFIRMED', 'PROCESSING', 'PACKING', 'READY_TO_SHIP']
const PERMISSION: Record<string, string> = {
  connect: 'couriers.manage', disconnect: 'couriers.manage', test_connection: 'couriers.manage', set_webhook_secret: 'couriers.manage',
  save_options: 'couriers.manage', courier_stores: 'couriers.manage',
}

/** Merges booking options (and the store list) into couriers.config; keys never go there. */
async function saveOptions(client: SupabaseClient, courierId: string, patch: CourierOptions & { stores?: PathaoStore[]; stores_synced_at?: string }, isActive?: boolean) {
  const { data, error } = await client.from('couriers').select('config').eq('id', courierId).maybeSingle()
  if (error || !data) throw new HttpError(404, 'Courier not found', 'NOT_FOUND')
  const config = { ...((data.config as Record<string, unknown> | null) ?? {}) }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    if (v === '') delete config[k]
    else config[k] = v
  }
  const update: Record<string, unknown> = { config }
  if (isActive !== undefined) update.is_active = isActive
  const { error: saveError } = await client.from('couriers').update(update).eq('id', courierId)
  if (saveError) throw new HttpError(500, 'Could not save the courier settings', 'INTERNAL')
  return config
}

function storesFrom(provider: unknown): PathaoProvider | RedxProvider {
  if (!(provider instanceof PathaoProvider) && !(provider instanceof RedxProvider)) throw new HttpError(422, 'Pickup stores are a Pathao and RedX feature', 'NOT_SUPPORTED')
  return provider
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

async function syncOne(client: SupabaseClient, admin: SupabaseClient, shipmentId: string) {
  const shipment = await loadShipment(client, shipmentId)
  const provider = await courierProviderFor(admin, shipment.courier)
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
async function bookOrder(client: SupabaseClient, admin: SupabaseClient, orderId: string, courier: CourierRow, note?: string | null, storeId?: string | null) {
  const { data: order, error } = await client
    .from('orders')
    .select('id, order_number, status, customer_name, customer_phone, shipping_address, shipping_area, shipping_district, cod_amount, order_items(quantity, product_name, product_variants(weight_grams)), shipments(id, courier_id, tracking_number, is_active)')
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
  const provider = await courierProviderFor(admin, courier)
  // Store orders can come in without a district; Steadfast books on the address alone, the others need one.
  if (!order.shipping_district?.trim() && provider.code !== 'steadfast') {
    throw new HttpError(422, `${order.order_number} has no district yet. Edit the order and choose it, then book with ${courier.name}.`, 'DISTRICT_MISSING')
  }
  const opts = courierOptions(courier.config)
  const items = order.order_items as unknown as Array<{ quantity: number; product_name: string | null; product_variants: { weight_grams: number | null } | null }>
  // Weight only when every item has one; otherwise the courier's minimum is used.
  const weightGrams = items.every((i) => i.product_variants?.weight_grams)
    ? items.reduce((s, i) => s + i.quantity * Number(i.product_variants!.weight_grams), 0) : null
  const parcelNote = note?.trim() || opts.default_note || null
  const created = await withBookingClaim(client, order.id, courier.id, () => provider.createShipment({
    orderNumber: order.order_number,
    recipientName: order.customer_name,
    recipientPhone: order.customer_phone,
    recipientAddress: order.shipping_address,
    district: order.shipping_district,
    area: order.shipping_area,
    codAmount: Number(order.cod_amount),
    itemCount: items.reduce((s, i) => s + i.quantity, 0),
    weightGrams,
    note: parcelNote,
    itemDescription: opts.send_product_names ? itemDescription(items) : null,
    storeId: storeId ?? null,
  }))
  return rpc(client, 'assign_courier', {
    p_order_id: order.id,
    p_courier_id: courier.id,
    p_tracking_number: created.trackingNumber,
    p_shipping_cost: created.cost ?? null,
    p_note: parcelNote,
    p_consignment_id: created.consignmentId,
    p_provider_payload: created.raw as Record<string, unknown>,
  })
}

/** Refreshes active API parcels from the courier (one merchant at a time). */
async function syncAll(client: SupabaseClient, admin: SupabaseClient, courierId?: string) {
  let query = client
    .from('shipments')
    .select('id, couriers!inner(api_enabled)')
    .eq('is_active', true)
    .eq('couriers.api_enabled', true)
    .in('status', SYNCABLE)
    .limit(50)
  // A service-role client reads every merchant's rows: keep to this one.
  const merchant = merchantOf(client)
  if (merchant) query = query.eq('merchant_id', merchant)
  if (courierId) query = query.eq('courier_id', courierId)
  const { data, error } = await query
  if (error) throw new HttpError(500, 'Could not load shipments', 'INTERNAL')
  const results = []
  for (const row of data ?? []) {
    try {
      results.push(await syncOne(client, admin, row.id))
    } catch (e) {
      results.push({ shipment_id: row.id, error: (e as Error).message })
    }
  }
  return { synced: results.length, results }
}

const SHIPPED = ['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'ON_HOLD', 'RETURNING']
type RunRow = { id: string; total: number; checked: number; changed: number; failed: number; finished_at: string | null }
type CheckOutcome = { shipment_id: string; order_number: string; courier: string; before: string; status?: string; provider_status?: string; error?: string }

/**
 * One batch of a logged status check: the next `batch` active parcels after `after`
 * (by id, so batches never repeat or skip one), each asked from its courier. A parcel
 * that fails is tried once more before it is reported.
 */
async function checkBatch(client: SupabaseClient, admin: SupabaseClient, run: RunRow, opts: { scope: 'all' | 'shipped'; courierId?: string; after?: string; batch: number }) {
  let query = client
    .from('shipments')
    .select('id, status, couriers!inner(name, api_enabled), orders(order_number)')
    .eq('is_active', true)
    .eq('couriers.api_enabled', true)
    .in('status', opts.scope === 'shipped' ? SHIPPED : SYNCABLE)
    .order('id')
    .limit(opts.batch)
  const merchant = merchantOf(client)
  if (merchant) query = query.eq('merchant_id', merchant)
  if (opts.courierId) query = query.eq('courier_id', opts.courierId)
  if (opts.after) query = query.gt('id', opts.after)
  const { data, error } = await query
  if (error) throw new HttpError(500, 'Could not load shipments', 'INTERNAL')
  const rows = (data ?? []) as unknown as Array<{ id: string; status: string; couriers: { name: string }; orders: { order_number: string } | null }>
  const results: CheckOutcome[] = []
  for (const row of rows) {
    const base = { shipment_id: row.id, order_number: row.orders?.order_number ?? '', courier: row.couriers.name, before: row.status }
    let outcome: CheckOutcome
    try {
      const r = await syncOne(client, admin, row.id)
      outcome = { ...base, status: r.status, provider_status: r.provider_status }
    } catch (first) {
      try {
        await new Promise((resolve) => setTimeout(resolve, 800))
        const r = await syncOne(client, admin, row.id)
        outcome = { ...base, status: r.status, provider_status: r.provider_status }
      } catch (e) {
        outcome = { ...base, error: ((e as Error).message || (first as Error).message || 'No answer').slice(0, 300) }
      }
    }
    results.push(outcome)
  }
  const done = rows.length < opts.batch
  const errors = results.filter((r) => r.error).map((r) => ({ order_number: r.order_number, courier: r.courier, error: r.error, at: new Date().toISOString() }))
  const updated = await rpc<RunRow>(client, 'courier_sync_run_progress', {
    p_run_id: run.id, p_checked: results.filter((r) => !r.error).length,
    p_changed: results.filter((r) => !r.error && r.status !== r.before).length, p_errors: errors, p_done: done,
  })
  return { run: updated, results, next: done ? null : rows[rows.length - 1]?.id ?? null, done }
}

/** The scheduled check for one store, when its setting says it is due: every active parcel, batch by batch. */
async function scheduledCheck(admin: SupabaseClient) {
  if (!(await rpc<boolean>(admin, 'courier_sync_due'))) return { skipped: true }
  let run = await rpc<RunRow>(admin, 'courier_sync_run_start', { p_trigger: 'SCHEDULED', p_scope: 'all', p_courier_id: null })
  const deadline = Date.now() + 100_000
  let after: string | undefined
  for (let i = 0; i < 30; i++) {
    const last = Date.now() > deadline || i === 29
    const r = await checkBatch(admin, admin, run, { scope: 'all', after, batch: 20 })
    run = r.run
    if (r.done) break
    after = r.next ?? undefined
    if (last) {
      run = await rpc<RunRow>(admin, 'courier_sync_run_progress', { p_run_id: run.id, p_checked: 0, p_changed: 0, p_errors: [], p_done: true })
      break
    }
  }
  return { run_id: run.id, checked: run.checked, changed: run.changed, failed: run.failed }
}

function notSupported(error: unknown): never {
  if (error instanceof CourierNotSupportedError) throw new HttpError(422, error.message, 'NOT_SUPPORTED')
  throw error
}

export default (
  handle(async (req) => {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
    const body = await readJson<{ action?: string }>(req)

    // pg_cron (or the Worker's scheduler) can trigger a periodic sync: the same check as every other scheduled call.
    const input = parse(schema, body)
    if (input.action === 'sync_all' && await isCronRequest(req, adminClient())) {
      // Scheduled: only stores that turned the automatic check on, and only when it is due.
      return json(req, await forEachMerchant('courier', (admin) => scheduledCheck(admin)))
    }
    const staff = await requireStaff(req, PERMISSION[input.action] ?? 'shipments.manage')
    const client = staff.client
    const admin = staff.admin

    try {
      switch (input.action) {
        case 'connect': {
          const missing = missingCredentialFields(input.provider, input.credentials as CourierCredentials)
          if (missing.length) throw new HttpError(422, `Fill in: ${missing.join(', ').replace(/_/g, ' ').replace('panel ', 'account ')}`, 'VALIDATION')
          const invalid = invalidCredentialFields(input.provider, input.credentials as CourierCredentials)
          if (invalid.length) throw new HttpError(422, `Check the ${invalid.join(', ')}`, 'VALIDATION')
          // Only the known fields are kept (plus the sandbox switch); empty optional ones are left out.
          const creds: CourierCredentials = Object.fromEntries(
            [...COURIER_FIELDS[input.provider], ...(COURIER_OPTIONAL_FIELDS[input.provider] ?? []), 'sandbox']
              .filter((k) => k in input.credentials && input.credentials[k] !== '').map((k) => [k, input.credentials[k]]))
          const opts = (input.options ?? {}) as CourierOptions
          const built = buildCourierProvider(input.provider, creds, null, opts)
          const test = await built.testConnection()
          if (!test.ok) throw new HttpError(422, `Could not connect: ${test.message}`, 'CONNECTION_FAILED')
          const stores = built instanceof PathaoProvider || built instanceof RedxProvider ? await built.listStores().catch(() => undefined) : undefined

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
          await rpc(admin, 'courier_credentials_store', {
            p_courier_id: courierId,
            p_provider: input.provider,
            p_credentials: creds,
            p_hint: credentialHint(input.provider, creds),
            p_actor: staff.user.id,
          })
          await saveOptions(client, courierId!, { ...opts, ...(stores ? { stores, stores_synced_at: new Date().toISOString() } : {}) }, input.is_active)
          return json(req, { courier_id: courierId, ok: true, message: test.message })
        }
        case 'save_options': {
          const courier = await loadCourier(client, input.courier_id)
          const opts = input.options as CourierOptions
          const known = (courier.config?.stores as PathaoStore[] | undefined) ?? []
          if (['pathao', 'redx'].includes(courier.provider) && opts.store_id && known.length && !known.some((s) => s.id === opts.store_id)) {
            throw new HttpError(422, `Store ${opts.store_id} is not on this ${courier.provider === 'redx' ? 'RedX' : 'Pathao'} account — sync the stores first`, 'VALIDATION')
          }
          const config = await saveOptions(client, input.courier_id, opts, input.is_active)
          return json(req, { ok: true, options: courierOptions(config) })
        }
        case 'courier_stores': {
          let provider
          if (input.credentials && Object.keys(input.credentials).length) {
            const missing = missingCredentialFields(input.provider, input.credentials as CourierCredentials)
            if (missing.length) throw new HttpError(422, `Fill in: ${missing.join(', ').replace(/_/g, ' ')}`, 'VALIDATION')
            provider = buildCourierProvider(input.provider, input.credentials as CourierCredentials)
          } else if (input.courier_id) {
            const courier = await loadCourier(client, input.courier_id)
            provider = await courierProviderFor(admin, { ...courier, api_enabled: true })
          } else {
            throw new HttpError(422, input.provider === 'redx' ? 'Enter the RedX access token first' : 'Enter the Pathao keys first', 'VALIDATION')
          }
          let stores: PathaoStore[]
          try {
            stores = await storesFrom(provider).listStores()
          } catch (e) {
            if (e instanceof HttpError) throw e
            throw new HttpError(422, (e as Error).message, 'CONNECTION_FAILED')
          }
          // Saved connection: remember the list so orders can pick a store without asking Pathao.
          if (input.courier_id && !input.credentials) await saveOptions(client, input.courier_id, { stores, stores_synced_at: new Date().toISOString() })
          return json(req, { stores })
        }
        case 'disconnect': {
          await loadCourier(client, input.courier_id)
          await rpc(admin, 'courier_credentials_clear', { p_courier_id: input.courier_id, p_actor: staff.user.id })
          return json(req, { ok: true })
        }
        case 'create_shipment': {
          const courier = await loadCourier(client, input.courier_id)
          return json(req, { shipment: await bookOrder(client, admin, input.order_id, courier, input.note, input.store_id) })
        }
        case 'create_shipments': {
          const courier = await loadCourier(client, input.courier_id)
          const results: Array<{ order_id: string; ok: boolean; tracking_number?: string | null; error?: string }> = []
          for (const orderId of input.order_ids) {
            try {
              const shipment = await bookOrder(client, admin, orderId, courier, null, input.store_id) as { tracking_number: string | null }
              results.push({ order_id: orderId, ok: true, tracking_number: shipment.tracking_number })
            } catch (e) {
              results.push({ order_id: orderId, ok: false, error: e instanceof HttpError || e instanceof Error ? e.message : String(e) })
            }
          }
          return json(req, { booked: results.filter((r) => r.ok).length, results })
        }
        case 'cancel_shipment': {
          const shipment = await loadShipment(client, input.shipment_id)
          await (await courierProviderFor(admin, shipment.courier)).cancelShipment({
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
          return json(req, await syncOne(client, admin, input.shipment_id))
        case 'sync_all':
          return json(req, await syncAll(client, admin, input.courier_id))
        case 'force_check': {
          const run = input.run_id
            ? { id: input.run_id, total: 0, checked: 0, changed: 0, failed: 0, finished_at: null }
            : await rpc<RunRow>(client, 'courier_sync_run_start', { p_trigger: 'MANUAL', p_scope: input.scope, p_courier_id: input.courier_id ?? null })
          const r = await checkBatch(client, admin, run, { scope: input.scope, courierId: input.courier_id, after: input.after, batch: input.batch })
          return json(req, { ...r, run: { ...r.run, total: r.run.total || run.total } })
        }
        case 'tracking': {
          const shipment = await loadShipment(client, input.shipment_id)
          const tracking = await (await courierProviderFor(admin, shipment.courier)).getTracking({
            consignmentId: shipment.consignment_id,
            trackingNumber: shipment.tracking_number,
            orderNumber: shipment.orderNumber,
          })
          return json(req, { tracking })
        }
        case 'delivery_cost': {
          const courier = await loadCourier(client, input.courier_id)
          const cost = await (await courierProviderFor(admin, courier)).getDeliveryCost({
            district: input.district, area: input.area, weightGrams: input.weight_grams, codAmount: input.cod_amount ?? 0,
          })
          if (cost !== null) return json(req, { cost, source: 'courier' })
          const zone = await rpc<{ charge: number } | null>(admin, 'resolve_delivery_zone', {
            p_district: input.district, p_area: input.area ?? null,
          })
          return json(req, { cost: zone?.charge ?? null, source: 'zone' })
        }
        case 'set_webhook_secret': {
          await loadCourier(client, input.courier_id)
          await rpc(admin, 'courier_webhook_secret_set', {
            p_courier_id: input.courier_id, p_secret: input.secret, p_actor: staff.user.id,
          })
          return json(req, { ok: true, hint: `••••${input.secret.slice(-4)}` })
        }
        case 'test_connection': {
          const courier = await loadCourier(client, input.courier_id)
          let result: { ok: boolean; message: string }
          try {
            result = await (await courierProviderFor(admin, { ...courier, api_enabled: true })).testConnection()
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
  })
)
