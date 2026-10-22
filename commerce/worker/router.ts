// What the site's Worker does with a request that is not a static file:
//
//   /functions/v1/<name>/…   a backend function (the Supabase Edge Functions' code, run here)
//   /functions/v1/files/…    uploads to R2 (see files.ts)
//   /files/<bucket>/<path>   an uploaded file
//   /__clerk/…               Clerk's Frontend API through our own address (clerk-proxy)
//   /oauth/shopify/callback  Shopify's OAuth return on the app's host (channels)
//   /rest/v1/…, /auth/v1/…   the Cloudflare database (when DATABASE_BACKEND=cloudflare; see db/gateway.ts)
//
//   /robots.txt, /sitemap.xml  per address: the store's own, or the website's (storefront.ts, site.ts)
//   /llms.txt                  the website's, for AI assistants (site.ts)
//   /__site/event              the server copy of a website pixel event (site-events.ts)
//
// Pages are the site itself (Workers Static Assets, single-page app); on a store's address the
// page carries that store's settings and head (title, meta tags, structured data).
import { apexOf } from '../supabase/functions/_shared/domain-check.ts'
import type { CopyEnv } from './copy.ts'
import { database, type DbEnv } from './db/gateway.ts'
import { filesApi, serveFile, type FilesEnv } from './files.ts'
import { FUNCTIONS, type Handler } from './functions.ts'
import { SITE_EVENT_PATH } from '../src/features/site/site-meta.ts'
import { siteEvent, type SiteEventsEnv } from './site-events.ts'
import { isPageRequest, storefrontFile, storefrontPage } from './storefront.ts'

export interface Env extends FilesEnv, DbEnv, SiteEventsEnv, Omit<CopyEnv, 'DATABASE'> {
  ASSETS: Fetcher
  CACHE?: KVNamespace
  /** "on" during the switch-over: pages and the API answer "back in a few minutes" (503). */
  MAINTENANCE?: string
  /**
   * Functions that keep running on Supabase Edge Functions: the Worker passes
   * their requests on unchanged. For the Workers Free plan (10 ms CPU and 50
   * outgoing requests per call), the long-running ones belong here; on Workers
   * Paid this is empty and everything runs in the Worker.
   */
  SUPABASE_FUNCTIONS?: string
  /** Shared with the root-domain proxy (deploy/root-proxy): only then are its headers believed. */
  ROOT_PROXY_SECRET?: string
}

const PROXY_HEADERS = ['x-fullfilio-proxy', 'x-fullfilio-host', 'x-fullfilio-client-ip']

function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * A visit to a root domain (shop.com) through our proxy server arrives on the proxy's
 * upstream address. With the proxy's secret, the request is put back on the visitor's own
 * address (so links, payment returns and the store lookup see shop.com) and carries the
 * visitor's IP. Without it, the proxy headers are dropped: nobody else can claim a host or IP.
 */
export function fromRootProxy(req: Request, secret: string | undefined): Request {
  if (!PROXY_HEADERS.some((h) => req.headers.has(h))) return req
  const given = req.headers.get('x-fullfilio-proxy') ?? ''
  // A final dot ("shop.com.") is the same name.
  const host = (req.headers.get('x-fullfilio-host') ?? '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')
  const ip = req.headers.get('x-fullfilio-client-ip') ?? ''
  const url = new URL(req.url)
  // Never the platform's own names (its root and every subdomain): the proxy is only for store domains.
  const platform = apexOf(url.hostname)
  const trusted = !!secret && secret.length >= 16 && sameSecret(given, secret)
    && /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,}|xn--[a-z0-9-]{2,59})$/.test(host) && host !== platform && !host.endsWith(`.${platform}`)
  if (trusted) url.host = host
  const out = new Request(url.toString(), req)
  for (const h of PROXY_HEADERS) out.headers.delete(h)
  if (trusted && /^[0-9a-f:.]{3,45}$/i.test(ip)) out.headers.set('cf-connecting-ip', ip)
  return out
}

const FUNCTION_PATH = /^\/functions\/v1\/([a-z0-9-]+)(?=\/|$)/

