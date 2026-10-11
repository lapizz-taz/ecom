import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { appBase, isLocalBackend, storefrontBase } from './storefront.ts'

/** A fake client: the primary domain row and the store settings. */
const client = (store: Record<string, unknown>, primary: string | null = null) => ({
  from: (table: string) => {
    const result = table === 'store_domains' ? { data: primary ? { domain: primary } : null, error: null } : { data: { value: store }, error: null }
    const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => result }
    return chain
  },
}) as unknown as SupabaseClient

describe('site addresses', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('uses the live custom domain first, then STOREFRONT_URL, the website, PLATFORM_URL', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://abc.supabase.co')
    vi.stubEnv('STOREFRONT_URL', 'https://shop.example.com/')
    expect(await storefrontBase(client({ website_url: 'https://other.example.com' }, 'mystore.com'))).toBe('https://mystore.com')
    expect(await storefrontBase(client({ website_url: 'https://other.example.com' }))).toBe('https://shop.example.com')
    vi.stubEnv('STOREFRONT_URL', '')
    expect(await storefrontBase(client({ website_url: 'https://commerce.example.com/' }))).toBe('https://commerce.example.com')
    vi.stubEnv('PLATFORM_URL', 'https://app.example.com')
    expect(await storefrontBase(client({ website_url: 'not a url' }))).toBe('https://app.example.com')
  })

  it('never falls back to localhost in production', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://abc.supabase.co')
    vi.stubEnv('STOREFRONT_URL', '')
    vi.stubEnv('PLATFORM_URL', '')
    expect(isLocalBackend()).toBe(false)
    await expect(storefrontBase(client({}))).rejects.toMatchObject({ code: 'SITE_URL_MISSING' })
    expect(() => appBase()).toThrow(/PLATFORM_URL/)
    // A plain-http origin is not trusted in production.
    expect(() => appBase(new Request('https://x', { headers: { origin: 'http://localhost:3000' } }))).toThrow()
    expect(appBase(new Request('https://x', { headers: { origin: 'https://app.example.com' } }))).toBe('https://app.example.com')
  })

  it('uses localhost only when the backend itself is local', async () => {
    vi.stubEnv('SUPABASE_URL', 'http://127.0.0.1:54321')
    vi.stubEnv('STOREFRONT_URL', '')
    vi.stubEnv('PLATFORM_URL', '')
    expect(await storefrontBase(client({}))).toBe('http://localhost:5173')
    expect(appBase()).toBe('http://localhost:5173')
    vi.stubEnv('PLATFORM_URL', 'https://app.example.com/')
    expect(appBase()).toBe('https://app.example.com')
  })
})
