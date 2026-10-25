// Audit round 4, pass 10: the store-wide rules that stop staff from working, applied to every action
// of every backend function on the real Worker (site + backend functions + Cloudflare database) on
// this machine. The database refuses changes when the store's access is BLOCKED (closed, suspended,
// first payment not made, offer ended) or READ_ONLY, and refuses work in the operational modules when
// the store requires check-in and the staff member has not checked in (or is on a break). The backend
// functions must refuse the same calls, since most of them act with the service role afterwards.
// Never deployed; outside services are not reachable from here.
//
// Run (from commerce/):
//   VITE_CLERK_PUBLISHABLE_KEY= VITE_DATABASE_BACKEND=cloudflare VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY=sb_publishable_e2e \
//     npx vite build --mode cloudflare --outDir scripts/audit/dist --emptyOutDir
//   node scripts/audit/functions-access-sweep.cjs
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
const persist = mkdtempSync(join(tmpdir(), 'audit-r4-access-'))

const dev = spawn(join(ROOT, 'node_modules/.bin/wrangler'),
  ['dev', '--local', '--config', join(S, 'wrangler.jsonc'), '--port', String(port), '--ip', '127.0.0.1', '--persist-to', persist,
    '--var', `PLATFORM_URL:${base}`, '--var', `FUNCTIONS_URL:${base}/functions/v1`],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } })
let devLog = ''
dev.stdout.on('data', (d) => { devLog += d })
dev.stderr.on('data', (d) => { devLog += d })

const results = []
const step = (name, ok, detail = '') => {
  results.push({ name, ok, detail: String(detail).slice(0, 1500) })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — ${String(detail).slice(0, 1500)}`}`)
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
  return { ...s, id: user.body?.id, token: s.session?.access_token, setError: set.status >= 300 ? set.body : null }
}

// Endpoints that answer without a staff sign-in by design (they check a secret, a signature, an API key or nothing).
// `billing` is the plan payment itself, which a store that lost access must still be able to make.
const PUBLIC = new Set(['checkout', 'site-api', 'api', 'clerk-auth', 'clerk-proxy', 'clerk-webhook', 'courier-webhook', 'payment-webhook', 'voicedrive', 'billing', 'notifications-dispatch', 'courier-relay'])
// The modules the check-in rule covers (public._hr_gate).
const GATED = new Set(['orders', 'products', 'inventory', 'customers', 'couriers', 'purchases', 'payments', 'fraud', 'production', 'pbx'])
// Actions that only read (`read` in requireStaff): open in a read-only store and before check-in, as views are.
const READS = new Set(['admin-users:list', 'courier:tracking', 'channels:plugin_status', 'channels:ad_tracking_get',
  'fraud-check:courier_history_status', 'fraud-check:courier_panel_status', 'pbx:status', 'domains:list'])
const isRead = (a) => READS.has(`${a.fn}:${a.action}`)

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
  return { status: res.status, text: text.slice(0, 220) }
}

const refused = (s) => s === 401 || s === 403
// No answer either way: the input check was never satisfied, or the caller was rate limited.
const unclear = (s) => s === 422 || s === 429

