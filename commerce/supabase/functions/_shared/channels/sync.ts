// Store sync jobs (Shopify, WooCommerce): fulfil shipped orders and keep stock in step.
// Pure logic over two ports (the database RPCs and the Shopify client) so it
// can be tested with mocked Shopify answers. Every outcome is written back to
// the database; nothing is reported as done until Shopify confirmed it.
import { ChannelError, type SeenFulfillment } from './common.ts'
import { type FulfillmentGroup, type FulfillmentState, planFulfillment } from './shopify.ts'

export interface Job { id: string; channel_id: string; kind: 'FULFILL' | 'INVENTORY'; ref_id: string; attempts: number; payload: Record<string, unknown> }
export type Outcome = { outcome: 'DONE' | 'RETRY' | 'FAILED'; error?: string; result?: Record<string, unknown>; delay?: number }

/** What the worker needs from Shopify (ShopifyClient implements it). */
export interface StockPort {
  available(inventoryItemId: string, locationId: string): Promise<number | null>
  setAvailable(inventoryItemId: string, locationId: string, quantity: number, from: number | null, key: string): Promise<void>
}
export interface ShopifyPort extends StockPort {
  fulfillmentState(orderId: string): Promise<FulfillmentState>
  createFulfillment(input: { groups: FulfillmentGroup[]; notifyCustomer: boolean; tracking: { company: string | null; number: string | null; url: string | null } | null }): Promise<SeenFulfillment>
  markDelivered(fulfillmentId: string, happenedAt: string | null): Promise<{ id: string; existing: boolean }>
}
/** What the worker needs from WooCommerce (WooClient implements it). */
export interface WooPort {
  orderState(orderId: string): Promise<{ status: string; email: string | null; notes: Array<{ id: number; note: string }> }>
  addNote(orderId: string, note: string, customer: boolean): Promise<number>
  setStatus(orderId: string, status: string): Promise<string>
}
export type Rpc = <T>(fn: string, args: Record<string, unknown>) => Promise<T>

interface FulfillContext {
  order: { id: string; order_number: string; status: string; external_order_id: string; customer_email: string | null; delivered_at?: string | null }
  fulfillment: { status: string; tracking_number: string | null; fulfillment_id?: string | null; delivered_status?: string | null } | null
  /** The Shopify fulfilment to mark Delivered: ours, or one made in Shopify. */
  delivered_target?: string | null
  shipment: { courier: string | null; provider: string | null; tracking: string | null; tracking_url: string | null; shipped_at: string | null } | null
  lines: Array<{ variant_id: string; sku: string | null; quantity: number; external_variant_id: string | null }>
}
interface ChannelOpts { notify_customer: boolean; fulfill_without_tracking: boolean }

const SHIPPED = ['SHIPPED', 'DELIVERED', 'PARTIALLY_DELIVERED']
/** Shopify knows these carriers by name (others are sent as written). */
const CARRIER: Record<string, string> = { pathao: 'Pathao', steadfast: 'Steadfast', redx: 'RedX' }

/** Errors worth trying again later (network, rate limits, Shopify hiccups). */
export function retryable(error: unknown): boolean {
  if (!(error instanceof ChannelError)) return true
  if (error.unauthorized || ['ACCESS_DENIED', 'USER_ERROR', 'NOT_FOUND', 'FROZEN'].includes(error.code ?? '')) return false
  return true
}

/**
 * Fulfils a shipped Shopify order (once), and when the order is delivered here
 * also marks that fulfilment Delivered on Shopify (once). Both steps look at
 * Shopify first, so a retry never creates a second fulfilment or event.
 */
