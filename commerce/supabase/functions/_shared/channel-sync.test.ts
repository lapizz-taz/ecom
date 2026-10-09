import { describe, expect, it, vi } from 'vitest'
import { ChannelError, type SeenFulfillment } from './channels/common.ts'
import { type FulfillmentState, planFulfillment, seenFromWebhook } from './channels/shopify.ts'
import { fulfillJob, GRACE_SECONDS, inventoryJob, type Job, type ShopifyPort } from './channels/sync.ts'

const job = (kind: Job['kind'], payload: Record<string, unknown> = {}): Job => ({ id: 'j1', channel_id: 'c0000000-0000-0000-0000-000000000000', kind, ref_id: 'o1', attempts: 1, payload })

const state = (over: Partial<FulfillmentState> = {}): FulfillmentState => ({
  email: 'rina@example.com',
  fulfillmentOrders: [{ id: 'gid://shopify/FulfillmentOrder/1', status: 'OPEN', lines: [
    { id: 'gid://shopify/FulfillmentOrderLineItem/11', remaining: 2, variant: '777', sku: 'TOTE-1' },
    { id: 'gid://shopify/FulfillmentOrderLineItem/12', remaining: 1, variant: '888', sku: 'CAP-1' },
  ] }],
  fulfillments: [],
  ...over,
})

function fulfilCtx(over: Record<string, unknown> = {}) {
  return {
    order: { id: 'o1', order_number: 'ISO-1', status: 'SHIPPED', external_order_id: '5001', customer_email: null },
    fulfillment: { status: 'PENDING', tracking_number: null },
    shipment: { courier: 'Pathao Main', provider: 'pathao', tracking: 'DL123', tracking_url: 'https://merchant.pathao.com/tracking?consignment_id=DL123', shipped_at: null },
    lines: [{ variant_id: 'v1', sku: 'TOTE-1', quantity: 2, external_variant_id: '777' }, { variant_id: 'v2', sku: 'CAP-1', quantity: 1, external_variant_id: '888' }],
    ...over,
  }
}

function harness(ctx: unknown, port: Partial<ShopifyPort>) {
  const saves: Array<Record<string, unknown>> = []
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    if (fn === 'channel_fulfillment_context' || fn === 'channel_inventory_context') return ctx
    if (fn === 'channel_fulfillment_update' || fn === 'channel_inventory_update') saves.push(args.p as Record<string, unknown>)
    return null
  }) as never
  return { rpc, saves, shopify: () => port as ShopifyPort }
}

const created: SeenFulfillment = { id: 'gid://shopify/Fulfillment/99', status: 'SUCCESS', display_status: 'FULFILLED', tracking_company: 'Pathao', tracking_number: 'DL123', tracking_url: null, created_at: null, all_fulfilled: false }
const opts = { notify_customer: true, fulfill_without_tracking: false }