function problem(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

/**
 * The request a function sees: headers that only a proxy in front of us may
 * set are dropped (anyone can send them to a Worker), and X-Forwarded-For is
 * the visitor's address as Cloudflare saw it.
 */
export function inbound(req: Request, url: string = req.url): Request {
  const out = new Request(url, req)
  for (const h of ['x-vercel-forwarded-for', 'x-real-ip', 'x-forwarded-host']) out.headers.delete(h)
  const ip = req.headers.get('cf-connecting-ip')
  if (ip) out.headers.set('x-forwarded-for', ip)
  else out.headers.delete('x-forwarded-for')
  return out
}

export function remoteFunctions(env: Pick<Env, 'SUPABASE_FUNCTIONS'>): Set<string> {
  return new Set((env.SUPABASE_FUNCTIONS ?? '').split(',').map((s) => s.trim()).filter(Boolean))
}

/** Passes a request on to the same function on Supabase. */
async function forward(req: Request, env: Env): Promise<Response> {
  const base = env.SUPABASE_URL?.replace(/\/+$/, '')
  if (!base) return problem(503, 'NOT_CONFIGURED', 'The database address is not set (SUPABASE_URL)')
  const url = new URL(req.url)
  const headers = new Headers(req.headers)
  for (const h of ['host', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'cf-worker', 'x-forwarded-proto']) headers.delete(h)
  const init = { method: req.method, headers, body: req.body, redirect: 'manual', duplex: 'half' } as RequestInit
  try {
    return await fetch(`${base}${url.pathname}${url.search}`, init)
  } catch {
    return problem(502, 'UPSTREAM_ERROR', 'Could not reach the server. Please try again.')
  }
}

export interface Router {
  route(req: Request): Promise<Response>
  /** Runs a function by name (in-process calls between functions). */
  invoke(name: string, req: Request): Promise<Response>
}

export function createRouter(env: Env, fns: Record<string, Handler> = FUNCTIONS): Router {
  const remote = remoteFunctions(env)
  const files = filesApi(env)

  const invoke = (name: string, req: Request): Promise<Response> => {
    if (remote.has(name)) return forward(req, env)
    const fn = fns[name]
    return fn ? fn(req) : Promise.resolve(problem(404, 'NOT_FOUND', 'No such function'))
  }

  const route = (incoming: Request): Promise<Response> => {
    const req = fromRootProxy(incoming, env.ROOT_PROXY_SECRET)
    const url = new URL(req.url)
    const path = url.pathname
    if (path === '/__clerk' || path.startsWith('/__clerk/')) {
      return invoke('clerk-proxy', inbound(req, `${url.origin}/functions/v1/clerk-proxy${path.slice('/__clerk'.length)}${url.search}`))
    }
    if (path === '/oauth/shopify/callback' || path === '/oauth/shopify/callback/') {
      return invoke('channels', inbound(req, `${url.origin}/functions/v1/channels/callback/shopify${url.search}`))
    }
    if (path.startsWith('/files/')) return serveFile(req, env)
    if (path.startsWith('/rest/v1/') || path.startsWith('/auth/v1/') || path.startsWith('/realtime/v1/')) return database(req, env)
    const fn = FUNCTION_PATH.exec(path)
    if (fn) return fn[1] === 'files' ? files(inbound(req)) : invoke(fn[1], inbound(req))
    // A code file from an older version (gone after a deploy) reaches the Worker: answer 404, never
    // the app page. The page would be kept under /assets/ as "immutable" for a year, and the
    // browser could then never load that file again ("A new version is ready" on every visit).
    if (path.startsWith('/assets/') || /\.(m?js|css|map)$/i.test(path)) {
      return Promise.resolve(new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } }))
    }
    // The website's pages made at build time are read by the Worker only (worker/site.ts).
    if (path.startsWith('/_site/')) return Promise.resolve(new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } }))
    if (path === '/robots.txt' || path === '/sitemap.xml' || path === '/llms.txt') return storefrontFile(req, url, env)
    if (path === SITE_EVENT_PATH) return siteEvent(req, url, env)
    if (isPageRequest(req, url)) return storefrontPage(req, url, env)
    return env.ASSETS.fetch(req)
  }

  return { route, invoke }
}