;(async () => {
  try {
    for (let i = 0; i < 180; i++) {
      try { const r = await fetch(`${base}/rest/v1/nothing`); if (r.status) break } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 1000))
    }
    const seeded = await fetch(`${base}/__seed`, { method: 'POST', body: readFileSync(join(ROOT, 'worker/db/generated/seed.sql'), 'utf8') })
    step('schema and reference data load', seeded.status === 200, await seeded.text().catch(() => ''))
    const viewer = await staff('r4-acc-viewer@example.com', 'VIEWER')
    const owner = await staff('r4-acc-owner@example.com', 'OWNER')
    const manager = await staff('r4-acc-manager@example.com', 'MANAGER')
    step('viewer, owner and manager signed in', Boolean(viewer.token && owner.token && manager.token),
      JSON.stringify([viewer, owner, manager].map((u) => u.error ?? u.setError)))

    const perms = await call('GET', '/rest/v1/permissions?select=code,module')
    const moduleOf = new Map((Array.isArray(perms.body) ? perms.body : []).map((p) => [p.code, p.module]))
    step('permission catalog read', moduleOf.size > 50, JSON.stringify(perms.body).slice(0, 300))

    const list = Object.entries(actions()).flatMap(([fn, acts]) => acts.map((action) => ({ fn, action })))
    const staffOnly = list.filter((a) => !PUBLIC.has(a.fn))

    // 1. What each action needs: a Viewer's refusal names the permission ("x.manage is required").
    // An action a Viewer gets past needs no more than the views the Viewer has.
    const needs = new Map()
    const viewerPasses = new Set()
    for (const a of staffOnly) {
      const r = await post(a.fn, a.action, viewer.token)
      const m = r.text.match(/([a-z_]+\.[a-z_]+) is required/)
      if (m) needs.set(`${a.fn}:${a.action}`, m[1])
      else if (!refused(r.status)) viewerPasses.add(`${a.fn}:${a.action}`)
    }
    step(`permission needed found for ${needs.size} of ${staffOnly.length} staff actions`, needs.size > 50)

    // 2. The store is suspended by the platform: its owner may not change anything anywhere.
    const suspend = await call('PATCH', `/rest/v1/merchants?id=eq.${M1}`, { body: { status: 'SUSPENDED' } })
    const mode = await call('POST', '/rest/v1/rpc/merchant_access_mode', { token: owner.token, body: {} })
    step('store suspended; the database calls its access BLOCKED', suspend.status < 300 && mode.body === 'BLOCKED', `${suspend.status} ${JSON.stringify(mode.body)}`)
    const suspended = []
    for (const a of staffOnly) suspended.push({ ...a, ...(await post(a.fn, a.action, owner.token)) })
    const blockedLeaks = suspended.filter((r) => !refused(r.status) && !unclear(r.status))
    step(`suspended store: its owner is refused on every staff action (${suspended.filter((r) => refused(r.status)).length} refused, ${suspended.filter((r) => unclear(r.status)).length} unclear)`,
      blockedLeaks.length === 0, JSON.stringify(blockedLeaks.map((r) => `${r.fn}:${r.action} ${r.status} ${r.text.slice(0, 90)}`)))

    // 2b. The platform makes a suspended store read-only instead: views and reads only.
    const rulesRow = await call('GET', '/rest/v1/platform_settings?key=eq.access_rules&select=value')
    const rules = (Array.isArray(rulesRow.body) && rulesRow.body[0]?.value) || {}
    const hadRules = Array.isArray(rulesRow.body) && rulesRow.body.length > 0
    const setRules = (value) => hadRules
      ? call('PATCH', '/rest/v1/platform_settings?key=eq.access_rules', { body: { value }, merchant: null })
      : call('POST', '/rest/v1/platform_settings', { body: { key: 'access_rules', value }, merchant: null })
    const ro = await setRules({ ...rules, MERCHANT_SUSPENDED: 'READ_ONLY' })
    const roMode = await call('POST', '/rest/v1/rpc/merchant_access_mode', { token: owner.token, body: {} })
    step('the same store made read-only', roMode.body === 'READ_ONLY', `${ro.status} ${JSON.stringify(ro.body)} ${JSON.stringify(roMode.body)}`)
    const readOnly = []
    for (const a of staffOnly) readOnly.push({ ...a, perm: needs.get(`${a.fn}:${a.action}`), ...(await post(a.fn, a.action, owner.token)) })
    // A change is anything that is not a read and needs more than a view or an export.
    const isChange = (r) => !isRead(r) && !viewerPasses.has(`${r.fn}:${r.action}`) && !(r.perm && /\.(view|export)$/.test(r.perm))
    const roLeaks = readOnly.filter((r) => isChange(r) && !refused(r.status) && !unclear(r.status))
    step(`read-only store: its owner is refused every change (${readOnly.filter((r) => refused(r.status)).length} refused)`,
      roLeaks.length === 0, JSON.stringify(roLeaks.map((r) => `${r.fn}:${r.action} (${r.perm ?? 'view'}) ${r.status} ${r.text.slice(0, 90)}`)))
    const roReads = readOnly.filter((r) => isRead(r) && !refused(r.status))
    step(`read-only store: the reads stay open (${roReads.length} of ${staffOnly.filter(isRead).length})`,
      roReads.length === staffOnly.filter(isRead).length, JSON.stringify(readOnly.filter((r) => isRead(r) && refused(r.status)).map((r) => `${r.fn}:${r.action} ${r.text.slice(0, 90)}`)))
    if (hadRules) await setRules(rules)
    else await call('DELETE', '/rest/v1/platform_settings?key=eq.access_rules', { merchant: null })

    // 3. Control: the same owner once the store is active again.
    await call('PATCH', `/rest/v1/merchants?id=eq.${M1}`, { body: { status: 'ACTIVE' } })
    const active = []
    for (const a of staffOnly) active.push({ ...a, ...(await post(a.fn, a.action, owner.token)) })
    const activeReached = active.filter((r) => !refused(r.status) && !unclear(r.status))
    step(`active store: its owner reaches ${activeReached.length} staff actions (control)`, activeReached.length > 50)

    // 4. Check-in required, and the manager has not checked in: no work in the operational modules.
    const saved = await call('POST', '/rest/v1/rpc/hr_settings_save', { token: owner.token, body: { p: { require_check_in: true } } })
    step('store requires check-in', saved.status < 300, JSON.stringify(saved.body))
    const gatedOf = (a) => GATED.has(moduleOf.get(needs.get(`${a.fn}:${a.action}`)) ?? '')
    const gated = staffOnly.filter((a) => gatedOf(a) && !isRead(a))
    const out = []
    for (const a of gated) out.push({ ...a, perm: needs.get(`${a.fn}:${a.action}`), ...(await post(a.fn, a.action, manager.token)) })
    const gateLeaks = out.filter((r) => !refused(r.status) && !unclear(r.status))
    step(`not checked in: the manager is refused on every operational action (${gated.length} actions; ${out.filter((r) => refused(r.status)).length} refused)`,
      gateLeaks.length === 0, JSON.stringify(gateLeaks.map((r) => `${r.fn}:${r.action} (${r.perm}) ${r.status} ${r.text.slice(0, 90)}`)))

    // 5. Control: checked in, the same manager reaches the actions the role allows.
    const checkIn = await call('POST', '/rest/v1/rpc/hr_check_in', { token: manager.token, body: {} })
    step('manager checked in', checkIn.status < 300, JSON.stringify(checkIn.body))
    const inside = []
    for (const a of gated) inside.push({ ...a, ...(await post(a.fn, a.action, manager.token)) })
    const insideReached = inside.filter((r) => !refused(r.status) && !unclear(r.status))
    step(`checked in: the manager reaches ${insideReached.length} of them (control)`, insideReached.length > 0)

    writeFileSync(join(S, 'functions-access-table-results.json'), JSON.stringify({ suspended, active, notCheckedIn: out, checkedIn: inside }, null, 2))
  } catch (e) {
    step('run finished without an exception', false, e && e.stack)
  } finally {
    dev.kill('SIGTERM')
    writeFileSync(join(S, 'functions-access-results.json'), JSON.stringify(results, null, 2))
    writeFileSync(join(S, 'functions-access-dev.log'), devLog.slice(-30000))
    const failedN = results.filter((r) => !r.ok).length
    console.log(`\n${results.length - failedN}/${results.length} passed`)
    process.exit(failedN ? 1 : 0)
  }
})()
