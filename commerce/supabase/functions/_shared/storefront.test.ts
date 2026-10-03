import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { storefrontBase } from './storefront.ts'

const withStore = (store: Record<string, unknown>) => ({
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { value: store }, error: null }) }) }) }),
}) as unknown as SupabaseClient

describe('storefront address', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('prefers STOREFRONT_URL, then the website in Settings, never localhost in production', async () => {
    vi.stubEnv('STOREFRONT_URL', 'https://shop.example.com/')
    expect(await storefrontBase(withStore({ website_url: 'https://other.example.com' }))).toBe('https://shop.example.com')
    vi.stubEnv('STOREFRONT_URL', '')
    expect(await storefrontBase(withStore({ website_url: 'https://commerce.example.com/' }))).toBe('https://commerce.example.com')
    expect(await storefrontBase(withStore({ website_url: 'not a url' }))).toBe('http://localhost:5173')
  })
})
