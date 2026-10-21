// Ready-made themes on Store → Theme: the library shows, "Try it" puts the look on the editor's draft
// (the live store does not change), Undo goes back, Save keeps it as a draft. Same local Worker as
// admin-pages-e2e.cjs.
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



const storeBg = (frame) => frame.evaluate(() => { const el = document.querySelector('[data-store-theme]'); return el ? getComputedStyle(el).backgroundColor : null })
async function previewFrame(page, ms = 30000) {
  for (let waited = 0; waited < ms; waited += 500) {
    const f = page.frames().find((x) => /theme_preview=1/.test(x.url()))
    if (f && await storeBg(f).catch(() => null)) return f
    await page.waitForTimeout(500)
  }
  return null
}
async function waitBg(frame, want, ms = 15000) {
  let got = null
  for (let waited = 0; waited < ms; waited += 300) { got = await storeBg(frame).catch(() => null); if (got === want) return got; await new Promise((r) => setTimeout(r, 300)) }
  return got
}
const liveTheme = async () => (await call('GET', `/rest/v1/settings?merchant_id=eq.${M1}&key=eq.storefront&select=value`)).body?.[0]?.value?.theme ?? {}

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
    const owner = await staff('theme-presets@example.com', 'OWNER')
    const product = await owner.client.rpc('admin_save_product', { p_payload: { name: 'Glow Serum', slug: 'glow-serum', status: 'ACTIVE', price: 1250, cost_price: 500, track_inventory: true, requires_production: false,
      variants: [{ sku: 'GS1', title: 'Default', initial_stock: 10 }] } })
    step('owner and a product', Boolean(owner.session && product.data?.id), JSON.stringify(product.error))

    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
    for (const width of [1440, 390]) {
      const ctx = await browser.newContext({ viewport: { width, height: width > 500 ? 900 : 844 }, isMobile: width < 500, hasTouch: width < 500 })
      const page = await ctx.newPage()
      const errs = []
      page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)))
      await page.goto(`${base}/admin/login`, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await page.evaluate(([k, s]) => { localStorage.setItem(k, s); localStorage.setItem('admin-whats-new-seen', '9999-12-31'); localStorage.setItem('admin-major-update-seen', '9999-12-31') }, [`sb-${new URL(base).hostname.split('.')[0]}-auth-token`, JSON.stringify(owner.session)])

      await page.goto(`${base}/admin/store/theme`, { waitUntil: 'domcontentloaded', timeout: 60000 })
      const listed = await settle(page, /Ready-made themes.*Classic.*Bloom.*Volt.*Bazaar/)
      const cards = page.locator('article', { has: page.locator('h3', { hasText: /^(Classic|Bloom|Volt|Bazaar)$/ }) })
      // The phone pass runs after the desktop pass saved Bloom as the draft.
      const expected = width === 1440 ? 'Classic' : 'Bloom'
      const classicCurrent = await page.locator('article', { has: page.locator('h3', { hasText: new RegExp(`^${expected}$`) }) }).getByText('Current').count()
      const overflow = await page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth)
      await page.locator('section', { has: page.getByRole('heading', { name: 'Ready-made themes' }) }).screenshot({ path: join(S, `themes-library-${width}.png`) })
      step(`[${width}] Theme page lists 4 themes, ${expected} is current, no sideways scroll`, listed && await cards.count() === 4 && classicCurrent === 1 && overflow <= 1,
        JSON.stringify({ listed, cards: await cards.count(), classicCurrent, overflow }))

      if (width === 1440) {
        await page.locator('article', { has: page.locator('h3', { hasText: /^Bloom$/ }) }).getByRole('link', { name: 'Try it' }).click()
        await page.waitForURL(/\/admin\/store\/theme\/editor$/, { timeout: 20000 }).catch(() => {})
        const toastShown = await settle(page, /Bloom is on your draft/, 15000)
        const frame = await previewFrame(page)
        const bg = frame && await waitBg(frame, 'rgb(255, 250, 247)')
        const heading = frame && await frame.evaluate(() => { const h = document.querySelector('[data-store-theme] h2'); return h ? getComputedStyle(h).fontFamily : '' })
        await page.screenshot({ path: join(S, 'themes-editor-bloom-1440.png') })
        step('Try it → editor shows Bloom (blush background, Cormorant headings) and says so', toastShown && bg === 'rgb(255, 250, 247)' && /Cormorant/.test(heading ?? ''),
          JSON.stringify({ url: page.url(), toastShown, bg, heading }))
        step('the live store has not changed', !(await liveTheme()).preset)

        await page.getByRole('button', { name: 'Undo' }).click()
        const undone = frame && await waitBg(frame, 'rgb(255, 255, 255)')
        step('Undo goes back to the previous look', undone === 'rgb(255, 255, 255)', String(undone))
        await page.getByRole('button', { name: 'Redo' }).click()
        const redone = frame && await waitBg(frame, 'rgb(255, 250, 247)')
        await page.getByRole('button', { name: /Save draft/ }).click()
        const saved = await settle(page, /Draft saved/, 15000)
        step('Redo and Save draft keep Bloom as the draft; live store unchanged', redone === 'rgb(255, 250, 247)' && saved && !(await liveTheme()).preset, JSON.stringify({ redone, saved }))

        await page.goto(`${base}/admin/store/theme`, { waitUntil: 'domcontentloaded', timeout: 60000 })
        await settle(page, /Ready-made themes.*Bazaar/)
        const bloomCurrent = await page.locator('article', { has: page.locator('h3', { hasText: /^Bloom$/ }) }).getByText('Current').count()
        step('Theme page now marks Bloom as current (on the draft)', bloomCurrent === 1 && await settle(page, /Draft not published|Your draft is not live yet/, 5000))

        await page.goto(`${base}/admin/store/theme/editor?preset=volt`, { waitUntil: 'domcontentloaded', timeout: 60000 })
        const vframe = await previewFrame(page)
        await page.getByRole('button', { name: 'Mobile' }).click().catch(() => {})
        const vbg = vframe && await waitBg(vframe, 'rgb(255, 255, 255)')
        const accent = vframe && await vframe.evaluate(() => getComputedStyle(document.querySelector('[data-store-theme]')).getPropertyValue('--primary').trim())
        await page.waitForTimeout(1500)
        await page.screenshot({ path: join(S, 'themes-editor-volt-mobile.png') })
        const panel = await page.locator('aside, [class*="w-[300px]"], body').first().innerText()
        const leftover = /Scrolling text|New arrivals/.test(panel)
        step('Volt applies over Bloom (blue accent, white background, none of Bloom\'s sections left over)', accent === '#1d4ed8' && vbg === 'rgb(255, 255, 255)' && !leftover, JSON.stringify({ accent, vbg, leftover }))
        step('no browser errors', errs.length === 0, errs.join(' | '))
      }
      await ctx.close()
    }
  } catch (e) {
    step('run finished without an exception', false, e && e.stack)
  } finally {
    await browser?.close()
    dev.kill('SIGTERM')
    writeFileSync(join(S, 'themes-results.json'), JSON.stringify(results, null, 2))
    writeFileSync(join(S, 'themes-dev.log'), devLog.slice(-30000))
    const failedN = results.filter((r) => !r.ok).length
    console.log(`\n${results.length - failedN}/${results.length} passed`)
    process.exit(failedN ? 1 : 0)
  }
})()
