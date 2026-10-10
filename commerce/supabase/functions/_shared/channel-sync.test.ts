import { describe, expect, it, vi } from 'vitest'
import { ChannelError, type SeenFulfillment } from './channels/common.ts'
import { type FulfillmentState, planFulfillment, seenFromWebhook } from './channels/shopify.ts'
import { fulfillJob, GRACE_SECONDS, inventoryJob, type Job, type ShopifyPort, wooFulfillJob, type WooPort } from './channels/sync.ts'
import { WooClient, wooCatalogItem, wooStockFromWebhook } from './channels/woocommerce.ts'

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

describe('WooCommerce fulfilment job', () => {
  const woo = (over: Partial<WooPort> = {}) => ({
    orderState: vi.fn(async () => ({ status: 'processing', email: 'rina@example.com', notes: [] as Array<{ id: number; note: string }> })),
    addNote: vi.fn(async () => 55),
    setStatus: vi.fn(async () => 'completed'),
    ...over,
  })

  it('adds the tracking note (e-mailed to the customer) and completes the order', async () => {
    const w = woo()
    const h = harness(fulfilCtx(), {})
    const out = await wooFulfillJob(job('FULFILL'), h.rpc, () => w, opts)
    expect(out.outcome).toBe('DONE')
    expect(w.addNote).toHaveBeenCalledWith('5001', expect.stringContaining('Tracking number: DL123'), true)
    expect(w.addNote.mock.calls[0][1]).toContain('https://merchant.pathao.com/tracking?consignment_id=DL123')
    expect(w.setStatus).toHaveBeenCalledWith('5001', 'completed')
    expect(h.saves.at(-1)).toMatchObject({ status: 'FULFILLED', fulfillment_id: 'woo-note-55', notification_status: 'REQUESTED' })
  })

  it('a retry finds its earlier note and does not post another', async () => {
    const w = woo({ orderState: vi.fn(async () => ({ status: 'completed', email: null, notes: [{ id: 9, note: 'Tracking number: DL123' }] })) })
    const h = harness(fulfilCtx(), {})
    await wooFulfillJob(job('FULFILL'), h.rpc, () => w, opts)
    expect(w.addNote).not.toHaveBeenCalled()
    expect(w.setStatus).not.toHaveBeenCalled()
    expect(h.saves.at(-1)).toMatchObject({ status: 'FULFILLED', fulfillment_id: 'woo-note-9' })
  })

  it('never completes an order cancelled in WooCommerce, and waits for tracking', async () => {
    const w = woo({ orderState: vi.fn(async () => ({ status: 'cancelled', email: null, notes: [] })) })
    const h = harness(fulfilCtx(), {})
    await wooFulfillJob(job('FULFILL'), h.rpc, () => w, opts)
    expect(w.setStatus).not.toHaveBeenCalled()
    expect(h.saves.at(-1)).toMatchObject({ status: 'SKIPPED' })
    const h2 = harness(fulfilCtx({ shipment: null }), {})
    const w2 = woo()
    await wooFulfillJob(job('FULFILL'), h2.rpc, () => w2, opts)
    expect(w2.orderState).not.toHaveBeenCalled()
    expect(h2.saves.at(-1)).toMatchObject({ status: 'NEEDS_TRACKING' })
  })
})

