// Audit round 3, pass 4: every admin page at phone and desktop width — no crash, no error screen,
// no sideways scrolling. Same local Worker as order-lifecycle-e2e.cjs.
// (Shared set-up below.) Pass 3: the order lifecycle, stock, profit & loss, the Call role and a second
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


const PATHS = ['', 'account', 'ads', 'announcements', 'audit-logs', 'channels', 'coupons', 'courier-invoices', 'courier-management', 'couriers', 'customers', 'finance', 'finance/accounts', 'finance/cash-flow', 'finance/expenses', 'finance/income', 'finance/income-expense', 'finance/profit-loss', 'finance/refunds', 'help', 'hr', 'hr/attendance', 'hr/departments', 'hr/report', 'hr/requests', 'hr/settings', 'hr/shifts', 'inbox', 'inbox/auto-replies', 'inbox/channels', 'inbox/comments', 'inventory', 'inventory/adjustments', 'inventory/branches', 'inventory/branches/setup', 'inventory/movements', 'label-builder', 'labels', 'marketing', 'marketing/google', 'marketing/tiktok', 'orders', 'orders/abandoned', 'orders/approved', 'orders/auto-pick', 'orders/block-list', 'orders/call-center', 'orders/dashboard', 'orders/fraud', 'orders/new', 'orders/sheets', 'orders/super-edit', 'orders/web', 'production', 'products', 'products/new', 'purchases', 'purchases/new', 'reports', 'scan', 'search', 'settings', 'settings/apps', 'settings/billing', 'settings/developers', 'settings/devices', 'settings/pbx', 'settings/voicedrive-pbx', 'sms', 'status', 'store/seo', 'store/shopify-sync', 'store/sync', 'store/theme', 'store/theme/editor', 'store/website', 'support/bugs', 'support/feedback', 'system-logs', 'updates', 'users']

;(async () => {
  let browser
  try {
    for (let i = 0; i < 180; i++) {
      try { const r = await fetch(`${base}/rest/v1/nothing`); if (r.status) break } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 1000))
    }
    const seeded = await fetch(`${base}/__seed`, { method: 'POST', body: readFileSync(join(ROOT, 'worker/db/generated/seed.sql'), 'utf8') })
    step('schema and reference data load', seeded.status === 200, await seeded.text().catch(() => ''))
    const cur = await call('GET', `/rest/v1/settings?merchant_id=eq.${M1}&key=eq.storefront&select=value`)
    await call('PATCH', `/rest/v1/settings?merchant_id=eq.${M1}&key=eq.storefront`, { body: { value: { ...(cur.body?.[0]?.value ?? {}), mode: 'OWN' } } })
    const owner = await staff('r3-pages@example.com', 'OWNER')
    const product = await owner.client.rpc('admin_save_product', { p_payload: { name: 'Page Tee', slug: 'page-tee', status: 'ACTIVE', price: 1000, cost_price: 400, track_inventory: true, requires_production: false,
      variants: [{ sku: 'PT1', title: 'Default', initial_stock: 10 }] } })
    const vid = (await call('GET', `/rest/v1/product_variants?product_id=eq.${product.data?.id}&select=id`)).body?.[0]?.id
    await place(vid, 'Karim Mia', '01812345678', 'r3-pages-0000001', 1)
    step('owner and sample data', Boolean(owner.session && vid))

    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
    const summary = []
    for (const width of [1440, 390]) {
      const ctx = await browser.newContext({ viewport: { width, height: width > 500 ? 900 : 844 }, isMobile: width < 500, hasTouch: width < 500 })
      const page = await ctx.newPage()
      let errs = []
      page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)))
      await page.goto(`${base}/admin/login`, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await page.evaluate(([k, s]) => { localStorage.setItem(k, s); localStorage.setItem('admin-whats-new-seen', '9999-12-31') }, [`sb-${new URL(base).hostname.split('.')[0]}-auth-token`, JSON.stringify(owner.session)])
      for (const p of PATHS) {
        errs = []
        await page.goto(`${base}/admin${p ? '/' + p : ''}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => errs.push(String(e)))
        await page.waitForTimeout(2500)
        const t = await text(page).catch(() => '')
        const crashed = /Something went wrong|Page not found/.test(t)
        const overflow = await page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth).catch(() => 0)
        const login = /\/admin\/login/.test(page.url())
        const ok = !crashed && errs.length === 0 && overflow <= 1 && !login
        summary.push({ width, path: p || '(dashboard)', ok, crashed, overflow, login, errs: errs.join(' | ') })
        if (!ok) await page.screenshot({ path: join(S, `page-${width}-${(p || 'dashboard').replace(/\//g, '_')}.png`) })
      }
      await ctx.close()
    }
    for (const r of summary) step(`[${r.width}] /admin/${r.path}`, r.ok, JSON.stringify({ crashed: r.crashed, overflow: r.overflow, login: r.login, errs: r.errs }))
  } catch (e) {
    step('run finished without an exception', false, e && e.stack)
  } finally {
    await browser?.close()
    dev.kill('SIGTERM')
    writeFileSync(join(S, 'pages-results.json'), JSON.stringify(results, null, 2))
    writeFileSync(join(S, 'pages-dev.log'), devLog.slice(-30000))
    const failedN = results.filter((r) => !r.ok).length
    console.log(`\n${results.length - failedN}/${results.length} passed`)
    process.exit(failedN ? 1 : 0)
  }
})()
