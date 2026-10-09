// Shopify Admin GraphQL API. Two ways in:
//   * OAuth with the store's own app (client ID + secret): staff approve on
//     Shopify, we get an offline access token;
//   * an Admin API access token from a custom app, plus its API secret (used to
//     check that webhooks really come from Shopify).
// Webhooks are signed with the app secret (X-Shopify-Hmac-Sha256); we check
// every one before reading it.
import { env } from '../env.ts'
import { type Check, ChannelError, clean, hmacBase64, hmacHex, money, type NormalizedOrder, safeEqual, type SeenFulfillment, touchFrom } from './common.ts'

type FetchFn = typeof fetch

export const SHOPIFY_API_VERSION = '2026-07'
/**
 * Exactly what the features use:
 *   read_orders                     import orders, read their fulfilments (+ order webhooks)
 *   read_customers                  the order's customer name / e-mail / phone fields
 *   read_products                   catalog import (variants, SKUs, barcodes)
 *   read_inventory, write_inventory read and set quantities (+ inventory webhook)
 *   read_locations                  choose the location to keep in step
 *   read/write_merchant_managed_fulfillment_orders   create fulfilments with tracking
 */
export const SHOPIFY_SCOPES = [
  'read_orders', 'read_customers', 'read_products', 'read_inventory', 'write_inventory', 'read_locations',
  'read_merchant_managed_fulfillment_orders', 'write_merchant_managed_fulfillment_orders',
]
/** Needed for importing orders; the connection fails without them. */
export const SHOPIFY_TOPICS = ['ORDERS_CREATE', 'ORDERS_CANCELLED', 'ORDERS_UPDATED', 'APP_UNINSTALLED'] as const
/** Nice to have (faster fulfilment / stock news); a store that refuses them still works through orders/updated and the hourly check. */
export const SHOPIFY_OPTIONAL_TOPICS = ['FULFILLMENTS_CREATE', 'FULFILLMENTS_UPDATE', 'INVENTORY_LEVELS_UPDATE'] as const

/** "mystore", "mystore.myshopify.com" or the admin URL → "mystore.myshopify.com" (or null if it isn't one). */
export function shopDomain(input: string): string | null {
  let v = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  const admin = /^admin\.shopify\.com$/.test(v) ? /\/store\/([a-z0-9][a-z0-9-]*)/.exec(input.toLowerCase())?.[1] : null
  if (admin) v = admin
  if (/^[a-z0-9][a-z0-9-]*$/.test(v)) v = `${v}.myshopify.com`
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(v) ? v : null
}

export function shopifyAuthUrl(shop: string, clientId: string, state: string, redirectUri: string): string {
  const q = new URLSearchParams({ client_id: clientId, scope: SHOPIFY_SCOPES.join(','), redirect_uri: redirectUri, state })
  return `https://${shop}/admin/oauth/authorize?${q.toString()}`
}

/** The callback's hmac: every other query parameter, sorted, signed with the app secret. */
export async function verifyShopifyCallback(params: URLSearchParams, secret: string): Promise<boolean> {
  const given = params.get('hmac') ?? ''
  const message = [...params.entries()].filter(([k]) => k !== 'hmac' && k !== 'signature')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&')
  return given.length > 0 && safeEqual(await hmacHex(secret, message), given)
}

export async function verifyShopifyWebhook(rawBody: string, header: string | null, secret: string): Promise<boolean> {
  return !!header && safeEqual(await hmacBase64(secret, rawBody), header)
}

export async function exchangeShopifyCode(shop: string, clientId: string, clientSecret: string, code: string, fetchFn: FetchFn = fetch) {
  let res: Response
  try {
    res = await fetchFn(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }), signal: AbortSignal.timeout(20_000),
    })
  } catch {
    throw new ChannelError('Could not reach Shopify to finish connecting')
  }
  const body = (await res.json().catch(() => null)) as { access_token?: string; scope?: string; error_description?: string } | null
  if (!res.ok || !body?.access_token) throw new ChannelError(`Shopify did not give an access token${body?.error_description ? `: ${body.error_description}` : ` (HTTP ${res.status})`}`, res.status)
  return { accessToken: body.access_token, scopes: (body.scope ?? '').split(',').filter(Boolean) }
}

interface GqlError { message: string; extensions?: { code?: string } }