describe('WooCommerce stock', () => {
  const res = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  it('maps products and variations to catalog items (variation stock managed by the parent is not synced)', () => {
    const p = { id: 10, name: 'Hoodie', type: 'variable', status: 'publish', manage_stock: false, stock_quantity: null, images: [{ src: 'https://x.test/h.jpg' }], short_description: '<p>Warm &amp; soft</p>' }
    const v = { id: 11, sku: 'HOOD-M', price: '1200', regular_price: '1450', sale_price: '1200', manage_stock: true as const, stock_quantity: 4, attributes: [{ name: 'Size', option: 'M' }] }
    expect(wooCatalogItem(p, v)).toMatchObject({
      external_variant_id: '11', external_product_id: '10', inventory_item_id: 'products/10/variations/11', tracked: true, variant_title: 'M',
      levels: [{ location_id: 'default', available: 4 }], price: '1200', compare_at_price: '1450', options: { Size: 'M' }, product_status: 'ACTIVE',
      image_url: 'https://x.test/h.jpg', product_description: 'Warm & soft',
    })
    expect(wooCatalogItem(p, { ...v, manage_stock: 'parent' }).tracked).toBe(false)
    expect(wooStockFromWebhook({ id: 11, parent_id: 10, manage_stock: true, stock_quantity: 3 })).toEqual({ item: 'products/10/variations/11', available: 3 })
    expect(wooStockFromWebhook({ id: 12, manage_stock: false, stock_quantity: null })).toBeNull()
  })

  it('sets stock only when WooCommerce still has what we last saw', async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') return res({ stock_quantity: JSON.parse(String(init.body)).stock_quantity })
      return res({ manage_stock: true, stock_quantity: url.includes('/variations/') ? 6 : 2 })
    })
    const c = new WooClient('https://shop.test', 'ck_x', 'cs_x', fetchFn as never)
    await c.setAvailable('products/10/variations/11', 'default', 4, 6, 'k')
    expect(JSON.parse(String(fetchFn.mock.calls.at(-1)![1]!.body))).toEqual({ manage_stock: true, stock_quantity: 4 })
    await expect(c.setAvailable('products/10', 'default', 4, 5, 'k')).rejects.toMatchObject({ code: 'STALE' })
    await expect(c.setAvailable('orders/1', 'default', 4, null, 'k')).rejects.toThrow(/Not a WooCommerce stock item/)
  })
})

describe('Delivered on Shopify', () => {
  const delivered = (fulfillment: Record<string, unknown>, extra: Record<string, unknown> = {}) => fulfilCtx({
    order: { id: 'o1', order_number: 'ISO-1', status: 'DELIVERED', external_order_id: '5001', customer_email: null, delivered_at: '2026-10-10T08:00:00Z' },
    fulfillment, delivered_target: fulfillment.fulfillment_id ?? null, ...extra,
  })

  it('already fulfilled: adds one Delivered event with the delivery time, never a second fulfilment', async () => {
    const markDelivered = vi.fn(async () => ({ id: 'gid://shopify/FulfillmentEvent/5', existing: false }))
    const createFulfillment = vi.fn()
    const h = harness(delivered({ status: 'FULFILLED', tracking_number: 'DL123', fulfillment_id: created.id, delivered_status: 'PENDING' }),
      { markDelivered, createFulfillment, fulfillmentState: vi.fn() })
    const out = await fulfillJob(job('FULFILL'), h.rpc, h.shopify, opts)
    expect(out).toMatchObject({ outcome: 'DONE', result: { delivered_event: 'gid://shopify/FulfillmentEvent/5' } })
    expect(markDelivered).toHaveBeenCalledExactlyOnceWith(created.id, '2026-10-10T08:00:00Z')
    expect(createFulfillment).not.toHaveBeenCalled()
    expect(h.saves).toEqual([{ delivered_status: 'MARKED', delivered_event_id: 'gid://shopify/FulfillmentEvent/5', delivered_error: '' }])
  })

  it('delivered before the fulfilment went out: fulfils, then marks delivered, in one run', async () => {
    const markDelivered = vi.fn(async () => ({ id: 'gid://shopify/FulfillmentEvent/6', existing: false }))
    const h = harness(delivered({ status: 'PENDING', tracking_number: null, delivered_status: 'PENDING' }),
      { fulfillmentState: async () => state(), createFulfillment: async () => created, markDelivered })
    const out = await fulfillJob(job('FULFILL'), h.rpc, h.shopify, opts)
    expect(out.outcome).toBe('DONE')
    expect(markDelivered).toHaveBeenCalledWith(created.id, '2026-10-10T08:00:00Z')
    expect(h.saves.map((x) => x.status ?? x.delivered_status)).toEqual(['PROCESSING', 'FULFILLED', 'MARKED'])
  })

  it('Shopify down while marking: keeps it pending and retries; missing permission: fails with the scope to add', async () => {
    const down = harness(delivered({ status: 'FULFILLED', tracking_number: 'DL123', fulfillment_id: created.id, delivered_status: 'PENDING' }),
      { markDelivered: async () => { throw new ChannelError('Shopify did not answer in time') } })
    expect(await fulfillJob(job('FULFILL'), down.rpc, down.shopify, opts)).toMatchObject({ outcome: 'RETRY' })
    expect(down.saves).toEqual([{ delivered_error: 'Shopify did not answer in time — will try again' }])

    const denied = harness(delivered({ status: 'FULFILLED', tracking_number: 'DL123', fulfillment_id: created.id, delivered_status: 'PENDING' }),
      { markDelivered: async () => { throw new ChannelError('Shopify refused: the app needs the write_fulfillments permission', 403, 'ACCESS_DENIED') } })
    expect(await fulfillJob(job('FULFILL'), denied.rpc, denied.shopify, opts)).toMatchObject({ outcome: 'FAILED' })
    expect(denied.saves[0]).toMatchObject({ delivered_status: 'FAILED', delivered_error: expect.stringMatching(/write_fulfillments/) })
  })

  it('not delivered (or already marked): nothing is sent', async () => {
    const markDelivered = vi.fn()
    const shipped = harness(fulfilCtx({ fulfillment: { status: 'FULFILLED', tracking_number: 'DL123', fulfillment_id: created.id, delivered_status: null } }), { markDelivered })
    expect(await fulfillJob(job('FULFILL'), shipped.rpc, shipped.shopify, opts)).toMatchObject({ outcome: 'DONE' })
    const marked = harness(delivered({ status: 'FULFILLED', tracking_number: 'DL123', fulfillment_id: created.id, delivered_status: 'MARKED' }), { markDelivered })
    expect(await fulfillJob(job('FULFILL'), marked.rpc, marked.shopify, opts)).toMatchObject({ outcome: 'DONE' })
    expect(markDelivered).not.toHaveBeenCalled()
  })

  it('fulfilled by hand in Shopify: that fulfilment is marked delivered', async () => {
    const markDelivered = vi.fn(async () => ({ id: 'gid://shopify/FulfillmentEvent/7', existing: true }))
    const h = harness(delivered({ status: 'SKIPPED', tracking_number: null, delivered_status: 'PENDING' }, { delivered_target: 'gid://shopify/Fulfillment/555' }), { markDelivered })
    expect(await fulfillJob(job('FULFILL'), h.rpc, h.shopify, opts)).toMatchObject({ outcome: 'DONE', result: { existing: true } })
    expect(markDelivered).toHaveBeenCalledWith('gid://shopify/Fulfillment/555', '2026-10-10T08:00:00Z')
  })
})

