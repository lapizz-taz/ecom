import { beforeEach, describe, expect, it, vi } from 'vitest'

// Stores opened by path (/s/<name>) and the Fullfilio website share one host: its cookies and its
// browser storage. A store's visitor id and ad clicks stay with that store (security audit run 6:
// the host-wide ff_vid cookie carried store A's id to store B and the website), and a store name
// that passes to another business does not hand it the previous owner's entries.
const g = globalThis as Record<string, unknown>
function memoryStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(), key: (i: number) => [...m.keys()][i] ?? null, get length() { return m.size },
  }
}
// One cookie jar for the whole host, like a browser's.
const jar = new Map<string, string>()
const doc = {
  get cookie() { return [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
  set cookie(v: string) { const [pair] = v.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim()) },
  getElementById: () => null,
}
const reload = vi.fn()
const loc = { protocol: 'https:', host: 'platform.example.invalid', hostname: 'platform.example.invalid', origin: 'https://platform.example.invalid', href: '', pathname: '/', search: '', reload }
const local = memoryStorage()
const session = memoryStorage()
Object.assign(g, { window: globalThis, document: doc, location: loc, localStorage: local, sessionStorage: session })
const at = (path: string, host = 'platform.example.invalid') => Object.assign(loc, { pathname: path, host, hostname: host, href: `https://${host}${path}` })
const STORE_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const STORE_B = 'bbbbbbbb-0000-4000-8000-000000000002'
const remember = (slug: string, merchant: string, host = 'platform.example.invalid') =>
  local.setItem(`site:v2:${host}:${slug}`, JSON.stringify({ kind: 'store', merchant_id: merchant, slug }))

async function fresh() {
  vi.resetModules()
  return { attribution: await import('./attribution'), merchant: await import('./merchant') }
}

beforeEach(() => {
  jar.clear()
  local.clear()
  session.clear()
  reload.mockClear()
})

describe('visitor id on a shared host', () => {
  it('path store A, path store B and the website each keep their own id; none is put in the host cookie', async () => {
    remember('store-a', STORE_A)
    remember('store-b', STORE_B)
    at('/s/store-a/', 'platform.example.invalid')
    const a = (await fresh()).attribution.visitorId()
    expect(jar.has('ff_vid')).toBe(false)

    at('/s/store-b/')
    const b = (await fresh()).attribution.visitorId()
    expect(b).not.toBe(a)

    // A host cookie someone else wrote is not taken over either.
    jar.set('ff_vid', a)
    at('/s/store-c/')
    expect((await fresh()).attribution.visitorId()).not.toBe(a)
    at('/')
    expect((await fresh()).attribution.visitorId()).not.toBe(a)
  })

  it("a store on its own address keeps the id in the cookie its server refreshes", async () => {
    remember('', STORE_A, 'shop.example.invalid')
    at('/', 'shop.example.invalid')
    jar.set('ff_vid', 'serverkept0001')
    expect((await fresh()).attribution.visitorId()).toBe('serverkept0001')
    local.clear()
    remember('', STORE_A, 'shop.example.invalid')
    jar.clear()
    const id = (await fresh()).attribution.visitorId()
    expect(jar.get('ff_vid')).toBe(id)
  })
})

describe('a store name that passes to another business', () => {
  it("drops the previous owner's entries for that name before anything reads them", async () => {
    at('/s/old-name/')
    remember('old-name', STORE_A)
    await fresh() // store A's visit stamps the name
    local.setItem('cart-v1@old-name', '{"items":["A shirt"]}')
    local.setItem('sf_attr@old-name', '{"first":{"params":{"utm_campaign":"A-spring"}}}')
    session.setItem('ff_ev_once@old-name', 'x')
    local.setItem('cart-v1@other-store', '{"items":["kept"]}')

    // The name now belongs to store B (the remembered answer says so after the reload).
    remember('old-name', STORE_B)
    await fresh()
    expect(local.getItem('cart-v1@old-name')).toBeNull()
    expect(local.getItem('sf_attr@old-name')).toBeNull()
    expect(session.getItem('ff_ev_once@old-name')).toBeNull()
    expect(local.getItem('cart-v1@other-store')).not.toBeNull()
    expect(local.getItem('owner@old-name')).toBe(STORE_B)
  })

  it('a lookup that finds a new owner drops the entries and reloads once', async () => {
    at('/s/old-name/')
    remember('old-name', STORE_A)
    const { merchant } = await fresh()
    local.setItem('cart-v1@old-name', '{"items":["A shirt"]}')
    await merchant.resolveSite(async () => ({ kind: 'store', merchant_id: STORE_B, slug: 'old-name' }))
    expect(local.getItem('cart-v1@old-name')).toBeNull()
    expect(reload).toHaveBeenCalledTimes(1)

    // After the reload the stamp and the answer agree: nothing more is dropped.
    reload.mockClear()
    local.setItem('cart-v1@old-name', '{"items":["B mug"]}')
    const again = (await fresh()).merchant
    await again.resolveSite(async () => ({ kind: 'store', merchant_id: STORE_B, slug: 'old-name' }))
    expect(local.getItem('cart-v1@old-name')).toContain('B mug')
    expect(reload).not.toHaveBeenCalled()
  })

  it("on a store's own address a new owner gets a clean slate", async () => {
    at('/', 'old-name.example.invalid')
    remember('', STORE_A, 'old-name.example.invalid')
    await fresh()
    local.setItem('cart-v1', '{"items":["A shirt"]}')
    local.setItem('sf_vid', 'storeAvisitor01')
    remember('', STORE_B, 'old-name.example.invalid')
    await fresh()
    expect(local.getItem('cart-v1')).toBeNull()
    expect(local.getItem('sf_vid')).toBeNull()
    expect(local.getItem('owner')).toBe(STORE_B)
  })
})
