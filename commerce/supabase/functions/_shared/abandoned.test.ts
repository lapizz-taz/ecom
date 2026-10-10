import { describe, expect, it, vi } from 'vitest'
import { abandonedRow, ShopifyClient } from './channels/shopify.ts'

const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

const node = {
  id: 'gid://shopify/AbandonedCheckout/31337', name: '#31337', abandonedCheckoutUrl: 'https://shop.example/123/checkouts/ac/abc/recover?key=k',
  createdAt: '2026-10-09T10:00:00Z', updatedAt: '2026-10-09T10:05:00Z', completedAt: null,
  totalPriceSet: { shopMoney: { amount: '1560.00', currencyCode: 'BDT' } }, subtotalPriceSet: { shopMoney: { amount: '1500.00' } },
  shippingAddress: { name: 'Mina Akter', phone: '+8801755000333', address1: 'House 4', address2: 'Road 7', city: 'Dhaka', province: 'Dhaka Division', country: 'Bangladesh' },
  customer: { firstName: 'Mina', lastName: 'Akter', defaultEmailAddress: { emailAddress: 'mina@example.com' }, defaultPhoneNumber: null },
  lineItems: { nodes: [{ title: 'Belt', variantTitle: 'Default Title', quantity: 2, sku: 'BLT', variant: { legacyResourceId: '99' }, originalUnitPriceSet: { shopMoney: { amount: '750.00' } }, image: null }] },
}

describe('abandonedRow', () => {
  it('maps a Shopify abandoned checkout, taking the phone from the address when the customer has none', () => {
    expect(abandonedRow(node)).toMatchObject({
      id: node.id, legacy_id: '31337', name: '#31337', recovery_url: node.abandonedCheckoutUrl, customer_name: 'Mina Akter',
      email: 'mina@example.com', phone: '+8801755000333', address: 'House 4, Road 7', city: 'Dhaka', province: 'Dhaka Division', country: 'Bangladesh',
      items: [{ title: 'Belt', variant: null, sku: 'BLT', quantity: 2, price: 750, external_variant_id: '99' }],
      item_count: 2, subtotal: 1500, total: 1560, currency: 'BDT', completed_at: null,
    })
  })
})

describe('ShopifyClient.abandonedCheckouts', () => {
  it('pages through results and asks only for checkouts since the date', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(reply({ data: { abandonedCheckouts: { nodes: [node], pageInfo: { hasNextPage: true, endCursor: 'c1' } } } }))
      .mockResolvedValueOnce(reply({ data: { abandonedCheckouts: { nodes: [{ ...node, id: 'gid://shopify/AbandonedCheckout/2' }], pageInfo: { hasNextPage: false, endCursor: null } } } }))
    const { rows, cursor } = await new ShopifyClient('t.myshopify.com', 'shpat_x', fetchFn).abandonedCheckouts({ since: '2026-10-01T00:00:00Z' })
    expect(rows.map((r) => r.legacy_id)).toEqual(['31337', '2'])
    expect(cursor).toBeNull()
    const first = JSON.parse(fetchFn.mock.calls[0][1].body)
    expect(first.variables).toMatchObject({ q: 'created_at:>=2026-10-01', after: null })
    expect(JSON.parse(fetchFn.mock.calls[1][1].body).variables.after).toBe('c1')
  })

  it('falls back to older field names when the API version lacks the newer ones', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(reply({ errors: [{ message: "Field 'defaultEmailAddress' doesn't exist on type 'Customer'", extensions: { code: 'undefinedField' } }] }))
      .mockResolvedValueOnce(reply({ data: { abandonedCheckouts: { nodes: [{ ...node, customer: { firstName: 'Mina', lastName: null, email: 'm@x.com', phone: '01755000333' } }], pageInfo: { hasNextPage: false, endCursor: null } } } }))
    const { rows } = await new ShopifyClient('t.myshopify.com', 'shpat_x', fetchFn).abandonedCheckouts({ since: '2026-10-01' })
    expect(rows[0]).toMatchObject({ email: 'm@x.com', phone: '01755000333', customer_name: 'Mina' })
    expect(JSON.parse(fetchFn.mock.calls[1][1].body).query).toContain('customer { firstName lastName email phone }')
  })

  it('explains a refused permission', async () => {
    const fetchFn = vi.fn().mockResolvedValue(reply({ errors: [{ message: 'Access denied for abandonedCheckouts field.', extensions: { code: 'ACCESS_DENIED' } }] }))
    await expect(new ShopifyClient('t.myshopify.com', 'shpat_x', fetchFn).abandonedCheckouts({ since: '2026-10-01' })).rejects.toThrow(/read_orders/)
  })

  it('imports the whole history in batches: stops at max and hands back the cursor to continue', async () => {
    const page = (n: number, cursor: string) => reply({ data: { abandonedCheckouts: {
      nodes: Array.from({ length: 20 }, (_, i) => ({ ...node, id: `gid://shopify/AbandonedCheckout/${n * 100 + i}` })), pageInfo: { hasNextPage: true, endCursor: cursor } } } })
    const fetchFn = vi.fn().mockResolvedValueOnce(page(1, 'c1')).mockResolvedValueOnce(page(2, 'c2'))
    const client = new ShopifyClient('t.myshopify.com', 'shpat_x', fetchFn)
    const first = await client.abandonedCheckouts({ since: null, max: 40 })
    expect(first.rows).toHaveLength(40)
    expect(first.cursor).toBe('c2')
    expect(JSON.parse(fetchFn.mock.calls[0][1].body).variables.q).toBeNull() // no date filter: everything
    fetchFn.mockResolvedValueOnce(reply({ data: { abandonedCheckouts: { nodes: [node], pageInfo: { hasNextPage: false, endCursor: 'c3' } } } }))
    const next = await client.abandonedCheckouts({ since: null, after: first.cursor, max: 40 })
    expect(JSON.parse(fetchFn.mock.calls[2][1].body).variables.after).toBe('c2')
    expect(next).toMatchObject({ cursor: null })
  })
})
