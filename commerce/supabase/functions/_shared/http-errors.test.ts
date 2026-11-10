import { describe, expect, it, vi } from 'vitest'

const logged: Array<{ message: string; context?: Record<string, unknown> }> = []
vi.mock('./monitoring.ts', () => ({
  functionName: () => 'orders',
  logEvent: (e: { message: string; context?: Record<string, unknown> }) => { logged.push(e); return Promise.resolve() },
}))

const { HttpError, fromDbError, handle } = await import('./http.ts')

const token = (claims: Record<string, unknown>) => `h.${btoa(JSON.stringify(claims)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')}.s`

describe('a failed request in the error tracker', () => {
  it('answers with a request id and logs the same id, the person, the business named and the path', async () => {
    const fn = handle(async () => { throw fromDbError({ message: 'null value in column "phone" violates not-null constraint', code: '23502' }) })
    const res = await fn(new Request('https://x.supabase.co/functions/v1/orders', {
      method: 'POST',
      headers: { authorization: `Bearer ${token({ sub: 'u-1', role: 'authenticated' })}`, 'x-merchant-id': '00000000-0000-4000-8000-000000000001' },
    }))
    expect(res.status).toBe(500)
    const body = await res.json() as { error: { code: string; message: string; request_id: string } }
    expect(body.error).toMatchObject({ code: 'INTERNAL', message: 'Something went wrong. Please try again.' })
    expect(body.error.request_id).toMatch(/^[0-9a-f]{12}$/)
    expect(logged.at(-1)).toMatchObject({
      message: 'null value in column "phone" violates not-null constraint',
      context: { request_id: body.error.request_id, user_id: 'u-1', merchant_hint: '00000000-0000-4000-8000-000000000001', path: '/functions/v1/orders', method: 'POST', status: 500 },
    })
  })

  it('an unexpected crash too; a service key names nobody; a 4xx answer has no id and is not logged', async () => {
    const crash = handle(async () => { throw new TypeError('x is undefined') })
    const res = await crash(new Request('https://x/functions/v1/orders', { method: 'POST', headers: { authorization: `Bearer ${token({ role: 'service_role' })}` } }))
    const body = await res.json() as { error: { request_id: string } }
    expect(logged.at(-1)?.context).toMatchObject({ request_id: body.error.request_id, user_id: undefined })
    const n = logged.length
    const bad = handle(async () => { throw new HttpError(422, 'Phone is required', 'VALIDATION') })
    const r2 = await bad(new Request('https://x/functions/v1/orders', { method: 'POST' }))
    expect(((await r2.json()) as { error: Record<string, unknown> }).error.request_id).toBeUndefined()
    expect(logged.length).toBe(n)
  })
})
