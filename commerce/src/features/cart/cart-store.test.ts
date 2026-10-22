import { describe, expect, it, vi } from 'vitest'

// Stores opened by path (/s/<name>) share the platform's origin and its browser storage. Each store
// keeps its own cart (security audit run 5: store A's cart lines reached store B's checkout pixels).
const g = globalThis as Record<string, unknown>
function memoryStorage() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, get length() { return m.size }, keys: () => [...m.keys()] }
}
const loc = { protocol: 'https:', host: 'platform.example.invalid', href: '', pathname: '/', search: '', hostname: 'platform.example.invalid', origin: 'https://platform.example.invalid', reload: () => {} }
const local = memoryStorage()
Object.assign(g, { window: globalThis, location: loc, localStorage: local, sessionStorage: memoryStorage() })
const item = (id: string, name: string) => ({ variantId: id, productId: `p-${id}`, slug: id, name, variantTitle: null, price: 500, image: null, maxQuantity: 5 })
const at = (path: string) => Object.assign(loc, { pathname: path, href: `https://platform.example.invalid${path}` })

describe('cart per store', () => {
  it('a cart from one store opened by path is not loaded in another', async () => {
    at('/s/store-a/product/shirt')
    const a = await import('./cart-store')
    a.useCart.getState().add(item('va', 'Store A shirt'), 1, false)
    expect(local.getItem('cart-v1@store-a')).toContain('Store A shirt')
    expect(local.getItem('cart-v1')).toBeNull()

    vi.resetModules()
    at('/s/store-b/product/mug')
    const b = await import('./cart-store')
    expect(b.useCart.getState().items).toEqual([])

    vi.resetModules()
    at('/s/store-a/cart')
    const again = await import('./cart-store')
    expect(again.useCart.getState().items.map((i) => i.name)).toEqual(['Store A shirt'])
  })

  it('the old shared key is dropped on a path store; a store on its own domain keeps its plain key', async () => {
    local.setItem('cart-v1', JSON.stringify({ state: { items: [item('vx', 'Old shared')], couponCode: '' }, version: 0 }))
    vi.resetModules()
    at('/s/store-c/')
    const c = await import('./cart-store')
    expect(c.useCart.getState().items).toEqual([])
    expect(local.getItem('cart-v1')).toBeNull()

    const { storeKey } = await import('@/lib/merchant')
    at('/product/tee')
    expect(storeKey('sf_vid')).toBe('sf_vid')
    at('/s/store-d/checkout')
    expect(storeKey('sf_vid')).toBe('sf_vid@store-d')
  })
})
