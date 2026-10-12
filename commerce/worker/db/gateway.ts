// The Worker's side of the Cloudflare database: /rest/v1 (the PostgREST API) and
// /auth/v1/admin (the account admin API) are answered by the Database Durable
// Object. Who is calling is decided here, from the request's token:
//
//   the service key            → service_role (server code, scheduled jobs)
//   a Clerk session token      → authenticated (verified against Clerk's keys)
//   anything else              → anon (shoppers, the publishable key)
//
// Server code keeps using supabase-js: with DATABASE_BACKEND=cloudflare its
// SUPABASE_URL points at INTERNAL_ORIGIN, and those requests are answered here
// in-process instead of going out to Supabase.
import { verifySessionToken } from '../../supabase/functions/_shared/clerk.ts'
import type { Caller, Database } from './database.ts'

export const INTERNAL_ORIGIN = 'https://database.internal'

export interface DbEnv {
  DATABASE?: DurableObjectNamespace<Database>
  /** "cloudflare" switches the site to the Cloudflare database; anything else keeps Supabase. */
  DATABASE_BACKEND?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
}

export const usesCloudflareDb = (env: DbEnv) => env.DATABASE_BACKEND === 'cloudflare' && Boolean(env.DATABASE)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, prefer, accept-profile, content-profile, range, x-merchant-id',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': 'content-range, x-total-count',
}

const MAX_BODY = 6 * 1024 * 1024

function stub(env: DbEnv) {
  const ns = env.DATABASE!
  // One database for the whole platform, placed near Bangladesh.
  return ns.get(ns.idFromName('main'), { locationHint: 'apac' })
}

function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** A stable uuid for a Clerk session id (device approval stores session uuids). */
async function sessionUuid(sid: string | undefined): Promise<string | null> {
  if (!sid) return null
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`clerk-session:${sid}`))).slice(0, 16)
  d[6] = (d[6] & 0x0f) | 0x50
  d[8] = (d[8] & 0x3f) | 0x80
  const h = Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

function jwtAlg(token: string): string | null {
  try {
    return (JSON.parse(atob(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))) as { alg?: string }).alg ?? null
  } catch {
    return null
  }
}

class Unauthorized extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

export async function identify(req: Request, env: DbEnv): Promise<Caller> {
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1] ?? null
  const apikey = req.headers.get('apikey')
  const base = {
    merchantHeader: req.headers.get('x-merchant-id'),
    userAgent: req.headers.get('user-agent'),
    ip: req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null,
  }
  const service = env.SUPABASE_SERVICE_ROLE_KEY
  if (service && ((bearer && equal(bearer, service)) || (!bearer && apikey && equal(apikey, service)))) {
    return { role: 'service_role', ...base }
  }
  // Clerk session tokens are RS256; Supabase's own (anon) keys are HS256 and mean a visitor.
  if (bearer && bearer.split('.').length === 3 && jwtAlg(bearer) === 'RS256') {
    try {
      const claims = await verifySessionToken(bearer)
      const c = claims as { sub: string; sid?: string; email?: string }
      return { role: 'authenticated', clerkUserId: c.sub, sessionId: await sessionUuid(c.sid), email: c.email ?? null, ...base }
    } catch (e) {
      const expired = (e as { code?: string }).code === 'TOKEN_EXPIRED'
      throw new Unauthorized('PGRST301', expired ? 'JWT expired' : 'invalid JWT')
    }
  }
  return { role: 'anon', ...base }
}

const reply = (status: number, body: string | null, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { ...CORS, 'Cache-Control': 'no-store', ...headers } })

/** Answers /rest/v1/… and /auth/v1/admin/… from the Cloudflare database. */
export async function database(req: Request, env: DbEnv): Promise<Response> {
  if (req.method === 'OPTIONS') return reply(204, null)
  if (!usesCloudflareDb(env)) return reply(503, JSON.stringify({ code: 'NOT_CONFIGURED', message: 'The Cloudflare database is not switched on' }), { 'Content-Type': 'application/json' })
  const url = new URL(req.url)
  let caller: Caller
  try {
    caller = await identify(req, env)
  } catch (e) {
    if (e instanceof Unauthorized) return reply(401, JSON.stringify({ code: e.code, message: e.message, details: null, hint: null }), { 'Content-Type': 'application/json' })
    throw e
  }
  const length = Number(req.headers.get('content-length') ?? 0)
  if (length > MAX_BODY) return reply(413, JSON.stringify({ code: 'PGRST413', message: 'Request body too large' }), { 'Content-Type': 'application/json' })
  const body = req.method === 'GET' || req.method === 'HEAD' ? null : await req.text()
  if (body && body.length > MAX_BODY) return reply(413, JSON.stringify({ code: 'PGRST413', message: 'Request body too large' }), { 'Content-Type': 'application/json' })

  if (url.pathname.startsWith('/rest/v1/')) {
    const res = await stub(env).rest({
      method: req.method,
      path: url.pathname.slice('/rest/v1/'.length),
      search: url.search.slice(1),
      headers: { prefer: req.headers.get('prefer') ?? undefined, accept: req.headers.get('accept') ?? undefined },
      body,
    }, caller)
    return reply(res.status, res.body, res.headers)
  }
  if (url.pathname.startsWith('/auth/v1/')) {
    const res = await stub(env).auth({ method: req.method, path: url.pathname.slice('/auth/v1/'.length), search: url.search.slice(1), body }, caller)
    return reply(res.status, res.body, res.headers)
  }
  return reply(404, JSON.stringify({ code: 'NOT_FOUND', message: 'Not found' }), { 'Content-Type': 'application/json' })
}
