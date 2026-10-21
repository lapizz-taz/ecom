// Audit round 3, pass 5: every Super Admin page at phone and desktop width, signed in as platform
// staff; a store owner is kept out. (Shared set-up below.) Pass 3: the order lifecycle, stock, profit & loss, the Call role and a second
// store, against the real Worker (site + backend functions + Cloudflare database) on this machine.
// Never deployed; no outside service is called.
//
// Run (from commerce/):
//   VITE_CLERK_PUBLISHABLE_KEY= VITE_DATABASE_BACKEND=cloudflare VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY=sb_publishable_e2e \
//     npx vite build --mode cloudflare --outDir scripts/audit/dist --emptyOutDir
//   node scripts/audit/order-lifecycle-e2e.cjs
// Needs Chromium (PLAYWRIGHT_BROWSERS_PATH) and worker/db/generated/seed.sql (npm run db:seed).
const { spawn } = require('node:child_process')
const { readFileSync, writeFileSync, mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { createClient } = require(join(__dirname, '../../node_modules/@supabase/supabase-js'))
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')

const ROOT = join(__dirname, '../..')
const S = __dirname
const port = 8000 + Math.floor(Math.random() * 900)
const base = `http://127.0.0.1:${port}`
const SERVICE = 'e2e-service-key-not-a-secret'
const ANON = 'sb_publishable_e2e'
const M1 = '00000000-0000-4000-8000-000000000001'
const persist = mkdtempSync(join(tmpdir(), 'audit-r3-'))

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
async function call(method, path, { body, key = SERVICE, token, merchant = M1, prefer } = {}) {
  const headers = { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${token ?? key}` }
  if (merchant) headers['x-merchant-id'] = merchant
  if (prefer) headers.Prefer = prefer
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
async function place(variantId, name, phone, key, quantity = 1) {
  const res = await fetch(`${base}/functions/v1/checkout`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: `Bearer ${ANON}`, 'x-merchant-id': M1 },
    body: JSON.stringify({ action: 'place', customer: { full_name: name, phone }, shipping: { address: 'House 7, Road 3, Dhanmondi', district: 'Dhaka' },
      items: [{ variant_id: variantId, quantity }], payment_method: 'COD', idempotency_key: key }) })
  return { status: res.status, body: await res.json().catch(() => null) }
}
const text = (page) => page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
async function settle(page, re, ms = 30000) {
  for (let waited = 0; waited < ms; waited += 500) {
    if (re.test(await text(page))) return true
    await page.waitForTimeout(500)
  }
  return false
}
const inv = async (vid) => (await call('GET', `/rest/v1/inventory?variant_id=eq.${vid}&select=on_hand,reserved,available`)).body?.[0]
const order = async (id) => (await call('GET', `/rest/v1/orders?id=eq.${id}&select=id,order_number,status,subtotal,delivery_charge,total_amount,cost_total`)).body?.[0]


const PATHS = ['', 'merchants', 'live', 'domains', 'merchants/new', 'employees', 'subscriptions', 'billing', 'finance', 'credits', 'sms', 'bd-courier', 'integrations', 'features', 'support', 'pbx', 'usage', 'automation', 'health', 'incidents', 'notifications', 'audit', 'security', 'data', 'settings']

;(async () => {
  let browser
  try {
    for (let i = 0; i < 180; i++) {
      try { const r = await fetch(`${base}/rest/v1/nothing`); if (r.status) break } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 1000))
    }
    const seeded = await fetch(`${base}/__seed`, { method: 'POST', body: readFileSync(join(ROOT, 'worker/db/generated/seed.sql'), 'utf8') })
    step('schema and reference data load', seeded.status === 200, await seeded.text().catch(() => ''))
    // Platform staff: a sign-in, then a Super Admin row.
    const u = await call('POST', '/auth/v1/admin/users', { merchant: null, body: { email: 'r3-platform@example.com', email_confirm: true, user_metadata: { full_name: 'Platform Audit' } } })
    const role = (await call('GET', '/rest/v1/platform_roles?code=eq.SUPER_ADMIN&select=id', { merchant: null })).body?.[0]?.id
    const ps = await call('POST', '/rest/v1/platform_staff', { merchant: null, body: { user_id: u.body?.id, email: 'r3-platform@example.com', full_name: 'Platform Audit', role_id: role, merchant_scope: 'ALL' } })
    const platform = await sessionFor('r3-platform@example.com')
    step('platform staff signed in', Boolean(platform.session) && ps.status < 300, JSON.stringify([ps.status, ps.body, platform.error]))
    const owner = await staff('r3-sa-owner@example.com', 'OWNER')

    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
    const key = `sb-${new URL(base).hostname.split('.')[0]}-auth-token`
    // A store owner opening Super Admin is kept out.
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
      const page = await ctx.newPage()
      await page.goto(`${base}/super-admin/login`, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await page.evaluate(([k, s]) => localStorage.setItem(k, s), [key, JSON.stringify(owner.session)])
      await page.goto(`${base}/super-admin/merchants`, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await page.waitForTimeout(5000)
      const t = await text(page)
      const rpc = await owner.client.rpc('platform_merchants_list', {})
      step('a store owner cannot see Super Admin (page and data)', !/Audit Store|My Store\b.*\bActive/.test(t) && (/not on the platform team|login|not.*access|permission|denied/i.test(t + page.url())) && Boolean(rpc.error),
        JSON.stringify({ url: page.url(), text: t.slice(0, 200), rpc: rpc.error?.message ?? 'returned data' }))
      await ctx.close()
    }
    const summary = []
    for (const width of [1440, 390]) {
      const ctx = await browser.newContext({ viewport: { width, height: width > 500 ? 900 : 844 }, isMobile: width < 500, hasTouch: width < 500 })
      const page = await ctx.newPage()
      let errs = []
      page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)))
      await page.goto(`${base}/super-admin/login`, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await page.evaluate(([k, s]) => localStorage.setItem(k, s), [key, JSON.stringify(platform.session)])
      for (const p of PATHS) {
        errs = []
        await page.goto(`${base}/super-admin${p ? '/' + p : ''}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
        await page.waitForTimeout(2500)
        const t = await text(page).catch(() => '')
        const crashed = /Something went wrong|Page not found/.test(t)
        const overflow = await page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth).catch(() => 0)
        const login = /\/login/.test(page.url())
        summary.push({ width, path: p || '(overview)', ok: !crashed && errs.length === 0 && overflow <= 1 && !login, crashed, overflow, login, errs: errs.join(' | ') })
        if (!summary.at(-1).ok) await page.screenshot({ path: join(S, `sa-${width}-${(p || 'overview').replace(/\//g, '_')}.png`) })
      }
      await ctx.close()
    }
    for (const r of summary) step(`[${r.width}] /super-admin/${r.path}`, r.ok, JSON.stringify({ crashed: r.crashed, overflow: r.overflow, login: r.login, errs: r.errs }))
  } catch (e) {
    step('run finished without an exception', false, e && e.stack)
  } finally {
    await browser?.close()
    dev.kill('SIGTERM')
    writeFileSync(join(S, 'sa-results.json'), JSON.stringify(results, null, 2))
    writeFileSync(join(S, 'sa-dev.log'), devLog.slice(-30000))
    const failedN = results.filter((r) => !r.ok).length
    console.log(`\n${results.length - failedN}/${results.length} passed`)
    process.exit(failedN ? 1 : 0)
  }
})()
