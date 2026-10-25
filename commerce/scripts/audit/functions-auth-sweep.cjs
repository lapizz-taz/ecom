// Audit round 4, pass 7: every action of every backend function, sent signed out and as a store
// Viewer, against the real Worker (site + backend functions + Cloudflare database) on this machine.
// A signed-out call may succeed only on the public endpoints; a Viewer only where it may look.
// Never deployed; outside services are not reachable from here.
//
// Run (from commerce/):
//   VITE_CLERK_PUBLISHABLE_KEY= VITE_DATABASE_BACKEND=cloudflare VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY=sb_publishable_e2e \
//     npx vite build --mode cloudflare --outDir scripts/audit/dist --emptyOutDir
//   node scripts/audit/functions-auth-sweep.cjs
// Needs worker/db/generated/seed.sql (npm run db:seed). Actions are read from each handler.ts.
const { spawn } = require('node:child_process')
const { readFileSync, writeFileSync, mkdtempSync, readdirSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { createClient } = require(join(__dirname, '../../node_modules/@supabase/supabase-js'))

const ROOT = join(__dirname, '../..')
const S = __dirname
const port = 8000 + Math.floor(Math.random() * 900)
const base = `http://127.0.0.1:${port}`
const SERVICE = 'e2e-service-key-not-a-secret'
const ANON = 'sb_publishable_e2e'
const M1 = '00000000-0000-4000-8000-000000000001'
const persist = mkdtempSync(join(tmpdir(), 'audit-r4-fn-'))

const dev = spawn(join(ROOT, 'node_modules/.bin/wrangler'),
  ['dev', '--local', '--config', join(S, 'wrangler.jsonc'), '--port', String(port), '--ip', '127.0.0.1', '--persist-to', persist,
    '--var', `PLATFORM_URL:${base}`, '--var', `FUNCTIONS_URL:${base}/functions/v1`],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } })
let devLog = ''
dev.stdout.on('data', (d) => { devLog += d })
dev.stderr.on('data', (d) => { devLog += d })

