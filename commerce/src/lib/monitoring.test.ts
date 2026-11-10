import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.fn(async (..._args: unknown[]) => ({ error: null }))
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: (...args: unknown[]) => rpc(...args) } }))
vi.mock('@/lib/env', () => ({ env: { isDev: false, sentry: {} }, APP_RELEASE: '2026-11-10T06:30Z+abc1234' }))

const { errorText, noteErrorShown, reportError, setMonitoringPlatform, setMonitoringUser } = await import('./monitoring')
const { AppError } = await import('./errors')
const { clearCrumbs, crumb } = await import('./breadcrumbs')

const sent = () => rpc.mock.calls.map((c) => c[1] as { p_message: string; p_context: Record<string, any> })

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

describe('reports to the Super Admin error tracker', () => {
  let now = Date.parse('2026-11-10T06:00:00Z')
  beforeEach(() => {
    // Each case a few minutes apart: repeats and "just reported" are timed.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime((now += 5 * 60_000))
    rpc.mockClear()
    clearCrumbs()
    vi.stubGlobal('window', { location: { pathname: '/admin/orders/new' }, innerWidth: 390, innerHeight: 844 })
    vi.stubGlobal('navigator', { onLine: true, userAgent: 'Mozilla/5.0 (iPhone)' })
    setMonitoringUser({ id: 'u1', role: 'ORDER_MANAGER' })
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); setMonitoringUser(null); setMonitoringPlatform(false) })

  it('sends the error with the steps before it, the page and the app version', () => {
    crumb({ t: 'nav', to: '/admin/orders/new' })
    crumb({ t: 'click', label: 'Create order' })
    reportError(new TypeError(`Cannot read properties of undefined (reading 'phone') ${Math.random()}`), { mutation: ['create-order'] })
    const [r] = sent()
    expect(r.p_message).toMatch(/^Cannot read properties of undefined/)
    expect(r.p_context).toMatchObject({ app: 'admin', release: '2026-11-10T06:30Z+abc1234', path: '/admin/orders/new', mutation: ['create-order'], screen: '390x844' })
    expect(r.p_context.trail.map((c: any) => c.t)).toEqual(['nav', 'click'])
    expect(r.p_context.stack).toContain('TypeError')
  })

  it('a server function failure names the function and carries its request id', () => {
    const e = new AppError('Something went wrong. Please try again.', 'INTERNAL')
    e.source = 'inbox/history_import'
    e.requestId = 'a1b2c3d4e5f6'
    reportError(e)
    expect(sent()[0].p_message).toBe('inbox/history_import: Something went wrong. Please try again.')
    expect(sent()[0].p_context).toMatchObject({ code: 'INTERNAL', request_id: 'a1b2c3d4e5f6', function: 'inbox/history_import' })
  })

  it('skips expected outcomes, browser noise, repeats within 30 seconds, and people who are not staff', () => {
    reportError(new AppError('Phone is required', 'VALIDATION'))
    reportError(new Error('ResizeObserver loop completed with undelivered notifications.'))
    reportError(new Error('This Page is already connected'), {})
    reportError(new Error('This Page is already connected'), {})
    expect(sent()).toHaveLength(1)
    setMonitoringUser(null)
    reportError(new Error(`customer side ${Math.random()}`))
    expect(sent()).toHaveLength(1)
    setMonitoringPlatform(true)
    vi.stubGlobal('window', { location: { pathname: '/super-admin/health' }, innerWidth: 1, innerHeight: 1 })
    reportError(new Error(`panel ${Math.random()}`))
    expect(sent()[1].p_context.app).toBe('super-admin')
  })

  it('a "Something went wrong" message is reported with the call that failed just before it', () => {
    crumb({ t: 'call', name: 'rpc approve_orders', status: 500, ms: 120 })
    noteErrorShown('Something went wrong. Please try again.', 'Something went wrong. Please try again.')
    expect(sent()[0].p_message).toBe('"Something went wrong. Please try again." shown after rpc approve_orders answered 500')
    expect(sent()[0].p_context.generic).toBe(true)
    // Right after the error itself was reported, the message is not reported again.
    noteErrorShown('Something went wrong', 'Something went wrong')
    expect(sent()).toHaveLength(1)
  })
})
