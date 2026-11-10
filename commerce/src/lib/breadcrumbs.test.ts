import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callName, clearCrumbs, crumb, lastFailedCall, maskDigits, noteRequestId, trackedFetch, trail } from './breadcrumbs'

beforeEach(() => clearCrumbs())

describe('the steps before an error', () => {
  it('names API calls without their contents', () => {
    expect(callName('https://x.supabase.co/rest/v1/rpc/approve_orders', 'POST')).toBe('rpc approve_orders')
    expect(callName('https://x.supabase.co/rest/v1/orders?select=*&phone=eq.01711', 'GET')).toBe('read orders')
    expect(callName('https://x.supabase.co/rest/v1/products?id=eq.1', 'PATCH')).toBe('update products')
    expect(callName('https://fullfilio.com/functions/v1/inbox', 'POST', '{"action":"history_import","id":"c1","days":30}')).toBe('fn inbox/history_import')
    expect(callName('https://fullfilio.com/functions/v1/courier', 'POST', 'not json')).toBe('fn courier')
    expect(callName('https://x.supabase.co/auth/v1/token?grant_type=refresh_token', 'POST')).toBe('auth token')
    expect(callName('https://cdn.example.com/a.js')).toBeNull()
  })

  it('keeps the last 30 steps, one line for a call repeated with the same outcome, with clock times', () => {
    crumb({ t: 'nav', to: '/admin/orders' }, 1_000)
    for (let i = 0; i < 5; i++) crumb({ t: 'call', name: 'rpc unread_count', status: 200, ms: 40 }, 2_000 + i)
    crumb({ t: 'call', name: 'rpc approve_orders', status: 500, ms: 300 }, 3_000)
    crumb({ t: 'call', name: 'rpc approve_orders', status: 500, ms: 310 }, 3_100)
    const t = trail()
    expect(t).toHaveLength(4)
    expect(t[1]).toMatchObject({ t: 'call', name: 'rpc unread_count', x: 5, at: new Date(2_004).toISOString() })
    expect(t[0].at).toBe('1970-01-01T00:00:01.000Z')
    for (let i = 0; i < 40; i++) crumb({ t: 'click', label: `Button ${i}` })
    expect(trail()).toHaveLength(30)
    expect(trail().at(-1)).toMatchObject({ label: 'Button 39' })
  })

  it('finds the call a "Something went wrong" was about, and its request id', () => {
    crumb({ t: 'call', name: 'fn inbox/history_import', status: 500, ms: 900 })
    crumb({ t: 'click', label: 'Bring old chats' })
    noteRequestId('fn inbox', 'a1b2c3d4e5f6')
    expect(lastFailedCall()).toMatchObject({ name: 'fn inbox/history_import', status: 500, request_id: 'a1b2c3d4e5f6' })
    clearCrumbs()
    crumb({ t: 'call', name: 'rpc x', status: 500, ms: 1 }, Date.now() - 60_000)
    expect(lastFailedCall()).toBeNull()
  })

  it('records each call through fetch: status, time, or that it failed', async () => {
    const ok = vi.fn(async () => new Response('{}', { status: 201 }))
    await trackedFetch(ok as unknown as typeof fetch, 'https://x.supabase.co/rest/v1/rpc/save_order', { method: 'POST' })
    const down = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    await expect(trackedFetch(down as unknown as typeof fetch, 'https://x.supabase.co/rest/v1/orders')).rejects.toThrow('Failed to fetch')
    await Promise.resolve()
    expect(trail().map((c) => [c.name, c.status])).toEqual([['rpc save_order', 201], ['read orders', 'failed']])
  })

  it('hides phone numbers in button labels', () => {
    expect(maskDigits('Call 01711999001')).toBe('Call •••••••••••')
    expect(maskDigits('Order 1016')).toBe('Order 1016')
  })
})