describe('Shopify fulfilment job', () => {
  it('fulfils the shipped quantities with the courier, tracking link and Shopify\'s own e-mail', async () => {
    const createFulfillment = vi.fn(async () => created)
    const h = harness(fulfilCtx(), { fulfillmentState: async () => state(), createFulfillment })
    const out = await fulfillJob(job('FULFILL'), h.rpc, h.shopify, opts)
    expect(out.outcome).toBe('DONE')
    expect(createFulfillment).toHaveBeenCalledWith({
      groups: [{ fulfillmentOrderId: 'gid://shopify/FulfillmentOrder/1', lines: [
        { id: 'gid://shopify/FulfillmentOrderLineItem/11', quantity: 2, variant: '777' },
        { id: 'gid://shopify/FulfillmentOrderLineItem/12', quantity: 1, variant: '888' }] }],
      notifyCustomer: true,
      tracking: { company: 'Pathao', number: 'DL123', url: 'https://merchant.pathao.com/tracking?consignment_id=DL123' },
    })
    expect(h.saves.at(-1)).toMatchObject({ status: 'FULFILLED', fulfillment_id: created.id, notification_status: 'REQUESTED' })
    // "Requested", never "delivered": Shopify does not confirm delivery of the e-mail.
    expect(String(h.saves.at(-1)!.notification_note)).toMatch(/asked to send/)
  })

  it('a retry finds the earlier fulfilment on Shopify and does not create another', async () => {
    const createFulfillment = vi.fn()
    const h = harness(fulfilCtx(), { fulfillmentState: async () => state({ fulfillments: [{ ...created }] }), createFulfillment })
    const out = await fulfillJob(job('FULFILL'), h.rpc, h.shopify, opts)
    expect(out).toMatchObject({ outcome: 'DONE', result: { adopted: created.id } })
    expect(createFulfillment).not.toHaveBeenCalled()
  })

  it('only fulfils what we ship and what Shopify still has open (partial)', async () => {
    const createFulfillment = vi.fn(async () => created)
    const ctx = fulfilCtx({ lines: [{ variant_id: 'v1', sku: 'TOTE-1', quantity: 5, external_variant_id: '777' }] })
    const h = harness(ctx, { fulfillmentState: async () => state(), createFulfillment })
    await fulfillJob(job('FULFILL'), h.rpc, h.shopify, opts)
    const groups = (createFulfillment.mock.calls[0] as unknown as [{ groups: Array<{ lines: Array<{ quantity: number }> }> }])[0].groups
    expect(groups[0].lines).toEqual([{ id: 'gid://shopify/FulfillmentOrderLineItem/11', quantity: 2, variant: '777' }])
  })

  it('waits for a tracking number instead of claiming the parcel shipped', async () => {
    const createFulfillment = vi.fn()
    const h = harness(fulfilCtx({ shipment: null }), { fulfillmentState: async () => state(), createFulfillment })
    const out = await fulfillJob(job('FULFILL'), h.rpc, h.shopify, opts)
    expect(out.outcome).toBe('DONE')
    expect(h.saves.at(-1)).toMatchObject({ status: 'NEEDS_TRACKING' })
    expect(createFulfillment).not.toHaveBeenCalled()
  })

  it('never fulfils a cancelled order', async () => {
    const createFulfillment = vi.fn()
    const h = harness(fulfilCtx({ order: { ...fulfilCtx().order, status: 'CANCELLED' } }), { fulfillmentState: async () => state(), createFulfillment })
    await fulfillJob(job('FULFILL'), h.rpc, h.shopify, opts)
    expect(h.saves.at(-1)).toMatchObject({ status: 'SKIPPED' })
    expect(createFulfillment).not.toHaveBeenCalled()
  })

  it('records why no e-mail is sent when the order has no e-mail', async () => {
    const h = harness(fulfilCtx(), { fulfillmentState: async () => state({ email: null }), createFulfillment: async () => created })
    await fulfillJob(job('FULFILL'), h.rpc, h.shopify, opts)
    expect(h.saves.at(-1)).toMatchObject({ status: 'FULFILLED', notify_requested: false, notification_status: 'NO_EMAIL' })
  })

  it('retries rate limits and network errors; stops on missing permission', async () => {
    const limited = harness(fulfilCtx(), { fulfillmentState: async () => { throw new ChannelError('Shopify is rate limiting', 429, 'RATE_LIMITED') } })
    expect((await fulfillJob(job('FULFILL'), limited.rpc, limited.shopify, opts)).outcome).toBe('RETRY')
    expect(limited.saves.at(-1)).toMatchObject({ status: 'PENDING' })
    const denied = harness(fulfilCtx(), { fulfillmentState: async () => state(), createFulfillment: async () => { throw new ChannelError('needs scope', 403, 'ACCESS_DENIED') } })
    expect((await fulfillJob(job('FULFILL'), denied.rpc, denied.shopify, opts)).outcome).toBe('FAILED')
    expect(denied.saves.at(-1)).toMatchObject({ status: 'FAILED' })
  })
})

