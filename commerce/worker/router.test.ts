import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRouter, inbound, type Env } from './router.ts'
import { FUNCTIONS } from './functions.ts'
import { readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const assets = { fetch: vi.fn(async (req: Request) => new Response(`asset ${new URL(req.url).pathname}`)) }

function env(extra: Partial<Env> = {}): Env {
  return { ASSETS: assets as unknown as Fetcher, SUPABASE_URL: 'https://db.example.supabase.co', ...extra } as Env
}

/** Fake functions that echo what they were given. */
function echo(name: string) {
  return async (req: Request) => Response.json({
    name, url: req.url, method: req.method, body: req.method === 'GET' ? null : await req.text(),
    xff: req.headers.get('x-forwarded-for'), vercel: req.headers.get('x-vercel-forwarded-for'), auth: req.headers.get('authorization'),
  })
}
const fns = { channels: echo('channels'), 'clerk-proxy': echo('clerk-proxy'), checkout: echo('checkout') }

afterEach(() => {
  vi.unstubAllGlobals()
  assets.fetch.mockClear()
})

describe('Worker routing', () => {
  it('has every Supabase function, under its own name', () => {
    const dir = resolve(__dirname, '../supabase/functions')
    const names = readdirSync(dir).filter((d) => !d.startsWith('_') && statSync(resolve(dir, d)).isDirectory())
    expect(Object.keys(FUNCTIONS).sort()).toEqual(names.sort())
    for (const fn of Object.values(FUNCTIONS)) expect(typeof fn).toBe('function')
  })

  it('runs a function with its path, query, body and sign-in', async () => {
    const r = createRouter(env(), fns)
    const res = await r.route(new Request('https://app.example.com/functions/v1/checkout/x?y=1', {
      method: 'POST', body: '{"a":1}', headers: { Authorization: 'Bearer abc', 'cf-connecting-ip': '203.0.113.9' },
    }))
    expect(await res.json()).toEqual({
      name: 'checkout', url: 'https://app.example.com/functions/v1/checkout/x?y=1', method: 'POST', body: '{"a":1}',
      xff: '203.0.113.9', vercel: null, auth: 'Bearer abc',
    })
    expect(assets.fetch).not.toHaveBeenCalled()
  })

  it('ignores proxy headers a visitor sends (no IP spoofing)', () => {
    const req = inbound(new Request('https://app.example.com/functions/v1/checkout', {
      headers: { 'x-vercel-forwarded-for': '1.1.1.1', 'x-real-ip': '1.1.1.1', 'x-forwarded-for': '1.1.1.1', 'cf-connecting-ip': '198.51.100.7' },
    }))
    expect(req.headers.get('x-vercel-forwarded-for')).toBeNull()
    expect(req.headers.get('x-real-ip')).toBeNull()
    expect(req.headers.get('x-forwarded-for')).toBe('198.51.100.7')
  })

  it('maps /__clerk to the Clerk proxy and Shopify\'s OAuth return to channels', async () => {
    const r = createRouter(env(), fns)
    const clerk = await (await r.route(new Request('https://app.example.com/__clerk/v1/client?_clerk_js_version=5'))).json()
    expect(clerk).toMatchObject({ name: 'clerk-proxy', url: 'https://app.example.com/functions/v1/clerk-proxy/v1/client?_clerk_js_version=5' })
    const shop = await (await r.route(new Request('https://app.example.com/oauth/shopify/callback?code=c&shop=s.myshopify.com&state=t'))).json()
    expect(shop).toMatchObject({ name: 'channels', url: 'https://app.example.com/functions/v1/channels/callback/shopify?code=c&shop=s.myshopify.com&state=t' })
  })

  it('answers 404 for an unknown function and leaves everything else to the site', async () => {
    const r = createRouter(env(), fns)
    const missing = await r.route(new Request('https://app.example.com/functions/v1/nope', { method: 'POST' }))
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
    const page = await r.route(new Request('https://app.example.com/oauth/other'))
    expect(await page.text()).toBe('asset /oauth/other')
  })

  it('answers 404 (not the app page) for a code file from an older version', async () => {
    const r = createRouter(env(), fns)
    for (const path of ['/assets/index-OLD123.js', '/assets/app-OLD.css', '/old-chunk.mjs']) {
      const res = await r.route(new Request(`https://app.example.com${path}`))
      expect(res.status).toBe(404)
      expect(res.headers.get('cache-control')).toBe('no-store')
    }
    expect(assets.fetch).not.toHaveBeenCalled()
  })

  it('passes the long-running functions on to Supabase unchanged (Workers Free)', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, init })
      return new Response('{"ok":true}', { status: 202, headers: { 'Content-Type': 'application/json', 'set-cookie': 'a=1' } })
    }))
    const r = createRouter(env({ SUPABASE_FUNCTIONS: 'channels, courier' }), fns)
    const res = await r.route(new Request('https://app.example.com/functions/v1/channels/webhook/0b2c?x=1', {
      method: 'POST', body: 'raw-body', headers: { 'X-Shopify-Hmac-Sha256': 'sig', 'cf-connecting-ip': '198.51.100.7', host: 'app.example.com' },
    }))
    expect(res.status).toBe(202)
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe('https://db.example.supabase.co/functions/v1/channels/webhook/0b2c?x=1')
    const headers = seen[0].init.headers as Headers
    expect(headers.get('x-shopify-hmac-sha256')).toBe('sig')
    expect(headers.get('host')).toBeNull()
    expect(headers.get('cf-connecting-ip')).toBeNull()
    expect(seen[0].init.redirect).toBe('manual')
    // Functions not in the list still run in the Worker.
    const local = await (await r.route(new Request('https://app.example.com/functions/v1/checkout', { method: 'POST', body: '{}' }))).json()
    expect(local.name).toBe('checkout')
    expect(seen).toHaveLength(1)
  })

  it('in-process calls between functions take the same path', async () => {
    const r = createRouter(env(), fns)
    const res = await r.invoke('checkout', new Request('https://worker.internal/functions/v1/checkout', { method: 'POST', body: 'x' }))
    expect((await res.json()).name).toBe('checkout')
  })
})
