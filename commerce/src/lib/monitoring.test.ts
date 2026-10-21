import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({ supabase: { rpc: vi.fn(async () => ({ error: null })) } }))
vi.mock('@/lib/env', () => ({ env: { isDev: false, sentry: {} } }))

const { errorText } = await import('./monitoring')

describe('errorText', () => {
  it('keeps the message of a database error object (not "[object Object]")', () => {
    expect(errorText({ message: 'function platform_ads_report does not exist', code: 'PGRST202', details: null, hint: null }))
      .toBe('function platform_ads_report does not exist (PGRST202)')
  })
  it('handles errors, strings and anything else', () => {
    expect(errorText(new Error('boom'))).toBe('boom')
    expect(errorText('plain')).toBe('plain')
    expect(errorText({ status: 500 })).toBe('{"status":500}')
    expect(errorText(undefined)).toBe('undefined')
  })
})
