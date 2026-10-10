import { describe, expect, it, vi } from 'vitest'
import { catalogItem, grams, ShopifyClient } from './channels/shopify.ts'
import { wooCatalogItem } from './channels/woocommerce.ts'

const variant = {
  legacyResourceId: '4401', sku: ' SH-M ', barcode: '8901', title: 'M', price: '990.00', compareAtPrice: '1200.00',
  selectedOptions: [{ name: 'Size', value: 'M' }],
  inventoryItem: { id: 'gid://shopify/InventoryItem/77', tracked: true, unitCost: { amount: '410.50' }, measurement: { weight: { unit: 'KILOGRAMS', value: 0.25 } },
    inventoryLevels: { nodes: [{ location: { id: 'gid://shopify/Location/1', name: 'Warehouse' }, quantities: [{ name: 'available', quantity: 6 }, { name: 'on_hand', quantity: 7 }] }] } },
}
const product = { legacyResourceId: '4400', title: 'Linen shirt', status: 'ACTIVE', vendor: 'Isolation', productType: 'Shirts', tags: ['summer'], description: 'Light' }

describe('Shopify catalog data', () => {
  it('keeps SKU, barcode, prices, cost, weight in grams, vendor, type, tags and stock per location', () => {
    expect(catalogItem(variant, product)).toMatchObject({
      external_variant_id: '4401', external_product_id: '4400', inventory_item_id: 'gid://shopify/InventoryItem/77', sku: 'SH-M', barcode: '8901',
      price: '990.00', compare_at_price: '1200.00', unit_cost: '410.50', weight_grams: 250, vendor: 'Isolation', product_type: 'Shirts', tags: ['summer'],
      options: { Size: 'M' }, tracked: true, levels: [{ location_id: 'gid://shopify/Location/1', available: 6, on_hand: 7 }],
    })
    expect(grams({ unit: 'POUNDS', value: 1 })).toBe(454)
    expect(grams({ unit: 'GRAMS', value: 0 })).toBeNull()
  })

  it('reads the catalog in small pages (under the query cost limit), then the images, and retries when throttled', async () => {
    const bodies: string[] = []
    let throttled = false
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      const q = JSON.parse(String(init.body)).query as string
      bodies.push(q)
      if (q.includes('productVariants') && !throttled) {
        throttled = true
        return new Response(JSON.stringify({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }), { status: 200 })
      }
      if (q.includes('productVariants')) {
        return new Response(JSON.stringify({ data: { productVariants: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ ...variant, product }] } } }))
      }
      return new Response(JSON.stringify({ data: { products: { pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{ legacyResourceId: '4400', media: { nodes: [{ preview: { image: { url: 'https://cdn.shopify.com/a.jpg' } } }, { preview: { image: { url: 'https://cdn.shopify.com/b.jpg' } } }] } }] } } }))
    })
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const p = new ShopifyClient('x.myshopify.com', 'shpat_x', fetchFn as never).catalog()
    await vi.runAllTimersAsync()
    const items = await p
    vi.useRealTimers()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ images: ['https://cdn.shopify.com/a.jpg', 'https://cdn.shopify.com/b.jpg'], image_url: 'https://cdn.shopify.com/a.jpg' })
    expect(bodies.filter((b) => b.includes('productVariants'))).toHaveLength(2)
    expect(bodies[0]).toMatch(/productVariants\(first: 30/)
    expect(bodies[0]).toMatch(/inventoryLevels\(first: 5\)/)
  })
})

describe('WooCommerce catalog data', () => {
  it('takes cost from a cost-of-goods plugin, all images, tags and the first category', () => {
    const item = wooCatalogItem({ id: 10, name: 'Hoodie', type: 'variable', status: 'publish', manage_stock: false, stock_quantity: null,
      images: [{ src: 'https://w.example.com/1.jpg' }, { src: 'https://w.example.com/2.jpg' }], tags: [{ name: 'winter' }], categories: [{ name: 'Hoodies' }],
      meta_data: [{ key: '_wc_cog_cost', value: '650' }] },
    { id: 11, sku: 'HD-M', price: '1450', manage_stock: true, stock_quantity: 4, image: { src: 'https://w.example.com/2.jpg' }, attributes: [{ name: 'Size', option: 'M' }], meta_data: [] })
    expect(item).toMatchObject({ unit_cost: '650', images: ['https://w.example.com/2.jpg', 'https://w.example.com/1.jpg'], tags: ['winter'], product_type: 'Hoodies', sku: 'HD-M' })
  })
})
