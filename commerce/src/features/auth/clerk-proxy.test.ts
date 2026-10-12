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

describe('clerkSignedInHere (Clerk\'s cross-tab cookie)', () => {
  it('reads whether anyone is signed in to Clerk in this browser', async () => {
    const { clerkSignedInHere } = await import('@/features/auth/clerk')
    expect(clerkSignedInHere('a=1; __client_uat=1760284800; b=2')).toBe(true)
    expect(clerkSignedInHere('__client_uat_Xy12=1760284800')).toBe(true)
    expect(clerkSignedInHere('__client_uat=0; __client_uat_Xy12=0')).toBe(false)
    expect(clerkSignedInHere('__client_uat=0; __client_uat_Xy12=1760284800')).toBe(true)
    expect(clerkSignedInHere('a=1')).toBeNull()
    expect(clerkSignedInHere('')).toBeNull()
  })
})