const results = []
const step = (name, ok, detail = '') => {
  results.push({ name, ok, detail: String(detail).slice(0, 900) })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — ${String(detail).slice(0, 900)}`}`)
}
async function call(method, path, { body, key = SERVICE, token, merchant = M1 } = {}) {
  const headers = { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${token ?? key}` }
  if (merchant) headers['x-merchant-id'] = merchant
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: res.status, body: json }
}
async function sessionFor(email) {
  const server = createClient(base, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } })
  const link = await server.auth.admin.generateLink({ type: 'magiclink', email })
  const client = createClient(base, ANON, { auth: { persistSession: false, autoRefreshToken: false } })
  const opened = await client.auth.verifyOtp({ type: 'magiclink', token_hash: link.data?.properties?.hashed_token })
  return { session: opened.data?.session, client, error: link.error ?? opened.error }
}
async function staff(email, role, merchant = M1) {
  const user = await call('POST', '/auth/v1/admin/users', { merchant, body: { email, email_confirm: true, user_metadata: { full_name: email.split('@')[0] }, app_metadata: { clerk_user_id: `user_${email.split('@')[0]}` } } })
  const set = await call('POST', '/rest/v1/rpc/admin_set_user_role', { merchant, body: { p_user_id: user.body?.id, p_role_code: role, p_is_active: true } })
  const s = await sessionFor(email)
  return { ...s, id: user.body?.id, setError: set.status >= 300 ? set.body : null }
}

// Endpoints that answer without a staff sign-in by design (they check a secret, a signature, an API key or nothing).
const PUBLIC = new Set(['checkout', 'site-api', 'api', 'clerk-auth', 'clerk-proxy', 'clerk-webhook', 'courier-webhook', 'payment-webhook', 'voicedrive', 'billing', 'notifications-dispatch', 'courier-relay'])

function actions() {
  const out = {}
  for (const fn of readdirSync(join(ROOT, 'supabase/functions'))) {
    let src
    try { src = readFileSync(join(ROOT, 'supabase/functions', fn, 'handler.ts'), 'utf8') } catch { continue }
    const acts = new Set()
    for (const re of [/case '([a-z_][a-z0-9_.:-]*)'\s*:/g, /action:\s*z\.literal\('([a-z_][a-z0-9_.:-]*)'\)/g, /action === '([a-z_][a-z0-9_]*)'/g]) for (const m of src.matchAll(re)) acts.add(m[1])
    out[fn] = acts.size ? [...acts].sort() : [null]
  }
  return out
}

/** A plausible value for a field the validator asked for, from its message. */
function guess(path, message) {
  const name = String(path.split('.').pop() ?? '')
  const option = message.match(/expected one of "([^"]+)"/) ?? message.match(/expected "([^"]+)"/)
  if (option) return option[1]
  if (/UUID|uuid/.test(message) || /(^|_)id$/.test(name)) return '00000000-0000-4000-8000-0000000000aa'
  if (/email/i.test(message) || /email/.test(name)) return 'audit@example.com'
  if (/URL|url/.test(message) || /url/.test(name)) return 'https://example.com'
  if (/expected number|expected int/.test(message)) return 1
  if (/expected boolean/.test(message)) return true
  if (/expected array/.test(message)) return []
  if (/expected (object|record)/.test(message)) return {}
  const min = message.match(/>=\s*(\d+) characters/)
  if (min) return 'x'.repeat(Number(min[1]))
  if (/phone/.test(name)) return '01711999001'
  return 'audit'
}
function setPath(obj, path, value) {
  const keys = path.split('.').filter(Boolean)
  let o = obj
  keys.forEach((k, i) => {
    if (i === keys.length - 1) o[k] = value
    else o = (o[k] = typeof o[k] === 'object' && o[k] !== null ? o[k] : /^\d+$/.test(keys[i + 1]) ? [] : {})
  })
}

/** Sends the action; while the validator names missing fields (422), fills them and tries again. */
async function post(fn, action, token) {
  const headers = { 'Content-Type': 'application/json', apikey: ANON, 'x-merchant-id': M1 }
  if (token) headers.Authorization = `Bearer ${token}`
  const body = action ? { action } : {}
  let res, text = ''
  for (let round = 0; round < 8; round++) {
    res = await fetch(`${base}/functions/v1/${fn}`, { method: 'POST', headers, body: JSON.stringify(body) })
    text = await res.text().catch(() => '')
    if (res.status !== 422) break
    let details = []
    try { details = JSON.parse(text)?.error?.details ?? [] } catch { /* not json */ }
    const fresh = details.filter((d) => d && typeof d.path === 'string' && d.path !== '' && d.path !== 'action')
    if (!fresh.length) break
    for (const d of fresh) setPath(body, d.path, guess(d.path, String(d.message ?? '')))
  }
  return { status: res.status, text: text.slice(0, 160), filled: Object.keys(body).length - 1 }
}

;(async () => {
  try {
    for (let i = 0; i < 180; i++) {
      try { const r = await fetch(`${base}/rest/v1/nothing`); if (r.status) break } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 1000))
    }
    const seeded = await fetch(`${base}/__seed`, { method: 'POST', body: readFileSync(join(ROOT, 'worker/db/generated/seed.sql'), 'utf8') })
    step('schema and reference data load', seeded.status === 200, await seeded.text().catch(() => ''))
    const viewer = await staff('r4-viewer@example.com', 'VIEWER')
    step('viewer signed in', Boolean(viewer.session), JSON.stringify(viewer.error ?? viewer.setError))
    const token = viewer.session?.access_token

    const table = []
    for (const [fn, acts] of Object.entries(actions())) {
      for (const action of acts) {
        const anon = await post(fn, action, null)
        const view = await post(fn, action, token)
        table.push({ fn, action, anon: anon.status, viewer: view.status, anonText: anon.text, viewerText: view.text })
      }
    }
    writeFileSync(join(S, 'functions-auth-table-results.json'), JSON.stringify(table, null, 2))
    const ok = (s) => s >= 200 && s < 300
    const anonOpen = table.filter((r) => ok(r.anon) && !PUBLIC.has(r.fn))
    step(`signed out: no staff endpoint answers (${table.length} actions)`, anonOpen.length === 0, JSON.stringify(anonOpen))
    // 503 NOT_CONFIGURED: sign-in through Clerk is not set up on this machine (no secret), which is the right answer.
    const crash = (status, text) => status >= 500 && !(status === 503 && text.includes('NOT_CONFIGURED'))
    const crashes = table.filter((r) => crash(r.anon, r.anonText) || crash(r.viewer, r.viewerText))
    step('no action crashes (5xx) on an unexpected caller', crashes.length === 0, JSON.stringify(crashes.map((r) => `${r.fn}:${r.action} ${r.anon}/${r.viewer} ${r.viewerText}`)))
    // What a store Viewer may do here, reviewed: look up a phone's delivery record (orders.view) and the public payment webhook.
    const VIEWER_OK = new Set(['fraud-check:phone_record', 'payment-webhook:null'])
    const viewerOpen = table.filter((r) => ok(r.viewer) && !VIEWER_OK.has(`${r.fn}:${r.action}`))
    step(`a store Viewer is refused everywhere else (${table.filter((r) => r.viewer === 403 || r.viewer === 401).length} refusals)`, viewerOpen.length === 0, JSON.stringify(viewerOpen))
  } catch (e) {
    step('run finished without an exception', false, e && e.stack)
  } finally {
    dev.kill('SIGTERM')
    writeFileSync(join(S, 'functions-auth-results.json'), JSON.stringify(results, null, 2))
    writeFileSync(join(S, 'functions-auth-dev.log'), devLog.slice(-30000))
    const failedN = results.filter((r) => !r.ok).length
    console.log(`\n${results.length - failedN}/${results.length} passed`)
    process.exit(failedN ? 1 : 0)
  }
})()