export async function fulfillJob(job: Job, rpc: Rpc, shopify: () => ShopifyPort, opts: ChannelOpts): Promise<Outcome> {
  const ctx = await rpc<FulfillContext>('channel_fulfillment_context', { p_order_id: job.ref_id })
  const f = ctx.fulfillment
  const save = (p: Record<string, unknown>) => rpc('channel_fulfillment_update', { p_order_id: job.ref_id, p })
  const wantDelivered = f?.delivered_status === 'PENDING' && ctx.order.status === 'DELIVERED'

  const deliver = async (target: string | null | undefined, result: Record<string, unknown> = {}): Promise<Outcome> => {
    if (!target) {
      await save({ delivered_status: 'SKIPPED', delivered_error: 'There is no Shopify fulfilment to mark delivered' })
      return { outcome: 'DONE', result: { ...result, delivered: 'no fulfilment' } }
    }
    try {
      const ev = await shopify().markDelivered(target, ctx.order.delivered_at ?? null)
      await save({ delivered_status: 'MARKED', delivered_event_id: ev.id, delivered_error: '' })
      return { outcome: 'DONE', result: { ...result, delivered_event: ev.id, existing: ev.existing } }
    } catch (error) {
      const message = (error as Error).message
      if (retryable(error)) {
        await save({ delivered_error: `${message} — will try again` })
        return { outcome: 'RETRY', error: message, result }
      }
      await save({ delivered_status: 'FAILED', delivered_error: message })
      return { outcome: 'FAILED', error: message, result }
    }
  }

  if (!f) return { outcome: 'DONE', result: { skipped: 'none' } }
  if (f.status === 'FULFILLED' || f.status === 'SKIPPED') {
    if (wantDelivered) return deliver(ctx.delivered_target)
    return { outcome: 'DONE', result: { skipped: f.status } }
  }
  // Cancelled (or moved back) after it was queued: never fulfil.
  if (!SHIPPED.includes(ctx.order.status)) {
    await save({ status: 'SKIPPED', error: `Order is ${ctx.order.status.toLowerCase().replace(/_/g, ' ')} — not fulfilled on Shopify` })
    return { outcome: 'DONE', result: { skipped: ctx.order.status } }
  }
  const tracking = ctx.shipment?.tracking ?? null
  if (!tracking && !opts.fulfill_without_tracking) {
    await save({ status: 'NEEDS_TRACKING', error: 'No courier tracking number on this order. Add it (book the courier or enter it) and it is sent automatically.' })
    return { outcome: 'DONE', result: { waiting: 'tracking' } }
  }
  const company = ctx.shipment ? (CARRIER[ctx.shipment.provider ?? ''] ?? ctx.shipment.courier) : null

  try {
    const client = shopify()
    // Always look at Shopify first: a previous attempt may have succeeded
    // without us hearing back, or someone fulfilled it by hand.
    const state = await client.fulfillmentState(ctx.order.external_order_id)
    const mine = tracking ? state.fulfillments.find((x) => x.tracking_number === tracking && x.status !== 'CANCELLED') : undefined
    if (mine) {
      await save({ status: 'FULFILLED', fulfillment_id: mine.id, courier: company, tracking_number: tracking, tracking_url: ctx.shipment?.tracking_url,
        shopify_status: mine.display_status ?? mine.status, error: '' })
      return wantDelivered ? deliver(mine.id, { adopted: mine.id }) : { outcome: 'DONE', result: { adopted: mine.id } }
    }
    const plan = planFulfillment(ctx.lines, state.fulfillmentOrders)
    if (!plan.groups.length) {
      if (state.fulfillments.length) {
        await rpc('channel_fulfillments_seen', { p_channel_id: job.channel_id, p_external_order_id: ctx.order.external_order_id,
          p_fulfillments: state.fulfillments.map((x) => ({ ...x, all_fulfilled: true })) })
        await save({ status: 'SKIPPED', error: 'Already fulfilled in Shopify' })
        return wantDelivered ? deliver(state.fulfillments[0].id, { skipped: 'already fulfilled' }) : { outcome: 'DONE', result: { skipped: 'already fulfilled' } }
      }
      const why = plan.unmatched.length ? `These items are not linked to Shopify products: ${plan.unmatched.join(', ')}` : 'Shopify has nothing left to fulfil on this order'
      await save({ status: 'FAILED', error: why, attempted: true })
      return { outcome: 'FAILED', error: why }
    }

    const email = state.email ?? ctx.order.customer_email
    const notify = opts.notify_customer && !!email
    await save({ status: 'PROCESSING', attempted: true, courier: company, tracking_number: tracking, tracking_url: ctx.shipment?.tracking_url,
      fulfillment_order_ids: plan.groups.map((g) => g.fulfillmentOrderId), line_items: plan.groups, shipped_at: ctx.shipment?.shipped_at })
    const created = await client.createFulfillment({
      groups: plan.groups, notifyCustomer: notify,
      tracking: tracking ? { company, number: tracking, url: ctx.shipment?.tracking_url ?? null } : null,
    })
    await save({
      status: 'FULFILLED', fulfillment_id: created.id, shopify_status: created.display_status ?? created.status, error: '',
      notify_requested: notify,
      notification_status: !opts.notify_customer ? 'DISABLED' : email ? 'REQUESTED' : 'NO_EMAIL',
      notification_note: !opts.notify_customer ? 'Customer e-mails are turned off for this store'
        : email ? 'Shopify was asked to send its shipping confirmation (delivery is not confirmed by Shopify)'
          : 'The order has no customer e-mail, so Shopify cannot send the shipping confirmation',
    })
    const result = { fulfillment_id: created.id, partial: plan.unmatched.length > 0 }
    return wantDelivered ? deliver(created.id, result) : { outcome: 'DONE', result }
  } catch (error) {
    const message = (error as Error).message
    if (retryable(error)) {
      await save({ status: 'PENDING', error: `${message} — will try again` })
      return { outcome: 'RETRY', error: message }
    }
    await save({ status: 'FAILED', error: message })
    return { outcome: 'FAILED', error: message }
  }
}