const ORDER_FIELDS = `
  id legacyResourceId name createdAt cancelledAt test email phone note displayFinancialStatus paymentGatewayNames
  currentTotalPriceSet { shopMoney { amount currencyCode } }
  totalShippingPriceSet { shopMoney { amount } }
  totalDiscountsSet { shopMoney { amount } }
  totalOutstandingSet { shopMoney { amount } }
  shippingAddress { name firstName lastName phone address1 address2 city province zip }
  billingAddress { name phone address1 address2 city province zip }
  customer { firstName lastName email phone }
  lineItems(first: 100) { nodes {
    title variantTitle quantity currentQuantity sku
    originalUnitPriceSet { shopMoney { amount } }
    image { url }
    variant { legacyResourceId sku product { legacyResourceId } }
  } }
  customerJourneySummary {
    firstVisit { landingPage referrerUrl occurredAt }
    lastVisit { landingPage referrerUrl occurredAt }
  }
  displayFulfillmentStatus
  fulfillments(first: 10) { id status displayStatus createdAt trackingInfo(first: 3) { company number url } }`

export class ShopifyClient {
  constructor(readonly shop: string, private readonly token: string, private readonly fetchFn: FetchFn = fetch) {}

  private endpoint() {
    const base = env('SHOPIFY_API_BASE')?.replace(/\/+$/, '') ?? `https://${this.shop}`
    return `${base}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`
  }

