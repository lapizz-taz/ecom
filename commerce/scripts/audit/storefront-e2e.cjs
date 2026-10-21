// Audit round 3, pass 5: the store as a shopper sees it — every storefront page at phone and desktop
// width, then a real purchase through the checkout form, the success page and Track order.
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


const STORE = '/s/my-store'
const PAGES = ['', '/shop', '/search?q=tee', '/product/store-tee', '/cart', '/checkout', '/track-order', '/login', '/register', '/contact', '/policies', '/no-such-page']

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
    const owner = await staff('r3-store@example.com', 'OWNER')
    const product = await owner.client.rpc('admin_save_product', { p_payload: { name: 'Store Tee', slug: 'store-tee', status: 'ACTIVE', price: 1200, cost_price: 500, track_inventory: true, requires_production: false,
      variants: [{ sku: 'STT1', title: 'Default', initial_stock: 5 }] } })
    const vid = (await call('GET', `/rest/v1/product_variants?product_id=eq.${product.data?.id}&select=id`)).body?.[0]?.id
    step('a product to sell (5 in stock)', Boolean(vid), JSON.stringify(product.error))

    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
    for (const width of [1440, 390]) {
      const ctx = await browser.newContext({ viewport: { width, height: width > 500 ? 900 : 844 }, isMobile: width < 500, hasTouch: width < 500 })
      const page = await ctx.newPage()
      let errs = []
      page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)))
      for (const p of PAGES) {
        errs = []
        await page.goto(`${base}${STORE}${p}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
        await page.waitForTimeout(2500)
        const t = await text(page)
        const overflow = await page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth)
        const crashed = /Something went wrong/.test(t)
        const expect404 = p === '/no-such-page'
        const okText = expect404 ? /not found|doesn.t exist|no longer/i.test(t) : !/Page not found/.test(t) && t.length > 40
        const productOk = p.startsWith('/product') ? /Store Tee/.test(t) && /1,?200/.test(t) : true
        step(`[${width}] store ${p || '/'}`, !crashed && okText && productOk && overflow <= 1 && errs.length === 0,
          JSON.stringify({ crashed, overflow, errs: errs.join(' | '), text: t.slice(0, 160) }))
      }
      await ctx.close()
    }

    // A purchase through the real checkout form, on a phone.
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    const page = await ctx.newPage()
    const errs = []
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)))
    await page.goto(`${base}${STORE}/product/store-tee`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await settle(page, /Store Tee/, 30000)
    await page.getByRole('button', { name: /add to cart/i }).first().click()
    await page.waitForTimeout(1500)
    await page.goto(`${base}${STORE}/checkout`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await settle(page, /Complete order/i, 30000)
    const ct = await text(page)
    step('checkout shows the order total (phone: the item list is folded into "Order summary")', /Order summary/.test(ct) && /1,?200/.test(ct), ct.slice(0, 400))
    await page.fill('#first_name', 'Nusrat').catch(() => null)
    await page.fill('#last_name', 'Jahan').catch(() => null)
    await page.fill('#phone', '01612345678')
    await page.fill('#address', 'House 12, Road 5, Mirpur 10')
    await page.click('#district')
    await page.getByRole('option', { name: 'Dhaka', exact: true }).click()
    await page.waitForTimeout(1500)
    const before = await inv(vid)
    await page.getByRole('button', { name: /Complete order/i }).click()
    const done = await settle(page, /Thank you|Order placed|order number|confirmed/i, 45000)
    const st = await text(page)
    step('Complete order → success page', done && /order-success/.test(page.url()), `${page.url()} — ${st.slice(0, 400)}`)
    await page.screenshot({ path: join(S, 'store-success-390.png') })
    const orders = (await call('GET', `/rest/v1/orders?merchant_id=eq.${M1}&select=id,order_number,customer_name,customer_phone,total_amount,subtotal,delivery_charge,status`)).body ?? []
    const o = orders[0]
    const after = await inv(vid)
    step('the order is saved once with the shopper\'s details and price; one unit reserved',
      orders.length === 1 && /Nusrat/.test(o?.customer_name ?? '') && /1612345678/.test(o?.customer_phone ?? '') && Number(o?.subtotal) === 1200 && after?.reserved === (before?.reserved ?? 0) + 1,
      JSON.stringify({ orders, before, after }))
    step('the success page shows that order number', new RegExp(o?.order_number ?? '§').test(st), st.slice(0, 300))

    // Reloading the success page does not place a second order.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3000)
    const again = (await call('GET', `/rest/v1/orders?merchant_id=eq.${M1}&select=id`)).body ?? []
    step('reloading the success page places no second order', again.length === 1, `${again.length} orders`)

    // Track order with number + phone; a wrong phone shows nothing.
    await page.goto(`${base}${STORE}/track-order`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForSelector('#order', { timeout: 30000 })
    await page.fill('#order', o?.order_number ?? '')
    await page.fill('#phone', '01699999999')
    await page.getByRole('button', { name: /Track order/i }).click()
    const wrong = await settle(page, /No order matches/i, 20000)
    await page.fill('#phone', '01612345678')
    await page.getByRole('button', { name: /Track order/i }).click()
    const right = await settle(page, new RegExp(`${o?.order_number}[\\s\\S]*Placed`), 20000)
    step('Track order: wrong phone → "No order matches"; right phone → the order and its status', wrong && right, (await text(page)).slice(0, 400))
    await page.screenshot({ path: join(S, 'store-track-390.png'), fullPage: true })
    step('no page errors during the purchase', errs.length === 0, errs.join(' | '))
    await ctx.close()
  } catch (e) {
    step('run finished without an exception', false, e && e.stack)
  } finally {
    await browser?.close()
    dev.kill('SIGTERM')
    writeFileSync(join(S, 'store-results.json'), JSON.stringify(results, null, 2))
    writeFileSync(join(S, 'store-dev.log'), devLog.slice(-30000))
    const failedN = results.filter((r) => !r.ok).length
    console.log(`\n${results.length - failedN}/${results.length} passed`)
    process.exit(failedN ? 1 : 0)
  }
})()
