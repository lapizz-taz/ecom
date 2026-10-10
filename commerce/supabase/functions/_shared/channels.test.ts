import { describe, expect, it, vi } from 'vitest'
import { hmacBase64, hmacHex } from './channels/common.ts'
import { normalizeShopifyOrder, ShopifyClient, shopifyClientToken, type ShopifyOrder, shopDomain, shopifyAuthUrl, verifyShopifyCallback, verifyShopifyWebhook } from './channels/shopify.ts'
import { normalizeWooOrder, siteUrl, verifyWooWebhook, WooClient, wooAuthUrl, type WooOrder } from './channels/woocommerce.ts'

const res = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const shopifyOrder = (over: Partial<ShopifyOrder> = {}): ShopifyOrder => ({
  id: 'gid://shopify/Order/5001', legacyResourceId: '5001', name: '#1001', createdAt: '2026-10-08T10:00:00Z', cancelledAt: null, test: false,
  email: 'rina@example.com', phone: null, note: 'Call before delivery', displayFinancialStatus: 'PENDING', paymentGatewayNames: ['Cash on Delivery (COD)'],
  currentTotalPriceSet: { shopMoney: { amount: '1520.00', currencyCode: 'BDT' } },
  totalShippingPriceSet: { shopMoney: { amount: '120.00' } }, totalDiscountsSet: { shopMoney: { amount: '100.00' } },
  totalOutstandingSet: { shopMoney: { amount: '1520.00' } },
  shippingAddress: { name: 'Rina Akter', phone: '+880 1712-345678', address1: 'House 9, Road 2', address2: 'Mirpur 10', city: 'Dhaka', province: null, zip: '1216' },
  billingAddress: null, customer: { firstName: 'Rina', lastName: 'Akter', email: null, phone: null },
  lineItems: { nodes: [{ title: 'Canvas Tote', variantTitle: 'Black', quantity: 2, currentQuantity: 2, sku: 'TOTE-BLK', originalUnitPriceSet: { shopMoney: { amount: '750.00' } }, image: { url: 'https://cdn.shopify.com/t.jpg' }, variant: { legacyResourceId: '777', sku: 'TOTE-BLK', product: { legacyResourceId: '70' } } }] },
  customerJourneySummary: { firstVisit: null, lastVisit: { landingPage: '/products/tote?utm_source=facebook&utm_medium=paid&utm_campaign=Eid&fbclid=abc', referrerUrl: 'https://m.facebook.com/', occurredAt: '2026-10-08T09:55:00Z' } },
  ...over,
})

describe('Shopify client credentials', () => {
  it('gets a token with no redirect and knows when it runs out', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ access_token: 'shpat_x', scope: 'read_orders,write_orders', expires_in: 86399 }), { status: 200 }))
    const t = await shopifyClientToken('mystore.myshopify.com', 'cid', 'secret', fetchFn as never)
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://mystore.myshopify.com/admin/oauth/access_token')
    expect(String(init.body)).toBe('grant_type=client_credentials&client_id=cid&client_secret=secret')
    expect(t.scopes).toEqual(['read_orders', 'write_orders'])
    const hours = (Date.parse(t.expiresAt) - Date.now()) / 3_600_000
    expect(hours).toBeGreaterThan(23.9)
    expect(hours).toBeLessThan(24)
  })

  it('explains a refused token instead of failing silently', async () => {
    const notInstalled = vi.fn(async () => new Response(JSON.stringify({ error: 'app_not_installed', error_description: 'The app is not installed' }), { status: 400 }))
    await expect(shopifyClientToken('s.myshopify.com', 'a', 'b', notInstalled as never)).rejects.toThrow(/Install the app on this store first/)
    const wrong = vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 }))
    await expect(shopifyClientToken('s.myshopify.com', 'a', 'b', wrong as never)).rejects.toThrow(/Check the Client ID and Client secret/)
  })
})

