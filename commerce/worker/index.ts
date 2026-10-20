// Fullfilio on Cloudflare: one Worker serves the site (Workers Static Assets)
// and the backend functions that ran as Supabase Edge Functions. The database is
// Supabase Postgres, or the Cloudflare database (db/, a SQLite Durable Object) once
// DATABASE_BACKEND=cloudflare; uploads go to R2; Workers KV holds public,
// rebuildable cache entries only.
import { AsyncLocalStorage } from 'node:async_hooks'
import { setSharedCache } from '../supabase/functions/_shared/cache.ts'
import { setRegistryRelay } from '../supabase/functions/_shared/domain-check.ts'
import { setHistoryRelay } from '../supabase/functions/_shared/fraud/courier-history.ts'
import { setPanelRelay } from '../supabase/functions/_shared/fraud/courier-panel.ts'
import { httpPanelRelay } from '../supabase/functions/_shared/fraud/courier-relay.ts'
import { setLocalCaller } from '../supabase/functions/_shared/internal.ts'
import { relayedFetch } from '../supabase/functions/_shared/payments/gateway-relay.ts'
import { copyOnce } from './copy.ts'
import { type JobRunner, runDue } from './cron.ts'
import { database, INTERNAL_ORIGIN, usesCloudflareDb } from './db/gateway.ts'
import { createRouter, type Env, type Router } from './router.ts'

export { Database } from './db/database.ts'

const requests = new AsyncLocalStorage<ExecutionContext>()

// The functions hand background work (logs, follow-up calls) to Supabase's
// EdgeRuntime.waitUntil; here it is the current request's ctx.waitUntil.
;(globalThis as { EdgeRuntime?: unknown }).EdgeRuntime = {
  waitUntil(task: Promise<unknown>) {
    requests.getStore()?.waitUntil(task)
  },
}

let router: Router | null = null

function setUp(env: Env): Router {
  const r = createRouter(env)
  const origin = (env as { FUNCTIONS_URL?: string }).FUNCTIONS_URL?.replace(/\/functions\/v1\/?$/, '') || 'https://worker.internal'
  setLocalCaller((name, init) => r.invoke(name, new Request(`${origin}/functions/v1/${name}`, init)))
  if (usesCloudflareDb(env)) {
    // The functions' supabase-js clients talk to the Cloudflare database in-process.
    ;(globalThis as { process?: { env: Record<string, string> } }).process!.env.SUPABASE_URL = INTERNAL_ORIGIN
    const outbound = globalThis.fetch
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const target = input instanceof Request ? input.url : String(input)
      if (target.startsWith(`${INTERNAL_ORIGIN}/`)) return database(new Request(input, init), env)
      return outbound(input, init)
    }
  }
  // The couriers' panels and BD Courier refuse requests from Cloudflare Workers: their
  // sign-ins and lookups run in the courier-relay function on Supabase (COURIER_PANEL_RELAY_URL).
  const { COURIER_PANEL_RELAY_URL: relayUrl, CRON_SECRET: cronSecret } = env as { COURIER_PANEL_RELAY_URL?: string; CRON_SECRET?: string }
  const relay = relayUrl ? httpPanelRelay({ url: relayUrl, cronSecret, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY }) : null
  setPanelRelay(relay)
  setHistoryRelay(relay ? (phone) => relay.history(phone) : null)
  // Registries (RDAP) refuse Workers too: the domain check asks them through the same relay.
  setRegistryRelay(relay ? (domain) => relay.rdap(domain) : null)
  // bKash and PayStation refuse Workers as well: their calls go through the same relay.
  if (relayUrl) globalThis.fetch = relayedFetch({ url: relayUrl, cronSecret, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY }, globalThis.fetch)
  const kv = env.CACHE
  setSharedCache(kv ? {
    get: (key) => kv.get(key),
    put: (key, value, ttlSeconds) => kv.put(key, value, { expirationTtl: Math.max(60, ttlSeconds) }),
  } : null)
  return r
}

