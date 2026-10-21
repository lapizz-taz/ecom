// Theme editor round: the preview never shows the Fullfilio website (open, reload, page switches),
// a reload keeps the editor's page and selection, the cart drawer's look is edited live, saved and
// restored; the website's orange buttons stay on the website; Cloud Calling replaces VoiceDrive PBX.
// Same local Worker as admin-pages-e2e.cjs (pages go through the Worker first, as in production;
// the built site needs dist/_site from scripts/prerender-site.mjs copied next to it).
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




const WEBSITE = 'The order system for online sellers'
// In every frame: note it whenever the theme preview frame ever shows the Fullfilio website.
const watchFrames = () => {
  if (!new URLSearchParams(location.search).has('theme_preview')) return
  const check = () => {
    if (document.body && document.body.innerText.includes('The order system for online sellers')) {
      try { window.top.__sawWebsite = (window.top.__sawWebsite || 0) + 1 } catch { /* other origin */ }
    }
  }
  new MutationObserver(check).observe(document, { childList: true, subtree: true, characterData: true })
  document.addEventListener('DOMContentLoaded', check)
}
async function previewFrame(page, ms = 30000) {
  for (let waited = 0; waited < ms; waited += 300) {
    const f = page.frames().find((x) => /theme_preview=1/.test(x.url()))
    if (f && await f.evaluate(() => !!document.querySelector('[data-store-theme]')).catch(() => false)) return f
    await page.waitForTimeout(300)
  }
  return null
}
// What the preview frame was sent: any page carrying the website's HTML counts as a flash too.
let sentWebsite = 0
const watchResponses = (page) => page.on('response', async (r) => {
  if (r.request().resourceType() !== 'document' || !/theme_preview=1/.test(r.url())) return
  if ((await r.text().catch(() => '')).includes(WEBSITE)) sentWebsite++
})
const saw = async (page) => (await page.evaluate(() => window.__sawWebsite || 0)) + sentWebsite
async function until(fn, ms = 15000) {
  let v
  for (let waited = 0; waited < ms; waited += 300) { v = await fn().catch(() => null); if (v) return v; await new Promise((r) => setTimeout(r, 300)) }
  return v
}

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
    const owner = await staff('theme-round@example.com', 'OWNER')
    const product = await owner.client.rpc('admin_save_product', { p_payload: { name: 'Linen Shirt', slug: 'linen-shirt', status: 'ACTIVE', price: 1250, cost_price: 500, track_inventory: true, requires_production: false,
      variants: [{ sku: 'LS1', title: 'Default', initial_stock: 10 }] } })
    step('owner and a product', Boolean(owner.session && product.data?.id), JSON.stringify(product.error))

    // The Worker: the website keeps its HTML; the preview frame gets the plain app page, 200 everywhere.
    const home = await fetch(`${base}/`).then(async (r) => ({ s: r.status, t: await r.text() }))
    const prev = []
    for (const p of ['/', '/shop', '/product/linen-shirt', '/cart']) {
      const r = await fetch(`${base}${p}?theme_preview=1`)
      const t = await r.text()
      prev.push({ p, s: r.status, prerendered: t.includes('data-prerendered'), website: t.includes(WEBSITE) })
    }
    step('Worker: fullfilio.com still sends the website HTML', home.s === 200 && home.t.includes('data-prerendered') && home.t.includes(WEBSITE))
    step('Worker: preview pages are the plain app page with status 200 (no website HTML)', prev.every((x) => x.s === 200 && !x.prerendered && !x.website), JSON.stringify(prev))

    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
    const errors = []
    const watch = (page, where) => {
      page.on('pageerror', (e) => errors.push(`${where}: ${String(e).slice(0, 200)}`))
      page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|fonts\.g|ERR_|net::/.test(m.text())) errors.push(`${where} console: ${m.text().slice(0, 200)}`) })
    }

    // --- The editor (desktop) ---
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await ctx.addInitScript(watchFrames)
    const page = await ctx.newPage()
    watch(page, 'editor')
    watchResponses(page)
    await page.goto(`${base}/admin/login`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.evaluate(([k, s]) => { localStorage.setItem(k, s); localStorage.setItem('admin-whats-new-seen', '9999-12-31'); localStorage.setItem('admin-major-update-seen', '9999-12-31') }, [`sb-${new URL(base).hostname.split('.')[0]}-auth-token`, JSON.stringify(owner.session)])

    await page.goto(`${base}/admin/store/theme/editor`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    let frame = await previewFrame(page)
    await page.waitForTimeout(1500)
    const unsavedOnOpen = await page.getByText('Unsaved changes').count()
    step('editor opens on the store (preview shows the store, never the website)', !!frame && await saw(page) === 0, `saw website ${await saw(page)} times`)
    step('a freshly opened editor has no unsaved changes', unsavedOnOpen === 0)

    for (let i = 0; i < 3; i++) {
      await page.reload({ waitUntil: 'domcontentloaded' })
      frame = await previewFrame(page)
    }
    await page.waitForTimeout(1000)
    step('3 reloads: the preview never shows the website', !!frame && await saw(page) === 0, `saw website ${await saw(page)} times`)

    // Page switches (the frame reloads for each page).
    const pick = async (label) => {
      await page.locator('header').getByRole('button', { name: /Home page|Collections|Products|Cart/ }).first().click()
      await page.getByRole('menuitem', { name: label }).click()
      return previewFrame(page)
    }
    for (const label of ['Collections', 'Home page', 'Products', 'Home page']) frame = await pick(label)
    await page.waitForTimeout(1000)
    step('switching pages 4 times: the preview never shows the website', !!frame && await saw(page) === 0, `saw website ${await saw(page)} times`)

    // A reload keeps the page and the selection.
    frame = await pick('Collections')
    const urlCollections = page.url()
    await page.reload({ waitUntil: 'domcontentloaded' })
    frame = await previewFrame(page)
    const collectionsKept = await page.locator('header').getByRole('button', { name: /Collections/ }).count()
    step('the address follows the page, and a reload stays on it', /page=collection/.test(urlCollections) && collectionsKept > 0 && /\/(collection|shop)/.test(frame?.url() ?? ''), JSON.stringify({ urlCollections, frame: frame?.url() }))

    // --- Cart drawer: live preview, save, restore ---
    frame = await pick('Cart')
    await page.getByRole('button', { name: 'Cart drawer' }).click()
    const drawer = () => frame.locator('[role="dialog"][data-section-id="cart-drawer"]')
    const opened = await until(async () => (await drawer().isVisible()) && /Sample product/.test(await drawer().innerText()))
    await page.screenshot({ path: join(S, 'round-drawer-default.png') })
    step('selecting "Cart drawer" opens it in the preview, with sample items in an empty cart', !!opened)

    const field = (label) => page.locator(`xpath=//div[span[normalize-space()=${JSON.stringify(label)}]]`).last()
    await field('Title').locator('input').fill('Your bag')
    await field('Opens from').locator('select').selectOption('left')
    await field('Width on computers').locator('select').selectOption('wide')
    await field('Background').locator('input.font-mono').fill('#fff7ed')
    await field('Label').locator('input').fill('Place order')
    await field('Button colour').locator('input.font-mono').fill('#ea580c')
    await field('Show the total').getByRole('switch').click()
    await field('Photo corners').locator('input[type=range]').fill('18')
    await field('Quantity box corners').locator('input[type=range]').fill('20')
    const live = await until(async () => {
      const d = drawer()
      const box = await d.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, width: r.width } })
      const t = await d.innerText()
      const bg = await d.evaluate((el) => getComputedStyle(el).backgroundColor)
      const btn = await d.getByRole('link', { name: /Place order/ }).evaluate((el) => getComputedStyle(el).backgroundColor)
      const photo = await d.locator('li span[aria-hidden]').first().evaluate((el) => getComputedStyle(el).borderTopLeftRadius)
      const stepper = await d.getByRole('button', { name: 'Decrease quantity' }).first().evaluate((el) => getComputedStyle(el.parentElement).borderTopLeftRadius)
      return /Your bag/.test(t) && /Place order/.test(t) && !/Place order ·/.test(t) && bg === 'rgb(255, 247, 237)' && btn === 'rgb(234, 88, 12)' && box && box.x < 5 && Math.round(box.width) === 480 && photo === '18px' && stepper === '20px' ? { box, bg, btn, photo, stepper } : null
    })
    await page.screenshot({ path: join(S, 'round-drawer-edited.png') })
    step('edits show live: title, left side, 480 px wide, background, button label and colour, total hidden, photo and quantity box corners', !!live, JSON.stringify(live))

    await page.getByRole('button', { name: /Save draft/ }).click()
    const saved = await settle(page, /Draft saved/, 15000)
    const savedUrl = page.url()
    await page.reload({ waitUntil: 'domcontentloaded' })
    frame = await previewFrame(page)
    const restored = await until(async () => {
      const title = await field('Title').locator('input').inputValue()
      const t = await drawer().innerText()
      return title === 'Your bag' && /Your bag/.test(t) && /Place order/.test(t) ? title : null
    })
    step('saved, and after a reload the editor reopens on the cart drawer with the same settings', saved && /section=cart-drawer/.test(savedUrl) && /page=cart/.test(savedUrl) && !!restored, JSON.stringify({ savedUrl, restored }))
    step('the live store is unchanged until Publish', !((await call('GET', `/rest/v1/settings?merchant_id=eq.${M1}&key=eq.storefront&select=value`)).body?.[0]?.value?.theme?.cart?.title))

    // The preview's checkout button is the store's (theme/drawer colour), not the website's orange.
    const storeBtn = await drawer().getByRole('link', { name: /Place order/ }).evaluate((el) => getComputedStyle(el).backgroundImage)
    step('store buttons do not take the website button style', storeBtn === 'none', storeBtn)

    // Mobile preview: the drawer fills the phone-width preview.
    await page.getByRole('button', { name: 'Mobile' }).click()
    frame = await previewFrame(page)
    const mobile = await until(async () => {
      const w = await frame.evaluate(() => window.innerWidth)
      const box = await drawer().evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, width: r.width } })
      return box && Math.abs(box.width - w) <= 1 ? { w, drawer: box.width } : null
    })
    await page.screenshot({ path: join(S, 'round-drawer-mobile.png') })
    step('mobile preview: the drawer uses the full phone width', !!mobile, JSON.stringify(mobile))

    // Deselect: the drawer closes in the preview.
    await page.getByRole('button', { name: 'Close' }).first().click().catch(() => {})
    const closed = await until(async () => !(await drawer().isVisible()))
    step('closing the settings closes the drawer in the preview', !!closed)

    // Help: Fullfilio support's address, not the owner's own.
    await page.goto(`${base}/admin/help`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await settle(page, /Contact/, 20000)
    const help = await text(page)
    step('Help → Contact shows help@fullfilio.com and no personal e-mail', /help@fullfilio\.com/.test(help) && !/theme-round@example\.com/.test(help), help.match(/.{0,60}@.{0,40}/g)?.join(' | '))

    // Cloud Calling in the admin menu.
    await page.goto(`${base}/admin/settings/apps`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await settle(page, /App integration/i, 20000)
    const navText = await text(page)
    step('menu says Cloud Calling, not VoiceDrive PBX', /Cloud Calling/.test(navText) && !/VoiceDrive/.test(navText), navText.match(/.{0,40}(Cloud Calling|VoiceDrive).{0,40}/g)?.join(' | '))
    const adminBtn = await page.locator('button, a').filter({ hasText: /^Connect$|^Manage$|^Open$/ }).first().evaluate((el) => getComputedStyle(el).backgroundImage).catch(() => 'none')
    step('admin buttons do not take the website button style', !/250, 99, 34/.test(adminBtn), adminBtn)
    await ctx.close()

    // --- The website's buttons, desktop and phone, dark and white versions ---
    for (const [width, light] of [[1440, false], [390, false], [1440, true]]) {
      const c = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 500 })
      const p = await c.newPage()
      watch(p, `website ${width}${light ? ' white' : ''}`)
      if (light) await p.addInitScript(() => localStorage.setItem('fullfilio.site-theme', 'light'))
      await p.goto(`${base}/`, { waitUntil: 'networkidle', timeout: 60000 })
      await settle(p, /Start for free/)
      const cta = p.getByRole('link', { name: 'Start for free' }).first()
      const st = await cta.evaluate((el) => { const s = getComputedStyle(el); return { img: s.backgroundImage, border: s.borderTopColor, color: s.color, radius: s.borderTopLeftRadius, h: el.getBoundingClientRect().height } })
      await cta.hover()
      await p.waitForTimeout(250)
      const hover = await cta.evaluate((el) => getComputedStyle(el).backgroundImage)
      await p.locator('section').first().screenshot({ path: join(S, `round-site-${width}${light ? '-white' : ''}.png`) })
      const overflow = await p.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth)
      const footer = await p.locator('footer').innerText()
      const ok = /radial-gradient/.test(st.img) && /rgb\(93, 170, 255\)/.test(st.img) && /rgb\(14, 80, 192\)/.test(st.img) && st.border === 'rgb(11, 74, 184)' && st.color === 'rgb(255, 255, 255)' && st.radius === '10px' && /rgb\(111, 182, 255\)/.test(hover) && overflow <= 1
      step(`website ${width}px${light ? ' (white version)' : ''}: blue glow button (sky-blue middle, royal-blue edge), white text, 10px corners, brighter on hover`, ok, JSON.stringify({ ...st, hover, overflow }))
      step(`website ${width}px${light ? ' (white version)' : ''}: footer shows help@fullfilio.com`, /help@fullfilio\.com/.test(footer))
      await c.close()
    }
    step('no browser errors', errors.length === 0, errors.join(' | '))
  } catch (e) {
    step('run finished without an exception', false, e && e.stack)
  } finally {
    await browser?.close()
    dev.kill('SIGTERM')
    writeFileSync(join(S, 'round-results.json'), JSON.stringify(results, null, 2))
    writeFileSync(join(S, 'round-dev.log'), devLog.slice(-30000))
    const failedN = results.filter((r) => !r.ok).length
    console.log(`\n${results.length - failedN}/${results.length} passed`)
    process.exit(failedN ? 1 : 0)
  }
})()
