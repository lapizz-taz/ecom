import { describe, expect, it } from 'vitest'
import { clerkProxyUrl } from './clerk'

describe('where the browser reaches Clerk', () => {
  it('own DNS (empty setting): straight to Clerk, no /__clerk relay', () => {
    expect(clerkProxyUrl('pk_live_abc', '')).toBeUndefined()
  })
  it('a configured relay address is used as is', () => {
    expect(clerkProxyUrl('pk_live_abc', '/__clerk')).toBe('/__clerk')
  })
  it('without the setting: production keys through /__clerk, development keys direct', () => {
    expect(clerkProxyUrl('pk_live_abc', undefined)).toBe('/__clerk')
    expect(clerkProxyUrl('pk_test_abc', undefined)).toBeUndefined()
  })
})