describe('Order status → Shopify (one job, each step once)', () => {
  const base = (over: Record<string, unknown> = {}) => fulfilCtx({
    sync: { cancel_status: null, paid_status: null, status_tag: null, events: {} },
    settings: { inventory_sync: true, mark_paid_on_delivery: true, status_tags: true, courier_events: true },
    status_tag: 'Status: Confirmed', merged_tag: null, delivered_target: null,
    fulfillment: null,
    ...over,
  })
  const harness2 = (ctx: unknown, port: Partial<ShopifyPort>) => {
    const syncSaves: Array<Record<string, unknown>> = []
    const h = harness(ctx, port)
    const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'channel_order_sync_update') { syncSaves.push(args.p as Record<string, unknown>); return null }
      return (h.rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<unknown>)(fn, args)
    }) as never
    return { ...h, rpc, syncSaves }
  }
  const st = (over = {}) => ({ cancelled: false, financialStatus: 'PENDING', tags: ['vip', 'Status: New'], fulfilled: false, ...over })

  it('cancelled here: cancels on Shopify without restocking there when this app sets Shopify stock (no double restock)', async () => {
    const cancelOrder = vi.fn(async () => 'gid://shopify/Job/1')
    const updateTags = vi.fn(async () => undefined)
    const h = harness2(base({ order: { id: 'o1', order_number: 'ISO-1', status: 'CANCELLED', external_order_id: '5001', customer_email: null }, status_tag: 'Status: Cancelled',
      sync: { cancel_status: 'PENDING', paid_status: null, status_tag: null, events: {} } }), { orderState: async () => st(), cancelOrder, updateTags })
    expect(await fulfillJob(job('FULFILL'), h.rpc, h.shopify, opts)).toMatchObject({ outcome: 'DONE' })
    expect(cancelOrder).toHaveBeenCalledExactlyOnceWith('5001', expect.stringContaining('ISO-1'), false)
    expect(h.syncSaves[0]).toMatchObject({ cancel_status: 'REQUESTED', restocked_in_store: false })
    expect(updateTags).toHaveBeenCalledWith('5001', ['Status: Cancelled'], ['Status: New'])
  })

  it('stock not synced: Shopify restocks itself; already cancelled on Shopify: nothing sent; fulfilled on Shopify: refused with a clear reason', async () => {
    const cancelOrder = vi.fn(async () => 'j')
    const ctx = (over = {}) => base({ order: { id: 'o1', order_number: 'ISO-1', status: 'CANCELLED', external_order_id: '5001', customer_email: null },
      sync: { cancel_status: 'PENDING', paid_status: null, status_tag: 'x', events: {} }, settings: { inventory_sync: false, mark_paid_on_delivery: true, status_tags: false, courier_events: true }, ...over })
    const a = harness2(ctx(), { orderState: async () => st(), cancelOrder })
    await fulfillJob(job('FULFILL'), a.rpc, a.shopify, opts)
    expect(cancelOrder).toHaveBeenLastCalledWith('5001', expect.any(String), true)
    const b = harness2(ctx(), { orderState: async () => st({ cancelled: true }), cancelOrder })
    await fulfillJob(job('FULFILL'), b.rpc, b.shopify, opts)
    expect(b.syncSaves[0]).toMatchObject({ cancel_status: 'CONFIRMED' })
    const c = harness2(ctx(), { orderState: async () => st({ fulfilled: true }), cancelOrder })
    await fulfillJob(job('FULFILL'), c.rpc, c.shopify, opts)
    expect(c.syncSaves[0]).toMatchObject({ cancel_status: 'FAILED', cancel_error: expect.stringMatching(/fulfilled on Shopify/) })
    expect(cancelOrder).toHaveBeenCalledTimes(1)
  })

  it('delivered (cash on delivery): Delivered event, marked paid once, tag updated; a second run sends nothing', async () => {
    const markDelivered = vi.fn(async () => ({ id: 'ev1', existing: false }))
    const markPaid = vi.fn(async () => 'PAID')
    const updateTags = vi.fn(async () => undefined)
    const delivered = (sync: Record<string, unknown>, fulfillment: Record<string, unknown>) => base({
      order: { id: 'o1', order_number: 'ISO-1', status: 'DELIVERED', external_order_id: '5001', customer_email: null, payment_method: 'COD', delivered_at: '2026-10-10T08:00:00Z', was_delivered: true },
      fulfillment, delivered_target: 'gid://shopify/Fulfillment/9', status_tag: 'Status: Delivered', sync })
    const port = { orderState: async () => st({ tags: ['Status: Shipped'] }), markDelivered, markPaid, updateTags }
    const first = harness2(delivered({ cancel_status: null, paid_status: null, status_tag: 'Status: Shipped', events: {} },
      { status: 'FULFILLED', tracking_number: 'DL1', fulfillment_id: 'gid://shopify/Fulfillment/9', delivered_status: 'PENDING' }), port)
    expect(await fulfillJob(job('FULFILL'), first.rpc, first.shopify, opts)).toMatchObject({ outcome: 'DONE' })
    expect(markDelivered).toHaveBeenCalledTimes(1)
    expect(markPaid).toHaveBeenCalledExactlyOnceWith('5001')
    expect(updateTags).toHaveBeenCalledWith('5001', ['Status: Delivered'], ['Status: Shipped'])
    const again = harness2(delivered({ cancel_status: null, paid_status: 'MARKED', status_tag: 'Status: Delivered', events: {} },
      { status: 'FULFILLED', tracking_number: 'DL1', fulfillment_id: 'gid://shopify/Fulfillment/9', delivered_status: 'MARKED' }), port)
    await fulfillJob(job('FULFILL'), again.rpc, again.shopify, opts)
    expect(markDelivered).toHaveBeenCalledTimes(1)
    expect(markPaid).toHaveBeenCalledTimes(1)
    expect(updateTags).toHaveBeenCalledTimes(1)
  })

  it('courier updates: failed delivery → Attempted delivery; returned without delivery → Failure; each once', async () => {
    const markEvent = vi.fn(async (_f: string, s: string) => ({ id: `ev-${s}`, existing: false }))
    const ctx = (status: string, events = {}) => base({ order: { id: 'o1', order_number: 'ISO-1', status, external_order_id: '5001', customer_email: null, was_delivered: false },
      fulfillment: { status: 'FULFILLED', tracking_number: 'DL1', fulfillment_id: 'F9', delivered_status: null }, delivered_target: 'F9',
      sync: { cancel_status: null, paid_status: null, status_tag: 'x', events }, settings: { inventory_sync: true, mark_paid_on_delivery: true, status_tags: false, courier_events: true } })
    const a = harness2(ctx('FAILED_DELIVERY'), { markEvent })
    await fulfillJob(job('FULFILL'), a.rpc, a.shopify, opts)
    expect(markEvent).toHaveBeenLastCalledWith('F9', 'ATTEMPTED_DELIVERY', null)
    expect(a.syncSaves[0]).toMatchObject({ events: { ATTEMPTED_DELIVERY: 'ev-ATTEMPTED_DELIVERY' } })
    const b = harness2(ctx('RETURNED', { ATTEMPTED_DELIVERY: 'x' }), { markEvent })
    await fulfillJob(job('FULFILL'), b.rpc, b.shopify, opts)
    expect(markEvent).toHaveBeenLastCalledWith('F9', 'FAILURE', null)
    const c = harness2(ctx('RETURNED', { FAILURE: 'ev' }), { markEvent })
    await fulfillJob(job('FULFILL'), c.rpc, c.shopify, opts)
    expect(markEvent).toHaveBeenCalledTimes(2)
  })
})

