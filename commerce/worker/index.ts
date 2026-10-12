// Fullfilio on Cloudflare: one Worker serves the site (Workers Static Assets)
// and the backend functions that ran as Supabase Edge Functions. The database is
// Supabase Postgres, or the Cloudflare database (db/, a SQLite Durable Object) once
// DATABASE_BACKEND=cloudflare; uploads go to R2; Workers KV holds public,
// rebuildable cache entries only.
import { AsyncLocalStorage } from 'node:async_hooks'
import { setSharedCache } from '../supabase/functions/_shared/cache.ts'
import { setLocalCaller } from '../supabase/functions/_shared/internal.ts'
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

export default {
  fetch(req, env, ctx) {
    router ??= setUp(env)
    const active = router
    return requests.run(ctx, () => active.route(req))
  },
  // Every minute (wrangler.jsonc). Only with the Cloudflare database: before the
  // switch-over the same jobs run in Supabase (pg_cron), and must not run twice.
  scheduled(event, env, ctx) {
    if (!usesCloudflareDb(env)) return
    router ??= setUp(env)
    const runner = jobRunner(env, router)
    ctx.waitUntil(requests.run(ctx, () => runDue(new Date(event.scheduledTime), runner,
      (job, e) => console.error(`scheduled job ${job} failed:`, e instanceof Error ? e.message : e))))
  },
} satisfies ExportedHandler<Env>