interface InventoryContext {
  variant_id: string; inventory_item_id: string | null; location_id: string | null; policy: 'FLAG' | 'SAAS_WINS'; sync_on: boolean
  desired: number; track_inventory: boolean; last_pushed_qty: number | null; shopify_available: number | null; mismatch_since: string | null; sku: string | null
}

/** Seconds to wait for a Shopify order to arrive before calling a difference "made in Shopify". */
export const GRACE_SECONDS = 120

/**
 * WooCommerce has no fulfilments: the order is marked Completed and the courier,
 * tracking number and (real) tracking link go in an order note, e-mailed to the
 * customer as a customer note when that is on. A note already carrying the
 * tracking number means an earlier attempt got through.
 */
export async function wooFulfillJob(job: Job, rpc: Rpc, woo: () => WooPort, opts: ChannelOpts): Promise<Outcome> {
  const ctx = await rpc<FulfillContext>('channel_fulfillment_context', { p_order_id: job.ref_id })
  const f = ctx.fulfillment
  const save = (p: Record<string, unknown>) => rpc('channel_fulfillment_update', { p_order_id: job.ref_id, p })
  if (!f || f.status === 'FULFILLED' || f.status === 'SKIPPED') return { outcome: 'DONE', result: { skipped: f?.status ?? 'none' } }
  if (!SHIPPED.includes(ctx.order.status)) {
    await save({ status: 'SKIPPED', error: `Order is ${ctx.order.status.toLowerCase().replace(/_/g, ' ')} — not completed in WooCommerce` })
    return { outcome: 'DONE', result: { skipped: ctx.order.status } }
  }
  const tracking = ctx.shipment?.tracking ?? null
  if (!tracking && !opts.fulfill_without_tracking) {
    await save({ status: 'NEEDS_TRACKING', error: 'No courier tracking number on this order. Add it (book the courier or enter it) and it is sent automatically.' })
    return { outcome: 'DONE', result: { waiting: 'tracking' } }
  }
  const company = ctx.shipment ? (CARRIER[ctx.shipment.provider ?? ''] ?? ctx.shipment.courier) : null
  const url = ctx.shipment?.tracking_url ?? null
  try {
    const client = woo()
    const state = await client.orderState(ctx.order.external_order_id)
    if (['cancelled', 'refunded', 'failed', 'trash'].includes(state.status)) {
      await save({ status: 'SKIPPED', error: `The order is ${state.status} in WooCommerce` })
      return { outcome: 'DONE', result: { skipped: state.status } }
    }
    const email = state.email ?? ctx.order.customer_email
    const notify = opts.notify_customer && !!email
    const earlier = tracking ? state.notes.find((n) => n.note.includes(tracking)) : undefined
    let noteId = earlier?.id ?? null
    if (!noteId) {
      await save({ status: 'PROCESSING', attempted: true, courier: company, tracking_number: tracking, tracking_url: url, shipped_at: ctx.shipment?.shipped_at })
      const text = [`Your order has been shipped${company ? ` with ${company}` : ''}.`, tracking ? `Tracking number: ${tracking}` : null, url ? `Track it here: ${url}` : null]
        .filter(Boolean).join('\n')
      noteId = await client.addNote(ctx.order.external_order_id, text, notify)
    }
    const status = state.status === 'completed' ? state.status : await client.setStatus(ctx.order.external_order_id, 'completed')
    if (status !== 'completed') throw new ChannelError(`WooCommerce left the order ${status}`, 422, 'USER_ERROR')
    await save({
      status: 'FULFILLED', fulfillment_id: `woo-note-${noteId}`, shopify_status: 'completed', error: '', courier: company, tracking_number: tracking, tracking_url: url,
      notify_requested: notify,
      notification_status: !opts.notify_customer ? 'DISABLED' : email ? 'REQUESTED' : 'NO_EMAIL',
      notification_note: !opts.notify_customer ? 'Customer e-mails are turned off for this store'
        : email ? 'WooCommerce was asked to e-mail the tracking note (delivery is not confirmed by WooCommerce)'
          : 'The order has no customer e-mail, so WooCommerce cannot send the note',
    })
    return { outcome: 'DONE', result: { note_id: noteId, adopted: !!earlier } }
  } catch (error) {
    const message = (error as Error).message
    if (retryable(error)) {
      await save({ status: 'PENDING', error: `${message} — will try again` })
      return { outcome: 'RETRY', error: message }
    }
    await save({ status: 'FAILED', error: message })
    return { outcome: 'FAILED', error: message }
  }
}