describe('Shopify', () => {
  it('accepts the store name, the myshopify address or the admin URL', () => {
    expect(shopDomain('mystore')).toBe('mystore.myshopify.com')
    expect(shopDomain('https://MyStore.myshopify.com/admin')).toBe('mystore.myshopify.com')
    expect(shopDomain('https://admin.shopify.com/store/my-store/orders')).toBe('my-store.myshopify.com')
    expect(shopDomain('evil.com')).toBeNull()
    expect(shopDomain('a.myshopify.com.evil.com')).toBeNull()
  })

  it('sends staff to the store\'s approval screen with the scopes we need', () => {
    const url = new URL(shopifyAuthUrl('mystore.myshopify.com', 'abc123', 'st', 'https://x.supabase.co/functions/v1/channels/callback/shopify'))
    expect(url.host).toBe('mystore.myshopify.com')
    expect(url.searchParams.get('scope')).toBe('read_orders,write_orders,read_draft_orders,write_draft_orders,read_products,write_products,read_inventory,write_inventory,read_locations,write_locations,read_merchant_managed_fulfillment_orders,write_merchant_managed_fulfillment_orders,read_fulfillments,write_fulfillments,read_returns,write_returns')
    expect(url.searchParams.get('scope')).not.toContain('read_customers')
    expect(url.searchParams.get('state')).toBe('st')
  })

  it('checks the callback and webhook signatures and rejects tampering', async () => {
    const params = new URLSearchParams({ code: 'c0de', shop: 'mystore.myshopify.com', state: 'st', timestamp: '1700000000' })
    params.set('hmac', await hmacHex('secret', 'code=c0de&shop=mystore.myshopify.com&state=st&timestamp=1700000000'))
    expect(await verifyShopifyCallback(params, 'secret')).toBe(true)
    params.set('shop', 'other.myshopify.com')
    expect(await verifyShopifyCallback(params, 'secret')).toBe(false)

    const body = JSON.stringify({ id: 5001 })
    const sig = await hmacBase64('secret', body)
    expect(await verifyShopifyWebhook(body, sig, 'secret')).toBe(true)
    expect(await verifyShopifyWebhook(body.replace('5001', '5002'), sig, 'secret')).toBe(false)
    expect(await verifyShopifyWebhook(body, null, 'secret')).toBe(false)
  })

  it('turns an order into ours: phone, address, lines, unpaid COD and the ad it came from', () => {
    const o = normalizeShopifyOrder(shopifyOrder())
    expect(o).toMatchObject({
      external_id: '5001', number: '#1001', cancelled: false,
      customer: { name: 'Rina Akter', phone: '+880 1712-345678', email: 'rina@example.com' },
      shipping: { address: 'House 9, Road 2, Mirpur 10', city: 'Dhaka', postal_code: '1216', district_hint: 'Dhaka' },
      shipping_price: 120, discount_total: 100, total: 1520, paid_amount: 0, currency: 'BDT',
    })
    expect(o.lines).toEqual([{ external_variant_id: '777', external_product_id: '70', sku: 'TOTE-BLK', title: 'Canvas Tote', variant_title: 'Black', quantity: 2, unit_price: 750, image_url: 'https://cdn.shopify.com/t.jpg' }])
    expect(o.attribution?.last_touch).toMatchObject({ landing: '/products/tote?utm_source=facebook&utm_medium=paid&utm_campaign=Eid&fbclid=abc', referrer: 'https://m.facebook.com/', params: { utm_source: 'facebook', utm_campaign: 'Eid', fbclid: 'abc' } })
    // Paid online: the amount received counts as paid; no visit info → no source is invented.
    const paid = normalizeShopifyOrder(shopifyOrder({ totalOutstandingSet: { shopMoney: { amount: '0.00' } }, customerJourneySummary: null }))
    expect(paid.paid_amount).toBe(1520)
    expect(paid.attribution).toBeNull()
  })

  it('reports a failed check when Shopify hides customer data from the app', async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const q = String(JSON.parse(String(init!.body)).query)
      if (q.includes('currentAppInstallation')) return res({ data: { shop: { name: 'My Store', currencyCode: 'BDT' }, currentAppInstallation: { accessScopes: [{ handle: 'read_orders' }, { handle: 'read_customers' }, { handle: 'read_products' }] } } })
      if (q.includes('shippingAddress')) return res({ data: { orders: { nodes: [{ name: '#1001', shippingAddress: null }] } }, errors: [{ message: 'This app is not approved to access the Order object. See https://shopify.dev/docs/apps/launch/protected-customer-data' }] })
      if (q.includes('webhookSubscriptions')) return res({ data: { webhookSubscriptions: { nodes: [
        { id: 'gid://1', topic: 'ORDERS_CREATE', uri: 'https://x/webhook/1' }, { id: 'gid://2', topic: 'ORDERS_CANCELLED', uri: 'https://x/webhook/1' }, { id: 'gid://3', topic: 'APP_UNINSTALLED', uri: 'https://x/webhook/1' }, { id: 'gid://4', topic: 'ORDERS_UPDATED', uri: 'https://x/webhook/1' }] } } })
      throw new Error(`unexpected ${q}`)
    })
    const t = await new ShopifyClient('mystore.myshopify.com', 'shpat_x', fetchFn as typeof fetch).test('https://x/webhook/1', [])
    // Orders-only app: fulfilment and stock sync are flagged as warnings, not failures.
    expect(Object.fromEntries(t.checks.map((c) => [c.key, c.status]))).toEqual({
      store: 'ok', scopes: 'ok', fulfilment: 'warn', inventory: 'warn', customer_data: 'fail', webhooks: 'ok', currency: 'ok' })
    const [, init] = fetchFn.mock.calls[0]
    expect((init!.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe('shpat_x')
  })

  it('says plainly when the token is rejected', async () => {
    const t = await new ShopifyClient('mystore.myshopify.com', 'bad', (async () => res({ errors: 'Invalid API key or access token' }, 401)) as typeof fetch).test('https://x', [])
    expect(t.checks).toEqual([{ key: 'store', label: 'Store reachable', status: 'fail', detail: expect.stringContaining('rejected the access token') }])
  })
})

