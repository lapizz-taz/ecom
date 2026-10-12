import { describe, expect, it } from 'vitest'
import { fetchWithRetry, retryAfterMs } from './fetch-retry'

/** A fake provider that answers from a list, recording each call. */
function provider(answers: Array<number | Error>) {
  const calls: string[] = []
  const fn = (async (input: RequestInfo | URL) => {
    calls.push(String(input))
    const next = answers.shift()
    if (next instanceof Error) throw next
    return new Response(`status ${next}`, { status: next ?? 200, headers: next === 429 ? { 'retry-after': '2' } : {} })
  }) as typeof fetch
  return { fn, calls }
}

const noWait = () => {
  const waits: number[] = []
  return { waits, sleep: async (ms: number) => { waits.push(ms) }, random: () => 0.5 }
}

describe('fetchWithRetry (read-only calls to outside services)', () => {
  it('tries again after a passing outage and returns the good answer', async () => {
    const p = provider([503, 502, 200])
    const w = noWait()
    const res = await fetchWithRetry(p.fn, w)('https://api.example/x')
    expect(res.status).toBe(200)
    expect(p.calls).toHaveLength(3)
    expect(w.waits).toEqual([400, 800])
  })

  it('waits as long as the provider asks (Retry-After), but never longer than the cap', async () => {
    const p = provider([429, 200])
    const w = noWait()
    expect((await fetchWithRetry(p.fn, { ...w, maxDelayMs: 1500 })('https://api.example/x')).status).toBe(200)
    expect(w.waits).toEqual([1500])
  })

  it('gives up after the last try and hands back the provider answer', async () => {
    const p = provider([503, 503, 503])
    const res = await fetchWithRetry(p.fn, noWait())('https://api.example/x')
    expect(res.status).toBe(503)
    expect(p.calls).toHaveLength(3)
  })

  it('does not repeat a refusal or a bad request', async () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const p = provider([status, 200])
      expect((await fetchWithRetry(p.fn, noWait())('https://api.example/x')).status).toBe(status)
      expect(p.calls).toHaveLength(1)
    }
  })

  it('tries again after a dropped connection, but not after its own timeout', async () => {
    const dropped = provider([new TypeError('connection reset'), 200])
    expect((await fetchWithRetry(dropped.fn, noWait())('https://api.example/x')).status).toBe(200)
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    const slow = provider([timeout, 200])
    await expect(fetchWithRetry(slow.fn, noWait())('https://api.example/x')).rejects.toThrow('timed out')
    expect(slow.calls).toHaveLength(1)
  })

  it('reads Retry-After as seconds or a date', () => {
    expect(retryAfterMs('3')).toBe(3000)
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6000)
    expect(retryAfterMs(null)).toBeNull()
    expect(retryAfterMs('soon')).toBeNull()
  })
})