describe('Two-way stock', () => {
  it('a change made in Shopify (after the grace period) is applied here instead of being overwritten', async () => {
    const saves: Array<Record<string, unknown>> = []
    const calls: string[] = []
    const ctx = { variant_id: 'v1', inventory_item_id: 'i1', location_id: 'L1', policy: 'TWO_WAY', sync_on: true, desired: 9, track_inventory: true,
      last_pushed_qty: 10, shopify_available: 13, mismatch_since: new Date(Date.now() - (GRACE_SECONDS + 5) * 1000).toISOString(), sku: 'X' }
    const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
      calls.push(fn)
      if (fn === 'channel_inventory_context') return ctx
      if (fn === 'channel_inventory_update') saves.push(args.p as Record<string, unknown>)
      if (fn === 'channel_inventory_adopt_change') return { status: 'ADOPTED', change: 3 }
      return null
    }) as never
    const setAvailable = vi.fn()
    const out = await inventoryJob(job('INVENTORY'), rpc, () => ({ available: async () => 13, setAvailable }))
    expect(out).toMatchObject({ outcome: 'DONE', result: { taken_from_store: 13, change: 3 } })
    expect(calls).toContain('channel_inventory_adopt_change')
    expect(setAvailable).not.toHaveBeenCalled()
  })
})

describe('Order without a fulfilment', () => {
  it('a cancelled order that was never shipped: no fulfilment is touched, the tag still goes out', async () => {
    const updateTags = vi.fn(async () => undefined)
    const saves: string[] = []
    const ctx = fulfilCtx({ order: { id: 'o1', order_number: 'ISO-1', status: 'CANCELLED', external_order_id: '5001', customer_email: null },
      fulfillment: null, sync: { cancel_status: 'CONFIRMED', paid_status: null, status_tag: null, events: {} },
      settings: { inventory_sync: true, mark_paid_on_delivery: true, status_tags: true, courier_events: true }, status_tag: 'Status: Cancelled' })
    const rpc = vi.fn(async (fn: string) => { saves.push(fn); return fn === 'channel_fulfillment_context' ? ctx : null }) as never
    const out = await fulfillJob(job('FULFILL'), rpc, () => ({ orderState: async () => ({ cancelled: true, financialStatus: 'PENDING', tags: [], fulfilled: false }), updateTags }) as never, opts)
    expect(out.outcome).toBe('DONE')
    expect(saves).not.toContain('channel_fulfillment_update')
    expect(updateTags).toHaveBeenCalledWith('5001', ['Status: Cancelled'], [])
  })
})