export async function inventoryJob(job: Job, rpc: Rpc, shopify: () => StockPort, now = Date.now(), store = 'Shopify'): Promise<Outcome> {
  const ctx = await rpc<InventoryContext | null>('channel_inventory_context', { p_channel_id: job.channel_id, p_variant_id: job.ref_id })
  const save = (p: Record<string, unknown>) => rpc('channel_inventory_update', { p_channel_id: job.channel_id, p_variant_id: job.ref_id, p })
  if (!ctx || !ctx.sync_on || !ctx.location_id || !ctx.inventory_item_id) return { outcome: 'DONE', result: { skipped: 'not synced' } }
  if (!ctx.track_inventory) {
    await save({ sync_status: 'UNTRACKED', error: '' })
    return { outcome: 'DONE', result: { skipped: 'stock not counted here' } }
  }
  try {
    const client = shopify()
    const current = await client.available(ctx.inventory_item_id, ctx.location_id)
    if (current === ctx.desired) {
      await save({ shopify_available: current, last_pushed_qty: current, sync_status: 'OK', error: '' })
      return { outcome: 'DONE', result: { in_step: current } }
    }
    const external = !job.payload.force && ctx.last_pushed_qty !== null && current !== ctx.last_pushed_qty
    if (external) {
      const since = ctx.mismatch_since ? Date.parse(ctx.mismatch_since) : null
      if (since === null || now - since < GRACE_SECONDS * 1000) {
        await save({ shopify_available: current, sync_status: 'MISMATCH', error: `Changed in ${store} (${ctx.last_pushed_qty} → ${current}); checking again shortly` })
        return { outcome: 'RETRY', error: 'waiting for orders to arrive', delay: GRACE_SECONDS }
      }
      if (ctx.policy !== 'SAAS_WINS') {
        await save({ shopify_available: current, sync_status: 'MISMATCH',
          error: `Changed in ${store} to ${current} (we last set ${ctx.last_pushed_qty}; ours is ${ctx.desired}). Review it under Reconcile.` })
        return { outcome: 'DONE', result: { flagged: current } }
      }
    }
    const key = `inv-${job.channel_id.slice(0, 8)}-${job.ref_id}-${current ?? 'none'}-${ctx.desired}`
    await client.setAvailable(ctx.inventory_item_id, ctx.location_id, ctx.desired, current, key)
    await save({ shopify_available: ctx.desired, last_pushed_qty: ctx.desired, sync_status: 'OK', error: '' })
    return { outcome: 'DONE', result: { set: ctx.desired, from: current } }
  } catch (error) {
    const e = error as ChannelError
    if (e instanceof ChannelError && e.code === 'STALE') {
      await save({ sync_status: 'PENDING', error: `${store} changed while we were updating; trying again` })
      return { outcome: 'RETRY', error: e.message, delay: 15 }
    }
    if (retryable(error)) {
      await save({ sync_status: 'PENDING', error: `${e.message} — will try again` })
      return { outcome: 'RETRY', error: e.message }
    }
    await save({ sync_status: 'FAILED', error: e.message })
    return { outcome: 'FAILED', error: e.message }
  }
}
