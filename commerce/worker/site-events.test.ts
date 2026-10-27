import { describe, expect, it, vi } from 'vitest'
import { siteEvent, siteEventPayload } from './site-events.ts'

// The server copy of a Fullfilio website pixel event (worker/site-events.ts → Meta Conversions API).

const SITE = 'https://fullfilio.com'
const HASH = 'a'.repeat(64)
const env = { PLATFORM_URL: SITE, SITE_META_CAPI_TOKEN: 'EAAtoken-secret' }
const ok = () => vi.fn(async () => new Response(JSON.stringify({ events_received: 1 }), { status: 200 }))

const body = (over: Record<string, unknown> = {}) => ({
  event: 'CompleteRegistration', id: 'ffw_cr_AbCdEfGhIjKlMnOpQrSt', url: `${SITE}/start`, external_id: HASH,
  data: { content_name: 'Growth', value: 2490, currency: 'BDT' }, user: { em: HASH, ph: HASH, fn: HASH },
  fbp: 'fb.1.1761100000000.1234567890', fbclid: 'IwAR0abc', ...over,
})
const post = (b: unknown, headers: Record<string, string> = {}, at = `${SITE}/__site/event`) => new Request(at, {
  method: 'POST', body: typeof b === 'string' ? b : JSON.stringify(b),
  headers: { Origin: SITE, 'Content-Type': 'application/json', 'cf-connecting-ip': '103.4.5.6', 'User-Agent': 'Mozilla/5.0 test', ...headers },
})
const send = (req: Request, f = ok(), e: Record<string, string> = env, pixel = '1234567890') => siteEvent(req, new URL(req.url), e, f as unknown as typeof fetch, pixel)

describe('website pixel: the server copy', () => {
  it('sends the event to Meta with the same id, hashed person, IP, browser and click id', async () => {
    const f = ok()
    const res = await send(post(body()), f)
    expect(res.status).toBe(204)
    expect(f).toHaveBeenCalledTimes(1)
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://graph.facebook.com/v22.0/1234567890/events')
    const sent = JSON.parse(String(init.body))
    expect(sent.access_token).toBe('EAAtoken-secret')
    expect(url).not.toContain('EAAtoken')
    const ev = sent.data[0]
    expect(ev).toMatchObject({ event_name: 'CompleteRegistration', event_id: 'ffw_cr_AbCdEfGhIjKlMnOpQrSt', action_source: 'website', event_source_url: `${SITE}/start` })
    expect(ev.custom_data).toEqual({ content_name: 'Growth', value: 2490, currency: 'BDT' })
    expect(ev.user_data).toMatchObject({ em: [HASH], ph: [HASH], fn: [HASH], external_id: [HASH], client_ip_address: '103.4.5.6', client_user_agent: 'Mozilla/5.0 test', fbp: 'fb.1.1761100000000.1234567890' })
    expect(ev.user_data.fbc).toMatch(/^fb\.1\.\d+\.IwAR0abc$/)
    expect(ev.user_data.country).toHaveLength(1)
  })

  it('a test code sends the events to the Test events tab', async () => {
    const f = ok()
    await send(post(body()), f, { ...env, SITE_META_TEST_CODE: 'TEST123' })
    expect(JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body)).test_event_code).toBe('TEST123')
  })

  it('does nothing without the pixel id or the token', async () => {
    const f = ok()
    expect((await send(post(body()), f, env, '')).status).toBe(204)
    expect((await send(post(body()), f, { PLATFORM_URL: SITE })).status).toBe(204)
    expect(f).not.toHaveBeenCalled()
  })

  it('takes events only from the website’s own pages, on its own address', async () => {
    const f = ok()
    await send(post(body(), { Origin: 'https://evil.example' }), f)
    await send(post(body(), {}, 'https://shop.fullfilio.com/__site/event'), f)
    await send(post(body({ url: 'https://evil.example/start' })), f)
    expect(f).not.toHaveBeenCalled()
    expect((await siteEvent(new Request(`${SITE}/__site/event`), new URL(`${SITE}/__site/event`), env)).status).toBe(405)
  })

  it('drops anything that is not one of our events', async () => {
    const f = ok()
    for (const b of [
      body({ event: 'Purchase' }), body({ event: 'toString' }), body({ id: 'ffw_pv_AbCdEfGhIjKlMnOpQrSt' }), body({ id: 'x' }),
      'not json', JSON.stringify(body({ data: { content_name: 'x'.repeat(5000) } })),
    ]) await send(post(b), f)
    expect(f).not.toHaveBeenCalled()
  })

  it('stops reading a body past 4 KB instead of taking it all in (audit run 6)', async () => {
    const streamed = (total: number) => {
      let pulled = 0
      const chunk = new Uint8Array(64 * 1024).fill(32)
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          if (pulled >= total) return c.close()
          pulled += chunk.byteLength
          c.enqueue(chunk)
        },
      })
      return { stream, pulled: () => pulled }
    }
    const f = ok()
    // A declared Content-Length over the limit is refused before reading.
    const big = streamed(8 * 1024 * 1024)
    const declared = new Request(`${SITE}/__site/event`, {
      method: 'POST', body: big.stream, headers: { Origin: SITE, 'Content-Length': String(8 * 1024 * 1024) }, duplex: 'half',
    } as RequestInit)
    expect((await send(declared, f)).status).toBe(204)
    expect(big.pulled()).toBeLessThanOrEqual(64 * 1024)
    // Without a length, the reader stops at the first chunk past the limit.
    const open = streamed(8 * 1024 * 1024)
    const undeclared = new Request(`${SITE}/__site/event`, { method: 'POST', body: open.stream, headers: { Origin: SITE }, duplex: 'half' } as RequestInit)
    expect((await send(undeclared, f)).status).toBe(204)
    expect(open.pulled()).toBeLessThanOrEqual(3 * 64 * 1024)
    expect(f).not.toHaveBeenCalled()
    // An ordinary event still goes through.
    await send(post(body()), f)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('keeps only hashes, a sane value and the BDT currency', async () => {
    const ev = await siteEventPayload(body({
      user: { em: 'someone@example.com', ph: '01711000000', fn: HASH }, data: { value: -5, currency: 'USD', content_name: 'Pricing' }, fbp: 'nope', fbclid: 'bad id!',
    }), post({}), SITE)
    expect(ev!.user_data).not.toHaveProperty('em')
    expect(ev!.user_data).not.toHaveProperty('ph')
    expect(ev!.user_data).not.toHaveProperty('fbp')
    expect(ev!.user_data).not.toHaveProperty('fbc')
    expect(ev!.user_data.fn).toEqual([HASH])
    expect(ev!.custom_data).toEqual({ content_name: 'Pricing' })
  })

  it('never passes Meta’s error on to the visitor, and keeps the token out of the log', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Invalid OAuth access token EAAtoken-secret' } }), { status: 400 }))
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const res = await send(post(body()), f as unknown as ReturnType<typeof ok>)
    expect(res.status).toBe(204)
    expect(log.mock.calls.flat().join(' ')).not.toContain('EAAtoken-secret')
    log.mockRestore()
  })
})
