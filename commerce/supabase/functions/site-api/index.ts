// Website API: lets a custom-coded shop (Next.js, Laravel, plain HTML…) sell
// through this platform. Same server-side checkout as the hosted store.
//
//   GET  /site-api/v1/products?search=&category=&limit=&offset=   catalog (active products)
//   GET  /site-api/v1/products/<slug>                              one product with variants
//   POST /site-api/v1/quote    {items, district, area?, coupon_code?, phone?, payment_method?}
//   POST /site-api/v1/orders   {customer, shipping, items, payment_method, idempotency_key, …}
//   GET  /site-api/v1/orders/<order_number>?phone=…                order status for the customer
//
// Authorization: Bearer pk_live_… (browser, only from the key's websites) or
// Bearer sk_live_… (your server; refused when sent from a browser). Keys are
// created in Settings → Website & domains and stored only as hashes.
import { placeOrder, quoteCart } from '../_shared/checkout-flow.ts'
import { dispatchNotificationsInBackground } from '../_shared/dispatch.ts'
import { clientIp, handle, HttpError, rateLimit, readJson } from '../_shared/http.ts'
import { parse, placeOrderSchema, quoteSchema } from '../_shared/schemas.ts'
import { adminClient, rpc } from '../_shared/supabase.ts'

interface SiteKey { id: string; name: string; kind: 'PUBLISHABLE' | 'SECRET'; allowed_origins: string[] }

const sha256 = async (s: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))), (b) => b.toString(16).padStart(2, '0')).join('')

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get('origin')
  return {
    // The key decides which websites may call; the header only lets the browser read the answer.
    'Access-Control-Allow-Origin': origin ?? '*',
    'Access-Control-Allow-Headers': 'authorization, content-type, x-api-key, idempotency-key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  }
}

const reply = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

async function authenticate(req: Request): Promise<SiteKey> {
  const raw = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim() || (req.headers.get('x-api-key') ?? '').trim()
  if (!/^(pk|sk)_live_[0-9a-f]{48}$/.test(raw)) throw new HttpError(401, 'Send your website API key as "Authorization: Bearer pk_live_…"', 'API_KEY_MISSING')
  const key = await rpc<SiteKey | null>(adminClient(), 'site_api_key_check', { p_hash: await sha256(raw) })
  if (!key) throw new HttpError(401, 'This API key is not valid or has been turned off', 'API_KEY_INVALID')
  const origin = req.headers.get('origin')
  if (key.kind === 'SECRET' && origin) {
    throw new HttpError(403, 'Secret keys are for your server only. Use a publishable key (pk_live_…) in browser code, and turn this secret key off.', 'SECRET_KEY_IN_BROWSER')
  }
  if (key.kind === 'PUBLISHABLE' && (!origin || !key.allowed_origins.includes(origin.toLowerCase()))) {
    throw new HttpError(403, origin ? `${origin} is not one of this key's websites` : 'Publishable keys work only from their websites; use a secret key on your server', 'ORIGIN_NOT_ALLOWED')
  }
  return key
}

const intParam = (v: string | null, def: number, max: number) => Math.min(Math.max(Number.parseInt(v ?? '', 10) || def, 0), max)

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) })
  const res = await handle(async (req) => {
    const url = new URL(req.url)
    const path = url.pathname.replace(/^.*\/site-api/, '').replace(/\/+$/, '') || '/'
    const key = await authenticate(req)
    rateLimit(`site:${key.id}:${clientIp(req)}`, req.method === 'POST' ? 30 : 120)
    const admin = adminClient()

    if (req.method === 'GET' && path === '/v1/products') {
      const data = await rpc(admin, 'storefront_list_products', {
        p_category: url.searchParams.get('category'), p_search: url.searchParams.get('search'), p_sort: url.searchParams.get('sort') ?? 'newest',
        p_min_price: null, p_max_price: null, p_in_stock: url.searchParams.get('in_stock') === 'true', p_tag: url.searchParams.get('tag'),
        p_featured: url.searchParams.get('featured') === 'true', p_limit: intParam(url.searchParams.get('limit'), 24, 100), p_offset: intParam(url.searchParams.get('offset'), 0, 100_000),
      })
      return reply(req, data)
    }
    const product = /^\/v1\/products\/([a-z0-9-]{1,120})$/.exec(path)
    if (req.method === 'GET' && product) {
      const data = await rpc(admin, 'storefront_get_product', { p_slug: product[1] })
      if (!data) throw new HttpError(404, 'Product not found', 'NOT_FOUND')
      return reply(req, data)
    }
    if (req.method === 'POST' && path === '/v1/quote') {
      const input = parse(quoteSchema, { ...(await readJson<Record<string, unknown>>(req)), action: 'quote' })
      return reply(req, await quoteCart(admin, input))
    }
    if (req.method === 'POST' && path === '/v1/orders') {
      const body = await readJson<Record<string, unknown>>(req)
      const input = parse(placeOrderSchema, { ...body, action: 'place', idempotency_key: body.idempotency_key ?? req.headers.get('idempotency-key') ?? undefined })
      const result = await placeOrder(admin, input, { ip: clientIp(req), userAgent: req.headers.get('user-agent'), siteKeyId: key.id })
      dispatchNotificationsInBackground()
      return reply(req, result, 201)
    }
    const track = /^\/v1\/orders\/([A-Za-z0-9-]{3,40})$/.exec(path)
    if (req.method === 'GET' && track) {
      const phone = url.searchParams.get('phone') ?? ''
      if (!/^\+?[0-9 -]{10,16}$/.test(phone)) throw new HttpError(422, 'Add ?phone= with the number on the order', 'VALIDATION')
      const data = await rpc(admin, 'track_order', { p_order_number: track[1], p_phone: phone })
      if (!data) throw new HttpError(404, 'No order with this number and phone', 'NOT_FOUND')
      return reply(req, data)
    }
    throw new HttpError(404, `Unknown endpoint ${req.method} ${path}`, 'NOT_FOUND')
  })(req)
  // Errors from handle() carry the app's CORS headers; the website needs its own origin.
  const headers = new Headers(res.headers)
  for (const [k, v] of Object.entries(cors(req))) headers.set(k, v)
  return new Response(res.body, { status: res.status, headers })
})