/** Scheduled jobs reach the database and the functions in-process, as the service role. */
function jobRunner(env: Env, active: Router): JobRunner {
  const service = env.SUPABASE_SERVICE_ROLE_KEY ?? ''
  const headers = { apikey: service, Authorization: `Bearer ${service}`, 'Content-Type': 'application/json' }
  const origin = (env as { FUNCTIONS_URL?: string }).FUNCTIONS_URL?.replace(/\/functions\/v1\/?$/, '') || 'https://worker.internal'
  const ok = async (res: Response, what: string) => {
    if (!res.ok) throw new Error(`${what}: ${res.status} ${(await res.text()).slice(0, 300)}`)
    return res
  }
  return {
    async rpc(fn, args = {}) {
      const res = await ok(await database(new Request(`${INTERNAL_ORIGIN}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args) }), env), fn)
      const text = await res.text()
      return text ? JSON.parse(text) : null
    },
    async exists(table, filter) {
      const res = await ok(await database(new Request(`${INTERNAL_ORIGIN}/rest/v1/${table}?select=*&${filter}&limit=1`, { headers }), env), table)
      return ((await res.json()) as unknown[]).length > 0
    },
    async call(fn, body, search) {
      const req = new Request(`${origin}/functions/v1/${fn}${search ? `?${search}` : ''}`, { method: 'POST', headers, body: JSON.stringify(body) })
      return (await ok(await active.invoke(fn, req), fn)).status
    },
  }
}

const MAINTENANCE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fullfilio is being upgraded</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#fafafa;color:#18181b}
main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.4rem;margin:0 0 .5rem}p{color:#52525b;line-height:1.5}
@media (prefers-color-scheme:dark){body{background:#09090b;color:#fafafa}p{color:#a1a1aa}}</style></head>
<body><main><h1>Fullfilio is being upgraded</h1><p>We are moving to faster servers. Everything will be back in a few minutes; nothing you saved is lost.</p></main></body></html>`

/** During the switch-over nothing is read or written: pages show a notice, the API asks callers to retry. */
function maintenance(req: Request): Response {
  const path = new URL(req.url).pathname
  const headers = { 'Retry-After': '300', 'Cache-Control': 'no-store' }
  if (/^\/(rest|auth|realtime|functions)\/v1\//.test(path) || path.startsWith('/__clerk') || path.startsWith('/oauth/') || path.startsWith('/files/')) {
    return Response.json({ error: { code: 'MAINTENANCE', message: 'Fullfilio is being upgraded. Try again in a few minutes.' } }, { status: 503, headers })
  }
  if (/\.[a-z0-9]{2,5}$/i.test(path)) return new Response('Service unavailable', { status: 503, headers })
  return new Response(MAINTENANCE_PAGE, { status: 503, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } })
}

export default {
  fetch(req, env, ctx) {
    if (env.MAINTENANCE === 'on') return maintenance(req)
    router ??= setUp(env)
    const active = router
    return requests.run(ctx, () => active.route(req))
  },
  // Every minute (wrangler.jsonc). Only with the Cloudflare database: before the
  // switch-over the same jobs run in Supabase (pg_cron), and must not run twice.
  scheduled(event, env, ctx) {
    // The switch-over copy from Supabase, when asked for (copy.ts); never over a live database.
    if (env.COPY_FROM_SUPABASE && env.SUPABASE_DB_URL) {
      ctx.waitUntil(copyOnce(env).catch((e) => console.error('copy from Supabase failed:', e instanceof Error ? e.message : e)))
    }
    if (!usesCloudflareDb(env) || env.MAINTENANCE === 'on') return
    router ??= setUp(env)
    const runner = jobRunner(env, router)
    ctx.waitUntil(requests.run(ctx, () => runDue(new Date(event.scheduledTime), runner,
      (job, e) => console.error(`scheduled job ${job} failed:`, e instanceof Error ? e.message : e))))
  },
} satisfies ExportedHandler<Env>
