// Anonymous requests are refused before a large body is read (security audit run 4): the inbox
// asks who is calling first; the Clerk proxy and webhook read through the bounded readers.
import { describe, expect, it, vi } from 'vitest'

const H = vi.hoisted(() => ({ pulled: 0, fetched: false, secret: false, user: null as null | { id: string }, staffAtPull: -1 }))

vi.mock('./monitoring.ts', async (importOriginal) => ({ ...(await importOriginal<typeof import('./monitoring.ts')>()), logEvent: () => Promise.resolve() }))
vi.mock('./cron.ts', async (importOriginal) => ({ ...(await importOriginal<typeof import('./cron.ts')>()), isCronRequest: async () => false }))
vi.mock('./supabase.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./supabase.ts')>()),
  adminClient: () => ({}),
  optionalUser: async () => H.user,
  // A signed-in account that is nobody's staff (a shopper who registered on a store).
  requireStaff: async () => { H.staffAtPull = H.pulled; throw new (await import('./http.ts')).HttpError(403, 'Staff access required', 'PERMISSION_DENIED') },
}))
vi.mock('./clerk.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./clerk.ts')>()),
  clerkProxySetting: async () => 'https://example.invalid/__clerk',
  clerkSecret: async () => 'sk_test_dummy',
  clerkWebhookSecret: async () => { H.secret = true; return 'whsec_ZHVtbXlkdW1teWR1bW15ZHVtbXk=' },
}))

function stream(total: number): ReadableStream<Uint8Array> {
  let sent = 0
  return new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (sent >= total) return ctrl.close()
      const n = Math.min(64 * 1024, total - sent)
      sent += n
      H.pulled += n
      ctrl.enqueue(new Uint8Array(n).fill(0x61))
    },
  }, { highWaterMark: 0 })
}
const post = (url: string, total: number) =>
  new Request(url, { method: 'POST', body: stream(total), headers: { 'content-type': 'application/json' }, duplex: 'half' } as RequestInit)
const MB = 1024 * 1024

describe('large anonymous bodies', () => {
  it('the inbox answers 401 without reading the body', async () => {
    H.pulled = 0
    const inbox = (await import('../inbox/handler.ts')).default
    const res = await inbox(post('https://fullfilio.test/functions/v1/inbox', 14 * MB))
    expect(res.status).toBe(401)
    expect(H.pulled).toBe(0)
  })

  it('a signed-in account that is not staff is refused before the body is read (audit run 5)', async () => {
    H.pulled = 0
    H.user = { id: '00000000-0000-4000-8000-0000000000aa' }
    const inbox = (await import('../inbox/handler.ts')).default
    const res = await inbox(post('https://fullfilio.test/functions/v1/inbox', 14 * MB))
    H.user = null
    expect(res.status).toBe(403)
    expect(H.staffAtPull).toBe(0)
    expect(H.pulled).toBe(0)
  })

  it('the Clerk proxy stops reading past 1 MB and never calls Clerk', async () => {
    H.pulled = 0
    H.fetched = false
    vi.stubGlobal('fetch', async () => { H.fetched = true; return new Response('ok') })
    const proxy = (await import('../clerk-proxy/handler.ts')).default
    const res = await proxy(post('https://fullfilio.test/functions/v1/clerk-proxy/v1/client', 32 * MB))
    vi.unstubAllGlobals()
    expect(res.status).toBe(413)
    expect(H.fetched).toBe(false)
    expect(H.pulled).toBeLessThan(MB + 256 * 1024)
  })

  it('the Clerk webhook stops reading past 256 KB, before its secret is looked up', async () => {
    H.pulled = 0
    H.secret = false
    const hook = (await import('../clerk-webhook/handler.ts')).default
    const res = await hook(post('https://fullfilio.test/functions/v1/clerk-webhook', 32 * MB))
    expect(res.status).toBe(413)
    expect(H.secret).toBe(false)
    expect(H.pulled).toBeLessThan(512 * 1024)
  })
})