describe('Shopify stock job', () => {
  const ctx = (over: Record<string, unknown> = {}) => ({
    variant_id: 'v1', inventory_item_id: 'gid://shopify/InventoryItem/5', location_id: 'gid://shopify/Location/1', policy: 'FLAG', sync_on: true,
    desired: 7, track_inventory: true, last_pushed_qty: 10, shopify_available: 10, mismatch_since: null, sku: 'TOTE-1', ...over,
  })

  it('sets Shopify to our available quantity, compare-and-set from what Shopify has, with an idempotency key', async () => {
    const setAvailable = vi.fn(async () => undefined)
    const h = harness(ctx(), { available: async () => 10, setAvailable })
    const out = await inventoryJob(job('INVENTORY'), h.rpc, h.shopify)
    expect(out.outcome).toBe('DONE')
    expect(setAvailable).toHaveBeenCalledWith('gid://shopify/InventoryItem/5', 'gid://shopify/Location/1', 7, 10, expect.stringContaining('-10-7'))
    expect(h.saves.at(-1)).toMatchObject({ last_pushed_qty: 7, sync_status: 'OK' })
  })

  it('does nothing when Shopify already matches', async () => {
    const setAvailable = vi.fn()
    const h = harness(ctx({ desired: 10 }), { available: async () => 10, setAvailable })
    await inventoryJob(job('INVENTORY'), h.rpc, h.shopify)
    expect(setAvailable).not.toHaveBeenCalled()
  })

  it('a change made in Shopify is given time, then flagged — not overwritten', async () => {
    const setAvailable = vi.fn()
    const first = harness(ctx(), { available: async () => 4, setAvailable })
    expect((await inventoryJob(job('INVENTORY'), first.rpc, first.shopify)).outcome).toBe('RETRY')
    expect(first.saves.at(-1)).toMatchObject({ sync_status: 'MISMATCH' })
    const later = harness(ctx({ mismatch_since: new Date(Date.now() - (GRACE_SECONDS + 5) * 1000).toISOString() }), { available: async () => 4, setAvailable })
    expect((await inventoryJob(job('INVENTORY'), later.rpc, later.shopify)).outcome).toBe('DONE')
    expect(later.saves.at(-1)).toMatchObject({ sync_status: 'MISMATCH' })
    expect(setAvailable).not.toHaveBeenCalled()
    // "This app wins": after the grace period ours is set.
    const wins = harness(ctx({ policy: 'SAAS_WINS', mismatch_since: new Date(Date.now() - (GRACE_SECONDS + 5) * 1000).toISOString() }), { available: async () => 4, setAvailable })
    await inventoryJob(job('INVENTORY'), wins.rpc, wins.shopify)
    expect(setAvailable).toHaveBeenCalledWith(expect.any(String), expect.any(String), 7, 4, expect.any(String))
  })

  it('retries when Shopify changed between reading and setting', async () => {
    const h = harness(ctx(), { available: async () => 10, setAvailable: async () => { throw new ChannelError('changeFromQuantity does not match', 409, 'STALE') } })
    expect(await inventoryJob(job('INVENTORY'), h.rpc, h.shopify)).toMatchObject({ outcome: 'RETRY', delay: 15 })
  })
})

describe('fulfilment helpers', () => {
  it('matches by SKU when an item was not linked by variant', () => {
    const plan = planFulfillment([{ external_variant_id: null, sku: 'cap-1', quantity: 1 }, { external_variant_id: null, sku: 'NOPE', quantity: 1 }], state().fulfillmentOrders)
    expect(plan.groups[0].lines).toEqual([{ id: 'gid://shopify/FulfillmentOrderLineItem/12', quantity: 1, variant: '888' }])
    expect(plan.unmatched).toEqual(['NOPE'])
  })

  it('reads fulfilments from orders/updated and fulfillments/create webhooks', () => {
    const fromOrder = seenFromWebhook({ id: 5001, fulfillment_status: 'fulfilled', fulfillments: [{ admin_graphql_api_id: 'gid://shopify/Fulfillment/7', status: 'success', tracking_company: 'Steadfast', tracking_number: 'SF1', tracking_url: 'https://steadfast.com.bd/t/SF1' }] })
    expect(fromOrder).toEqual([expect.objectContaining({ id: 'gid://shopify/Fulfillment/7', status: 'SUCCESS', tracking_number: 'SF1', all_fulfilled: true })])
    const fromFulfilment = seenFromWebhook({ id: 8, order_id: 5001, status: 'success', tracking_numbers: ['RX9'] })
    expect(fromFulfilment[0]).toMatchObject({ id: 'gid://shopify/Fulfillment/8', tracking_number: 'RX9' })
  })
})
