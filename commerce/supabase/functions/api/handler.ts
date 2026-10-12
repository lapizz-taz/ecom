// External API: connect your own systems (ERP, accounting, warehouse apps,
// Zapier/Make, scripts) to this business's orders, products, stock and customers.
//
//   GET  /api/v1/me                                         the key, its permissions and business
//   GET  /api/v1/orders?status=&updated_since=&limit=&offset=      orders:read
//   GET  /api/v1/orders/<order number or id>                         orders:read
//   POST /api/v1/orders/<order number or id>/status {status, note?}  orders:write
//   GET  /api/v1/products?search=&limit=&offset=                     products:read
//   GET  /api/v1/inventory?sku=&limit=&offset=                       inventory:read
//   POST /api/v1/inventory/<sku> {mode: set|add|remove, quantity, note}  inventory:write
//   GET  /api/v1/customers?phone=&limit=&offset=                     customers:read
//
// Authorization: Bearer ffl_live_… — server to server only (refused from a
// browser). Keys are created in Settings → Developers, stored only as hashes,
// and every scope is checked again inside the database.
import { z } from 'zod'
import { clientIp, handle, HttpError, rateLimit, readJson } from '../_shared/http.ts'
import { parse } from '../_shared/schemas.ts'
import { adminClient, rpc } from '../_shared/supabase.ts'

interface ApiKey { id: string; name: string; scopes: string[]; feature: boolean; merchantId: string }

const sha256 = async (s: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))), (b) => b.toString(16).padStart(2, '0')).join('')

const reply = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra } })

async function authenticate(req: Request): Promise<ApiKey> {
  const raw = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!/^ffl_live_[0-9a-f]{48}$/.test(raw)) throw new HttpError(401, 'Send your API key as "Authorization: Bearer ffl_live_…"', 'API_KEY_MISSING')
  if (req.headers.get('origin')) {
    throw new HttpError(403, 'API keys are for servers only. Call the API from your backend, never from a browser, and turn this key off if it was exposed.', 'KEY_IN_BROWSER')
  }
  const hash = await sha256(raw)
  const merchantId = await rpc<string | null>(adminClient(), 'api_key_merchant', { p_hash: hash })
  const found = merchantId ? await rpc<Omit<ApiKey, 'merchantId'> | null>(adminClient(merchantId), 'api_key_check', { p_hash: hash }) : null
  if (!merchantId || !found) throw new HttpError(401, 'This API key is not valid, has expired or has been turned off', 'API_KEY_INVALID')
  if (!found.feature) throw new HttpError(403, "The External API is not included in this business's plan", 'FEATURE_OFF')
  return { ...found, merchantId }
}

const page = (url: URL) => ({
  limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
  offset: url.searchParams.get('offset') ? Number(url.searchParams.get('offset')) : undefined,
})
const statusBody = z.object({ status: z.string().trim().min(3).max(40), note: z.string().trim().max(500).optional() })
const stockBody = z.object({ mode: z.enum(['set', 'add', 'remove']), quantity: z.number().int().min(0).max(1_000_000), note: z.string().trim().min(2).max(300) })

export default (async (req: Request): Promise<Response> => {
  const started = Date.now()
  const url = new URL(req.url)
  const path = url.pathname.replace(/^.*\/api(?=\/|$)/, '').replace(/\/+$/, '') || '/'
  let key: ApiKey | null = null
  const res = await handle(async (req) => {
    if (req.method === 'OPTIONS') throw new HttpError(403, 'API keys are for servers only', 'KEY_IN_BROWSER')
    key = await authenticate(req)
    rateLimit(`api:${key.id}`, req.method === 'GET' ? 240 : 60)
    const db = adminClient(key.merchantId)
    const call = (fn: string, args: Record<string, unknown>) => rpc(db, fn, { p_key: key!.id, ...args })

    if (req.method === 'GET' && path === '/v1/me') {
      return reply({ key: { name: key.name, scopes: key.scopes }, business_id: key.merchantId })
    }
    if (req.method === 'GET' && path === '/v1/orders') {
      return reply(await call('api_orders', { p: { ...page(url), status: url.searchParams.get('status'), updated_since: url.searchParams.get('updated_since') } }))
    }
    const order = /^\/v1\/orders\/([A-Za-z0-9-]{3,60})(\/status)?$/.exec(path)
    if (order && req.method === 'GET' && !order[2]) return reply(await call('api_order', { p_ref: order[1] }))
    if (order && req.method === 'POST' && order[2]) {
      const body = parse(statusBody, await readJson(req))
      return reply(await call('api_order_set_status', { p_ref: order[1], p_status: body.status, p_note: body.note ?? null }))
    }
    if (req.method === 'GET' && path === '/v1/products') {
      return reply(await call('api_products', { p: { ...page(url), search: url.searchParams.get('search') } }))
    }
    if (req.method === 'GET' && path === '/v1/inventory') {
      return reply(await call('api_inventory', { p: { ...page(url), sku: url.searchParams.get('sku') } }))
    }
    const stock = /^\/v1\/inventory\/([^/]{1,80})$/.exec(path)
    if (stock && req.method === 'POST') {
      const body = parse(stockBody, await readJson(req))
      return reply(await call('api_inventory_adjust', { p_sku: decodeURIComponent(stock[1]), p_mode: body.mode, p_quantity: body.quantity, p_note: body.note }))
    }
    if (req.method === 'GET' && path === '/v1/customers') {
      return reply(await call('api_customers', { p: { ...page(url), phone: url.searchParams.get('phone') } }))
    }
    throw new HttpError(404, `Unknown endpoint ${req.method} ${path}`, 'NOT_FOUND')
  })(req)

  // Log every authenticated request (best effort) for the Developers page.
  const k = key as ApiKey | null
  if (k) {
    let code: string | null = null
    if (res.status >= 400) code = await res.clone().json().then((b) => (b as { error?: { code?: string } }).error?.code ?? null).catch(() => null)
    const log = rpc(adminClient(k.merchantId), 'api_request_log', {
      p_key: k.id, p_method: req.method, p_path: path, p_status: res.status, p_duration_ms: Date.now() - started, p_ip: clientIp(req), p_error: code,
    }).catch(() => undefined)
    // deno-lint-ignore no-explicit-any
    const runtime = (globalThis as any).EdgeRuntime
    if (runtime?.waitUntil) runtime.waitUntil(log)
    else await log
  }
  // No browser CORS: the API is server to server.
  const headers = new Headers(res.headers)
  for (const h of ['Access-Control-Allow-Origin', 'Access-Control-Allow-Headers', 'Access-Control-Allow-Methods']) headers.delete(h)
  headers.set('X-Request-Duration', String(Date.now() - started))
  return new Response(res.body, { status: res.status, headers })
})