  /** Raw call: data plus GraphQL errors (some errors only hide part of the data). */
  async raw<T>(query: string, variables: Record<string, unknown> = {}): Promise<{ data: T | null; errors: GqlError[] }> {
    let res: Response
    try {
      res = await this.fetchFn(this.endpoint(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Shopify-Access-Token': this.token },
        body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30_000),
      })
    } catch (error) {
      throw new ChannelError((error as Error).name === 'TimeoutError' ? 'Shopify did not answer in time' : `Could not reach ${this.shop}`)
    }
    if (res.status === 401 || res.status === 403) throw new ChannelError('Shopify rejected the access token. Connect the store again.', res.status, 'UNAUTHORIZED')
    if (res.status === 404) throw new ChannelError(`${this.shop} was not found on Shopify`, 404, 'NOT_FOUND')
    if (res.status === 402) throw new ChannelError('This Shopify store is frozen (unpaid plan)', 402, 'FROZEN')
    if (res.status === 429) throw new ChannelError('Shopify is rate limiting; try again in a minute', 429, 'RATE_LIMITED')
    const body = (await res.json().catch(() => null)) as { data?: T; errors?: GqlError[] | string } | null
    if (!body) throw new ChannelError(`Shopify answered HTTP ${res.status} without a body`, res.status)
    const errors = typeof body.errors === 'string' ? [{ message: body.errors }] : body.errors ?? []
    return { data: body.data ?? null, errors }
  }

  async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const { data, errors } = await this.raw<T>(query, variables)
    if (errors.length && !data) throw new ChannelError(`Shopify: ${errors.map((e) => e.message).join('; ')}`)
    if (errors.some((e) => e.extensions?.code === 'ACCESS_DENIED')) throw new ChannelError(`Shopify: ${errors[0].message}`, 403, 'ACCESS_DENIED')
    return data as T
  }

  async shop_(): Promise<{ name: string; currency: string; scopes: string[] }> {
    const d = await this.gql<{ shop: { name: string; currencyCode: string }; currentAppInstallation: { accessScopes: Array<{ handle: string }> } }>(
      '{ shop { name currencyCode } currentAppInstallation { accessScopes { handle } } }')
    return { name: d.shop.name, currency: d.shop.currencyCode, scopes: d.currentAppInstallation.accessScopes.map((s) => s.handle) }
  }

  async order(gid: string): Promise<NormalizedOrder | null> {
    const id = gid.startsWith('gid://') ? gid : `gid://shopify/Order/${gid}`
    const { data, errors } = await this.raw<{ order: ShopifyOrder | null }>(`query($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`, { id })
    if (!data?.order) {
      if (errors.length) throw new ChannelError(`Shopify: ${errors.map((e) => e.message).join('; ')}`)
      return null
    }
    return normalizeShopifyOrder(data.order)
  }

  /** Orders created since a date (newest first), up to `max`. */
  async ordersSince(sinceIso: string, max = 250): Promise<NormalizedOrder[]> {
    const out: NormalizedOrder[] = []
    let after: string | null = null
    while (out.length < max) {
      const d: { orders: { nodes: ShopifyOrder[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await this.gql(
        `query($q: String!, $after: String) { orders(first: 50, after: $after, sortKey: CREATED_AT, reverse: true, query: $q) {
          pageInfo { hasNextPage endCursor } nodes { ${ORDER_FIELDS} } } }`,
        { q: `created_at:>=${sinceIso}`, after })
      out.push(...d.orders.nodes.map(normalizeShopifyOrder))
      if (!d.orders.pageInfo.hasNextPage) break
      after = d.orders.pageInfo.endCursor
    }
    return out.slice(0, max)
  }

  async webhooks(): Promise<Array<{ id: string; topic: string; url: string | null }>> {
    // Newer API versions call the address `uri`; older ones `endpoint.callbackUrl`.
    const modern = await this.raw<{ webhookSubscriptions: { nodes: Array<{ id: string; topic: string; uri?: string }> } }>(
      '{ webhookSubscriptions(first: 100) { nodes { id topic uri } } }')
    if (modern.data?.webhookSubscriptions && !modern.errors.length) {
      return modern.data.webhookSubscriptions.nodes.map((n) => ({ id: n.id, topic: n.topic, url: n.uri ?? null }))
    }
    const legacy = await this.gql<{ webhookSubscriptions: { nodes: Array<{ id: string; topic: string; endpoint?: { callbackUrl?: string } }> } }>(
      '{ webhookSubscriptions(first: 100) { nodes { id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } } }')
    return legacy.webhookSubscriptions.nodes.map((n) => ({ id: n.id, topic: n.topic, url: n.endpoint?.callbackUrl ?? null }))
  }

  /** Our webhooks pointing at `url`; existing ones are reused. */
  async ensureWebhooks(url: string): Promise<Array<{ id: string; topic: string }>> {
    const existing = (await this.webhooks()).filter((w) => w.url === url)
    const out: Array<{ id: string; topic: string }> = []
    for (const topic of [...SHOPIFY_TOPICS, ...SHOPIFY_OPTIONAL_TOPICS]) {
      const have = existing.find((w) => w.topic === topic)
      if (have) { out.push({ id: have.id, topic }); continue }
      try {
        out.push({ id: await this.createWebhook(topic, url), topic })
      } catch (error) {
        if ((SHOPIFY_TOPICS as readonly string[]).includes(topic)) throw error
        // Optional: a store without that permission still works.
      }
    }
    return out
  }

  // --- fulfilment ------------------------------------------------------------------------

  /** Fulfilment orders (what can still be fulfilled) and fulfilments made so far. */
  async fulfillmentState(orderId: string): Promise<FulfillmentState> {
    const id = orderId.startsWith('gid://') ? orderId : `gid://shopify/Order/${orderId}`
    type R = { order: {
      id: string; email: string | null; displayFulfillmentStatus: string | null
      fulfillmentOrders: { nodes: Array<{ id: string; status: string; lineItems: { nodes: Array<{ id: string; remainingQuantity: number; lineItem: { sku: string | null; variant: { legacyResourceId: string } | null } }> } }> }
      fulfillments: ShopifyFulfillment[]
    } | null }
    const d = await this.gql<R>(`query($id: ID!) { order(id: $id) {
      id email displayFulfillmentStatus
      fulfillmentOrders(first: 20) { nodes { id status lineItems(first: 100) { nodes { id remainingQuantity lineItem { sku variant { legacyResourceId } } } } } }
      fulfillments(first: 20) { id status displayStatus createdAt trackingInfo(first: 3) { company number url } }
    } }`, { id })
    if (!d.order) throw new ChannelError('This order no longer exists in Shopify', 404, 'NOT_FOUND')
    const all = d.order.displayFulfillmentStatus === 'FULFILLED'
    return {
      email: d.order.email,
      fulfillmentOrders: d.order.fulfillmentOrders.nodes.map((fo) => ({
        id: fo.id, status: fo.status,
        lines: fo.lineItems.nodes.map((l) => ({ id: l.id, remaining: l.remainingQuantity, variant: l.lineItem.variant?.legacyResourceId ?? null, sku: l.lineItem.sku })),
      })),
      fulfillments: d.order.fulfillments.map((f) => seenFulfillment(f, all)),
    }
  }

  /** Creates the fulfilment. Throws on any user error; returns Shopify's record. */
  async createFulfillment(input: {
    groups: FulfillmentGroup[]; notifyCustomer: boolean; tracking: { company: string | null; number: string | null; url: string | null } | null
  }): Promise<SeenFulfillment> {
    const fulfillment: Record<string, unknown> = {
      lineItemsByFulfillmentOrder: input.groups.map((g) => ({
        fulfillmentOrderId: g.fulfillmentOrderId,
        fulfillmentOrderLineItems: g.lines.map((l) => ({ id: l.id, quantity: l.quantity })),
      })),
      notifyCustomer: input.notifyCustomer,
    }
    if (input.tracking?.number) {
      fulfillment.trackingInfo = { company: input.tracking.company ?? undefined, number: input.tracking.number, ...(input.tracking.url ? { url: input.tracking.url } : {}) }
    }
    type R = { fulfillmentCreate: { fulfillment: ShopifyFulfillment | null; userErrors: Array<{ field: string[] | null; message: string }> } | null }
    const { data, errors } = await this.raw<R>(`mutation($f: FulfillmentInput!) { fulfillmentCreate(fulfillment: $f) {
      fulfillment { id status displayStatus createdAt trackingInfo(first: 3) { company number url } }
      userErrors { field message } } }`, { f: fulfillment })
    if (errors.some((e) => e.extensions?.code === 'ACCESS_DENIED')) {
      throw new ChannelError('Shopify refused: the app needs the fulfilment permissions (write_merchant_managed_fulfillment_orders). Update the app scopes and connect again.', 403, 'ACCESS_DENIED')
    }
    const res = data?.fulfillmentCreate
    if (!res) throw new ChannelError(`Shopify: ${errors.map((e) => e.message).join('; ') || 'no answer'}`)
    if (!res.fulfillment) throw new ChannelError(`Shopify would not fulfil: ${res.userErrors.map((e) => e.message).join('; ')}`, 422, 'USER_ERROR')
    return seenFulfillment(res.fulfillment, false)
  }

  // --- inventory --------------------------------------------------------------------------

  async locations(): Promise<Array<{ id: string; name: string; active: boolean }>> {
    const d = await this.gql<{ locations: { nodes: Array<{ id: string; name: string; isActive: boolean }> } }>(
      '{ locations(first: 50) { nodes { id name isActive } } }')
    return d.locations.nodes.map((l) => ({ id: l.id, name: l.name, active: l.isActive }))
  }

  /** Every variant with its inventory item and per-location available quantity (up to `max`). */
  async catalog(max = 2000): Promise<CatalogItem[]> {
    const out: CatalogItem[] = []
    let after: string | null = null
    while (out.length < max) {
      type R = { productVariants: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<{
        legacyResourceId: string; sku: string | null; barcode: string | null; title: string
        product: { legacyResourceId: string; title: string; status: string }
        inventoryItem: { id: string; tracked: boolean; inventoryLevels: { nodes: Array<{ location: { id: string; name: string }; quantities: Array<{ name: string; quantity: number }> }> } } | null
      }> } }
      const d: R = await this.gql<R>(`query($after: String) { productVariants(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { legacyResourceId sku barcode title product { legacyResourceId title status }
          inventoryItem { id tracked inventoryLevels(first: 10) { nodes { location { id name } quantities(names: ["available", "on_hand"]) { name quantity } } } } } } }`,
        { after })
      for (const v of d.productVariants.nodes) {
        out.push({
          external_variant_id: String(v.legacyResourceId), external_product_id: String(v.product.legacyResourceId),
          inventory_item_id: v.inventoryItem?.id ?? null, sku: clean(v.sku), barcode: clean(v.barcode),
          product_title: v.product.title, variant_title: v.title, product_status: v.product.status, tracked: v.inventoryItem?.tracked ?? false,
          levels: (v.inventoryItem?.inventoryLevels.nodes ?? []).map((l) => ({
            location_id: l.location.id, location: l.location.name,
            available: l.quantities.find((q) => q.name === 'available')?.quantity ?? null,
            on_hand: l.quantities.find((q) => q.name === 'on_hand')?.quantity ?? null,
          })),
        })
      }
      if (!d.productVariants.pageInfo.hasNextPage) break
      after = d.productVariants.pageInfo.endCursor
    }
    return out
  }

  /** Available quantity of one item at one location (null when not stocked there). */
  async available(inventoryItemId: string, locationId: string): Promise<number | null> {
    const d = await this.gql<{ inventoryItem: { inventoryLevel: { quantities: Array<{ name: string; quantity: number }> } | null } | null }>(
      `query($id: ID!, $loc: ID!) { inventoryItem(id: $id) { inventoryLevel(locationId: $loc) { quantities(names: ["available"]) { name quantity } } } }`,
      { id: inventoryItemId, loc: locationId })
    if (!d.inventoryItem) throw new ChannelError('This inventory item no longer exists in Shopify', 404, 'NOT_FOUND')
    return d.inventoryItem.inventoryLevel?.quantities.find((q) => q.name === 'available')?.quantity ?? null
  }

  /**
   * Sets the available quantity, only if Shopify still has `from` (compare-and-set).
   * The idempotency key makes a retried request apply once.
   */
  async setAvailable(inventoryItemId: string, locationId: string, quantity: number, from: number | null, key: string): Promise<void> {
    type R = { inventorySetQuantities: { inventoryAdjustmentGroup: { id: string } | null; userErrors: Array<{ field: string[] | null; message: string; code: string | null }> } | null }
    const { data, errors } = await this.raw<R>(`mutation($input: InventorySetQuantitiesInput!, $key: String!) {
      inventorySetQuantities(input: $input) @idempotent(key: $key) { inventoryAdjustmentGroup { id } userErrors { field message code } } }`, {
      key,
      input: { name: 'available', reason: 'correction', quantities: [{ inventoryItemId, locationId, quantity, changeFromQuantity: from }] },
    })
    if (errors.some((e) => e.extensions?.code === 'ACCESS_DENIED')) {
      throw new ChannelError('Shopify refused: the app needs write_inventory. Update the app scopes and connect again.', 403, 'ACCESS_DENIED')
    }
    const res = data?.inventorySetQuantities
    if (!res) throw new ChannelError(`Shopify: ${errors.map((e) => e.message).join('; ') || 'no answer'}`)
    if (res.userErrors.length) {
      const stale = res.userErrors.some((e) => /CHANGE_FROM|COMPARE|stale|does not match/i.test(`${e.code} ${e.message}`))
      throw new ChannelError(`Shopify would not set the quantity: ${res.userErrors.map((e) => e.message).join('; ')}`, 409, stale ? 'STALE' : 'USER_ERROR')
    }
  }

  private async createWebhook(topic: string, url: string): Promise<string> {
    const mutation = `mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { webhookSubscription { id } userErrors { field message } } }`
    type R = { webhookSubscriptionCreate: { webhookSubscription: { id: string } | null; userErrors: Array<{ message: string }> } }
    let r = await this.raw<R>(mutation, { topic, sub: { uri: url, format: 'JSON' } })
    if (!r.data?.webhookSubscriptionCreate && r.errors.some((e) => /uri/i.test(e.message))) {
      r = await this.raw<R>(mutation, { topic, sub: { callbackUrl: url, format: 'JSON' } })
    }
    const res = r.data?.webhookSubscriptionCreate
    if (!res) throw new ChannelError(`Shopify would not add the ${topic} webhook: ${r.errors.map((e) => e.message).join('; ') || 'no answer'}`)
    if (!res.webhookSubscription) throw new ChannelError(`Shopify would not add the ${topic} webhook: ${res.userErrors.map((e) => e.message).join('; ')}`)
    return res.webhookSubscription.id
  }

  async removeWebhooks(ids: string[]): Promise<void> {
    for (const id of ids) {
      await this.raw('mutation($id: ID!) { webhookSubscriptionDelete(id: $id) { deletedWebhookSubscriptionId userErrors { message } } }', { id })
        .catch(() => undefined)
    }
  }

  /** The connection test staff see: every step that importing orders depends on. */
  async test(webhookUrl: string, storedWebhookIds: string[]): Promise<{ checks: Check[]; name: string | null; currency: string | null; scopes: string[] }> {
    const checks: Check[] = []
    let info: Awaited<ReturnType<ShopifyClient['shop_']>>
    try {
      info = await this.shop_()
      checks.push({ key: 'store', label: 'Store reachable', status: 'ok', detail: `${info.name} (${this.shop})` })
    } catch (error) {
      const e = error as ChannelError
      checks.push({ key: 'store', label: 'Store reachable', status: 'fail', detail: e.message })
      return { checks, name: null, currency: null, scopes: [] }
    }
    const has = (x: string) => info.scopes.includes(x) || info.scopes.includes(x.replace('read_', 'write_'))
    const missing = ['read_orders'].filter((x) => !has(x))
    const soft = ['read_customers', 'read_products'].filter((x) => !has(x))
    const fulfil = ['write_merchant_managed_fulfillment_orders'].filter((x) => !info.scopes.includes(x))
    const stock = ['read_inventory', 'write_inventory', 'read_locations'].filter((x) => !info.scopes.includes(x))
    checks.push(fulfil.length
      ? { key: 'fulfilment', label: 'Fulfilment on Shopify', status: 'warn', detail: 'Add read/write_merchant_managed_fulfillment_orders to the app, then connect again, so shipped orders are fulfilled on Shopify with tracking' }
      : { key: 'fulfilment', label: 'Fulfilment on Shopify', status: 'ok', detail: 'Shipped orders are fulfilled on Shopify with the courier tracking link' })
    checks.push(stock.length
      ? { key: 'inventory', label: 'Stock sync', status: 'warn', detail: `Add ${stock.join(', ')} to the app, then connect again, to keep Shopify stock in step` }
      : { key: 'inventory', label: 'Stock sync', status: 'ok', detail: 'Stock can be kept in step (turn it on under Shopify sync)' })
    checks.push(missing.length
      ? { key: 'scopes', label: 'Permissions', status: 'fail', detail: `Missing ${missing.join(', ')} — allow it in the app's Admin API access scopes` }
      : soft.length
        ? { key: 'scopes', label: 'Permissions', status: 'warn', detail: `Orders OK; also allow ${soft.join(', ')} for customer names and product details` }
        : { key: 'scopes', label: 'Permissions', status: 'ok', detail: 'Orders, customers and products' })

    // Customer name, phone and address are "protected customer data" on Shopify.
    if (!missing.length) {
      const r = await this.raw<{ orders: { nodes: Array<{ name: string; shippingAddress: { phone: string | null; address1: string | null } | null }> } }>(
        '{ orders(first: 1, sortKey: CREATED_AT, reverse: true) { nodes { name shippingAddress { phone address1 } } } }')
      const denied = r.errors.find((e) => /protected customer data|not approved to access|access denied/i.test(e.message))
      const last = r.data?.orders.nodes[0]
      checks.push(denied
        ? { key: 'customer_data', label: 'Customer details', status: 'fail', detail: 'Shopify hides names, phones and addresses from this app. In the app settings, request access to protected customer data (name, phone, address).' }
        : !last
          ? { key: 'customer_data', label: 'Customer details', status: 'warn', detail: 'No orders yet to check — place a test order to confirm phone and address come through' }
          : !last.shippingAddress?.phone
            ? { key: 'customer_data', label: 'Customer details', status: 'warn', detail: `Order ${last.name} has no phone number. Make phone required at checkout (Settings → Checkout).` }
            : { key: 'customer_data', label: 'Customer details', status: 'ok', detail: `Name, phone and address come through (checked ${last.name})` })
    }

    try {
      const hooks = (await this.webhooks()).filter((w) => w.url === webhookUrl || storedWebhookIds.includes(w.id))
      const need = SHOPIFY_TOPICS.filter((t) => !hooks.some((h) => h.topic === t))
      checks.push(need.length
        ? { key: 'webhooks', label: 'Instant order updates', status: 'fail', detail: `Not set up: ${need.join(', ').toLowerCase()} — click "Fix webhooks"` }
        : { key: 'webhooks', label: 'Instant order updates', status: 'ok', detail: 'New and cancelled orders arrive within seconds' })
    } catch (error) {
      checks.push({ key: 'webhooks', label: 'Instant order updates', status: 'fail', detail: (error as Error).message })
    }
    checks.push(info.currency === 'BDT'
      ? { key: 'currency', label: 'Currency', status: 'ok', detail: 'BDT' }
      : { key: 'currency', label: 'Currency', status: 'warn', detail: `Store currency is ${info.currency}; amounts are imported as they are, not converted` })
    return { checks, name: info.name, currency: info.currency, scopes: info.scopes }
  }
}

interface Money { shopMoney: { amount: string; currencyCode?: string } }
export interface ShopifyOrder {
  id: string; legacyResourceId: string; name: string; createdAt: string; cancelledAt: string | null; test: boolean
  email: string | null; phone: string | null; note: string | null; displayFinancialStatus: string | null; paymentGatewayNames: string[] | null
  currentTotalPriceSet: Money | null; totalShippingPriceSet: Money | null; totalDiscountsSet: Money | null; totalOutstandingSet: Money | null
  shippingAddress: Address | null; billingAddress: Address | null
  customer: { firstName: string | null; lastName: string | null; email: string | null; phone: string | null } | null
  lineItems: { nodes: Array<{
    title: string; variantTitle: string | null; quantity: number; currentQuantity?: number | null; sku: string | null
    originalUnitPriceSet: Money | null; image: { url: string } | null
    variant: { legacyResourceId: string; sku: string | null; product: { legacyResourceId: string } | null } | null
  }> }
  customerJourneySummary?: { firstVisit: Visit | null; lastVisit: Visit | null } | null
  displayFulfillmentStatus?: string | null
  fulfillments?: ShopifyFulfillment[]
}
export interface ShopifyFulfillment {
  id: string; status: string | null; displayStatus: string | null; createdAt: string | null
  trackingInfo: Array<{ company: string | null; number: string | null; url: string | null }> | null
}
export interface FulfillmentGroup { fulfillmentOrderId: string; lines: Array<{ id: string; quantity: number; variant: string | null }> }
export interface FulfillmentState {
  email: string | null
  fulfillmentOrders: Array<{ id: string; status: string; lines: Array<{ id: string; remaining: number; variant: string | null; sku: string | null }> }>
  fulfillments: SeenFulfillment[]
}
export interface CatalogItem {
  external_variant_id: string; external_product_id: string; inventory_item_id: string | null; sku: string | null; barcode: string | null
  product_title: string; variant_title: string; product_status: string; tracked: boolean
  levels: Array<{ location_id: string; location: string; available: number | null; on_hand: number | null }>
}

export function seenFulfillment(f: ShopifyFulfillment, allFulfilled: boolean): SeenFulfillment {
  const t = f.trackingInfo?.[0]
  return {
    id: f.id, status: f.status, display_status: f.displayStatus, created_at: f.createdAt,
    tracking_company: t?.company ?? null, tracking_number: t?.number ?? null, tracking_url: t?.url ?? null, all_fulfilled: allFulfilled,
  }
}

/** Fulfilments in an orders/updated or fulfillments/* webhook (REST shape). */
export function seenFromWebhook(body: Record<string, unknown>): SeenFulfillment[] {
  type Rest = { admin_graphql_api_id?: string; id?: number; status?: string; shipment_status?: string | null; created_at?: string
    tracking_company?: string | null; tracking_number?: string | null; tracking_numbers?: string[]; tracking_url?: string | null; tracking_urls?: string[] }
  const list: Rest[] = Array.isArray(body.fulfillments) ? body.fulfillments as Rest[] : body.order_id ? [body as Rest] : []
  const all = body.fulfillment_status === 'fulfilled'
  return list.filter((f) => f.admin_graphql_api_id || f.id).map((f) => ({
    id: f.admin_graphql_api_id ?? `gid://shopify/Fulfillment/${f.id}`,
    status: f.status ? f.status.toUpperCase() : null, display_status: f.shipment_status ? f.shipment_status.toUpperCase() : null,
    tracking_company: f.tracking_company ?? null, tracking_number: f.tracking_number ?? f.tracking_numbers?.[0] ?? null,
    tracking_url: f.tracking_url ?? f.tracking_urls?.[0] ?? null, created_at: f.created_at ?? null, all_fulfilled: all,
  }))
}

/**
 * Which Shopify fulfilment-order lines to fulfil for what we are shipping:
 * our quantity per Shopify variant, taken from open fulfilment orders, never
 * more than Shopify says is remaining (so a partly fulfilled order only gets
 * the rest, and quantities we removed stay unfulfilled).
 */
export function planFulfillment(
  ours: Array<{ external_variant_id: string | null; sku: string | null; quantity: number }>,
  fos: FulfillmentState['fulfillmentOrders'],
): { groups: FulfillmentGroup[]; unmatched: string[] } {
  const want = new Map<string, number>()
  const unmatched: string[] = []
  const open = fos.filter((fo) => ['OPEN', 'IN_PROGRESS', 'SCHEDULED'].includes(fo.status))
  for (const l of ours) {
    if (l.quantity <= 0) continue
    const key = l.external_variant_id
      ?? open.flatMap((fo) => fo.lines).find((x) => x.sku && l.sku && x.sku.toLowerCase() === l.sku.toLowerCase())?.variant
      ?? null
    if (!key) { unmatched.push(l.sku ?? 'item'); continue }
    want.set(key, (want.get(key) ?? 0) + l.quantity)
  }
  const groups: FulfillmentGroup[] = []
  for (const fo of open) {
    const lines: FulfillmentGroup['lines'] = []
    for (const line of fo.lines) {
      const need = line.variant ? want.get(line.variant) ?? 0 : 0
      const take = Math.min(need, line.remaining)
      if (take > 0) {
        lines.push({ id: line.id, quantity: take, variant: line.variant })
        want.set(line.variant!, need - take)
      }
    }
    if (lines.length) groups.push({ fulfillmentOrderId: fo.id, lines })
  }
  return { groups, unmatched }
}
interface Address { name?: string | null; firstName?: string | null; lastName?: string | null; phone: string | null; address1: string | null; address2: string | null; city: string | null; province: string | null; zip: string | null }
interface Visit { landingPage: string | null; referrerUrl: string | null; occurredAt: string | null }

export function normalizeShopifyOrder(o: ShopifyOrder): NormalizedOrder {
  const a = o.shippingAddress ?? o.billingAddress
  const customerName = [o.customer?.firstName, o.customer?.lastName].filter(Boolean).join(' ')
  const total = money(o.currentTotalPriceSet?.shopMoney.amount)
  const outstanding = money(o.totalOutstandingSet?.shopMoney.amount ?? total)
  const visit = (v: Visit | null | undefined) => v ? touchFrom(v.landingPage, v.referrerUrl, v.occurredAt) : null
  const first = visit(o.customerJourneySummary?.firstVisit)
  const last = visit(o.customerJourneySummary?.lastVisit)
  return {
    external_id: String(o.legacyResourceId),
    number: o.name ?? null,
    created_at: o.createdAt ?? null,
    cancelled: !!o.cancelledAt,
    test: !!o.test,
    customer: {
      name: clean(a?.name) ?? clean([a?.firstName, a?.lastName].filter(Boolean).join(' ')) ?? clean(customerName),
      phone: clean(a?.phone) ?? clean(o.phone) ?? clean(o.billingAddress?.phone) ?? clean(o.customer?.phone),
      email: clean(o.email) ?? clean(o.customer?.email),
    },
    shipping: {
      address: clean([a?.address1, a?.address2].filter(Boolean).join(', ')),
      area: null, city: clean(a?.city), state: clean(a?.province), postal_code: clean(a?.zip), district_hint: clean(a?.province) ?? clean(a?.city),
    },
    lines: o.lineItems.nodes.map((l) => ({
      external_variant_id: l.variant?.legacyResourceId ? String(l.variant.legacyResourceId) : null,
      external_product_id: l.variant?.product?.legacyResourceId ? String(l.variant.product.legacyResourceId) : null,
      sku: clean(l.sku) ?? clean(l.variant?.sku),
      title: l.title,
      variant_title: clean(l.variantTitle),
      quantity: l.currentQuantity ?? l.quantity,
      unit_price: money(l.originalUnitPriceSet?.shopMoney.amount),
      image_url: l.image?.url ?? null,
    })),
    shipping_price: money(o.totalShippingPriceSet?.shopMoney.amount),
    discount_total: money(o.totalDiscountsSet?.shopMoney.amount),
    total,
    paid_amount: Math.max(money(total - outstanding), 0),
    currency: o.currentTotalPriceSet?.shopMoney.currencyCode ?? null,
    gateway: clean((o.paymentGatewayNames ?? []).join(', ')),
    note: clean(o.note),
    attribution: first || last ? { first_touch: first ?? last, last_touch: last ?? first } : null,
    fulfillments: (o.fulfillments ?? []).map((f) => seenFulfillment(f, o.displayFulfillmentStatus === 'FULFILLED')),
  }
}
