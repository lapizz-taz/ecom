import { describe, expect, it } from 'vitest'
import { rateLimit, readJson, readText } from './http.ts'
import { formOrQuery } from './payment-flow.ts'

// A body sent without Content-Length (chunked), so only the counted stream can stop it.
function streamed(bytes: number, chunk = 16 * 1024): Request {
  let sent = 0
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= bytes) return c.close()
      const n = Math.min(chunk, bytes - sent)
      sent += n
      c.enqueue(new Uint8Array(n).fill(97))
    },
  })
  return new Request('https://x.test/hook', { method: 'POST', body, duplex: 'half' } as RequestInit)
}

describe('request body limits', () => {
  it('refuses a body over the limit by its declared length', async () => {
    const req = new Request('https://x.test', { method: 'POST', body: 'x', headers: { 'content-length': String(10 * 1024 * 1024) } })
    await expect(readText(req, 1024)).rejects.toMatchObject({ status: 413 })
  })

  it('refuses a streamed body once it passes the limit', async () => {
    await expect(readText(streamed(200 * 1024), 64 * 1024)).rejects.toMatchObject({ status: 413 })
  })

  it('counts bytes, not characters', async () => {
    const req = new Request('https://x.test', { method: 'POST', body: JSON.stringify({ t: 'ক'.repeat(30) }) })
    await expect(readJson(req, 64)).rejects.toMatchObject({ status: 413 })
  })

  it('reads a normal JSON body', async () => {
    const req = new Request('https://x.test', { method: 'POST', body: JSON.stringify({ a: 1 }) })
    expect(await readJson(req)).toEqual({ a: 1 })
  })

  it('caps gateway callbacks and still parses forms and JSON', async () => {
    const big = new Request('https://x.test/cb', { method: 'POST', body: 'a='.padEnd(100 * 1024, 'x'), headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    await expect(formOrQuery(big)).rejects.toMatchObject({ status: 413 })
    const form = new Request('https://x.test/cb?q=1', { method: 'POST', body: 'paymentID=P1&status=success', headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    expect(await formOrQuery(form)).toEqual({ q: '1', paymentID: 'P1', status: 'success' })
    const js = new Request('https://x.test/cb', { method: 'POST', body: '{"invoice":"I1"}', headers: { 'content-type': 'application/json' } })
    expect(await formOrQuery(js)).toEqual({ invoice: 'I1' })
  })
})

describe('rateLimit', () => {
  it('keeps limiting a key and stays bounded under many distinct keys', () => {
    for (let i = 0; i < 3; i++) rateLimit('same-key', 3)
    expect(() => rateLimit('same-key', 3)).toThrow(/Too many requests/)
    for (let i = 0; i < 12_000; i++) rateLimit(`k-${i}`, 5)
  })
})