const wooOrder = (over: Partial<WooOrder> = {}): WooOrder => ({
  id: 812, number: '812', status: 'processing', currency: 'BDT', date_created_gmt: '2026-10-08T10:00:00', date_paid_gmt: null,
  total: '1310.00', shipping_total: '60.00', discount_total: '0.00', payment_method: 'cod', payment_method_title: 'Cash on delivery',
  customer_note: '', billing: { first_name: 'Karim', last_name: 'Uddin', address_1: 'Agrabad', city: 'Chattogram', state: 'BD-10', phone: '01812345678', email: 'k@example.com' },
  shipping: { first_name: '', last_name: '', address_1: '', city: '', state: '', phone: '' },
  line_items: [{ product_id: 40, variation_id: 41, name: 'Leather Belt - Brown', quantity: 1, subtotal: '1250.00', sku: 'BELT-BRN', image: { src: 'https://shop.com/belt.jpg' } }],
  meta_data: [{ key: '_wc_order_attribution_utm_source', value: 'facebook' }, { key: '_wc_order_attribution_session_entry', value: 'https://shop.com/belt?fbclid=x1' }],
  ...over,
})

describe('WooCommerce', () => {
  it('only takes secure store addresses', () => {
    expect(siteUrl('shop.com')).toBe('https://shop.com')
    expect(siteUrl('https://shop.com/wp-admin/')).toBe('https://shop.com')
    expect(siteUrl('https://shop.com/store/')).toBe('https://shop.com/store')
    expect(siteUrl('http://shop.com')).toBeNull()
    expect(siteUrl('https://user:pw@shop.com')).toBeNull()
  })

  it('asks the owner to approve Read/Write keys on their own site', () => {
    const url = new URL(wooAuthUrl('https://shop.com', 'OMS', 'st', 'https://admin.app/admin/channels', 'https://x/functions/v1/channels/callback/woocommerce'))
    expect(url.origin + url.pathname).toBe('https://shop.com/wc-auth/v1/authorize')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ scope: 'read_write', user_id: 'st', callback_url: 'https://x/functions/v1/channels/callback/woocommerce' })
  })

  it('checks webhook signatures', async () => {
    const body = JSON.stringify(wooOrder())
    expect(await verifyWooWebhook(body, await hmacBase64('whsec', body), 'whsec')).toBe(true)
    expect(await verifyWooWebhook(body, await hmacBase64('other', body), 'whsec')).toBe(false)
  })

  it('reads the Bangladesh state code as the district and keeps COD unpaid', () => {
    const o = normalizeWooOrder(wooOrder())
    expect(o).toMatchObject({
      external_id: '812', number: '#812', cancelled: false,
      customer: { name: 'Karim Uddin', phone: '01812345678' },
      shipping: { address: 'Agrabad', city: 'Chattogram', district_hint: 'Chattogram' },
      total: 1310, shipping_price: 60, paid_amount: 0,
      lines: [{ external_variant_id: '41', sku: 'BELT-BRN', unit_price: 1250, quantity: 1 }],
    })
    expect(o.attribution?.last_touch?.params).toMatchObject({ utm_source: 'facebook', fbclid: 'x1' })
    expect(normalizeWooOrder(wooOrder({ payment_method: 'bkash', date_paid_gmt: '2026-10-08T10:01:00' })).paid_amount).toBe(1310)
    expect(normalizeWooOrder(wooOrder({ status: 'cancelled' })).cancelled).toBe(true)
  })

  it('falls back to keys in the query when the host drops the Authorization header', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      const u = new URL(url)
      if (!u.searchParams.get('consumer_key')) return res({ code: 'woocommerce_rest_cannot_view', message: 'Sorry, you cannot list resources.' }, 401)
      return res([{ id: 812 }])
    })
    const client = new WooClient('https://shop.com', `ck_${'a'.repeat(40)}`, `cs_${'b'.repeat(40)}`, fetchFn as typeof fetch)
    await client.ordersSince('2026-10-01T00:00:00Z')
    expect(fetchFn).toHaveBeenCalledTimes(2)
    await client.webhooks()
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })

  it('explains a blocked API (HTML instead of JSON) and wrong permalinks', async () => {
    const html = new WooClient('https://shop.com', 'ck', 'cs', (async () => new Response('<html>Just a moment…</html>', { status: 200 })) as typeof fetch)
    expect((await html.test('https://x')).checks[1]).toMatchObject({ status: 'fail', detail: expect.stringContaining('firewall') })
    const plain = new WooClient('https://shop.com', 'ck', 'cs', (async () => new Response('<html>404</html>', { status: 404 })) as typeof fetch)
    expect((await plain.test('https://x')).checks[1]).toMatchObject({ status: 'fail', detail: expect.stringContaining('Permalinks') })
  })
})
