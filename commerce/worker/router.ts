// What the site's Worker does with a request that is not a static file:
//
//   /functions/v1/<name>/…   a backend function (the Supabase Edge Functions' code, run here)
//   /functions/v1/files/…    uploads to R2 (see files.ts)
//   /files/<bucket>/<path>   an uploaded file
//   /__clerk/…               Clerk's Frontend API through our own address (clerk-proxy)
//   /oauth/shopify/callback  Shopify's OAuth return on the app's host (channels)
//   /rest/v1/…, /auth/v1/…   the Cloudflare database (when DATABASE_BACKEND=cloudflare; see db/gateway.ts)
//
// Everything else is the site itself (Workers Static Assets, single-page app).
import type { CopyEnv } from './copy.ts'
import { database, type DbEnv } from './db/gateway.ts'
import { filesApi, serveFile, type FilesEnv } from './files.ts'
import { FUNCTIONS, type Handler } from './functions.ts'

export interface Env extends FilesEnv, DbEnv, Omit<CopyEnv, 'DATABASE'> {
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

  const route = (req: Request): Promise<Response> => {
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
    return env.ASSETS.fetch(req)
  }

  return { route, invoke }
}
